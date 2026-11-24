use super::{rms_i16_normalized, TrackSource, SAMPLE_RATE};
use std::collections::VecDeque;

pub(super) enum TrackPlayback {
    Microphone { gain: f32 },
    Other,
}

impl TrackPlayback {
    pub(super) fn new(source: TrackSource) -> Self {
        match source {
            TrackSource::Microphone => Self::Microphone { gain: 4.0 }, // +12 dB from the first frame
            _ => Self::Other,
        }
    }

    /// Queue mono PCM for the mixer. The speaking meter uses the received mic level
    /// before either leveling or the listener's volume adjustment.
    pub(super) fn push_frame(
        &mut self,
        samples: &[i16],
        volume: f32,
        buffer: &mut VecDeque<f32>,
    ) -> Option<f32> {
        let scale = volume / 32768.0;
        let Self::Microphone { gain } = self else {
            buffer.extend(samples.iter().map(|&s| f32::from(s) * scale));
            return None;
        };

        const TARGET_RMS: f32 = 0.2; // -14 dBFS
        const MAX_GAIN: f32 = 8.0; // +18 dB
        const QUIET_FLOOR: f32 = 0.003; // about -50 dBFS
        let rms = rms_i16_normalized(samples);
        let mut frame_gain = *gain;
        let mut step = 0.0;
        // Hold the last gain during pauses so the noise floor doesn't set the level.
        if rms >= QUIET_FLOOR {
            let desired = (TARGET_RMS / rms).min(MAX_GAIN);
            let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
            let response_seconds = if desired < *gain { 0.035 } else { 0.35 };
            let response = 1.0 - (-seconds / response_seconds).exp();
            *gain += (desired - *gain) * response;
            step = (*gain - frame_gain) / samples.len() as f32;
        }
        for &sample in samples {
            frame_gain += step;
            buffer.push_back(f32::from(sample) * scale * frame_gain);
        }
        Some(rms)
    }
}

/// Limit the sum after participant volume and resampling. A single gain for the
/// mix preserves speaker balance when multiple voices peak at the same time.
pub(super) struct MixLimiter {
    gain: f32,
    release: f32,
}

impl MixLimiter {
    pub(super) fn new(sample_rate: u32) -> Self {
        Self {
            gain: 1.0,
            release: 1.0 - (-1.0 / (0.08 * sample_rate as f32)).exp(), // 80 ms recovery
        }
    }

    pub(super) fn process(&mut self, sample: f32) -> f32 {
        self.gain += (1.0 - self.gain) * self.release;
        let peak = sample.abs();
        if peak * self.gain > 1.0 {
            self.gain = 1.0 / peak;
        }
        sample * self.gain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::SAMPLES_PER_10MS;

    fn tone(peak: f32) -> Vec<i16> {
        (0..SAMPLES_PER_10MS)
            .map(|i| {
                let phase = std::f32::consts::TAU * 200.0 * i as f32 / SAMPLE_RATE as f32;
                (peak * phase.sin()) as i16
            })
            .collect()
    }

    fn rms(samples: &VecDeque<f32>) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn quiet_mic_gets_immediate_boost_and_sustained_voices_level_off() {
        let quiet = tone(400.0);
        let input = rms_i16_normalized(&quiet);
        let mut track = TrackPlayback::new(TrackSource::Microphone);
        let mut buffer = VecDeque::new();
        assert_eq!(track.push_frame(&quiet, 1.0, &mut buffer), Some(input));
        assert!((4.0..4.2).contains(&(rms(&buffer) / input)));

        for (peak, expected_rms) in [(400.0, input * 8.0), (2000.0, 0.2), (16000.0, 0.2)] {
            let frame = tone(peak);
            for _ in 0..200 {
                buffer.clear();
                track.push_frame(&frame, 1.0, &mut buffer);
            }
            assert!((rms(&buffer) - expected_rms).abs() < 0.002);
        }
    }

    #[test]
    fn listener_volume_scales_leveled_speech_and_preserves_the_meter() {
        let frame = tone(1000.0);
        let mut reference = VecDeque::new();
        let level =
            TrackPlayback::new(TrackSource::Microphone).push_frame(&frame, 1.0, &mut reference);
        for volume in [0.0, 0.5, 2.0] {
            let mut buffer = VecDeque::new();
            let meter =
                TrackPlayback::new(TrackSource::Microphone).push_frame(&frame, volume, &mut buffer);
            assert_eq!(meter, level);
            assert!(buffer.iter().zip(&reference).all(|(s, r)| *s == r * volume));
        }
    }

    #[test]
    fn pauses_do_not_raise_the_gain_on_background_noise() {
        let mut track = TrackPlayback::new(TrackSource::Microphone);
        let mut buffer = VecDeque::new();
        track.push_frame(&tone(16000.0), 1.0, &mut buffer);
        buffer.clear();
        let background = tone(50.0);
        track.push_frame(&background, 1.0, &mut buffer);
        let before = buffer.clone();
        for _ in 0..100 {
            buffer.clear();
            track.push_frame(&background, 1.0, &mut buffer);
        }
        assert_eq!(buffer, before);
        buffer.clear();
        track.push_frame(&[0; 480], 1.0, &mut buffer);
        assert!(buffer.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn screen_share_obeys_its_own_volume_and_skips_speech_leveling() {
        let mut track = TrackPlayback::new(TrackSource::ScreenshareAudio);
        let mut buffer = VecDeque::new();
        let meter = track.push_frame(&[i16::MIN, 0, 8192], 0.5, &mut buffer);
        assert_eq!(meter, None);
        assert_eq!(buffer, [-0.5, 0.0, 0.125]);
    }

    #[test]
    fn overlapping_peaks_are_limited_and_the_mix_recovers() {
        for rate in [44100, 48000, 96000] {
            let mut limiter = MixLimiter::new(rate);
            assert_eq!(limiter.process(0.75), 0.75);
            for peak in [2.0, -3.0, 5.0, -8.0] {
                assert!((limiter.process(peak) - peak.signum()).abs() < 0.00001);
            }
            assert!(limiter.process(0.75) < 0.1);
            for _ in 0..rate {
                limiter.process(0.0);
            }
            assert!((limiter.process(0.75) - 0.75).abs() < 0.001);
        }
    }
}

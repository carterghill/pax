use super::{setup_mic_input, AudioState, NoiseProcessor, SAMPLE_RATE};
use crate::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tauri::State;
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

const MAX_RECORDING_SECONDS: u32 = 300;
const MAX_SAMPLES: usize = (SAMPLE_RATE * MAX_RECORDING_SECONDS) as usize;

#[cfg(target_os = "ios")]
mod ios {
    use std::ffi::c_void;

    extern "C" {
        fn pax_begin_recording_audio_session() -> *mut c_void;
        fn pax_end_recording_audio_session(handle: *mut c_void);
    }

    pub(super) struct RecordingAudioSession(*mut c_void);

    // The retained Objective-C token is owned by this guard and may be released on any thread.
    unsafe impl Send for RecordingAudioSession {}

    impl RecordingAudioSession {
        pub(super) fn begin() -> Result<Self, String> {
            let handle = unsafe { pax_begin_recording_audio_session() };
            if handle.is_null() {
                return Err(
                    "Microphone access is required and the iOS audio session must be available."
                        .into(),
                );
            }
            Ok(Self(handle))
        }
    }

    impl Drop for RecordingAudioSession {
        fn drop(&mut self) {
            unsafe { pax_end_recording_audio_session(self.0) };
        }
    }
}

pub(crate) struct AudioRecording {
    id: uuid::Uuid,
    stop: oneshot::Sender<()>,
    capture: JoinHandle<Vec<i16>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordedAudio {
    upload_id: String,
    path: std::path::PathBuf,
    byte_size: usize,
    duration_ms: u64,
}

#[tauri::command]
pub(crate) async fn start_audio_recording(
    state: State<'_, Arc<AppState>>,
    recording_id: String,
    input_device_id: Option<String>,
) -> Result<u32, String> {
    let id = uuid::Uuid::parse_str(&recording_id).map_err(|_| "Invalid recording ID")?;
    let mut active = state.audio_recording.lock().await;
    if active.is_some() {
        return Err("An audio recording is already in progress.".into());
    }
    if state.client.lock().await.is_none() {
        return Err("Sign in to record an audio message.".into());
    }

    let (frames, mut audio) = mpsc::channel(100);
    let (stream, audio_session) = tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "ios")]
        let audio_session = ios::RecordingAudioSession::begin()?;
        #[cfg(not(target_os = "ios"))]
        let audio_session = ();
        let stream = setup_mic_input(
            Arc::new(Mutex::new(AudioState::default())),
            Arc::new(Mutex::new(NoiseProcessor::new())),
            frames,
            input_device_id.as_deref(),
        )?;
        stream.play()?;
        Ok::<_, String>((stream, audio_session))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not start the microphone: {e}"))?;

    let (stop, mut stopped) = oneshot::channel();
    let capture = tokio::spawn(async move {
        let deadline = tokio::time::sleep(Duration::from_secs(MAX_RECORDING_SECONDS.into()));
        tokio::pin!(deadline);
        let mut samples = Vec::new();
        while samples.len() < MAX_SAMPLES {
            tokio::select! {
                _ = &mut stopped => break,
                _ = &mut deadline => break,
                frame = audio.recv() => match frame {
                    Some(frame) => samples.extend(frame),
                    None => break,
                },
            }
        }
        drop(stream);
        #[cfg(target_os = "ios")]
        drop(audio_session);
        #[cfg(not(target_os = "ios"))]
        let () = audio_session;
        while samples.len() < MAX_SAMPLES {
            let Ok(frame) = audio.try_recv() else { break };
            samples.extend(frame);
        }
        samples.truncate(MAX_SAMPLES);
        samples
    });
    *active = Some(AudioRecording { id, stop, capture });
    Ok(MAX_RECORDING_SECONDS)
}

#[tauri::command]
pub(crate) async fn stop_audio_recording(
    state: State<'_, Arc<AppState>>,
    recording_id: String,
) -> Result<RecordedAudio, String> {
    let id = uuid::Uuid::parse_str(&recording_id).map_err(|_| "Invalid recording ID")?;
    let mut active = state.audio_recording.lock().await;
    let samples = finish_recording(&mut active, id).await?;
    if samples.is_empty() {
        return Err("The microphone did not capture any audio.".into());
    }
    let upload_id = id.to_string();
    let path = crate::commands::media_files::room_file_staging_path(&upload_id);
    let duration_ms = (samples.len() as u64 * 1000).div_ceil(u64::from(SAMPLE_RATE));
    let bytes = wav(&samples);
    let byte_size = bytes.len();
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&path)
        .await
        .map_err(|error| format!("Could not save the voice message: {error}"))?;
    let result = async {
        file.write_all(&bytes).await?;
        file.flush().await
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(format!("Could not save the voice message: {error}"));
    }
    Ok(RecordedAudio {
        upload_id,
        path,
        byte_size,
        duration_ms,
    })
}

#[tauri::command]
pub(crate) async fn cancel_audio_recording(
    state: State<'_, Arc<AppState>>,
    recording_id: String,
) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&recording_id).map_err(|_| "Invalid recording ID")?;
    let mut active = state.audio_recording.lock().await;
    if active.as_ref().is_some_and(|recording| recording.id == id) {
        finish_recording(&mut active, id).await?;
    }
    let path = crate::commands::media_files::room_file_staging_path(&id.to_string());
    let _ = tokio::fs::remove_file(path).await;
    Ok(())
}

async fn finish_recording(
    active: &mut Option<AudioRecording>,
    id: uuid::Uuid,
) -> Result<Vec<i16>, String> {
    let Some(recording) = active.take_if(|recording| recording.id == id) else {
        return Err("This audio recording is no longer available.".into());
    };
    let _ = recording.stop.send(());
    recording.capture.await.map_err(|e| e.to_string())
}

fn wav(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * size_of::<i16>()) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes()); // block alignment
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
    bytes
}

#[cfg(test)]
#[test]
fn voice_recording_wav_contains_pcm_and_byte_rate() {
    let bytes = wav(&[-100, 100]);
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..16], b"WAVEfmt ");
    assert_eq!(&bytes[28..32], &96_000u32.to_le_bytes());
    assert_eq!(&bytes[36..44], b"data\x04\0\0\0");
    assert_eq!(&bytes[44..], &[156, 255, 100, 0]);
}

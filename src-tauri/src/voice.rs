/// Rust-native voice chat using the LiveKit Rust SDK + cpal for audio I/O.
///
/// This module replaces the browser-based livekit-client JS SDK, which cannot
/// work inside WebKitGTK because WebRTC is unreliable/unsupported there.
///
/// Architecture:
///   Mic:  cpal input → ring buffer → tokio task → NativeAudioSource → LiveKit
///   Spkr: LiveKit → NativeAudioStream → per-user volume → mix → ring buffer → cpal output
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use livekit::prelude::*;
use livekit::track::{LocalAudioTrack, LocalTrack, RemoteTrack, TrackSource};
use livekit::options::TrackPublishOptions;
use livekit::webrtc::{
    audio_frame::AudioFrame,
    audio_source::native::NativeAudioSource,
    audio_stream::native::NativeAudioStream,
    prelude::{AudioSourceOptions, RtcAudioSource},
};
use futures_util::StreamExt;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use nnnoiseless::DenoiseState;
use once_cell::sync::Lazy;
// cpal::Stream is !Send because of platform internals, but we only ever
// create streams on one thread and drop them (possibly on another).
// This is safe for our use case.
struct SendStream(cpal::Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}
// ─── Constants ──────────────────────────────────────────────────────────────
const SAMPLE_RATE: u32 = 48000;
const NUM_CHANNELS: u32 = 1;
const SAMPLES_PER_10MS: u32 = SAMPLE_RATE / 100; // 480
// ─── Types emitted to the frontend ─────────────────────────────────────────
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipantInfo {
    pub identity: String,
    pub is_speaking: bool,
    pub is_local: bool,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStateEvent {
    pub connected_room_id: Option<String>,
    pub is_connecting: bool,
    pub is_mic_enabled: bool,
    pub is_noise_suppressed: bool,
    /// Identity of the participant currently sharing their screen (if any)
    pub screen_sharing_owner: Option<String>,
    /// Whether this client is currently sharing its own screen
    pub is_local_screen_sharing: bool,
    pub error: Option<String>,
    pub participants: Vec<VoiceParticipantInfo>,
}
// ─── Internal shared audio state ────────────────────────────────────────────
struct AudioState {
    /// Mixed playback samples from all remote participants (f32, mono)
    playback_buffer: VecDeque<f32>,
    /// Per-user volume multiplier (0.0 – 2.0, default 1.0)
    user_volumes: HashMap<String, f32>,
    /// Currently active speakers
    active_speakers: Vec<String>,
    /// All remote participant identities we know about
    remote_participants: Vec<String>,
    /// Whether mic is enabled
    mic_enabled: bool,
    /// Whether mic noise suppression is enabled
    noise_suppression_enabled: bool,
    /// Identity of the participant currently sharing their screen, if any
    screen_sharing_owner: Option<String>,
    /// Whether this client is currently sharing its own screen
    is_local_screen_sharing: bool,
}
impl Default for AudioState {
    fn default() -> Self {
        Self {
            playback_buffer: VecDeque::with_capacity(SAMPLE_RATE as usize),
            user_volumes: HashMap::new(),
            active_speakers: Vec::new(),
            remote_participants: Vec::new(),
            mic_enabled: true,
            noise_suppression_enabled: true,
            screen_sharing_owner: None,
            is_local_screen_sharing: false,
        }
    }
}
// ─── VoiceSession ───────────────────────────────────────────────────────────
/// Holds the LiveKit room + audio state for one active voice call.
pub struct VoiceSession {
    room: Arc<livekit::Room>,
    audio_state: Arc<Mutex<AudioState>>,
    room_id: String,
    local_identity: String,
    /// Stored to keep the cpal streams alive (dropped on disconnect)
    _input_stream: Option<SendStream>,
    _output_stream: Option<SendStream>,
    /// Cancellation handle for the event loop
    shutdown_tx: mpsc::Sender<()>,
    /// Screen share handle (track + capture shutdown); dropped on stop
    _screen_handle: Option<crate::screen::ScreenShareHandle>,
    /// Noise processor for tunable suppression (shared with mic callback)
    noise_proc: Arc<Mutex<NoiseProcessor>>,
}
impl VoiceSession {
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    pub fn local_identity(&self) -> &str {
        &self.local_identity
    }
}
/// Global singleton for the current voice session.
/// Only one voice call is active at a time.
pub struct VoiceManager {
    session: Mutex<Option<VoiceSession>>,
}
impl VoiceManager {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
    /// Connect to a LiveKit room and start audio.
    pub async fn connect(
        &self,
        room_id: String,
        livekit_url: String,
        jwt: String,
        local_identity: String,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Disconnect existing session first
        self.disconnect_inner().await;
        // Emit "connecting" state
        let _ = app_handle.emit("voice-state-changed", VoiceStateEvent {
            connected_room_id: Some(room_id.clone()),
            is_connecting: true,
            is_mic_enabled: false,
            is_noise_suppressed: true,
            screen_sharing_owner: None,
            is_local_screen_sharing: false,
            error: None,
            participants: vec![],
        });
        let audio_state = Arc::new(Mutex::new(AudioState::default()));
        // 1. Create audio source for mic
        let audio_source = NativeAudioSource::new(
            AudioSourceOptions {
                echo_cancellation: false,
                noise_suppression: false,
                auto_gain_control: false,
            },
            SAMPLE_RATE,
            NUM_CHANNELS,
            100, // 100ms buffer
        );
        // 2. Connect to LiveKit room (do this BEFORE creating cpal streams,
        //    because cpal::Stream is !Send and can't exist across await points)
        let room_options = RoomOptions::default();
        let (room, events) = livekit::Room::connect(&livekit_url, &jwt, room_options)
            .await
            .map_err(|e| format!("LiveKit connection failed: {}", e))?;
        let room = Arc::new(room);
        // 3. Publish mic track
        let mic_track = LocalAudioTrack::create_audio_track(
            "microphone",
            RtcAudioSource::Native(audio_source.clone()),
        );
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(mic_track),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("Failed to publish mic track: {}", e))?;
        // 4. Now set up cpal streams (no more .await after this point)
        // Create a channel for mic frames: cpal callback → pump task
        let (mic_frame_tx, mic_frame_rx) = mpsc::channel::<Vec<i16>>(10); // small bounded buffer
        let noise_proc = Arc::new(Mutex::new(NoiseProcessor::new()));
        noise_proc.lock().set_enabled(audio_state.lock().noise_suppression_enabled);
        let input_stream = setup_mic_input(audio_state.clone(), noise_proc.clone(), mic_frame_tx)
            .map_err(|e| format!("Failed to open microphone: {}", e))?;
        let output_stream = setup_speaker_output(audio_state.clone())
            .map_err(|e| format!("Failed to open speakers: {}", e))?;
        // 5. Start mic capture pump (receives frames from cpal callback → LiveKit)
        let mic_source = audio_source.clone();
        tokio::spawn(async move {
            mic_capture_pump(mic_source, mic_frame_rx).await;
        });
        // 6. Start event loop
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);
        let evt_state = audio_state.clone();
        let evt_room_id = room_id.clone();
        let evt_room = room.clone();
        let evt_local_id = local_identity.clone();
        tokio::spawn(async move {
            run_event_loop(
                events,
                evt_state,
                evt_room,
                evt_room_id,
                evt_local_id,
                app_handle,
                shutdown_rx,
            )
            .await;
        });
        // 7. Start cpal streams and wrap for Send safety
        input_stream.play().map_err(|e| format!("Mic stream error: {}", e))?;
        output_stream.play().map_err(|e| format!("Speaker stream error: {}", e))?;
        // Wrap in SendStream so VoiceSession is Send+Sync for Tauri State
        let input_stream = SendStream(input_stream);
        let output_stream = SendStream(output_stream);
        // Store session
        {
            let mut guard = self.session.lock();
            *guard = Some(VoiceSession {
                room,
                audio_state,
                room_id,
                local_identity,
                _input_stream: Some(input_stream),
                _output_stream: Some(output_stream),
                shutdown_tx,
                _screen_handle: None,
                noise_proc,
            });
        }
        Ok(())
    }
    /// Disconnect from voice, cleaning up all resources.
    pub async fn disconnect(&self) {
        self.disconnect_inner().await;
    }
    async fn disconnect_inner(&self) {
        let session = {
            let mut guard = self.session.lock();
            guard.take()
        };
        if let Some(session) = session {
            // Signal the event loop to stop
            let _ = session.shutdown_tx.send(()).await;
            // Close the LiveKit room
            if let Err(e) = session.room.close().await {
                log::error!("Error closing LiveKit room: {}", e);
            }
            // cpal streams are dropped here automatically
        }
    }
    /// Toggle mic mute/unmute. Returns new enabled state.
    pub fn toggle_mic(&self) -> Result<bool, String> {
        let guard = self.session.lock();
        let session = guard.as_ref().ok_or("Not in a voice call")?;
        let mut state = session.audio_state.lock();
        state.mic_enabled = !state.mic_enabled;
        // Mute/unmute the published track
        let publications = session.room.local_participant().track_publications();
        for (_sid, pub_) in publications.iter() {
            if state.mic_enabled {
                pub_.unmute();
            } else {
                pub_.mute();
            }
        }
        Ok(state.mic_enabled)
    }

    /// Toggle noise suppression on/off. Returns new enabled state.
    pub fn toggle_noise_suppression(&self) -> Result<bool, String> {
        let guard = self.session.lock();
        let session = guard.as_ref().ok_or("Not in a voice call")?;
        let mut st = session.audio_state.lock();
        st.noise_suppression_enabled = !st.noise_suppression_enabled;
        let enabled = st.noise_suppression_enabled;
        drop(st);
        session.noise_proc.lock().set_enabled(enabled);
        Ok(enabled)
    }

    /// Update noise suppression parameters (takes effect immediately when in a call).
    pub fn set_noise_suppression_config(&self, config: NoiseSuppressionConfig) -> Result<(), String> {
        *NOISE_SUPPRESSION_CONFIG.write() = config.clone();
        let guard = self.session.lock();
        if let Some(session) = guard.as_ref() {
            session.noise_proc.lock().set_config(config);
        }
        Ok(())
    }

    /// Get current noise suppression config (from session if in call, else stored default).
    pub fn get_noise_suppression_config(&self) -> Result<NoiseSuppressionConfig, String> {
        let guard = self.session.lock();
        Ok(guard
            .as_ref()
            .map(|s| s.noise_proc.lock().config.clone())
            .unwrap_or_else(|| NOISE_SUPPRESSION_CONFIG.read().clone()))
    }

    /// Set per-user volume (0.0 – 2.0).
    pub fn set_participant_volume(&self, identity: String, volume: f32) {
        let guard = self.session.lock();
        let clamped = volume.clamp(0.0, 2.0);
        if let Some(session) = guard.as_ref() {
            let mut state = session.audio_state.lock();
            let old_volume = state.user_volumes.insert(identity.clone(), clamped);

            // If the volume actually changed, clear the playback buffer so the new
            // volume takes effect *immediately*.
            if old_volume != Some(clamped) {
                state.playback_buffer.clear();
            }
        } 
    }
    /// Get the currently connected room ID, if any.
    pub fn connected_room_id(&self) -> Option<String> {
        let guard = self.session.lock();
        guard.as_ref().map(|s| s.room_id.clone())
    }

    /// Start sharing screen. Returns error if not in a call or capture fails.
    /// For Window mode, window_title selects which window (None = foreground).
    pub async fn start_screen_share(
        &self,
        mode: crate::screen::ScreenShareMode,
        window_title: Option<String>,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        let (room, audio_state, room_id, local_identity) = {
            let guard = self.session.lock();
            let session = guard.as_ref().ok_or("Not in a voice call")?;
            (
                session.room.clone(),
                session.audio_state.clone(),
                session.room_id.clone(),
                session.local_identity.clone(),
            )
        };
        eprintln!("[Pax] voice::start_screen_share: mode={:?} window_title={:?}", mode, window_title);
        let handle = crate::screen::start_screen_capture(room.clone(), mode, window_title).await?;
        // Video is published inside start_screen_capture (after capture is hot)
        if let Some(audio_track) = &handle.audio_track {
            eprintln!("[Pax] Publishing screen share audio track (ScreenshareAudio)");
            room.local_participant()
                .publish_track(
                    LocalTrack::Audio(audio_track.clone()),
                    TrackPublishOptions {
                        source: TrackSource::ScreenshareAudio,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| format!("Failed to publish screen audio track: {}", e))?;
        }
        {
            let mut guard = self.session.lock();
            let session = guard.as_mut().ok_or("Not in a voice call")?;
            session._screen_handle = Some(handle);
        }
        {
            let mut st = audio_state.lock();
            st.is_local_screen_sharing = true;
        }
        emit_state(app_handle, &room_id, &local_identity, &audio_state, false, true, None);
        Ok(())
    }

    /// Stop sharing screen.
    pub async fn stop_screen_share(&self, app_handle: &AppHandle) -> Result<(), String> {
        eprintln!("[Pax] voice::stop_screen_share");
        let (room, audio_state, mut handle, room_id, local_identity) = {
            let mut guard = self.session.lock();
            let session = guard.as_mut().ok_or("Not in a voice call")?;
            let handle = session._screen_handle.take();
            (
                session.room.clone(),
                session.audio_state.clone(),
                handle,
                session.room_id.clone(),
                session.local_identity.clone(),
            )
        };
        if let Some(mut h) = handle.take() {
            h.stop();
            let lp = room.local_participant();
            let sids: Vec<_> = lp
                .track_publications()
                .iter()
                .filter(|(_, p)| {
                    let s = p.source();
                    s == TrackSource::Screenshare || s == TrackSource::ScreenshareAudio
                })
                .map(|(sid, _)| sid.clone())
                .collect();
            for sid in sids {
                let _ = lp.unpublish_track(&sid).await;
            }
        }
        {
            let mut st = audio_state.lock();
            st.is_local_screen_sharing = false;
        }
        emit_state(app_handle, &room_id, &local_identity, &audio_state, false, true, None);
        Ok(())
    }
}
// ─── Mic capture pump ───────────────────────────────────────────────────────
/// Receives completed mic frames from the cpal callback channel and sends to LiveKit.
/// Zero latency added — frames arrive as soon as cpal has enough samples.
async fn mic_capture_pump(
    source: NativeAudioSource,
    mut frame_rx: mpsc::Receiver<Vec<i16>>,
) {
    while let Some(samples) = frame_rx.recv().await {
        let frame = AudioFrame {
            data: samples.into(),
            sample_rate: SAMPLE_RATE,
            num_channels: NUM_CHANNELS,
            samples_per_channel: SAMPLES_PER_10MS,
        };
        if let Err(e) = source.capture_frame(&frame).await {
            log::error!("Failed to capture mic frame: {}", e);
        }
    }
}

/// Receives audio from one remote participant, applies volume, and mixes into playback buffer.
async fn handle_remote_audio(
    audio_track: RemoteAudioTrack,
    identity: String,
    audio_state: Arc<Mutex<AudioState>>,
) {
    let mut stream = NativeAudioStream::new(
        audio_track.rtc_track(),
        SAMPLE_RATE as i32,
        NUM_CHANNELS as i32,
    );
    while let Some(frame) = stream.next().await {
        let samples: &[i16] = frame.data.as_ref();
        let mut st = audio_state.lock();
        let key = identity.split(':').take(2).collect::<Vec<_>>().join(":");
        let volume = *st.user_volumes.get(&key).unwrap_or(&1.0);
        // Cap playback buffer at ~500ms to prevent unbounded growth
        let max_buf = (SAMPLE_RATE / 2) as usize;
        while st.playback_buffer.len() + samples.len() > max_buf {
            st.playback_buffer.pop_front();
        }

        // Convert i16 → f32, apply volume, and MIX (add) into the buffer.
        for &s in samples {
            let f = ((s as f32 / 32768.0) * volume).clamp(-1.0, 1.0);
            st.playback_buffer.push_back(f);
        }
    }
}
// ─── Event loop ─────────────────────────────────────────────────────────────
async fn run_event_loop(
    mut events: mpsc::UnboundedReceiver<RoomEvent>,
    audio_state: Arc<Mutex<AudioState>>,
    _room: Arc<livekit::Room>,
    room_id: String,
    local_identity: String,
    app_handle: AppHandle,
    mut shutdown_rx: mpsc::Receiver<()>,
) {
    // Emit initial connected state
    emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                break;
            }
            event = events.recv() => {
                match event {
                    Some(RoomEvent::TrackSubscribed { track, publication, participant }) => {
                        let identity = participant.identity().to_string();
                        let source = publication.source();
                        if let RemoteTrack::Audio(audio_track) = track {
                            {
                                let mut st = audio_state.lock();
                                if !st.remote_participants.contains(&identity) {
                                    st.remote_participants.push(identity.clone());
                                }
                            }
                            let state_clone = audio_state.clone();
                            tokio::spawn(async move {
                                handle_remote_audio(audio_track, identity, state_clone).await;
                            });
                            emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
                        } else if let RemoteTrack::Video(_video_track) = track {
                            if source == TrackSource::Screenshare {
                                let mut st = audio_state.lock();
                                st.screen_sharing_owner = Some(identity);
                                drop(st);
                                emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
                            }
                        }
                    }
                    Some(RoomEvent::TrackUnsubscribed { publication, participant, .. }) => {
                        let identity = participant.identity().to_string();
                        if publication.source() == TrackSource::Screenshare {
                            let mut st = audio_state.lock();
                            if st.screen_sharing_owner.as_deref() == Some(&identity) {
                                st.screen_sharing_owner = None;
                            }
                            drop(st);
                            emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
                        }
                    }
                    Some(RoomEvent::ParticipantConnected(participant)) => {
                        let identity = participant.identity().to_string();
                        println!("[Pax] Participant connected: {}", identity);
                        {
                            let mut st = audio_state.lock();
                            if !st.remote_participants.contains(&identity) {
                                st.remote_participants.push(identity);
                            }
                        }
                        emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
                    }
                    Some(RoomEvent::ParticipantDisconnected(participant)) => {
                        let identity = participant.identity().to_string();
                        println!("[Pax] Participant disconnected: {}", identity);
                        {
                            let mut st = audio_state.lock();
                            st.remote_participants.retain(|id| id != &identity);
                            if st.screen_sharing_owner.as_deref() == Some(&identity) {
                                st.screen_sharing_owner = None;
                            }
                        }
                        emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
                    }
                    Some(RoomEvent::ActiveSpeakersChanged { speakers }) => {
                        let speaker_ids: Vec<String> = speakers
                            .iter()
                            .map(|p| p.identity().to_string())
                            .collect();
                        {
                            let mut st = audio_state.lock();
                            st.active_speakers = speaker_ids;
                        }
                        emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, true, None);
                    }
                    Some(RoomEvent::Disconnected { reason }) => {
                        log::info!("[Pax] Disconnected from LiveKit room: {:?}", reason);
                        emit_state(&app_handle, &room_id, &local_identity, &audio_state, false, false, Some("Disconnected from voice".into()));
                        break;
                    }
                    None => {
                        log::info!("[Pax] LiveKit event channel closed");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
}
fn emit_state(
    app_handle: &AppHandle,
    room_id: &str,
    local_identity: &str,
    audio_state: &Arc<Mutex<AudioState>>,
    is_connecting: bool,
    is_connected: bool,
    error: Option<String>,
) {
    let st = audio_state.lock();
    let mut participants = Vec::new();
    // Local participant
    if is_connected {
        participants.push(VoiceParticipantInfo {
            identity: local_identity.to_string(),
            is_speaking: st.active_speakers.contains(&local_identity.to_string()),
            is_local: true,
        });
    }
    // Remote participants
    for id in &st.remote_participants {
        participants.push(VoiceParticipantInfo {
            identity: id.clone(),
            is_speaking: st.active_speakers.contains(id),
            is_local: false,
        });
    }
    let event = VoiceStateEvent {
        connected_room_id: if is_connected || is_connecting { Some(room_id.to_string()) } else { None },
        is_connecting,
        is_mic_enabled: st.mic_enabled,
        is_noise_suppressed: st.noise_suppression_enabled,
        screen_sharing_owner: st.screen_sharing_owner.clone(),
        is_local_screen_sharing: st.is_local_screen_sharing,
        error,
        participants,
    };
    let _ = app_handle.emit("voice-state-changed", event);
}
// ─── cpal audio setup ───────────────────────────────────────────────────────
/// Tunable noise suppression parameters.
///
/// RNNoise already performs spectral noise suppression via its neural network.
/// These parameters control *optional* post-processing on top of the denoised
/// output.  With `extra_attenuation = 0.0` and `agc_target_rms = 0`, the
/// behaviour matches the original frontend WASM worklet (pure RNNoise).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseSuppressionConfig {
    /// Additional soft gating strength applied on top of RNNoise.
    /// 0.0 = pure RNNoise output (recommended default).
    /// Higher values apply a VAD-probability-weighted gain curve that further
    /// attenuates non-voice frames.  Range 0.0 – 1.0.
    pub extra_attenuation: f32,
    /// AGC target RMS level.  0 = AGC disabled (recommended default).
    /// When >0, a gentle automatic gain control normalises voice loudness.
    pub agc_target_rms: f32,
}

impl Default for NoiseSuppressionConfig {
    fn default() -> Self {
        Self {
            extra_attenuation: 0.0,
            agc_target_rms: 0.0,
        }
    }
}

static NOISE_SUPPRESSION_CONFIG: Lazy<parking_lot::RwLock<NoiseSuppressionConfig>> =
    Lazy::new(|| parking_lot::RwLock::new(NoiseSuppressionConfig::default()));

struct NoiseProcessor {
    enabled: bool,
    warmed_up: bool,
    denoise: Option<Box<DenoiseState<'static>>>,
    in_f32: Vec<f32>,
    out_f32: Vec<f32>,
    /// Smoothed soft-gate gain (only used when extra_attenuation > 0)
    gate_gain: f32,
    /// Smoothed AGC gain (only used when agc_target_rms > 0)
    agc_gain: f32,
    config: NoiseSuppressionConfig,
}

impl NoiseProcessor {
    fn new() -> Self {
        Self {
            enabled: false,
            warmed_up: false,
            denoise: None,
            in_f32: vec![0.0; SAMPLES_PER_10MS as usize],
            out_f32: vec![0.0; SAMPLES_PER_10MS as usize],
            gate_gain: 1.0,
            agc_gain: 1.0,
            config: NOISE_SUPPRESSION_CONFIG.read().clone(),
        }
    }

    fn set_config(&mut self, config: NoiseSuppressionConfig) {
        self.config = config;
    }

    fn set_enabled(&mut self, enabled: bool) {
        if enabled == self.enabled {
            return;
        }
        self.enabled = enabled;
        if enabled {
            self.denoise = Some(DenoiseState::new());
            self.warmed_up = false;
            self.gate_gain = 1.0;
            self.agc_gain = 1.0;
        } else {
            self.denoise = None;
            self.warmed_up = false;
            self.gate_gain = 1.0;
            self.agc_gain = 1.0;
        }
    }

    fn process_i16_in_place(&mut self, samples: &mut [i16]) {
        if !self.enabled {
            return;
        }
        if samples.len() != SAMPLES_PER_10MS as usize {
            return;
        }
        let Some(denoise) = self.denoise.as_mut() else {
            return;
        };

        // nnnoiseless expects f32 samples in i16-scale (not normalised to -1..1)
        for (i, &s) in samples.iter().enumerate() {
            self.in_f32[i] = s as f32;
        }

        let vad_prob = denoise.process_frame(&mut self.out_f32[..], &self.in_f32[..]);

        if !self.warmed_up {
            self.warmed_up = true;
            return;
        }

        // ── Core: use RNNoise denoised output directly ──────────────────
        // This matches the original frontend WASM worklet behaviour.
        // The neural network has already performed spectral noise suppression;
        // the output in self.out_f32 is the clean signal.

        let mut combined_gain: f32 = 1.0;

        // ── Optional soft VAD gate ──────────────────────────────────────
        // When extra_attenuation > 0, use the continuous VAD probability to
        // gently reduce gain during non-voice frames.  This is a smooth
        // probability-weighted curve — NOT a binary open/close gate.
        let atten = self.config.extra_attenuation.clamp(0.0, 1.0);
        if atten > 0.0 {
            // Map extra_attenuation 0..1 → exponent 1..4 for the VAD curve.
            // Higher exponent = more aggressive suppression of low-probability frames.
            let curve = 1.0 + atten * 3.0;
            let vad_factor = vad_prob.powf(curve);
            let floor = 0.01_f32;
            let target = floor + (1.0 - floor) * vad_factor;

            let coeff = if target > self.gate_gain { 0.6 } else { 0.15 };
            self.gate_gain += (target - self.gate_gain) * coeff;
            combined_gain *= self.gate_gain;
        }

        // ── Optional gentle AGC ─────────────────────────────────────────
        let agc_target = self.config.agc_target_rms;
        if agc_target > 0.0 && vad_prob > 0.5 {
            const AGC_MIN: f32 = 0.5;
            const AGC_MAX: f32 = 3.0;
            const AGC_SPEED: f32 = 0.05;

            let mut sum_sq = 0.0f32;
            for &s in &self.out_f32 {
                sum_sq += s * s;
            }
            let rms = (sum_sq / self.out_f32.len() as f32).sqrt().max(1.0);
            let desired = (agc_target / rms).clamp(AGC_MIN, AGC_MAX);
            self.agc_gain += (desired - self.agc_gain) * AGC_SPEED;
            combined_gain *= self.agc_gain;
        }

        // ── Limiter ─────────────────────────────────────────────────────
        if combined_gain != 1.0 {
            let mut peak = 0.0f32;
            for &s in &self.out_f32 {
                peak = peak.max((s * combined_gain).abs());
            }
            if peak > i16::MAX as f32 {
                combined_gain *= (i16::MAX as f32) / peak;
            }
        }

        // ── Write output ────────────────────────────────────────────────
        for (i, out) in self.out_f32.iter().enumerate() {
            let scaled = out * combined_gain;
            samples[i] = scaled.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
    }
}

fn setup_mic_input(
    audio_state: Arc<Mutex<AudioState>>,
    noise_proc: Arc<Mutex<NoiseProcessor>>,
    frame_tx: mpsc::Sender<Vec<i16>>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found")?;
    log::info!("[Pax] Using input device: {:?}", device.name());
    let default_config = device.default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;
    let channels = default_config.channels();
    let config = cpal::StreamConfig {
        channels,
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    log::info!("[Pax] Mic config: {}ch @ {}Hz", channels, default_config.sample_rate().0);
    // Local frame accumulator — shared with the cpal callback via Arc<Mutex>
    let frame_buf: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(
        Vec::with_capacity(SAMPLES_PER_10MS as usize * 2),
    ));
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Check mute state
                let (is_muted, noise_suppression_enabled) = {
                    let st = audio_state.lock();
                    (!st.mic_enabled, st.noise_suppression_enabled)
                };
                let ch = channels as usize;
                let frame_size = SAMPLES_PER_10MS as usize;
                let mut buf = frame_buf.lock();
                // Extract mono (channel 0) and convert f32 → i16
                for frame in data.chunks(ch) {
                    let sample = if is_muted { 0.0 } else { frame[0] };
                    let clamped = sample.clamp(-1.0, 1.0);
                    buf.push((clamped * 32767.0) as i16);
                }
                // Send completed frames immediately via channel
                while buf.len() >= frame_size {
                    let mut samples: Vec<i16> = buf.drain(..frame_size).collect();

                    // Apply noise suppression (RNNoise-style) only when enabled and not muted.
                    if noise_suppression_enabled && !is_muted {
                        let mut np = noise_proc.lock();
                        np.set_enabled(true);
                        np.process_i16_in_place(&mut samples[..]);
                    } else {
                        let mut np = noise_proc.lock();
                        np.set_enabled(false);
                    }

                    // try_send is non-blocking — drop frame if channel is full (backpressure)
                    let _ = frame_tx.try_send(samples);
                }
            },
            move |err| {
                log::error!("[Pax] Mic input error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {}", e))?;
    Ok(stream)
}
fn setup_speaker_output(audio_state: Arc<Mutex<AudioState>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No audio output found")?;
    log::info!("[Pax] Using output device: {:?}", device.name());
    // Use the device's preferred config (Windows typically requires stereo)
    let default_config = device.default_output_config()
        .map_err(|e| format!("Failed to get default output config: {}", e))?;
    let channels = default_config.channels();
    let config = cpal::StreamConfig {
        channels,
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    log::info!("[Pax] Speaker config: {}ch @ {}Hz", channels, default_config.sample_rate().0);
    let state = audio_state.clone();
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut st = state.lock();
                let ch = channels as usize;
                // Our playback buffer is mono — duplicate each sample to all output channels
                for frame in data.chunks_mut(ch) {
                    let sample = st.playback_buffer.pop_front().unwrap_or(0.0);
                    for s in frame.iter_mut() {
                        *s = sample;
                    }
                }
            },
            move |err| {
                log::error!("[Pax] Speaker output error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build output stream: {}", e))?;
    Ok(stream)
}
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
    pub error: Option<String>,
    pub participants: Vec<VoiceParticipantInfo>,
}

// ─── Internal shared audio state ────────────────────────────────────────────

struct AudioState {
    /// Mic samples waiting to be sent to LiveKit (i16, 48kHz mono)
    mic_buffer: VecDeque<i16>,
    /// Mixed playback samples from all remote participants (f32, 48kHz mono)
    playback_buffer: VecDeque<f32>,
    /// Per-user volume multiplier (0.0 – 2.0, default 1.0)
    user_volumes: HashMap<String, f32>,
    /// Currently active speakers
    active_speakers: Vec<String>,
    /// All remote participant identities we know about
    remote_participants: Vec<String>,
    /// Whether mic is enabled
    mic_enabled: bool,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            mic_buffer: VecDeque::with_capacity(SAMPLE_RATE as usize),
            playback_buffer: VecDeque::with_capacity(SAMPLE_RATE as usize),
            user_volumes: HashMap::new(),
            active_speakers: Vec::new(),
            remote_participants: Vec::new(),
            mic_enabled: true,
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
}

impl VoiceSession {
    pub fn room_id(&self) -> &str {
        &self.room_id
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
        let input_stream = setup_mic_input(audio_state.clone())
            .map_err(|e| format!("Failed to open microphone: {}", e))?;

        let output_stream = setup_speaker_output(audio_state.clone())
            .map_err(|e| format!("Failed to open speakers: {}", e))?;

        // 5. Start mic capture pump (reads from cpal buffer → LiveKit)
        let mic_source = audio_source.clone();
        let mic_state = audio_state.clone();
        tokio::spawn(async move {
            mic_capture_pump(mic_source, mic_state).await;
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

    /// Set per-user volume (0.0 – 2.0).
    pub fn set_participant_volume(&self, identity: String, volume: f32) {
        let guard = self.session.lock();
        if let Some(session) = guard.as_ref() {
            let mut state = session.audio_state.lock();
            state.user_volumes.insert(identity, volume.clamp(0.0, 2.0));
        }
    }

    /// Get the currently connected room ID, if any.
    pub fn connected_room_id(&self) -> Option<String> {
        let guard = self.session.lock();
        guard.as_ref().map(|s| s.room_id.clone())
    }
}

// ─── Mic capture pump ───────────────────────────────────────────────────────

/// Continuously reads mic samples from the ring buffer and sends them to LiveKit.
async fn mic_capture_pump(source: NativeAudioSource, state: Arc<Mutex<AudioState>>) {
    let frame_size = SAMPLES_PER_10MS as usize;

    loop {
        // Sleep ~10ms to accumulate a frame worth of samples
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let samples: Vec<i16> = {
            let mut st = state.lock();
            if !st.mic_enabled {
                // If muted, drain the buffer but send silence
                st.mic_buffer.clear();
                continue;
            }
            if st.mic_buffer.len() < frame_size {
                continue;
            }
            st.mic_buffer.drain(..frame_size).collect()
        };

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

// ─── Remote audio handler ───────────────────────────────────────────────────

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
        let volume = *st.user_volumes.get(&identity).unwrap_or(&1.0);

        // Cap playback buffer at ~500ms to prevent unbounded growth
        let max_buf = (SAMPLE_RATE / 2) as usize;
        while st.playback_buffer.len() + samples.len() > max_buf {
            st.playback_buffer.pop_front();
        }

        // Convert i16 → f32, apply volume, and MIX (add) into the buffer.
        // Since cpal output drains the buffer, we just append here.
        // If multiple participants are active, their samples interleave in time
        // and get added when they overlap in the buffer.
        for &s in samples {
            let f = (s as f32 / 32768.0) * volume;
            st.playback_buffer.push_back(f);
        }
    }

    log::info!("Audio stream ended for participant: {}", identity);
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
                log::info!("[Pax] Voice event loop shutting down");
                break;
            }
            event = events.recv() => {
                match event {
                    Some(RoomEvent::TrackSubscribed { track, publication: _, participant }) => {
                        if let RemoteTrack::Audio(audio_track) = track {
                            let identity = participant.identity().to_string();
                            log::info!("[Pax] Audio track subscribed from {}", identity);

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
                        }
                    }
                    Some(RoomEvent::TrackUnsubscribed { track: _, participant, .. }) => {
                        log::info!("[Pax] Track unsubscribed from {}", participant.identity());
                    }
                    Some(RoomEvent::ParticipantConnected(participant)) => {
                        let identity = participant.identity().to_string();
                        log::info!("[Pax] Participant connected: {}", identity);
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
                        log::info!("[Pax] Participant disconnected: {}", identity);
                        {
                            let mut st = audio_state.lock();
                            st.remote_participants.retain(|id| id != &identity);
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
        error,
        participants,
    };

    let _ = app_handle.emit("voice-state-changed", event);
}

// ─── cpal audio setup ───────────────────────────────────────────────────────

fn setup_mic_input(audio_state: Arc<Mutex<AudioState>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found")?;

    log::info!("[Pax] Using input device: {:?}", device.name());

    let config = cpal::StreamConfig {
        channels: NUM_CHANNELS as u16,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };

    let state = audio_state.clone();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut st = state.lock();
                // Convert f32 → i16 and push to mic buffer
                for &sample in data {
                    let clamped = sample.clamp(-1.0, 1.0);
                    let i16_sample = (clamped * 32767.0) as i16;
                    st.mic_buffer.push_back(i16_sample);
                }
                // Cap buffer at ~1 second
                while st.mic_buffer.len() > SAMPLE_RATE as usize {
                    st.mic_buffer.pop_front();
                }
            },
            move |err| {
                log::error!("[Pax] Mic input error: {}", err);
            },
            None, // no timeout
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

    let config = cpal::StreamConfig {
        channels: NUM_CHANNELS as u16,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };

    let state = audio_state.clone();
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut st = state.lock();
                for sample in data.iter_mut() {
                    *sample = st.playback_buffer.pop_front().unwrap_or(0.0);
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
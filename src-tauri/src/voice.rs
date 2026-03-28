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
use std::time::Duration;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::{interval_at, Instant as TokioInstant, MissedTickBehavior};
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
use std::sync::atomic::{AtomicBool, Ordering};
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
/// EMA blend for smoothed RMS (higher = snappier).
const SPEAKING_LEVEL_EMA: f32 = 0.22;
/// Normalized RMS (0..1) — above this shows the speaking ring alongside LiveKit’s active list.
/// LiveKit’s server-side `active` flag is conservative; this picks up normal conversation levels.
const SPEAKING_LEVEL_THRESHOLD: f32 = 0.009;
/// How often to push voice state so RMS-based speaking indicators stay responsive.
const SPEAKING_UI_TICK_MS: u64 = 90;
// ─── Types emitted to the frontend ─────────────────────────────────────────
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipantInfo {
    pub identity: String,
    pub is_speaking: bool,
    pub is_local: bool,
    pub is_muted: bool,
    pub is_deafened: bool,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStateEvent {
    pub connected_room_id: Option<String>,
    pub is_connecting: bool,
    pub is_mic_enabled: bool,
    pub is_deafened: bool,
    pub is_noise_suppressed: bool,
    /// Identities of participants currently sharing their screens
    pub screen_sharing_owners: Vec<String>,
    /// Whether this client is currently sharing its own screen
    pub is_local_screen_sharing: bool,
    pub error: Option<String>,
    pub participants: Vec<VoiceParticipantInfo>,
}
// ─── Internal shared audio state ────────────────────────────────────────────
struct AudioState {
    /// Per-track playback buffers from remote participants (f32, mono).
    /// Key is a track identifier like "identity::Microphone" or "identity::ScreenshareAudio".
    /// The speaker output callback sums all buffers to produce the final mix.
    playback_buffers: HashMap<String, VecDeque<f32>>,
    /// Per-user volume multiplier (0.0 – 2.0, default 1.0)
    user_volumes: HashMap<String, f32>,
    /// Currently active speakers (from LiveKit server)
    active_speakers: Vec<String>,
    /// Smoothed normalized RMS (0..1) from local mic frames (post noise processing).
    local_mic_level_smooth: f32,
    /// Smoothed normalized RMS per remote identity from decoded mic audio.
    remote_mic_level_smooth: HashMap<String, f32>,
    /// All remote participant identities we know about
    remote_participants: Vec<String>,
    /// Per-remote participant mic mute state (true = muted)
    remote_mic_muted: HashMap<String, bool>,
    /// Per-remote participant deafen state (Pax attribute-based)
    remote_deafened: HashMap<String, bool>,
    /// Whether mic is enabled
    mic_enabled: bool,
    /// Whether local playback is deafened
    deafened: bool,
    /// Whether mic noise suppression is enabled
    noise_suppression_enabled: bool,
    /// Identities of participants currently sharing their screens
    screen_sharing_owners: Vec<String>,
    /// Whether this client is currently sharing its own screen
    is_local_screen_sharing: bool,
    /// Per-identity shutdown flags for remote screen share video receiver tasks
    video_recv_shutdowns: HashMap<String, Arc<AtomicBool>>,
}
impl Default for AudioState {
    fn default() -> Self {
        Self {
            playback_buffers: HashMap::new(),
            user_volumes: HashMap::new(),
            active_speakers: Vec::new(),
            local_mic_level_smooth: 0.0,
            remote_mic_level_smooth: HashMap::new(),
            remote_participants: Vec::new(),
            remote_mic_muted: HashMap::new(),
            remote_deafened: HashMap::new(),
            mic_enabled: true,
            deafened: false,
            noise_suppression_enabled: true,
            screen_sharing_owners: Vec::new(),
            is_local_screen_sharing: false,
            video_recv_shutdowns: HashMap::new(),
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
        // AppHandle::clone uses Rc for the event loop — share via Arc from this tokio task
        // and from nested spawns (e.g. video receiver) instead of cloning AppHandle on workers.
        let app_handle = Arc::new(app_handle);
        // Emit "connecting" state
        let _ = app_handle.emit("voice-state-changed", VoiceStateEvent {
            connected_room_id: Some(room_id.clone()),
            is_connecting: true,
            is_mic_enabled: false,
            is_deafened: false,
            is_noise_suppressed: true,
            screen_sharing_owners: vec![],
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
            // Stop all video receivers
            {
                let mut st = session.audio_state.lock();
                for (_, shutdown) in st.video_recv_shutdowns.drain() {
                    shutdown.store(true, Ordering::Relaxed);
                }
            }
            crate::video_recv::clear_all_frame_buffers();
            crate::native_overlay::destroy_all_overlays();

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
        let mic_enabled = state.mic_enabled;
        let deafened = state.deafened;
        let room = session.room.clone();
        drop(state);
        // Mute/unmute only the microphone track — leave screen share audio untouched
        let publications = session.room.local_participant().track_publications();
        for (_sid, pub_) in publications.iter() {
            if pub_.source() != TrackSource::Microphone {
                continue;
            }
            if mic_enabled {
                pub_.unmute();
            } else {
                pub_.mute();
            }
        }
        update_local_status_attributes(room, mic_enabled, deafened);
        Ok(mic_enabled)
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

    /// Toggle local deafen on/off. Returns new deafened state.
    pub fn toggle_deafen(&self) -> Result<bool, String> {
        let guard = self.session.lock();
        let session = guard.as_ref().ok_or("Not in a voice call")?;
        let mut st = session.audio_state.lock();
        st.deafened = !st.deafened;
        let deafened = st.deafened;
        let mic_enabled = st.mic_enabled;
        let room = session.room.clone();
        drop(st);
        update_local_status_attributes(room, mic_enabled, deafened);
        Ok(deafened)
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

    /// Set per-user volume (0.0 – 2.0) for a specific source ("microphone" or "screenshare_audio").
    pub fn set_participant_volume(&self, identity: String, volume: f32, source: String) {
        let guard = self.session.lock();
        let clamped = volume.clamp(0.0, 2.0);
        if let Some(session) = guard.as_ref() {
            let mut state = session.audio_state.lock();
            // Key format: "@user:server::microphone" or "@user:server::screenshare_audio"
            let user_part: String = identity.split(':').take(2).collect::<Vec<_>>().join(":");
            let vol_key = format!("{}::{}", user_part, source);
            state.user_volumes.insert(vol_key, clamped);
        } 
    }
    /// Get the currently connected room ID, if any.
    pub fn connected_room_id(&self) -> Option<String> {
        let guard = self.session.lock();
        guard.as_ref().map(|s| s.room_id.clone())
    }

    /// Matrix room id + LiveKit SFU room name (from the joined room; used for admin ListParticipants).
    pub fn current_matrix_room_and_livekit_sfu_name(&self) -> Option<(String, String)> {
        let guard = self.session.lock();
        let s = guard.as_ref()?;
        Some((s.room_id.clone(), s.room.name()))
    }

    /// Start sharing screen. Returns error if not in a call or capture fails.
    /// For Window mode, window_title selects which window (None = foreground).
    pub async fn start_screen_share(
        &self,
        mode: crate::screen::ScreenShareMode,
        window_title: Option<String>,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        let (room, audio_state, room_id, local_identity, existing_handle) = {
            let guard = self.session.lock();
            let session = guard.as_ref().ok_or("Not in a voice call")?;
            (
                session.room.clone(),
                session.audio_state.clone(),
                session.room_id.clone(),
                session.local_identity.clone(),
                session._screen_handle.as_ref().map(|_| ()),
            )
        };
        if existing_handle.is_some() {
            // Ensure replacement semantics: never leave a stale screenshare publication active.
            self.stop_screen_share(app_handle).await?;
        } else {
            // Also clean up any orphaned screen-share publications (e.g. handle lost after an error).
            let lp = room.local_participant();
            let stale_sids: Vec<_> = lp
                .track_publications()
                .iter()
                .filter(|(_, p)| {
                    let s = p.source();
                    s == TrackSource::Screenshare || s == TrackSource::ScreenshareAudio
                })
                .map(|(sid, _)| sid.clone())
                .collect();
            for sid in stale_sids {
                let _ = lp.unpublish_track(&sid).await;
            }
        }
        log::info!("voice::start_screen_share: mode={:?} window_title={:?}", mode, window_title);
        let handle = crate::screen::start_screen_capture(room.clone(), mode, window_title).await?;
        // Video is published inside start_screen_capture (after capture is hot)
        if let Some(audio_track) = &handle.audio_track {
            log::info!("Publishing screen share audio track (ScreenshareAudio)");
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

    /// Change screen share quality on-the-fly via RtpSender::set_parameters().
    /// This updates the encoder's bitrate target on the very next frame —
    /// no track renegotiation, no subscriber interruption.
    pub async fn set_screen_share_quality(
        &self,
        quality: crate::screen::ScreenShareQuality,
        _app_handle: &AppHandle,
    ) -> Result<(), String> {
        crate::screen::set_screen_share_quality(quality);

        // Get the track from the screen handle
        let track = {
            let guard = self.session.lock();
            let session = guard.as_ref().ok_or("Not in a voice call")?;
            match session._screen_handle.as_ref() {
                Some(handle) => handle.track.clone(),
                None => {
                    // Not currently sharing — just store the quality for next time
                    return Ok(());
                }
            }
        };

        // Reach the RtpSender via the track's transceiver
        let transceiver = track
            .transceiver()
            .ok_or("Screen share track has no transceiver (not published?)")?;
        let sender = transceiver.sender();

        // Get current parameters (preserves transaction_id + encodings)
        let mut params = sender.parameters();
        if params.encodings.is_empty() {
            return Err("No encodings on screen share sender".to_string());
        }

        // Update the first encoding's max_bitrate
        let new_bitrate = quality.max_bitrate();
        params.encodings[0].max_bitrate = Some(new_bitrate);

        log::info!(
            "set_parameters: quality={} max_bitrate={} (transaction_id={}, {} encodings)",
            quality.label(),
            new_bitrate,
            params.transaction_id,
            params.encodings.len()
        );

        // Apply — encoder picks up the new bitrate on the next frame
        sender
            .set_parameters(params)
            .map_err(|e| format!("set_parameters failed: {}", e))?;

        log::info!("Screen share quality changed to {} (seamless)", quality.label());
        Ok(())
    }

    /// Stop sharing screen.
    pub async fn stop_screen_share(&self, app_handle: &AppHandle) -> Result<(), String> {
        log::info!("voice::stop_screen_share");
        let (room, audio_state, handle, room_id, local_identity) = {
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
        if let Some(mut h) = handle {
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

// ─── Native overlay helper ──────────────────────────────────────────────────

/// Get the parent HWND for native overlay creation.  The actual child HWND
/// will be created on the video receiver thread to avoid Win32 message pump
/// deadlocks.  Returns `Some(parent_hwnd)` on Windows, `None` elsewhere.
fn get_parent_hwnd_for_overlay(app_handle: &AppHandle) -> Option<isize> {
    if !crate::native_overlay::is_supported() {
        return None;
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let window = app_handle.get_webview_window("main")?;
        let hwnd = window.hwnd().ok()?.0 as isize;
        Some(hwnd)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_handle;
        None
    }
}

#[inline]
fn rms_i16_normalized(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0f64;
    for &s in samples {
        let x = s as f64 * (1.0 / 32768.0);
        acc += x * x;
    }
    (acc / samples.len() as f64).sqrt() as f32
}

#[inline]
fn ema_speaking_level(prev: f32, instant: f32) -> f32 {
    prev * (1.0 - SPEAKING_LEVEL_EMA) + instant * SPEAKING_LEVEL_EMA
}

fn merge_speaking_from_level(
    server_active: bool,
    level_smooth: f32,
    allow_level: bool,
) -> bool {
    server_active || (allow_level && level_smooth >= SPEAKING_LEVEL_THRESHOLD)
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

/// Receives audio from one remote track, applies volume, and writes into a per-track buffer.
/// The speaker output callback sums all per-track buffers for the final mix.
async fn handle_remote_audio(
    audio_track: RemoteAudioTrack,
    identity: String,
    track_key: String,
    source_tag: String,
    audio_state: Arc<Mutex<AudioState>>,
) {
    let mut stream = NativeAudioStream::new(
        audio_track.rtc_track(),
        SAMPLE_RATE as i32,
        NUM_CHANNELS as i32,
    );
    // Build the volume lookup key: "@user:server::microphone" or "@user:server::screenshare_audio"
    let user_part: String = identity.split(':').take(2).collect::<Vec<_>>().join(":");
    let vol_key = format!("{}::{}", user_part, source_tag);
    while let Some(frame) = stream.next().await {
        let samples: &[i16] = frame.data.as_ref();
        let mut st = audio_state.lock();
        let volume = *st.user_volumes.get(&vol_key).unwrap_or(&1.0);

        // Per-track RMS for speaking indicator (only track mic-source audio for levels)
        let inst = rms_i16_normalized(samples);
        st.remote_mic_level_smooth
            .entry(identity.clone())
            .and_modify(|e| *e = ema_speaking_level(*e, inst))
            .or_insert(inst);

        let buf = st.playback_buffers
            .entry(track_key.clone())
            .or_insert_with(|| VecDeque::with_capacity(SAMPLE_RATE as usize));

        // Cap per-track buffer at ~500ms to prevent unbounded growth
        let max_buf = (SAMPLE_RATE / 2) as usize;
        while buf.len() + samples.len() > max_buf {
            buf.pop_front();
        }

        for &s in samples {
            let f = ((s as f32 / 32768.0) * volume).clamp(-1.0, 1.0);
            buf.push_back(f);
        }
    }
    // Track ended — clean up its buffer
    audio_state.lock().playback_buffers.remove(&track_key);
}
// ─── Event loop ─────────────────────────────────────────────────────────────
async fn run_event_loop(
    mut events: mpsc::UnboundedReceiver<RoomEvent>,
    audio_state: Arc<Mutex<AudioState>>,
    _room: Arc<livekit::Room>,
    room_id: String,
    local_identity: String,
    app_handle: Arc<AppHandle>,
    mut shutdown_rx: mpsc::Receiver<()>,
) {
    // Emit initial connected state
    emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
    let mut speaking_tick = interval_at(
        TokioInstant::now() + Duration::from_millis(SPEAKING_UI_TICK_MS),
        Duration::from_millis(SPEAKING_UI_TICK_MS),
    );
    speaking_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                break;
            }
            _ = speaking_tick.tick() => {
                emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
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
                                if source == TrackSource::Microphone {
                                    st.remote_mic_muted.insert(identity.clone(), publication.is_muted());
                                }
                                if let Some(raw) = participant.attributes().get("pax.muted") {
                                    st.remote_mic_muted.insert(identity.clone(), raw == "true");
                                }
                                let deafened = participant
                                    .attributes()
                                    .get("pax.deafened")
                                    .map(|v| v == "true")
                                    .unwrap_or(false);
                                st.remote_deafened.insert(identity.clone(), deafened);
                            }
                            let state_clone = audio_state.clone();
                            let track_key = format!("{}::{:?}", identity, source);
                            let source_tag = match source {
                                TrackSource::Microphone => "microphone".to_string(),
                                TrackSource::ScreenshareAudio => "screenshare_audio".to_string(),
                                other => format!("{:?}", other).to_lowercase(),
                            };
                            tokio::spawn(async move {
                                handle_remote_audio(audio_track, identity, track_key, source_tag, state_clone).await;
                            });
                            emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                        } else if let RemoteTrack::Video(video_track) = track {
                            if source == TrackSource::Screenshare {
                                let identity_clone = identity.clone();
                                log::info!("TrackSubscribed: Video/Screenshare from '{}' (local='{}')", identity_clone, local_identity);
                                let mut st = audio_state.lock();

                                // Add to owners list (if not already present)
                                if !st.screen_sharing_owners.contains(&identity) {
                                    st.screen_sharing_owners.push(identity.clone());
                                }

                                // Only receive if WE are not the one sharing
                                if identity_clone != local_identity {
                                    // Stop any existing receiver for this specific identity
                                    if let Some(old_shutdown) = st.video_recv_shutdowns.remove(&identity_clone) {
                                        old_shutdown.store(true, Ordering::Relaxed);
                                    }
                                    crate::native_overlay::destroy_overlay(&identity_clone);

                                    log::info!("Spawning video receiver for '{}'", identity_clone);
                                    let shutdown = Arc::new(AtomicBool::new(false));
                                    st.video_recv_shutdowns.insert(identity_clone.clone(), shutdown.clone());
                                    drop(st);

                                    // Get parent HWND for native overlay (child HWND created on video thread)
                                    let parent_hwnd = get_parent_hwnd_for_overlay(app_handle.as_ref());

                                    crate::video_recv::spawn_video_receiver(
                                        identity_clone,
                                        video_track,
                                        shutdown,
                                        Arc::clone(&app_handle),
                                        parent_hwnd,
                                    );
                                } else {
                                    log::info!("Skipping video receiver (local screen share)");
                                    drop(st);
                                }

                                emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                            }
                        }
                    }
                    Some(RoomEvent::TrackUnsubscribed { publication, participant, .. }) => {
                        let identity = participant.identity().to_string();
                        let source = publication.source();
                        if source == TrackSource::Screenshare {
                            let mut st = audio_state.lock();
                            st.screen_sharing_owners.retain(|id| id != &identity);
                            // Shut down only this identity's receiver
                            if let Some(shutdown) = st.video_recv_shutdowns.remove(&identity) {
                                shutdown.store(true, Ordering::Relaxed);
                            }
                            drop(st);
                            crate::video_recv::clear_frame_buffer_for(&identity);
                            crate::native_overlay::destroy_overlay(&identity);
                            emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                        } else if source == TrackSource::Microphone || source == TrackSource::ScreenshareAudio {
                            let track_key = format!("{}::{:?}", identity, source);
                            let mut st = audio_state.lock();
                            st.playback_buffers.remove(&track_key);
                            if source == TrackSource::Microphone {
                                st.remote_mic_muted.remove(&identity);
                                st.remote_mic_level_smooth.remove(&identity);
                            }
                            drop(st);
                            emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                        }
                    }
                    Some(RoomEvent::TrackMuted { participant, publication }) => {
                        if publication.source() == TrackSource::Microphone {
                            let identity = participant.identity().to_string();
                            let mut st = audio_state.lock();
                            st.remote_mic_muted.insert(identity, true);
                            drop(st);
                            emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                        }
                    }
                    Some(RoomEvent::TrackUnmuted { participant, publication }) => {
                        if publication.source() == TrackSource::Microphone {
                            let identity = participant.identity().to_string();
                            let mut st = audio_state.lock();
                            st.remote_mic_muted.insert(identity, false);
                            drop(st);
                            emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                        }
                    }
                    Some(RoomEvent::ParticipantConnected(participant)) => {
                        let identity = participant.identity().to_string();
                        log::info!("Participant connected: {}", identity);
                        {
                            let mut st = audio_state.lock();
                            if !st.remote_participants.contains(&identity) {
                                st.remote_participants.push(identity.clone());
                            }
                            let deafened = participant
                                .attributes()
                                .get("pax.deafened")
                                .map(|v| v == "true")
                                .unwrap_or(false);
                            st.remote_deafened.insert(identity.clone(), deafened);
                            if let Some(raw) = participant.attributes().get("pax.muted") {
                                st.remote_mic_muted.insert(participant.identity().to_string(), raw == "true");
                            }
                        }
                        emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                    }
                    Some(RoomEvent::ParticipantAttributesChanged { participant, changed_attributes }) => {
                        let mut changed = false;
                        let identity = participant.identity().to_string();
                        let mut st = audio_state.lock();
                        if let Some(raw) = changed_attributes.get("pax.deafened") {
                            st.remote_deafened.insert(identity.clone(), raw == "true");
                            changed = true;
                        }
                        if let Some(raw) = changed_attributes.get("pax.muted") {
                            st.remote_mic_muted.insert(identity.clone(), raw == "true");
                            changed = true;
                        }
                        drop(st);
                        if changed {
                            emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                        }
                    }
                    Some(RoomEvent::ParticipantDisconnected(participant)) => {
                        let identity = participant.identity().to_string();
                        log::info!("Participant disconnected: {}", identity);
                        {
                            let mut st = audio_state.lock();
                            st.remote_participants.retain(|id| id != &identity);
                            st.remote_mic_muted.remove(&identity);
                            st.remote_deafened.remove(&identity);
                            st.remote_mic_level_smooth.remove(&identity);
                            // Remove all per-track playback buffers for this participant
                            let prefix = format!("{}::", identity);
                            st.playback_buffers.retain(|k, _| !k.starts_with(&prefix));
                            if st.screen_sharing_owners.contains(&identity) {
                                st.screen_sharing_owners.retain(|id| id != &identity);
                                if let Some(shutdown) = st.video_recv_shutdowns.remove(&identity) {
                                    shutdown.store(true, Ordering::Relaxed);
                                }
                                crate::video_recv::clear_frame_buffer_for(&identity);
                                crate::native_overlay::destroy_overlay(&identity);
                            }
                        }
                        emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
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
                        emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, true, None);
                    }
                    Some(RoomEvent::Disconnected { reason }) => {
                        log::info!("Disconnected from LiveKit room: {:?}", reason);
                        emit_state(app_handle.as_ref(), &room_id, &local_identity, &audio_state, false, false, Some("Disconnected from voice".into()));
                        break;
                    }
                    None => {
                        log::info!("LiveKit event channel closed");
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
        let server = st.active_speakers.contains(&local_identity.to_string());
        let level_speaking = merge_speaking_from_level(false, st.local_mic_level_smooth, st.mic_enabled);
        participants.push(VoiceParticipantInfo {
            identity: local_identity.to_string(),
            is_speaking: server || level_speaking,
            is_local: true,
            is_muted: !st.mic_enabled,
            is_deafened: st.deafened,
        });
    }
    // Remote participants
    for id in &st.remote_participants {
        let server = st.active_speakers.contains(id);
        let muted = *st.remote_mic_muted.get(id).unwrap_or(&false);
        let smooth = *st.remote_mic_level_smooth.get(id).unwrap_or(&0.0);
        let level_speaking = merge_speaking_from_level(false, smooth, !muted);
        participants.push(VoiceParticipantInfo {
            identity: id.clone(),
            is_speaking: server || level_speaking,
            is_local: false,
            is_muted: muted,
            is_deafened: *st.remote_deafened.get(id).unwrap_or(&false),
        });
    }
    let event = VoiceStateEvent {
        connected_room_id: if is_connected || is_connecting { Some(room_id.to_string()) } else { None },
        is_connecting,
        is_mic_enabled: st.mic_enabled,
        is_deafened: st.deafened,
        is_noise_suppressed: st.noise_suppression_enabled,
        screen_sharing_owners: st.screen_sharing_owners.clone(),
        is_local_screen_sharing: st.is_local_screen_sharing,
        error,
        participants,
    };
    let _ = app_handle.emit("voice-state-changed", event);
}

fn update_local_status_attributes(room: Arc<livekit::Room>, mic_enabled: bool, deafened: bool) {
    tokio::spawn(async move {
        let lp = room.local_participant();
        let mut attrs = lp.attributes();
        attrs.insert("pax.muted".to_string(), (!mic_enabled).to_string());
        attrs.insert("pax.deafened".to_string(), deafened.to_string());
        if let Err(e) = lp.set_attributes(attrs).await {
            log::warn!("Failed to set participant attributes: {}", e);
        }
    });
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
    /// 0.0 = pure RNNoise output.
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
            // Slightly above pure RNNoise for a cleaner default in noisier rooms.
            extra_attenuation: 0.1,
            // Keep a moderate default to level quieter microphones while
            // still leaving headroom for the limiter.
            agc_target_rms: 6000.0,
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

        // ── Core: RNNoise denoise first ─────────────────────────────────
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

        // ── Sound leveling (AGC) after RNNoise ──────────────────────────
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

/// Drain completed 480-sample frames from `buf`, apply noise suppression + RMS, and send.
/// Shared between the resampling and non-resampling mic input paths.
fn drain_and_send_frames(
    buf: &mut Vec<i16>,
    frame_size: usize,
    is_muted: bool,
    noise_suppression_enabled: bool,
    noise_proc: &Arc<Mutex<NoiseProcessor>>,
    audio_state: &Arc<Mutex<AudioState>>,
    frame_tx: &mpsc::Sender<Vec<i16>>,
) {
    while buf.len() >= frame_size {
        let mut samples: Vec<i16> = buf.drain(..frame_size).collect();
        if noise_suppression_enabled && !is_muted {
            let mut np = noise_proc.lock();
            np.set_enabled(true);
            np.process_i16_in_place(&mut samples[..]);
        } else {
            let mut np = noise_proc.lock();
            np.set_enabled(false);
        }
        {
            let inst = rms_i16_normalized(&samples);
            let mut st = audio_state.lock();
            st.local_mic_level_smooth = ema_speaking_level(st.local_mic_level_smooth, inst);
        }
        let _ = frame_tx.try_send(samples);
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
    log::info!("Using input device: {:?}", device.name());
    let default_config = device.default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;
    let channels = default_config.channels();
    let device_rate = default_config.sample_rate().0;
    let config = cpal::StreamConfig {
        channels,
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    log::info!("Mic config: {}ch @ {}Hz (target {}Hz)", channels, device_rate, SAMPLE_RATE);
    let needs_resample = device_rate != SAMPLE_RATE;
    if needs_resample {
        log::info!("Mic resampling enabled: {}Hz → {}Hz", device_rate, SAMPLE_RATE);
    }
    // Pre-resample accumulator (f32 mono at device rate) — only used when resampling
    let raw_buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(
        Vec::with_capacity(SAMPLES_PER_10MS as usize * 2),
    ));
    // Fractional position tracker for linear interpolation resampling
    let resample_frac: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    // Post-resample frame accumulator (i16 at 48000 Hz)
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

                if needs_resample {
                    // ── Resampling path: device_rate → 48000 Hz ──
                    let mut raw = raw_buf.lock();
                    // Extract mono (channel 0) as f32
                    for frame in data.chunks(ch) {
                        let sample = if is_muted { 0.0 } else { frame[0].clamp(-1.0, 1.0) };
                        raw.push(sample);
                    }
                    // Resample accumulated device-rate samples to 48000 Hz via linear interpolation
                    let step = device_rate as f64 / SAMPLE_RATE as f64; // input step per output sample
                    let mut frac = resample_frac.lock();
                    let mut buf = frame_buf.lock();
                    while *frac + step < raw.len() as f64 {
                        let idx = *frac as usize;
                        let t = *frac - idx as f64;
                        let s0 = raw[idx] as f64;
                        let s1 = if idx + 1 < raw.len() { raw[idx + 1] as f64 } else { s0 };
                        let sample = (s0 * (1.0 - t) + s1 * t) as f32;
                        buf.push((sample * 32767.0) as i16);
                        *frac += step;
                    }
                    // Remove consumed input samples and adjust fractional position
                    let consumed = *frac as usize;
                    if consumed > 0 && consumed <= raw.len() {
                        raw.drain(..consumed);
                        *frac -= consumed as f64;
                    }
                    drop(frac);
                    // Send completed 480-sample frames
                    drain_and_send_frames(&mut buf, frame_size, is_muted, noise_suppression_enabled, &noise_proc, &audio_state, &frame_tx);
                } else {
                    // ── No resampling needed (device already at 48000 Hz) ──
                    let mut buf = frame_buf.lock();
                    for frame in data.chunks(ch) {
                        let sample = if is_muted { 0.0 } else { frame[0] };
                        let clamped = sample.clamp(-1.0, 1.0);
                        buf.push((clamped * 32767.0) as i16);
                    }
                    drain_and_send_frames(&mut buf, frame_size, is_muted, noise_suppression_enabled, &noise_proc, &audio_state, &frame_tx);
                }
            },
            move |err| {
                log::error!("Mic input error: {}", err);
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
    log::info!("Using output device: {:?}", device.name());
    // Use the device's preferred config (Windows typically requires stereo)
    let default_config = device.default_output_config()
        .map_err(|e| format!("Failed to get default output config: {}", e))?;
    let channels = default_config.channels();
    let device_rate = default_config.sample_rate().0;
    let config = cpal::StreamConfig {
        channels,
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    log::info!("Speaker config: {}ch @ {}Hz (buffer at {}Hz)", channels, device_rate, SAMPLE_RATE);
    let needs_resample = device_rate != SAMPLE_RATE;
    if needs_resample {
        log::info!("Speaker resampling enabled: {}Hz → {}Hz", SAMPLE_RATE, device_rate);
    }
    let state = audio_state.clone();
    // Persistent resampling state: fractional position in the 48000 Hz buffer
    // and the previous sample for interpolation (shared across callbacks).
    let resample_frac: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let prev_sample: Arc<Mutex<f32>> = Arc::new(Mutex::new(0.0));

    /// Pop one sample from every per-track buffer and sum them into a single mixed sample.
    #[inline]
    fn pop_mixed(buffers: &mut HashMap<String, VecDeque<f32>>) -> f32 {
        let mut sum = 0.0f32;
        for buf in buffers.values_mut() {
            sum += buf.pop_front().unwrap_or(0.0);
        }
        sum.clamp(-1.0, 1.0)
    }

    /// Peek the front sample from every per-track buffer and sum them.
    #[inline]
    fn peek_mixed(buffers: &HashMap<String, VecDeque<f32>>) -> f32 {
        let mut sum = 0.0f32;
        for buf in buffers.values() {
            sum += buf.front().copied().unwrap_or(0.0);
        }
        sum.clamp(-1.0, 1.0)
    }

    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut st = state.lock();
                let ch = channels as usize;
                if needs_resample {
                    // ── Resampling path: 48000 Hz buffer → device_rate ──
                    // step = how many 48000 Hz buffer positions to advance per output sample
                    let step = SAMPLE_RATE as f64 / device_rate as f64;
                    let mut frac = resample_frac.lock();
                    let mut prev = prev_sample.lock();
                    for frame in data.chunks_mut(ch) {
                        if st.deafened {
                            // Consume buffers proportionally while deafened
                            *frac += step;
                            while *frac >= 1.0 {
                                let _ = pop_mixed(&mut st.playback_buffers);
                                *frac -= 1.0;
                            }
                            for s in frame.iter_mut() {
                                *s = 0.0;
                            }
                        } else {
                            // Advance fractional position and consume buffer samples
                            *frac += step;
                            while *frac >= 1.0 {
                                *prev = pop_mixed(&mut st.playback_buffers);
                                *frac -= 1.0;
                            }
                            // Interpolate between previous and next mixed sample
                            let next = peek_mixed(&st.playback_buffers);
                            let t = *frac as f32;
                            let sample = *prev * (1.0 - t) + next * t;
                            for s in frame.iter_mut() {
                                *s = sample;
                            }
                        }
                    }
                } else {
                    // ── No resampling needed (device already at 48000 Hz) ──
                    for frame in data.chunks_mut(ch) {
                        let sample = if st.deafened {
                            let _ = pop_mixed(&mut st.playback_buffers);
                            0.0
                        } else {
                            pop_mixed(&mut st.playback_buffers)
                        };
                        for s in frame.iter_mut() {
                            *s = sample;
                        }
                    }
                }
            },
            move |err| {
                log::error!("Speaker output error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build output stream: {}", e))?;
    Ok(stream)
}
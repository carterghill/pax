//! Screen capture for LiveKit screen sharing.
//!
//! On Windows: uses windows-capture (Graphics Capture API) as primary; falls back to
//! libwebrtc DesktopCapturer or screenshots crate if needed.
//! On Linux: uses xdg-desktop-portal + PipeWire (video and audio).
//! On macOS: uses libwebrtc DesktopCapturer.
//!
//! Converts frames to I420 and feeds them into a NativeVideoSource for publishing.
//! On Windows, captures system audio via WASAPI process loopback.
//! On Linux, captures system audio via PipeWire sink monitor.

use std::sync::atomic::{AtomicBool, Ordering};
use once_cell::sync::Lazy;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::track::{LocalAudioTrack, LocalTrack, LocalVideoTrack};
use livekit::track::TrackSource;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};

/// Screen share mode: entire screen or a specific window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareMode {
    Screen,
    Window,
}

/// Handle for an active screen share. Holds video and optional audio tracks.
/// Dropping stops the capture thread and loopback stream.
pub struct ScreenShareHandle {
    pub track: LocalVideoTrack,
    /// Screen share audio track (system audio), if loopback capture succeeded.
    pub audio_track: Option<LocalAudioTrack>,
    _shutdown: Arc<AtomicBool>,
    /// Capture thread handle; kept alive so the thread doesn't die silently.
    pub(crate) _capturer_thread: Option<std::thread::JoinHandle<()>>,
    /// Process loopback audio capture thread handle (Windows).
    pub(crate) _audio_capture_thread: Option<std::thread::JoinHandle<()>>,
}

impl ScreenShareHandle {
    /// Signal shutdown and wait for capture thread. Call before unpublishing.
    pub fn stop(&mut self) {
        self._shutdown.store(true, Ordering::Relaxed);
        if let Some(thread) = self._audio_capture_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self._capturer_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for ScreenShareHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenSharePreset {
    #[serde(rename = "720p")]
    H720,
    #[serde(rename = "1080p")]
    H1080,
}

impl ScreenSharePreset {
    pub fn width(self) -> u32 {
        match self {
            Self::H720 => 1280,
            Self::H1080 => 1920,
        }
    }

    pub fn height(self) -> u32 {
        match self {
            Self::H720 => 720,
            Self::H1080 => 1080,
        }
    }

    pub fn fps(self) -> u32 {
        30
    }

    /// Max bitrate in bits per second.
    pub fn max_bitrate(self) -> u64 {
        match self {
            Self::H720 => 2_000_000,
            Self::H1080 => 3_500_000,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::H720 => "720p",
            Self::H1080 => "1080p",
        }
    }
}

impl Default for ScreenSharePreset {
    fn default() -> Self {
        Self::H1080
    }
}

static SCREEN_SHARE_PRESET: Lazy<parking_lot::RwLock<ScreenSharePreset>> =
    Lazy::new(|| parking_lot::RwLock::new(ScreenSharePreset::default()));

pub fn get_screen_share_preset() -> ScreenSharePreset {
    *SCREEN_SHARE_PRESET.read()
}

pub fn set_screen_share_preset(preset: ScreenSharePreset) {
    *SCREEN_SHARE_PRESET.write() = preset;
}

/// Start screen sharing and return a handle containing the track.
/// Publishes the video track immediately after capture is running (avoids SDP race).
/// The caller is responsible for unpublishing when done. Dropping the handle
/// stops the capture thread.
pub async fn start_screen_capture(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
    window_title: Option<String>,
) -> Result<ScreenShareHandle, String> {
    #[cfg(target_os = "windows")]
    {
        // Try windows-capture (Graphics Capture API) first - avoids DXGI/COM conflicts with audio
        match start_screen_capture_windows_graphics(room.clone(), mode, window_title.clone()).await {
            Ok(handle) => return Ok(handle),
            Err(e) => log::warn!("windows-capture failed ({}), falling back to DesktopCapturer", e),
        }
        start_screen_capture_libwebrtc_or_fallback(room, mode, window_title).await
    }

    #[cfg(target_os = "linux")]
    {
        match start_screen_capture_pipewire(room.clone(), mode).await {
            Ok(handle) => return Ok(handle),
            Err(e) => {
                log::warn!("PipeWire capture failed ({}), falling back to libwebrtc", e);
                start_screen_capture_libwebrtc_or_fallback(room, mode, window_title).await
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        start_screen_capture_libwebrtc_or_fallback(room, mode, window_title).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (room, mode, window_title);
        Err("Screen sharing is not supported on this platform".to_string())
    }
}

/// Windows: Graphics Capture API via windows-capture crate.
#[cfg(target_os = "windows")]
async fn start_screen_capture_windows_graphics(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
    window_title: Option<String>,
) -> Result<ScreenShareHandle, String> {
    use livekit::webrtc::video_source::native::NativeVideoSource;
    use windows_capture::capture::GraphicsCaptureApiHandler;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    let preset = get_screen_share_preset();
    let resolution = VideoResolution {
        width: preset.width(),
        height: preset.height(),
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let shutdown = Arc::new(AtomicBool::new(false));
    let first_frame = Arc::new(AtomicBool::new(false));
    let flags = (video_source.clone(), shutdown.clone(), first_frame.clone(), preset);

    let bitrate = preset.max_bitrate();
    let capture_interval_ms = (1000.0 / preset.fps() as f64).round() as u64;
    log::info!(
        "start_screen_capture_windows_graphics: mode={:?} preset={} fps={}",
        mode,
        preset.label(),
        preset.fps()
    );

    let (capture_control, target_audio_pid) = match mode {
        ScreenShareMode::Screen => {
            log::debug!("Using Monitor::primary()");
            let monitor = Monitor::primary().map_err(|e| format!("Monitor::primary: {}", e))?;
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(Duration::from_millis(capture_interval_ms)),
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            );
            (ScreenCaptureHandler::start_free_threaded(settings), None)
        }
        ScreenShareMode::Window => {
            let window = if let Some(ref title) = window_title {
                log::debug!("Looking up window by title: {}", title);
                Window::from_name(title)
                    .or_else(|_| Window::from_contains_name(title))
                    .map_err(|e| format!("Window '{}': {}", title, e))?
            } else {
                log::debug!("Using Window::foreground() (no title specified)");
                Window::foreground().map_err(|e| format!("Window::foreground: {}", e))?
            };
            let win_title = window.title().unwrap_or_else(|_| String::new());
            let target_audio_pid = window.process_id().ok();
            log::debug!("Capturing window: {} (audio PID: {:?})", win_title, target_audio_pid);
            let settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(Duration::from_millis(capture_interval_ms)),
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            );
            (ScreenCaptureHandler::start_free_threaded(settings), target_audio_pid)
        }
    };

    let capture_control = capture_control.map_err(|e| format!("windows-capture: {}", e))?;
    let capturer_thread = capture_control.into_thread_handle();

    // Wait for first frame before publishing - LiveKit needs media flowing for proper SDP negotiation
    log::debug!("Waiting for first capture frame before publishing...");
    for i in 0..100 {
        if first_frame.load(Ordering::Relaxed) {
            log::debug!("First frame received after {}ms", i * 50);
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if !first_frame.load(Ordering::Relaxed) {
        log::warn!(" No frame received in 5s, publishing anyway");
    }

    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        RtcVideoSource::Native(video_source),
    );

    let framerate = preset.fps() as f64;
    let codec = crate::codec::resolve_codec();
    log::info!(
        "Publishing screen track to LiveKit ({:?}, {}, {}fps)",
        codec,
        preset.label(),
        preset.fps()
    );
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: codec,
                simulcast: false,
                video_encoding: Some(VideoEncoding {
                    max_bitrate: bitrate,
                    max_framerate: framerate,
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Failed to publish screen track: {}", e))?;
    log::info!("Screen track published successfully");

    let (audio_track, loopback_stream, audio_capture_thread) =
        setup_screen_share_audio_process_loopback(mode, target_audio_pid, shutdown.clone());
    let _ = loopback_stream;

    // Wrap the capture thread so we can join it when stopping
    let wrapper_thread = thread::spawn(move || {
        let _ = capturer_thread.join();
    });

    Ok(ScreenShareHandle {
        track,
        audio_track,
        _shutdown: shutdown,
        _capturer_thread: Some(wrapper_thread),
        _audio_capture_thread: audio_capture_thread,
    })
}

/// Handler for windows-capture Graphics Capture API.
#[cfg(target_os = "windows")]
struct ScreenCaptureHandler {
    video_source: livekit::webrtc::video_source::native::NativeVideoSource,
    shutdown: Arc<AtomicBool>,
    first_frame: Arc<AtomicBool>,
    preset: ScreenSharePreset,
    frame_count: u64,
}

#[cfg(target_os = "windows")]
impl windows_capture::capture::GraphicsCaptureApiHandler for ScreenCaptureHandler {
    type Flags = (
        livekit::webrtc::video_source::native::NativeVideoSource,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
        ScreenSharePreset,
    );
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (video_source, shutdown, first_frame, preset) = ctx.flags;
        log::debug!("ScreenCaptureHandler::new - capture starting");
        Ok(Self { video_source, shutdown, first_frame, preset, frame_count: 0 })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame<'_>,
        capture_control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.shutdown.load(Ordering::Relaxed) {
            log::debug!("Screen capture: shutdown requested, stopping");
            capture_control.stop();
            return Ok(());
        }
        let mut buf = frame.buffer()?;
        let w = buf.width() as i32;
        let h = buf.height() as i32;
        if w <= 0 || h <= 0 {
            return Ok(());
        }
        let (raw, stride) = if buf.has_padding() {
            let raw = buf.as_nopadding_buffer()?;
            (raw, w * 4)
        } else {
            let row_pitch = buf.row_pitch() as i32;
            let raw = buf.as_raw_buffer();
            (raw, row_pitch)
        };

        let mut i420 = I420Buffer::new(w as u32, h as u32);
        let (dst_y, dst_u, dst_v) = i420.data_mut();
        let src_stride = stride as u32;
        libwebrtc::native::yuv_helper::argb_to_i420(
            raw,
            src_stride,
            dst_y,
            w as u32,
            dst_u,
            ((w + 1) / 2) as u32,
            dst_v,
            ((w + 1) / 2) as u32,
            w,
            h,
        );

        let (out_w, out_h) = (self.preset.width() as i32, self.preset.height() as i32);
        let buffer = if w != out_w || h != out_h {
            i420.scale(out_w, out_h)
        } else {
            i420
        };

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;
        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: now,
            buffer,
        };
        self.video_source.capture_frame(&vf);
        self.frame_count += 1;
        if self.frame_count == 1 {
            self.first_frame.store(true, Ordering::Relaxed);
            log::debug!("Screen capture: first frame ({}x{})", w, h);
        } else if self.frame_count % 100 == 0 {
            log::trace!("Screen capture: frame {} ({}x{})", self.frame_count, w, h);
        }
        Ok(())
    }
}

/// Libwebrtc DesktopCapturer path (macOS/Linux) or fallback on Windows.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn start_screen_capture_libwebrtc_or_fallback(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
    _window_title: Option<String>,
) -> Result<ScreenShareHandle, String> {
    let preset = get_screen_share_preset();
    let bitrate = preset.max_bitrate();
    let capture_interval_ms = (1000.0 / preset.fps() as f64).round() as u64;
    use libwebrtc::desktop_capturer::{
        CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
        DesktopFrame,
    };
    use libwebrtc::native::yuv_helper;
    use libwebrtc::video_source::native::NativeVideoSource;

    let source_type = match mode {
        ScreenShareMode::Screen => DesktopCaptureSourceType::Screen,
        ScreenShareMode::Window => DesktopCaptureSourceType::Window,
    };

    log::info!("start_screen_capture_libwebrtc: mode={:?}", mode);
    let mut capturer_opt = None;
    for attempt in 0..3 {
        let mut options = DesktopCapturerOptions::new(source_type);
        options.set_include_cursor(true);
        capturer_opt = DesktopCapturer::new(options);
        if capturer_opt.is_some() {
            log::debug!("DesktopCapturer::new succeeded on attempt {}", attempt + 1);
            break;
        }
        if attempt < 2 {
            let delay_ms = if attempt == 0 { 1000 } else { 500 };
            log::warn!("DesktopCapturer::new failed (attempt {}), retrying in {}ms", attempt + 1, delay_ms);
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }

    let mut capturer = match capturer_opt {
        Some(c) => c,
        None => {
            log::warn!("DesktopCapturer::new failed after retries");
            if mode == ScreenShareMode::Screen {
                log::warn!("Falling back to screenshots crate");
                return start_screen_capture_screenshots_fallback(room).await;
            }
            return Err("Failed to create desktop capturer. Try selecting \"Entire screen\" instead of a window.".to_string());
        }
    };

    let sources = capturer.get_source_list();
    let source: Option<CaptureSource> = sources.into_iter().next();
    if source.is_none() {
        log::debug!("get_source_list returned empty, trying without explicit source");
    }

    let resolution = VideoResolution {
        width: preset.width(),
        height: preset.height(),
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let video_source_clone = video_source.clone();

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_cap = shutdown.clone();
    let shutdown_thread = shutdown.clone();

    let preset = preset;
    capturer.start_capture(source, move |result: Result<DesktopFrame, libwebrtc::desktop_capturer::CaptureError>| {
        if shutdown_cap.load(Ordering::Relaxed) {
            return;
        }
        let frame = match result {
            Ok(f) => f,
            Err(e) => {
                log::warn!("Screen capture frame error: {:?}", e);
                return;
            }
        };
        let w = frame.width();
        let h = frame.height();
        if w <= 0 || h <= 0 {
            return;
        }
        let stride = frame.stride();
        let data = frame.data();

        let mut i420 = I420Buffer::new(w as u32, h as u32);
        let (dst_y, dst_u, dst_v) = i420.data_mut();
        let stride_y = w;
        let stride_u = (w + 1) / 2;
        let stride_v = (w + 1) / 2;

        yuv_helper::argb_to_i420(
            data,
            stride,
            dst_y,
            stride_y as u32,
            dst_u,
            stride_u as u32,
            dst_v,
            stride_v as u32,
            w,
            h,
        );

        let (out_w, out_h) = (preset.width() as i32, preset.height() as i32);
        let buffer = if w != out_w || h != out_h {
            i420.scale(out_w, out_h)
        } else {
            i420
        };

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as i64;
        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: now,
            buffer,
        };
        video_source_clone.capture_frame(&vf);
    });

    let capturer_thread = thread::spawn(move || {
        let mut cap = capturer;
        while !shutdown_thread.load(Ordering::Relaxed) {
            cap.capture_frame();
            thread::sleep(Duration::from_millis(capture_interval_ms));
        }
    });

    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        RtcVideoSource::Native(video_source),
    );

    room.local_participant()
        .publish_track(
            LocalTrack::Video(track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: crate::codec::resolve_codec(),
                simulcast: false,
                video_encoding: Some(VideoEncoding {
                    max_bitrate: bitrate,
                    max_framerate: preset.fps() as f64,
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Failed to publish screen track: {}", e))?;

    #[cfg(target_os = "windows")]
    let (audio_track, loopback_stream, audio_capture_thread) =
        setup_screen_share_audio_process_loopback(mode, None, shutdown.clone());
    #[cfg(not(target_os = "windows"))]
    let (audio_track, loopback_stream, audio_capture_thread): (
        Option<LocalAudioTrack>,
        Option<cpal::Stream>,
        Option<std::thread::JoinHandle<()>>,
    ) = (None, None, None);
    let _ = loopback_stream;

    Ok(ScreenShareHandle {
        track,
        audio_track,
        _shutdown: shutdown,
        _capturer_thread: Some(capturer_thread),
        _audio_capture_thread: audio_capture_thread,
    })
}

/// Fallback screen capture using the screenshots crate when libwebrtc DesktopCapturer fails.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn start_screen_capture_screenshots_fallback(
    room: Arc<livekit::Room>,
) -> Result<ScreenShareHandle, String> {
    use libwebrtc::native::yuv_helper;
    use livekit::webrtc::video_source::native::NativeVideoSource;

    let preset = get_screen_share_preset();
    let bitrate = preset.max_bitrate();
    let capture_interval_ms = (1000.0 / preset.fps() as f64).round() as u64;
    log::warn!(
        "start_screen_capture_screenshots_fallback: preset={} fps={}",
        preset.label(),
        preset.fps()
    );
    let screens = screenshots::Screen::all()
        .map_err(|e| format!("screenshots: failed to enumerate screens: {}", e))?;
    let screen = screens.into_iter().next()
        .ok_or("screenshots: no screens found")?;

    let resolution = VideoResolution {
        width: preset.width(),
        height: preset.height(),
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let video_source_clone = video_source.clone();

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_thread = shutdown.clone();

    let preset = preset;
    let capturer_thread = thread::spawn(move || {
        while !shutdown_thread.load(Ordering::Relaxed) {
            match screen.capture() {
                Ok(img) => {
                    let w = img.width() as i32;
                    let h = img.height() as i32;
                    if w <= 0 || h <= 0 {
                        continue;
                    }
                    let raw = img.as_raw();
                    let stride = w * 4;

                    let mut i420 = I420Buffer::new(w as u32, h as u32);
                    let (dst_y, dst_u, dst_v) = i420.data_mut();
                    let src_stride = stride as u32;
                    yuv_helper::abgr_to_i420(
                        raw,
                        src_stride,
                        dst_y,
                        w as u32,
                        dst_u,
                        ((w + 1) / 2) as u32,
                        dst_v,
                        ((w + 1) / 2) as u32,
                        w,
                        h,
                    );

                    let (out_w, out_h) = (preset.width() as i32, preset.height() as i32);
                    let buffer = if w != out_w || h != out_h {
                        i420.scale(out_w, out_h)
                    } else {
                        i420
                    };

                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_micros() as i64;
                    let vf = VideoFrame {
                        rotation: VideoRotation::VideoRotation0,
                        timestamp_us: now,
                        buffer,
                    };
                    video_source_clone.capture_frame(&vf);
                }
                Err(e) => {
                    log::warn!("screenshots capture: {}", e);
                }
            }
            thread::sleep(Duration::from_millis(capture_interval_ms));
        }
    });

    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        RtcVideoSource::Native(video_source),
    );

    // Publish video immediately while capture is hot
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: crate::codec::resolve_codec(),
                simulcast: false,
                video_encoding: Some(VideoEncoding {
                    max_bitrate: bitrate,
                    max_framerate: preset.fps() as f64,
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Failed to publish screen track (fallback): {}", e))?;

    #[cfg(target_os = "windows")]
    let (audio_track, loopback_stream, audio_capture_thread) =
        setup_screen_share_audio_process_loopback(ScreenShareMode::Screen, None, shutdown.clone());
    #[cfg(not(target_os = "windows"))]
    let (audio_track, loopback_stream, audio_capture_thread): (
        Option<LocalAudioTrack>,
        Option<cpal::Stream>,
        Option<std::thread::JoinHandle<()>>,
    ) = (None, None, None);
    let _ = loopback_stream;

    Ok(ScreenShareHandle {
        track,
        audio_track,
        _shutdown: shutdown,
        _capturer_thread: Some(capturer_thread),
        _audio_capture_thread: audio_capture_thread,
    })
}

/// Set up system audio capture via Windows process loopback (WASAPI).
/// Screen mode (target_audio_pid=None): EXCLUDE Pax → all system audio except Pax.
/// Window mode (target_audio_pid=Some(pid)): INCLUDE that process → only that app's audio.
#[cfg(target_os = "windows")]
fn setup_screen_share_audio_process_loopback(
    _mode: ScreenShareMode,
    target_audio_pid: Option<u32>,
    shutdown: Arc<AtomicBool>,
) -> (
    Option<LocalAudioTrack>,
    Option<cpal::Stream>,
    Option<std::thread::JoinHandle<()>>,
) {
    use livekit::webrtc::{
        audio_frame::AudioFrame,
        audio_source::native::NativeAudioSource,
        prelude::{AudioSourceOptions, RtcAudioSource},
    };
    use tokio::sync::mpsc;
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    const SAMPLE_RATE: u32 = 48000;
    const NUM_CHANNELS: u32 = 1;
    const SAMPLES_PER_10MS: usize = (SAMPLE_RATE / 100) as usize; // 480
    const BLOCKALIGN: usize = 8; // 2 channels * 4 bytes float

    let audio_source = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        },
        SAMPLE_RATE,
        NUM_CHANNELS,
        100,
    );

    let (frame_tx, mut frame_rx) = mpsc::channel::<Vec<i16>>(10);
    let frame_buf: Arc<parking_lot::Mutex<Vec<i16>>> =
        Arc::new(parking_lot::Mutex::new(Vec::with_capacity(SAMPLES_PER_10MS * 2)));

    // Screen mode (target_audio_pid=None): EXCLUDE Pax → all system audio
    // Window mode (target_audio_pid=Some(pid)): INCLUDE that app → only that window's audio
    let (process_id, include_tree) = match target_audio_pid {
        None => {
            log::debug!("Screen share audio: EXCLUDE mode (all system audio except Pax)");
            (std::process::id(), false)
        }
        Some(pid) => {
            log::debug!("Screen share audio: INCLUDE mode (only PID {})", pid);
            (pid, true)
        }
    };

    // Brief defer so video capture is established first (windows-capture has no DXGI conflict)
    const AUDIO_DEFER_MS: u64 = 300;

    let shutdown_cap = shutdown.clone();
    let capture_thread = std::thread::Builder::new()
        .name("screen-audio-capture".into())
        .spawn(move || {
            thread::sleep(Duration::from_millis(AUDIO_DEFER_MS));
            if shutdown_cap.load(Ordering::Relaxed) {
                return;
            }
            if wasapi::initialize_mta().is_err() {
                log::warn!("Screen share process loopback: COM init failed");
                return;
            }
            log::debug!("Screen share audio: initializing WASAPI process loopback");
            let mut audio_client = match AudioClient::new_application_loopback_client(
                process_id,
                include_tree,
            ) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Screen share process loopback: {}", e);
                    return;
                }
            };
            let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, 2, None);
            let stream_mode = StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: 0,
            };
            if audio_client
                .initialize_client(&format, &Direction::Capture, &stream_mode)
                .is_err()
            {
                log::warn!("Screen share process loopback: init failed");
                return;
            }
            let h_event = match audio_client.set_get_eventhandle() {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("Screen share process loopback event: {}", e);
                    return;
                }
            };
            let capture_client = match audio_client.get_audiocaptureclient() {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Screen share process loopback capture client: {}", e);
                    return;
                }
            };
            if audio_client.start_stream().is_err() {
                log::warn!("Screen share process loopback: start failed");
                return;
            }

            let mut sample_queue = std::collections::VecDeque::<u8>::new();
            while !shutdown_cap.load(Ordering::Relaxed) {
                let new_frames = capture_client
                    .get_next_packet_size()
                    .ok()
                    .unwrap_or(Some(0))
                    .unwrap_or(0);
                if new_frames > 0 {
                    let _ = capture_client.read_from_device_to_deque(&mut sample_queue);
                }
                // Convert float stereo to mono i16, emit 10ms frames
                while sample_queue.len() >= BLOCKALIGN * SAMPLES_PER_10MS {
                    let mut buf = frame_buf.lock();
                    for _ in 0..SAMPLES_PER_10MS {
                        let mut left = [0u8; 4];
                        let mut right = [0u8; 4];
                        for b in &mut left {
                            *b = sample_queue.pop_front().unwrap_or(0);
                        }
                        for b in &mut right {
                            *b = sample_queue.pop_front().unwrap_or(0);
                        }
                        let l = f32::from_le_bytes(left);
                        let r = f32::from_le_bytes(right);
                        let mono = ((l + r) * 0.5).clamp(-1.0, 1.0) * 32767.0;
                        buf.push(mono as i16);
                    }
                    if buf.len() >= SAMPLES_PER_10MS {
                        let samples: Vec<i16> = buf.drain(..SAMPLES_PER_10MS).collect();
                        let _ = frame_tx.try_send(samples);
                    }
                }
                if h_event.wait_for_event(100).is_err() {
                    break;
                }
            }
            let _ = audio_client.stop_stream();
        })
        .map_err(|e| {
            log::warn!("Screen share process loopback thread spawn failed: {}", e);
            e
        })
        .ok();

    let audio_source_clone = audio_source.clone();
    tokio::spawn(async move {
        while let Some(samples) = frame_rx.recv().await {
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate: SAMPLE_RATE,
                num_channels: NUM_CHANNELS,
                samples_per_channel: SAMPLES_PER_10MS as u32,
            };
            if let Err(e) = audio_source_clone.capture_frame(&frame).await {
                log::warn!("Screen share audio capture: {}", e);
            }
        }
    });

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    log::info!("Screen share audio (process loopback) enabled");
    (Some(track), None, capture_thread)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn setup_screen_share_audio() -> (Option<LocalAudioTrack>, Option<cpal::Stream>) {
    (None, None)
}

/// Linux: xdg-desktop-portal + PipeWire screen capture with audio.
///
/// Flow:
/// 1. ashpd opens the ScreenCast portal → native compositor dialog
/// 2. User selects screen/window → portal returns PipeWire node_id + fd
/// 3. Dedicated thread runs PipeWire MainLoop, connects to the portal stream
/// 4. Frames arrive as SPA buffers → convert to I420 → feed NativeVideoSource
/// 5. Separate PipeWire thread captures desktop audio from the default sink monitor
#[cfg(target_os = "linux")]
async fn start_screen_capture_pipewire(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
) -> Result<ScreenShareHandle, String> {
    use ashpd::desktop::{
        screencast::{CursorMode, Screencast, SourceType},
        PersistMode,
    };
    use livekit::webrtc::video_source::native::NativeVideoSource;

    let preset = get_screen_share_preset();
    let bitrate = preset.max_bitrate();
    log::info!("start_screen_capture_pipewire: mode={:?} preset={}", mode, preset.label());

    // --- 1. Open xdg-desktop-portal ScreenCast session ---
    log::info!("PipeWire: creating Screencast proxy...");
    let proxy = tokio::time::timeout(
        Duration::from_secs(5),
        Screencast::new(),
    ).await
        .map_err(|_| "Screencast portal: D-Bus connection timed out (5s)".to_string())?
        .map_err(|e| format!("Screencast portal unavailable: {}", e))?;

    log::info!("PipeWire: creating session...");
    let session = tokio::time::timeout(
        Duration::from_secs(5),
        proxy.create_session(),
    ).await
        .map_err(|_| "create_session timed out (5s)".to_string())?
        .map_err(|e| format!("Failed to create screencast session: {}", e))?;

    let source_type = match mode {
        ScreenShareMode::Screen => SourceType::Monitor,
        ScreenShareMode::Window => SourceType::Window,
    };

    log::info!("PipeWire: selecting sources ({:?})...", mode);
    tokio::time::timeout(
        Duration::from_secs(5),
        proxy.select_sources(
            &session,
            CursorMode::Embedded,
            source_type.into(),
            true,  // multiple = true (portal may still show single-select)
            None,  // no restore token
            PersistMode::DoNot,
        ),
    ).await
        .map_err(|_| "select_sources timed out (5s)".to_string())?
        .map_err(|e| format!("select_sources: {}", e))?;

    // This shows the compositor's native picker — user may take a while.
    // 60s timeout so it doesn't hang forever if the portal backend is broken.
    log::info!("PipeWire: starting portal (waiting for user to pick screen/window)...");
    let start_response = tokio::time::timeout(
        Duration::from_secs(60),
        proxy.start(&session, None),
    ).await
        .map_err(|_| "Portal picker timed out after 60s — is xdg-desktop-portal-kde running?".to_string())?
        .map_err(|e| format!("Portal start failed: {}", e))?;

    let response = start_response.response()
        .map_err(|e| format!("Portal response error: {}", e))?;

    let streams = response.streams();
    if streams.is_empty() {
        return Err("No streams returned from portal (user cancelled?)".to_string());
    }
    let portal_stream = &streams[0];
    let node_id = portal_stream.pipe_wire_node_id();
    log::info!("Portal returned PipeWire node_id={}, size={:?}", node_id, portal_stream.size());

    // Keep the session alive — dropping it ends the screencast.
    // We leak the session handle; it gets cleaned up when the portal session
    // is closed on disconnect or when the process exits.
    // (ashpd sessions auto-close on Drop, so we must prevent that.)
    let session_box = Box::new(session);
    std::mem::forget(session_box);

    // --- 2. Set up video source ---
    let resolution = livekit::webrtc::video_source::VideoResolution {
        width: preset.width(),
        height: preset.height(),
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let shutdown = Arc::new(AtomicBool::new(false));

    // --- 3. Spawn PipeWire video capture thread ---
    // Connect to the regular PipeWire daemon (not portal fd) — Pax is a native
    // app so the portal screencast node is visible on the main PipeWire instance.
    // This is the same approach OBS, Firefox, and Chrome use.
    let video_source_cap = video_source.clone();
    let shutdown_video = shutdown.clone();

    let capturer_thread = thread::Builder::new()
        .name("pw-video-capture".into())
        .spawn(move || {
            log::info!("pw-video-capture thread started for node {}", node_id);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                pipewire_video_capture_loop(node_id, video_source_cap, shutdown_video, preset);
            }));
            if let Err(e) = result {
                let msg = if let Some(s) = e.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = e.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic".to_string()
                };
                log::error!("pw-video-capture thread panicked: {}", msg);
            }
            log::info!("pw-video-capture thread exited");
        })
        .map_err(|e| format!("Failed to spawn PipeWire video thread: {}", e))?;

    // Brief delay for first frame to flow before publishing (non-blocking)
    for _i in 0..6 {
        if shutdown.load(Ordering::Relaxed) { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // --- 4. Publish video track ---
    log::info!("Creating and publishing screen track...");
    let track = livekit::track::LocalVideoTrack::create_video_track(
        "screenshare",
        livekit::webrtc::video_source::RtcVideoSource::Native(video_source),
    );

    let codec = crate::codec::resolve_codec();
    log::info!(
        "Publishing screen track to LiveKit ({:?}, {}, {}fps)",
        codec, preset.label(), preset.fps()
    );
    room.local_participant()
        .publish_track(
            livekit::track::LocalTrack::Video(track.clone()),
            livekit::options::TrackPublishOptions {
                source: livekit::track::TrackSource::Screenshare,
                video_codec: codec,
                simulcast: false,
                video_encoding: Some(livekit::options::VideoEncoding {
                    max_bitrate: bitrate,
                    max_framerate: preset.fps() as f64,
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Failed to publish screen track: {}", e))?;
    log::info!("Screen track published successfully");

    // --- 5. Start PipeWire audio capture (desktop audio via sink monitor) ---
    let shutdown_audio = shutdown.clone();
    let (audio_track, audio_thread) = setup_screen_share_audio_pipewire(shutdown_audio);

    Ok(ScreenShareHandle {
        track,
        audio_track,
        _shutdown: shutdown,
        _capturer_thread: Some(capturer_thread),
        _audio_capture_thread: audio_thread,
    })
}

/// PipeWire video capture main loop — runs on a dedicated OS thread.
///
/// Connects to the portal-provided PipeWire remote, creates a video stream
/// targeting the screencast node, converts incoming frames to I420, and feeds
/// them into the LiveKit NativeVideoSource.
#[cfg(target_os = "linux")]
fn pipewire_video_capture_loop(
    node_id: u32,
    video_source: livekit::webrtc::video_source::native::NativeVideoSource,
    shutdown: Arc<AtomicBool>,
    preset: ScreenSharePreset,
) {
    use pipewire as pw;
    use pw::{properties::properties, spa};
    use spa::pod::Pod;

    log::info!("PipeWire video: calling pw::init()...");
    pw::init();

    log::info!("PipeWire video: creating MainLoop...");
    let mainloop = match pw::main_loop::MainLoopRc::new(None) {
        Ok(ml) => ml,
        Err(e) => { log::error!("PipeWire MainLoop::new failed: {}", e); return; }
    };
    log::info!("PipeWire video: creating Context...");
    let context = match pw::context::ContextRc::new(&mainloop, None) {
        Ok(ctx) => ctx,
        Err(e) => { log::error!("PipeWire Context::new failed: {}", e); return; }
    };
    log::info!("PipeWire video: connecting to PipeWire daemon...");
    let core = match context.connect_rc(None) {
        Ok(c) => c,
        Err(e) => { log::error!("PipeWire connect failed: {}", e); return; }
    };
    log::info!("PipeWire video: connected to daemon, creating stream...");

    // User data shared with the stream callbacks.
    // MainLoopRc is !Send but safe here: created and used entirely on this thread.
    struct PwVideoData {
        format: spa::param::video::VideoInfoRaw,
        video_source: livekit::webrtc::video_source::native::NativeVideoSource,
        preset: ScreenSharePreset,
        frame_count: u64,
        mainloop: pw::main_loop::MainLoopRc,
        shutdown: Arc<AtomicBool>,
    }

    let data = PwVideoData {
        format: Default::default(),
        video_source,
        preset,
        frame_count: 0,
        mainloop: mainloop.clone(),
        shutdown: shutdown.clone(),
    };

    let stream = match pw::stream::StreamBox::new(
        &core,
        "pax-screenshare",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    ) {
        Ok(s) => s,
        Err(e) => { log::error!("PipeWire Stream::new failed: {}", e); return; }
    };

    let mainloop_err = mainloop.clone();

    let _listener = stream
        .add_local_listener_with_user_data(data)
        .state_changed(move |_, _, old, new| {
            log::debug!("PipeWire stream state: {:?} -> {:?}", old, new);
            // Quit the main loop if the stream errors out
            if matches!(new, pw::stream::StreamState::Error(_)) {
                mainloop_err.quit();
            }
        })
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else { return; };
            if id != pw::spa::param::ParamType::Format.as_raw() { return; }

            let (media_type, media_subtype) =
                match pw::spa::param::format_utils::parse_format(param) {
                    Ok(v) => v,
                    Err(_) => return,
                };

            if media_type != pw::spa::param::format::MediaType::Video
                || media_subtype != pw::spa::param::format::MediaSubtype::Raw
            {
                return;
            }

            if let Err(e) = user_data.format.parse(param) {
                log::warn!("Failed to parse video format: {:?}", e);
                return;
            }

            log::info!(
                "PipeWire negotiated video: format={:?} size={}x{} framerate={}/{}",
                user_data.format.format(),
                user_data.format.size().width,
                user_data.format.size().height,
                user_data.format.framerate().num,
                user_data.format.framerate().denom,
            );
        })
        .process(|stream_ref, user_data| {
            // Check shutdown flag on every frame
            if user_data.shutdown.load(Ordering::Relaxed) {
                user_data.mainloop.quit();
                return;
            }
            let Some(mut buffer) = stream_ref.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() { return; }

            let spa_data = &mut datas[0];
            let chunk_size = spa_data.chunk().size() as usize;
            let chunk_stride = spa_data.chunk().stride();
            if chunk_size == 0 { return; }

            let Some(raw_slice) = spa_data.data() else { return; };
            let raw_slice = &raw_slice[..chunk_size];

            let w = user_data.format.size().width as i32;
            let h = user_data.format.size().height as i32;
            if w <= 0 || h <= 0 { return; }

            let src_stride = if chunk_stride > 0 { chunk_stride as u32 } else { (w * 4) as u32 };

            // Convert to I420 based on negotiated pixel format
            let mut i420 = livekit::webrtc::video_frame::I420Buffer::new(w as u32, h as u32);
            let (dst_y, dst_u, dst_v) = i420.data_mut();

            let fmt = user_data.format.format();
            // libyuv naming: argb = [B,G,R,A] in memory (little-endian), abgr = [R,G,B,A]
            let convert_ok = match fmt {
                pw::spa::param::video::VideoFormat::BGRx
                | pw::spa::param::video::VideoFormat::BGRA => {
                    libwebrtc::native::yuv_helper::argb_to_i420(
                        raw_slice, src_stride,
                        dst_y, w as u32,
                        dst_u, ((w + 1) / 2) as u32,
                        dst_v, ((w + 1) / 2) as u32,
                        w, h,
                    );
                    true
                }
                pw::spa::param::video::VideoFormat::RGBx
                | pw::spa::param::video::VideoFormat::RGBA => {
                    libwebrtc::native::yuv_helper::abgr_to_i420(
                        raw_slice, src_stride,
                        dst_y, w as u32,
                        dst_u, ((w + 1) / 2) as u32,
                        dst_v, ((w + 1) / 2) as u32,
                        w, h,
                    );
                    true
                }
                _ => {
                    if user_data.frame_count == 0 {
                        log::warn!("Unsupported PipeWire video format: {:?}, frames will be skipped", fmt);
                    }
                    false
                }
            };

            if !convert_ok { return; }

            let (out_w, out_h) = (user_data.preset.width() as i32, user_data.preset.height() as i32);
            let buffer = if w != out_w || h != out_h {
                i420.scale(out_w, out_h)
            } else {
                i420
            };

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as i64;
            let vf = livekit::webrtc::video_frame::VideoFrame {
                rotation: livekit::webrtc::video_frame::VideoRotation::VideoRotation0,
                timestamp_us: now,
                buffer,
            };
            user_data.video_source.capture_frame(&vf);
            user_data.frame_count += 1;
            if user_data.frame_count == 1 {
                log::info!("PipeWire: first frame captured ({}x{})", w, h);
            } else if user_data.frame_count % 300 == 0 {
                log::trace!("PipeWire: frame {} ({}x{})", user_data.frame_count, w, h);
            }
        })
        .register();

    let _listener = match _listener {
        Ok(l) => l,
        Err(e) => { log::error!("PipeWire stream listener registration failed: {:?}", e); return; }
    };

    // Build SPA format pod: negotiate BGRx/BGRA/RGBx/RGBA
    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Video
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            pw::spa::param::video::VideoFormat::BGRx,
            pw::spa::param::video::VideoFormat::BGRx,
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::RGBx,
            pw::spa::param::video::VideoFormat::RGBA,
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            pw::spa::utils::Rectangle {
                width: preset.width(),
                height: preset.height()
            },
            pw::spa::utils::Rectangle { width: 1, height: 1 },
            pw::spa::utils::Rectangle { width: 4096, height: 4096 }
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            pw::spa::utils::Fraction { num: preset.fps(), denom: 1 },
            pw::spa::utils::Fraction { num: 0, denom: 1 },
            pw::spa::utils::Fraction { num: 120, denom: 1 }
        ),
    );
    log::info!("PipeWire video: serializing format pod...");
    let values: Vec<u8> = match pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    ) {
        Ok(v) => v.0.into_inner(),
        Err(e) => { log::error!("PipeWire PodSerializer failed: {:?}", e); return; }
    };

    let mut params = [Pod::from_bytes(&values).unwrap()];

    log::info!("PipeWire video: connecting stream to node {}...", node_id);
    if let Err(e) = stream.connect(
        spa::utils::Direction::Input,
        Some(node_id),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    ) {
        log::error!("PipeWire stream connect failed: {}", e);
        return;
    }

    log::info!("PipeWire video stream connected to node {}", node_id);

    // Add a timer to check the shutdown flag periodically
    let mainloop_quit = mainloop.clone();
    let timer = mainloop.loop_().add_timer(move |_| {
        if shutdown.load(Ordering::Relaxed) {
            mainloop_quit.quit();
        }
    });
    timer.update_timer(
        Some(Duration::from_millis(100)),
        Some(Duration::from_millis(100)),
    ).into_result().ok();

    log::info!("PipeWire video: entering main loop...");
    mainloop.run();
    log::info!("PipeWire video capture loop exited");
}

/// Set up desktop audio capture via PipeWire sink monitor on Linux.
///
/// Captures all system audio by connecting to the default audio sink's monitor
/// port. Converts stereo f32 → mono i16 in 10ms frames for LiveKit.
#[cfg(target_os = "linux")]
fn setup_screen_share_audio_pipewire(
    shutdown: Arc<AtomicBool>,
) -> (Option<LocalAudioTrack>, Option<std::thread::JoinHandle<()>>) {
    use livekit::webrtc::{
        audio_frame::AudioFrame,
        audio_source::native::NativeAudioSource,
        prelude::{AudioSourceOptions, RtcAudioSource},
    };
    use tokio::sync::mpsc;

    const SAMPLE_RATE: u32 = 48000;
    const NUM_CHANNELS: u32 = 1;
    const SAMPLES_PER_10MS: usize = (SAMPLE_RATE / 100) as usize; // 480

    let audio_source = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        },
        SAMPLE_RATE,
        NUM_CHANNELS,
        100,
    );

    let (frame_tx, mut frame_rx) = mpsc::channel::<Vec<i16>>(10);

    let shutdown_cap = shutdown.clone();
    let capture_thread = thread::Builder::new()
        .name("pw-audio-capture".into())
        .spawn(move || {
            pipewire_audio_capture_loop(frame_tx, shutdown_cap);
        })
        .map_err(|e| {
            log::warn!("Screen share PipeWire audio thread spawn failed: {}", e);
            e
        })
        .ok();

    if capture_thread.is_none() {
        return (None, None);
    }

    // Async task to feed audio frames to LiveKit
    let audio_source_clone = audio_source.clone();
    tokio::spawn(async move {
        while let Some(samples) = frame_rx.recv().await {
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate: SAMPLE_RATE,
                num_channels: NUM_CHANNELS,
                samples_per_channel: SAMPLES_PER_10MS as u32,
            };
            if let Err(e) = audio_source_clone.capture_frame(&frame).await {
                log::warn!("Screen share PipeWire audio capture: {}", e);
            }
        }
    });

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    log::info!("Screen share audio (PipeWire sink monitor) enabled");
    (Some(track), capture_thread)
}

/// PipeWire audio capture main loop — runs on a dedicated OS thread.
///
/// Connects to the default audio sink's monitor to capture all desktop audio.
/// Converts stereo f32 to mono i16 and sends 10ms frames via channel.
#[cfg(target_os = "linux")]
fn pipewire_audio_capture_loop(
    frame_tx: tokio::sync::mpsc::Sender<Vec<i16>>,
    shutdown: Arc<AtomicBool>,
) {
    use pipewire as pw;
    use pw::{properties::properties, spa};
    use spa::pod::Pod;

    const SAMPLE_RATE: u32 = 48000;
    const CHANNELS: u32 = 2;
    const SAMPLES_PER_10MS: usize = (SAMPLE_RATE / 100) as usize; // 480 mono samples

    // Brief delay to let video capture start first
    thread::sleep(Duration::from_millis(300));
    if shutdown.load(Ordering::Relaxed) { return; }

    pw::init();

    let mainloop = match pw::main_loop::MainLoopRc::new(None) {
        Ok(ml) => ml,
        Err(e) => { log::warn!("PipeWire audio MainLoop failed: {}", e); return; }
    };
    let context = match pw::context::ContextRc::new(&mainloop, None) {
        Ok(ctx) => ctx,
        Err(e) => { log::warn!("PipeWire audio Context failed: {}", e); return; }
    };
    // Connect to the regular PipeWire daemon (not portal fd)
    let core = match context.connect_rc(None) {
        Ok(c) => c,
        Err(e) => { log::warn!("PipeWire audio connect failed: {}", e); return; }
    };

    struct PwAudioData {
        sample_buf: Vec<i16>,
        frame_tx: tokio::sync::mpsc::Sender<Vec<i16>>,
        mainloop: pw::main_loop::MainLoopRc,
        shutdown: Arc<AtomicBool>,
    }

    let data = PwAudioData {
        sample_buf: Vec::with_capacity(SAMPLES_PER_10MS * 2),
        frame_tx,
        mainloop: mainloop.clone(),
        shutdown: shutdown.clone(),
    };

    let stream = match pw::stream::StreamBox::new(
        &core,
        "pax-screenshare-audio",
        properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
            // Capture from the default audio sink (all desktop audio)
            "stream.capture.sink" => "true",
        },
    ) {
        Ok(s) => s,
        Err(e) => { log::warn!("PipeWire audio Stream::new failed: {}", e); return; }
    };

    let mainloop_err = mainloop.clone();

    let _listener = stream
        .add_local_listener_with_user_data(data)
        .state_changed(move |_, _, old, new| {
            log::debug!("PipeWire audio stream state: {:?} -> {:?}", old, new);
            if matches!(new, pw::stream::StreamState::Error(_)) {
                mainloop_err.quit();
            }
        })
        .process(|stream_ref, user_data| {
            if user_data.shutdown.load(Ordering::Relaxed) {
                user_data.mainloop.quit();
                return;
            }
            let Some(mut buffer) = stream_ref.dequeue_buffer() else { return; };
            let datas = buffer.datas_mut();
            if datas.is_empty() { return; }

            let spa_data = &mut datas[0];
            let chunk_size = spa_data.chunk().size() as usize;
            if chunk_size == 0 { return; }

            let Some(raw_bytes) = spa_data.data() else { return; };
            let raw_bytes = &raw_bytes[..chunk_size];

            // PipeWire delivers stereo f32 interleaved — reinterpret byte slice as f32
            let float_samples = unsafe {
                let ptr = raw_bytes.as_ptr() as *const f32;
                let count = raw_bytes.len() / std::mem::size_of::<f32>();
                std::slice::from_raw_parts(ptr, count)
            };

            // Convert stereo f32 to mono i16
            for pair in float_samples.chunks(CHANNELS as usize) {
                let mono = if pair.len() >= 2 {
                    ((pair[0] + pair[1]) * 0.5).clamp(-1.0, 1.0) * 32767.0
                } else if !pair.is_empty() {
                    pair[0].clamp(-1.0, 1.0) * 32767.0
                } else {
                    0.0
                };
                user_data.sample_buf.push(mono as i16);
            }

            // Emit 10ms frames (480 mono samples at 48kHz)
            while user_data.sample_buf.len() >= SAMPLES_PER_10MS {
                let frame: Vec<i16> = user_data.sample_buf.drain(..SAMPLES_PER_10MS).collect();
                let _ = user_data.frame_tx.try_send(frame);
            }
        })
        .register();

    let _listener = match _listener {
        Ok(l) => l,
        Err(e) => { log::warn!("PipeWire audio stream listener failed: {:?}", e); return; }
    };

    // Negotiate F32 stereo at 48kHz
    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Audio
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::AudioFormat,
            Id,
            pw::spa::param::audio::AudioFormat::F32LE
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::AudioRate,
            Int,
            SAMPLE_RATE as i32
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::AudioChannels,
            Int,
            CHANNELS as i32
        ),
    );
    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )
    .expect("Audio PodSerializer failed")
    .0
    .into_inner();

    let mut params = [Pod::from_bytes(&values).unwrap()];

    if let Err(e) = stream.connect(
        spa::utils::Direction::Input,
        None, // no specific target — stream.capture.sink connects to default sink monitor
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    ) {
        log::warn!("PipeWire audio stream connect failed: {}", e);
        return;
    }

    log::info!("PipeWire audio stream connected (sink monitor capture)");

    // Timer to check shutdown flag
    let mainloop_quit = mainloop.clone();
    let timer = mainloop.loop_().add_timer(move |_| {
        if shutdown.load(Ordering::Relaxed) {
            mainloop_quit.quit();
        }
    });
    timer.update_timer(
        Some(Duration::from_millis(100)),
        Some(Duration::from_millis(100)),
    ).into_result().ok();

    mainloop.run();
    log::info!("PipeWire audio capture loop exited");
}

/// Enumerate capturable windows (Windows only). Returns (title, process_name) for each.
#[cfg(target_os = "windows")]
pub fn enumerate_screen_share_windows() -> Result<Vec<(String, String)>, String> {
    use windows_capture::window::Window;

    log::debug!("enumerate_screen_share_windows");
    let windows = Window::enumerate().map_err(|e| format!("Window::enumerate: {}", e))?;
    let mut out = Vec::new();
    for w in windows {
        if !w.is_valid() {
            continue;
        }
        let title = w.title().unwrap_or_else(|_| String::new());
        let process = w.process_name().unwrap_or_else(|_| String::new());
        if !title.is_empty() || !process.is_empty() {
            out.push((title, process));
        }
    }
    log::info!("Found {} capturable windows", out.len());
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
pub fn enumerate_screen_share_windows() -> Result<Vec<(String, String)>, String> {
    Ok(vec![])
}
//! Screen capture for LiveKit screen sharing.
//!
//! On Windows: uses windows-capture (Graphics Capture API) as primary; falls back to
//! libwebrtc DesktopCapturer or screenshots crate if needed.
//! On Linux: uses xdg-desktop-portal for picker + GStreamer pipewiresrc for capture.
//! On macOS: uses libwebrtc DesktopCapturer.
//!
//! Converts frames to I420 and feeds them into a NativeVideoSource for publishing.
//! On Windows, captures system audio via WASAPI process loopback.

use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::track::TrackSource;
use livekit::track::{LocalAudioTrack, LocalTrack, LocalVideoTrack};
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};

/// Screen share mode: entire screen or a specific window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareMode {
    Screen,
    Window,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenShareWindowOption {
    pub id: String,
    pub title: String,
    pub process_name: String,
    pub icon_data_url: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

/// Handle for an active screen share. Holds video and optional audio tracks.
/// Dropping stops the capture thread and loopback stream.
pub struct ScreenShareHandle {
    pub track: LocalVideoTrack,
    /// Screen share audio track (system audio), if loopback capture succeeded.
    pub audio_track: Option<LocalAudioTrack>,
    /// The NativeVideoSource feeding the track — kept alive so we can
    /// create a new LocalVideoTrack from it without restarting capture.
    #[allow(dead_code)]
    pub video_source: livekit::webrtc::video_source::native::NativeVideoSource,
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

/// Internal ABR bitrate tier. The adaptive bitrate system steps through
/// these tiers based on bandwidth conditions. Not user-facing.
///
/// Values are mode-dependent:
///   Regular mode:        High = 3.5M/native/30fps  Med = 1.5M/native/30fps  Low = 750K/720p/20fps
///   Low bandwidth mode:  High = 500K/720p/24fps    Med = 350K/540p/24fps    Low = 200K/480p/20fps
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenShareQuality {
    Low,
    Medium,
    High,
}

impl ScreenShareQuality {
    pub fn fps(self) -> u32 {
        self.max_framerate() as u32
    }

    /// Max bitrate in bits per second. Values depend on the current bandwidth mode.
    pub fn max_bitrate(self) -> u64 {
        if is_low_bandwidth_mode() {
            match self {
                Self::Low => 200_000,
                Self::Medium => 350_000,
                Self::High => 500_000,
            }
        } else {
            match self {
                Self::Low => 750_000,
                Self::Medium => 1_500_000,
                Self::High => 3_500_000,
            }
        }
    }

    /// Max framerate for this tier.
    pub fn max_framerate(self) -> f64 {
        if is_low_bandwidth_mode() {
            match self {
                Self::Low => 20.0,
                Self::Medium => 24.0,
                Self::High => 24.0,
            }
        } else {
            match self {
                Self::Low => 20.0,
                Self::Medium => 30.0,
                Self::High => 30.0,
            }
        }
    }

    /// Target resolution height for this tier, or `None` for native resolution.
    /// Used by ABR to set `scale_resolution_down_by` on the encoder mid-stream.
    pub fn target_height(self) -> Option<u32> {
        if is_low_bandwidth_mode() {
            match self {
                Self::Low => Some(480),
                Self::Medium => Some(540),
                Self::High => Some(720),
            }
        } else {
            match self {
                Self::Low => Some(720),
                Self::Medium => None, // native
                Self::High => None,   // native
            }
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    /// Numeric tier for ordering: 0 = Low, 1 = Medium, 2 = High.
    pub fn tier(self) -> u8 {
        match self {
            Self::Low => 0,
            Self::Medium => 1,
            Self::High => 2,
        }
    }

    /// Convert a tier number back to quality (clamped to valid range).
    pub fn from_tier(t: u8) -> Self {
        match t {
            0 => Self::Low,
            1 => Self::Medium,
            _ => Self::High,
        }
    }

    /// One tier below, or self if already at Low.
    pub fn step_down(self) -> Self {
        Self::from_tier(self.tier().saturating_sub(1))
    }

    /// One tier above, or self if already at High.
    pub fn step_up(self) -> Self {
        Self::from_tier((self.tier() + 1).min(2))
    }
}

impl Default for ScreenShareQuality {
    fn default() -> Self {
        Self::High
    }
}

/// The current ABR tier — may be reduced by the adaptive bitrate system.
/// Reset to High on every new stream start.
static SCREEN_SHARE_QUALITY: Lazy<parking_lot::RwLock<ScreenShareQuality>> =
    Lazy::new(|| parking_lot::RwLock::new(ScreenShareQuality::default()));

/// Low bandwidth mode: 500 kbps / 24 fps.
/// On Windows (default), screen share uses simulcast unless this is on.
/// On Linux, screen share never uses simulcast — single layer avoids starving multiple
/// OpenH264 instances when NVENC is not the active encoder.
static LOW_BANDWIDTH_MODE: Lazy<parking_lot::RwLock<bool>> =
    Lazy::new(|| parking_lot::RwLock::new(false));

pub fn is_low_bandwidth_mode() -> bool {
    *LOW_BANDWIDTH_MODE.read()
}

pub fn set_low_bandwidth_mode(enabled: bool) {
    *LOW_BANDWIDTH_MODE.write() = enabled;
    log::info!("Low bandwidth mode: {}", if enabled { "ON" } else { "OFF" });
}

pub fn get_screen_share_quality() -> ScreenShareQuality {
    *SCREEN_SHARE_QUALITY.read()
}

/// Set the current active quality (used by the adaptive bitrate system).
pub fn set_screen_share_quality(quality: ScreenShareQuality) {
    *SCREEN_SHARE_QUALITY.write() = quality;
}

/// Build `TrackPublishOptions` for screen sharing, respecting low bandwidth mode.
///
/// Always resets the ABR tier to High — each new stream starts at full quality
/// and the adaptive bitrate system steps down if needed.
///
/// - Default: 3.5 Mbps / 30 fps; simulcast ON except on Linux (single layer).
/// - Low bandwidth: 500 kbps / 24 fps; simulcast OFF everywhere.
fn build_screen_share_publish_options(codec: livekit::options::VideoCodec) -> TrackPublishOptions {
    // Reset ABR tier — every new stream starts at full quality
    set_screen_share_quality(ScreenShareQuality::High);
    let quality = ScreenShareQuality::High;

    let low_bw = is_low_bandwidth_mode();
    let bitrate = quality.max_bitrate();
    let framerate = quality.fps() as f64;
    let simulcast = !low_bw && !cfg!(target_os = "linux");

    log::info!(
        "Screen share publish options: codec={:?}, {}kbps, {}fps, simulcast={}, low_bw={}",
        codec,
        bitrate / 1000,
        framerate,
        simulcast,
        low_bw,
    );

    TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: codec,
        simulcast,
        video_encoding: Some(VideoEncoding {
            max_bitrate: bitrate,
            max_framerate: framerate,
        }),
        ..Default::default()
    }
}

/// Start screen sharing and return a handle containing the track.
/// Publishes the video track immediately after capture is running (avoids SDP race).
/// The caller is responsible for unpublishing when done. Dropping the handle
/// stops the capture thread.
pub async fn start_screen_capture(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
    window_title: Option<String>,
    window_handle: Option<String>,
) -> Result<ScreenShareHandle, String> {
    #[cfg(target_os = "windows")]
    {
        // Try windows-capture (Graphics Capture API) first - avoids DXGI/COM conflicts with audio
        match start_screen_capture_windows_graphics(
            room.clone(),
            mode,
            window_title.clone(),
            window_handle.clone(),
        )
        .await
        {
            Ok(handle) => return Ok(handle),
            Err(e) => log::warn!(
                "windows-capture failed ({}), falling back to DesktopCapturer",
                e
            ),
        }
        start_screen_capture_libwebrtc_or_fallback(room, mode, window_title, window_handle).await
    }

    #[cfg(target_os = "linux")]
    {
        let _ = window_handle;
        let _ = window_title; // Portal handles window selection natively
                              // Use portal for the native screen/window picker, then GStreamer
                              // pipewiresrc for real-time frame capture. This avoids the pw_init()/GTK
                              // conflict by letting GStreamer manage its own PipeWire connection.
        start_screen_capture_linux(room, mode).await
    }

    #[cfg(target_os = "macos")]
    {
        start_screen_capture_libwebrtc_or_fallback(room, mode, window_title, window_handle).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (room, mode, window_title, window_handle);
        Err("Screen sharing is not supported on this platform".to_string())
    }
}

/// Windows: Graphics Capture API via windows-capture crate.
#[cfg(target_os = "windows")]
async fn start_screen_capture_windows_graphics(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
    window_title: Option<String>,
    window_handle: Option<String>,
) -> Result<ScreenShareHandle, String> {
    use livekit::webrtc::video_source::native::NativeVideoSource;
    use windows_capture::capture::GraphicsCaptureApiHandler;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    let quality = get_screen_share_quality();
    // Resolution hint for signaling — actual frames come at native size
    let resolution = VideoResolution {
        width: 1920,
        height: 1080,
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let shutdown = Arc::new(AtomicBool::new(false));
    let first_frame = Arc::new(AtomicBool::new(false));
    let capture_interval_ms = (1000.0 / quality.fps() as f64).round() as u64;
    log::info!(
        "start_screen_capture_windows_graphics: mode={:?} quality={} fps={}",
        mode,
        quality.label(),
        quality.fps()
    );

    let make_flags = || (video_source.clone(), shutdown.clone(), first_frame.clone());
    let start_capture_with_interval = |interval: MinimumUpdateIntervalSettings| {
        let (capture_control, target_audio_pid) = match mode {
            ScreenShareMode::Screen => {
                log::debug!("Using Monitor::primary()");
                let monitor = Monitor::primary().map_err(|e| format!("Monitor::primary: {}", e))?;
                let settings = Settings::new(
                    monitor,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::Default,
                    SecondaryWindowSettings::Default,
                    interval,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    make_flags(),
                );
                (ScreenCaptureHandler::start_free_threaded(settings), None)
            }
            ScreenShareMode::Window => {
                let window = if let Some(ref handle) = window_handle {
                    let hwnd_value = handle
                        .parse::<usize>()
                        .map_err(|e| format!("Invalid window handle '{}': {}", handle, e))?;
                    let hwnd = hwnd_value as *mut std::ffi::c_void;
                    log::debug!("Using window handle: {} ({:p})", handle, hwnd);
                    let w = Window::from_raw_hwnd(hwnd);
                    if !w.is_valid() {
                        return Err("Selected window is no longer available".to_string());
                    }
                    w
                } else if let Some(ref title) = window_title {
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
                log::debug!(
                    "Capturing window: {} (audio PID: {:?})",
                    win_title,
                    target_audio_pid
                );
                let settings = Settings::new(
                    window,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::Default,
                    SecondaryWindowSettings::Default,
                    interval,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    make_flags(),
                );
                (
                    ScreenCaptureHandler::start_free_threaded(settings),
                    target_audio_pid,
                )
            }
        };

        capture_control
            .map(|control| (control, target_audio_pid))
            .map_err(|e| format!("windows-capture: {}", e))
    };

    // Older Windows builds support WGC capture but not MinUpdateInterval; retry without it.
    let (capture_control, target_audio_pid) = match start_capture_with_interval(
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(capture_interval_ms)),
    ) {
        Ok(values) => values,
        Err(e)
            if e.to_ascii_lowercase().contains("minimum update interval")
                && e.to_ascii_lowercase().contains("not supported") =>
        {
            log::warn!(
                "windows-capture min update interval unsupported; retrying with default interval"
            );
            start_capture_with_interval(MinimumUpdateIntervalSettings::Default)?
        }
        Err(e) => return Err(e),
    };
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
        RtcVideoSource::Native(video_source.clone()),
    );

    let codec = crate::codec::resolve_screen_share_codec();
    let publish_options = build_screen_share_publish_options(codec);
    room.local_participant()
        .publish_track(LocalTrack::Video(track.clone()), publish_options)
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
        video_source,
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
    frame_count: u64,
}

#[cfg(target_os = "windows")]
impl windows_capture::capture::GraphicsCaptureApiHandler for ScreenCaptureHandler {
    type Flags = (
        livekit::webrtc::video_source::native::NativeVideoSource,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
    );
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (video_source, shutdown, first_frame) = ctx.flags;
        log::debug!("ScreenCaptureHandler::new - capture starting");
        Ok(Self {
            video_source,
            shutdown,
            first_frame,
            frame_count: 0,
        })
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

        // Pass native resolution directly — no scaling needed
        let buffer = i420;

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

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        log::info!("Screen capture target closed");
        self.shutdown.store(true, Ordering::Relaxed);
        Ok(())
    }
}

/// Libwebrtc DesktopCapturer path (macOS/Linux) or fallback on Windows.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn start_screen_capture_libwebrtc_or_fallback(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
    window_title: Option<String>,
    _window_handle: Option<String>,
) -> Result<ScreenShareHandle, String> {
    let quality = get_screen_share_quality();
    let capture_interval_ms = (1000.0 / quality.fps() as f64).round() as u64;
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
            log::warn!(
                "DesktopCapturer::new failed (attempt {}), retrying in {}ms",
                attempt + 1,
                delay_ms
            );
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

    fn select_source_for_mode(
        mode: ScreenShareMode,
        sources: Vec<CaptureSource>,
        window_title: Option<&str>,
    ) -> Result<Option<CaptureSource>, String> {
        if sources.is_empty() {
            return Ok(None);
        }

        if mode != ScreenShareMode::Window {
            return Ok(sources.into_iter().next());
        }

        let requested_title = match window_title
            .map(str::trim)
            .filter(|title| !title.is_empty())
        {
            Some(title) => title,
            None => return Ok(sources.into_iter().next()),
        };
        let requested_title_lower = requested_title.to_ascii_lowercase();
        let mut fuzzy_match = None;
        let mut available_titles = Vec::new();

        for source in sources {
            let source_title = source.title();
            available_titles.push(source_title.clone());

            if source_title.eq_ignore_ascii_case(requested_title) {
                return Ok(Some(source));
            }

            if fuzzy_match.is_none()
                && source_title
                    .to_ascii_lowercase()
                    .contains(&requested_title_lower)
            {
                fuzzy_match = Some(source);
            }
        }

        if let Some(source) = fuzzy_match {
            log::warn!(
                "DesktopCapturer fallback matched window '{}' fuzzily to '{}'",
                requested_title,
                source.title()
            );
            return Ok(Some(source));
        }

        Err(format!(
            "Selected window '{}' is no longer available to DesktopCapturer fallback (available: {:?})",
            requested_title, available_titles
        ))
    }

    let sources = capturer.get_source_list();
    let source = select_source_for_mode(mode, sources, window_title.as_deref())?;
    if source.is_none() {
        log::debug!("get_source_list returned empty, trying without explicit source");
    }

    // Resolution hint for signaling — actual frames come at native size
    let resolution = VideoResolution {
        width: 1920,
        height: 1080,
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let video_source_clone = video_source.clone();

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_cap = shutdown.clone();
    let shutdown_thread = shutdown.clone();

    capturer.start_capture(
        source,
        move |result: Result<DesktopFrame, libwebrtc::desktop_capturer::CaptureError>| {
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

            // Pass native resolution directly — no scaling needed
            let buffer = i420;

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
        },
    );

    let capturer_thread = thread::spawn(move || {
        let mut cap = capturer;
        while !shutdown_thread.load(Ordering::Relaxed) {
            cap.capture_frame();
            thread::sleep(Duration::from_millis(capture_interval_ms));
        }
    });

    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        RtcVideoSource::Native(video_source.clone()),
    );

    let codec = crate::codec::resolve_screen_share_codec();
    let publish_options = build_screen_share_publish_options(codec);
    room.local_participant()
        .publish_track(LocalTrack::Video(track.clone()), publish_options)
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
        video_source,
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

    let quality = get_screen_share_quality();
    let capture_interval_ms = (1000.0 / quality.fps() as f64).round() as u64;
    log::warn!(
        "start_screen_capture_screenshots_fallback: quality={} fps={}",
        quality.label(),
        quality.fps()
    );
    let screens = screenshots::Screen::all()
        .map_err(|e| format!("screenshots: failed to enumerate screens: {}", e))?;
    let screen = screens
        .into_iter()
        .next()
        .ok_or("screenshots: no screens found")?;

    // Resolution hint for signaling — actual frames come at native size
    let resolution = VideoResolution {
        width: 1920,
        height: 1080,
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let video_source_clone = video_source.clone();

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_thread = shutdown.clone();

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

                    // Pass native resolution directly — no scaling needed
                    let buffer = i420;

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
        RtcVideoSource::Native(video_source.clone()),
    );

    // Publish video immediately while capture is hot
    let codec = crate::codec::resolve_screen_share_codec();
    let publish_options = build_screen_share_publish_options(codec);
    room.local_participant()
        .publish_track(LocalTrack::Video(track.clone()), publish_options)
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
        video_source,
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
    let frame_buf: Arc<parking_lot::Mutex<Vec<i16>>> = Arc::new(parking_lot::Mutex::new(
        Vec::with_capacity(SAMPLES_PER_10MS * 2),
    ));

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
            let mut audio_client =
                match AudioClient::new_application_loopback_client(process_id, include_tree) {
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

/// Linux: xdg-desktop-portal for screen/window picker + GStreamer pipewiresrc for capture.
///
/// Flow:
/// 1. ashpd opens the ScreenCast portal → native compositor picker dialog
/// 2. User selects screen/window → portal returns PipeWire node_id
/// 3. GStreamer pipeline: pipewiresrc path={node_id} ! videoconvert ! I420 ! appsink
/// 4. Dedicated thread pulls frames from appsink → feeds LiveKit NativeVideoSource
///
/// GStreamer manages its own PipeWire connection internally via pipewiresrc,
/// so no pw_init() is needed (avoiding the GTK conflict).
#[cfg(target_os = "linux")]
async fn start_screen_capture_linux(
    room: Arc<livekit::Room>,
    mode: ScreenShareMode,
) -> Result<ScreenShareHandle, String> {
    use ashpd::desktop::{
        screencast::{CursorMode, Screencast, SourceType},
        PersistMode,
    };
    use livekit::webrtc::video_source::native::NativeVideoSource;

    let quality = get_screen_share_quality();
    log::info!(
        "start_screen_capture_linux: mode={:?} quality={}",
        mode,
        quality.label()
    );

    // --- 1. Show native screen/window picker via xdg-desktop-portal ---
    log::info!("Linux capture: creating Screencast proxy...");
    let proxy = tokio::time::timeout(Duration::from_secs(5), Screencast::new())
        .await
        .map_err(|_| "Screencast portal: D-Bus connection timed out (5s)".to_string())?
        .map_err(|e| format!("Screencast portal unavailable: {}", e))?;

    log::info!("Linux capture: creating session...");
    let session = tokio::time::timeout(Duration::from_secs(5), proxy.create_session())
        .await
        .map_err(|_| "create_session timed out (5s)".to_string())?
        .map_err(|e| format!("Failed to create screencast session: {}", e))?;

    let source_type = match mode {
        ScreenShareMode::Screen => SourceType::Monitor,
        ScreenShareMode::Window => SourceType::Window,
    };

    log::info!("Linux capture: selecting sources ({:?})...", mode);
    tokio::time::timeout(
        Duration::from_secs(5),
        proxy.select_sources(
            &session,
            CursorMode::Embedded,
            source_type.into(),
            true,
            None,
            PersistMode::DoNot,
        ),
    )
    .await
    .map_err(|_| "select_sources timed out (5s)".to_string())?
    .map_err(|e| format!("select_sources: {}", e))?;

    log::info!("Linux capture: waiting for user to pick screen/window...");
    let start_response = tokio::time::timeout(Duration::from_secs(60), proxy.start(&session, None))
        .await
        .map_err(|_| {
            "Portal picker timed out after 60s — is xdg-desktop-portal-kde running?".to_string()
        })?
        .map_err(|e| format!("Portal start failed: {}", e))?;

    let response = start_response
        .response()
        .map_err(|e| format!("Portal response error: {}", e))?;

    let streams = response.streams();
    if streams.is_empty() {
        return Err("No streams returned from portal (user cancelled?)".to_string());
    }
    let portal_stream = &streams[0];
    let node_id = portal_stream.pipe_wire_node_id();
    log::info!(
        "Portal returned PipeWire node_id={}, size={:?}",
        node_id,
        portal_stream.size()
    );

    // Keep the portal session alive — dropping ends the screencast.
    let session_box = Box::new(session);
    std::mem::forget(session_box);

    // --- 2. Set up GStreamer pipeline ---
    use gstreamer::prelude::*;

    gstreamer::init().map_err(|e| format!("GStreamer init failed: {}", e))?;

    let pipeline_str = format!(
        "pipewiresrc path={node_id} do-timestamp=true keepalive-time=1000 \
         ! videorate \
         ! videoconvert \
         ! video/x-raw,format=I420,framerate={fps}/1 \
         ! appsink name=sink emit-signals=false max-buffers=2 drop=true sync=false",
        node_id = node_id,
        fps = quality.fps(),
    );
    log::info!("GStreamer pipeline: {}", pipeline_str);

    let pipeline = gstreamer::parse::launch(&pipeline_str).map_err(|e| {
        log::error!("GStreamer pipeline parse failed: {}", e);
        format!("GStreamer pipeline parse failed: {}", e)
    })?;
    let pipeline = pipeline.downcast::<gstreamer::Pipeline>().map_err(|_| {
        log::error!("Failed to cast to Pipeline");
        "Failed to cast to Pipeline".to_string()
    })?;

    let appsink = pipeline
        .by_name("sink")
        .ok_or_else(|| {
            log::error!("appsink not found");
            "appsink element not found in pipeline".to_string()
        })?
        .downcast::<gstreamer_app::AppSink>()
        .map_err(|_| {
            log::error!("Failed to cast to AppSink");
            "Failed to cast sink to AppSink".to_string()
        })?;

    pipeline.set_state(gstreamer::State::Playing).map_err(|e| {
        log::error!("Failed to start GStreamer pipeline: {:?}", e);
        format!("Failed to start GStreamer pipeline: {:?}", e)
    })?;
    log::info!("GStreamer pipeline started");

    // --- 3. Spawn frame-pulling thread ---
    // Resolution hint for signaling — actual frames come at native size from GStreamer
    let resolution = livekit::webrtc::video_source::VideoResolution {
        width: 1920,
        height: 1080,
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let video_source_cap = video_source.clone();
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_thread = shutdown.clone();

    let pipeline_clone = pipeline.clone();
    let capturer_thread = thread::Builder::new()
        .name("gst-screen-capture".into())
        .spawn(move || {
            log::info!("GStreamer capture thread started for node {}", node_id);
            let mut frame_count: u64 = 0;

            while !shutdown_thread.load(Ordering::Relaxed) {
                // Pull a sample with a 100ms timeout so we can check shutdown
                let sample = appsink.try_pull_sample(gstreamer::ClockTime::from_mseconds(100));
                let Some(sample) = sample else {
                    if appsink.is_eos() {
                        log::info!("GStreamer appsink reached EOS");
                        break;
                    }
                    continue;
                };

                // Extract frame dimensions from caps
                let caps = match sample.caps() {
                    Some(c) => c,
                    None => continue,
                };
                let structure = match caps.structure(0) {
                    Some(s) => s,
                    None => continue,
                };
                let out_w: i32 = match structure.get("width") {
                    Ok(w) => w,
                    Err(_) => continue,
                };
                let out_h: i32 = match structure.get("height") {
                    Ok(h) => h,
                    Err(_) => continue,
                };
                if out_w <= 0 || out_h <= 0 {
                    continue;
                }

                let buffer = match sample.buffer() {
                    Some(b) => b,
                    None => continue,
                };

                let map = match buffer.map_readable() {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let data = map.as_slice();

                // Data is already I420 thanks to videoconvert in the pipeline.
                // Frame layout: Y plane (w*h) + U plane (w/2*h/2) + V plane (w/2*h/2)
                let expected_size = (out_w * out_h * 3 / 2) as usize;
                if data.len() < expected_size {
                    if frame_count == 0 {
                        log::warn!(
                            "GStreamer: frame too small ({} < {})",
                            data.len(),
                            expected_size
                        );
                    }
                    continue;
                }

                // Copy I420 data directly into a LiveKit I420Buffer
                let mut i420 =
                    livekit::webrtc::video_frame::I420Buffer::new(out_w as u32, out_h as u32);
                let (dst_y, dst_u, dst_v) = i420.data_mut();

                let y_size = (out_w * out_h) as usize;
                let uv_size = (out_w / 2 * out_h / 2) as usize;
                dst_y[..y_size].copy_from_slice(&data[..y_size]);
                dst_u[..uv_size].copy_from_slice(&data[y_size..y_size + uv_size]);
                dst_v[..uv_size].copy_from_slice(&data[y_size + uv_size..y_size + 2 * uv_size]);

                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_micros() as i64;
                let vf = livekit::webrtc::video_frame::VideoFrame {
                    rotation: livekit::webrtc::video_frame::VideoRotation::VideoRotation0,
                    timestamp_us: now,
                    buffer: i420,
                };
                video_source_cap.capture_frame(&vf);
                frame_count += 1;
                if frame_count == 1 {
                    log::info!("GStreamer: first frame captured ({}x{} I420)", out_w, out_h);
                } else if frame_count % 300 == 0 {
                    log::debug!("GStreamer: frame {} ({}x{})", frame_count, out_w, out_h);
                }
            }

            // Shut down the pipeline
            let _ = pipeline_clone.set_state(gstreamer::State::Null);
            log::info!(
                "GStreamer capture thread exited (frame_count={})",
                frame_count
            );
        })
        .map_err(|e| format!("Failed to spawn GStreamer capture thread: {}", e))?;

    // --- 4. Publish video track ---
    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        livekit::webrtc::video_source::RtcVideoSource::Native(video_source.clone()),
    );

    let codec = crate::codec::resolve_screen_share_codec();
    let publish_options = build_screen_share_publish_options(codec);
    room.local_participant()
        .publish_track(LocalTrack::Video(track.clone()), publish_options)
        .await
        .map_err(|e| format!("Failed to publish screen track: {}", e))?;
    log::info!("Screen track published successfully");

    // --- 5. Desktop audio capture via GStreamer pulsesrc ---
    log::info!("Setting up screen share audio capture...");
    let shutdown_audio = shutdown.clone();
    let (audio_track, audio_thread) = setup_screen_share_audio_gstreamer(shutdown_audio);
    log::info!(
        "Audio setup result: track={}, thread={}",
        audio_track.is_some(),
        audio_thread.is_some()
    );

    Ok(ScreenShareHandle {
        track,
        audio_track,
        video_source,
        _shutdown: shutdown,
        _capturer_thread: Some(capturer_thread),
        _audio_capture_thread: audio_thread,
    })
}

/// Set up desktop audio capture via GStreamer pulsesrc on Linux.
///
/// Captures all desktop audio from the default sink's monitor using PipeWire's
/// PulseAudio compatibility layer. Outputs mono i16 at 48kHz in 10ms frames
/// for LiveKit.
#[cfg(target_os = "linux")]
fn setup_screen_share_audio_gstreamer(
    shutdown: Arc<AtomicBool>,
) -> (Option<LocalAudioTrack>, Option<std::thread::JoinHandle<()>>) {
    use gstreamer::prelude::*;
    use livekit::webrtc::{
        audio_frame::AudioFrame,
        audio_source::native::NativeAudioSource,
        prelude::{AudioSourceOptions, RtcAudioSource},
    };

    const SAMPLE_RATE: u32 = 48000;
    const NUM_CHANNELS: u32 = 1;
    const SAMPLES_PER_10MS: usize = (SAMPLE_RATE / 100) as usize; // 480

    eprintln!("[pax-audio] setup_screen_share_audio_gstreamer called");
    log::info!("Setting up GStreamer audio capture");

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

    // Try pulsesrc with default monitor first, then fall back to autoaudiosrc
    let pipeline_str = format!(
        "pulsesrc device=\"@DEFAULT_MONITOR@\" \
         ! audioconvert \
         ! audioresample \
         ! audio/x-raw,format=S16LE,rate={rate},channels={ch} \
         ! appsink name=audiosink emit-signals=false max-buffers=10 drop=true sync=false",
        rate = SAMPLE_RATE,
        ch = NUM_CHANNELS,
    );
    eprintln!("[pax-audio] trying pipeline: {}", pipeline_str);
    log::info!("GStreamer audio pipeline: {}", pipeline_str);

    let audio_pipeline = match gstreamer::parse::launch(&pipeline_str) {
        Ok(p) => {
            eprintln!("[pax-audio] parse::launch succeeded");
            p
        }
        Err(e) => {
            eprintln!(
                "[pax-audio] pulsesrc pipeline failed: {}, skipping audio",
                e
            );
            log::warn!("GStreamer audio pipeline parse failed: {}", e);
            return (None, None);
        }
    };
    let audio_pipeline = match audio_pipeline.downcast::<gstreamer::Pipeline>() {
        Ok(p) => {
            eprintln!("[pax-audio] downcast to Pipeline succeeded");
            p
        }
        Err(_) => {
            eprintln!("[pax-audio] downcast to Pipeline FAILED");
            log::warn!("Failed to cast audio pipeline");
            return (None, None);
        }
    };
    let audio_appsink = match audio_pipeline.by_name("audiosink") {
        Some(e) => match e.downcast::<gstreamer_app::AppSink>() {
            Ok(s) => s,
            Err(_) => {
                eprintln!("[pax-audio] downcast audiosink FAILED");
                log::warn!("Failed to cast audiosink to AppSink");
                return (None, None);
            }
        },
        None => {
            eprintln!("[pax-audio] audiosink not found in pipeline");
            log::warn!("audiosink element not found in audio pipeline");
            return (None, None);
        }
    };

    eprintln!("[pax-audio] setting pipeline to Playing...");
    if let Err(e) = audio_pipeline.set_state(gstreamer::State::Playing) {
        eprintln!("[pax-audio] set_state(Playing) FAILED: {:?}", e);
        log::warn!("Failed to start GStreamer audio pipeline: {:?}", e);
        return (None, None);
    }
    eprintln!("[pax-audio] audio pipeline Playing!");
    log::info!("GStreamer audio pipeline started (desktop audio capture)");

    let audio_source_clone = audio_source.clone();
    let audio_pipeline_clone = audio_pipeline.clone();

    let audio_thread = thread::Builder::new()
        .name("gst-audio-capture".into())
        .spawn(move || {
            log::info!("GStreamer audio capture thread started");
            let mut sample_buf: Vec<i16> = Vec::with_capacity(SAMPLES_PER_10MS * 2);

            // Create a tokio runtime for this thread to drive audio_source.capture_frame
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create audio tokio runtime");

            while !shutdown.load(Ordering::Relaxed) {
                let sample =
                    audio_appsink.try_pull_sample(gstreamer::ClockTime::from_mseconds(100));
                let Some(sample) = sample else {
                    if audio_appsink.is_eos() {
                        log::info!("GStreamer audio appsink reached EOS");
                        break;
                    }
                    continue;
                };

                let buffer = match sample.buffer() {
                    Some(b) => b,
                    None => continue,
                };
                let map = match buffer.map_readable() {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                // Data is S16LE mono — interpret as i16 slice
                let data = map.as_slice();
                let samples = unsafe {
                    std::slice::from_raw_parts(
                        data.as_ptr() as *const i16,
                        data.len() / std::mem::size_of::<i16>(),
                    )
                };
                sample_buf.extend_from_slice(samples);

                // Emit 10ms frames (480 mono samples at 48kHz)
                while sample_buf.len() >= SAMPLES_PER_10MS {
                    let frame_samples: Vec<i16> = sample_buf.drain(..SAMPLES_PER_10MS).collect();
                    let frame = AudioFrame {
                        data: frame_samples.into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: NUM_CHANNELS,
                        samples_per_channel: SAMPLES_PER_10MS as u32,
                    };
                    rt.block_on(async {
                        if let Err(e) = audio_source_clone.capture_frame(&frame).await {
                            log::warn!("Screen share audio capture: {}", e);
                        }
                    });
                }
            }

            let _ = audio_pipeline_clone.set_state(gstreamer::State::Null);
            log::info!("GStreamer audio capture thread exited");
        })
        .map_err(|e| {
            log::warn!("GStreamer audio thread spawn failed: {}", e);
            e
        })
        .ok();

    if audio_thread.is_none() {
        return (None, None);
    }

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    log::info!("Screen share audio (GStreamer pulsesrc monitor) enabled");
    (Some(track), audio_thread)
}

#[cfg(target_os = "windows")]
mod windows_picker {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::slice;

    use png::{BitDepth, ColorType, Encoder};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, CreateSolidBrush, DeleteDC, DeleteObject, FillRect,
        SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, RGBQUAD, SRCCOPY, STRETCH_HALFTONE,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS, PW_CLIENTONLY};
    use windows::Win32::UI::WindowsAndMessaging::{
        CopyIcon, DestroyIcon, DrawIconEx, GetClassLongPtrW, GetWindowRect, SendMessageW,
        DI_NORMAL, GCLP_HICON, GCLP_HICONSM, HICON, ICON_BIG, ICON_SMALL2, PW_RENDERFULLCONTENT,
        WM_GETICON,
    };
    use windows_capture::window::Window;

    use super::ScreenShareWindowOption;

    const THUMBNAIL_WIDTH: i32 = 320;
    const THUMBNAIL_HEIGHT: i32 = 180;
    const ICON_SIZE: i32 = 32;

    struct BitmapSurface {
        dc: HDC,
        bitmap: HBITMAP,
        old_object: HGDIOBJ,
        bits: *mut u8,
        width: i32,
        height: i32,
    }

    impl BitmapSurface {
        fn new(width: i32, height: i32) -> Result<Self, String> {
            if width <= 0 || height <= 0 {
                return Err("Invalid bitmap size".to_string());
            }

            unsafe {
                let dc = CreateCompatibleDC(None);
                if dc.0.is_null() {
                    return Err("CreateCompatibleDC failed".to_string());
                }

                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width,
                        biHeight: -height,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    bmiColors: [RGBQUAD::default(); 1],
                };
                let mut bits = std::ptr::null_mut();
                let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)
                    .map_err(|e| format!("CreateDIBSection failed: {e}"))?;
                let old_object = SelectObject(dc, HGDIOBJ(bitmap.0));
                if old_object.0.is_null() {
                    let _ = DeleteObject(HGDIOBJ(bitmap.0));
                    let _ = DeleteDC(dc);
                    return Err("SelectObject failed".to_string());
                }

                Ok(Self {
                    dc,
                    bitmap,
                    old_object,
                    bits: bits.cast(),
                    width,
                    height,
                })
            }
        }

        fn fill(&self, color: COLORREF) {
            unsafe {
                let brush = CreateSolidBrush(color);
                if !brush.0.is_null() {
                    let rect = RECT {
                        left: 0,
                        top: 0,
                        right: self.width,
                        bottom: self.height,
                    };
                    let _ = FillRect(self.dc, &rect, brush);
                    let _ = DeleteObject(HGDIOBJ(brush.0));
                }
            }
        }

        fn png_data_url(&self, preserve_alpha: bool) -> Option<String> {
            let len = (self.width * self.height * 4) as usize;
            let mut rgba = unsafe { slice::from_raw_parts(self.bits, len).to_vec() };
            for px in rgba.chunks_exact_mut(4) {
                px.swap(0, 2);
                if !preserve_alpha {
                    px[3] = 255;
                }
            }

            let mut encoded = Vec::new();
            let mut encoder = Encoder::new(&mut encoded, self.width as u32, self.height as u32);
            encoder.set_color(ColorType::Rgba);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(&rgba).ok()?;
            drop(writer);

            Some(format!(
                "data:image/png;base64,{}",
                data_encoding::BASE64.encode(&encoded)
            ))
        }
    }

    impl Drop for BitmapSurface {
        fn drop(&mut self) {
            unsafe {
                if !self.old_object.0.is_null() {
                    let _ = SelectObject(self.dc, self.old_object);
                }
                if !self.bitmap.0.is_null() {
                    let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
                }
                if !self.dc.0.is_null() {
                    let _ = DeleteDC(self.dc);
                }
            }
        }
    }

    fn get_window_icon(hwnd: HWND) -> Option<HICON> {
        let candidates = [
            unsafe {
                SendMessageW(
                    hwnd,
                    WM_GETICON,
                    Some(WPARAM(ICON_BIG as usize)),
                    Some(LPARAM(0)),
                )
            },
            unsafe {
                SendMessageW(
                    hwnd,
                    WM_GETICON,
                    Some(WPARAM(ICON_SMALL2 as usize)),
                    Some(LPARAM(0)),
                )
            },
            LRESULT(unsafe { GetClassLongPtrW(hwnd, GCLP_HICON) as isize }),
            LRESULT(unsafe { GetClassLongPtrW(hwnd, GCLP_HICONSM) as isize }),
        ];

        for candidate in candidates {
            if candidate.0 != 0 {
                let icon = HICON(candidate.0 as *mut c_void);
                if let Ok(copy) = unsafe { CopyIcon(icon) } {
                    if !copy.0.is_null() {
                        return Some(copy);
                    }
                }
            }
        }
        None
    }

    fn capture_window_icon_data_url(hwnd: HWND) -> Option<String> {
        let icon = get_window_icon(hwnd)?;
        let surface = BitmapSurface::new(ICON_SIZE, ICON_SIZE).ok()?;
        let result = unsafe {
            DrawIconEx(
                surface.dc, 0, 0, icon, ICON_SIZE, ICON_SIZE, 0, None, DI_NORMAL,
            )
        }
        .ok()
        .and_then(|_| surface.png_data_url(true));
        let _ = unsafe { DestroyIcon(icon) };
        result
    }

    fn window_rect(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
        Some(rect)
    }

    fn fit_size(src_w: i32, src_h: i32, max_w: i32, max_h: i32) -> (i32, i32) {
        if src_w <= 0 || src_h <= 0 {
            return (max_w.max(1), max_h.max(1));
        }
        let width_limited = max_w * src_h <= max_h * src_w;
        if width_limited {
            let h = (src_h * max_w / src_w).max(1);
            (max_w.max(1), h)
        } else {
            let w = (src_w * max_h / src_h).max(1);
            (w, max_h.max(1))
        }
    }

    fn capture_window_thumbnail_data_url(hwnd: HWND) -> Option<String> {
        let rect = window_rect(hwnd)?;
        let src_w = (rect.right - rect.left).max(1);
        let src_h = (rect.bottom - rect.top).max(1);
        let source = BitmapSurface::new(src_w, src_h).ok()?;

        let rendered =
            unsafe { PrintWindow(hwnd, source.dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)) }
                .as_bool()
                || unsafe { PrintWindow(hwnd, source.dc, PW_CLIENTONLY) }.as_bool();
        if !rendered {
            return None;
        }

        let canvas = BitmapSurface::new(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT).ok()?;
        canvas.fill(COLORREF(0x16181d));

        let (scaled_w, scaled_h) = fit_size(src_w, src_h, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
        let offset_x = (THUMBNAIL_WIDTH - scaled_w) / 2;
        let offset_y = (THUMBNAIL_HEIGHT - scaled_h) / 2;
        unsafe {
            let _ = SetStretchBltMode(canvas.dc, STRETCH_HALFTONE);
            if !StretchBlt(
                canvas.dc,
                offset_x,
                offset_y,
                scaled_w,
                scaled_h,
                Some(source.dc),
                0,
                0,
                src_w,
                src_h,
                SRCCOPY,
            )
            .as_bool()
            {
                return None;
            }
        }

        canvas.png_data_url(false)
    }

    pub fn enumerate() -> Result<Vec<ScreenShareWindowOption>, String> {
        log::debug!("enumerate_screen_share_windows");
        let windows = Window::enumerate().map_err(|e| format!("Window::enumerate: {}", e))?;
        let mut out = Vec::new();
        for window in windows {
            if !window.is_valid() {
                continue;
            }

            let hwnd_raw = window.as_raw_hwnd();
            let hwnd = HWND(hwnd_raw);
            let title = window.title().unwrap_or_else(|_| String::new());
            let process_name = window.process_name().unwrap_or_else(|_| String::new());
            if title.is_empty() && process_name.is_empty() {
                continue;
            }

            out.push(ScreenShareWindowOption {
                id: (hwnd_raw as usize).to_string(),
                title,
                process_name,
                icon_data_url: capture_window_icon_data_url(hwnd),
                thumbnail_data_url: capture_window_thumbnail_data_url(hwnd),
            });
        }

        log::info!("Found {} capturable windows", out.len());
        Ok(out)
    }
}

/// Enumerate capturable windows (Windows only) with thumbnails and icons.
#[cfg(target_os = "windows")]
pub fn enumerate_screen_share_windows() -> Result<Vec<ScreenShareWindowOption>, String> {
    windows_picker::enumerate()
}

#[cfg(target_os = "windows")]
pub fn is_window_handle_valid(hwnd: usize) -> bool {
    use windows_capture::window::Window;

    let window = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
    window.is_valid()
}

#[cfg(not(target_os = "windows"))]
pub fn is_window_handle_valid(_hwnd: usize) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub fn enumerate_screen_share_windows() -> Result<Vec<ScreenShareWindowOption>, String> {
    Ok(vec![])
}

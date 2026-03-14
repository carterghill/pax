//! Screen capture for LiveKit screen sharing.
//!
//! On Windows: uses windows-capture (Graphics Capture API) as primary; falls back to
//! libwebrtc DesktopCapturer or screenshots crate if needed.
//! On macOS/Linux: uses libwebrtc DesktopCapturer.
//!
//! Converts frames to I420 and feeds them into a NativeVideoSource for publishing.
//! On Windows, also captures system audio (WASAPI process loopback) for screen-share audio.

use std::sync::atomic::{AtomicBool, Ordering};
use once_cell::sync::Lazy;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
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

/// Target resolution for screen share (scaled down for bandwidth).
const TARGET_WIDTH: u32 = 1280;
const TARGET_HEIGHT: u32 = 720;

/// Configurable screen share settings (bitrate, fps). Applied when starting a new share.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenShareConfig {
    pub bitrate_kbps: u32,
    pub fps: u32,
}

impl Default for ScreenShareConfig {
    fn default() -> Self {
        Self { bitrate_kbps: 1500, fps: 10 }
    }
}

static SCREEN_SHARE_CONFIG: Lazy<parking_lot::RwLock<ScreenShareConfig>> =
    Lazy::new(|| parking_lot::RwLock::new(ScreenShareConfig::default()));

pub fn get_screen_share_config() -> ScreenShareConfig {
    SCREEN_SHARE_CONFIG.read().clone()
}

pub fn set_screen_share_config(config: ScreenShareConfig) {
    *SCREEN_SHARE_CONFIG.write() = config;
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
            Err(e) => eprintln!("[Pax] windows-capture failed ({}), falling back to DesktopCapturer", e),
        }
        start_screen_capture_libwebrtc_or_fallback(room, mode, window_title).await
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    let resolution = VideoResolution {
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let shutdown = Arc::new(AtomicBool::new(false));
    let first_frame = Arc::new(AtomicBool::new(false));
    let flags = (video_source.clone(), shutdown.clone(), first_frame.clone());

    let config = get_screen_share_config();
    let capture_interval_ms = (1000.0 / config.fps.max(1) as f64).round() as u64;
    eprintln!("[Pax] start_screen_capture_windows_graphics: mode={:?} bitrate={}kbps fps={}", mode, config.bitrate_kbps, config.fps);

    let (capture_control, target_audio_pid) = match mode {
        ScreenShareMode::Screen => {
            eprintln!("[Pax] Using Monitor::primary()");
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
                eprintln!("[Pax] Looking up window by title: {}", title);
                Window::from_name(title)
                    .or_else(|_| Window::from_contains_name(title))
                    .map_err(|e| format!("Window '{}': {}", title, e))?
            } else {
                eprintln!("[Pax] Using Window::foreground() (no title specified)");
                Window::foreground().map_err(|e| format!("Window::foreground: {}", e))?
            };
            let win_title = window.title().unwrap_or_else(|_| String::new());
            let target_audio_pid = window.process_id().ok();
            eprintln!("[Pax] Capturing window: {} (audio PID: {:?})", win_title, target_audio_pid);
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
    eprintln!("[Pax] Waiting for first capture frame before publishing...");
    for i in 0..100 {
        if first_frame.load(Ordering::Relaxed) {
            eprintln!("[Pax] First frame received after {}ms", i * 50);
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if !first_frame.load(Ordering::Relaxed) {
        eprintln!("[Pax] WARNING: No frame received in 5s, publishing anyway");
    }

    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        RtcVideoSource::Native(video_source),
    );

    let bitrate = (config.bitrate_kbps as u64) * 1000;
    let framerate = config.fps as f64;
    eprintln!("[Pax] Publishing screen track to LiveKit (VP8, {}kbps, {}fps)", config.bitrate_kbps, config.fps);
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: VideoCodec::VP8,
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
    eprintln!("[Pax] Screen track published successfully");

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
    frame_count: u64,
}

#[cfg(target_os = "windows")]
impl windows_capture::capture::GraphicsCaptureApiHandler for ScreenCaptureHandler {
    type Flags = (livekit::webrtc::video_source::native::NativeVideoSource, Arc<AtomicBool>, Arc<AtomicBool>);
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (video_source, shutdown, first_frame) = ctx.flags;
        eprintln!("[Pax] ScreenCaptureHandler::new - capture starting");
        Ok(Self { video_source, shutdown, first_frame, frame_count: 0 })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame<'_>,
        capture_control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.shutdown.load(Ordering::Relaxed) {
            eprintln!("[Pax] Screen capture: shutdown requested, stopping");
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

        let (out_w, out_h) = (TARGET_WIDTH as i32, TARGET_HEIGHT as i32);
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
            eprintln!("[Pax] Screen capture: first frame ({}x{})", w, h);
        } else if self.frame_count % 100 == 0 {
            eprintln!("[Pax] Screen capture: frame {} ({}x{})", self.frame_count, w, h);
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
    let config = get_screen_share_config();
    let bitrate = (config.bitrate_kbps as u64) * 1000;
    let capture_interval_ms = (1000.0 / config.fps.max(1) as f64).round() as u64;
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

    eprintln!("[Pax] start_screen_capture_libwebrtc: mode={:?}", mode);
    let mut capturer_opt = None;
    for attempt in 0..3 {
        let mut options = DesktopCapturerOptions::new(source_type);
        options.set_include_cursor(true);
        capturer_opt = DesktopCapturer::new(options);
        if capturer_opt.is_some() {
            eprintln!("[Pax] DesktopCapturer::new succeeded on attempt {}", attempt + 1);
            break;
        }
        if attempt < 2 {
            let delay_ms = if attempt == 0 { 1000 } else { 500 };
            eprintln!("[Pax] DesktopCapturer::new failed (attempt {}), retrying in {}ms", attempt + 1, delay_ms);
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }

    let mut capturer = match capturer_opt {
        Some(c) => c,
        None => {
            eprintln!("[Pax] DesktopCapturer::new failed after retries");
            if mode == ScreenShareMode::Screen {
                eprintln!("[Pax] Falling back to screenshots crate");
                return start_screen_capture_screenshots_fallback(room).await;
            }
            return Err("Failed to create desktop capturer. Try selecting \"Entire screen\" instead of a window.".to_string());
        }
    };

    let sources = capturer.get_source_list();
    let source: Option<CaptureSource> = sources.into_iter().next();
    if source.is_none() {
        eprintln!("[Pax] get_source_list returned empty, trying without explicit source");
    }

    let resolution = VideoResolution {
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
    };
    let video_source = NativeVideoSource::new(resolution, true);
    let video_source_clone = video_source.clone();

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_cap = shutdown.clone();
    let shutdown_thread = shutdown.clone();

    capturer.start_capture(source, move |result: Result<DesktopFrame, libwebrtc::desktop_capturer::CaptureError>| {
        if shutdown_cap.load(Ordering::Relaxed) {
            return;
        }
        let frame = match result {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[Pax] Screen capture frame error: {:?}", e);
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

        let (out_w, out_h) = (TARGET_WIDTH as i32, TARGET_HEIGHT as i32);
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
                video_codec: VideoCodec::VP8,
                simulcast: false,
                video_encoding: Some(VideoEncoding {
                    max_bitrate: bitrate,
                    max_framerate: config.fps as f64,
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
    let (audio_track, loopback_stream, audio_capture_thread) = (None, None, None);
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

    let config = get_screen_share_config();
    let bitrate = (config.bitrate_kbps as u64) * 1000;
    let capture_interval_ms = (1000.0 / config.fps.max(1) as f64).round() as u64;
    eprintln!("[Pax] start_screen_capture_screenshots_fallback");
    let screens = screenshots::Screen::all()
        .map_err(|e| format!("screenshots: failed to enumerate screens: {}", e))?;
    let screen = screens.into_iter().next()
        .ok_or("screenshots: no screens found")?;

    let resolution = VideoResolution {
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
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

                    let (out_w, out_h) = (TARGET_WIDTH as i32, TARGET_HEIGHT as i32);
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
                    eprintln!("[Pax] screenshots capture: {}", e);
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
                video_codec: VideoCodec::VP8,
                simulcast: false,
                video_encoding: Some(VideoEncoding {
                    max_bitrate: bitrate,
                    max_framerate: config.fps as f64,
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
    let (audio_track, loopback_stream, audio_capture_thread) = (None, None, None);
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
            eprintln!("[Pax] Screen share audio: EXCLUDE mode (all system audio except Pax)");
            (std::process::id(), false)
        }
        Some(pid) => {
            eprintln!("[Pax] Screen share audio: INCLUDE mode (only PID {})", pid);
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
                eprintln!("[Pax] Screen share process loopback: COM init failed");
                return;
            }
            eprintln!("[Pax] Screen share audio: initializing WASAPI process loopback");
            let mut audio_client = match AudioClient::new_application_loopback_client(
                process_id,
                include_tree,
            ) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[Pax] Screen share process loopback: {}", e);
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
                eprintln!("[Pax] Screen share process loopback: init failed");
                return;
            }
            let h_event = match audio_client.set_get_eventhandle() {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[Pax] Screen share process loopback event: {}", e);
                    return;
                }
            };
            let capture_client = match audio_client.get_audiocaptureclient() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[Pax] Screen share process loopback capture client: {}", e);
                    return;
                }
            };
            if audio_client.start_stream().is_err() {
                eprintln!("[Pax] Screen share process loopback: start failed");
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
            eprintln!("[Pax] Screen share process loopback thread spawn failed: {}", e);
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
                eprintln!("[Pax] Screen share audio capture: {}", e);
            }
        }
    });

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    eprintln!("[Pax] Screen share audio (process loopback) enabled");
    (Some(track), None, capture_thread)
}

/// Set up system audio capture (WASAPI device loopback on Windows) for screen share.
/// Returns (audio_track, stream) if successful. Caller must keep stream alive.
///
/// DISABLED: Opening the default output device for loopback while it's already used for
/// speaker playback causes DesktopCapturer (video) to fail. Replaced by process loopback.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn setup_screen_share_audio_device_loopback() -> (Option<LocalAudioTrack>, Option<cpal::Stream>) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use livekit::webrtc::{
        audio_frame::AudioFrame,
        audio_source::native::NativeAudioSource,
        prelude::{AudioSourceOptions, RtcAudioSource},
    };
    use tokio::sync::mpsc;

    const NUM_CHANNELS: u32 = 1;

    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => return (None, None),
    };
    let config = match device.default_output_config() {
        Ok(c) => c,
        Err(_) => return (None, None),
    };
    let stream_config: cpal::StreamConfig = config.config().into();

    let sample_rate = stream_config.sample_rate.0;
    let channels = stream_config.channels as usize;
    let samples_per_channel = (sample_rate / 100) as usize; // 10ms frames

    let audio_source = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        },
        sample_rate,
        NUM_CHANNELS,
        100,
    );

    let (frame_tx, mut frame_rx) = mpsc::channel::<Vec<i16>>(10);
    let frame_buf: Arc<parking_lot::Mutex<Vec<i16>>> =
        Arc::new(parking_lot::Mutex::new(Vec::with_capacity(samples_per_channel * 2)));

    let stream_result = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut buf = frame_buf.lock();
                for frame in data.chunks(channels) {
                    let sample = frame[0].clamp(-1.0, 1.0);
                    buf.push((sample * 32767.0) as i16);
                }
                while buf.len() >= samples_per_channel {
                    let samples: Vec<i16> = buf.drain(..samples_per_channel).collect();
                    let _ = frame_tx.try_send(samples);
                }
            },
            |e| eprintln!("[Pax] Screen share loopback error: {}", e),
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let mut buf = frame_buf.lock();
                for frame in data.chunks(channels) {
                    buf.push(frame[0]);
                }
                while buf.len() >= samples_per_channel {
                    let samples: Vec<i16> = buf.drain(..samples_per_channel).collect();
                    let _ = frame_tx.try_send(samples);
                }
            },
            |e| eprintln!("[Pax] Screen share loopback error: {}", e),
            None,
        ),
        _ => return (None, None),
    };
    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Pax] Screen share loopback: {}", e);
            return (None, None);
        }
    };

    if stream.play().is_err() {
        eprintln!("[Pax] Screen share loopback: failed to play");
        return (None, None);
    }

    let audio_source_clone = audio_source.clone();
    tokio::spawn(async move {
        while let Some(samples) = frame_rx.recv().await {
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate,
                num_channels: NUM_CHANNELS,
                samples_per_channel: samples_per_channel as u32,
            };
            if let Err(e) = audio_source_clone.capture_frame(&frame).await {
                eprintln!("[Pax] Screen share audio capture: {}", e);
            }
        }
    });

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    eprintln!("[Pax] Screen share audio (loopback) enabled");
    (Some(track), Some(stream))
}

#[cfg(not(target_os = "windows"))]
fn setup_screen_share_audio() -> (Option<LocalAudioTrack>, Option<cpal::Stream>) {
    (None, None)
}

/// Enumerate capturable windows (Windows only). Returns (title, process_name) for each.
#[cfg(target_os = "windows")]
pub fn enumerate_screen_share_windows() -> Result<Vec<(String, String)>, String> {
    use windows_capture::window::Window;

    eprintln!("[Pax] enumerate_screen_share_windows");
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
    eprintln!("[Pax] Found {} capturable windows", out.len());
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
pub fn enumerate_screen_share_windows() -> Result<Vec<(String, String)>, String> {
    Ok(vec![])
}

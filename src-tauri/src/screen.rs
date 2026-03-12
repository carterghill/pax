//! Screen capture for LiveKit screen sharing.
//!
//! Uses libwebrtc DesktopCapturer on Windows/macOS/Linux. Converts frames to I420
//! and feeds them into a NativeVideoSource for publishing to LiveKit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livekit::track::LocalVideoTrack;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};

/// Screen share mode: entire screen or a specific window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareMode {
    Screen,
    Window,
}

/// Handle for an active screen share. Holds the track and signals the capture thread
/// to stop when dropped.
pub struct ScreenShareHandle {
    pub track: LocalVideoTrack,
    _shutdown: Arc<AtomicBool>,
}

impl Drop for ScreenShareHandle {
    fn drop(&mut self) {
        self._shutdown.store(true, Ordering::Relaxed);
    }
}

/// Target resolution for screen share (scaled down for bandwidth).
const TARGET_WIDTH: u32 = 1280;
const TARGET_HEIGHT: u32 = 720;

/// Start screen sharing and return a handle containing the track.
/// The caller is responsible for unpublishing when done. Dropping the handle
/// stops the capture thread.
pub async fn start_screen_capture(
    _room: Arc<livekit::Room>,
    mode: ScreenShareMode,
) -> Result<ScreenShareHandle, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
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

        let mut options = DesktopCapturerOptions::new(source_type);
        options.set_include_cursor(true);

        let mut capturer = DesktopCapturer::new(options)
            .ok_or("Failed to create desktop capturer (permissions or platform limitation)")?;

        let sources = capturer.get_source_list();
        let source: Option<CaptureSource> = sources.into_iter().next();

        let resolution = VideoResolution {
            width: TARGET_WIDTH,
            height: TARGET_HEIGHT,
        };
        let video_source = NativeVideoSource::new(resolution, true);
        let video_source_clone = video_source.clone();

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_cap = shutdown.clone();
        let shutdown_thread = shutdown.clone();

        capturer.start_capture(source, move |result: Result<DesktopFrame, _>| {
            if shutdown_cap.load(Ordering::Relaxed) {
                return;
            }
            let frame = match result {
                Ok(f) => f,
                Err(_) => return,
            };
            let w = frame.width();
            let h = frame.height();
            if w <= 0 || h <= 0 {
                return;
            }
            let stride = frame.stride();
            let data = frame.data();

            // Convert at source resolution first (argb_to_i420 expects matching dimensions)
            let mut i420 = I420Buffer::new(w as u32, h as u32);
            let (dst_y, dst_u, dst_v) = i420.data_mut();
            let stride_y = w;
            let stride_u = (w + 1) / 2;
            let stride_v = (w + 1) / 2;

            // DesktopFrame is typically BGRA on Windows; libyuv ARGB = BGRA in memory
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

            // Scale down to target resolution for bandwidth
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

        let track = LocalVideoTrack::create_video_track(
            "screenshare",
            RtcVideoSource::Native(video_source),
        );

        thread::spawn(move || {
            let mut cap = capturer;
            while !shutdown_thread.load(Ordering::Relaxed) {
                cap.capture_frame();
                thread::sleep(Duration::from_millis(100)); // ~10 fps
            }
        });

        Ok(ScreenShareHandle {
            track,
            _shutdown: shutdown,
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (_room, mode);
        Err("Screen sharing is not supported on this platform".to_string())
    }
}

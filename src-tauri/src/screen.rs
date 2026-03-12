//! Screen capture for LiveKit screen sharing.
//!
//! Uses libwebrtc DesktopCapturer on Windows/macOS/Linux. Converts frames to I420
//! and feeds them into a NativeVideoSource for publishing to LiveKit.
//!
//! On Windows, also captures system audio (WASAPI loopback) via cpal and publishes
//! it as a screen-share audio track.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livekit::track::{LocalAudioTrack, LocalVideoTrack};
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};

/// Screen share mode: entire screen or a specific window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareMode {
    Screen,
    Window,
}

/// Wrapper so cpal::Stream can be stored in ScreenShareHandle (which must be Send).
struct SendStream(cpal::Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

/// Handle for an active screen share. Holds video and optional audio tracks.
/// Dropping stops the capture thread and loopback stream.
pub struct ScreenShareHandle {
    pub track: LocalVideoTrack,
    /// Screen share audio track (system audio), if loopback capture succeeded.
    pub audio_track: Option<LocalAudioTrack>,
    /// Keeps loopback stream alive; dropped when handle is dropped.
    _loopback_stream: Option<SendStream>,
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

        // Retry: DXGI/DesktopCapturer can fail transiently after a previous session
        let mut capturer_opt = None;
        for attempt in 0..3 {
            let mut options = DesktopCapturerOptions::new(source_type);
            options.set_include_cursor(true);
            capturer_opt = DesktopCapturer::new(options);
            if capturer_opt.is_some() {
                break;
            }
            if attempt < 2 {
                let delay_ms = if attempt == 0 { 1000 } else { 500 };
                log::warn!("[Pax] Screen capture: DesktopCapturer::new failed (attempt {}), retrying in {}ms", attempt + 1, delay_ms);
                thread::sleep(Duration::from_millis(delay_ms));
            }
        }
        // If libwebrtc DesktopCapturer fails, try screenshots crate fallback (Screen mode only)
        let mut capturer = match capturer_opt {
            Some(c) => c,
            None => {
                if mode == ScreenShareMode::Screen {
                    return start_screen_capture_screenshots_fallback(_room).await;
                }
                return Err("Failed to create desktop capturer. Try selecting \"Entire screen\" instead of a window.".to_string());
            }
        };
        let sources = capturer.get_source_list();
        let source: Option<CaptureSource> = sources.into_iter().next();
        if source.is_none() {
            log::warn!("[Pax] Screen capture: get_source_list returned empty, trying without explicit source");
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
                    log::warn!("[Pax] Screen capture frame error: {:?}", e);
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

        // Screen share audio disabled: WASAPI process loopback conflicts with DesktopCapturer's
        // DXGI capture — video fails when audio is enabled. See setup_screen_share_audio_process_loopback.
        let (audio_track, loopback_stream) = (None, None);

        Ok(ScreenShareHandle {
            track,
            audio_track,
            _loopback_stream: loopback_stream.map(SendStream),
            _shutdown: shutdown,
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (_room, mode);
        Err("Screen sharing is not supported on this platform".to_string())
    }
}

/// Fallback screen capture using the screenshots crate when libwebrtc DesktopCapturer fails.
/// Uses GDI/other APIs instead of DXGI; no system audio.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn start_screen_capture_screenshots_fallback(
    _room: Arc<livekit::Room>,
) -> Result<ScreenShareHandle, String> {
    use livekit::webrtc::video_source::native::NativeVideoSource;

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

    thread::spawn(move || {
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
                    rgba_to_i420(raw, stride as u32, w, h, dst_y, dst_u, dst_v);

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
                    log::warn!("[Pax] screenshots capture: {}", e);
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
    });

    let track = LocalVideoTrack::create_video_track(
        "screenshare",
        RtcVideoSource::Native(video_source),
    );

    // Screen share audio disabled on Windows: process loopback conflicts with video capture
    let (audio_track, loopback_stream) = (None, None);

    Ok(ScreenShareHandle {
        track,
        audio_track,
        _loopback_stream: loopback_stream.map(SendStream),
        _shutdown: shutdown,
    })
}

/// Convert RGBA (R,G,B,A per pixel) to I420. Strides for dst are standard I420.
fn rgba_to_i420(
    src: &[u8],
    src_stride: u32,
    width: i32,
    height: i32,
    dst_y: &mut [u8],
    dst_u: &mut [u8],
    dst_v: &mut [u8],
) {
    let w = width as usize;
    let h = height as usize;
    let stride = src_stride as usize;
    let chroma_w = (w + 1) / 2;
    let chroma_h = (h + 1) / 2;

    for y in 0..h {
        for x in 0..w {
            let i = y * stride + x * 4;
            let r = src[i] as f32;
            let g = src[i + 1] as f32;
            let b = src[i + 2] as f32;
            let y_val = (0.299 * r + 0.587 * g + 0.114 * b).clamp(0.0, 255.0) as u8;
            dst_y[y * w + x] = y_val;
        }
    }
    for y in 0..chroma_h {
        for x in 0..chroma_w {
            let sx = x * 2;
            let sy = y * 2;
            let i = (sy * stride + sx * 4).min(src.len().saturating_sub(4));
            let r = src.get(i).copied().unwrap_or(0) as f32;
            let g = src.get(i + 1).copied().unwrap_or(0) as f32;
            let b = src.get(i + 2).copied().unwrap_or(0) as f32;
            let u_val = (-0.169 * r - 0.331 * g + 0.5 * b + 128.0).clamp(0.0, 255.0) as u8;
            let v_val = (0.5 * r - 0.419 * g - 0.081 * b + 128.0).clamp(0.0, 255.0) as u8;
            dst_u[y * chroma_w + x] = u_val;
            dst_v[y * chroma_w + x] = v_val;
        }
    }
}

/// Set up system audio capture via Windows process loopback (WASAPI).
/// Uses EXCLUDE mode: captures all system audio except Pax's own output.
/// DISABLED: Conflicts with DesktopCapturer's DXGI — video capture fails when this runs.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn setup_screen_share_audio_process_loopback(
    _mode: ScreenShareMode,
    shutdown: Arc<AtomicBool>,
) -> (Option<LocalAudioTrack>, Option<cpal::Stream>) {
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

    // Screen mode: EXCLUDE Pax (include_tree=false) → full system audio except Pax
    let process_id = std::process::id();
    let include_tree = false; // EXCLUDE mode: capture all except process tree

    // Defer COM init: wasapi::initialize_mta() can interfere with DesktopCapturer's DXGI.
    // Give video capture time to establish before touching COM.
    const AUDIO_DEFER_MS: u64 = 2000;

    let shutdown_cap = shutdown.clone();
    let capture_thread = std::thread::Builder::new()
        .name("screen-audio-capture".into())
        .spawn(move || {
            thread::sleep(Duration::from_millis(AUDIO_DEFER_MS));
            if shutdown_cap.load(Ordering::Relaxed) {
                return;
            }
            if wasapi::initialize_mta().is_err() {
                log::warn!("[Pax] Screen share process loopback: COM init failed");
                return;
            }
            let mut audio_client = match AudioClient::new_application_loopback_client(
                process_id,
                include_tree,
            ) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[Pax] Screen share process loopback: {}", e);
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
                log::warn!("[Pax] Screen share process loopback: init failed");
                return;
            }
            let h_event = match audio_client.set_get_eventhandle() {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("[Pax] Screen share process loopback event: {}", e);
                    return;
                }
            };
            let capture_client = match audio_client.get_audiocaptureclient() {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[Pax] Screen share process loopback capture client: {}", e);
                    return;
                }
            };
            if audio_client.start_stream().is_err() {
                log::warn!("[Pax] Screen share process loopback: start failed");
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
        });

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
                log::error!("[Pax] Screen share audio capture: {}", e);
            }
        }
    });

    // Keep capture thread alive (it will exit when shutdown is set)
    std::mem::forget(capture_thread);

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    log::info!("[Pax] Screen share audio (process loopback) enabled");
    (Some(track), None)
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
            |e| log::error!("[Pax] Screen share loopback error: {}", e),
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
            |e| log::error!("[Pax] Screen share loopback error: {}", e),
            None,
        ),
        _ => return (None, None),
    };
    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[Pax] Screen share loopback: {}", e);
            return (None, None);
        }
    };

    if stream.play().is_err() {
        log::warn!("[Pax] Screen share loopback: failed to play");
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
                log::error!("[Pax] Screen share audio capture: {}", e);
            }
        }
    });

    let track = LocalAudioTrack::create_audio_track(
        "screenshare-audio",
        RtcAudioSource::Native(audio_source),
    );

    log::info!("[Pax] Screen share audio (loopback) enabled");
    (Some(track), Some(stream))
}

#[cfg(not(target_os = "windows"))]
fn setup_screen_share_audio() -> (Option<LocalAudioTrack>, Option<cpal::Stream>) {
    (None, None)
}

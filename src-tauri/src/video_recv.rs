//! Screen share video reception pipeline.
//!
//! Receives decoded video frames from LiveKit's NativeVideoStream,
//! converts I420 (YUV420p) → RGBA via SIMD-optimized libyuv, and stores
//! the raw pixel buffer. The Tauri URI scheme protocol handler serves
//! the raw RGBA bytes to the webview on demand.
//!
//! No JPEG encoding — the frontend uses putImageData() to draw raw pixels
//! directly onto a canvas. This gives ~1ms per frame instead of ~50ms.
//!
//! Cross-platform (Linux + Windows) — libyuv handles the conversion.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use livekit::track::RemoteVideoTrack;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::webrtc::prelude::VideoBuffer; // Required for .width() and .height()
use once_cell::sync::Lazy;
use parking_lot::Mutex;

// ─── Global frame buffer ────────────────────────────────────────────────────

/// The latest screen share frame as raw RGBA pixels.
pub struct ScreenShareFrame {
    /// Raw RGBA pixel data (4 bytes per pixel, row-major)
    pub rgba_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub frame_number: u64,
}

pub static SCREEN_SHARE_FRAME: Lazy<Arc<Mutex<Option<ScreenShareFrame>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

pub static SCREEN_SHARE_RECEIVING: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

// ─── Video receive task ─────────────────────────────────────────────────────

/// Spawn a background task that consumes video frames from a remote
/// screen-share track, converts to RGBA, and stores the latest frame.
///
/// The task runs until the track ends or `shutdown` is set to `true`.
pub fn spawn_video_receiver(
    video_track: RemoteVideoTrack,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        SCREEN_SHARE_RECEIVING.store(true, Ordering::Relaxed);
        eprintln!("[Pax VideoRecv] Task started");

        let rtc_track = video_track.rtc_track();
        let mut stream = NativeVideoStream::new(rtc_track);
        let mut frame_number: u64 = 0;

        loop {
            // 1. Wait for at least one frame
            let first = stream.next().await;
            let Some(mut latest_frame) = first else {
                eprintln!("[Pax VideoRecv] Stream ended");
                break;
            };

            if shutdown.load(Ordering::Relaxed) {
                eprintln!("[Pax VideoRecv] Shutdown requested");
                break;
            }

            // 2. Drain all buffered frames, keeping ONLY the newest.
            loop {
                match futures_util::FutureExt::now_or_never(stream.next()) {
                    Some(Some(newer_frame)) => {
                        latest_frame = newer_frame;
                    }
                    _ => break,
                }
            }

            // 3. Convert I420 → RGBA via SIMD-optimized libyuv (~1ms for 1080p)
            let i420 = latest_frame.buffer.to_i420();
            let width = i420.width();
            let height = i420.height();

            if width == 0 || height == 0 {
                continue;
            }

            let (data_y, data_u, data_v) = i420.data();
            let (stride_y, stride_u, stride_v) = i420.strides();
            let dst_stride = width * 4;
            let mut rgba = vec![0u8; (dst_stride * height) as usize];

            // libyuv naming: i420_to_abgr produces [R,G,B,A] byte order in memory.
            libwebrtc::native::yuv_helper::i420_to_abgr(
                data_y, stride_y,
                data_u, stride_u,
                data_v, stride_v,
                &mut rgba, dst_stride,
                width as i32, height as i32,
            );

            frame_number += 1;

            // 4. Store raw RGBA (overwrite previous — latest-only buffer).
            {
                let mut guard = SCREEN_SHARE_FRAME.lock();
                *guard = Some(ScreenShareFrame {
                    rgba_data: rgba,
                    width,
                    height,
                    frame_number,
                });
            }
        }

        // Track ended — clean up.
        {
            let mut guard = SCREEN_SHARE_FRAME.lock();
            *guard = None;
        }
        SCREEN_SHARE_RECEIVING.store(false, Ordering::Relaxed);
        eprintln!("[Pax VideoRecv] Exited");
    });
}

/// Clear the global frame buffer.
pub fn clear_frame_buffer() {
    let mut guard = SCREEN_SHARE_FRAME.lock();
    *guard = None;
    SCREEN_SHARE_RECEIVING.store(false, Ordering::Relaxed);
}

// ─── URI scheme protocol handler ────────────────────────────────────────────

/// Binary frame format served to the webview:
///   Bytes 0..4:   width  (u32, little-endian)
///   Bytes 4..8:   height (u32, little-endian)
///   Bytes 8..:    raw RGBA pixel data (width * height * 4 bytes)
///
/// URL paths:
///   /frame   — binary frame as above (application/octet-stream)
///   /status  — JSON { receiving, frameNumber, width, height }
pub fn handle_protocol_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();

    if path == "/status" || path.is_empty() || path == "/" {
        let guard = SCREEN_SHARE_FRAME.lock();
        let receiving = SCREEN_SHARE_RECEIVING.load(Ordering::Relaxed);
        let (frame_number, width, height) = guard
            .as_ref()
            .map(|f| (f.frame_number, f.width, f.height))
            .unwrap_or((0, 0, 0));
        let json = format!(
            r#"{{"receiving":{},"frameNumber":{},"width":{},"height":{}}}"#,
            receiving, frame_number, width, height,
        );
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .header("cache-control", "no-cache, no-store, must-revalidate")
            .header("access-control-allow-origin", "*")
            .body(json.into_bytes())
            .unwrap_or_else(|_| {
                tauri::http::Response::builder()
                    .status(500)
                    .body(b"Internal error".to_vec())
                    .unwrap()
            });
    }

    if path == "/frame" {
        let guard = SCREEN_SHARE_FRAME.lock();
        if let Some(frame) = guard.as_ref() {
            // Build binary response: 8-byte header + raw RGBA
            let header_size = 8;
            let pixel_size = frame.rgba_data.len();
            let mut body = Vec::with_capacity(header_size + pixel_size);
            body.extend_from_slice(&frame.width.to_le_bytes());
            body.extend_from_slice(&frame.height.to_le_bytes());
            body.extend_from_slice(&frame.rgba_data);

            return tauri::http::Response::builder()
                .status(200)
                .header("content-type", "application/octet-stream")
                .header("cache-control", "no-cache, no-store, must-revalidate")
                .header("access-control-allow-origin", "*")
                .body(body)
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(b"Internal error".to_vec())
                        .unwrap()
                });
        } else {
            return tauri::http::Response::builder()
                .status(204)
                .header("cache-control", "no-cache, no-store, must-revalidate")
                .header("access-control-allow-origin", "*")
                .body(Vec::new())
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(b"Internal error".to_vec())
                        .unwrap()
                });
        }
    }

    tauri::http::Response::builder()
        .status(404)
        .body(b"Not found".to_vec())
        .unwrap()
}
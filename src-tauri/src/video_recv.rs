//! Screen share video reception pipeline.
//!
//! Receives decoded video frames from LiveKit's NativeVideoStream,
//! converts I420 (YUV420p) → RGBA → JPEG, and stores the latest frame
//! in a global buffer. The Tauri URI scheme protocol handler serves
//! the latest JPEG frame to the webview on demand.
//!
//! This module is fully cross-platform (Linux + Windows) — all conversion
//! and encoding is pure Rust with no system dependencies.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use livekit::track::RemoteVideoTrack;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::webrtc::prelude::VideoBuffer; // Required for .width() and .height()
use once_cell::sync::Lazy;
use parking_lot::Mutex;

// ─── Global frame buffer ────────────────────────────────────────────────────
/// The latest screen share JPEG frame, ready to be served to the webview.
/// `None` means no screen share is active (or no frames received yet).
pub struct ScreenShareFrame {
    pub jpeg_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Monotonically increasing frame counter; the frontend uses this to
    /// detect when a new frame is available (avoids re-drawing stale data).
    pub frame_number: u64,
}

pub static SCREEN_SHARE_FRAME: Lazy<Arc<Mutex<Option<ScreenShareFrame>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Sentinel: set to `true` when the current screen share video receiver is
/// active. Reset to `false` when it exits. Used by the frontend to know
/// whether to poll.
pub static SCREEN_SHARE_RECEIVING: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

// ─── Video receive task ─────────────────────────────────────────────────────

/// Spawn a background task that consumes video frames from a remote
/// screen-share track, converts to JPEG, and stores the latest frame.
///
/// The task runs until the track ends or `shutdown` is set to `true`.
/// When it exits, the global frame buffer is cleared.
pub fn spawn_video_receiver(
    video_track: RemoteVideoTrack,
    shutdown: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        SCREEN_SHARE_RECEIVING.store(true, Ordering::Relaxed);
        eprintln!("[Pax VideoRecv] Task started, creating NativeVideoStream...");

        let rtc_track = video_track.rtc_track();
        let mut stream = NativeVideoStream::new(rtc_track);
        eprintln!("[Pax VideoRecv] NativeVideoStream created, waiting for frames...");
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
            //    This is the key to staying current — if encoding took 50ms
            //    and 2 more frames arrived, we skip them and show the latest.
            let mut drained = 0u32;
            loop {
                match futures_util::FutureExt::now_or_never(stream.next()) {
                    Some(Some(newer_frame)) => {
                        latest_frame = newer_frame;
                        drained += 1;
                    }
                    _ => break,
                }
            }
            if drained > 0 && frame_number < 5 {
                eprintln!("[Pax VideoRecv] Drained {} stale frames", drained);
            }

            // 3. Convert I420 → RGBA (SIMD-fast, ~1ms)
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

            // NOTE: libyuv naming is counterintuitive — i420_to_abgr produces
            // actual [R,G,B,A] byte order in memory (what everyone else calls RGBA).
            libwebrtc::native::yuv_helper::i420_to_abgr(
                data_y, stride_y,
                data_u, stride_u,
                data_v, stride_v,
                &mut rgba, dst_stride,
                width as i32, height as i32,
            );

            // 4. JPEG encode on a blocking thread so we don't stall the tokio runtime.
            let jpeg = tokio::task::spawn_blocking(move || {
                encode_jpeg(&rgba, width, height)
            })
            .await
            .ok()
            .flatten();

            let Some(jpeg) = jpeg else { continue; };

            frame_number += 1;

            // 5. Store the latest frame (overwrite any previous one).
            {
                let mut guard = SCREEN_SHARE_FRAME.lock();
                *guard = Some(ScreenShareFrame {
                    jpeg_data: jpeg,
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
        log::info!("[Pax] Screen share video receiver exited");
    });
}

/// Clear the global frame buffer (called when screen share ends or
/// participant disconnects).
pub fn clear_frame_buffer() {
    let mut guard = SCREEN_SHARE_FRAME.lock();
    *guard = None;
    SCREEN_SHARE_RECEIVING.store(false, Ordering::Relaxed);
}

// ─── JPEG encoding ──────────────────────────────────────────────────────────

/// Encode RGBA pixel data to JPEG.  Returns `None` on encoding failure.
/// JPEG doesn't support alpha, so we strip RGBA → RGB before encoding.
fn encode_jpeg(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    // Strip alpha channel: RGBA → RGB (JPEG has no alpha support)
    let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|px| &px[..3]).copied().collect();

    let mut buf = Vec::with_capacity(64 * 1024); // pre-alloc ~64KB
    let mut cursor = std::io::Cursor::new(&mut buf);

    // Quality 50 is a good balance: ~30–50KB per 1080p frame,
    // visually fine for screen text, and fast to encode.
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 50);
    match encoder.encode(&rgb, width, height, image::ExtendedColorType::Rgb8) {
        Ok(()) => Some(buf),
        Err(e) => {
            eprintln!("[Pax VideoRecv] JPEG encode error: {}", e);
            None
        }
    }
}

// ─── URI scheme protocol handler ────────────────────────────────────────────

/// Build an HTTP response containing the latest screen share JPEG frame.
/// Called by the Tauri URI scheme protocol handler registered in lib.rs.
///
/// URL paths:
///   /frame        — latest JPEG frame (image/jpeg)
///   /status       — JSON with { receiving, frameNumber, width, height }
pub fn handle_protocol_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();

    if path == "/status" || path.is_empty() || path == "/" {
        // Return status as JSON
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
            return tauri::http::Response::builder()
                .status(200)
                .header("content-type", "image/jpeg")
                .header("cache-control", "no-cache, no-store, must-revalidate")
                .header("access-control-allow-origin", "*")
                .header("x-frame-number", frame.frame_number.to_string())
                .header("x-frame-width", frame.width.to_string())
                .header("x-frame-height", frame.height.to_string())
                .body(frame.jpeg_data.clone())
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(b"Internal error".to_vec())
                        .unwrap()
                });
        } else {
            // No frame available — return 204 No Content
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

    // Unknown path
    tauri::http::Response::builder()
        .status(404)
        .body(b"Not found".to_vec())
        .unwrap()
}
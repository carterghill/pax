//! Screen share video reception pipeline.
//!
//! Receives decoded video frames from LiveKit's NativeVideoStream,
//! optionally downscales via libyuv, converts I420 → RGBA, and stores
//! the raw pixel buffer. The frontend communicates its viewport size
//! so we only produce pixels at the resolution actually displayed.
//!
//! Cross-platform (Linux + Windows) — libyuv handles scaling + conversion.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use livekit::track::RemoteVideoTrack;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::webrtc::prelude::VideoBuffer;
use once_cell::sync::Lazy;
use parking_lot::Mutex;

// ─── Global state ───────────────────────────────────────────────────────────

pub struct ScreenShareFrame {
    pub rgba_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub frame_number: u64,
}

pub static SCREEN_SHARE_FRAME: Lazy<Arc<Mutex<Option<ScreenShareFrame>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

pub static SCREEN_SHARE_RECEIVING: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// Target viewport dimensions set by the frontend.
/// (0, 0) = use native resolution (no downscale).
static TARGET_WIDTH: AtomicU32 = AtomicU32::new(0);
static TARGET_HEIGHT: AtomicU32 = AtomicU32::new(0);

// ─── Video receive task ─────────────────────────────────────────────────────

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
            let first = stream.next().await;
            let Some(mut latest_frame) = first else {
                eprintln!("[Pax VideoRecv] Stream ended");
                break;
            };

            if shutdown.load(Ordering::Relaxed) {
                eprintln!("[Pax VideoRecv] Shutdown requested");
                break;
            }

            // Drain to latest
            loop {
                match futures_util::FutureExt::now_or_never(stream.next()) {
                    Some(Some(newer)) => { latest_frame = newer; }
                    _ => break,
                }
            }

            let mut i420 = latest_frame.buffer.to_i420();
            let src_w = i420.width();
            let src_h = i420.height();

            if src_w == 0 || src_h == 0 {
                continue;
            }

            // Read the target viewport size set by the frontend
            let tgt_w = TARGET_WIDTH.load(Ordering::Relaxed);
            let tgt_h = TARGET_HEIGHT.load(Ordering::Relaxed);

            // Compute scaled dimensions (fit within target, preserve aspect ratio)
            let (out_w, out_h) = if tgt_w > 0 && tgt_h > 0 && (tgt_w < src_w || tgt_h < src_h) {
                fit_dimensions(src_w, src_h, tgt_w, tgt_h)
            } else {
                (src_w, src_h)
            };

            // Downscale I420 if needed (libyuv SIMD — very fast, ~0.5ms for 1080p→540p)
            let final_i420 = if out_w != src_w || out_h != src_h {
                i420.scale(out_w as i32, out_h as i32)
            } else {
                i420
            };

            // I420 → RGBA
            let (data_y, data_u, data_v) = final_i420.data();
            let (stride_y, stride_u, stride_v) = final_i420.strides();
            let w = final_i420.width();
            let h = final_i420.height();
            let dst_stride = w * 4;
            let mut rgba = vec![0u8; (dst_stride * h) as usize];

            libwebrtc::native::yuv_helper::i420_to_abgr(
                data_y, stride_y,
                data_u, stride_u,
                data_v, stride_v,
                &mut rgba, dst_stride,
                w as i32, h as i32,
            );

            frame_number += 1;

            {
                let mut guard = SCREEN_SHARE_FRAME.lock();
                *guard = Some(ScreenShareFrame {
                    rgba_data: rgba,
                    width: w,
                    height: h,
                    frame_number,
                });
            }
        }

        {
            let mut guard = SCREEN_SHARE_FRAME.lock();
            *guard = None;
        }
        SCREEN_SHARE_RECEIVING.store(false, Ordering::Relaxed);
        eprintln!("[Pax VideoRecv] Exited");
    });
}

/// Compute output dimensions that fit within `max_w × max_h`
/// while preserving the source aspect ratio.
/// Ensures dimensions are even (required by I420 chroma subsampling).
fn fit_dimensions(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let scale_x = max_w as f64 / src_w as f64;
    let scale_y = max_h as f64 / src_h as f64;
    let scale = scale_x.min(scale_y).min(1.0); // never upscale

    let mut w = (src_w as f64 * scale).round() as u32;
    let mut h = (src_h as f64 * scale).round() as u32;

    // I420 requires even dimensions
    w = (w / 2) * 2;
    h = (h / 2) * 2;

    // Floor to at least 2×2
    w = w.max(2);
    h = h.max(2);

    (w, h)
}

pub fn clear_frame_buffer() {
    let mut guard = SCREEN_SHARE_FRAME.lock();
    *guard = None;
    SCREEN_SHARE_RECEIVING.store(false, Ordering::Relaxed);
}

// ─── URI scheme protocol handler ────────────────────────────────────────────

/// URL paths:
///   /frame          — binary: u32le width + u32le height + RGBA pixels
///   /resize?w=&h=   — set target viewport (returns 204)
///   /status         — JSON status
pub fn handle_protocol_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let path = request.uri().path();

    // ── /resize?w=X&h=Y ────────────────────────────────────────────────
    if path == "/resize" {
        let w = parse_query_param(&uri, "w").unwrap_or(0);
        let h = parse_query_param(&uri, "h").unwrap_or(0);
        TARGET_WIDTH.store(w, Ordering::Relaxed);
        TARGET_HEIGHT.store(h, Ordering::Relaxed);
        return tauri::http::Response::builder()
            .status(204)
            .header("access-control-allow-origin", "*")
            .body(Vec::new())
            .unwrap();
    }

    // ── /status ─────────────────────────────────────────────────────────
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

    // ── /frame ──────────────────────────────────────────────────────────
    if path == "/frame" {
        let guard = SCREEN_SHARE_FRAME.lock();
        if let Some(frame) = guard.as_ref() {
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
                .header("access-control-allow-origin", "*")
                .body(Vec::new())
                .unwrap();
        }
    }

    tauri::http::Response::builder()
        .status(404)
        .body(b"Not found".to_vec())
        .unwrap()
}

/// Parse a u32 query parameter from a URI string.
fn parse_query_param(uri: &str, key: &str) -> Option<u32> {
    let query = uri.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == key {
            return kv.next()?.parse().ok();
        }
    }
    None
}
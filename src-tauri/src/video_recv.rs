//! Multi-stream screen share video reception pipeline.
//!
//! Supports multiple concurrent screen share streams, keyed by participant
//! identity. Each stream has its own receive task, frame buffer, and
//! target resolution. The frontend fetches frames per-identity via
//! /frame?id=<identity> and reports viewport size per-identity via
//! /resize?id=<identity>&w=X&h=Y.
//!
//! Cross-platform (Linux + Windows) — libyuv handles scaling + conversion.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use livekit::track::RemoteVideoTrack;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::webrtc::prelude::VideoBuffer;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ─── Frame-ready event emitted to frontend ──────────────────────────────────
#[derive(Clone, Serialize)]
pub struct FrameReadyEvent {
    pub id: String,
}

// ─── Global state (all keyed by participant identity) ───────────────────────

pub struct ScreenShareFrame {
    pub rgba_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub frame_number: u64,
}

/// Per-identity frame buffers. Each active screen share has its own entry.
pub static FRAMES: Lazy<Arc<Mutex<HashMap<String, ScreenShareFrame>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Per-identity "receiving" flags.
pub static RECEIVING: Lazy<Arc<Mutex<HashMap<String, bool>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Per-identity target viewport dimensions (w, h). (0,0) = native resolution.
pub static TARGETS: Lazy<Arc<Mutex<HashMap<String, (u32, u32)>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

// ─── Video receive task ─────────────────────────────────────────────────────

/// Spawn a background task for one participant's screen share stream.
pub fn spawn_video_receiver(
    identity: String,
    video_track: RemoteVideoTrack,
    shutdown: Arc<AtomicBool>,
    app_handle: AppHandle,
) {
    let id = identity.clone();
    tokio::spawn(async move {
        {
            let mut recv = RECEIVING.lock();
            recv.insert(id.clone(), true);
        }
        eprintln!("[Pax VideoRecv] Task started for '{}'", id);

        let rtc_track = video_track.rtc_track();
        let mut stream = NativeVideoStream::new(rtc_track);
        let mut frame_number: u64 = 0;

        loop {
            let first = stream.next().await;
            let Some(mut latest_frame) = first else {
                eprintln!("[Pax VideoRecv] Stream ended for '{}'", id);
                break;
            };

            if shutdown.load(Ordering::Relaxed) {
                eprintln!("[Pax VideoRecv] Shutdown for '{}'", id);
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

            // Read this stream's target viewport
            let (tgt_w, tgt_h) = {
                let targets = TARGETS.lock();
                targets.get(&id).copied().unwrap_or((0, 0))
            };

            let (out_w, out_h) = if tgt_w > 0 && tgt_h > 0 && (tgt_w < src_w || tgt_h < src_h) {
                fit_dimensions(src_w, src_h, tgt_w, tgt_h)
            } else {
                (src_w, src_h)
            };

            let final_i420 = if out_w != src_w || out_h != src_h {
                i420.scale(out_w as i32, out_h as i32)
            } else {
                i420
            };

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
                let mut frames = FRAMES.lock();
                frames.insert(id.clone(), ScreenShareFrame {
                    rgba_data: rgba,
                    width: w,
                    height: h,
                    frame_number,
                });
            }

            // Notify frontend immediately — no polling delay
            let _ = app_handle.emit("screen-share-frame-ready", FrameReadyEvent {
                id: id.clone(),
            });
        }

        // Clean up this stream's state
        {
            let mut frames = FRAMES.lock();
            frames.remove(&id);
        }
        {
            let mut recv = RECEIVING.lock();
            recv.remove(&id);
        }
        {
            let mut targets = TARGETS.lock();
            targets.remove(&id);
        }
        eprintln!("[Pax VideoRecv] Exited for '{}'", id);
    });
}

fn fit_dimensions(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let scale_x = max_w as f64 / src_w as f64;
    let scale_y = max_h as f64 / src_h as f64;
    let scale = scale_x.min(scale_y).min(1.0);

    let mut w = (src_w as f64 * scale).round() as u32;
    let mut h = (src_h as f64 * scale).round() as u32;

    w = (w / 2) * 2;
    h = (h / 2) * 2;
    w = w.max(2);
    h = h.max(2);

    (w, h)
}

/// Clear one identity's frame buffer.
pub fn clear_frame_buffer_for(identity: &str) {
    FRAMES.lock().remove(identity);
    RECEIVING.lock().remove(identity);
    TARGETS.lock().remove(identity);
}

/// Clear all frame buffers (used on voice disconnect).
pub fn clear_all_frame_buffers() {
    FRAMES.lock().clear();
    RECEIVING.lock().clear();
    TARGETS.lock().clear();
}

// ─── URI scheme protocol handler ────────────────────────────────────────────

/// URL paths:
///   /frame?id=X          — binary frame for identity X
///   /resize?id=X&w=Y&h=Z — set target viewport for identity X
///   /status              — JSON { streams: [{ id, receiving, frameNumber, width, height }] }
pub fn handle_protocol_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let path = request.uri().path();

    // ── /resize?id=X&w=Y&h=Z ───────────────────────────────────────────
    if path == "/resize" {
        let id = parse_query_param_str(&uri, "id").unwrap_or_default();
        let w = parse_query_param_u32(&uri, "w").unwrap_or(0);
        let h = parse_query_param_u32(&uri, "h").unwrap_or(0);
        if !id.is_empty() {
            let mut targets = TARGETS.lock();
            if w == 0 && h == 0 {
                targets.remove(&id);
            } else {
                targets.insert(id, (w, h));
            }
        }
        return ok_204();
    }

    // ── /status ─────────────────────────────────────────────────────────
    if path == "/status" || path.is_empty() || path == "/" {
        let frames = FRAMES.lock();
        let recv = RECEIVING.lock();

        let mut streams = Vec::new();
        // Include all identities we know about (receiving or with frames)
        let mut all_ids: Vec<String> = recv.keys().cloned().collect();
        for k in frames.keys() {
            if !all_ids.contains(k) {
                all_ids.push(k.clone());
            }
        }
        for id in &all_ids {
            let receiving = recv.get(id).copied().unwrap_or(false);
            let (frame_number, width, height) = frames
                .get(id)
                .map(|f| (f.frame_number, f.width, f.height))
                .unwrap_or((0, 0, 0));
            streams.push(format!(
                r#"{{"id":"{}","receiving":{},"frameNumber":{},"width":{},"height":{}}}"#,
                id.replace('"', "\\\""),
                receiving,
                frame_number,
                width,
                height,
            ));
        }

        let json = format!(r#"{{"streams":[{}]}}"#, streams.join(","));
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .header("cache-control", "no-cache, no-store, must-revalidate")
            .header("access-control-allow-origin", "*")
            .body(json.into_bytes())
            .unwrap_or_else(|_| err_500());
    }

    // ── /frame?id=X ─────────────────────────────────────────────────────
    if path == "/frame" {
        let id = parse_query_param_str(&uri, "id").unwrap_or_default();
        if id.is_empty() {
            return ok_204();
        }

        let frames = FRAMES.lock();
        if let Some(frame) = frames.get(&id) {
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
                .unwrap_or_else(|_| err_500());
        } else {
            return ok_204();
        }
    }

    tauri::http::Response::builder()
        .status(404)
        .body(b"Not found".to_vec())
        .unwrap()
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn ok_204() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(204)
        .header("access-control-allow-origin", "*")
        .body(Vec::new())
        .unwrap()
}

fn err_500() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(500)
        .body(b"Internal error".to_vec())
        .unwrap()
}

/// Parse a u32 query parameter.
fn parse_query_param_u32(uri: &str, key: &str) -> Option<u32> {
    parse_query_param_str(uri, key)?.parse().ok()
}

/// Parse a string query parameter (URL-decoded).
fn parse_query_param_str(uri: &str, key: &str) -> Option<String> {
    let query = uri.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == key {
            let raw = kv.next()?;
            return Some(url_decode(raw));
        }
    }
    None
}

/// Basic percent-decoding for query parameter values.
fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().and_then(|c| hex_val(c));
            let lo = chars.next().and_then(|c| hex_val(c));
            if let (Some(h), Some(l)) = (hi, lo) {
                result.push((h << 4 | l) as char);
            }
        } else if b == b'+' {
            result.push(' ');
        } else {
            result.push(b as char);
        }
    }
    result
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
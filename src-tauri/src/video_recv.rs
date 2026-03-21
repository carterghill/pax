//! Multi-stream screen share video reception pipeline.
//!
//! Each stream runs on its own DEDICATED OS THREAD with a private
//! single-threaded tokio runtime. This eliminates scheduling contention
//! with the main tokio runtime (audio, Matrix sync, presence, etc.)
//! which was causing frame timing jitter regardless of resolution.
//!
//! TWO RENDERING PATHS:
//!
//!   Native GPU (preferred on Windows):
//!     LiveKit decode → I420 → wgpu texture upload → GPU YUV→RGB → native HWND
//!     Zero IPC overhead.  Frames never cross the Rust↔WebView boundary.
//!
//!   Protocol fallback (Linux, or if GPU init fails):
//!     LiveKit decode → I420 → pack into Vec<u8> → paxvideo:// protocol → WebGL
//!     Binary frame format: [u32 w][u32 h][Y plane][U plane][V plane]
//!     Total per frame: 8 + w*h*1.5 bytes (3.1MB for 1080p)

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

#[derive(Clone, Serialize)]
pub struct FrameReadyEvent {
    pub id: String,
}

struct StreamState {
    /// Pre-formatted I420 body. None = already consumed by handler.
    body: Option<Vec<u8>>,
    width: u32,
    height: u32,
    frame_number: u64,
    receiving: bool,
    target: (u32, u32),
}

static STREAMS: Lazy<Mutex<HashMap<String, StreamState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Spawn a video receiver on a **dedicated OS thread** with its own
/// single-threaded tokio runtime. This ensures frame processing never
/// competes with audio, Matrix sync, or any other async work.
///
/// If `parent_hwnd` is `Some`, the thread creates a child HWND and initializes
/// a native GPU renderer (zero-IPC path).
/// If `None` or if GPU init fails, falls back to the protocol-based path.
pub fn spawn_video_receiver(
    identity: String,
    video_track: RemoteVideoTrack,
    shutdown: Arc<AtomicBool>,
    app_handle: Arc<AppHandle>,
    parent_hwnd: Option<isize>,
) {
    let id = identity.clone();
    std::thread::Builder::new()
        .name(format!("pax-video-{}", id))
        .spawn(move || {
            // Private runtime — only this stream's work runs here.
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("[Pax VideoRecv] Failed to create runtime");

            rt.block_on(async move {
                // ── Try to initialize native GPU renderer ────────────
                let mut gpu_renderer: Option<crate::native_overlay::GpuRenderer> = None;
                if let Some(phwnd) = parent_hwnd {
                    match crate::native_overlay::GpuRenderer::new(phwnd, id.clone()).await {
                        Ok(renderer) => {
                            eprintln!("[Pax VideoRecv] Native GPU renderer initialized for '{}'", id);
                            gpu_renderer = Some(renderer);
                        }
                        Err(e) => {
                            eprintln!(
                                "[Pax VideoRecv] GPU init failed for '{}': {} — falling back to protocol",
                                id, e
                            );
                            // Fall through to protocol path
                        }
                    }
                }

                let use_native = gpu_renderer.is_some();

                // Only register in STREAMS for protocol-based path
                if !use_native {
                    let mut streams = STREAMS.lock();
                    let entry = streams.entry(id.clone()).or_insert_with(|| StreamState {
                        body: None, width: 0, height: 0, frame_number: 0,
                        receiving: true, target: (0, 0),
                    });
                    entry.receiving = true;
                }

                eprintln!(
                    "[Pax VideoRecv] Dedicated thread started for '{}' (native_gpu={})",
                    id, use_native
                );

                let rtc_track = video_track.rtc_track();
                let mut stream = NativeVideoStream::new(rtc_track);
                let mut clip_rx = if use_native {
                    let (clip_tx, clip_rx) = tokio::sync::mpsc::unbounded_channel();
                    crate::native_overlay::register_overlay_clip_notifier(&id, clip_tx);
                    Some(clip_rx)
                } else {
                    None
                };
                let mut frame_number: u64 = 0;
                let mut total_process_us: u64 = 0;
                let mut drained_count: u64 = 0;

                // ── Periodic Win32 message pump (native GPU path only) ──
                // The overlay HWND is owned by THIS thread.  When the main
                // thread (Tauri UI) sends messages to our HWND — e.g. during
                // focus transitions, resize, taskbar restore — it uses
                // SendMessage, which BLOCKS THE MAIN THREAD until we call
                // PeekMessage/DispatchMessage here.  If we only pump inside
                // render_frame (once per video frame, ~30fps), the main
                // thread can stall for 30+ ms per message.  Pumping every
                // ~4 ms keeps the main thread responsive.
                let mut pump_ticker = tokio::time::interval(
                    std::time::Duration::from_millis(4),
                );
                pump_ticker.set_missed_tick_behavior(
                    tokio::time::MissedTickBehavior::Skip,
                );

                loop {
                    if shutdown.load(Ordering::Relaxed) {
                        eprintln!("[Pax VideoRecv] Shutdown for '{}'", id);
                        break;
                    }

                    if clip_rx.is_some() {
                        let mut close_clip_channel = false;
                        {
                            let cr = clip_rx.as_mut().expect("clip_rx checked is_some");
                            tokio::select! {
                                biased;
                                // Highest priority: keep the main thread unblocked
                                _ = pump_ticker.tick() => {
                                    crate::native_overlay::pump_messages();
                                }
                                msg = cr.recv() => {
                                    match msg {
                                        Some(()) => {
                                            while cr.try_recv().is_ok() {}
                                            if let Some(renderer) = gpu_renderer.as_mut() {
                                                renderer.refresh_obstruction_clip();
                                            }
                                        }
                                        None => {
                                            close_clip_channel = true;
                                        }
                                    }
                                }
                                first = stream.next() => {
                                    let Some(mut latest_frame) = first else {
                                        eprintln!("[Pax VideoRecv] Stream ended for '{}'", id);
                                        break;
                                    };

                                    if shutdown.load(Ordering::Relaxed) {
                                        eprintln!("[Pax VideoRecv] Shutdown for '{}'", id);
                                        break;
                                    }

                                    let mut skipped = 0u32;
                                    loop {
                                        match futures_util::FutureExt::now_or_never(stream.next()) {
                                            Some(Some(newer)) => { latest_frame = newer; skipped += 1; }
                                            _ => break,
                                        }
                                    }
                                    drained_count += skipped as u64;

                                    let process_start = std::time::Instant::now();

                                    let mut i420 = latest_frame.buffer.to_i420();
                                    let src_w = i420.width();
                                    let src_h = i420.height();
                                    if src_w == 0 || src_h == 0 {
                                        continue;
                                    }

                                    frame_number += 1;

                                    if frame_number == 1 {
                                        eprintln!(
                                            "[Pax VideoRecv] First frame decoded for '{}': {}x{}",
                                            id, src_w, src_h
                                        );
                                    }

                                    let Some(renderer) = gpu_renderer.as_mut() else {
                                        continue;
                                    };
                                    let (fit_w, fit_h) = renderer.get_fit_dimensions(src_w, src_h);
                                    let final_i420 = if fit_w > 0 && fit_h > 0
                                        && (fit_w < src_w || fit_h < src_h)
                                    {
                                        i420.scale(fit_w as i32, fit_h as i32)
                                    } else {
                                        i420
                                    };

                                    let w = final_i420.width();
                                    let h = final_i420.height();
                                    let (data_y, data_u, data_v) = final_i420.data();
                                    let (stride_y, stride_u, stride_v) = final_i420.strides();
                                    renderer.render_frame(
                                        data_y, data_u, data_v,
                                        w, h,
                                        stride_y, stride_u, stride_v,
                                    );

                                    let elapsed_us = process_start.elapsed().as_micros() as u64;
                                    total_process_us += elapsed_us;

                                    if frame_number % 300 == 0 {
                                        let avg_us = total_process_us / frame_number;
                                        eprintln!(
                                            "[Pax VideoRecv] '{}' stats: frame={} avg_process={}µs drained={} last={}µs",
                                            id, frame_number, avg_us, drained_count, elapsed_us
                                        );
                                    }
                                }
                            }
                        }
                        if close_clip_channel {
                            clip_rx = None;
                        }
                    } else {
                        let first = stream.next().await;
                        let Some(mut latest_frame) = first else {
                            eprintln!("[Pax VideoRecv] Stream ended for '{}'", id);
                            break;
                        };

                        if shutdown.load(Ordering::Relaxed) {
                            eprintln!("[Pax VideoRecv] Shutdown for '{}'", id);
                            break;
                        }

                        let mut skipped = 0u32;
                        loop {
                            match futures_util::FutureExt::now_or_never(stream.next()) {
                                Some(Some(newer)) => { latest_frame = newer; skipped += 1; }
                                _ => break,
                            }
                        }
                        drained_count += skipped as u64;

                        let mut i420 = latest_frame.buffer.to_i420();
                        let src_w = i420.width();
                        let src_h = i420.height();
                        if src_w == 0 || src_h == 0 {
                            continue;
                        }

                        frame_number += 1;

                        if frame_number == 1 {
                            eprintln!(
                                "[Pax VideoRecv] First frame decoded for '{}': {}x{}",
                                id, src_w, src_h
                            );
                        }

                        let (tgt_w, tgt_h) = {
                            let streams = STREAMS.lock();
                            streams.get(&id).map(|s| s.target).unwrap_or((0, 0))
                        };

                        let needs_scale = tgt_w > 0 && tgt_h > 0 && (tgt_w < src_w || tgt_h < src_h);
                        let final_i420 = if needs_scale {
                            let (out_w, out_h) = fit_dimensions(src_w, src_h, tgt_w, tgt_h);
                            i420.scale(out_w as i32, out_h as i32)
                        } else {
                            i420
                        };

                        let w = final_i420.width();
                        let h = final_i420.height();
                        let (data_y, data_u, data_v) = final_i420.data();
                        let (stride_y, stride_u, stride_v) = final_i420.strides();

                        let cw = (w / 2) as usize;
                        let ch = (h / 2) as usize;
                        let y_size = (w * h) as usize;
                        let uv_size = cw * ch;
                        let total = 8 + y_size + uv_size * 2;

                        let mut body = Vec::with_capacity(total);
                        body.extend_from_slice(&w.to_le_bytes());
                        body.extend_from_slice(&h.to_le_bytes());

                        if stride_y == w {
                            body.extend_from_slice(&data_y[..y_size]);
                        } else {
                            for row in 0..h as usize {
                                let start = row * stride_y as usize;
                                body.extend_from_slice(&data_y[start..start + w as usize]);
                            }
                        }

                        if stride_u == cw as u32 {
                            body.extend_from_slice(&data_u[..uv_size]);
                        } else {
                            for row in 0..ch {
                                let start = row * stride_u as usize;
                                body.extend_from_slice(&data_u[start..start + cw]);
                            }
                        }

                        if stride_v == cw as u32 {
                            body.extend_from_slice(&data_v[..uv_size]);
                        } else {
                            for row in 0..ch {
                                let start = row * stride_v as usize;
                                body.extend_from_slice(&data_v[start..start + cw]);
                            }
                        }

                        {
                            let mut streams = STREAMS.lock();
                            let entry = streams.entry(id.clone()).or_insert_with(|| StreamState {
                                body: None, width: 0, height: 0, frame_number: 0,
                                receiving: true, target: (tgt_w, tgt_h),
                            });
                            entry.body = Some(body);
                            entry.width = w;
                            entry.height = h;
                            entry.frame_number = frame_number;
                        }

                        let _ = app_handle.emit("screen-share-frame-ready", FrameReadyEvent {
                            id: id.clone(),
                        });
                    }
                }

                if use_native {
                    crate::native_overlay::unregister_overlay_clip_notifier(&id);
                }

                // Cleanup
                if !use_native {
                    let mut streams = STREAMS.lock();
                    streams.remove(&id);
                }
                eprintln!("[Pax VideoRecv] Thread exiting for '{}'", id);
            });
        })
        .expect("[Pax VideoRecv] Failed to spawn thread");
}

fn fit_dimensions(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let scale_x = max_w as f64 / src_w as f64;
    let scale_y = max_h as f64 / src_h as f64;
    let scale = scale_x.min(scale_y).min(1.0);
    let mut w = (src_w as f64 * scale).round() as u32;
    let mut h = (src_h as f64 * scale).round() as u32;
    w = (w / 2) * 2;
    h = (h / 2) * 2;
    (w.max(2), h.max(2))
}

pub fn clear_frame_buffer_for(identity: &str) {
    STREAMS.lock().remove(identity);
}

pub fn clear_all_frame_buffers() {
    STREAMS.lock().clear();
}

// ─── URI scheme protocol handler ────────────────────────────────────────────

pub fn handle_protocol_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let path = request.uri().path();

    if path == "/resize" {
        let id = parse_query_param_str(&uri, "id").unwrap_or_default();
        let w = parse_query_param_u32(&uri, "w").unwrap_or(0);
        let h = parse_query_param_u32(&uri, "h").unwrap_or(0);
        if !id.is_empty() {
            let mut streams = STREAMS.lock();
            if let Some(entry) = streams.get_mut(&id) {
                entry.target = if w == 0 && h == 0 { (0, 0) } else { (w, h) };
            } else if w > 0 && h > 0 {
                streams.insert(id, StreamState {
                    body: None, width: 0, height: 0, frame_number: 0,
                    receiving: false, target: (w, h),
                });
            }
        }
        return ok_204();
    }

    if path == "/status" || path.is_empty() || path == "/" {
        let streams = STREAMS.lock();
        let mut items = Vec::new();
        for (id, s) in streams.iter() {
            items.push(format!(
                r#"{{"id":"{}","receiving":{},"frameNumber":{},"width":{},"height":{}}}"#,
                id.replace('"', "\\\""), s.receiving, s.frame_number, s.width, s.height,
            ));
        }
        let json = format!(r#"{{"streams":[{}]}}"#, items.join(","));
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .header("cache-control", "no-cache, no-store, must-revalidate")
            .header("access-control-allow-origin", "*")
            .body(json.into_bytes())
            .unwrap_or_else(|_| err_500());
    }

    if path == "/frame" {
        let id = parse_query_param_str(&uri, "id").unwrap_or_default();
        if id.is_empty() {
            return ok_204();
        }

        let body = {
            let mut streams = STREAMS.lock();
            streams.get_mut(&id).and_then(|s| s.body.take())
        };

        if let Some(body) = body {
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

fn parse_query_param_u32(uri: &str, key: &str) -> Option<u32> {
    parse_query_param_str(uri, key)?.parse().ok()
}

fn parse_query_param_str(uri: &str, key: &str) -> Option<String> {
    let query = uri.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == key {
            return Some(url_decode(kv.next()?));
        }
    }
    None
}

fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().and_then(hex_val);
            let lo = chars.next().and_then(hex_val);
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
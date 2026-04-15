pub mod auth;
pub mod codec;
pub mod config;
pub mod embed;
pub mod members;
pub mod messages;
pub mod overlay;
pub mod presence;
pub mod profile;
pub mod rooms;
pub mod voice_matrix;

use std::collections::HashMap;
use std::sync::Arc;

use data_encoding::BASE64;
use matrix_sdk::{Client, Room};
use tokio::sync::Mutex;

use crate::AppState;

/// Format an error with its full source chain so we see the real cause (e.g. TLS, timeout).
pub(crate) fn fmt_error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut current: &dyn std::error::Error = e;
    while let Some(source) = current.source() {
        s.push_str(" | ");
        s.push_str(&source.to_string());
        current = source;
    }
    s
}

/// Clone the Matrix client out of AppState, or error if not logged in.
pub(crate) async fn get_client(state: &AppState) -> Result<Client, String> {
    state
        .client
        .lock()
        .await
        .as_ref()
        .ok_or_else(|| "Not logged in".to_string())
        .cloned()
}

/// Parse a room ID string and look it up on the client.
pub(crate) fn resolve_room(client: &Client, room_id: &str) -> Result<Room, String> {
    let parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    client
        .get_room(&parsed)
        .ok_or_else(|| "Room not found".to_string())
}

pub(crate) fn encode_avatar_data_url(bytes: &[u8]) -> String {
    encode_bytes_data_url(bytes, "image/png")
}

pub(crate) fn encode_bytes_data_url(bytes: &[u8], mime_type: &str) -> String {
    let b64 = BASE64.encode(bytes);
    format!("data:{mime_type};base64,{b64}")
}

/// Guess image MIME type from magic bytes; falls back to `application/octet-stream`.
pub(crate) fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return "image/jpeg";
    }
    if bytes.len() >= 8 && bytes[0] == 0x89 && &bytes[1..4] == b"PNG" {
        return "image/png";
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return "image/gif";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    "application/octet-stream"
}

/// Guess image or common video container MIME from magic bytes.
pub(crate) fn sniff_media_mime(bytes: &[u8]) -> &'static str {
    let img = sniff_image_mime(bytes);
    if img != "application/octet-stream" {
        return img;
    }
    // ISO BMFF (MP4 / MOV / similar): size (4) + "ftyp" at offset 4
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return "video/mp4";
    }
    // EBML (WebM / Matroska)
    if bytes.len() >= 4 && bytes[0] == 0x1A && bytes[1] == 0x45 && bytes[2] == 0xDF && bytes[3] == 0xA3 {
        return "video/webm";
    }
    // PDF
    if bytes.len() >= 4 && &bytes[0..4] == b"%PDF" {
        return "application/pdf";
    }
    "application/octet-stream"
}

/// Convert a temp-file path to a Tauri asset-protocol URL that works
/// directly in `<img src>` — no frontend `convertFileSrc()` needed.
#[cfg(target_os = "windows")]
pub(crate) fn file_to_asset_url(path: &str) -> String {
    format!("https://asset.localhost/{}", urlencoding::encode(path))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn file_to_asset_url(path: &str) -> String {
    format!("asset://localhost/{}", urlencoding::encode(path))
}

fn mime_to_avatar_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// Fetch an avatar by MXC URI, with cache.
///
/// Avatar bytes are written to a temp file and cached as an `asset://`
/// URL — NOT as a multi-KB `data:` URL.  This keeps the `avatar_cache`
/// HashMap small, keeps IPC responses small, and lets the WebView manage
/// image memory through its own eviction policy.
///
/// `fetch_bytes` is a future that downloads the image — callers pass in
/// `room.avatar(MediaFormat::File)` or `member.avatar(MediaFormat::File)`.
pub(crate) async fn get_or_fetch_avatar(
    mxc_uri: Option<&matrix_sdk::ruma::MxcUri>,
    fetch_bytes: impl std::future::Future<Output = Result<Option<Vec<u8>>, matrix_sdk::Error>>,
    avatar_cache: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<String> {
    let mxc = mxc_uri?.to_string();

    // Cache hit — return immediately if the value is a file-backed URL.
    // Old `data:` entries are treated as stale and re-fetched below.
    {
        let cache = avatar_cache.lock().await;
        if let Some(cached) = cache.get(&mxc) {
            if !cached.starts_with("data:") {
                return Some(cached.clone());
            }
            // data: URL from before this fix — fall through to re-fetch
            // and replace with a temp-file-backed entry.
        }
    }

    let bytes = tokio::time::timeout(std::time::Duration::from_secs(10), fetch_bytes)
        .await
        .ok()?
        .ok()
        .flatten()?;

    let mime = sniff_image_mime(&bytes);
    let ext = mime_to_avatar_ext(mime);
    let temp_dir = std::env::temp_dir();
    let path = temp_dir.join(format!("pax_avatar_{}.{}", uuid::Uuid::new_v4(), ext));

    if std::fs::write(&path, &bytes).is_err() {
        // Disk write failed — don't cache, just return None.
        return None;
    }

    let path_str = path.to_str()?;
    let asset_url = file_to_asset_url(path_str);
    avatar_cache.lock().await.insert(mxc, asset_url.clone());
    Some(asset_url)
}
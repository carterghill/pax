pub mod auth;
pub mod avatar_cache;
pub mod codec;
pub mod config;
pub mod downloads;
pub mod embed;
pub mod lifecycle;
pub mod media_files;
pub mod media_protocol;
pub mod members;
pub mod message_display;
pub mod messages;
pub mod notification_levels;
pub mod notifications;
pub mod overlay;
pub mod pax_settings;
pub mod presence;
pub mod profile;
pub mod push;
pub mod push_rules;
pub mod reconciler;
pub mod room_creation;
pub mod room_discovery;
pub mod room_listing;
pub mod room_membership;
pub mod room_settings;
pub mod space_order;
pub mod tray_indicator;
pub mod unread;
pub mod voice_matrix;

use std::sync::Arc;

use data_encoding::BASE64;
use matrix_sdk::{Client, Room};

use crate::AppState;

pub(crate) use avatar_cache::AvatarDiskCache;

/// Tauri app-scoped temp directory.  Set once during `setup()` in lib.rs.
/// Falls back to `std::env::temp_dir()` if never initialised (shouldn't
/// happen in practice).
pub static TAURI_TEMP_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Return the Tauri temp dir (or system temp dir as fallback).
pub(crate) fn temp_dir() -> std::path::PathBuf {
    TAURI_TEMP_DIR
        .get()
        .cloned()
        .unwrap_or_else(std::env::temp_dir)
}

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

pub(crate) struct AuthedClient {
    pub client: Client,
    pub homeserver: String,
    pub access_token: String,
}

pub(crate) async fn get_authed_client(state: &AppState) -> Result<AuthedClient, String> {
    let client = get_client(state).await?;
    let homeserver = client.homeserver().to_string();
    let homeserver = homeserver.trim_end_matches('/').to_string();
    let access_token = client
        .access_token()
        .ok_or("No access token")?
        .to_string();
    Ok(AuthedClient {
        client,
        homeserver,
        access_token,
    })
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
    if bytes.len() >= 4
        && bytes[0] == 0x1A
        && bytes[1] == 0x45
        && bytes[2] == 0xDF
        && bytes[3] == 0xA3
    {
        return "video/webm";
    }
    // PDF
    if bytes.len() >= 4 && &bytes[0..4] == b"%PDF" {
        return "application/pdf";
    }
    "application/octet-stream"
}

/// Upload base64-encoded media to the homeserver and return the MXC URI.
pub(crate) async fn upload_media_b64(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    data_b64: &str,
    mime: &str,
) -> Result<String, String> {
    let bytes = data_encoding::BASE64
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("Invalid base64 data: {e}"))?;

    let upload_url = format!(
        "{}/_matrix/media/v3/upload",
        homeserver.trim_end_matches('/')
    );

    let resp = http_client
        .post(&upload_url)
        .timeout(std::time::Duration::from_secs(30))
        .bearer_auth(access_token)
        .header("Content-Type", mime)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Media upload failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Media upload failed ({}): {}", status, text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse upload response: {e}"))?;

    body["content_uri"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No content_uri in upload response".to_string())
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
/// Avatar bytes are written to a deterministic file under the
/// persistent avatar directory (`{app_cache_dir}/avatars/`) and
/// cached as a raw filesystem path. The frontend converts it to an
/// `asset://` URL via `convertFileSrc()` — the same pattern used for
/// every other media path in the app.
///
/// Because the filename is UUID-v5-derived from the MXC URI, the
/// same MXC always maps to the same on-disk file; the cache
/// survives app restart and the bytes don't need to be re-downloaded.
/// If the persistent dir isn't initialised yet (very early in setup,
/// or on a platform where `app_cache_dir()` fails), we fall back to
/// the Tauri temp dir with a UUID-v4 name — behaviour matches the
/// pre-disk-cache implementation for that session.
///
/// `fetch_bytes` is a future that downloads the image — callers pass
/// in `room.avatar(MediaFormat::File)` or
/// `member.avatar(MediaFormat::File)`.
pub(crate) async fn get_or_fetch_avatar(
    mxc_uri: Option<&matrix_sdk::ruma::MxcUri>,
    fetch_bytes: impl std::future::Future<Output = Result<Option<Vec<u8>>, matrix_sdk::Error>>,
    avatar_cache: &Arc<AvatarDiskCache>,
) -> Option<String> {
    let mxc = mxc_uri?.to_string();

    // Cache hit — filesystem-backed entries only. `data:` URLs are
    // treated as stale and re-fetched (they're leftovers from the
    // knock-member path before the temp-file migration).
    if let Some(cached) = avatar_cache.get(&mxc).await {
        if !cached.starts_with("data:") {
            // Defensive: if the on-disk file was wiped behind us
            // (manual cache-dir deletion, etc.), fall through to
            // re-download rather than trap callers on a dead path.
            // The frontend `<img onError>` path would eventually
            // recover, but re-fetching here avoids the flash.
            if std::path::Path::new(&cached).is_file() {
                return Some(cached);
            }
        }
    }

    let bytes = tokio::time::timeout(std::time::Duration::from_secs(10), fetch_bytes)
        .await
        .ok()?
        .ok()
        .flatten()?;

    let mime = sniff_image_mime(&bytes);
    let ext = mime_to_avatar_ext(mime);

    // Prefer the persistent avatar dir; if it's not initialised yet
    // fall back to the Tauri temp dir so the avatar still renders
    // this session (just won't survive a restart).
    let (dir, filename) = match avatar_cache.dir() {
        Some(d) => (d, AvatarDiskCache::filename_for_mxc(&mxc, ext)),
        None => (
            temp_dir(),
            format!("pax_avatar_{}.{}", uuid::Uuid::new_v4(), ext),
        ),
    };
    let path = dir.join(&filename);

    if std::fs::write(&path, &bytes).is_err() {
        return None;
    }

    let path_str = path.to_str()?.to_string();
    avatar_cache.insert(mxc, path_str.clone()).await;
    Some(path_str)
}

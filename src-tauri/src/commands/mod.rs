pub mod auth;
pub mod codec;
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
    let b64 = BASE64.encode(bytes);
    format!("data:image/png;base64,{}", b64)
}

/// Fetch an avatar by MXC URI, with cache.
///
/// `fetch_bytes` is a future that downloads the image — callers pass in
/// `room.avatar(MediaFormat::File)` or `member.avatar(MediaFormat::File)`.
pub(crate) async fn get_or_fetch_avatar(
    mxc_uri: Option<&matrix_sdk::ruma::MxcUri>,
    fetch_bytes: impl std::future::Future<Output = Result<Option<Vec<u8>>, matrix_sdk::Error>>,
    avatar_cache: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<String> {
    let mxc = mxc_uri?.to_string();

    {
        let cache = avatar_cache.lock().await;
        if let Some(cached) = cache.get(&mxc) {
            return Some(cached.clone());
        }
    }

    let bytes = fetch_bytes.await.ok().flatten()?;
    let data_url = encode_avatar_data_url(&bytes);
    avatar_cache.lock().await.insert(mxc, data_url.clone());
    Some(data_url)
}
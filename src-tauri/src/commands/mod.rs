pub mod auth;
pub mod members;
pub mod messages;
pub mod overlay;
pub mod presence;
pub mod rooms;
pub mod voice_matrix;

use std::collections::HashMap;
use std::sync::Arc;

use data_encoding::BASE64;
use matrix_sdk::{media::MediaFormat, room::RoomMember, Room};
use tokio::sync::Mutex;

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

fn encode_avatar_data_url(bytes: &[u8]) -> String {
    let b64 = BASE64.encode(bytes);
    format!("data:image/png;base64,{}", b64)
}

pub(crate) async fn get_or_fetch_room_avatar(
    room: &Room,
    avatar_cache: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<String> {
    let mxc = room.avatar_url().map(|uri| uri.to_string())?;

    {
        let cache = avatar_cache.lock().await;
        if let Some(cached) = cache.get(&mxc) {
            return Some(cached.clone());
        }
    }

    let bytes = room.avatar(MediaFormat::File).await.ok().flatten()?;
    let data_url = encode_avatar_data_url(&bytes);
    avatar_cache.lock().await.insert(mxc, data_url.clone());
    Some(data_url)
}

pub(crate) async fn get_or_fetch_member_avatar(
    member: &RoomMember,
    avatar_cache: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<String> {
    let mxc = member.avatar_url().map(|uri| uri.to_string())?;

    // Fast path: check cache without holding the lock during the fetch
    {
        let cache = avatar_cache.lock().await;
        if let Some(cached) = cache.get(&mxc) {
            return Some(cached.clone());
        }
    }

    let bytes = member.avatar(MediaFormat::File).await.ok().flatten()?;
    let data_url = encode_avatar_data_url(&bytes);

    // Insert (another task may have raced, but that's fine — same data)
    avatar_cache.lock().await.insert(mxc, data_url.clone());
    Some(data_url)
}
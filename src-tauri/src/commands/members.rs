use std::sync::Arc;

use futures_util::future::join_all;
use tauri::State;

use crate::types::RoomMemberInfo;
use crate::AppState;

use super::{get_client, get_or_fetch_member_avatar, resolve_room};

#[tauri::command]
pub async fn get_room_members(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<RoomMemberInfo>, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let members = room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get members: {e}"))?;

    let avatar_cache = state.avatar_cache.clone();
    let presence_map = state.presence_map.lock().await.clone();

    // Fetch all avatars concurrently
    let avatar_futures: Vec<_> = members
        .iter()
        .map(|member| {
            let cache = avatar_cache.clone();
            let member = member.clone();
            async move { get_or_fetch_member_avatar(&member, &cache).await }
        })
        .collect();
    let avatars = join_all(avatar_futures).await;

    let result = members
        .iter()
        .zip(avatars)
        .map(|(member, avatar_url)| {
            let user_id_str = member.user_id().to_string();
            let presence = presence_map
                .get(&user_id_str)
                .cloned()
                .unwrap_or_else(|| "offline".to_string());
            RoomMemberInfo {
                user_id: user_id_str,
                display_name: member.display_name().map(|n| n.to_string()),
                avatar_url,
                presence,
            }
        })
        .collect();

    Ok(result)
}
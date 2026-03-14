use std::sync::Arc;

use tauri::State;

use crate::types::RoomMemberInfo;
use crate::AppState;

use super::get_or_fetch_member_avatar;

#[tauri::command]
pub async fn get_room_members(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<RoomMemberInfo>, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;

    let members = room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get members: {e}"))?;

    let avatar_cache = state.avatar_cache.clone();
    let presence_map = state.presence_map.lock().await.clone();

    let mut result = Vec::new();
    for member in members {
        let avatar_url = get_or_fetch_member_avatar(&member, &avatar_cache).await;

        let user_id_str = member.user_id().to_string();
        let presence = presence_map
            .get(&user_id_str)
            .cloned()
            .unwrap_or_else(|| "offline".to_string());

        result.push(RoomMemberInfo {
            user_id: user_id_str,
            display_name: member.display_name().map(|n| n.to_string()),
            avatar_url,
            presence,
        });
    }

    Ok(result)
}

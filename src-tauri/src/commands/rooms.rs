use std::sync::Arc;

use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::{config::SyncSettings, Client};
use tauri::State;

use crate::types::RoomInfo;
use crate::AppState;

use super::{fmt_error_chain, get_or_fetch_room_avatar};
use crate::commands::voice_matrix::matrix_voice_leave_all_joined_rooms;

#[tauri::command]
pub async fn login(
    state: State<'_, Arc<AppState>>,
    homeserver: String,
    username: String,
    password: String,
) -> Result<String, String> {
    let client = Client::builder()
        .homeserver_url(&homeserver)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {}", fmt_error_chain(&e)))?;

    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Pax")
        .send()
        .await
        .map_err(|e| format!("Login failed: {}", fmt_error_chain(&e)))?;

    client
        .sync_once(SyncSettings::default().set_presence(matrix_sdk::ruma::presence::PresenceState::Offline))
        .await
        .map_err(|e| format!("Initial sync failed: {}", fmt_error_chain(&e)))?;

    // Crash recovery: clear stale voice call state in the background so login returns immediately.
    let client_cleanup = client.clone();
    let http_client = state.http_client.clone();
    tokio::spawn(async move {
        let _ = matrix_voice_leave_all_joined_rooms(&client_cleanup, &http_client, None).await;
    });

    let user_id = client
        .user_id()
        .ok_or("No user ID after login")?
        .to_string();

    *state.client.lock().await = Some(client);
    state.avatar_cache.lock().await.clear();
    Ok(user_id)
}

#[tauri::command]
pub async fn get_rooms(state: State<'_, Arc<AppState>>) -> Result<Vec<RoomInfo>, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    let all_rooms = client.joined_rooms();
    let avatar_cache = state.avatar_cache.clone();

    // First pass: collect space IDs and their children via m.space.child state events
    let mut space_children: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    for room in &all_rooms {
        if room.is_space() {
            let mut children = Vec::new();
            if let Ok(events) = room.get_state_events(StateEventType::SpaceChild).await {
                for event in events {
                    if let Ok(raw) = event.deserialize() {
                        match raw {
                            matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Sync(e) => {
                                children.push(e.state_key().to_string());
                            }
                            matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Stripped(
                                e,
                            ) => {
                                children.push(e.state_key().to_string());
                            }
                        }
                    }
                }
            }
            space_children.insert(room.room_id().to_string(), children);
        }
    }

    // Second pass: build room list with parent space info
    let mut room_list = Vec::new();

    for room in &all_rooms {
        let avatar_url = get_or_fetch_room_avatar(room, &avatar_cache).await;
        let room_id_str = room.room_id().to_string();

        // Find which spaces contain this room
        let parent_space_ids: Vec<String> = space_children
            .iter()
            .filter(|(_, children)| children.contains(&room_id_str))
            .map(|(space_id, _)| space_id.clone())
            .collect();

        let room_type_str = room.room_type().map(|rt| rt.to_string());

        room_list.push(RoomInfo {
            id: room_id_str,
            name: room.name().unwrap_or_else(|| "Unnamed".to_string()),
            avatar_url,
            is_space: room.is_space(),
            parent_space_ids,
            room_type: room_type_str,
        });
    }

    Ok(room_list)
}

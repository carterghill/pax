use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::{config::SyncSettings, Client, SessionMeta};
use tauri::{Manager, State};

use crate::types::RoomInfo;
use crate::AppState;

use super::auth::{save_session_to_credentials, SavedSession};
use super::{fmt_error_chain, get_or_fetch_room_avatar};
use crate::commands::voice_matrix::matrix_voice_leave_all_joined_rooms;

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?
        .join("matrix_store"))
}

#[tauri::command]
pub async fn login(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    homeserver: String,
    username: String,
    password: String,
) -> Result<String, String> {
    let sp = store_path(&app)?;

    // Clear any existing store before password login. A new login creates a new device ID,
    // but the crypto store may still have data from a previous device — that causes
    // "account in the store doesn't match" errors.
    if sp.exists() {
        let _ = std::fs::remove_dir_all(&sp);
    }

    eprintln!("[Pax] login: building client for {}", homeserver);
    let client = Client::builder()
        .homeserver_url(&homeserver)
        .sqlite_store(&sp, None)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {}", fmt_error_chain(&e)))?;

    eprintln!("[Pax] login: authenticating...");
    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Pax")
        .send()
        .await
        .map_err(|e| format!("Login failed: {}", fmt_error_chain(&e)))?;

    eprintln!("[Pax] login: running initial sync...");
    tokio::time::timeout(
        Duration::from_secs(30),
        client.sync_once(SyncSettings::default().set_presence(matrix_sdk::ruma::presence::PresenceState::Offline)),
    )
    .await
    .map_err(|_| "Initial sync timed out (30s) — is the homeserver responsive?".to_string())?
    .map_err(|e| format!("Initial sync failed: {}", fmt_error_chain(&e)))?;

    eprintln!("[Pax] login: sync complete, saving session...");
    if let Some(session) = client.matrix_auth().session() {
        let _ = save_session_to_credentials(
            &app,
            SavedSession {
                user_id: session.meta.user_id.to_string(),
                device_id: session.meta.device_id.to_string(),
                access_token: session.tokens.access_token,
            },
        );
    }

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
    *state.sync_running.lock().await = false;
    state.avatar_cache.lock().await.clear();
    eprintln!("[Pax] login: done — user_id={}", user_id);
    Ok(user_id)
}

/// Fast-path boot: restore a previously saved session from the SQLite store.
/// Skips authentication and sync_once entirely -- rooms are available from the
/// persisted store, and start_sync picks up incrementally.
#[tauri::command]
pub async fn restore_session(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let creds = super::auth::load_credentials(app.clone())?
        .ok_or("No saved credentials")?;
    let sd = creds.session.ok_or("No saved session")?;
    let sp = store_path(&app)?;

    eprintln!("[Pax] restore_session: building client for {}", creds.homeserver);
    let client = Client::builder()
        .homeserver_url(&creds.homeserver)
        .sqlite_store(&sp, None)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {}", fmt_error_chain(&e)))?;

    let user_id = matrix_sdk::ruma::UserId::parse(&sd.user_id)
        .map_err(|e| format!("Invalid user ID: {e}"))?;

    eprintln!("[Pax] restore_session: restoring session...");
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: user_id.clone(),
                device_id: sd.device_id.into(),
            },
            tokens: SessionTokens {
                access_token: sd.access_token,
                refresh_token: None,
            },
        })
        .await
        .map_err(|e| format!("Failed to restore session: {e}"))?;

    // Quick token validity check (lightweight /account/whoami call)
    tokio::time::timeout(Duration::from_secs(5), client.whoami())
        .await
        .map_err(|_| "Token check timed out".to_string())?
        .map_err(|e| format!("Session expired: {e}"))?;

    eprintln!("[Pax] restore_session: valid — user_id={}", user_id);

    let client_cleanup = client.clone();
    let http_client = state.http_client.clone();
    tokio::spawn(async move {
        let _ = matrix_voice_leave_all_joined_rooms(&client_cleanup, &http_client, None).await;
    });

    *state.client.lock().await = Some(client);
    *state.sync_running.lock().await = false;
    Ok(user_id.to_string())
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

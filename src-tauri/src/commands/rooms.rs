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
use super::{fmt_error_chain, get_or_fetch_avatar};

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?
        .join("matrix_store"))
}

/// Register a new account on the homeserver.
///
/// Handles the UIAA flow for `m.login.registration_token` + `m.login.dummy`.
/// After registration succeeds, builds a full matrix-sdk Client and logs in.
#[tauri::command]
pub async fn register(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    homeserver: String,
    username: String,
    password: String,
    registration_token: String,
) -> Result<String, String> {
    let http = &state.http_client;
    let register_url = format!(
        "{}/_matrix/client/v3/register",
        homeserver.trim_end_matches('/')
    );

    // Step 1: Initial request to get session + required flows
    let initial = serde_json::json!({
        "username": username,
        "password": password,
        "initial_device_display_name": "Pax",
    });

    let resp = http
        .post(&register_url)
        .json(&initial)
        .send()
        .await
        .map_err(|e| format!("Failed to contact homeserver: {e}"))?;

    // 200 means open registration (no UIAA) — unlikely with a token server, but handle it
    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await
            .map_err(|e| format!("Failed to parse registration response: {e}"))?;
        return finish_registration(&state, &app, &homeserver, &username, &password, &body).await;
    }

    if resp.status().as_u16() != 401 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Registration failed ({}): {}", status, text));
    }

    // 401 → UIAA challenge
    let uiaa: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse UIAA response: {e}"))?;

    let session = uiaa["session"]
        .as_str()
        .ok_or("No UIAA session in response")?
        .to_string();

    // Step 2: Complete m.login.registration_token stage
    let token_auth = serde_json::json!({
        "username": username,
        "password": password,
        "initial_device_display_name": "Pax",
        "auth": {
            "type": "m.login.registration_token",
            "token": registration_token,
            "session": session,
        }
    });

    let resp = http
        .post(&register_url)
        .json(&token_auth)
        .send()
        .await
        .map_err(|e| format!("Failed to send token auth: {e}"))?;

    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await
            .map_err(|e| format!("Failed to parse registration response: {e}"))?;
        return finish_registration(&state, &app, &homeserver, &username, &password, &body).await;
    }

    if resp.status().as_u16() != 401 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Registration token rejected ({}): {}", status, text));
    }

    // Some servers require an additional m.login.dummy stage after the token
    let uiaa2: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse second UIAA response: {e}"))?;

    // Check if the token stage completed (should appear in "completed" array)
    let completed = uiaa2["completed"].as_array();
    let token_accepted = completed
        .map(|arr| arr.iter().any(|v| v.as_str() == Some("m.login.registration_token")))
        .unwrap_or(false);

    if !token_accepted {
        return Err("Registration token was not accepted by the server".to_string());
    }

    // Step 3: Complete m.login.dummy stage
    let dummy_auth = serde_json::json!({
        "username": username,
        "password": password,
        "initial_device_display_name": "Pax",
        "auth": {
            "type": "m.login.dummy",
            "session": session,
        }
    });

    let resp = http
        .post(&register_url)
        .json(&dummy_auth)
        .send()
        .await
        .map_err(|e| format!("Failed to send dummy auth: {e}"))?;

    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await
            .map_err(|e| format!("Failed to parse registration response: {e}"))?;
        return finish_registration(&state, &app, &homeserver, &username, &password, &body).await;
    }

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Err(format!("Registration failed at dummy stage ({}): {}", status, text))
}

/// After registration succeeds, log in with the SDK to get a proper Client.
async fn finish_registration(
    state: &State<'_, Arc<AppState>>,
    app: &tauri::AppHandle,
    homeserver: &str,
    username: &str,
    password: &str,
    _reg_response: &serde_json::Value,
) -> Result<String, String> {
    // Registration succeeded — now do a normal SDK login so we get a fully
    // initialised Client with crypto store, sync, etc.
    let sp = store_path(app)?;
    if sp.exists() {
        let _ = std::fs::remove_dir_all(&sp);
    }

    let client = Client::builder()
        .homeserver_url(homeserver)
        .sqlite_store(&sp, None)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {}", fmt_error_chain(&e)))?;

    client
        .matrix_auth()
        .login_username(username, password)
        .initial_device_display_name("Pax")
        .send()
        .await
        .map_err(|e| format!("Post-registration login failed: {}", fmt_error_chain(&e)))?;

    tokio::time::timeout(
        Duration::from_secs(30),
        client.sync_once(SyncSettings::default().set_presence(
            matrix_sdk::ruma::presence::PresenceState::Offline,
        )),
    )
    .await
    .map_err(|_| "Initial sync timed out (30s)".to_string())?
    .map_err(|e| format!("Initial sync failed: {}", fmt_error_chain(&e)))?;

    if let Some(session) = client.matrix_auth().session() {
        let _ = save_session_to_credentials(
            app,
            homeserver,
            SavedSession {
                user_id: session.meta.user_id.to_string(),
                device_id: session.meta.device_id.to_string(),
                access_token: session.tokens.access_token,
            },
        );
    }

    let user_id = client
        .user_id()
        .ok_or("No user ID after registration")?
        .to_string();

    *state.client.lock().await = Some(client);
    *state.sync_running.lock().await = false;
    state.avatar_cache.lock().await.clear();
    log::info!("register: done — user_id={}", user_id);
    Ok(user_id)
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

    log::info!("login: building client for {}", homeserver);
    let client = Client::builder()
        .homeserver_url(&homeserver)
        .sqlite_store(&sp, None)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {}", fmt_error_chain(&e)))?;

    log::info!("login: authenticating...");
    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Pax")
        .send()
        .await
        .map_err(|e| format!("Login failed: {}", fmt_error_chain(&e)))?;

    log::info!("login: running initial sync...");
    tokio::time::timeout(
        Duration::from_secs(30),
        client.sync_once(SyncSettings::default().set_presence(matrix_sdk::ruma::presence::PresenceState::Offline)),
    )
    .await
    .map_err(|_| "Initial sync timed out (30s) — is the homeserver responsive?".to_string())?
    .map_err(|e| format!("Initial sync failed: {}", fmt_error_chain(&e)))?;

    log::info!("login: sync complete, saving session...");
    if let Some(session) = client.matrix_auth().session() {
        let _ = save_session_to_credentials(
            &app,
            &homeserver,
            SavedSession {
                user_id: session.meta.user_id.to_string(),
                device_id: session.meta.device_id.to_string(),
                access_token: session.tokens.access_token,
            },
        );
    }

    let user_id = client
        .user_id()
        .ok_or("No user ID after login")?
        .to_string();

    *state.client.lock().await = Some(client);
    *state.sync_running.lock().await = false;
    state.avatar_cache.lock().await.clear();
    log::info!("login: done — user_id={}", user_id);
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

    log::info!("restore_session: building client for {}", creds.homeserver);
    let client = Client::builder()
        .homeserver_url(&creds.homeserver)
        .sqlite_store(&sp, None)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {}", fmt_error_chain(&e)))?;

    let user_id = matrix_sdk::ruma::UserId::parse(&sd.user_id)
        .map_err(|e| format!("Invalid user ID: {e}"))?;

    log::info!("restore_session: restoring session...");
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
        .map_err(|e| format!("Failed to restore session: {}", fmt_error_chain(&e)))?;

    // Quick token validity check (lightweight /account/whoami call)
    tokio::time::timeout(Duration::from_secs(5), client.whoami())
        .await
        .map_err(|_| "Token check timed out".to_string())?
        .map_err(|e| format!("Session expired: {e}"))?;

    log::info!("restore_session: valid — user_id={}", user_id);

    *state.client.lock().await = Some(client);
    *state.sync_running.lock().await = false;
    Ok(user_id.to_string())
}

#[tauri::command]
pub async fn get_rooms(state: State<'_, Arc<AppState>>) -> Result<Vec<RoomInfo>, String> {
    let client = super::get_client(&state).await?;

    let joined_rooms = client.joined_rooms();
    let invited_rooms = client.invited_rooms();
    let avatar_cache = state.avatar_cache.clone();

    // First pass: collect space IDs and their children via m.space.child state events
    let mut space_children: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    for room in &joined_rooms {
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

    // Second pass: build room list with parent space info (joined rooms)
    let mut room_list = Vec::new();

    for room in &joined_rooms {
        let avatar_url = get_or_fetch_avatar(
            room.avatar_url().as_deref(),
            room.avatar(matrix_sdk::media::MediaFormat::File),
            &avatar_cache,
        ).await;
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
            membership: "joined".to_string(),
        });
    }

    // Third pass: add invited rooms
    for room in &invited_rooms {
        let avatar_url = get_or_fetch_avatar(
            room.avatar_url().as_deref(),
            room.avatar(matrix_sdk::media::MediaFormat::File),
            &avatar_cache,
        ).await;
        let room_id_str = room.room_id().to_string();

        // Check if any joined space lists this room as a child
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
            membership: "invited".to_string(),
        });
    }

    Ok(room_list)
}

#[tauri::command]
pub async fn join_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&parsed)
        .ok_or_else(|| "Room not found".to_string())?;

    room.join()
        .await
        .map_err(|e| format!("Failed to join room: {}", fmt_error_chain(&e)))?;

    Ok(())
}
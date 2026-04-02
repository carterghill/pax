use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::{config::SyncSettings, Client, SessionMeta};
use tauri::{Manager, State};

use crate::types::{RoomInfo, SpaceChildInfo, SpaceInfo};
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

/// Build a matrix-sdk Client with automatic retries for transient failures
/// (DNS hiccups, brief network outages). Tries up to 3 times with increasing
/// delays before giving up.
async fn build_client_with_retry(
    homeserver: &str,
    store_path: &std::path::Path,
) -> Result<Client, String> {
    let mut last_err = String::new();
    for attempt in 0u64..3 {
        match Client::builder()
            .homeserver_url(homeserver)
            .sqlite_store(store_path, None)
            .build()
            .await
        {
            Ok(c) => return Ok(c),
            Err(e) => {
                last_err = format!("Failed to create client: {}", fmt_error_chain(&e));
                log::warn!("build_client attempt {}/3 failed: {}", attempt + 1, last_err);
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
                }
            }
        }
    }
    Err(format!("{} (retried 3 times)", last_err))
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

    let client = build_client_with_retry(homeserver, &sp).await?;

    {
        let mut last_err = String::new();
        let mut succeeded = false;
        for attempt in 0u32..3 {
            match client
                .matrix_auth()
                .login_username(username, password)
                .initial_device_display_name("Pax")
                .send()
                .await
            {
                Ok(_) => { succeeded = true; break; }
                Err(e) => {
                    last_err = fmt_error_chain(&e);
                    log::warn!("Post-registration login attempt {}/3 failed: {}", attempt + 1, last_err);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1))).await;
                    }
                }
            }
        }
        if !succeeded {
            return Err(format!("Post-registration login failed: {} (retried 3 times)", last_err));
        }
    }

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
    let client = build_client_with_retry(&homeserver, &sp).await?;

    log::info!("login: authenticating...");
    {
        let mut last_err = String::new();
        let mut succeeded = false;
        for attempt in 0u32..3 {
            match client
                .matrix_auth()
                .login_username(&username, &password)
                .initial_device_display_name("Pax")
                .send()
                .await
            {
                Ok(_) => { succeeded = true; break; }
                Err(e) => {
                    last_err = fmt_error_chain(&e);
                    log::warn!("Login attempt {}/3 failed: {}", attempt + 1, last_err);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1))).await;
                    }
                }
            }
        }
        if !succeeded {
            return Err(format!("Login failed: {} (retried 3 times)", last_err));
        }
    }

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

    // If a compile-time homeserver is configured, reject saved sessions that
    // point at a different server — the baked-in value is the source of truth.
    if let Some(configured) = &state.auth_config.default_homeserver {
        if creds.homeserver.trim_end_matches('/') != configured.trim_end_matches('/') {
            log::warn!(
                "restore_session: saved homeserver ({}) differs from configured ({}), discarding stale session",
                creds.homeserver, configured
            );
            return Err("Saved session is for a different homeserver".to_string());
        }
    }

    log::info!("restore_session: building client for {}", creds.homeserver);
    let client = build_client_with_retry(&creds.homeserver, &sp).await?;

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

    // Quick token validity check (lightweight /account/whoami call) with retries
    {
        let mut last_err = String::new();
        let mut succeeded = false;
        for attempt in 0u32..3 {
            match tokio::time::timeout(Duration::from_secs(5), client.whoami()).await {
                Ok(Ok(_)) => { succeeded = true; break; }
                Ok(Err(e)) => {
                    let err_str = format!("{e}");
                    // Transient network errors (DNS, connection) — retry
                    let is_transient = err_str.contains("dns")
                        || err_str.contains("connect")
                        || err_str.contains("sending request")
                        || err_str.contains("lookup");
                    if !is_transient {
                        // Likely auth error (expired token, etc.) — fail immediately
                        return Err(format!("Session expired: {e}"));
                    }
                    last_err = format!("Connection failed: {}", err_str);
                    log::warn!("whoami attempt {}/3 failed (transient): {}", attempt + 1, err_str);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1))).await;
                    }
                }
                Err(_) => {
                    last_err = "Token check timed out".to_string();
                    log::warn!("whoami attempt {}/3 timed out", attempt + 1);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1))).await;
                    }
                }
            }
        }
        if !succeeded {
            return Err(format!("{} (retried 3 times)", last_err));
        }
    }

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

    // join_room_by_id works for both accepting invites and joining public rooms
    // the client may not yet know about.
    client
        .join_room_by_id(&parsed)
        .await
        .map_err(|e| format!("Failed to join room: {}", fmt_error_chain(&e)))?;

    Ok(())
}

/// Convert an MXC URI to an unauthenticated thumbnail URL.
fn mxc_to_thumbnail_url(homeserver: &str, mxc: &str, width: u32, height: u32) -> Option<String> {
    let stripped = mxc.strip_prefix("mxc://")?;
    let (server, media_id) = stripped.split_once('/')?;
    Some(format!(
        "{}/_matrix/media/v3/thumbnail/{}/{}?width={}&height={}&method=crop",
        homeserver.trim_end_matches('/'),
        server,
        media_id,
        width,
        height,
    ))
}

#[tauri::command]
pub async fn get_space_info(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<SpaceInfo, String> {
    let client = super::get_client(&state).await?;
    let parsed = matrix_sdk::ruma::RoomId::parse(&space_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let space = client
        .get_room(&parsed)
        .ok_or("Space not found")?;

    let avatar_cache = state.avatar_cache.clone();
    let space_avatar = get_or_fetch_avatar(
        space.avatar_url().as_deref(),
        space.avatar(matrix_sdk::media::MediaFormat::File),
        &avatar_cache,
    )
    .await;

    let space_name = space.name().unwrap_or_else(|| "Unnamed".to_string());
    let space_topic = space.topic();

    // Call the room hierarchy API to discover child rooms (including ones not yet joined)
    let session = client
        .matrix_auth()
        .session()
        .ok_or("Not logged in")?;
    let homeserver = client.homeserver().to_string();
    let url = format!(
        "{}/_matrix/client/v1/rooms/{}/hierarchy?limit=50",
        homeserver.trim_end_matches('/'),
        space_id,
    );

    let resp = state
        .http_client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", session.tokens.access_token),
        )
        .send()
        .await
        .map_err(|e| format!("Hierarchy request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Hierarchy API error ({}): {}", status, text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse hierarchy response: {e}"))?;

    let mut children = Vec::new();

    if let Some(rooms) = body["rooms"].as_array() {
        for room_data in rooms {
            let child_id = match room_data["room_id"].as_str() {
                Some(id) => id.to_string(),
                None => continue,
            };

            // Skip the space itself (first entry in hierarchy is always the queried space)
            if child_id == space_id {
                continue;
            }

            let name = room_data["name"]
                .as_str()
                .unwrap_or("Unnamed")
                .to_string();
            let topic = room_data["topic"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string());
            let join_rule = room_data["join_rule"].as_str().map(|s| s.to_string());
            let room_type = room_data["room_type"].as_str().map(|s| s.to_string());
            let num_joined_members = room_data["num_joined_members"].as_u64().unwrap_or(0);

            // Determine this user's membership in the child room
            let membership = if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(&child_id) {
                if let Some(r) = client.get_room(&rid) {
                    match r.state() {
                        matrix_sdk::RoomState::Joined => "joined",
                        matrix_sdk::RoomState::Invited => "invited",
                        _ => "none",
                    }
                } else {
                    "none"
                }
            } else {
                "none"
            }
            .to_string();

            // Avatar: use cache for joined rooms, convert MXC thumbnail URL for others
            let avatar_url = if membership == "joined" {
                if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(&child_id) {
                    if let Some(r) = client.get_room(&rid) {
                        get_or_fetch_avatar(
                            r.avatar_url().as_deref(),
                            r.avatar(matrix_sdk::media::MediaFormat::File),
                            &avatar_cache,
                        )
                        .await
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                room_data["avatar_url"]
                    .as_str()
                    .and_then(|mxc| mxc_to_thumbnail_url(&homeserver, mxc, 64, 64))
            };

            children.push(SpaceChildInfo {
                id: child_id,
                name,
                topic,
                avatar_url,
                membership,
                join_rule,
                room_type,
                num_joined_members,
            });
        }
    }

    Ok(SpaceInfo {
        name: space_name,
        topic: space_topic,
        avatar_url: space_avatar,
        children,
    })
}

#[tauri::command]
pub async fn get_history_visibility(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    // Validate the room exists
    let _ = super::resolve_room(&client, &room_id)?;

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.history_visibility/",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&room_id),
    );

    let resp = state
        .http_client
        .get(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("Failed to get history visibility: {}", super::fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        // If the event doesn't exist yet, the spec default is "shared"
        return Ok("shared".to_string());
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse history visibility response: {e}"))?;

    Ok(body
        .get("history_visibility")
        .and_then(|v| v.as_str())
        .unwrap_or("shared")
        .to_string())
}

#[tauri::command]
pub async fn set_history_visibility(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    visibility: String,
) -> Result<(), String> {
    let valid = ["joined", "shared", "invited", "world_readable"];
    if !valid.contains(&visibility.as_str()) {
        return Err(format!(
            "Invalid history_visibility '{}'. Must be one of: {}",
            visibility,
            valid.join(", ")
        ));
    }

    let client = super::get_client(&state).await?;
    // Validate the room exists
    let _ = super::resolve_room(&client, &room_id)?;

    let content = serde_json::json!({
        "history_visibility": visibility,
    });

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.history_visibility/",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&room_id),
    );

    let resp = state
        .http_client
        .put(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&content)
        .send()
        .await
        .map_err(|e| format!("Failed to send history visibility event: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to set history visibility ({}): {}",
            status, body
        ));
    }

    log::info!(
        "set_history_visibility: room={} visibility={}",
        room_id,
        visibility
    );
    Ok(())
}
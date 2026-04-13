use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use tokio::sync::Mutex;
use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::{config::SyncSettings, Client, RoomMemberships, SessionMeta};
use tauri::{Manager, State};

use crate::types::{RoomInfo, SpaceChildInfo, SpaceInfo};
use crate::AppState;

use super::auth::{
    save_session_to_credentials, spawn_cleanup_stale_matrix_stores, SavedCredentials, SavedSession,
};
use super::{fmt_error_chain, get_or_fetch_avatar};

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))
}

fn sqlite_path_for_restore(
    app: &tauri::AppHandle,
    creds: &SavedCredentials,
) -> Result<std::path::PathBuf, String> {
    let base = app_data_dir(app)?;
    Ok(match &creds.sqlite_store_dir {
        Some(rel) => base.join(rel),
        None => base.join("matrix_store"),
    })
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
                log::warn!(
                    "build_client attempt {}/3 failed: {}",
                    attempt + 1,
                    last_err
                );
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
                }
            }
        }
    }
    Err(format!("{} (retried 3 times)", last_err))
}

/// Password login / registration: always use a new SQLite directory under `matrix_sessions/` so we
/// never delete or reuse a store path that may still be open. Reusing the same `Client` after a
/// failed `login_username` can panic with `AlreadyInitializedError`, so each attempt uses a new path.
async fn login_password_into_new_store(
    app: &tauri::AppHandle,
    homeserver: &str,
    username: &str,
    password: &str,
    log_prefix: &str,
) -> Result<(Client, String), String> {
    let base = app_data_dir(app)?;
    let sessions_root = base.join("matrix_sessions");
    std::fs::create_dir_all(&sessions_root)
        .map_err(|e| format!("Failed to create matrix_sessions: {e}"))?;

    let mut last_err = String::new();
    for attempt in 0u32..3 {
        let id = uuid::Uuid::new_v4();
        let rel = format!("matrix_sessions/pw_{id}");
        let sp = base.join(&rel);

        let client = match build_client_with_retry(homeserver, &sp).await {
            Ok(c) => c,
            Err(e) => {
                last_err = e;
                log::warn!(
                    "{}: build client attempt {}/3 failed: {}",
                    log_prefix,
                    attempt + 1,
                    last_err
                );
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1))).await;
                }
                continue;
            }
        };
        match client
            .matrix_auth()
            .login_username(username, password)
            .initial_device_display_name("Pax")
            .send()
            .await
        {
            Ok(_) => return Ok((client, rel)),
            Err(e) => {
                last_err = fmt_error_chain(&e);
                log::warn!(
                    "{}: authenticate attempt {}/3 failed: {}",
                    log_prefix,
                    attempt + 1,
                    last_err
                );
                drop(client);
                let _ = std::fs::remove_dir_all(&sp);
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(format!("{log_prefix} failed after 3 attempts: {last_err}"))
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
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse registration response: {e}"))?;
        return finish_registration(&state, &app, &homeserver, &username, &password, &body).await;
    }

    if resp.status().as_u16() != 401 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Registration failed ({}): {}", status, text));
    }

    // 401 → UIAA challenge
    let uiaa: serde_json::Value = resp
        .json()
        .await
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
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse registration response: {e}"))?;
        return finish_registration(&state, &app, &homeserver, &username, &password, &body).await;
    }

    if resp.status().as_u16() != 401 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Registration token rejected ({}): {}",
            status, text
        ));
    }

    // Some servers require an additional m.login.dummy stage after the token
    let uiaa2: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse second UIAA response: {e}"))?;

    // Check if the token stage completed (should appear in "completed" array)
    let completed = uiaa2["completed"].as_array();
    let token_accepted = completed
        .map(|arr| {
            arr.iter()
                .any(|v| v.as_str() == Some("m.login.registration_token"))
        })
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
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse registration response: {e}"))?;
        return finish_registration(&state, &app, &homeserver, &username, &password, &body).await;
    }

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Err(format!(
        "Registration failed at dummy stage ({}): {}",
        status, text
    ))
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
    state.stop_sync_task().await;
    *state.client.lock().await = None;

    let (client, store_rel) = login_password_into_new_store(
        app,
        homeserver,
        username,
        password,
        "Post-registration login",
    )
    .await?;

    tokio::time::timeout(
        Duration::from_secs(30),
        client.sync_once(
            SyncSettings::default()
                .set_presence(matrix_sdk::ruma::presence::PresenceState::Offline),
        ),
    )
    .await
    .map_err(|_| "Initial sync timed out (30s)".to_string())?
    .map_err(|e| format!("Initial sync failed: {}", fmt_error_chain(&e)))?;

    if let Some(session) = client.matrix_auth().session() {
        let keep = store_rel.clone();
        let _ = save_session_to_credentials(
            app,
            homeserver,
            SavedSession {
                user_id: session.meta.user_id.to_string(),
                device_id: session.meta.device_id.to_string(),
                access_token: session.tokens.access_token,
            },
            Some(store_rel),
        );
        spawn_cleanup_stale_matrix_stores(app.clone(), keep);
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
    persist_session: bool,
) -> Result<String, String> {
    state.stop_sync_task().await;
    *state.client.lock().await = None;

    log::info!("login: password auth for {}", homeserver);
    let (client, store_rel) =
        login_password_into_new_store(&app, &homeserver, &username, &password, "Login").await?;

    log::info!("login: running initial sync...");
    tokio::time::timeout(
        Duration::from_secs(30),
        client.sync_once(
            SyncSettings::default()
                .set_presence(matrix_sdk::ruma::presence::PresenceState::Offline),
        ),
    )
    .await
    .map_err(|_| "Initial sync timed out (30s) — is the homeserver responsive?".to_string())?
    .map_err(|e| format!("Initial sync failed: {}", fmt_error_chain(&e)))?;

    log::info!("login: sync complete, saving session...");
    if persist_session {
        if let Some(session) = client.matrix_auth().session() {
            let keep = store_rel.clone();
            let _ = save_session_to_credentials(
                &app,
                &homeserver,
                SavedSession {
                    user_id: session.meta.user_id.to_string(),
                    device_id: session.meta.device_id.to_string(),
                    access_token: session.tokens.access_token,
                },
                Some(store_rel),
            );
            spawn_cleanup_stale_matrix_stores(app.clone(), keep);
        }
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
    let creds = super::auth::load_credentials(app.clone())?.ok_or("No saved credentials")?;
    let sp = sqlite_path_for_restore(&app, &creds)?;
    let sd = creds.session.ok_or("No saved session")?;

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
                Ok(Ok(_)) => {
                    succeeded = true;
                    break;
                }
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
                    log::warn!(
                        "whoami attempt {}/3 failed (transient): {}",
                        attempt + 1,
                        err_str
                    );
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1)))
                            .await;
                    }
                }
                Err(_) => {
                    last_err = "Token check timed out".to_string();
                    log::warn!("whoami attempt {}/3 timed out", attempt + 1);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(1000 * (attempt as u64 + 1)))
                            .await;
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

async fn fetch_space_children_for_room(
    room: matrix_sdk::Room,
) -> (String, Vec<String>) {
    let room_id = room.room_id().to_string();
    let mut children = Vec::new();
    match tokio::time::timeout(
        Duration::from_secs(10),
        room.get_state_events(StateEventType::SpaceChild),
    )
    .await
    {
        Ok(Ok(events)) => {
            for event in events {
                if let Ok(raw) = event.deserialize() {
                    match raw {
                        matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Sync(e) => {
                            children.push(e.state_key().to_string());
                        }
                        matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Stripped(e) => {
                            children.push(e.state_key().to_string());
                        }
                    }
                }
            }
        }
        Ok(Err(e)) => {
            log::warn!(
                "get_rooms: failed to fetch m.space.child events for {}: {}",
                room_id,
                fmt_error_chain(&e)
            );
        }
        Err(_) => {
            log::warn!(
                "get_rooms: timed out fetching m.space.child events for {}",
                room_id
            );
        }
    }
    (room_id, children)
}

/// Concurrent fetches for space hierarchy + avatars; sequential was very slow with many spaces/rooms.
const GET_ROOMS_SPACE_CHILD_CONCURRENCY: usize = 16;
const GET_ROOMS_AVATAR_CONCURRENCY: usize = 24;

/// 1:1 direct message: use peer display name, avatar, and presence (like Element).
async fn dm_one_to_one_peer_summary(
    room: &matrix_sdk::Room,
    avatar_cache: &Arc<Mutex<HashMap<String, String>>>,
    presence_map: &Arc<Mutex<HashMap<String, String>>>,
    status_msg_map: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<(String, Option<String>, String, String, Option<String>)> {
    if room.is_space() {
        return None;
    }
    let is_dm = room.is_direct().await.ok()?;
    if !is_dm {
        return None;
    }
    let client = room.client();
    let me = client.user_id()?;
    // Include invited members so 1:1 DMs still resolve the peer before they accept (we're joined, they're invited).
    let members = room
        .members(RoomMemberships::JOIN | RoomMemberships::INVITE)
        .await
        .ok()?;
    let others: Vec<_> = members
        .into_iter()
        .filter(|m| m.user_id() != me)
        .collect();
    if others.len() != 1 {
        return None;
    }
    let m = others.into_iter().next()?;
    let peer_id = m.user_id().to_string();
    let display = m
        .display_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| peer_id.clone());
    let avatar = get_or_fetch_avatar(
        m.avatar_url(),
        m.avatar(matrix_sdk::media::MediaFormat::File),
        avatar_cache,
    )
    .await;
    let presence = presence_map
        .lock()
        .await
        .get(&peer_id)
        .cloned()
        .unwrap_or_else(|| "offline".to_string());
    let status_msg = status_msg_map
        .lock()
        .await
        .get(&peer_id)
        .cloned();
    Some((display, avatar, peer_id, presence, status_msg))
}

#[tauri::command]
pub async fn get_rooms(state: State<'_, Arc<AppState>>) -> Result<Vec<RoomInfo>, String> {
    let client = super::get_client(&state).await?;

    let joined_rooms = client.joined_rooms();
    let invited_rooms = client.invited_rooms();
    let avatar_cache = state.avatar_cache.clone();
    let presence_map = state.presence_map.clone();
    let status_msg_map_rooms = state.status_msg_map.clone();

    let space_rooms: Vec<matrix_sdk::Room> = joined_rooms
        .iter()
        .filter(|r| r.is_space())
        .cloned()
        .collect();

    // Space → child room ids (parallel; was one 10s timeout per space in series).
    let space_child_pairs: Vec<(String, Vec<String>)> = stream::iter(
        space_rooms
            .into_iter()
            .map(|room| async move { fetch_space_children_for_room(room).await }),
    )
    .buffer_unordered(GET_ROOMS_SPACE_CHILD_CONCURRENCY)
    .collect()
    .await;

    let space_children: HashMap<String, Vec<String>> = space_child_pairs.into_iter().collect();
    let space_children = Arc::new(space_children);

    // Joined rooms: parallel avatars, preserve sidebar order via index sort.
    let mut joined_parts: Vec<(usize, RoomInfo)> = stream::iter(
        joined_rooms.into_iter().enumerate().map(|(idx, room)| {
            let sc = space_children.clone();
            let ac = avatar_cache.clone();
            let pm = presence_map.clone();
            let sm = status_msg_map_rooms.clone();
            async move {
                let room_id_str = room.room_id().to_string();
                let parent_space_ids: Vec<String> = sc
                    .iter()
                    .filter(|(_, children)| children.contains(&room_id_str))
                    .map(|(space_id, _)| space_id.clone())
                    .collect();
                let room_type_str = room.room_type().map(|rt| rt.to_string());
                let topic = room.topic();

                let mut name = room.name().unwrap_or_else(|| "Unnamed".to_string());
                let mut avatar_url = get_or_fetch_avatar(
                    room.avatar_url().as_deref(),
                    room.avatar(matrix_sdk::media::MediaFormat::File),
                    &ac,
                )
                .await;
                let mut is_direct = false;
                let mut dm_peer_user_id: Option<String> = None;
                let mut dm_peer_presence: Option<String> = None;
                let mut dm_peer_status_msg: Option<String> = None;

                if let Some((dname, dav, pid, pres, smsg)) =
                    dm_one_to_one_peer_summary(&room, &ac, &pm, &sm).await
                {
                    name = dname;
                    avatar_url = dav;
                    is_direct = true;
                    dm_peer_user_id = Some(pid);
                    dm_peer_presence = Some(pres);
                    dm_peer_status_msg = smsg;
                }

                let info = RoomInfo {
                    id: room_id_str,
                    name,
                    avatar_url,
                    is_space: room.is_space(),
                    parent_space_ids,
                    room_type: room_type_str,
                    topic,
                    membership: "joined".to_string(),
                    is_direct,
                    dm_peer_user_id,
                    dm_peer_presence,
                    dm_peer_status_msg,
                };
                (idx, info)
            }
        }),
    )
    .buffer_unordered(GET_ROOMS_AVATAR_CONCURRENCY)
    .collect()
    .await;

    joined_parts.sort_by_key(|(i, _)| *i);
    let mut room_list: Vec<RoomInfo> = joined_parts.into_iter().map(|(_, r)| r).collect();

    // Invited rooms (same pattern).
    let mut invited_parts: Vec<(usize, RoomInfo)> = stream::iter(
        invited_rooms.into_iter().enumerate().map(|(idx, room)| {
            let sc = space_children.clone();
            let ac = avatar_cache.clone();
            let pm = presence_map.clone();
            let sm = status_msg_map_rooms.clone();
            async move {
                let room_id_str = room.room_id().to_string();
                let parent_space_ids: Vec<String> = sc
                    .iter()
                    .filter(|(_, children)| children.contains(&room_id_str))
                    .map(|(space_id, _)| space_id.clone())
                    .collect();
                let room_type_str = room.room_type().map(|rt| rt.to_string());
                let topic = room.topic();

                let mut name = room.name().unwrap_or_else(|| "Unnamed".to_string());
                let mut avatar_url = get_or_fetch_avatar(
                    room.avatar_url().as_deref(),
                    room.avatar(matrix_sdk::media::MediaFormat::File),
                    &ac,
                )
                .await;
                let mut is_direct = false;
                let mut dm_peer_user_id: Option<String> = None;
                let mut dm_peer_presence: Option<String> = None;
                let mut dm_peer_status_msg: Option<String> = None;

                if let Some((dname, dav, pid, pres, smsg)) =
                    dm_one_to_one_peer_summary(&room, &ac, &pm, &sm).await
                {
                    name = dname;
                    avatar_url = dav;
                    is_direct = true;
                    dm_peer_user_id = Some(pid);
                    dm_peer_presence = Some(pres);
                    dm_peer_status_msg = smsg;
                }

                let info = RoomInfo {
                    id: room_id_str,
                    name,
                    avatar_url,
                    is_space: room.is_space(),
                    parent_space_ids,
                    room_type: room_type_str,
                    topic,
                    membership: "invited".to_string(),
                    is_direct,
                    dm_peer_user_id,
                    dm_peer_presence,
                    dm_peer_status_msg,
                };
                (idx, info)
            }
        }),
    )
    .buffer_unordered(GET_ROOMS_AVATAR_CONCURRENCY)
    .collect()
    .await;

    invited_parts.sort_by_key(|(i, _)| *i);
    room_list.extend(invited_parts.into_iter().map(|(_, r)| r));

    Ok(room_list)
}

#[tauri::command]
pub async fn current_homeserver(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    Ok(client.homeserver().to_string())
}

#[tauri::command]
pub async fn join_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    via_servers: Option<Vec<String>>,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;

    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    // Federation hints (same discovery as the old raw HTTP join).
    let mut server_names = Vec::new();
    if let Some(via_servers) = via_servers.as_deref() {
        for via_server in via_servers {
            for discovered in discover_federation_server_names(&state.http_client, via_server).await {
                push_unique(&mut server_names, discovered);
            }
        }
    }
    if let Some((_, server_name)) = room_id.rsplit_once(':') {
        for discovered in discover_federation_server_names(&state.http_client, server_name).await {
            push_unique(&mut server_names, discovered);
        }
    }

    let via: Vec<matrix_sdk::ruma::OwnedServerName> = server_names
        .iter()
        .filter_map(|s| matrix_sdk::ruma::OwnedServerName::try_from(s.as_str()).ok())
        .collect();

    // Use the SDK join so `finish_join_room` registers the room in the in-memory client
    // immediately. A raw POST /join succeeds before sliding sync runs, so `get_room` would
    // miss and `get_messages` / `get_room_members` returned "Room not found" until sync caught up.
    let room = if via.is_empty() {
        client
            .join_room_by_id(&parsed)
            .await
            .map_err(|e| format!("Failed to join room: {}", fmt_error_chain(&e)))?
    } else {
        let rid: &matrix_sdk::ruma::RoomId = &*parsed;
        let id: &matrix_sdk::ruma::RoomOrAliasId = rid.into();
        client
            .join_room_by_id_or_alias(id, &via)
            .await
            .map_err(|e| format!("Failed to join room: {}", fmt_error_chain(&e)))?
    };

    Ok(room.room_id().to_string())
}

#[tauri::command]
pub async fn leave_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let url = format!("{}/_matrix/client/v3/rooms/{}/leave", hs, encoded_room);
    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Leave failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Leave failed ({status}): {text}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn knock_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    reason: Option<String>,
    via_servers: Option<Vec<String>>,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs_trim = homeserver.trim_end_matches('/');

    let encoded = urlencoding::encode(&room_id);
    let mut url = format!("{}/_matrix/client/v3/knock/{}", hs_trim, encoded);

    // Add via servers as query params
    let mut via_parts = Vec::new();
    if let Some(servers) = via_servers.as_deref() {
        for server in servers {
            for discovered in discover_federation_server_names(&state.http_client, server).await {
                if !via_parts.contains(&discovered) {
                    via_parts.push(discovered);
                }
            }
        }
    }
    if let Some((_, server_name)) = room_id.rsplit_once(':') {
        for discovered in discover_federation_server_names(&state.http_client, server_name).await {
            if !via_parts.contains(&discovered) {
                via_parts.push(discovered);
            }
        }
    }
    if !via_parts.is_empty() {
        let query: Vec<String> = via_parts
            .iter()
            .map(|s| format!("server_name={}", urlencoding::encode(s)))
            .collect();
        url = format!("{}?{}", url, query.join("&"));
    }

    let mut body = serde_json::json!({});
    if let Some(reason) = reason {
        body["reason"] = serde_json::json!(reason);
    }

    let resp = state
        .http_client
        .post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Knock failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Knock failed ({status}): {text}"));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse knock response: {e}"))?;

    Ok(result["room_id"]
        .as_str()
        .unwrap_or(&room_id)
        .to_string())
}

/// Convert an MXC URI to an unauthenticated thumbnail URL.
fn mxc_to_thumbnail_url(base_url: &str, mxc: &str, width: u32, height: u32) -> Option<String> {
    let stripped = mxc.strip_prefix("mxc://")?;
    let (server, media_id) = stripped.split_once('/')?;
    Some(format!(
        "{}/_matrix/media/v3/thumbnail/{}/{}?width={}&height={}&method=crop",
        base_url.trim_end_matches('/'),
        server,
        media_id,
        width,
        height,
    ))
}

async fn mxc_to_discovered_thumbnail_url(
    http_client: &reqwest::Client,
    discovery_cache: &mut std::collections::HashMap<String, String>,
    mxc: &str,
    width: u32,
    height: u32,
) -> Option<String> {
    let stripped = mxc.strip_prefix("mxc://")?;
    let (server, _) = stripped.split_once('/')?;

    let base_url = if let Some(base_url) = discovery_cache.get(server) {
        base_url.clone()
    } else {
        let discovered = discover_client_base_urls(http_client, server)
            .await
            .into_iter()
            .next()
            .unwrap_or_else(|| format!("https://{server}"));
        discovery_cache.insert(server.to_string(), discovered.clone());
        discovered
    };

    mxc_to_thumbnail_url(&base_url, mxc, width, height)
}

#[tauri::command]
pub async fn get_space_info(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<SpaceInfo, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&space_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let space = client.get_room(&parsed).ok_or("Space not found")?;

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
    let session = client.matrix_auth().session().ok_or("Not logged in")?;
    let homeserver = client.homeserver().to_string();
    let url = format!(
        "{}/_matrix/client/v1/rooms/{}/hierarchy?limit=50",
        homeserver.trim_end_matches('/'),
        space_id,
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header(
            "Authorization",
            format!("Bearer {}", session.tokens.access_token),
        )
        .send()
        .await
        .map_err(|e| format!("Hierarchy request failed: {}", fmt_error_chain(&e)))?;

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
    let mut media_base_url_cache = std::collections::HashMap::new();

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

            let mut name = room_data["name"].as_str().unwrap_or("Unnamed").to_string();
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
            let mut avatar_url = if membership == "joined" {
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
                match room_data["avatar_url"].as_str() {
                    Some(mxc) => {
                        mxc_to_discovered_thumbnail_url(
                            &state.http_client,
                            &mut media_base_url_cache,
                            mxc,
                            64,
                            64,
                        )
                        .await
                    }
                    None => None,
                }
            };

            let mut is_direct = false;
            let mut dm_peer_user_id: Option<String> = None;
            let mut dm_peer_presence: Option<String> = None;
            let mut dm_peer_status_msg: Option<String> = None;

            if membership == "joined" {
                if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(&child_id) {
                    if let Some(r) = client.get_room(&rid) {
                        if let Some((dname, dav, pid, pres, smsg)) =
                            dm_one_to_one_peer_summary(&r, &avatar_cache, &state.presence_map, &state.status_msg_map).await
                        {
                            name = dname;
                            avatar_url = dav;
                            is_direct = true;
                            dm_peer_user_id = Some(pid);
                            dm_peer_presence = Some(pres);
                            dm_peer_status_msg = smsg;
                        }
                    }
                }
            }

            children.push(SpaceChildInfo {
                id: child_id,
                name,
                topic,
                avatar_url,
                membership,
                join_rule,
                room_type,
                num_joined_members,
                is_direct,
                dm_peer_user_id,
                dm_peer_presence,
                dm_peer_status_msg,
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
        .map_err(|e| {
            format!(
                "Failed to get history visibility: {}",
                super::fmt_error_chain(&e)
            )
        })?;

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
        .map_err(|e| {
            format!(
                "Failed to send history visibility event: {}",
                super::fmt_error_chain(&e)
            )
        })?;

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

// ─── Space settings (edit existing space; excludes m.federate — immutable after creation) ───

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSettingsSnapshot {
    pub room_id: String,
    pub name: String,
    pub topic: String,
    pub avatar_url: Option<String>,
    pub join_rule: String,
    pub history_visibility: String,
    pub guest_access: String,
    pub listed_in_directory: bool,
    pub room_alias_local: Option<String>,
    pub homeserver_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSettingsPermissions {
    pub name: bool,
    pub topic: bool,
    pub avatar: bool,
    pub join_rules: bool,
    pub history_visibility: bool,
    pub guest_access: bool,
    pub directory_listing: bool,
    pub room_alias: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSettingsData {
    pub snapshot: SpaceSettingsSnapshot,
    pub permissions: SpaceSettingsPermissions,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySpaceSettingsPatch {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_data: Option<String>,
    pub avatar_mime: Option<String>,
    #[serde(default)]
    pub remove_avatar: bool,
    pub listed_in_directory: Option<bool>,
    pub join_rule: Option<String>,
    pub room_alias_local: Option<String>,
    pub history_visibility: Option<String>,
    pub guest_access: Option<String>,
}

fn homeserver_name_from_room_id(room_id: &str) -> String {
    room_id
        .rsplit_once(':')
        .map(|(_, s)| s.to_string())
        .unwrap_or_else(|| "localhost".to_string())
}

fn alias_local_part(canonical_alias: &str) -> Option<String> {
    let s = canonical_alias.strip_prefix('#')?;
    s.split_once(':').map(|(local, _)| local.to_string())
}

fn power_level_for_user(pl: &serde_json::Value, user_id: &str) -> i64 {
    pl.get("users")
        .and_then(|u| u.get(user_id))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("users_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        })
}

fn power_required_for_state_event(pl: &serde_json::Value, event_type: &str) -> i64 {
    pl.get("events")
        .and_then(|e| e.get(event_type))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("state_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(50)
        })
}

async fn http_get_room_state(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    room_id: &str,
    event_path: &str,
) -> Result<Option<serde_json::Value>, String> {
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        event_path
    );
    let resp = http_client
        .get(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("State GET failed: {}", fmt_error_chain(&e)))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("State GET error ({}): {}", status, t));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("State GET parse: {e}"))?;
    Ok(Some(body))
}

async fn http_put_room_state(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    room_id: &str,
    event_path: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        event_path
    );
    let resp = http_client
        .put(&state_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(body)
        .send()
        .await
        .map_err(|e| format!("State PUT failed: {}", fmt_error_chain(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("State PUT error ({}): {}", status, t));
    }
    Ok(())
}

/// Snapshot and per-field edit permissions for a space room (from `m.room.power_levels`).
#[tauri::command]
pub async fn get_space_settings(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<SpaceSettingsData, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&space_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client.get_room(&parsed).ok_or("Space not found")?;

    let user_id = client
        .user_id()
        .ok_or("No user ID")?
        .to_string();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');

    let pl_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.power_levels/",
    )
    .await?;

    let (_user_pl, perms) = if let Some(pl) = pl_body {
        let u = power_level_for_user(&pl, &user_id);
        let join_editable = {
            let jr = http_get_room_state(
                &state.http_client,
                hs_trim,
                &access_token,
                &space_id,
                "m.room.join_rules/",
            )
            .await
            .ok()
            .flatten();
            let rule = jr
                .as_ref()
                .and_then(|b| b.get("join_rule"))
                .and_then(|v| v.as_str())
                .unwrap_or("invite");
            matches!(rule, "public" | "invite" | "knock")
        };
        (
            u,
            SpaceSettingsPermissions {
                name: u >= power_required_for_state_event(&pl, "m.room.name"),
                topic: u >= power_required_for_state_event(&pl, "m.room.topic"),
                avatar: u >= power_required_for_state_event(&pl, "m.room.avatar"),
                join_rules: join_editable
                    && u >= power_required_for_state_event(&pl, "m.room.join_rules"),
                history_visibility: u
                    >= power_required_for_state_event(&pl, "m.room.history_visibility"),
                guest_access: u >= power_required_for_state_event(&pl, "m.room.guest_access"),
                directory_listing: u >= power_required_for_state_event(&pl, "m.room.join_rules"),
                room_alias: u >= power_required_for_state_event(&pl, "m.room.canonical_alias"),
            },
        )
    } else {
        (
            0i64,
            SpaceSettingsPermissions {
                name: false,
                topic: false,
                avatar: false,
                join_rules: false,
                history_visibility: false,
                guest_access: false,
                directory_listing: false,
                room_alias: false,
            },
        )
    };

    let name_state = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.name/",
    )
    .await?;
    let name = name_state
        .as_ref()
        .and_then(|b| b.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| room.name())
        .unwrap_or_else(|| "Unnamed".to_string());

    let topic_state = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.topic/",
    )
    .await?;
    let topic = topic_state
        .as_ref()
        .and_then(|b| b.get("topic"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let avatar_state = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.avatar/",
    )
    .await?;
    let avatar_mxc = avatar_state
        .as_ref()
        .and_then(|b| b.get("url"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let avatar_url = if let Some(mxc) = avatar_mxc {
        mxc_to_thumbnail_url(hs_trim, mxc, 96, 96)
    } else {
        get_or_fetch_avatar(
            room.avatar_url().as_deref(),
            room.avatar(matrix_sdk::media::MediaFormat::File),
            &state.avatar_cache,
        )
        .await
    };

    let join_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.join_rules/",
    )
    .await?;
    let join_rule = join_body
        .as_ref()
        .and_then(|b| b.get("join_rule"))
        .and_then(|v| v.as_str())
        .unwrap_or("invite")
        .to_string();

    let guest_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.guest_access/",
    )
    .await?;
    let guest_access = guest_body
        .as_ref()
        .and_then(|b| b.get("guest_access"))
        .and_then(|v| v.as_str())
        .unwrap_or("forbidden")
        .to_string();

    let history_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.history_visibility/",
    )
    .await?;
    let history_visibility = history_body
        .as_ref()
        .and_then(|b| b.get("history_visibility"))
        .and_then(|v| v.as_str())
        .unwrap_or("shared")
        .to_string();

    let dir_url = format!(
        "{}/_matrix/client/v3/directory/list/room/{}",
        hs_trim,
        urlencoding::encode(&space_id)
    );
    let listed_in_directory = match state
        .http_client
        .get(&dir_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|b| b.get("visibility").and_then(|v| v.as_str()).map(|v| v == "public"))
            .unwrap_or(false),
        _ => false,
    };

    let canon_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.canonical_alias/",
    )
    .await?;
    let room_alias_local = canon_body
        .as_ref()
        .and_then(|b| b.get("alias"))
        .and_then(|v| v.as_str())
        .and_then(|a| alias_local_part(a));

    let homeserver_name = homeserver_name_from_room_id(&space_id);

    Ok(SpaceSettingsData {
        snapshot: SpaceSettingsSnapshot {
            room_id: space_id.clone(),
            name,
            topic,
            avatar_url,
            join_rule,
            history_visibility,
            guest_access,
            listed_in_directory,
            room_alias_local,
            homeserver_name,
        },
        permissions: perms,
    })
}

/// Apply updates to space profile, join rules, directory listing, history, and guest access.
#[tauri::command]
pub async fn apply_space_settings(
    state: State<'_, Arc<AppState>>,
    space_id: String,
    patch: ApplySpaceSettingsPatch,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&space_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    client.get_room(&parsed).ok_or("Space not found")?;

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');
    let http = &state.http_client;

    if let Some(name) = &patch.name {
        let t = name.trim();
        if t.is_empty() {
            return Err("Space name cannot be empty.".to_string());
        }
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.name/",
            &serde_json::json!({ "name": t }),
        )
        .await?;
    }

    if let Some(topic) = &patch.topic {
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.topic/",
            &serde_json::json!({ "topic": topic }),
        )
        .await?;
    }

    if patch.remove_avatar {
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.avatar/",
            &serde_json::json!({}),
        )
        .await?;
    } else if let (Some(data), Some(mime)) = (&patch.avatar_data, &patch.avatar_mime) {
        let bytes = data_encoding::BASE64
            .decode(data.as_bytes())
            .map_err(|e| format!("Invalid base64 avatar data: {e}"))?;

        let upload_url = format!("{}/_matrix/media/v3/upload", hs_trim);
        let resp = http
            .post(&upload_url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(access_token.to_string())
            .header("Content-Type", mime.as_str())
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Avatar upload failed: {}", fmt_error_chain(&e)))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Avatar upload failed ({}): {}", status, text));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Upload response parse: {e}"))?;
        let mxc = body["content_uri"]
            .as_str()
            .ok_or("No content_uri in upload response")?;
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.avatar/",
            &serde_json::json!({ "url": mxc }),
        )
        .await?;
    }

    if let Some(jr) = &patch.join_rule {
        let valid = ["public", "invite", "knock"];
        if !valid.contains(&jr.as_str()) {
            return Err(format!(
                "Invalid join_rule '{}'. Must be one of: {}",
                jr,
                valid.join(", ")
            ));
        }
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.join_rules/",
            &serde_json::json!({ "join_rule": jr }),
        )
        .await?;
    }

    if let Some(ga) = &patch.guest_access {
        let valid = ["can_join", "forbidden"];
        if !valid.contains(&ga.as_str()) {
            return Err(format!(
                "Invalid guest_access '{}'. Must be one of: {}",
                ga,
                valid.join(", ")
            ));
        }
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.guest_access/",
            &serde_json::json!({ "guest_access": ga }),
        )
        .await?;
    }

    if let Some(hv) = &patch.history_visibility {
        set_history_visibility(state.clone(), space_id.clone(), hv.clone()).await?;
    }

    if let Some(local_raw) = &patch.room_alias_local {
        let local = local_raw.trim();
        if !local.is_empty() {
            let server = homeserver_name_from_room_id(&space_id);
            let alias = format!("#{local}:{server}");
            let encoded_alias = urlencoding::encode(&alias);

            // Create the alias mapping in the room directory first
            let alias_url = format!(
                "{}/_matrix/client/v3/directory/room/{}",
                hs_trim, encoded_alias
            );
            let alias_resp = http
                .put(&alias_url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(access_token.to_string())
                .json(&serde_json::json!({ "room_id": space_id }))
                .send()
                .await
                .map_err(|e| format!("Alias PUT failed: {}", fmt_error_chain(&e)))?;
            let alias_status = alias_resp.status();
            // 409 means alias already exists, which is fine
            if !alias_status.is_success() && alias_status.as_u16() != 409 {
                let t = alias_resp.text().await.unwrap_or_default();
                return Err(format!("Failed to create alias ({alias_status}): {t}"));
            }

            // Now set it as canonical
            http_put_room_state(
                http,
                hs_trim,
                &access_token,
                &space_id,
                "m.room.canonical_alias/",
                &serde_json::json!({ "alias": alias }),
            )
            .await?;
        }
    }

    if let Some(listed) = patch.listed_in_directory {
        let dir_url = format!(
            "{}/_matrix/client/v3/directory/list/room/{}",
            hs_trim,
            urlencoding::encode(&space_id)
        );
        if !listed {
            let resp = http
                .delete(&dir_url)
                .timeout(Duration::from_secs(30))
                .bearer_auth(access_token.to_string())
                .send()
                .await
                .map_err(|e| format!("Directory DELETE failed: {}", fmt_error_chain(&e)))?;
            let status = resp.status();
            if !status.is_success() && status.as_u16() != 404 {
                let t = resp.text().await.unwrap_or_default();
                return Err(format!("Directory DELETE ({}): {}", status, t));
            }
        } else {
            let body = serde_json::json!({ "visibility": "public" });
            let resp = http
                .put(&dir_url)
                .timeout(Duration::from_secs(30))
                .bearer_auth(access_token.to_string())
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Directory PUT failed: {}", fmt_error_chain(&e)))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let t = resp.text().await.unwrap_or_default();
                return Err(format!("Directory PUT ({}): {}", status, t));
            }
        }
    }

    log::info!("apply_space_settings: applied patch for room {}", space_id);
    Ok(())
}

/// Check whether the logged-in user is allowed to create rooms on the homeserver.
///
/// There is no standard Matrix client API to query this permission directly.
/// Synapse controls it via the `enable_room_creation` config (defaults to `true`).
/// We probe by inspecting the server capabilities endpoint and fall back to
/// assuming creation is allowed — the actual create request will fail with
/// `M_FORBIDDEN` if the server disallows it, and we surface that error in the UI.
#[tauri::command]
pub async fn can_create_rooms(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    let client = super::get_client(&state).await?;

    // The capabilities endpoint doesn't expose room creation directly, but if
    // we can reach it we know the session is valid. Room creation is almost
    // universally enabled, so default to true.
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let url = format!(
        "{}/_matrix/client/v3/capabilities",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => Ok(true),
        Ok(r) if r.status().as_u16() == 403 => Ok(false),
        Ok(_) => Ok(true), // Assume allowed if capabilities endpoint returns unexpected status
        Err(_) => Ok(true), // Network error — optimistic default
    }
}

/// Create a new Matrix space.
///
/// Calls `POST /_matrix/client/v3/createRoom` with `creation_content.type = "m.space"`.
/// If an avatar is provided (base64 + MIME), it is uploaded first and included
/// in the initial room state.
#[tauri::command]
pub async fn create_space(
    state: State<'_, Arc<AppState>>,
    name: String,
    topic: Option<String>,
    is_public: bool,
    room_alias: Option<String>,
    federate: bool,
    avatar_data: Option<String>,
    avatar_mime: Option<String>,
    history_visibility: Option<String>,
    guest_access: Option<String>,
    join_rule: Option<String>,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Upload avatar if provided, get MXC URI
    let avatar_mxc: Option<String> = if let (Some(data), Some(mime)) = (&avatar_data, &avatar_mime)
    {
        let bytes = data_encoding::BASE64
            .decode(data.as_bytes())
            .map_err(|e| format!("Invalid base64 avatar data: {e}"))?;

        let upload_url = format!(
            "{}/_matrix/media/v3/upload",
            homeserver.trim_end_matches('/')
        );

        let resp = state
            .http_client
            .post(&upload_url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(access_token.to_string())
            .header("Content-Type", mime.as_str())
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Failed to upload avatar: {}", super::fmt_error_chain(&e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Avatar upload failed ({}): {}", status, text));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse upload response: {e}"))?;

        body["content_uri"].as_str().map(|s| s.to_string())
    } else {
        None
    };

    // Build initial_state events
    let mut initial_state: Vec<serde_json::Value> = Vec::new();

    // Avatar state event
    if let Some(mxc) = &avatar_mxc {
        initial_state.push(serde_json::json!({
            "type": "m.room.avatar",
            "state_key": "",
            "content": {
                "url": mxc,
            }
        }));
    }

    // History visibility
    if let Some(hv) = &history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {
                    "history_visibility": hv,
                }
            }));
        }
    }

    // Guest access
    if let Some(ga) = &guest_access {
        let valid = ["can_join", "forbidden"];
        if valid.contains(&ga.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.guest_access",
                "state_key": "",
                "content": {
                    "guest_access": ga,
                }
            }));
        }
    }

    // Join rules (public, invite, knock)
    // The preset sets a default join rule, but an explicit initial_state overrides it.
    // For "knock", we use private_chat preset and override with the knock join rule.
    if let Some(jr) = &join_rule {
        let valid = ["public", "invite", "knock"];
        if valid.contains(&jr.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.join_rules",
                "state_key": "",
                "content": {
                    "join_rule": jr,
                }
            }));
        }
    }

    // Build createRoom request body
    // For knock join rule, use private_chat preset (closest match) and let
    // the m.room.join_rules initial state event override it.
    let effective_join_rule =
        join_rule
            .as_deref()
            .unwrap_or(if is_public { "public" } else { "invite" });
    let preset = if effective_join_rule == "public" {
        "public_chat"
    } else {
        "private_chat"
    };
    let visibility = if is_public { "public" } else { "private" };

    let mut body = serde_json::json!({
        "name": name,
        "preset": preset,
        "visibility": visibility,
        "creation_content": {
            "type": "m.space",
            "m.federate": federate,
        },
        "initial_state": initial_state,
        // Prevent regular messages in the space room — only admins should be
        // able to send events (matches Element's behaviour for spaces).
        "power_level_content_override": {
            "events_default": 100,
        },
    });

    if let Some(t) = &topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = &room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    // Send createRoom request
    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create space: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    let room_id = resp_body["room_id"]
        .as_str()
        .ok_or("No room_id in create response")?
        .to_string();

    log::info!(
        "create_space: created '{}' → {} (public={}, federate={})",
        name,
        room_id,
        is_public,
        federate,
    );

    Ok(room_id)
}

/// Create a nested Matrix space under a parent space.
///
/// Same options as [`create_space`], plus linking the new space to `parent_space_id`
/// via `m.space.parent` / `m.space.child`. Requires permission to send `m.space.child`
/// in the parent (same as [`create_room_in_space`]).
#[tauri::command]
pub async fn create_sub_space(
    state: State<'_, Arc<AppState>>,
    parent_space_id: String,
    name: String,
    topic: Option<String>,
    is_public: bool,
    room_alias: Option<String>,
    federate: bool,
    avatar_data: Option<String>,
    avatar_mime: Option<String>,
    history_visibility: Option<String>,
    guest_access: Option<String>,
    join_rule: Option<String>,
) -> Result<String, String> {
    if !can_manage_space_children_for_user(&state, &parent_space_id).await? {
        return Err(
            "You don't have permission to add rooms to this space (insufficient power level). Ask a space admin to raise your level or create the sub-space for you.".to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let server_name = parent_space_id
        .split(':')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    // Upload avatar if provided, get MXC URI
    let avatar_mxc: Option<String> = if let (Some(data), Some(mime)) = (&avatar_data, &avatar_mime)
    {
        let bytes = data_encoding::BASE64
            .decode(data.as_bytes())
            .map_err(|e| format!("Invalid base64 avatar data: {e}"))?;

        let upload_url = format!(
            "{}/_matrix/media/v3/upload",
            homeserver.trim_end_matches('/')
        );

        let resp = state
            .http_client
            .post(&upload_url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(access_token.to_string())
            .header("Content-Type", mime.as_str())
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Failed to upload avatar: {}", super::fmt_error_chain(&e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Avatar upload failed ({}): {}", status, text));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse upload response: {e}"))?;

        body["content_uri"].as_str().map(|s| s.to_string())
    } else {
        None
    };

    // Build initial_state events — parent link first, then same as create_space
    let mut initial_state: Vec<serde_json::Value> = Vec::new();

    initial_state.push(serde_json::json!({
        "type": "m.space.parent",
        "state_key": parent_space_id,
        "content": {
            "via": [server_name.clone()],
            "canonical": true,
        }
    }));

    if let Some(mxc) = &avatar_mxc {
        initial_state.push(serde_json::json!({
            "type": "m.room.avatar",
            "state_key": "",
            "content": {
                "url": mxc,
            }
        }));
    }

    if let Some(hv) = &history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {
                    "history_visibility": hv,
                }
            }));
        }
    }

    if let Some(ga) = &guest_access {
        let valid = ["can_join", "forbidden"];
        if valid.contains(&ga.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.guest_access",
                "state_key": "",
                "content": {
                    "guest_access": ga,
                }
            }));
        }
    }

    if let Some(jr) = &join_rule {
        let valid = ["public", "invite", "knock"];
        if valid.contains(&jr.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.join_rules",
                "state_key": "",
                "content": {
                    "join_rule": jr,
                }
            }));
        }
    }

    let effective_join_rule =
        join_rule
            .as_deref()
            .unwrap_or(if is_public { "public" } else { "invite" });
    let preset = if effective_join_rule == "public" {
        "public_chat"
    } else {
        "private_chat"
    };
    let visibility = if is_public { "public" } else { "private" };

    let mut body = serde_json::json!({
        "name": name,
        "preset": preset,
        "visibility": visibility,
        "creation_content": {
            "type": "m.space",
            "m.federate": federate,
        },
        "initial_state": initial_state,
        "power_level_content_override": {
            "events_default": 100,
        },
    });

    if let Some(t) = &topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = &room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create space: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    let room_id = resp_body["room_id"]
        .as_str()
        .ok_or("No room_id in create response")?
        .to_string();

    let child_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.child/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&parent_space_id),
        urlencoding::encode(&room_id),
    );

    let child_content = serde_json::json!({
        "via": [server_name],
        "suggested": false,
    });

    let child_resp = state
        .http_client
        .put(&child_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&child_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Space created but failed to link to parent: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !child_resp.status().is_success() {
        let status = child_resp.status();
        let text = child_resp.text().await.unwrap_or_default();
        log::warn!(
            "create_sub_space: m.space.child failed ({}): {} — room {} exists but is unlinked",
            status,
            text,
            room_id
        );
        return Err(format!(
            "Space created ({}) but linking to parent failed ({}): {}",
            room_id, status, text
        ));
    }

    log::info!(
        "create_sub_space: created '{}' → {} under parent {}",
        name,
        room_id,
        parent_space_id
    );

    Ok(room_id)
}

/// Check whether the logged-in user has permission to add/remove children
/// in a space (i.e. can send `m.space.child` state events).
///
/// Compares the user's power level against the level required for
/// `m.space.child` in the space's `m.room.power_levels` state.
async fn can_manage_space_children_for_user(
    state: &AppState,
    space_id: &str,
) -> Result<bool, String> {
    let client = super::get_client(state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Fetch m.room.power_levels from the space
    let pl_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.power_levels/",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(space_id),
    );

    let resp = state
        .http_client
        .get(&pl_url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to fetch power levels: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !resp.status().is_success() {
        // If we can't read power levels, assume no permission
        return Ok(false);
    }

    let pl: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse power levels: {e}"))?;

    // Determine the required power level for m.space.child state events.
    // Check events["m.space.child"] first, then fall back to state_default (spec default 50).
    let required = pl
        .get("events")
        .and_then(|e| e.get("m.space.child"))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("state_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(50)
        });

    // Determine this user's power level.
    // Check users[user_id] first, then fall back to users_default (spec default 0).
    let user_id_str = user_id.to_string();
    let user_pl = pl
        .get("users")
        .and_then(|u| u.get(&user_id_str))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("users_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        });

    Ok(user_pl >= required)
}

#[tauri::command]
pub async fn can_manage_space_children(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<bool, String> {
    can_manage_space_children_for_user(&state, &space_id).await
}

/// Create a new room and add it as a child of the specified space.
///
/// Creates the room via `POST /createRoom`, then sends an `m.space.child`
/// state event in the parent space and an `m.space.parent` state event
/// in the new room to link them bidirectionally.
///
/// `space_room_access` controls directory visibility and join rules:
/// - `space_members` (default): not in the public directory; joined members of
///   the parent space may join without an invite (`join_rule: restricted`).
/// - `public`: public directory + open join.
/// - `invite`: not in the public directory; invite-only.
#[tauri::command]
pub async fn create_room_in_space(
    state: State<'_, Arc<AppState>>,
    space_id: String,
    name: String,
    topic: Option<String>,
    space_room_access: String,
    room_type: Option<String>,
    room_alias: Option<String>,
    history_visibility: Option<String>,
) -> Result<String, String> {
    if !can_manage_space_children_for_user(&state, &space_id).await? {
        return Err(
            "You don't have permission to add rooms to this space (insufficient power level). Ask a space admin to raise your level or create the channel for you.".to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Derive the server name from the space ID (e.g. "!abc:matrix.example.com" → "matrix.example.com")
    let server_name = space_id
        .split(':')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    // Build initial state
    let mut initial_state: Vec<serde_json::Value> = Vec::new();

    // Link back to the parent space
    initial_state.push(serde_json::json!({
        "type": "m.space.parent",
        "state_key": space_id,
        "content": {
            "via": [server_name.clone()],
            "canonical": true,
        }
    }));

    let access = space_room_access.trim().to_ascii_lowercase();
    let access = match access.as_str() {
        "public" => "public",
        "invite" => "invite",
        _ => "space_members",
    };

    // Restricted join: members of the parent space can join without an invite.
    // Use private_chat preset and override join_rules (same idea as knock in create_space).
    if access == "space_members" {
        initial_state.push(serde_json::json!({
            "type": "m.room.join_rules",
            "state_key": "",
            "content": {
                "join_rule": "restricted",
                "allow": [
                    {
                        "type": "m.room_membership",
                        "room_id": space_id,
                    }
                ]
            }
        }));
    }

    // History visibility
    if let Some(hv) = &history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {
                    "history_visibility": hv,
                }
            }));
        }
    }

    // Build createRoom body
    let (preset, visibility) = match access {
        "public" => ("public_chat", "public"),
        _ => ("private_chat", "private"),
    };

    let mut body = serde_json::json!({
        "name": name,
        "preset": preset,
        "visibility": visibility,
        "initial_state": initial_state,
    });

    // Room versions that support restricted join rules (MSC3083).
    if access == "space_members" {
        body["room_version"] = serde_json::json!("10");
    }

    if let Some(t) = &topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = &room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    // Set room type in creation_content if specified (e.g. voice room)
    if let Some(rt) = &room_type {
        if !rt.is_empty() {
            body["creation_content"] = serde_json::json!({
                "type": rt,
            });
        }
    }

    // Create the room
    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create room: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    let new_room_id = resp_body["room_id"]
        .as_str()
        .ok_or("No room_id in create response")?
        .to_string();

    // Add the new room as a child of the space via m.space.child state event
    let child_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.child/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&space_id),
        urlencoding::encode(&new_room_id),
    );

    let child_content = serde_json::json!({
        "via": [server_name],
        "suggested": false,
    });

    let child_resp = state
        .http_client
        .put(&child_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&child_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Room created but failed to link to space: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !child_resp.status().is_success() {
        let status = child_resp.status();
        let text = child_resp.text().await.unwrap_or_default();
        log::warn!(
            "create_room_in_space: m.space.child failed ({}): {} — room {} exists but is unlinked",
            status,
            text,
            new_room_id
        );
        return Err(format!(
            "Room created ({}) but linking to space failed ({}): {}",
            new_room_id, status, text
        ));
    }

    log::info!(
        "create_room_in_space: created '{}' → {} in space {} (access={}, type={:?})",
        name,
        new_room_id,
        space_id,
        access,
        room_type,
    );

    Ok(new_room_id)
}

/// Create a normal room not attached to any space (appears under the global Home list).
///
/// `room_access` matches [`create_room_in_space`] semantics except `space_members` is treated as
/// a private room (not in the public directory; invite to join), since there is no parent space.
#[tauri::command]
pub async fn create_standalone_room(
    state: State<'_, Arc<AppState>>,
    name: String,
    topic: Option<String>,
    room_access: String,
    room_type: Option<String>,
    room_alias: Option<String>,
    history_visibility: Option<String>,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let mut initial_state: Vec<serde_json::Value> = Vec::new();

    let access = room_access.trim().to_ascii_lowercase();
    let access = match access.as_str() {
        "public" => "public",
        "invite" => "invite",
        _ => "private", // space_members or unknown: private chat, not in public directory
    };

    let (preset, visibility) = match access {
        "public" => ("public_chat", "public"),
        _ => ("private_chat", "private"),
    };

    if let Some(hv) = &history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {
                    "history_visibility": hv,
                }
            }));
        }
    }

    let mut body = serde_json::json!({
        "name": name,
        "preset": preset,
        "visibility": visibility,
        "initial_state": initial_state,
    });

    if let Some(t) = &topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = &room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    if let Some(rt) = &room_type {
        if !rt.is_empty() {
            body["creation_content"] = serde_json::json!({
                "type": rt,
            });
        }
    }

    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create room: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    let new_room_id = resp_body["room_id"]
        .as_str()
        .ok_or("No room_id in create response")?
        .to_string();

    log::info!(
        "create_standalone_room: created '{}' → {} (access={}, type={:?})",
        name,
        new_room_id,
        access,
        room_type,
    );

    Ok(new_room_id)
}

/// Link an existing room or sub-space to a parent space via `m.space.parent` / `m.space.child`.
///
/// The user must be able to send `m.space.child` in the parent and `m.space.parent` in the
/// child (typically admin in both rooms).
#[tauri::command]
pub async fn link_room_to_space(
    state: State<'_, Arc<AppState>>,
    parent_space_id: String,
    child_room_id: String,
) -> Result<(), String> {
    if parent_space_id == child_room_id {
        return Err("Cannot link a room to itself.".to_string());
    }

    if !can_manage_space_children_for_user(&state, &parent_space_id).await? {
        return Err(
            "You don't have permission to add rooms to this space (insufficient power level)."
                .to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let server_name = parent_space_id
        .split(':')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    // 1) Child points to parent (same shape as create_room_in_space / create_sub_space)
    let parent_state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.parent/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&child_room_id),
        urlencoding::encode(&parent_space_id),
    );

    let parent_content = serde_json::json!({
        "via": [server_name.clone()],
        "canonical": true,
    });

    let parent_resp = state
        .http_client
        .put(&parent_state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&parent_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to link room to parent space: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !parent_resp.status().is_success() {
        let status = parent_resp.status();
        let text = parent_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Could not add parent link in the room ({}): {}",
            status, text
        ));
    }

    // 2) Parent lists child
    let child_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.child/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&parent_space_id),
        urlencoding::encode(&child_room_id),
    );

    let child_content = serde_json::json!({
        "via": [server_name],
        "suggested": false,
    });

    let child_resp = state
        .http_client
        .put(&child_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&child_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Parent link was set but failed to update the space: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !child_resp.status().is_success() {
        let status = child_resp.status();
        let text = child_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Room was linked in the child room but updating the space failed ({}): {}",
            status, text
        ));
    }

    log::info!(
        "link_room_to_space: linked {} as child of {}",
        child_room_id,
        parent_space_id
    );

    Ok(())
}

/// Search the public room directory for spaces.
///
/// Uses `POST /publicRooms` with `filter.room_types: ["m.space"]` to find
/// only spaces. Supports an optional search term and a `server` parameter
/// to browse a remote server's directory over federation.
fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn parse_server_input_url(input: &str) -> Option<reqwest::Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(url) = reqwest::Url::parse(trimmed) {
        return Some(url);
    }

    reqwest::Url::parse(&format!("https://{trimmed}")).ok()
}

fn normalize_server_name(input: &str) -> Option<String> {
    let url = parse_server_input_url(input)?;
    let host = url.host_str()?.to_string();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

fn canonicalize_homeserver_base_url(input: &str) -> Option<String> {
    let mut url = parse_server_input_url(input)?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn discovery_hosts_for_server_input(input: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let Some(url) = parse_server_input_url(input) else {
        return hosts;
    };
    let Some(host) = url.host_str() else {
        return hosts;
    };

    push_unique(&mut hosts, host.to_string());
    if let Some(stripped) = host.strip_prefix("matrix.") {
        push_unique(&mut hosts, stripped.to_string());
    }

    hosts
}

async fn parse_public_rooms_response(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Public rooms query failed ({}): {}", status, text));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse public rooms response: {e}"))
}

fn public_room_matches_search(room_data: &serde_json::Value, search_term: Option<&str>) -> bool {
    let Some(term) = search_term else {
        return true;
    };

    [
        room_data["name"].as_str(),
        room_data["topic"].as_str(),
        room_data["canonical_alias"].as_str(),
        room_data["room_id"].as_str(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(term))
}

fn enrich_public_rooms_with_membership(
    client: &Client,
    mut result: serde_json::Value,
) -> serde_json::Value {
    let Some(chunk) = result["chunk"].as_array().cloned() else {
        return result;
    };

    let mut enriched = Vec::new();
    for room_data in &chunk {
        let mut entry = room_data.clone();
        let room_id = room_data["room_id"].as_str().unwrap_or("");
        let membership = if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(room_id) {
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
        };
        entry["membership"] = serde_json::json!(membership);
        enriched.push(entry);
    }

    result["chunk"] = serde_json::json!(enriched);
    result
}

async fn normalize_public_room_avatar_urls(
    http_client: &reqwest::Client,
    mut result: serde_json::Value,
) -> serde_json::Value {
    let Some(chunk) = result["chunk"].as_array().cloned() else {
        return result;
    };

    let mut normalized = Vec::new();
    let mut media_base_url_cache = std::collections::HashMap::new();

    for room_data in chunk {
        let mut entry = room_data.clone();
        if let Some(mxc) = room_data["avatar_url"].as_str() {
            if let Some(url) = mxc_to_discovered_thumbnail_url(
                http_client,
                &mut media_base_url_cache,
                mxc,
                64,
                64,
            )
            .await
            {
                entry["avatar_url"] = serde_json::json!(url);
            }
        }
        normalized.push(entry);
    }

    result["chunk"] = serde_json::json!(normalized);
    result
}

async fn discover_federation_server_names(
    http_client: &reqwest::Client,
    server_input: &str,
) -> Vec<String> {
    let mut federation_servers = Vec::new();

    let Some(url) = parse_server_input_url(server_input) else {
        return federation_servers;
    };
    let Some(host) = url.host_str() else {
        return federation_servers;
    };

    let stripped_host = host.strip_prefix("matrix.").map(str::to_string);

    if let Some(apex) = &stripped_host {
        let well_known_url = format!("https://{apex}/.well-known/matrix/server");
        match http_client
            .get(&well_known_url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
                Ok(body) => {
                    push_unique(&mut federation_servers, apex.clone());
                    if let Some(advertised) = body["m.server"].as_str() {
                        push_unique(&mut federation_servers, advertised.to_string());
                    }
                }
                Err(e) => {
                    log::warn!(
                        "search_public_spaces: failed to parse {well_known_url}: {e}"
                    );
                }
            },
            Ok(resp) => {
                log::debug!(
                    "search_public_spaces: {} returned {}",
                    well_known_url,
                    resp.status()
                );
            }
            Err(e) => {
                log::debug!(
                    "search_public_spaces: failed to fetch {}: {}",
                    well_known_url,
                    fmt_error_chain(&e)
                );
            }
        }
    }

    let well_known_url = format!("https://{host}/.well-known/matrix/server");
    match http_client
        .get(&well_known_url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                if let Some(normalized) = normalize_server_name(server_input) {
                    push_unique(&mut federation_servers, normalized);
                }
                if let Some(advertised) = body["m.server"].as_str() {
                    push_unique(&mut federation_servers, advertised.to_string());
                }
            }
            Err(e) => {
                log::warn!(
                    "search_public_spaces: failed to parse {well_known_url}: {e}"
                );
            }
        },
        Ok(resp) => {
            log::debug!(
                "search_public_spaces: {} returned {}",
                well_known_url,
                resp.status()
            );
        }
        Err(e) => {
            log::debug!(
                "search_public_spaces: failed to fetch {}: {}",
                well_known_url,
                fmt_error_chain(&e)
            );
        }
    }

    if let Some(normalized) = normalize_server_name(server_input) {
        push_unique(&mut federation_servers, normalized);
    }

    federation_servers
}

async fn discover_client_base_urls(
    http_client: &reqwest::Client,
    server_input: &str,
) -> Vec<String> {
    let mut base_urls = Vec::new();

    for host in discovery_hosts_for_server_input(server_input) {
        let well_known_url = format!("https://{host}/.well-known/matrix/client");
        match http_client
            .get(&well_known_url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
                Ok(body) => {
                    if let Some(base_url) = body["m.homeserver"]["base_url"].as_str() {
                        if let Some(normalized) = canonicalize_homeserver_base_url(base_url) {
                            push_unique(&mut base_urls, normalized);
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "search_public_spaces: failed to parse {well_known_url}: {e}"
                    );
                }
            },
            Ok(resp) => {
                log::debug!(
                    "search_public_spaces: {} returned {}",
                    well_known_url,
                    resp.status()
                );
            }
            Err(e) => {
                log::debug!(
                    "search_public_spaces: failed to fetch {}: {}",
                    well_known_url,
                    fmt_error_chain(&e)
                );
            }
        }
    }

    if let Some(base_url) = canonicalize_homeserver_base_url(server_input) {
        push_unique(&mut base_urls, base_url);
    }

    base_urls
}

async fn search_public_spaces_direct_fallback(
    state: &AppState,
    base_urls: &[String],
    server_input: &str,
    search_term: Option<&str>,
    limit: u32,
) -> Result<serde_json::Value, String> {
    if base_urls.is_empty() {
        return Err(format!(
            "No direct homeserver URL could be discovered for {}",
            server_input
        ));
    }

    let normalized_search_term = search_term.map(|term| term.to_lowercase());
    let per_page = limit.max(50).min(100);
    let max_pages = if normalized_search_term.is_some() { 5 } else { 2 };
    let mut last_err: Option<String> = None;

    'base_urls: for base_url in base_urls {
        let mut matched_spaces = Vec::new();
        let mut next_batch: Option<String> = None;
        let mut saw_success = false;

        for _ in 0..max_pages {
            let mut url = format!("{}/_matrix/client/v3/publicRooms?limit={}", base_url, per_page);
            if let Some(since) = &next_batch {
                url.push_str("&since=");
                url.push_str(&urlencoding::encode(since));
            }

            let resp = match state
                .http_client
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    let err = format!("Direct public rooms query failed: {}", fmt_error_chain(&e));
                    if saw_success {
                        log::warn!("search_public_spaces: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                let text = resp.text().await.unwrap_or_default();
                let err = format!(
                    "Remote homeserver does not allow unauthenticated direct /publicRooms lookup (401 Unauthorized): {}",
                    text
                );
                if saw_success {
                    log::warn!("search_public_spaces: {err}");
                    break;
                }
                last_err = Some(err);
                continue 'base_urls;
            }

            let body = match parse_public_rooms_response(resp).await {
                Ok(body) => body,
                Err(err) => {
                    if saw_success {
                        log::warn!("search_public_spaces: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            saw_success = true;

            if let Some(chunk) = body["chunk"].as_array() {
                for room_data in chunk {
                    if room_data["room_type"].as_str() != Some("m.space") {
                        continue;
                    }
                    if !public_room_matches_search(
                        room_data,
                        normalized_search_term.as_deref(),
                    ) {
                        continue;
                    }
                    matched_spaces.push(room_data.clone());
                    if matched_spaces.len() >= limit as usize {
                        break;
                    }
                }
            }

            if matched_spaces.len() >= limit as usize {
                break;
            }

            next_batch = body["next_batch"].as_str().map(String::from);
            if next_batch.is_none() {
                break;
            }
        }

        if saw_success {
            return Ok(serde_json::json!({ "chunk": matched_spaces }));
        }
    }

    Err(last_err.unwrap_or_else(|| {
        format!("Direct public rooms lookup failed for {}", server_input)
    }))
}

/// Remove spaces from a `publicRooms` chunk so the directory lists chat/voice rooms only.
fn filter_public_chunk_exclude_spaces(mut result: serde_json::Value) -> serde_json::Value {
    let Some(chunk) = result["chunk"].as_array().cloned() else {
        return result;
    };
    let filtered: Vec<_> = chunk
        .into_iter()
        .filter(|r| r["room_type"].as_str() != Some("m.space"))
        .collect();
    result["chunk"] = serde_json::json!(filtered);
    result
}

async fn search_public_rooms_direct_fallback(
    state: &AppState,
    base_urls: &[String],
    server_input: &str,
    search_term: Option<&str>,
    limit: u32,
) -> Result<serde_json::Value, String> {
    if base_urls.is_empty() {
        return Err(format!(
            "No direct homeserver URL could be discovered for {}",
            server_input
        ));
    }

    let normalized_search_term = search_term.map(|term| term.to_lowercase());
    let per_page = limit.max(50).min(100);
    let max_pages = if normalized_search_term.is_some() { 5 } else { 2 };
    let mut last_err: Option<String> = None;

    'base_urls: for base_url in base_urls {
        let mut matched_rooms = Vec::new();
        let mut next_batch: Option<String> = None;
        let mut saw_success = false;

        for _ in 0..max_pages {
            let mut url = format!("{}/_matrix/client/v3/publicRooms?limit={}", base_url, per_page);
            if let Some(since) = &next_batch {
                url.push_str("&since=");
                url.push_str(&urlencoding::encode(since));
            }

            let resp = match state
                .http_client
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    let err = format!("Direct public rooms query failed: {}", fmt_error_chain(&e));
                    if saw_success {
                        log::warn!("search_public_rooms: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                let text = resp.text().await.unwrap_or_default();
                let err = format!(
                    "Remote homeserver does not allow unauthenticated direct /publicRooms lookup (401 Unauthorized): {}",
                    text
                );
                if saw_success {
                    log::warn!("search_public_rooms: {err}");
                    break;
                }
                last_err = Some(err);
                continue 'base_urls;
            }

            let body = match parse_public_rooms_response(resp).await {
                Ok(body) => body,
                Err(err) => {
                    if saw_success {
                        log::warn!("search_public_rooms: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            saw_success = true;

            if let Some(chunk) = body["chunk"].as_array() {
                for room_data in chunk {
                    if room_data["room_type"].as_str() == Some("m.space") {
                        continue;
                    }
                    if !public_room_matches_search(
                        room_data,
                        normalized_search_term.as_deref(),
                    ) {
                        continue;
                    }
                    matched_rooms.push(room_data.clone());
                    if matched_rooms.len() >= limit as usize {
                        break;
                    }
                }
            }

            if matched_rooms.len() >= limit as usize {
                break;
            }

            next_batch = body["next_batch"].as_str().map(String::from);
            if next_batch.is_none() {
                break;
            }
        }

        if saw_success {
            return Ok(serde_json::json!({ "chunk": matched_rooms }));
        }
    }

    Err(last_err.unwrap_or_else(|| {
        format!("Direct public rooms lookup failed for {}", server_input)
    }))
}

#[tauri::command]
pub async fn search_public_spaces(
    state: State<'_, Arc<AppState>>,
    search_term: Option<String>,
    server: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let search_term = search_term
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty());
    let server = server
        .map(|server| server.trim().to_string())
        .filter(|server| !server.is_empty());

    let mut filter = serde_json::json!({
        "room_types": ["m.space"],
    });
    if let Some(term) = &search_term {
        filter["generic_search_term"] = serde_json::json!(term);
    }

    let body = serde_json::json!({
        "filter": filter,
        "limit": limit,
    });

    if let Some(server_input) = server.as_deref() {
        let federation_servers =
            discover_federation_server_names(&state.http_client, server_input).await;
        let direct_base_urls = discover_client_base_urls(&state.http_client, server_input).await;
        let mut last_federation_err: Option<String> = None;

        for federation_server in federation_servers {
            let url = format!(
                "{}/_matrix/client/v3/publicRooms?server={}",
                homeserver.trim_end_matches('/'),
                urlencoding::encode(&federation_server)
            );

            let result = match state
                .http_client
                .post(&url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(&access_token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) => parse_public_rooms_response(resp).await,
                Err(e) => Err(format!(
                    "Failed to search public spaces: {}",
                    super::fmt_error_chain(&e)
                )),
            };

            match result {
                Ok(result) => {
                    let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
                    return Ok(enrich_public_rooms_with_membership(&client, result));
                }
                Err(err) => {
                    log::warn!(
                        "search_public_spaces: federation lookup via '{}' failed: {}",
                        federation_server,
                        err
                    );
                    last_federation_err = Some(format!(
                        "Federated public rooms query failed via {}: {}",
                        federation_server, err
                    ));
                }
            }
        }

        let primary_err = last_federation_err.unwrap_or_else(|| {
            format!(
                "Failed to resolve a federation server name for {}",
                server_input
            )
        });

        match search_public_spaces_direct_fallback(
            &state,
            &direct_base_urls,
            server_input,
            search_term.as_deref(),
            limit,
        )
        .await
        {
            Ok(result) => {
                let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
                Ok(enrich_public_rooms_with_membership(&client, result))
            }
            Err(fallback_err) => Err(format!(
                "{} | Direct lookup fallback failed: {}",
                primary_err, fallback_err
            )),
        }
    } else {
        let url = format!(
            "{}/_matrix/client/v3/publicRooms",
            homeserver.trim_end_matches('/')
        );

        let result = match state
            .http_client
            .post(&url)
            .timeout(Duration::from_secs(15))
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => parse_public_rooms_response(resp).await,
            Err(e) => Err(format!(
                "Failed to search public spaces: {}",
                super::fmt_error_chain(&e)
            )),
        }?;

        let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
        Ok(enrich_public_rooms_with_membership(&client, result))
    }
}

/// Search the public room directory for non-space rooms (chat/voice).
///
/// Uses `POST /publicRooms` without `room_types`, then drops `m.space` entries.
#[tauri::command]
pub async fn search_public_rooms(
    state: State<'_, Arc<AppState>>,
    search_term: Option<String>,
    server: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let search_term = search_term
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty());
    let server = server
        .map(|server| server.trim().to_string())
        .filter(|server| !server.is_empty());

    let mut filter = serde_json::json!({});
    if let Some(term) = &search_term {
        filter["generic_search_term"] = serde_json::json!(term);
    }

    let body = serde_json::json!({
        "filter": filter,
        "limit": limit,
    });

    if let Some(server_input) = server.as_deref() {
        let federation_servers =
            discover_federation_server_names(&state.http_client, server_input).await;
        let direct_base_urls = discover_client_base_urls(&state.http_client, server_input).await;
        let mut last_federation_err: Option<String> = None;

        for federation_server in federation_servers {
            let url = format!(
                "{}/_matrix/client/v3/publicRooms?server={}",
                homeserver.trim_end_matches('/'),
                urlencoding::encode(&federation_server)
            );

            let result = match state
                .http_client
                .post(&url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(&access_token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) => parse_public_rooms_response(resp).await,
                Err(e) => Err(format!(
                    "Failed to search public rooms: {}",
                    super::fmt_error_chain(&e)
                )),
            };

            match result {
                Ok(result) => {
                    let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
                    let result = filter_public_chunk_exclude_spaces(result);
                    return Ok(enrich_public_rooms_with_membership(&client, result));
                }
                Err(err) => {
                    log::warn!(
                        "search_public_rooms: federation lookup via '{}' failed: {}",
                        federation_server,
                        err
                    );
                    last_federation_err = Some(format!(
                        "Federated public rooms query failed via {}: {}",
                        federation_server, err
                    ));
                }
            }
        }

        let primary_err = last_federation_err.unwrap_or_else(|| {
            format!(
                "Failed to resolve a federation server name for {}",
                server_input
            )
        });

        match search_public_rooms_direct_fallback(
            &state,
            &direct_base_urls,
            server_input,
            search_term.as_deref(),
            limit,
        )
        .await
        {
            Ok(result) => {
                let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
                Ok(enrich_public_rooms_with_membership(&client, result))
            }
            Err(fallback_err) => Err(format!(
                "{} | Direct lookup fallback failed: {}",
                primary_err, fallback_err
            )),
        }
    } else {
        let url = format!(
            "{}/_matrix/client/v3/publicRooms",
            homeserver.trim_end_matches('/')
        );

        let result = match state
            .http_client
            .post(&url)
            .timeout(Duration::from_secs(15))
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => parse_public_rooms_response(resp).await,
            Err(e) => Err(format!(
                "Failed to search public rooms: {}",
                super::fmt_error_chain(&e)
            )),
        }?;

        let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
        let result = filter_public_chunk_exclude_spaces(result);
        Ok(enrich_public_rooms_with_membership(&client, result))
    }
}

/// Resolve a room alias (e.g. `#my-space:example.com`) to its room ID.
///
/// Uses `GET /directory/room/{roomAlias}` which works across federation.
#[tauri::command]
pub async fn resolve_room_alias(
    state: State<'_, Arc<AppState>>,
    alias: String,
) -> Result<serde_json::Value, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let url = format!(
        "{}/_matrix/client/v3/directory/room/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&alias),
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("Failed to resolve alias: {}", super::fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Alias not found ({}): {}", status, text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse alias response: {e}"))?;

    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_homeserver_base_url, discovery_hosts_for_server_input,
        discover_federation_server_names, normalize_server_name, public_room_matches_search,
    };

    #[test]
    fn normalizes_server_name_from_plain_host_or_url() {
        assert_eq!(
            normalize_server_name("matrix.tchncs.de"),
            Some("matrix.tchncs.de".to_string())
        );
        assert_eq!(
            normalize_server_name("https://matrix.4d2.org/"),
            Some("matrix.4d2.org".to_string())
        );
        assert_eq!(
            normalize_server_name("https://matrix.grin.hu:8448/foo"),
            Some("matrix.grin.hu:8448".to_string())
        );
    }

    #[test]
    fn preserves_homeserver_base_url_path_when_present() {
        assert_eq!(
            canonicalize_homeserver_base_url("https://example.com/matrix/"),
            Some("https://example.com/matrix".to_string())
        );
    }

    #[test]
    fn includes_apex_domain_for_matrix_subdomains() {
        assert_eq!(
            discovery_hosts_for_server_input("matrix.tchncs.de"),
            vec!["matrix.tchncs.de".to_string(), "tchncs.de".to_string()]
        );
    }

    #[test]
    fn matches_search_against_space_metadata() {
        let room = serde_json::json!({
            "name": "Privacy Guides",
            "topic": "Security and privacy discussions",
            "canonical_alias": "#privacy:privacyguides.org",
            "room_id": "!abc:privacyguides.org",
        });

        assert!(public_room_matches_search(&room, Some("privacy")));
        assert!(public_room_matches_search(&room, Some("security")));
        assert!(public_room_matches_search(&room, Some("!abc")));
        assert!(!public_room_matches_search(&room, Some("matrix.org")));
    }

    #[tokio::test]
    async fn prefers_apex_federation_server_name_for_matrix_subdomains() {
        let client = reqwest::Client::new();
        let candidates = discover_federation_server_names(&client, "matrix.tchncs.de").await;

        assert!(!candidates.is_empty());
        assert_eq!(candidates[0], "tchncs.de".to_string());
    }

    #[test]
    fn extracts_server_name_from_matrix_identifiers_with_rsplit_once() {
        assert_eq!(
            "!MfAmcoFvXtYUOhFCRt:4d2.org".rsplit_once(':').map(|(_, s)| s),
            Some("4d2.org")
        );
        assert_eq!(
            "#tune-zone:4d2.org".rsplit_once(':').map(|(_, s)| s),
            Some("4d2.org")
        );
    }
}
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::{Client, SessionMeta};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::time::timeout;

use crate::AppState;

use super::fmt_error_chain;

const CREDENTIALS_FILENAME: &str = "credentials.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedCredentials {
    pub homeserver: String,
    #[serde(default)]
    pub session: Option<SavedSession>,
    /// Relative path under app data dir for the Matrix SDK SQLite store (password logins use a new subdir each time).
    #[serde(default)]
    pub sqlite_store_dir: Option<String>,
}

/// Best-effort: delete every Matrix SDK SQLite directory except `keep_sqlite_relative`
/// (relative to app data, `/`-separated, e.g. `matrix_sessions/pw_<uuid>`).
/// Runs in the background so login/register return immediately.
pub(crate) fn spawn_cleanup_stale_matrix_stores(
    app: tauri::AppHandle,
    keep_sqlite_relative: String,
) {
    tauri::async_runtime::spawn(async move {
        let res = tokio::task::spawn_blocking(move || {
            let Ok(base) = app.path().app_data_dir() else {
                return;
            };
            let keep_norm = keep_sqlite_relative
                .replace('\\', "/")
                .trim_matches('/')
                .to_string();

            // Legacy single-directory layout
            let legacy = base.join("matrix_store");
            if legacy.exists() && keep_norm != "matrix_store" {
                if let Err(e) = std::fs::remove_dir_all(&legacy) {
                    log::debug!("cleanup: could not remove legacy matrix_store: {e}");
                }
            }

            let sessions = base.join("matrix_sessions");
            let Ok(read_dir) = std::fs::read_dir(&sessions) else {
                return;
            };
            for ent in read_dir.flatten() {
                let Ok(ft) = ent.file_type() else {
                    continue;
                };
                if !ft.is_dir() {
                    continue;
                }
                let name = ent.file_name().to_string_lossy().into_owned();
                if !name.starts_with("pw_") {
                    continue;
                }
                let rel = format!("matrix_sessions/{name}").replace('\\', "/");
                if rel == keep_norm {
                    continue;
                }
                if let Err(e) = std::fs::remove_dir_all(ent.path()) {
                    log::debug!("cleanup: could not remove {rel}: {e}");
                }
            }
        })
        .await;
        if let Err(e) = res {
            log::debug!("cleanup: spawn_blocking join error: {e}");
        }
    });
}

fn credentials_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir.join(CREDENTIALS_FILENAME))
}

#[tauri::command]
pub async fn logout(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    // Tell the server we're offline BEFORE tearing anything down, while the
    // client and access token still exist.
    //
    // Cap wait time: a stuck homeserver must not block sign-out indefinitely
    // (the UI awaits this command before clearing session state).
    let presence_deadline = Duration::from_secs(3);
    let send_offline = async {
        if let Some(client) = state.client.lock().await.as_ref() {
            if let Some(user_id) = client.user_id() {
                let request =
                    matrix_sdk::ruma::api::client::presence::set_presence::v3::Request::new(
                        user_id.to_owned(),
                        matrix_sdk::ruma::presence::PresenceState::Offline,
                    );
                let _ = client.send(request).await;
            }
        }
    };
    if timeout(presence_deadline, send_offline).await.is_err() {
        log::warn!(
            "logout: presence set_offline timed out after {:?}, continuing teardown",
            presence_deadline
        );
    }

    state.stop_sync_task().await;
    state.stop_heartbeat_loop();
    if let Ok(mut g) = state.voice_livekit_jwt_service_url.lock() {
        *g = None;
    }
    if let Ok(mut m) = state.livekit_matrix_to_sfu_room.lock() {
        m.clear();
    }
    *state.client.lock().await = None;
    state.avatar_cache.clear().await;
    crate::commands::unread::clear_unread_cache(state.inner()).await;
    state.presence_map.lock().await.clear();
    *state.sync_running.lock().await = false;

    // Best-effort cleanup only — do not block on locked files (Windows).
    if let Ok(dir) = app.path().app_data_dir() {
        let store_path = dir.join("matrix_store");
        let _ = std::fs::remove_dir_all(&store_path);
    }
    Ok(())
}

pub fn save_session_to_credentials(
    app: &tauri::AppHandle,
    homeserver: &str,
    session: SavedSession,
    sqlite_store_dir: Option<String>,
) -> Result<(), String> {
    let path = credentials_path(app)?;

    let mut creds = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read credentials: {e}"))?;
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse credentials: {e}"))?
    } else {
        SavedCredentials {
            homeserver: homeserver.to_string(),
            session: None,
            sqlite_store_dir: None,
        }
    };

    creds.homeserver = homeserver.to_string();
    creds.session = Some(session);
    if let Some(dir) = sqlite_store_dir {
        creds.sqlite_store_dir = Some(dir);
    }
    let json = serde_json::to_string_pretty(&creds)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write credentials: {e}"))?;
    Ok(())
}

/// Persist the homeserver URL (no password). Session tokens are patched in
/// later by `save_session_to_credentials` after a successful login.
#[tauri::command]
pub fn save_credentials(app: tauri::AppHandle, homeserver: String) -> Result<(), String> {
    let path = credentials_path(&app)?;
    let creds = SavedCredentials {
        homeserver,
        session: None,
        sqlite_store_dir: None,
    };
    let json = serde_json::to_string_pretty(&creds)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write credentials: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_credentials(app: tauri::AppHandle) -> Result<Option<SavedCredentials>, String> {
    let path = credentials_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read credentials: {e}"))?;
    let creds: SavedCredentials =
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse credentials: {e}"))?;
    Ok(Some(creds))
}

#[tauri::command]
pub fn clear_saved_credentials(app: tauri::AppHandle) -> Result<(), String> {
    let path = credentials_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove credentials: {e}"))?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/*  Login / Register / Restore                                         */
/* ------------------------------------------------------------------ */

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
    state.avatar_cache.clear().await;
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
    state.avatar_cache.clear().await;
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
    let creds = load_credentials(app.clone())?.ok_or("No saved credentials")?;
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

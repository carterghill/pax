use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
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
    /// Relative path under app data dir for the Matrix SDK SQLite store.
    #[serde(default)]
    pub sqlite_store_dir: Option<String>,
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
pub async fn get_access_token(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    client
        .access_token()
        .ok_or_else(|| "No access token for the current session".to_string())
}

#[tauri::command]
pub async fn logout(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    // Give pending keys a chance to reach backup before stopping the SDK. The
    // databases remain on disk even if the network is unavailable.
    if let Some(client) = state.client.lock().await.as_ref() {
        let backups = client.encryption().backups();
        if backups.are_enabled().await {
            let _ = timeout(Duration::from_secs(10), async {
                backups.wait_for_steady_state().await
            })
            .await;
        }
    }
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
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;
    state.stop_heartbeat_loop();
    if let Ok(mut g) = state.voice_livekit_jwt_service_url.lock() {
        *g = None;
    }
    *state.client.lock().await = None;
    state.avatars.reset();
    state.file_cache.clear().await;
    crate::commands::unread::clear_unread_cache(state.inner()).await;
    state.presence_map.lock().await.clear();
    *state.sync_running.lock().await = false;

    // A crypto store may contain the only remaining copy of a room key.
    // Signing out must not delete it as if it were an ordinary message cache.
    let _ = app;
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

/// Carry locally held history across reauthentication. An expired access token
/// does not invalidate the keys in its SQLite store. The old store is kept even
/// if transfer fails, and exports are encrypted with an ephemeral random secret.
async fn transfer_previous_room_keys(
    app: &tauri::AppHandle,
    new_client: &Client,
    live_previous: Option<Client>,
    saved: Option<SavedCredentials>,
) -> Result<(), String> {
    // Reauthentication normally reuses the original device and crypto store.
    if saved
        .as_ref()
        .and_then(|c| c.session.as_ref())
        .is_some_and(|s| {
            new_client
                .user_id()
                .is_some_and(|id| id.as_str() == s.user_id)
                && new_client
                    .device_id()
                    .is_some_and(|id| id.as_str() == s.device_id)
        })
    {
        return Ok(());
    }
    let same_account = |old: &Client| {
        old.user_id() == new_client.user_id() && old.homeserver() == new_client.homeserver()
    };
    let previous = if let Some(old) = live_previous.filter(&same_account) {
        Some(old)
    } else if let Some(creds) = saved {
        if let Some(session) = &creds.session {
            let same_user = new_client
                .user_id()
                .is_some_and(|id| id.as_str() == session.user_id);
            let same_server = creds.homeserver.trim_end_matches('/')
                == new_client.homeserver().as_str().trim_end_matches('/');
            let path = sqlite_path_for_restore(app, &creds)?;
            if same_user && same_server && path.exists() {
                // Use default settings for this source client: do not
                // bootstrap an identity or create backups using an old token.
                let old = Client::builder().homeserver_url(&creds.homeserver)
                    .sqlite_store(path, None).build().await
                    .map_err(|e| format!("Could not open your previous encryption keys. The original store has been kept: {}", fmt_error_chain(&e)))?;
                old.restore_session(MatrixSession {
                    meta: SessionMeta {
                        user_id: matrix_sdk::ruma::UserId::parse(&session.user_id).map_err(|e| e.to_string())?,
                        device_id: session.device_id.clone().into(),
                    },
                    tokens: SessionTokens { access_token: session.access_token.clone(), refresh_token: None },
                }).await.map_err(|e| format!("Could not restore your previous encryption keys. The original store has been kept: {}", fmt_error_chain(&e)))?;
                Some(old)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    let Some(previous) = previous else {
        return Ok(());
    };
    let path = app_data_dir(app)?.join(format!("key-transfer-{}.enc", uuid::Uuid::new_v4()));
    let passphrase = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let result =
        transfer_room_keys_between_clients(&previous, new_client, &path, &passphrase).await;
    let _ = std::fs::remove_file(path);
    result.map_err(|e| format!("Could not transfer your previous encryption keys. Your original store has been kept: {e}"))
}

async fn transfer_room_keys_between_clients(
    previous: &Client,
    next: &Client,
    path: &std::path::Path,
    passphrase: &str,
) -> Result<(), String> {
    if previous.user_id().is_none()
        || previous.user_id() != next.user_id()
        || previous.homeserver() != next.homeserver()
    {
        return Err(
            "Encryption keys can only be transferred between sessions of the same account.".into(),
        );
    }
    previous
        .encryption()
        .export_room_keys(path.to_owned(), passphrase, |_| true)
        .await
        .map_err(|e| fmt_error_chain(&e))?;
    next.encryption()
        .import_room_keys(path.to_owned(), passphrase)
        .await
        .map_err(|e| fmt_error_chain(&e))?;
    Ok(())
}

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

fn reusable_login_store(
    creds: &SavedCredentials,
    homeserver: &str,
    username: &str,
) -> Option<(String, String)> {
    if creds.homeserver.trim_end_matches('/') != homeserver.trim_end_matches('/') {
        return None;
    }
    let session = creds.session.as_ref()?;
    let user_id = matrix_sdk::ruma::UserId::parse(&session.user_id).ok()?;
    let username = username.trim();
    if username != user_id.as_str() && username != user_id.localpart() {
        return None;
    }
    Some((
        creds
            .sqlite_store_dir
            .clone()
            .unwrap_or_else(|| "matrix_store".into()),
        session.device_id.clone(),
    ))
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
            .with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                auto_enable_backups: true,
                // Fetch keys as rooms are read, rather than downloading an
                // unbounded account-wide archive in one response.
                backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            })
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

/// Reauthenticate an existing device in its original store when possible. New
/// accounts/devices get their own store. Every attempt uses a fresh Client,
/// since reusing a Client after failed login can cause AlreadyInitializedError.
async fn login_password_into_new_store(
    app: &tauri::AppHandle,
    homeserver: &str,
    username: &str,
    password: &str,
    log_prefix: &str,
    reusable: Option<(String, String)>,
) -> Result<(Client, String), String> {
    let base = app_data_dir(app)?;
    let sessions_root = base.join("matrix_sessions");
    std::fs::create_dir_all(&sessions_root)
        .map_err(|e| format!("Failed to create matrix_sessions: {e}"))?;

    let mut last_err = String::new();
    for attempt in 0u32..3 {
        let rel = reusable
            .as_ref()
            .map(|(rel, _)| rel.clone())
            .unwrap_or_else(|| format!("matrix_sessions/pw_{}", uuid::Uuid::new_v4()));
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
        let mut login = client
            .matrix_auth()
            .login_username(username, password)
            .initial_device_display_name("Pax");
        if let Some((_, device_id)) = &reusable {
            login = login.device_id(device_id);
        }
        match login.send().await {
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
                // A wrong password or network error must never delete existing
                // keys. Only this attempt's newly created directory is disposable.
                if reusable.is_none() {
                    let _ = std::fs::remove_dir_all(&sp);
                }
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
    let _operation = state.encryption.operation.lock().await;
    // Registration succeeded — now do a normal SDK login so we get a fully
    // initialised Client with crypto store, sync, etc.
    state.stop_sync_task().await;
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;
    *state.client.lock().await = None;

    let (client, store_rel) = login_password_into_new_store(
        app,
        homeserver,
        username,
        password,
        "Post-registration login",
        None,
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
        save_session_to_credentials(
            app,
            homeserver,
            SavedSession {
                user_id: session.meta.user_id.to_string(),
                device_id: session.meta.device_id.to_string(),
                access_token: session.tokens.access_token,
            },
            Some(store_rel),
        )?;
    }

    let user_id = client
        .user_id()
        .ok_or("No user ID after registration")?
        .to_string();

    *state.client.lock().await = Some(client);
    state.notifications.start_session();
    state.voice_presence.start_session();
    state.attachments.start_session();
    *state.sync_running.lock().await = false;
    state.avatars.reset();
    state.file_cache.clear().await;
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
    let _operation = state.encryption.operation.lock().await;
    let previous_client = state.client.lock().await.clone();
    let previous_credentials = load_credentials(app.clone())?;
    let reusable = previous_credentials
        .as_ref()
        .and_then(|creds| reusable_login_store(creds, &homeserver, &username))
        .filter(|(rel, _)| app_data_dir(&app).is_ok_and(|base| base.join(rel).exists()));
    state.stop_sync_task().await;
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;
    *state.client.lock().await = None;

    log::info!("login: password auth for {}", homeserver);
    let (client, store_rel) =
        login_password_into_new_store(&app, &homeserver, &username, &password, "Login", reusable)
            .await?;

    transfer_previous_room_keys(&app, &client, previous_client, previous_credentials).await?;

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
            save_session_to_credentials(
                &app,
                &homeserver,
                SavedSession {
                    user_id: session.meta.user_id.to_string(),
                    device_id: session.meta.device_id.to_string(),
                    access_token: session.tokens.access_token,
                },
                Some(store_rel),
            )?;
        }
    } else {
        clear_saved_credentials(app.clone())?;
    }

    let user_id = client
        .user_id()
        .ok_or("No user ID after login")?
        .to_string();

    *state.client.lock().await = Some(client);
    state.notifications.start_session();
    state.voice_presence.start_session();
    state.attachments.start_session();
    *state.sync_running.lock().await = false;
    state.avatars.reset();
    state.file_cache.clear().await;
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
    let _operation = state.encryption.operation.lock().await;
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
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;

    state.avatars.reset();
    *state.client.lock().await = Some(client);
    state.notifications.start_session();
    state.voice_presence.start_session();
    state.attachments.start_session();
    *state.sync_running.lock().await = false;
    Ok(user_id.to_string())
}

#[cfg(test)]
mod encryption_tests {
    use super::*;
    use matrix_sdk::config::RequestConfig;
    use matrix_sdk::ruma::api::MatrixVersion;

    struct TestDir(std::path::PathBuf);
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn encryption_store_reuse_requires_the_same_account_and_server() {
        let saved = SavedCredentials {
            homeserver: "https://example.org".into(),
            session: Some(SavedSession {
                user_id: "@alice:example.org".into(),
                device_id: "ORIGINAL".into(),
                access_token: "expired".into(),
            }),
            sqlite_store_dir: Some("matrix_sessions/pw_original".into()),
        };
        assert_eq!(
            reusable_login_store(&saved, "https://example.org/", "alice"),
            Some(("matrix_sessions/pw_original".into(), "ORIGINAL".into()))
        );
        assert!(
            reusable_login_store(&saved, "https://example.org", "@alice:example.org").is_some()
        );
        assert!(reusable_login_store(&saved, "https://example.org", "bob").is_none());
        assert!(reusable_login_store(&saved, "https://another.org", "alice").is_none());
    }

    async fn client(path: &std::path::Path, user: &str, device: &str) -> Client {
        let client = Client::builder()
            .homeserver_url("http://127.0.0.1:9")
            .server_versions([MatrixVersion::V1_11])
            .request_config(RequestConfig::new().disable_retry())
            .sqlite_store(path, None)
            .build()
            .await
            .unwrap();
        client
            .restore_session(MatrixSession {
                meta: SessionMeta {
                    user_id: matrix_sdk::ruma::UserId::parse(user).unwrap(),
                    device_id: device.into(),
                },
                tokens: SessionTokens {
                    access_token: "test-token".into(),
                    refresh_token: None,
                },
            })
            .await
            .unwrap();
        client
    }

    #[tokio::test]
    async fn encryption_keys_survive_restart_and_transfer_to_a_new_device() {
        let dir = TestDir(
            std::env::temp_dir().join(format!("pax-encryption-test-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&dir.0).unwrap();
        let fixture = dir.0.join("fixture.enc");
        // Public test fixture from matrix-rust-sdk's backups.rs, Apache-2.0,
        // Copyright The Matrix.org Foundation C.I.C. The test passphrase is 1234.
        std::fs::write(&fixture, include_str!("fixtures/test-room-key-export.txt")).unwrap();
        let old_path = dir.0.join("original-device");
        let original = client(&old_path, "@alice:example.org", "ORIGINAL").await;
        let imported = original
            .encryption()
            .import_room_keys(fixture.clone(), "1234")
            .await
            .unwrap();
        assert_eq!(imported.imported_count, 1);
        drop(original);

        let reopened = client(&old_path, "@alice:example.org", "ORIGINAL").await;
        let next = client(&dir.0.join("new-device"), "@alice:example.org", "NEW").await;
        let transfer = dir.0.join("transfer.enc");
        transfer_room_keys_between_clients(&reopened, &next, &transfer, "transfer-secret")
            .await
            .unwrap();
        assert!(next
            .encryption()
            .import_room_keys(transfer.clone(), "wrong-secret")
            .await
            .is_err());
        // The transferred key is already in the new device's persistent store.
        let duplicate = next
            .encryption()
            .import_room_keys(transfer.clone(), "transfer-secret")
            .await
            .unwrap();
        assert_eq!(duplicate.total_count, 1);
        assert_eq!(duplicate.imported_count, 0);

        let other = client(&dir.0.join("other-account"), "@bob:example.org", "BOB").await;
        let rejected_export = dir.0.join("must-not-exist.enc");
        assert!(
            transfer_room_keys_between_clients(&reopened, &other, &rejected_export, "secret")
                .await
                .is_err()
        );
        assert!(!rejected_export.exists());
        assert!(
            old_path.exists(),
            "Reauthentication must preserve the original store"
        );
    }
}

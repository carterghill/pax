use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
use matrix_sdk::{Client, SessionMeta};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::time::timeout;

use crate::AppState;

use super::fmt_error_chain;
use super::pax_auth::{self, AccountMode, Descriptor, Enrollment};

pub(crate) const CREDENTIALS_FILENAME: &str = "credentials.json";
const PAX_SETUP_REQUIRED: &str = "Sign in with your password to finish encrypted account setup.";
const PAX_RECOVERY_REQUIRED: &str = "Sign in with your Pax password to restore encrypted history.";

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
    #[serde(default)]
    pub account_mode: AccountMode,
    #[serde(default)]
    pub pax_enrollment_pending: bool,
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
    state.direct_calls.lock().await.clear();
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;
    state.stop_heartbeat_loop();
    if let Ok(mut g) = state.voice_livekit_jwt_service_url.lock() {
        *g = None;
    }
    *state.client.lock().await = None;
    *state.session_store_dir.lock().await = None;
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
    account_mode: AccountMode,
    pax_enrollment_pending: bool,
) -> Result<(), String> {
    let path = credentials_path(app)?;

    let creds = SavedCredentials {
        homeserver: homeserver.to_owned(),
        session: Some(session),
        sqlite_store_dir,
        account_mode,
        pax_enrollment_pending,
    };
    let json = serde_json::to_string_pretty(&creds)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    pax_auth::atomic_write(&path, json.as_bytes())
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
        account_mode: AccountMode::Matrix,
        pax_enrollment_pending: false,
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
async fn build_client_for_mode(
    homeserver: &str,
    store_path: &std::path::Path,
    mode: AccountMode,
) -> Result<Client, String> {
    let mut last_err = String::new();
    for attempt in 0u64..3 {
        match Client::builder()
            .homeserver_url(homeserver)
            .sqlite_store(store_path, None)
            .with_encryption_settings(EncryptionSettings {
                // Pax must recover the existing identity before doing anything
                // that could create or replace server-side encryption state.
                auto_enable_cross_signing: mode == AccountMode::Matrix,
                auto_enable_backups: mode == AccountMode::Matrix,
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

#[derive(Debug)]
pub(super) enum PasswordLoginError {
    Rejected,
    Other(String),
}
impl PasswordLoginError {
    pub(super) fn message(self) -> String {
        match self {
            Self::Rejected => "Incorrect username or password.".into(),
            Self::Other(message) => message,
        }
    }

    fn matrix_message(self) -> String {
        match self {
            Self::Rejected => {
                "The homeserver rejected your standard Matrix username or password.".into()
            }
            other => other.message(),
        }
    }
}

// Keep the typed rejection separate from timeouts, malformed responses and
// rate limits. Only a genuine credential rejection permits a legacy probe.
pub(super) async fn request_password_session(
    http: &reqwest::Client,
    home: &str,
    user: &str,
    credential: &str,
    device: Option<&str>,
) -> Result<SavedSession, PasswordLoginError> {
    let mut body = serde_json::json!({
        "type": "m.login.password", "identifier": { "type": "m.id.user", "user": user },
        "password": credential, "initial_device_display_name": "Pax", "refresh_token": false,
    });
    if let Some(device) = device {
        body["device_id"] = device.into();
    }
    let response = http
        .post(format!(
            "{}/_matrix/client/v3/login",
            home.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            PasswordLoginError::Other(
                "Could not contact the homeserver. Check your connection and try again.".into(),
            )
        })?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|_| {
        PasswordLoginError::Other("Invalid sign-in response from the homeserver.".into())
    })?;
    if status.as_u16() == 403 && value["errcode"] == "M_FORBIDDEN" {
        // Only log the status, never credentials, response bodies or tokens.
        log::info!("login: password authentication rejected (HTTP 403)");
        return Err(PasswordLoginError::Rejected);
    }
    if !status.is_success() {
        // Do not echo server-controlled error text which could contain secrets.
        return Err(PasswordLoginError::Other(if status.as_u16() == 429 {
            "Too many sign-in attempts. Wait a moment and try again.".into()
        } else {
            format!("The homeserver could not complete sign-in (HTTP {status}).")
        }));
    }
    session_from_response(&value).map_err(PasswordLoginError::Other)
}

fn session_from_response(value: &serde_json::Value) -> Result<SavedSession, String> {
    let field = |name| {
        value[name]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "Incomplete authentication response from the homeserver.".to_string())
    };
    let user_id = field("user_id")?;
    matrix_sdk::ruma::UserId::parse(&user_id)
        .map_err(|_| "Invalid account ID in authentication response")?;
    Ok(SavedSession {
        user_id,
        device_id: field("device_id")?,
        access_token: field("access_token")?,
    })
}

/// Registration UIAA always receives the actual Matrix credential, never a
/// Pax account's memorable password. Unsupported challenges fail explicitly.
pub(super) async fn submit_registration(
    http: &reqwest::Client,
    home: &str,
    username: &str,
    credential: &str,
    token: &str,
) -> Result<SavedSession, String> {
    let url = format!("{}/_matrix/client/v3/register", home.trim_end_matches('/'));
    let mut body = serde_json::json!({ "username": username, "password": credential, "initial_device_display_name": "Pax" });
    for _ in 0..4 {
        let response = http.post(&url).timeout(Duration::from_secs(30)).json(&body).send().await
            .map_err(|_| "Registration could not reach the homeserver. If the account was created, sign in with the same password to finish setup.")?;
        let status = response.status();
        let challenge: serde_json::Value = response
            .json()
            .await
            .map_err(|_| "Invalid registration response")?;
        if status.is_success() {
            return session_from_response(&challenge);
        }
        if status.as_u16() != 401 {
            return Err(match challenge["errcode"].as_str() {
                Some("M_USER_IN_USE") => {
                    "This username is already registered. Sign in or choose another username."
                        .into()
                }
                Some("M_INVALID_USERNAME") => {
                    "This username is not allowed by the homeserver.".into()
                }
                Some("M_WEAK_PASSWORD") => {
                    "The homeserver did not accept this account password.".into()
                }
                Some("M_FORBIDDEN") => {
                    "Registration was rejected. Check the registration token.".into()
                }
                _ => format!("Registration failed (HTTP {status})."),
            });
        }
        let session = challenge["session"]
            .as_str()
            .ok_or("Missing registration authentication session")?;
        let completed = challenge["completed"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let flows = challenge["flows"]
            .as_array()
            .ok_or("Unsupported registration challenge")?;
        let stages = flows
            .iter()
            .filter_map(|f| f["stages"].as_array())
            .find(|stages| {
                stages.iter().all(|s| {
                    matches!(
                        s.as_str(),
                        Some("m.login.dummy" | "m.login.registration_token")
                    )
                })
            })
            .ok_or("This server requires a registration step Pax does not support yet.")?;
        let next = stages
            .iter()
            .find(|s| !completed.contains(s))
            .and_then(|s| s.as_str())
            .ok_or("Registration did not complete. Check the registration token.")?;
        if body["auth"]["type"].as_str() == Some(next) {
            return Err(
                "Registration authentication was rejected. Check the registration token.".into(),
            );
        }
        body["auth"] = match next {
            "m.login.registration_token" => {
                serde_json::json!({ "type": next, "token": token, "session": session })
            }
            _ => serde_json::json!({ "type": next, "session": session }),
        };
    }
    Err("Registration did not complete. Check the registration token.".into())
}

async fn stop_previous_session(state: &AppState) {
    state.stop_sync_task().await;
    state.direct_calls.lock().await.clear();
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;
    *state.client.lock().await = None;
}

pub(super) async fn restore_authenticated_client(
    app: &tauri::AppHandle,
    home: &str,
    session: &SavedSession,
    rel: &str,
    mode: AccountMode,
) -> Result<Client, String> {
    let client = build_client_for_mode(home, &app_data_dir(app)?.join(rel), mode).await?;
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: matrix_sdk::ruma::UserId::parse(&session.user_id)
                    .map_err(|_| "Invalid account ID")?,
                device_id: session.device_id.clone().into(),
            },
            tokens: SessionTokens {
                access_token: session.access_token.clone(),
                refresh_token: None,
            },
        })
        .await
        .map_err(|_| {
            "Could not open the encryption store. The original files have been preserved."
        })?;
    Ok(client)
}

async fn initial_sync(client: &Client) -> Result<(), String> {
    timeout(
        Duration::from_secs(30),
        client.sync_once(
            SyncSettings::default()
                .set_presence(matrix_sdk::ruma::presence::PresenceState::Offline),
        ),
    )
    .await
    .map_err(|_| "Initial sync timed out. Sign in again to continue.".to_string())?
    .map_err(|_| "Initial sync failed. Check your connection and sign in again.".to_string())?;
    Ok(())
}

async fn install_session(
    state: &AppState,
    client: Client,
    mode: AccountMode,
    store_dir: String,
) -> Result<String, String> {
    let user = client.user_id().ok_or("Missing account ID")?.to_string();
    *state.account_mode.lock().await = mode;
    *state.session_store_dir.lock().await = Some(store_dir);
    *state.client.lock().await = Some(client);
    state.notifications.start_session();
    state.voice_presence.start_session();
    state.attachments.start_session();
    *state.sync_running.lock().await = false;
    state.avatars.reset();
    state.file_cache.clear().await;
    Ok(user)
}

fn progress(app: &tauri::AppHandle, message: &str) {
    let _ = app.emit("auth-progress", message);
}

#[tauri::command]
pub async fn register(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    homeserver: String,
    username: String,
    password: String,
    registration_token: String,
    account_mode: Option<AccountMode>,
) -> Result<String, String> {
    let _operation = state.encryption.operation.lock().await;
    let password = zeroize::Zeroizing::new(password);
    let mode = account_mode.unwrap_or(AccountMode::Pax);
    if username.is_empty() || password.is_empty() {
        return Err("Username and password are required.".into());
    }
    let rel = format!("matrix_sessions/pw_{}", uuid::Uuid::new_v4());
    if mode == AccountMode::Matrix {
        progress(&app, "Creating account…");
        let session = submit_registration(
            &state.http_client,
            &homeserver,
            &username,
            &password,
            &registration_token,
        )
        .await?;
        stop_previous_session(&state).await;
        save_session_to_credentials(
            &app,
            &homeserver,
            session.clone(),
            Some(rel.clone()),
            mode,
            false,
        )?;
        let client = restore_authenticated_client(&app, &homeserver, &session, &rel, mode).await?;
        initial_sync(&client).await?;
        // Explicit standard markers are helpful, but legacy servers without
        // custom profile support remain fully usable.
        if pax_auth::check_profile_support(&state.http_client, &homeserver)
            .await
            .is_ok()
        {
            let _ = pax_auth::publish(
                &state.http_client,
                &client,
                &Descriptor::new(&session.user_id, mode, true),
            )
            .await;
        }
        return install_session(&state, client, mode, rel).await;
    }
    pax_auth::ensure_trusted(&homeserver, &state.auth_config)?;
    if password.chars().count() < 12 {
        return Err(
            "Use at least 12 characters for your Pax password. A few unrelated words work well."
                .into(),
        );
    }
    progress(&app, "Checking homeserver…");
    pax_auth::check_profile_support(&state.http_client, &homeserver).await?;
    let user = pax_auth::account_id(
        &state.http_client,
        &homeserver,
        &username,
        &state.auth_config,
    )
    .await?;
    let existing = pax_auth::read_enrollment(&app, &homeserver, &user)?;
    if existing.as_ref().is_some_and(|e| e.registered || e.ready) {
        return Err(
            "This account was already created. Sign in with the same password to continue setup."
                .into(),
        );
    }
    progress(&app, "Protecting your password…");
    let keys = pax_auth::derive(&user, &password).await?;
    let mut record = Enrollment {
        user_id: user.clone(),
        homeserver: homeserver.clone(),
        store_dir: rel.clone(),
        device_id: None,
        registered: false,
        ready: false,
    };
    pax_auth::save_enrollment(&app, &record)?;
    progress(&app, "Creating account…");
    let session = submit_registration(
        &state.http_client,
        &homeserver,
        &username,
        &keys.credential,
        &registration_token,
    )
    .await?;
    let finish: Result<Client, String> = async {
        if session.user_id != user {
            return Err("The server returned a different account domain. Account creation succeeded, but Pax setup stopped to protect your keys. Check PAX_SERVER_NAME before continuing.".into());
        }
        record.registered = true;
        record.device_id = Some(session.device_id.clone());
        // Save the original device before any fallible crypto/network work. A
        // normal sign-in can resume using exactly this device's encryption store.
        pax_auth::save_enrollment(&app, &record)?;
        save_session_to_credentials(
            &app, &homeserver, session.clone(), Some(rel.clone()), mode, true,
        )?;
        stop_previous_session(&state).await;
        let client = restore_authenticated_client(&app, &homeserver, &session, &rel, mode).await?;
        pax_auth::publish(&state.http_client, &client, &Descriptor::new(&user, mode, false)).await?;
        initial_sync(&client).await?;
        progress(&app, "Setting up encrypted history…");
        pax_auth::complete_enrollment(&state.http_client, &client, &keys, true).await?;
        record.ready = true;
        pax_auth::save_enrollment(&app, &record)?;
        save_session_to_credentials(&app, &homeserver, session, Some(rel.clone()), mode, false)?;
        Ok(client)
    }.await;
    let client = finish.map_err(|e| {
        format!("Your account was created. Sign in with the same password to finish setup. {e}")
    })?;
    install_session(&state, client, mode, rel).await
}

pub(super) struct PasswordAuthentication {
    pub session: SavedSession,
    pub mode: AccountMode,
    pub keys: Option<pax_auth::PaxKeys>,
    pub descriptor: Option<Descriptor>,
}

async fn discover_sign_in(
    http: &reqwest::Client,
    home: &str,
    user: &str,
    pinned: bool,
) -> Result<Option<Descriptor>, String> {
    // During a discovery outage, only installations with a known Pax mode can
    // proceed without a descriptor.
    let descriptor = match pax_auth::discover(http, home, user).await {
        Ok(d) => d,
        Err(pax_auth::DiscoveryError::Unavailable(_)) if pinned => None,
        Err(e) => return Err(e.into()),
    };
    if descriptor.as_ref().is_some_and(|d| d.state == "converting") {
        return Err(super::account_conversion::PENDING_MESSAGE.into());
    }
    if pinned
        && descriptor
            .as_ref()
            .is_some_and(|d| d.mode == AccountMode::Matrix)
    {
        return Err("This account's sign-in settings changed unexpectedly. Pax has kept your password private. Check with your homeserver administrator.".into());
    }
    Ok(descriptor)
}

/// Mode discovery and network authentication share one path in the UI and
/// integration tests. No Tauri or disk state is needed until authentication.
pub(super) async fn authenticate_password(
    http: &reqwest::Client,
    home: &str,
    user: &str,
    matrix_identifier: &str,
    password: &str,
    device: Option<&str>,
    config: &crate::AuthConfig,
    pinned: bool,
) -> Result<PasswordAuthentication, String> {
    let descriptor = discover_sign_in(http, home, user, pinned).await?;
    let desired = if pinned {
        Some(AccountMode::Pax)
    } else {
        descriptor.as_ref().map(|d| d.mode)
    };
    // Pax enrollment is limited to the deployment's trusted homeserver.
    // Unmarked accounts on other servers keep ordinary Matrix authentication.
    let desired = if desired.is_none() && pax_auth::ensure_trusted(home, config).is_err() {
        Some(AccountMode::Matrix)
    } else {
        desired
    };
    let mut keys = None;
    log::info!("login: account={user}, discovered_mode={desired:?}, local_pax_pin={pinned}");
    let (session, mode) = if desired == Some(AccountMode::Matrix) {
        log::info!("login: using standard Matrix authentication");
        (
            request_password_session(http, home, matrix_identifier, password, device)
                .await
                .map_err(PasswordLoginError::matrix_message)?,
            AccountMode::Matrix,
        )
    } else {
        pax_auth::ensure_trusted(home, config)?;
        let derived = pax_auth::derive(user, password).await?;
        match request_password_session(http, home, user, &derived.credential, device).await {
            Ok(session) => {
                keys = Some(derived);
                (session, AccountMode::Pax)
            }
            // Unsigned, trusted-server compatibility for older, unmarked
            // Matrix accounts. Never infer mode from a timeout or rate limit.
            Err(PasswordLoginError::Rejected) if desired.is_none() => {
                log::info!("login: Pax probe rejected; using standard Matrix authentication for the unmarked account");
                (
                    request_password_session(http, home, matrix_identifier, password, device)
                        .await
                        .map_err(PasswordLoginError::matrix_message)?,
                    AccountMode::Matrix,
                )
            }
            Err(e) => return Err(e.message()),
        }
    };
    if session.user_id != user {
        return Err(
            "The homeserver authenticated a different account. Sign-in was stopped.".into(),
        );
    }
    if device.is_some_and(|device| device != session.device_id) {
        return Err("The homeserver returned a different device. Your original encryption store has been preserved.".into());
    }
    Ok(PasswordAuthentication {
        session,
        mode,
        keys,
        descriptor,
    })
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
    let password = zeroize::Zeroizing::new(password);
    let previous_credentials = load_credentials(app.clone())?;
    let previous_client = state.client.lock().await.clone();
    let reusable = previous_credentials
        .as_ref()
        .and_then(|c| reusable_login_store(c, &homeserver, &username));
    let user = if reusable.is_some() {
        previous_credentials
            .as_ref()
            .and_then(|c| c.session.as_ref())
            .unwrap()
            .user_id
            .clone()
    } else {
        pax_auth::account_id(
            &state.http_client,
            &homeserver,
            &username,
            &state.auth_config,
        )
        .await?
    };
    let record = pax_auth::read_enrollment(&app, &homeserver, &user)?;
    if super::account_conversion::read_journal(&app, &homeserver, &user)?
        .is_some_and(|j| !j.record.complete)
    {
        return Err(super::account_conversion::PENDING_MESSAGE.into());
    }
    let pinned = record.as_ref().is_some_and(|e| e.registered || e.ready)
        || previous_credentials
            .as_ref()
            .is_some_and(|c| c.account_mode == AccountMode::Pax && reusable.is_some());
    let reusable = reusable
        .or_else(|| {
            record.as_ref().and_then(|r| {
                r.device_id
                    .as_ref()
                    .map(|d| (r.store_dir.clone(), d.clone()))
            })
        })
        .filter(|(rel, device)| {
            app_data_dir(&app).is_ok_and(|base| base.join(rel).exists())
                || record.as_ref().is_some_and(|r| {
                    r.registered
                        && !r.ready
                        && &r.store_dir == rel
                        && r.device_id.as_ref() == Some(device)
                })
        });
    progress(&app, "Unlocking your account…");
    let PasswordAuthentication {
        session,
        mode,
        keys,
        descriptor,
    } = authenticate_password(
        &state.http_client,
        &homeserver,
        &user,
        username.trim(),
        &password,
        reusable.as_ref().map(|(_, d)| d.as_str()),
        &state.auth_config,
        pinned,
    )
    .await?;
    let rel = reusable
        .as_ref()
        .map(|(r, _)| r.clone())
        .unwrap_or_else(|| format!("matrix_sessions/pw_{}", uuid::Uuid::new_v4()));
    let local_setup = record.as_ref().is_some_and(|r| {
        r.registered
            && !r.ready
            && r.store_dir == rel
            && r.device_id.as_deref() == Some(session.device_id.as_str())
    });
    let mut pin = if mode == AccountMode::Pax {
        let mut pin = record.unwrap_or(Enrollment {
            user_id: user.clone(),
            homeserver: homeserver.clone(),
            store_dir: rel.clone(),
            device_id: Some(session.device_id.clone()),
            registered: false,
            ready: true,
        });
        pin.store_dir = rel.clone();
        pin.device_id = Some(session.device_id.clone());
        pax_auth::save_enrollment(&app, &pin)?;
        save_session_to_credentials(
            &app,
            &homeserver,
            session.clone(),
            Some(rel.clone()),
            mode,
            true,
        )?;
        Some(pin)
    } else {
        None
    };
    stop_previous_session(&state).await;
    let client = restore_authenticated_client(&app, &homeserver, &session, &rel, mode).await?;
    transfer_previous_room_keys(&app, &client, previous_client, previous_credentials).await?;
    initial_sync(&client).await?;
    if let Some(keys) = &keys {
        progress(&app, "Restoring encrypted history…");
        let pending = descriptor.as_ref().is_some_and(|d| d.state == "pending") || local_setup;
        if pending {
            pax_auth::complete_enrollment(&state.http_client, &client, keys, local_setup).await?;
        } else {
            let envelope = pax_auth::fetch_envelope(&client).await?.ok_or("Account recovery information is missing. Try your original computer; no encryption data has been replaced.")?;
            pax_auth::unlock(&client, keys, &envelope).await?;
        }
        if let Some(pin) = pin.as_mut() {
            pin.ready = true;
            pax_auth::save_enrollment(&app, pin)?;
        }
    }
    if persist_session {
        save_session_to_credentials(&app, &homeserver, session, Some(rel.clone()), mode, false)?;
    } else {
        clear_saved_credentials(app.clone())?;
    }
    install_session(&state, client, mode, rel).await
}

async fn saved_session_mode(
    http: &reqwest::Client,
    home: &str,
    user: &str,
    config: &crate::AuthConfig,
    pinned: bool,
) -> Result<AccountMode, String> {
    let descriptor = discover_sign_in(http, home, user, pinned).await?;
    if pinned || descriptor.as_ref().is_some_and(|d| d.mode == AccountMode::Pax) {
        pax_auth::ensure_trusted(home, config)?;
        if descriptor.is_some_and(|d| d.state == "pending") {
            return Err(PAX_SETUP_REQUIRED.into());
        }
        return Ok(AccountMode::Pax);
    }
    Ok(AccountMode::Matrix)
}

/// Resume a saved device session without a password request or an initial sync.
#[tauri::command]
pub async fn restore_session(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let _operation = state.encryption.operation.lock().await;
    #[cfg(target_os = "android")]
    let _cold_store = crate::call_notifications::android::COLD_STORE.lock().await;
    let creds = load_credentials(app.clone())?.ok_or("No saved credentials")?;
    let sd = creds.session.as_ref().ok_or("No saved session")?;
    if creds.pax_enrollment_pending {
        return Err(PAX_SETUP_REQUIRED.into());
    }

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

    let user_id = matrix_sdk::ruma::UserId::parse(&sd.user_id)
        .map_err(|e| format!("Invalid user ID: {e}"))?;
    if super::account_conversion::read_journal(&app, &creds.homeserver, user_id.as_str())?
        .is_some_and(|j| !j.record.complete)
    {
        return Err(super::account_conversion::PENDING_MESSAGE.into());
    }
    let pinned = creds.account_mode == AccountMode::Pax
        || pax_auth::read_enrollment(&app, &creds.homeserver, user_id.as_str())?
            .is_some_and(|e| e.registered || e.ready);
    let mode = saved_session_mode(
        &state.http_client,
        &creds.homeserver,
        user_id.as_str(),
        &state.auth_config,
        pinned,
    )
    .await?;

    // Determine the mode before opening the SDK store, where Matrix mode can
    // automatically initialize encryption state.
    let sp = sqlite_path_for_restore(&app, &creds)?;
    if mode == AccountMode::Pax && !sp.exists() {
        return Err(PAX_RECOVERY_REQUIRED.into());
    }
    log::info!("restore_session: building {mode:?} client for {}", creds.homeserver);
    let client = build_client_for_mode(&creds.homeserver, &sp, mode).await?;

    log::info!("restore_session: restoring session...");
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: user_id.clone(),
                device_id: sd.device_id.clone().into(),
            },
            tokens: SessionTokens {
                access_token: sd.access_token.clone(),
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
                Ok(Ok(response)) => {
                    if response.user_id != user_id {
                        return Err("The saved session belongs to a different account.".into());
                    }
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
    if mode != creds.account_mode {
        save_session_to_credentials(
            &app,
            &creds.homeserver,
            sd.clone(),
            creds.sqlite_store_dir.clone(),
            mode,
            false,
        )?;
    }
    if mode == AccountMode::Pax {
        client
            .encryption()
            .wait_for_e2ee_initialization_tasks()
            .await;
        if !client
            .encryption()
            .cross_signing_status()
            .await
            .is_some_and(|s| s.is_complete())
            || !client.encryption().backups().are_enabled().await
        {
            return Err(PAX_RECOVERY_REQUIRED.into());
        }
    }
    *state.account_mode.lock().await = mode;
    *state.session_store_dir.lock().await = Some(creds.sqlite_store_dir.clone().unwrap_or_else(|| "matrix_store".into()));
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
    use crate::commands::pax_auth::tests::{Server, USER};
    use matrix_sdk::config::RequestConfig;
    use matrix_sdk::ruma::api::MatrixVersion;
    use serde_json::json;

    struct TestDir(std::path::PathBuf);
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn saved_matrix_session_follows_profile_conversion() {
        let server = Server::start().await;
        let http = reqwest::Client::new();
        let config = crate::AuthConfig::default();
        let discover_mode = || saved_session_mode(&http, &server.home, USER, &config, false);
        assert_eq!(discover_mode().await.unwrap(), AccountMode::Matrix);

        let mut descriptor = Descriptor::new(USER, AccountMode::Pax, false);
        server.state.lock().unwrap().profile = json!({pax_auth::PROFILE_FIELD:&descriptor});
        assert_eq!(discover_mode().await.unwrap_err(), PAX_SETUP_REQUIRED);

        descriptor.state = "converting".into();
        descriptor.conversion_id = Some(uuid::Uuid::new_v4().to_string());
        server.state.lock().unwrap().profile = json!({pax_auth::PROFILE_FIELD:&descriptor});
        assert_eq!(
            discover_mode().await.unwrap_err(),
            super::super::account_conversion::PENDING_MESSAGE
        );

        descriptor.state = "ready".into();
        descriptor.conversion_id = None;
        server.state.lock().unwrap().profile = json!({pax_auth::PROFILE_FIELD:descriptor});
        assert_eq!(discover_mode().await.unwrap(), AccountMode::Pax);
    }

    #[tokio::test]
    async fn saved_session_does_not_assume_matrix_when_discovery_fails() {
        let server = Server::start().await;
        let http = reqwest::Client::new();
        let config = crate::AuthConfig::default();
        let discover_mode = |pinned| saved_session_mode(&http, &server.home, USER, &config, pinned);

        server.state.lock().unwrap().profile_status = Some(503);
        assert!(discover_mode(false).await.is_err());
        assert_eq!(discover_mode(true).await.unwrap(), AccountMode::Pax);

        server.state.lock().unwrap().profile_status = None;
        server.state.lock().unwrap().profile = json!({pax_auth::PROFILE_FIELD: {"schema_version": 999}});
        assert!(discover_mode(true).await.is_err());
        server.state.lock().unwrap().profile =
            json!({pax_auth::PROFILE_FIELD: Descriptor::new(USER, AccountMode::Matrix, true)});
        assert!(discover_mode(true).await.is_err());
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
            account_mode: AccountMode::Matrix,
            pax_enrollment_pending: false,
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

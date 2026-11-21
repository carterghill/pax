use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::SessionTokens;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
use matrix_sdk::ruma::api::client::error::ErrorKind;
use matrix_sdk::{Client, HttpError, RefreshTokenError, SessionMeta};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::time::timeout;

use crate::AppState;

use super::fmt_error_chain;
use super::pax_auth::{self, AccountMode, Descriptor, Enrollment};

pub(crate) const CREDENTIALS_FILENAME: &str = "credentials.json";
static CREDENTIALS_LOCK: Mutex<()> = Mutex::new(());
const PAX_SETUP_REQUIRED: &str = "Sign in with your password to finish encrypted account setup.";
const PAX_RECOVERY_REQUIRED: &str = "Sign in with your Pax password to restore encrypted history.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl SavedSession {
    pub(super) fn from_client(client: &Client) -> Result<Self, String> {
        let meta = client.session_meta().ok_or("Missing session identity")?;
        let tokens = client.session_tokens().ok_or("Missing session tokens")?;
        Ok(Self {
            user_id: meta.user_id.to_string(),
            device_id: meta.device_id.to_string(),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
        })
    }

    pub(crate) fn tokens(&self) -> SessionTokens {
        SessionTokens {
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reauthentication: Option<Reauthentication>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionEnd {
    SoftLogout,
    Revoked,
    AccountLocked,
}

impl SessionEnd {
    fn message(self) -> &'static str {
        match self {
            Self::SoftLogout => {
                "Your session expired. Enter your password to continue on this device."
            }
            Self::Revoked => "Your session ended. Sign in again to continue.",
            Self::AccountLocked => {
                "Your homeserver locked this account. You can sign in once it is unlocked."
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Reauthentication {
    user_id: String,
    device_id: String,
    reason: SessionEnd,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginDetails {
    homeserver: String,
    user_id: Option<String>,
    remember_me: bool,
    message: Option<&'static str>,
}

impl SavedCredentials {
    fn user_id(&self) -> Option<&str> {
        self.reauthentication
            .as_ref()
            .map(|r| r.user_id.as_str())
            .or_else(|| self.session.as_ref().map(|s| s.user_id.as_str()))
    }

    fn login_details(&self, remember_me: bool) -> LoginDetails {
        LoginDetails {
            homeserver: self.homeserver.clone(),
            user_id: self.user_id().map(str::to_owned),
            remember_me,
            message: self.reauthentication.as_ref().map(|r| r.reason.message()),
        }
    }
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
    #[cfg(target_os = "android")]
    let _cold_store = crate::call_notifications::android::COLD_STORE.lock().await;
    let client = state.client.lock().await.clone();
    let store_dir = state.session_store_dir.lock().await.clone();
    let mut remotely_signed_out = true;
    if let Some(client) = &client {
        let backups = client.encryption().backups();
        if backups.are_enabled().await {
            let _ = timeout(Duration::from_secs(10), async {
                backups.wait_for_steady_state().await
            })
            .await;
        }
        // Stop sync before revoking the token to avoid racing a refresh.
        state.stop_sync_task().await;
        if let Some(user_id) = client.user_id() {
            let request = matrix_sdk::ruma::api::client::presence::set_presence::v3::Request::new(
                user_id.to_owned(),
                matrix_sdk::ruma::presence::PresenceState::Offline,
            );
            let _ = timeout(Duration::from_secs(3), client.send(request)).await;
        }
        remotely_signed_out =
            match timeout(Duration::from_secs(8), client.matrix_auth().logout()).await {
                Ok(Ok(_)) => true,
                Ok(Err(error)) => {
                    log_refresh_failure(&error);
                    session_end(&error) == Some(SessionEnd::Revoked)
                }
                Err(_) => false,
            };
    }
    let mut ended = None;
    if let (Some(client), Some(store_dir)) = (&client, store_dir) {
        if let Ok(session) = SavedSession::from_client(client) {
            let mode = *state.account_mode.lock().await;
            let credentials = ended_credentials(
                client.homeserver().to_string(),
                &session,
                store_dir,
                mode,
                SessionEnd::Revoked,
            );
            if let Err(error) = remember_session_end(&app, &credentials, &session) {
                log::error!("Could not record Matrix sign-out: {error}");
            }
            ended = Some(credentials);
        }
    }
    drop(client);
    clear_local_session(&state, &app).await;
    *state.reauthentication.lock().await = ended.clone();
    if let Some(ended) = ended.as_ref() {
        discard_revoked_device(&app, ended)?;
    }
    clear_saved_credentials(app)?;
    state.reauthentication.lock().await.take();
    if remotely_signed_out {
        Ok(())
    } else {
        Err("Signed out on this device. Pax could not confirm sign-out with the homeserver.".into())
    }
}

async fn clear_local_session(state: &Arc<AppState>, app: &tauri::AppHandle) {
    state.audio_recording.lock().await.take();
    state.stop_sync_task().await;
    state.direct_calls.lock().await.clear();
    state.matrix_voip.reset().await;
    state.notifications.reset();
    state.voice_presence.reset();
    state.attachments.reset().await;
    state.stop_heartbeat_loop();
    if let Ok(mut g) = state.voice_livekit_jwt_service_url.lock() {
        *g = None;
    }
    if let Ok(mut delayed_leave) = state.delayed_leave_id.lock() {
        delayed_leave.take();
    }
    if state.voice_room.lock().await.take().is_some() {
        app.state::<crate::voice::VoiceManager>().disconnect().await;
    }
    *state.client.lock().await = None;
    *state.session_store_dir.lock().await = None;
    state.avatars.reset();
    state.file_cache.clear().await;
    super::unread::clear_unread_cache(state).await;

    if let Err(error) = crate::app_badge::set_notification_count(app, 0, false) {
        log::warn!("[badge] failed to clear badge at sign-out: {error}");
    }
}

fn log_refresh_failure(error: &HttpError) {
    let HttpError::RefreshToken(RefreshTokenError::MatrixAuth(error)) = error else {
        return;
    };
    if let Some(response) = error.as_client_api_error() {
        log::warn!(
            "Matrix access token refresh failed (HTTP {})",
            response.status_code.as_u16()
        );
    } else {
        log::warn!("Matrix access token refresh failed (no usable HTTP response)");
    }
}

fn session_end(error: &HttpError) -> Option<SessionEnd> {
    let (error, refreshing) = match error {
        HttpError::RefreshToken(RefreshTokenError::MatrixAuth(error)) => (error.as_ref(), true),
        _ => (error, false),
    };
    let response = error.as_client_api_error()?;
    match (response.status_code.as_u16(), response.error_kind()) {
        (401, Some(ErrorKind::UnknownToken { soft_logout: true })) => Some(SessionEnd::SoftLogout),
        (401, Some(ErrorKind::UnknownToken { soft_logout: false })) => Some(SessionEnd::Revoked),
        (401, Some(ErrorKind::UserLocked)) => Some(SessionEnd::AccountLocked),
        (401, Some(_)) if refreshing => Some(SessionEnd::Revoked),
        _ => None,
    }
}

fn ended_credentials(
    home: String,
    session: &SavedSession,
    store_dir: String,
    mode: AccountMode,
    reason: SessionEnd,
) -> SavedCredentials {
    SavedCredentials {
        homeserver: home,
        session: None,
        sqlite_store_dir: Some(store_dir),
        account_mode: mode,
        pax_enrollment_pending: false,
        reauthentication: Some(Reauthentication {
            user_id: session.user_id.clone(),
            device_id: session.device_id.clone(),
            reason,
        }),
    }
}

fn remember_session_end(
    app: &tauri::AppHandle,
    ended: &SavedCredentials,
    session: &SavedSession,
) -> Result<bool, String> {
    let path = credentials_path(app)?;
    let _guard = CREDENTIALS_LOCK.lock().map_err(|e| e.to_string())?;
    if read_credentials_at(&path)?.is_some_and(|saved| {
        saved.homeserver.trim_end_matches('/') == ended.homeserver.trim_end_matches('/')
            && saved
                .session
                .is_some_and(|s| s.user_id == session.user_id && s.device_id == session.device_id)
    }) {
        write_credentials(&path, ended)?;
        return Ok(true);
    }
    Ok(false)
}

fn discard_revoked_device(app: &tauri::AppHandle, creds: &SavedCredentials) -> Result<(), String> {
    let Some(ended) = creds
        .reauthentication
        .as_ref()
        .filter(|ended| ended.reason == SessionEnd::Revoked)
    else {
        return Ok(());
    };
    let home = &creds.homeserver;
    let user_id = &ended.user_id;
    let device_id = &ended.device_id;
    let enrollment = pax_auth::read_enrollment(app, home, user_id).and_then(|record| {
        if let Some(mut record) = record.filter(|r| r.device_id.as_ref() == Some(device_id)) {
            // The account's authentication mode is still pinned after its device is gone.
            record.device_id = None;
            pax_auth::save_enrollment(app, &record)
        } else {
            Ok(())
        }
    });
    let conversion =
        super::account_conversion::discard_device_binding(app, home, user_id, device_id);
    let store = discard_session_store(
        &app_data_dir(app)?,
        creds.sqlite_store_dir.as_deref().unwrap_or("matrix_store"),
    );
    enrollment.and(conversion).and(store)
}

fn discard_session_store(base: &Path, store_dir: &str) -> Result<(), String> {
    use std::path::Component::Normal;
    let mut parts = Path::new(store_dir).components();
    let safe = match (parts.next(), parts.next(), parts.next()) {
        (Some(Normal(directory)), None, None) => directory == "matrix_store",
        (Some(Normal(parent)), Some(Normal(_)), None) => parent == "matrix_sessions",
        _ => false,
    };
    if !safe {
        return Err("Invalid Matrix session store path".into());
    }
    let path = base.join(store_dir);
    let canonical = match path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not locate the Matrix session store: {error}"
            ))
        }
    };
    let expected = base
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(store_dir);
    if canonical != expected {
        return Err("Invalid Matrix session store location".into());
    }
    std::fs::remove_dir_all(canonical)
        .map_err(|e| format!("Could not discard the Matrix session store: {e}"))
}

pub(super) fn handle_sync_session_error(
    error: &matrix_sdk::Error,
    state: &Arc<AppState>,
    app: &Arc<tauri::AppHandle>,
    client: &Client,
) -> bool {
    let matrix_sdk::Error::Http(error) = error else {
        return false;
    };
    log_refresh_failure(error);
    let Some(reason) = session_end(error) else {
        return false;
    };
    // Teardown joins the sync task, so it must run in a separate task.
    let (state, app, client) = (Arc::clone(state), Arc::clone(app), client.clone());
    tokio::spawn(async move {
        let _operation = state.encryption.operation.lock().await;
        #[cfg(target_os = "android")]
        let _cold_store = crate::call_notifications::android::COLD_STORE.lock().await;
        let active = state
            .client
            .lock()
            .await
            .as_ref()
            .and_then(|current| current.session_meta().zip(client.session_meta()))
            .is_some_and(|(current, ended)| std::ptr::eq(current, ended));
        if !active {
            return;
        }
        let (Ok(session), Some(store_dir)) = (
            SavedSession::from_client(&client),
            state.session_store_dir.lock().await.clone(),
        ) else {
            return;
        };
        let mode = *state.account_mode.lock().await;
        let ended = ended_credentials(
            client.homeserver().to_string(),
            &session,
            store_dir,
            mode,
            reason,
        );
        let remembered = match remember_session_end(&app, &ended, &session) {
            Ok(remembered) => remembered,
            Err(error) => {
                log::error!("Could not clear invalidated Matrix credentials: {error}");
                false
            }
        };
        let details = ended.login_details(remembered);
        *state.reauthentication.lock().await = Some(ended.clone());
        drop(client);
        clear_local_session(&state, &app).await;
        if let Err(error) = discard_revoked_device(&app, &ended) {
            log::error!("Failed to discard invalidated Matrix device: {error}");
        }
        let _ = app.emit("session-ended", details);
    });
    true
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
        reauthentication: None,
    };
    let _guard = CREDENTIALS_LOCK.lock().map_err(|e| e.to_string())?;
    write_credentials(&path, &creds)
}

pub(super) fn save_client_session(
    app: &tauri::AppHandle,
    client: &Client,
    store_dir: &str,
    account_mode: AccountMode,
) -> Result<(), String> {
    let path = credentials_path(app)?;
    let _guard = CREDENTIALS_LOCK.lock().map_err(|e| e.to_string())?;
    write_credentials(
        &path,
        &SavedCredentials {
            homeserver: client.homeserver().to_string(),
            session: Some(SavedSession::from_client(client)?),
            sqlite_store_dir: Some(store_dir.to_owned()),
            account_mode,
            pax_enrollment_pending: false,
            reauthentication: None,
        },
    )
}

fn write_credentials(path: &Path, creds: &SavedCredentials) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(creds)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    pax_auth::atomic_write(path, &json)
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
        reauthentication: None,
    };
    let _guard = CREDENTIALS_LOCK.lock().map_err(|e| e.to_string())?;
    write_credentials(&path, &creds)
}

#[tauri::command]
pub fn load_credentials(app: tauri::AppHandle) -> Result<Option<LoginDetails>, String> {
    Ok(read_credentials(&app)?.map(|creds| creds.login_details(true)))
}

pub(super) fn read_credentials(app: &tauri::AppHandle) -> Result<Option<SavedCredentials>, String> {
    read_credentials_at(&credentials_path(app)?)
}

pub(crate) fn read_credentials_at(path: &Path) -> Result<Option<SavedCredentials>, String> {
    match std::fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map(Some)
            .map_err(|e| format!("Failed to parse credentials: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read credentials: {e}")),
    }
}

#[tauri::command]
pub fn clear_saved_credentials(app: tauri::AppHandle) -> Result<(), String> {
    let path = credentials_path(&app)?;
    let _guard = CREDENTIALS_LOCK.lock().map_err(|e| e.to_string())?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove credentials: {e}")),
    }
}

pub(crate) fn persist_refreshed_tokens(
    client: &Client,
    path: std::path::PathBuf,
    saved: &SavedSession,
) -> Result<(), String> {
    if saved.refresh_token.is_none() {
        return Ok(());
    }
    let previous = Mutex::new(saved.access_token.clone());
    client
        .set_session_callbacks(
            Box::new(|_| Err("Matrix sessions are restored explicitly".into())),
            Box::new(move |client| {
                log::info!("Matrix access token refreshed successfully");
                let _guard = CREDENTIALS_LOCK.lock().map_err(|e| e.to_string())?;
                let mut previous = previous.lock().map_err(|e| e.to_string())?;
                let updated = SavedSession::from_client(&client)?;
                // A request from a replaced client can still finish refreshing.
                // Write only if the file still contains this client's previous token.
                if let Some(mut creds) = read_credentials_at(&path)? {
                    if creds.homeserver.trim_end_matches('/')
                        == client.homeserver().as_str().trim_end_matches('/')
                        && creds.session.as_ref().is_some_and(|saved| {
                            saved.user_id == updated.user_id
                                && saved.device_id == updated.device_id
                                && saved.access_token == *previous
                        })
                    {
                        creds.session = Some(updated.clone());
                        write_credentials(&path, &creds)?;
                    }
                }
                *previous = updated.access_token;
                Ok(())
            }),
        )
        .map_err(|e| format!("Could not set up session refresh: {e}"))
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
                    tokens: session.tokens(),
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
    let (user, device) = match (&creds.reauthentication, &creds.session) {
        (Some(reauthentication), _) if reauthentication.reason != SessionEnd::Revoked => {
            (&reauthentication.user_id, &reauthentication.device_id)
        }
        (None, Some(session)) => (&session.user_id, &session.device_id),
        _ => return None,
    };
    let user_id = matrix_sdk::ruma::UserId::parse(user).ok()?;
    let username = username.trim();
    if username != user_id.as_str() && username != user_id.localpart() {
        return None;
    }
    Some((
        creds
            .sqlite_store_dir
            .clone()
            .unwrap_or_else(|| "matrix_store".into()),
        device.clone(),
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
            .handle_refresh_tokens()
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
        "password": credential, "initial_device_display_name": "Pax", "refresh_token": true,
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
        refresh_token: value["refresh_token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .map(str::to_owned),
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
    let mut body = serde_json::json!({ "username": username, "password": credential, "initial_device_display_name": "Pax", "refresh_token": true });
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
    state.matrix_voip.reset().await;
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
    persist_refreshed_tokens(&client, credentials_path(app)?, session)?;
    restore_tokens(&client, session).await.map_err(|_| {
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
    state.reauthentication.lock().await.take();
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
    #[cfg(target_os = "android")]
    let _cold_store = crate::call_notifications::android::COLD_STORE.lock().await;
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
        save_client_session(&app, &client, &rel, mode)?;
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
        save_client_session(&app, &client, &rel, mode)?;
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
    #[cfg(target_os = "android")]
    let _cold_store = crate::call_notifications::android::COLD_STORE.lock().await;
    let password = zeroize::Zeroizing::new(password);
    let previous_credentials = state
        .reauthentication
        .lock()
        .await
        .clone()
        .or(read_credentials(&app)?);
    let previous_client = state.client.lock().await.clone();
    let reusable = previous_credentials
        .as_ref()
        .and_then(|c| reusable_login_store(c, &homeserver, &username));
    let user = if reusable.is_some() {
        previous_credentials
            .as_ref()
            .and_then(SavedCredentials::user_id)
            .ok_or("Missing device account")?
            .to_owned()
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
    let revoked = previous_credentials.as_ref().is_some_and(|creds| {
        creds.homeserver.trim_end_matches('/') == homeserver.trim_end_matches('/')
            && creds
                .reauthentication
                .as_ref()
                .is_some_and(|ended| ended.reason == SessionEnd::Revoked && ended.user_id == user)
    });
    let reusable = reusable
        .or_else(|| {
            record.as_ref().filter(|_| !revoked).and_then(|r| {
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
        save_client_session(&app, &client, &rel, mode)?;
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

// Validate the session before the installed client's encryption tasks can use its store.
async fn check_saved_session(
    client: &Client,
    saved: &SavedSession,
) -> Result<Option<SessionEnd>, String> {
    for attempt in 0..3 {
        match timeout(Duration::from_secs(5), client.whoami()).await {
            Ok(Ok(response)) => {
                let same_user = response.user_id.as_str() == saved.user_id;
                let same_device = response
                    .device_id
                    .is_none_or(|id| id.as_str() == saved.device_id);
                return Ok((!same_user || !same_device).then_some(SessionEnd::Revoked));
            }
            Ok(Err(error)) => {
                log_refresh_failure(&error);
                if let Some(reason) = session_end(&error) {
                    return Ok(Some(reason));
                }
            }
            Err(_) => {}
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
        }
    }
    Err("Pax could not verify the saved session. Check your connection and try again.".into())
}

async fn restore_tokens(client: &Client, saved: &SavedSession) -> Result<(), String> {
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: matrix_sdk::ruma::UserId::parse(&saved.user_id)
                    .map_err(|_| "Invalid saved Matrix user ID")?,
                device_id: saved.device_id.clone().into(),
            },
            tokens: saved.tokens(),
        })
        .await
        .map_err(|e| {
            format!(
                "Could not restore the saved Matrix session: {}",
                fmt_error_chain(&e)
            )
        })
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
    let creds = read_credentials(&app)?.ok_or("No saved credentials")?;
    if state
        .auth_config
        .default_homeserver
        .as_ref()
        .is_some_and(|configured| {
            creds.homeserver.trim_end_matches('/') != configured.trim_end_matches('/')
        })
    {
        return Err("Saved session is for a different homeserver".into());
    }
    if let Some(ended) = creds.reauthentication.as_ref() {
        if let Err(error) = discard_revoked_device(&app, &creds) {
            log::error!("Failed to discard invalidated Matrix device: {error}");
        }
        return Err(ended.reason.message().into());
    }
    let saved = creds.session.as_ref().ok_or("No saved session")?;
    let store_dir = creds.sqlite_store_dir.as_deref().unwrap_or("matrix_store");

    let probe = Client::builder()
        .homeserver_url(&creds.homeserver)
        .handle_refresh_tokens()
        .build()
        .await
        .map_err(|_| "Pax could not connect to the saved homeserver.")?;
    persist_refreshed_tokens(&probe, credentials_path(&app)?, saved)?;
    restore_tokens(&probe, saved)
        .await
        .map_err(|_| "Could not read the saved Matrix session.")?;
    let reason = check_saved_session(&probe, saved).await?;
    let session = SavedSession::from_client(&probe)?;
    drop(probe);

    if let Some(reason) = reason {
        let ended = ended_credentials(
            creds.homeserver.clone(),
            &session,
            store_dir.into(),
            creds.account_mode,
            reason,
        );
        *state.reauthentication.lock().await = Some(ended.clone());
        if let Err(error) = remember_session_end(&app, &ended, &session) {
            log::error!("Could not clear invalidated Matrix credentials: {error}");
        }
        if let Err(error) = discard_revoked_device(&app, &ended) {
            log::error!("Failed to discard invalidated Matrix device: {error}");
        }
        return Err(reason.message().into());
    }
    if creds.pax_enrollment_pending {
        return Err(PAX_SETUP_REQUIRED.into());
    }
    if super::account_conversion::read_journal(&app, &creds.homeserver, &session.user_id)?
        .is_some_and(|journal| !journal.record.complete)
    {
        return Err(super::account_conversion::PENDING_MESSAGE.into());
    }
    let pinned = creds.account_mode == AccountMode::Pax
        || pax_auth::read_enrollment(&app, &creds.homeserver, &session.user_id)?
            .is_some_and(|enrollment| enrollment.registered || enrollment.ready);
    let mode = saved_session_mode(
        &state.http_client,
        &creds.homeserver,
        &session.user_id,
        &state.auth_config,
        pinned,
    )
    .await?;

    if mode == AccountMode::Pax && !sqlite_path_for_restore(&app, &creds)?.exists() {
        return Err(PAX_RECOVERY_REQUIRED.into());
    }
    let client =
        restore_authenticated_client(&app, &creds.homeserver, &session, store_dir, mode).await?;
    if mode == AccountMode::Pax {
        client
            .encryption()
            .wait_for_e2ee_initialization_tasks()
            .await;
        if !client
            .encryption()
            .cross_signing_status()
            .await
            .is_some_and(|status| status.is_complete())
            || !client.encryption().backups().are_enabled().await
        {
            return Err(PAX_RECOVERY_REQUIRED.into());
        }
    }
    if mode != creds.account_mode {
        save_client_session(&app, &client, store_dir, mode)?;
    }
    install_session(&state, client, mode, store_dir.to_owned()).await
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

    const WHOAMI: &str = "/_matrix/client/v3/account/whoami";
    const REFRESH: &str = "/_matrix/client/v3/refresh";

    fn old_saved_session() -> SavedSession {
        serde_json::from_value(json!({
            "user_id": USER, "device_id": "ORIGINAL", "access_token": "old-access"
        }))
        .unwrap()
    }

    async fn refresh_test_client(server: &Server, session: &SavedSession, path: &Path) -> Client {
        let client = Client::builder()
            .homeserver_url(&server.home)
            .request_config(RequestConfig::default().disable_retry())
            .handle_refresh_tokens()
            .build()
            .await
            .unwrap();
        persist_refreshed_tokens(&client, path.to_owned(), session).unwrap();
        restore_tokens(&client, session).await.unwrap();
        client
    }

    #[tokio::test]
    async fn refresh_retries_authenticated_request_and_saves_rotated_tokens() {
        let server = Server::start().await;
        let directory = TestDir(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()));
        std::fs::create_dir(&directory.0).unwrap();
        let path = directory.0.join(CREDENTIALS_FILENAME);
        let mut session = old_saved_session();
        session.refresh_token = Some("refresh-1".into());
        let creds = SavedCredentials {
            homeserver: server.home.clone(),
            session: Some(session.clone()),
            sqlite_store_dir: Some("matrix_store".into()),
            account_mode: AccountMode::Matrix,
            pax_enrollment_pending: false,
            reauthentication: None,
        };
        write_credentials(&path, &creds).unwrap();
        {
            let mut mock = server.state.lock().unwrap();
            mock.expired_whoami_token = Some(session.access_token.clone());
            mock.route_overrides.insert(
                ("POST".into(), REFRESH.into()),
                (
                    200,
                    json!({
                        "access_token":"new-access", "refresh_token":"refresh-2"
                    }),
                ),
            );
        }
        let client = refresh_test_client(&server, &session, &path).await;
        assert_eq!(check_saved_session(&client, &session).await.unwrap(), None);
        let stored = read_credentials_at(&path)
            .unwrap()
            .unwrap()
            .session
            .unwrap();
        assert_eq!(stored.access_token, "new-access");
        assert_eq!(stored.refresh_token.as_deref(), Some("refresh-2"));
        assert_eq!(stored.device_id, session.device_id);
        assert!(server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(_, path, body)| { path == REFRESH && body["refresh_token"] == "refresh-1" }));

        std::fs::remove_file(&path).unwrap();
        client.matrix_auth().refresh_access_token().await.unwrap();
        assert!(read_credentials_at(&path).unwrap().is_none());
    }

    #[tokio::test]
    async fn startup_distinguishes_soft_logout_revocation_and_refresh_failures() {
        let server = Server::start().await;
        let directory = TestDir(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()));
        let path = directory.0.join(CREDENTIALS_FILENAME);
        let mut session = old_saved_session();
        let deny = |path: &str, status, body| {
            let method = if path == WHOAMI { "GET" } else { "POST" };
            server
                .state
                .lock()
                .unwrap()
                .route_overrides
                .insert((method.into(), path.into()), (status, body));
        };
        deny(
            WHOAMI,
            401,
            json!({"errcode":"M_UNKNOWN_TOKEN", "error":"Test response", "soft_logout":true}),
        );
        let legacy = refresh_test_client(&server, &session, &path).await;
        assert!(session.refresh_token.is_none());
        assert_eq!(
            check_saved_session(&legacy, &session).await.unwrap(),
            Some(SessionEnd::SoftLogout)
        );
        deny(
            WHOAMI,
            401,
            json!({"errcode":"M_UNKNOWN_TOKEN", "error":"Test response"}),
        );
        assert_eq!(
            check_saved_session(&legacy, &session).await.unwrap(),
            Some(SessionEnd::Revoked)
        );
        deny(
            WHOAMI,
            401,
            json!({"errcode":"M_USER_LOCKED", "error":"Test response", "soft_logout":true}),
        );
        assert_eq!(
            check_saved_session(&legacy, &session).await.unwrap(),
            Some(SessionEnd::AccountLocked)
        );

        session.refresh_token = Some("refresh-1".into());
        let client = refresh_test_client(&server, &session, &path).await;
        deny(
            WHOAMI,
            401,
            json!({"errcode":"M_UNKNOWN_TOKEN", "error":"Test response", "soft_logout":true}),
        );
        deny(
            REFRESH,
            401,
            json!({"errcode":"M_UNKNOWN_TOKEN", "error":"Test response"}),
        );
        assert_eq!(
            check_saved_session(&client, &session).await.unwrap(),
            Some(SessionEnd::Revoked)
        );
        deny(
            REFRESH,
            401,
            json!({"errcode":"M_UNKNOWN_TOKEN", "error":"Test response", "soft_logout":true}),
        );
        assert_eq!(
            check_saved_session(&client, &session).await.unwrap(),
            Some(SessionEnd::SoftLogout)
        );
        deny(
            REFRESH,
            503,
            json!({"errcode":"M_UNKNOWN", "error":"Test response"}),
        );
        assert!(check_saved_session(&client, &session).await.is_err());
    }

    #[test]
    fn ended_session_reuses_device_only_for_reauthentication() {
        let session = old_saved_session();
        let home = "https://example.org";
        for mode in [AccountMode::Pax, AccountMode::Matrix] {
            for reason in [
                SessionEnd::SoftLogout,
                SessionEnd::Revoked,
                SessionEnd::AccountLocked,
            ] {
                let record =
                    ended_credentials(home.into(), &session, "matrix_store".into(), mode, reason);
                let serialized = serde_json::to_vec(&record).unwrap();
                let restored: SavedCredentials = serde_json::from_slice(&serialized).unwrap();
                assert!(restored.session.is_none());
                assert_eq!(restored.user_id(), Some(USER));
                assert_eq!(
                    reusable_login_store(&restored, home, "alice"),
                    (reason != SessionEnd::Revoked)
                        .then(|| { ("matrix_store".into(), session.device_id.clone()) })
                );
            }
        }
    }

    #[test]
    fn discard_removes_only_the_selected_matrix_store() {
        let directory = TestDir(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()));
        let removed = directory.0.join("matrix_sessions/revoked");
        let retained = directory.0.join("matrix_sessions/other");
        std::fs::create_dir_all(&removed).unwrap();
        std::fs::create_dir_all(&retained).unwrap();
        assert!(
            discard_session_store(&directory.0, "matrix_sessions/../matrix_sessions/other")
                .is_err()
        );
        discard_session_store(&directory.0, "matrix_sessions/revoked").unwrap();
        assert!(!removed.exists());
        assert!(retained.exists());
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
                refresh_token: None,
            }),
            sqlite_store_dir: Some("matrix_sessions/pw_original".into()),
            account_mode: AccountMode::Matrix,
            pax_enrollment_pending: false,
            reauthentication: None,
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

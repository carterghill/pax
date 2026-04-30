use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::timeout;
use tauri::{Manager, State};

use crate::AppState;

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
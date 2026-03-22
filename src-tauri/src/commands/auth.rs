use std::sync::Arc;

use serde::{Deserialize, Serialize};
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
    state.stop_call_member_refresh_loop();
    if let Ok(mut m) = state.livekit_matrix_to_sfu_room.lock() {
        m.clear();
    }
    *state.client.lock().await = None;
    state.avatar_cache.lock().await.clear();
    state.presence_map.lock().await.clear();
    *state.sync_running.lock().await = false;

    // Clear the SQLite store so the next login starts fresh.
    if let Ok(dir) = app.path().app_data_dir() {
        let store_path = dir.join("matrix_store");
        let _ = std::fs::remove_dir_all(&store_path);
    }
    Ok(())
}

pub fn save_session_to_credentials(app: &tauri::AppHandle, session: SavedSession) -> Result<(), String> {
    let path = credentials_path(app)?;
    if !path.exists() {
        return Ok(());
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read credentials: {e}"))?;
    let mut creds: SavedCredentials = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse credentials: {e}"))?;
    creds.session = Some(session);
    let json = serde_json::to_string_pretty(&creds)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write credentials: {e}"))?;
    Ok(())
}

/// Persist the homeserver URL (no password). Session tokens are patched in
/// later by `save_session_to_credentials` after a successful login.
#[tauri::command]
pub fn save_credentials(
    app: tauri::AppHandle,
    homeserver: String,
) -> Result<(), String> {
    let path = credentials_path(&app)?;
    let creds = SavedCredentials {
        homeserver,
        session: None,
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
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read credentials: {e}"))?;
    let creds: SavedCredentials = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse credentials: {e}"))?;
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
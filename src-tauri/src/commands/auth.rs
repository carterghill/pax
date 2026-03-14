use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::AppState;

const CREDENTIALS_FILENAME: &str = "credentials.json";

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedCredentials {
    pub homeserver: String,
    pub username: String,
    pub password: String,
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
pub async fn logout(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.client.lock().await = None;
    state.avatar_cache.lock().await.clear();
    state.presence_map.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub fn save_credentials(
    app: tauri::AppHandle,
    homeserver: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let path = credentials_path(&app)?;
    let creds = SavedCredentials {
        homeserver,
        username,
        password,
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

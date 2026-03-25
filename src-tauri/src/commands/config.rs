use std::sync::Arc;

use crate::{AppState, AuthConfig};

#[tauri::command]
pub async fn get_giphy_api_key(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    Ok(state.giphy_api_key.clone().unwrap_or_default())
}

#[tauri::command]
pub async fn get_auth_config(state: tauri::State<'_, Arc<AppState>>) -> Result<AuthConfig, String> {
    Ok(state.auth_config.clone())
}
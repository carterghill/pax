use std::sync::Arc;

use crate::AppState;

#[tauri::command]
pub async fn get_tenor_api_key(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    Ok(state.tenor_api_key.clone().unwrap_or_default())
}
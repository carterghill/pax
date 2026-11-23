//! App lifecycle helpers: quit and hide main window (e.g. minimize to tray).

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{voice::VoiceManager, AppState};

const PREFS_FILENAME: &str = "close_window_preference.json";
const VOICE_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
struct CloseWindowPreferenceFile {
    /// `"minimize_tray"` or `"quit"`.
    action: String,
}

fn prefs_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(PREFS_FILENAME))
}

/// Returns `Some("minimize_tray")`, `Some("quit")`, or `None` when the user wants the dialog each time.
#[tauri::command]
pub fn get_close_window_preference(app: AppHandle) -> Result<Option<String>, String> {
    let path = prefs_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let parsed: CloseWindowPreferenceFile =
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if parsed.action != "minimize_tray" && parsed.action != "quit" {
        return Ok(None);
    }
    Ok(Some(parsed.action))
}

#[tauri::command]
pub fn set_close_window_preference(app: AppHandle, action: String) -> Result<(), String> {
    if action != "minimize_tray" && action != "quit" {
        return Err("action must be minimize_tray or quit".to_string());
    }
    let path = prefs_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = CloseWindowPreferenceFile { action };
    let json = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_close_window_preference(app: AppHandle) -> Result<(), String> {
    let path = prefs_path(&app)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

pub(crate) async fn close_voice_before_exit(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let voice = app.state::<VoiceManager>();
    let result = tokio::time::timeout(VOICE_EXIT_TIMEOUT, async {
        let _voice_operation = state.voice_room.lock().await;
        state.stop_heartbeat_loop();
        state.group_calls.lock().await.clear();
        state.matrix_voip.reset().await;
        voice.close_media_for_exit().await;
    })
    .await;
    if result.is_err() {
        log::warn!("Timed out closing LiveKit during app exit");
    }
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    #[cfg(desktop)]
    {
        return win.hide().map_err(|e| e.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = win;
        Ok(())
    }
}

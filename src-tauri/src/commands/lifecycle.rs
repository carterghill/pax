//! App lifecycle helpers: quit and hide main window (e.g. minimize to tray).

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const PREFS_FILENAME: &str = "close_window_preference.json";

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

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.hide().map_err(|e| e.to_string())
}
//! App lifecycle helpers: quit and hide main window (e.g. minimize to tray).

use tauri::{AppHandle, Manager};

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

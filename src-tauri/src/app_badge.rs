use tauri::AppHandle;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;

#[cfg(target_os = "ios")]
pub(crate) mod ios;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

#[tauri::command]
pub fn set_app_notification_count(
    app: AppHandle,
    count: u64,
    show_on_desktop: bool,
) -> Result<(), String> {
    set_notification_count(&app, count, show_on_desktop)
}

pub(crate) fn set_notification_count(
    app: &AppHandle,
    count: u64,
    show_on_desktop: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    let count = if show_on_desktop { count } else { 0 };
    #[cfg(target_os = "linux")]
    linux::set(count);
    #[cfg(target_os = "ios")]
    ios::set(count);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        let result = window.set_badge_label((count > 0).then(|| count.to_string()));
        #[cfg(target_os = "windows")]
        let result = windows::set(&window, count);
        result.map_err(|error| error.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (app, count);
    #[cfg(not(desktop))]
    let _ = show_on_desktop;
    Ok(())
}

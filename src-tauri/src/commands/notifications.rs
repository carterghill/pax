//! Desktop notification dispatch + window focus.
//!
//! Thin Tauri-command wrappers over `tauri-plugin-notification` for sending
//! a notification, plus `focus_main_window` for the click-to-focus flow that
//! pairs with it.  The actual "should we notify?" policy (active-room
//! suppression, level gating, mention matching) lives in the frontend hook
//! `useDesktopNotifications` — this module is deliberately dumb.
//!
//! ### Permission model
//!
//! `tauri-plugin-notification` on macOS and mobile requires a permission
//! grant from the user before it can display notifications.  `notify_send`
//! checks-and-requests on every call; `notify_supported` surfaces the
//! current permission state so the frontend can decide whether to show a
//! banner or settings prompt.  On Linux and Windows the plugin typically
//! returns `Granted` immediately (those OSes don't gate per-app).

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// Returns true iff this platform + permission state allows notifications
/// to be shown right now.  The frontend uses this to decide whether to
/// attempt `notify_send` or silently drop.
///
/// Side effect: if permission is in the `Unknown` state (first launch on
/// macOS / iOS / Android), this will prompt the user.  On Linux + Windows
/// permission is usually implicit so this resolves immediately.
#[tauri::command]
pub async fn notify_supported(app: AppHandle) -> Result<bool, String> {
    let notif = app.notification();
    match notif
        .permission_state()
        .map_err(|e| format!("permission_state: {e}"))?
    {
        PermissionState::Granted => Ok(true),
        PermissionState::Denied => Ok(false),
        // First-run-ish states — request and return the resolved value.
        _ => match notif
            .request_permission()
            .map_err(|e| format!("request_permission: {e}"))?
        {
            PermissionState::Granted => Ok(true),
            _ => Ok(false),
        },
    }
}

/// Show a desktop notification.  Returns `Err` only on plugin-level
/// failures (e.g. the OS refused to display); gating on permission state
/// and "should we notify at all" is the caller's responsibility.
///
/// `body` is a single line in most desktop UIs; the plugin handles
/// truncation per platform.  `icon_path` is an absolute filesystem path
/// (optional).  We don't pass the app's default icon explicitly because
/// the plugin falls back to the bundle icon on every supported OS.
#[tauri::command]
pub async fn notify_send(
    app: AppHandle,
    title: String,
    body: String,
    icon_path: Option<String>,
) -> Result<(), String> {
    let mut builder = app.notification().builder().title(&title).body(&body);
    if let Some(path) = icon_path.as_ref() {
        builder = builder.icon(path);
    }
    builder
        .show()
        .map_err(|e| format!("notification show: {e}"))
}

/// Bring the main window to the foreground.  Used by the "click the
/// notification to jump to the room" flow — the frontend listens for the
/// plugin's click event, invokes this, then navigates to the room.
///
/// No-op (returning Ok) if the main window is already visible and
/// foreground, or if the window has been torn down (shouldn't happen
/// during a live session but worth being defensive about).
#[tauri::command]
pub async fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    #[cfg(desktop)]
    {
        // `unminimize` is a no-op if not minimized; `show` is a no-op if
        // already visible. Both are cheap — we issue them unconditionally
        // rather than querying state first.
        let _ = win.unminimize();
        let _ = win.show();
        return win.set_focus().map_err(|e| format!("set_focus: {e}"));
    }
    #[cfg(not(desktop))]
    {
        let _ = win;
        Ok(())
    }
}
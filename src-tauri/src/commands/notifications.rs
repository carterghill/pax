//! Message banners and local mobile notification delivery.

use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[tauri::command]
pub fn message_notification_delivery() -> &'static str {
    if cfg!(desktop) {
        "desktop"
    } else if super::push::push_gateway_url().is_some() {
        "mobilePush"
    } else {
        "mobileLocal"
    }
}

#[tauri::command]
pub async fn notify_supported(app: AppHandle) -> Result<bool, String> {
    notification_permission(&app)
}

fn notification_permission(app: &AppHandle) -> Result<bool, String> {
    let notifications = app.notification();
    let state = notifications
        .permission_state()
        .map_err(|e| e.to_string())?;
    match state {
        PermissionState::Granted => Ok(true),
        PermissionState::Denied => Ok(false),
        _ => notifications
            .request_permission()
            .map(|state| state == PermissionState::Granted)
            .map_err(|e| e.to_string()),
    }
}

/// Local delivery for a mobile client without a push gateway.
#[tauri::command]
pub async fn notify_send(
    app: AppHandle,
    title: String,
    body: String,
    icon_path: Option<String>,
) -> Result<(), String> {
    let mut builder = app.notification().builder().title(&title).body(&body);
    #[cfg(target_os = "android")]
    {
        builder = builder.channel_id("pax_message_alerts");
    }
    if let Some(path) = icon_path.as_ref() {
        builder = builder.icon(path);
    }
    builder
        .show()
        .map_err(|e| format!("notification show: {e}"))
}

#[cfg(desktop)]
pub(super) mod desktop;

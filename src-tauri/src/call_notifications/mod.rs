use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[cfg(target_os = "android")]
pub(crate) mod android;

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[path = "apple.rs"]
mod platform;

#[cfg(target_os = "macos")]
pub(crate) use platform::initialize_macos;
#[cfg(target_os = "ios")]
pub(crate) use platform::{close_ios_ringing_call, initialize_ios, ios_voip_token};
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CallPhase {
    Incoming,
    Answering,
    Active,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IncomingCall {
    call_id: uuid::Uuid,
    caller: String,
    #[serde(default)]
    video: bool,
    expires_at: u64,
    phase: CallPhase,
}

#[cfg(not(target_os = "android"))]
struct PresentedCall {
    id: uuid::Uuid,
    notification: platform::Notification,
}

#[derive(Default)]
pub(crate) struct CallNotifications {
    #[cfg(not(target_os = "android"))]
    current: Mutex<Option<PresentedCall>>,
    #[cfg(target_os = "ios")]
    queued: std::sync::Mutex<Option<NotificationAction>>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Answer,
    Decline,
    #[cfg(target_os = "ios")]
    End,
    Open,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationAction {
    call_id: uuid::Uuid,
    action: Action,
}

#[cfg(not(target_os = "android"))]
fn report_action(app: &AppHandle, id: uuid::Uuid, action: Action) {
    #[cfg(desktop)]
    if matches!(action, Action::Open | Action::Answer) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    let action = NotificationAction {
        call_id: id,
        action,
    };
    #[cfg(target_os = "ios")]
    if let Ok(mut queued) = app.state::<CallNotifications>().queued.lock() {
        *queued = Some(action.clone());
    }
    let _ = app.emit("call-notification-action", action);
}

#[tauri::command]
pub(crate) fn take_call_notification_action(
    state: State<'_, CallNotifications>,
) -> Option<NotificationAction> {
    #[cfg(target_os = "ios")]
    return state.queued.lock().ok()?.take();
    #[cfg(not(target_os = "ios"))]
    {
        let _ = state;
        None
    }
}

#[tauri::command]
pub(crate) async fn sync_call_notification(
    app: AppHandle,
    notifications: State<'_, CallNotifications>,
    call: Option<IncomingCall>,
    busy: bool,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, notifications, call, busy);
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "ios")]
        platform::set_busy(busy);
        #[cfg(desktop)]
        let _ = busy;

        let mut current = notifications.current.lock().await;
        if let Some(presented) = current.as_ref() {
            if let Some(call) = call.as_ref().filter(|call| call.call_id == presented.id) {
                #[cfg(target_os = "ios")]
                {
                    presented.notification.update(call.phase);
                    return Ok(());
                }
                #[cfg(desktop)]
                if call.phase == CallPhase::Incoming {
                    return Ok(());
                }
            }
        }
        if let Some(previous) = current.take() {
            previous.notification.close().await;
        }
        let Some(call) = call.filter(|call| call.phase == CallPhase::Incoming) else {
            return Ok(());
        };
        let remaining = call
            .expires_at
            .saturating_sub(crate::voice_presence::now_ms())
            .min(150_000);
        if remaining == 0 {
            return Ok(());
        }
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if app.get_webview_window("main").is_some_and(|window| {
            window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
        }) {
            return Ok(());
        }
        let id = call.call_id;
        let notification = platform::Notification::show(&app, &call, remaining).await?;
        *current = Some(PresentedCall { id, notification });

        #[cfg(desktop)]
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(remaining)).await;
            let state = app.state::<CallNotifications>();
            let mut current = state.current.lock().await;
            if current.as_ref().is_some_and(|call| call.id == id) {
                if let Some(expired) = current.take() {
                    expired.notification.close().await;
                }
            }
        });
        Ok(())
    }
}

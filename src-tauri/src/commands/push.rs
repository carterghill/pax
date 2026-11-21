//! Matrix pusher registration for FCM, iOS VoIP, and iOS badges.
//!
//! The flow is:
//!   1. Kotlin `MainActivity` fetches the FCM device token and injects it
//!      into the WebView (`window.__paxFcmToken`).
//!   2. The frontend hook `usePushNotifications` reads the token and
//!      calls `register_pusher` with it.
//!   3. This module POSTs `/_matrix/client/v3/pushers/set` on the user's
//!      homeserver, pointing at our Sygnal push-gateway instance.
//!   4. On logout the frontend calls `unregister_pusher` to remove it.
//!
//! Pusher `data` omits `format: event_id_only` so the homeserver sends the
//! full notification payload (sender, room name, message preview) to Sygnal.
//!
//! Background notification *display* is handled entirely on the Kotlin side
//! (`PaxFCMService`) — Sygnal sends FCM data messages, the service shows an
//! Android system notification, no Rust involvement needed for that path.

use std::sync::Arc;

#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::State;

use crate::AppState;

/// Compile-time push gateway URL (e.g. `https://push.brandxtech.ca`).
/// Set via `PAX_PUSH_GATEWAY_URL` in `.env` / shell environment.
pub(crate) fn push_gateway_url() -> Option<&'static str> {
    #[cfg(target_os = "android")]
    return option_env!("PAX_PUSH_GATEWAY_URL");
    #[cfg(target_os = "ios")]
    return option_env!("PAX_IOS_VOIP_PUSH_GATEWAY_URL");
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return None;
}

/// The reverse-DNS app id registered in Sygnal's config.
const APP_ID: &str = if cfg!(target_os = "ios") {
    "com.carter.pax.voip"
} else {
    "com.carter.pax"
};

const IOS_BADGE_APP_ID: &str = "com.carter.pax.badge";

fn badge_gateway_url() -> Option<&'static str> {
    #[cfg(target_os = "ios")]
    return option_env!("PAX_IOS_BADGE_PUSH_GATEWAY_URL");
    #[cfg(not(target_os = "ios"))]
    return None;
}

/// Human-readable name shown in the homeserver's pusher list.
const APP_DISPLAY_NAME: &str = "Pax";

/// Register a mobile push token as a Matrix pusher on the user's homeserver.
///
/// Called by the frontend after login / session restore / token refresh.
/// Safe to call multiple times with the same token — the homeserver
/// deduplicates by `(app_id, pushkey)`.
#[tauri::command]
pub async fn register_pusher(
    state: State<'_, Arc<AppState>>,
    push_key: String,
    device_display_name: String,
    badge_only: Option<bool>,
) -> Result<(), String> {
    let badge_only = badge_only.unwrap_or(false);
    let (app_id, gateway_url) = if badge_only {
        (IOS_BADGE_APP_ID, badge_gateway_url())
    } else {
        (APP_ID, push_gateway_url())
    };
    let gateway_url = gateway_url.ok_or("No push gateway URL configured for this platform")?;

    let ac = super::get_authed_client(&state).await?;

    let url = format!(
        "{}/_matrix/client/v3/pushers/set",
        ac.homeserver
    );

    // Android previews and the existing VoIP gateway use the full payload.
    // The badge gateway needs only the event ID and notification count.
    let mut data = serde_json::json!({
        "url": format!("{}/_matrix/push/v1/notify", gateway_url.trim_end_matches('/'))
    });
    if badge_only {
        data["format"] = serde_json::json!("event_id_only");
    }
    let body = serde_json::json!({
        "app_display_name": APP_DISPLAY_NAME,
        "app_id": app_id,
        "data": data,
        "device_display_name": device_display_name,
        "kind": "http",
        "lang": "en",
        "pushkey": push_key
    });

    log::info!("[push] registering pusher with gateway {}", gateway_url);

    let resp = state
        .http_client
        .post(&url)
        .bearer_auth(&ac.access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to register pusher: {}", super::fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Pusher registration failed ({}): {}", status, text));
    }

    log::info!("[push] pusher registered successfully");
    if badge_only {
        return Ok(());
    }

    // Encrypted room events already use the homeserver's encrypted-message rules.
    // Unencrypted Pax calls need a rule below room-level notification preferences.
    let rule = "com.carter.pax.direct_call";
    let rule_url = format!("{}/_matrix/client/v3/pushrules/global/underride/{rule}", ac.homeserver);
    if let Ok(existing) = state.http_client.get(&rule_url).bearer_auth(&ac.access_token).send().await {
        if existing.status() == reqwest::StatusCode::NOT_FOUND {
            let result = super::push_rules::put_push_rule_raw(
                &state,
                "underride",
                rule,
                &serde_json::json!({
                    "conditions": [{ "kind": "event_match", "key": "type", "pattern": rule }],
                    "actions": ["notify", { "set_tweak": "sound", "value": "ring" }],
                }),
                None,
                None,
            ).await;
            if let Err(error) = result {
                log::warn!("Could not set up the push rule for unencrypted Pax calls: {error}");
            }
        }
    }
    Ok(())
}

/// Remove a mobile pusher from the homeserver.
///
/// Called on logout so the server stops sending pushes to a device
/// the user has signed out of.  `kind: null` tells the server to
/// delete the pusher matching `(app_id, pushkey)`.
#[tauri::command]
pub async fn unregister_pusher(
    state: State<'_, Arc<AppState>>,
    push_key: String,
    badge_only: Option<bool>,
) -> Result<(), String> {
    let ac = super::get_authed_client(&state).await?;

    let url = format!(
        "{}/_matrix/client/v3/pushers/set",
        ac.homeserver
    );

    let body = serde_json::json!({
        "app_id": if badge_only.unwrap_or(false) { IOS_BADGE_APP_ID } else { APP_ID },
        "kind": null,
        "pushkey": push_key
    });

    log::info!("[push] unregistering pusher");

    let resp = state
        .http_client
        .post(&url)
        .bearer_auth(&ac.access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to unregister pusher: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // Non-fatal on logout — log but don't block the sign-out flow.
        log::warn!("[push] unregister failed ({}): {}", status, text);
    } else {
        log::info!("[push] pusher unregistered successfully");
    }

    Ok(())
}

/// Read the FCM token from the file written by MainActivity.kt.
/// Returns `None` if the file doesn't exist (non-Android builds, or
/// first launch before Firebase has fetched a token).
#[tauri::command]
pub async fn get_fcm_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        // Kotlin's filesDir = /data/data/<pkg>/files/
        // Try multiple paths since Tauri's data_dir may differ from filesDir
        let candidates = vec![
            std::path::PathBuf::from("/data/data/com.carter.pax/files/fcm_token.txt"),
            {
                let d = app.path().data_dir().unwrap_or_default();
                d.join("fcm_token.txt")
            },
            {
                let d = app.path().app_data_dir().unwrap_or_default();
                d.join("fcm_token.txt")
            },
        ];
        for path in &candidates {
            if let Ok(token) = std::fs::read_to_string(path) {
                let token = token.trim().to_string();
                if !token.is_empty() {
                    log::info!(
                        "[push] read FCM token from {:?} ({} chars)",
                        path,
                        token.len()
                    );
                    return Ok(Some(token));
                }
            }
        }
        log::warn!("[push] FCM token file not found in any candidate path");
        Ok(None)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Returns whether push notifications are configured for this build.
/// The frontend uses this to decide whether to attempt registration.
#[tauri::command]
pub fn push_gateway_configured(badge_only: Option<bool>) -> bool {
    if badge_only.unwrap_or(false) {
        badge_gateway_url().is_some()
    } else {
        push_gateway_url().is_some()
    }
}

#[tauri::command]
pub fn get_ios_badge_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "ios")]
    if badge_gateway_url().is_some() {
        return crate::app_badge::ios::push_token(app);
    }
    let _ = app;
    None
}

#[tauri::command]
pub fn get_ios_voip_token() -> Option<String> {
    #[cfg(target_os = "ios")]
    return crate::call_notifications::ios_voip_token();
    #[cfg(not(target_os = "ios"))]
    return None;
}

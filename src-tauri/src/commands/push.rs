//! Matrix pusher registration for FCM, iOS VoIP, and iOS badges.
//!
//! Android reconciles its pusher from a native job. iOS registers its tokens
//! through the WebView as they become available.

use std::sync::Arc;

use matrix_sdk::{
    config::RequestConfig,
    ruma::{
        api::client::push::{get_pushrule, set_pushrule},
        push::{Action, NewConditionalPushRule, NewPushRule, PushCondition, RuleKind, Tweak},
    },
    Client,
};
use tauri::State;

use crate::AppState;

#[cfg(target_os = "android")]
pub(crate) mod android;

pub(crate) fn push_gateway_url() -> Option<&'static str> {
    #[cfg(target_os = "android")]
    return option_env!("PAX_PUSH_GATEWAY_URL").filter(|url| !url.trim().is_empty());
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

fn notify_url(gateway_url: &str) -> Result<String, String> {
    const NOTIFY_PATH: &str = "/_matrix/push/v1/notify";
    let mut url = reqwest::Url::parse(gateway_url).map_err(|_| "Invalid push gateway URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The push gateway must be an HTTPS URL without credentials, query or fragment".into(),
        );
    }
    if matches!(url.path().trim_end_matches('/'), "" | NOTIFY_PATH) {
        url.set_path(NOTIFY_PATH);
        Ok(url.into())
    } else {
        Err(format!(
            "The push gateway URL must have a root path or {NOTIFY_PATH}"
        ))
    }
}

async fn ensure_call_rule(client: &Client) {
    let rule_id = super::direct_calls::CALL_EVENT;
    let config = RequestConfig::new()
        .timeout(std::time::Duration::from_secs(3))
        .disable_retry();
    let existing = client
        .send(get_pushrule::v3::Request::new(
            RuleKind::Underride,
            rule_id.to_owned(),
        ))
        .with_request_config(config)
        .await;
    if existing
        .err()
        .and_then(|error| error.as_client_api_error().map(|api| api.status_code))
        != Some(reqwest::StatusCode::NOT_FOUND)
    {
        return;
    }

    let rule = NewConditionalPushRule::new(
        rule_id.to_owned(),
        vec![PushCondition::EventMatch {
            key: "type".into(),
            pattern: rule_id.into(),
        }],
        vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound("ring".into())),
        ],
    );
    if let Err(error) = client
        .send(set_pushrule::v3::Request::new(NewPushRule::Underride(rule)))
        .with_request_config(config)
        .await
    {
        log::warn!("Could not set up the push rule for unencrypted Pax calls: {error}");
    }
}

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

    let url = format!("{}/_matrix/client/v3/pushers/set", ac.homeserver);

    // Android previews and the existing VoIP gateway use the full payload.
    // The badge gateway needs only the event ID and notification count.
    let mut data = serde_json::json!({
        "url": if cfg!(target_os = "android") {
            notify_url(gateway_url)?
        } else {
            format!("{}/_matrix/push/v1/notify", gateway_url.trim_end_matches('/'))
        }
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
    if !badge_only {
        ensure_call_rule(&ac.client).await;
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

    let url = format!("{}/_matrix/client/v3/pushers/set", ac.homeserver);

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

#[cfg(test)]
mod tests {
    use super::notify_url;

    #[test]
    fn gateway_origin_and_full_endpoint_produce_the_same_notify_url() {
        let expected = "https://push.example.org/_matrix/push/v1/notify";
        for input in ["https://push.example.org/", expected] {
            assert_eq!(notify_url(input).unwrap(), expected);
        }
    }

    #[test]
    fn gateway_url_rejects_http_and_non_matrix_paths() {
        for input in ["http://push.example.org", "https://push.example.org/custom"] {
            assert!(notify_url(input).is_err(), "{input}");
        }
    }
}

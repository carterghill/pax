use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use jni::{
    objects::{JObject, JString},
    sys::{jboolean, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};
use matrix_sdk::{
    config::RequestConfig,
    ruma::{
        api::client::{
            error::{ErrorKind, RetryAfter},
            push::{set_pusher::v3::Request, PusherIds, PusherInit, PusherKind},
        },
        push::HttpPusherData,
    },
    Client, HttpError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::{ensure_call_rule, notify_url, push_gateway_url, APP_DISPLAY_NAME, APP_ID};
use crate::{
    call_notifications::android::{app_state, runtime, saved_client, COLD_STORE},
    commands::pax_auth::atomic_write,
    voice_presence::now_ms,
};

pub(crate) static REGISTRATION_LOCK: Mutex<()> = Mutex::const_new(());
const REFRESH_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

// Store attempted tokens before sending the request. A timeout or process exit
// can happen after the homeserver accepts a pusher.
#[derive(Default, Deserialize, Serialize)]
struct Registration {
    pushkeys: Vec<String>,
    current: Option<RegisteredPusher>,
    retry_after_ms: u64,
}

#[derive(Deserialize, Serialize)]
struct RegisteredPusher {
    pushkey: String,
    url: String,
    registered_at_ms: u64,
}

fn registration_path(base: &Path, client: &Client) -> Option<PathBuf> {
    let key = serde_json::to_vec(&(client.homeserver().as_str(), client.session_meta()?)).ok()?;
    let hash = Sha256::digest(key);
    Some(base.join(format!("android-pusher-{hash:x}.json")))
}

impl Registration {
    fn read(path: &Path) -> Result<Self, String> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        atomic_write(
            path,
            &serde_json::to_vec(self).map_err(|error| error.to_string())?,
        )
    }
}

fn pusher_ids(pushkey: String) -> PusherIds {
    PusherIds::new(pushkey, APP_ID.to_owned())
}

async fn send_pusher(client: &Client, request: Request) -> Result<(), HttpError> {
    client
        .send(request)
        .with_request_config(
            RequestConfig::new()
                .timeout(Duration::from_secs(5))
                .disable_retry(),
        )
        .await
        .map(|_| ())
}

async fn remove_pusher(client: &Client, pushkey: String) -> Result<(), HttpError> {
    match send_pusher(client, Request::delete(pusher_ids(pushkey))).await {
        Err(error) if matches!(error.client_api_error_kind(), Some(ErrorKind::NotFound)) => Ok(()),
        result => result,
    }
}

fn retry_after(error: &HttpError) -> Option<Duration> {
    match error.client_api_error_kind() {
        Some(ErrorKind::LimitExceeded {
            retry_after: Some(RetryAfter::Delay(delay)),
        }) => Some(*delay),
        Some(ErrorKind::LimitExceeded {
            retry_after: Some(RetryAfter::DateTime(deadline)),
        }) => Some(
            deadline
                .duration_since(SystemTime::now())
                .unwrap_or_default(),
        ),
        _ => None,
    }
}

fn retry_request(
    path: &Path,
    registration: &mut Registration,
    error: &HttpError,
) -> Result<bool, String> {
    log::warn!("[push] Could not reconcile the Android pusher: {error}");
    if let Some(delay) = retry_after(error) {
        let millis = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
        registration.retry_after_ms = now_ms().saturating_add(millis);
        registration.save(path)?;
    }
    Ok(match error.as_client_api_error() {
        Some(error) => {
            let status = error.status_code;
            status.is_server_error() || matches!(status.as_u16(), 408 | 429)
        }
        None => true,
    })
}

// Returns true when Android should retry the job.
async fn reconcile(base: &Path, pushkey: String) -> Result<bool, String> {
    if pushkey.is_empty() || pushkey.len() > 512 {
        return Ok(false);
    }
    let Some(gateway) = push_gateway_url() else {
        return Ok(false);
    };
    let url = match notify_url(gateway) {
        Ok(url) => url,
        Err(error) => {
            log::error!("[push] {error}");
            return Ok(false);
        }
    };

    let _registration = REGISTRATION_LOCK.lock().await;
    let store = COLD_STORE.lock().await;
    let (client, _cold_store) = if let Some(state) = app_state() {
        let client = state.client.lock().await.clone();
        drop(store);
        (client, None)
    } else {
        (saved_client(base).await, Some(store))
    };
    let Some(client) = client else {
        return Ok(false);
    };
    let Some(path) = registration_path(base, &client) else {
        return Ok(false);
    };
    let mut registration = Registration::read(&path)?;
    if now_ms() < registration.retry_after_ms {
        return Ok(true);
    }

    if !registration.current.as_ref().is_some_and(|pusher| {
        pusher.pushkey == pushkey
            && pusher.url == url
            && now_ms().saturating_sub(pusher.registered_at_ms) < REFRESH_INTERVAL_MS
    }) {
        if !registration.pushkeys.contains(&pushkey) {
            registration.pushkeys.push(pushkey.clone());
            registration.save(&path)?;
        }
        let pusher = PusherInit {
            ids: pusher_ids(pushkey.clone()),
            app_display_name: APP_DISPLAY_NAME.into(),
            device_display_name: "Pax (Android)".into(),
            kind: PusherKind::Http(HttpPusherData::new(url.clone())),
            lang: "en".into(),
            profile_tag: None,
        };
        if let Err(error) = send_pusher(&client, Request::post(pusher.into())).await {
            return retry_request(&path, &mut registration, &error);
        }
        registration.current = Some(RegisteredPusher {
            pushkey: pushkey.clone(),
            url,
            registered_at_ms: now_ms(),
        });
        registration.retry_after_ms = 0;
        registration.save(&path)?;
        ensure_call_rule(&client).await;
    }

    while let Some(old) = registration
        .pushkeys
        .iter()
        .find(|key| **key != pushkey)
        .cloned()
    {
        if let Err(error) = remove_pusher(&client, old.clone()).await {
            return retry_request(&path, &mut registration, &error);
        }
        registration.pushkeys.retain(|key| key != &old);
        registration.save(&path)?;
    }
    Ok(false)
}

/// Called with REGISTRATION_LOCK held and before revoking the Matrix session.
pub(crate) async fn unregister(base: &Path, client: &Client, current_token: Option<String>) {
    let Some(path) = registration_path(base, client) else {
        return;
    };
    let mut pushkeys = match Registration::read(&path) {
        Ok(registration) => registration.pushkeys,
        Err(error) => {
            log::warn!("[push] Could not read the Android pusher registration: {error}");
            Vec::new()
        }
    };
    // Also remove the token from installations that predate native registration.
    if let Some(token) =
        current_token.filter(|token| !token.is_empty() && !pushkeys.contains(token))
    {
        pushkeys.push(token);
    }
    for pushkey in pushkeys {
        if let Err(error) = remove_pusher(client, pushkey).await {
            log::warn!("[push] Could not remove an Android pusher on sign-out: {error}");
        }
    }
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[push] Could not remove the local Android pusher registration: {error}");
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_carter_pax_PaxPushJob_reconcile(
    mut env: JNIEnv<'_>,
    _this: JObject<'_>,
    base: JString<'_>,
    token: JString<'_>,
) -> jboolean {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let base = PathBuf::from(String::from(env.get_string(&base).ok()?));
        let token = String::from(env.get_string(&token).ok()?);
        Some(runtime()?.block_on(async {
            match tokio::time::timeout(Duration::from_secs(20), reconcile(&base, token)).await {
                Ok(Ok(retry)) => retry,
                Ok(Err(error)) => {
                    log::warn!("[push] Android registration could not be completed: {error}");
                    true
                }
                Err(_) => true,
            }
        }))
    }));
    if matches!(result, Ok(Some(true))) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

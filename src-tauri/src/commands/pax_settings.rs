//! Pax-specific settings stored in Matrix account data.
//!
//! Two event types are owned by Pax:
//!
//!   * `ca.brandxtech.pax.unread_settings` — whether to show unread
//!     indicators globally, per-space, and per-room.  Purely a display
//!     concern; has no effect on whether notifications are delivered.
//!     Unread indicators are a Pax concept (Matrix has no native "count
//!     toward unread but don't notify" switch), so this lives wholly in
//!     account data rather than push rules.
//!
//!   * `ca.brandxtech.pax.notification_settings` — global default
//!     notification level, per-space notification level, and per-room
//!     notification level overrides.  **Account data is authoritative** for
//!     the level; push rules are a derived, lossy projection maintained by
//!     `commands::reconciler`.  See `commands::notification_levels` for the
//!     rationale (tl;dr: Synapse doesn't allow user override rules to
//!     beat builtin mention rules, so the finer-grained levels can't be
//!     expressed purely in push rules — we keep the intent here and the
//!     client-side notification handler will honour it).
//!
//! Both event types sync across the user's devices via Matrix account data
//! and both preserve unknown JSON fields on round-trip so future Pax
//! versions can add fields without older versions silently dropping them.
//!
//! ### Schema versioning
//!
//! `version: 1` today.  Bump only for breaking changes to existing fields'
//! shape.  Purely additive new fields go into the flattened `extra` map and
//! don't need a version bump.
//!
//! ### Concurrency
//!
//! Each `set_*` command performs a read-modify-write against the homeserver.
//! A module-local async mutex serialises those cycles so two rapid-fire
//! frontend writes can't race and lose one update.  The mutex is held
//! across the GET + PUT, not just the PUT.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

use super::reconciler::{NotificationSession, ReconcileScope};
use super::{fmt_error_chain, get_authed_client, AuthedClient};

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// ---------- Constants ----------

const UNREAD_SETTINGS_TYPE: &str = "ca.brandxtech.pax.unread_settings";
const NOTIFICATION_SETTINGS_TYPE: &str = "ca.brandxtech.pax.notification_settings";

const SCHEMA_VERSION: u32 = 1;

/// Serialises read-modify-write cycles for both settings types.  Module-local
/// rather than on `AppState` so `lib.rs` stays unchanged.
static PAX_SETTINGS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

fn default_true() -> bool {
    true
}

// ---------- Schemas ----------

/// Pax unread-indicator preferences.  Absence of an entry in `spaces` or
/// `rooms` means "inherit from the parent layer" — resolution order at
/// display time is room → space → global.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadSettings {
    #[serde(default = "default_schema_version")]
    pub version: u32,
    #[serde(default = "default_true")]
    pub global: bool,
    #[serde(default)]
    pub spaces: HashMap<String, bool>,
    #[serde(default)]
    pub rooms: HashMap<String, bool>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for UnreadSettings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            global: true,
            spaces: HashMap::new(),
            rooms: HashMap::new(),
            extra: HashMap::new(),
        }
    }
}

/// Notification levels a user can pick from.  Serialised in camelCase to
/// match frontend conventions: `all`, `userMentions`, `roomPings`,
/// `allMentions`, `none`.
///
/// At the push-rule layer only `All` vs "anything else" is distinguishable
/// (Synapse's limitations — see `notification_levels` module docs).  The
/// finer-grained variants are stored here so the client-side notification
/// handler can honour them when it renders local notifications.
/// How the desktop tray icon shows unread / notification state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TrayUnreadIndicatorMode {
    /// Red dot for any unread (previous Pax default).
    AllRed,
    /// Red when something would notify; blue for other unread; nothing if clear.
    #[default]
    Split,
    /// Red only when there is notification-worthy unread; no dot for muted-only unread.
    NotifyOnly,
    /// Never show a tray badge.
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationLevel {
    /// Every message notifies.
    All,
    /// Only messages that mention this user's MXID.
    UserMentions,
    /// Only `@room` pings.
    RoomPings,
    /// Any mention — user mentions and `@room`.  Element's default for
    /// group rooms; also what the push-rule layer installs for any
    /// non-`All` level.
    AllMentions,
    /// Nothing notifies.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    #[serde(default = "default_schema_version")]
    pub version: u32,
    #[serde(default)]
    pub tray_unread_indicator: TrayUnreadIndicatorMode,
    /// Default level for rooms with no explicit setting and no
    /// space-scoped setting.  `None` → fall through to Element-style
    /// per-room-type defaults (`All` for DMs, `AllMentions` for group
    /// rooms).
    #[serde(default)]
    pub global_default: Option<NotificationLevel>,
    /// Per-space intent.  Applies to direct child rooms that don't have
    /// their own entry in `rooms`.
    #[serde(default)]
    pub spaces: HashMap<String, NotificationLevel>,
    /// Per-room explicit override.  A room in this map takes precedence
    /// over any space-level or global setting.  Keys are room IDs.
    #[serde(default)]
    pub rooms: HashMap<String, NotificationLevel>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            tray_unread_indicator: TrayUnreadIndicatorMode::default(),
            global_default: None,
            spaces: HashMap::new(),
            rooms: HashMap::new(),
            extra: HashMap::new(),
        }
    }
}

// ---------- HTTP helpers ----------

async fn fetch_account_data_raw(
    state: &AppState,
    event_type: &str,
) -> Result<Option<Value>, String> {
    let auth = get_authed_client(state).await?;
    fetch_account_data_for_client(&state.http_client, &auth, event_type).await
}

async fn fetch_account_data_for_client(
    http: &reqwest::Client,
    auth: &AuthedClient,
    event_type: &str,
) -> Result<Option<Value>, String> {
    let user_id = auth.client.user_id().ok_or("No user ID")?.to_string();
    let access_token = &auth.access_token;
    let hs = &auth.homeserver;

    let url = format!(
        "{hs}/_matrix/client/v3/user/{}/account_data/{}",
        urlencoding::encode(&user_id),
        urlencoding::encode(event_type),
    );

    let resp = http
        .get(&url)
        .bearer_auth(&access_token)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch account data: {}", fmt_error_chain(&e)))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "GET account_data/{event_type} failed: HTTP {status} — {body}"
        ));
    }

    resp.json::<Value>()
        .await
        .map(Some)
        .map_err(|e| format!("Malformed account_data response: {}", fmt_error_chain(&e)))
}

async fn put_account_data_raw(
    state: &AppState,
    event_type: &str,
    body: &Value,
) -> Result<(), String> {
    let auth = get_authed_client(state).await?;
    put_account_data_for_client(&state.http_client, &auth, event_type, body).await
}

async fn put_account_data_for_client(
    http: &reqwest::Client,
    auth: &AuthedClient,
    event_type: &str,
    body: &Value,
) -> Result<(), String> {
    let user_id = auth.client.user_id().ok_or("No user ID")?.to_string();
    let access_token = &auth.access_token;
    let hs = &auth.homeserver;

    let url = format!(
        "{hs}/_matrix/client/v3/user/{}/account_data/{}",
        urlencoding::encode(&user_id),
        urlencoding::encode(event_type),
    );

    let resp = http
        .put(&url)
        .bearer_auth(&access_token)
        .json(body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Failed to PUT account data: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "PUT account_data/{event_type} failed: HTTP {status} — {body}"
        ));
    }

    Ok(())
}

// ---------- Load / save helpers ----------

async fn load_unread_settings(state: &AppState) -> Result<UnreadSettings, String> {
    match fetch_account_data_raw(state, UNREAD_SETTINGS_TYPE).await? {
        None => Ok(UnreadSettings::default()),
        Some(v) => serde_json::from_value::<UnreadSettings>(v)
            .map_err(|e| format!("Bad unread_settings JSON: {e}")),
    }
}

async fn save_unread_settings(
    state: &AppState,
    app: &AppHandle,
    settings: &UnreadSettings,
) -> Result<(), String> {
    let body =
        serde_json::to_value(settings).map_err(|e| format!("Serialise unread_settings: {e}"))?;
    put_account_data_raw(state, UNREAD_SETTINGS_TYPE, &body).await?;
    let _ = app.emit("pax-unread-settings-changed", settings.clone());
    Ok(())
}

/// Read through the session cache; concurrent readers share the first GET.
pub(super) async fn load_notification_settings_inner(
    state: &AppState,
) -> Result<NotificationSettings, String> {
    let session = state.notifications.session();
    load_settings_for_session(state, &session).await
}

pub(super) async fn load_settings_for_session(
    state: &AppState,
    session: &NotificationSession,
) -> Result<NotificationSettings, String> {
    session
        .run(async {
            let _guard = session.settings_load.lock().await;
            loop {
                let (revision, cached) = session.settings();
                if let Some(settings) = cached {
                    return Ok(settings);
                }
                if let Some(error) = session.settings_error() {
                    return Err(error);
                }
                let auth = get_authed_client(state).await?;
                match fetch_notification_settings(&state.http_client, &auth).await {
                    Ok(settings) => {
                        if session.cache_settings(revision, settings.clone()) {
                            return Ok(settings);
                        }
                    }
                    Err(error) => {
                        if session.fail_settings(revision, error.clone()) {
                            return Err(error);
                        }
                    }
                }
            }
        })
        .await
}

async fn fetch_notification_settings(
    http: &reqwest::Client,
    auth: &AuthedClient,
) -> Result<NotificationSettings, String> {
    match fetch_account_data_for_client(http, auth, NOTIFICATION_SETTINGS_TYPE).await? {
        None => Ok(NotificationSettings::default()),
        Some(value) => serde_json::from_value(value)
            .map_err(|e| format!("Bad notification_settings JSON: {e}")),
    }
}

/// Explicit edits still use a fresh serialized read-modify-write. Cached
/// resolution must not overwrite fields another device has recently saved.
async fn update_notification_settings(
    state: &Arc<AppState>,
    app: &AppHandle,
    update: impl FnOnce(&mut NotificationSettings),
) -> Result<NotificationSettings, String> {
    let session = state.notifications.session();
    session
        .run(async {
            let _guard = PAX_SETTINGS_LOCK.lock().await;
            let auth = get_authed_client(state).await?;
            let mut settings = fetch_notification_settings(&state.http_client, &auth).await?;
            let original = settings.clone();
            update(&mut settings);
            if settings != original {
                let body = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
                put_account_data_for_client(
                    &state.http_client,
                    &auth,
                    NOTIFICATION_SETTINGS_TYPE,
                    &body,
                )
                .await?;
            }
            let scope = session.set_settings(settings.clone());
            let _ = app.emit("pax-notification-settings-changed", &settings);
            if !scope.is_empty() {
                session.schedule(state, app, scope);
            }
            Ok(settings)
        })
        .await
}

pub(super) async fn set_room_level_inner(
    state: &Arc<AppState>,
    app: &AppHandle,
    room_id: &str,
    level: Option<NotificationLevel>,
) -> Result<(), String> {
    update_notification_settings(state, app, |settings| match level {
        Some(level) => {
            settings.rooms.insert(room_id.to_owned(), level);
        }
        None => {
            settings.rooms.remove(room_id);
        }
    })
    .await
    .map(|_| ())
}

/// Called after sync_once has applied account data. No server requests are
/// awaited here. Re-fetch differing settings rather than trusting an old echo
/// that could arrive after a more recent local save.
pub(super) fn process_synced_settings(state: &Arc<AppState>, app: &AppHandle, event: &Value) {
    match event.get("type").and_then(Value::as_str) {
        Some(NOTIFICATION_SETTINGS_TYPE) => {
            let Some(content) = event.get("content") else {
                return;
            };
            match serde_json::from_value::<NotificationSettings>(content.clone()) {
                Ok(settings) => {
                    let session = state.notifications.session();
                    if session.invalidate_settings_if_different(&settings) {
                        let _ = app.emit("pax-notification-settings-invalidated", ());
                        session.schedule(state, app, ReconcileScope::all());
                    }
                }
                Err(error) => log::warn!("Invalid synced notification settings: {error}"),
            }
        }
        Some(UNREAD_SETTINGS_TYPE) => {
            if let Some(content) = event.get("content") {
                if let Ok(settings) = serde_json::from_value::<UnreadSettings>(content.clone()) {
                    let _ = app.emit("pax-unread-settings-changed", settings);
                }
            }
        }
        Some("m.push_rules") => state
            .notifications
            .session()
            .schedule_projection(state, app),
        _ => {}
    }
}

// ---------- Commands: unread settings ----------

#[tauri::command]
pub async fn get_unread_settings(
    state: State<'_, Arc<AppState>>,
) -> Result<UnreadSettings, String> {
    load_unread_settings(&state).await
}

#[tauri::command]
pub async fn set_global_unread_indicator(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    show: bool,
) -> Result<UnreadSettings, String> {
    let _guard = PAX_SETTINGS_LOCK.lock().await;
    let mut settings = load_unread_settings(&state).await?;
    settings.global = show;
    save_unread_settings(&state, &app, &settings).await?;
    Ok(settings)
}

#[tauri::command]
pub async fn set_space_unread_indicator(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    space_id: String,
    show: Option<bool>,
) -> Result<UnreadSettings, String> {
    let _guard = PAX_SETTINGS_LOCK.lock().await;
    let mut settings = load_unread_settings(&state).await?;
    match show {
        Some(v) => {
            settings.spaces.insert(space_id, v);
        }
        None => {
            settings.spaces.remove(&space_id);
        }
    }
    save_unread_settings(&state, &app, &settings).await?;
    Ok(settings)
}

#[tauri::command]
pub async fn set_room_unread_indicator(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    show: Option<bool>,
) -> Result<UnreadSettings, String> {
    let _guard = PAX_SETTINGS_LOCK.lock().await;
    let mut settings = load_unread_settings(&state).await?;
    match show {
        Some(v) => {
            settings.rooms.insert(room_id, v);
        }
        None => {
            settings.rooms.remove(&room_id);
        }
    }
    save_unread_settings(&state, &app, &settings).await?;
    Ok(settings)
}

// ---------- Commands: notification settings ----------

#[tauri::command]
pub async fn get_notification_settings(
    state: State<'_, Arc<AppState>>,
) -> Result<NotificationSettings, String> {
    load_notification_settings_inner(&state).await
}

#[tauri::command]
pub async fn set_tray_unread_indicator_mode(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    mode: TrayUnreadIndicatorMode,
) -> Result<NotificationSettings, String> {
    update_notification_settings(&state, &app, |settings| {
        settings.tray_unread_indicator = mode
    })
    .await
}

/// Set the global default notification level.  Triggers a full reconcile
/// so every room without an explicit or space-scoped setting picks up the
/// new default.
#[tauri::command]
pub async fn set_global_default_notification_level(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    level: Option<NotificationLevel>,
) -> Result<NotificationSettings, String> {
    let updated =
        update_notification_settings(&state, &app, |settings| settings.global_default = level)
            .await?;
    Ok(updated)
}

/// Set the per-space notification level.  `None` removes the entry so
/// child rooms revert to the global default on the scoped reconcile that
/// follows.
#[tauri::command]
pub async fn set_space_notification_level(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    space_id: String,
    level: Option<NotificationLevel>,
) -> Result<NotificationSettings, String> {
    let updated = update_notification_settings(&state, &app, |settings| match level {
        Some(level) => {
            settings.spaces.insert(space_id.clone(), level);
        }
        None => {
            settings.spaces.remove(&space_id);
        }
    })
    .await?;
    Ok(updated)
}

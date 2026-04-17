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
//!     notification level (None = follow Element-style per-room-type
//!     defaults), per-space notification level, and a `roomOverrides`
//!     marker set recording which rooms have user-set per-room push rules
//!     (so the reconciler in Pass 2 won't clobber user intent when a
//!     space-level setting changes).  The authoritative per-room level
//!     itself lives in push rules, not here.
//!
//! Both event types sync across the user's devices via Matrix account data
//! and both preserve unknown JSON fields on round-trip so future Pax
//! versions can add fields (sounds, keywords, etc.) without older versions
//! silently dropping them.
//!
//! ### Schema versioning
//!
//! `version: 1` today.  Bump only for breaking changes to existing fields'
//! shape.  Purely additive new fields go into the flattened `extra` map and
//! don't need a version bump — older Pax reads through them untouched.
//!
//! ### Concurrency
//!
//! Each `set_*` command performs a read-modify-write against the homeserver.
//! A module-local async mutex serialises those cycles so two rapid-fire
//! frontend writes can't race and lose one update.  The mutex is held
//! across the GET + PUT, not just the PUT.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

use super::{fmt_error_chain, get_client};

// ---------- Constants ----------

const UNREAD_SETTINGS_TYPE: &str = "ca.brandxtech.pax.unread_settings";
const NOTIFICATION_SETTINGS_TYPE: &str = "ca.brandxtech.pax.notification_settings";

const SCHEMA_VERSION: u32 = 1;

/// Serialises the read-modify-write cycle for both settings types.  Held
/// across GET + PUT to avoid a lost update when two commands fire back to
/// back.  Module-local rather than on `AppState` so `lib.rs` stays
/// unchanged — `tokio::sync::Mutex::const_new` makes this safe in a static.
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
    /// Top of the inheritance chain.  Default: true.
    #[serde(default = "default_true")]
    pub global: bool,
    /// Space-scoped override.  Keys are space room IDs.
    #[serde(default)]
    pub spaces: HashMap<String, bool>,
    /// Room-scoped override.  Keys are room IDs; overrides any space-level
    /// decision for that specific room.
    #[serde(default)]
    pub rooms: HashMap<String, bool>,
    /// Unknown fields from future versions, preserved on round-trip.
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

/// Notification levels a user can pick from.  Mirrors Discord's language
/// but maps to Matrix push rules — see `commands::notification_levels` in
/// Pass 2.  Keywords are intentionally not a separate level: when we add
/// them, they'll land as their own `content`-kind push rules on top of the
/// level machinery, without requiring a new variant here.
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
    /// group rooms.
    AllMentions,
    /// Nothing notifies.
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    #[serde(default = "default_schema_version")]
    pub version: u32,
    /// Global default level.  `None` → follow Element-style per-room-type
    /// defaults (DMs `All`, group rooms `AllMentions`).  Set this to force
    /// every new room to start at a specific level.
    #[serde(default)]
    pub global_default: Option<NotificationLevel>,
    /// Per-space intent.  The Pass 2 reconciler applies the chosen level to
    /// every room in each space that doesn't have its own override.
    #[serde(default)]
    pub spaces: HashMap<String, NotificationLevel>,
    /// Room IDs where the user has explicitly set a per-room notification
    /// level.  The authoritative level lives in push rules; this set just
    /// tells the reconciler "don't overwrite these when the parent space's
    /// level changes."
    #[serde(default)]
    pub room_overrides: HashSet<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            global_default: None,
            spaces: HashMap::new(),
            room_overrides: HashSet::new(),
            extra: HashMap::new(),
        }
    }
}

// ---------- HTTP helpers ----------

/// GET `/_matrix/client/v3/user/{userId}/account_data/{type}`.
///
/// Returns `Ok(None)` on 404 so the caller can substitute a default without
/// the "does it exist yet" check leaking into every settings command.
async fn fetch_account_data_raw(
    state: &AppState,
    event_type: &str,
) -> Result<Option<Value>, String> {
    let client = get_client(state).await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "No user ID".to_string())?
        .to_string();
    let access_token = client
        .access_token()
        .ok_or_else(|| "No access token".to_string())?;
    let hs = client.homeserver().to_string();
    let hs = hs.trim_end_matches('/');

    let url = format!(
        "{hs}/_matrix/client/v3/user/{}/account_data/{}",
        urlencoding::encode(&user_id),
        urlencoding::encode(event_type),
    );

    let resp = state
        .http_client
        .get(&url)
        .bearer_auth(&access_token)
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

/// PUT `/_matrix/client/v3/user/{userId}/account_data/{type}`.  Body is the
/// full event content — Matrix has no merge/patch semantics here.  Any
/// fields the caller omits are lost, which is why every writer in this
/// module does read-modify-write under the module lock.
async fn put_account_data_raw(
    state: &AppState,
    event_type: &str,
    body: &Value,
) -> Result<(), String> {
    let client = get_client(state).await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "No user ID".to_string())?
        .to_string();
    let access_token = client
        .access_token()
        .ok_or_else(|| "No access token".to_string())?;
    let hs = client.homeserver().to_string();
    let hs = hs.trim_end_matches('/');

    let url = format!(
        "{hs}/_matrix/client/v3/user/{}/account_data/{}",
        urlencoding::encode(&user_id),
        urlencoding::encode(event_type),
    );

    let resp = state
        .http_client
        .put(&url)
        .bearer_auth(&access_token)
        .json(body)
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
    let body = serde_json::to_value(settings)
        .map_err(|e| format!("Serialise unread_settings: {e}"))?;
    put_account_data_raw(state, UNREAD_SETTINGS_TYPE, &body).await?;
    let _ = app.emit("pax-unread-settings-changed", settings.clone());
    Ok(())
}

async fn load_notification_settings(state: &AppState) -> Result<NotificationSettings, String> {
    match fetch_account_data_raw(state, NOTIFICATION_SETTINGS_TYPE).await? {
        None => Ok(NotificationSettings::default()),
        Some(v) => serde_json::from_value::<NotificationSettings>(v)
            .map_err(|e| format!("Bad notification_settings JSON: {e}")),
    }
}

async fn save_notification_settings(
    state: &AppState,
    app: &AppHandle,
    settings: &NotificationSettings,
) -> Result<(), String> {
    let body = serde_json::to_value(settings)
        .map_err(|e| format!("Serialise notification_settings: {e}"))?;
    put_account_data_raw(state, NOTIFICATION_SETTINGS_TYPE, &body).await?;
    let _ = app.emit("pax-notification-settings-changed", settings.clone());
    Ok(())
}

// ---------- Commands: unread settings ----------

/// Read the current unread-indicator settings.  Returns defaults (global:
/// true, empty maps) if no event exists on the server yet.
#[tauri::command]
pub async fn get_unread_settings(
    state: State<'_, Arc<AppState>>,
) -> Result<UnreadSettings, String> {
    load_unread_settings(&state).await
}

/// Set the global "show unread indicators" switch.  Returns the full
/// updated settings blob so the caller can avoid a follow-up read.
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

/// Set the per-space unread-indicator override.  `show: None` removes the
/// entry, reverting that space to inherit the global setting.
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

/// Set the per-room unread-indicator override.  `show: None` removes the
/// entry so that room inherits its space (or the global setting).
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

/// Read the current notification settings.  Returns defaults (no global
/// override, empty maps, empty overrides set) if the event doesn't exist.
#[tauri::command]
pub async fn get_notification_settings(
    state: State<'_, Arc<AppState>>,
) -> Result<NotificationSettings, String> {
    load_notification_settings(&state).await
}

/// Set the global default notification level.  `None` restores the
/// Element-style per-room-type defaults (DMs All, group rooms
/// AllMentions) — the Pass 2 reconciler will read this when deciding
/// defaults for brand-new rooms.
#[tauri::command]
pub async fn set_global_default_notification_level(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    level: Option<NotificationLevel>,
) -> Result<NotificationSettings, String> {
    let _guard = PAX_SETTINGS_LOCK.lock().await;
    let mut settings = load_notification_settings(&state).await?;
    settings.global_default = level;
    save_notification_settings(&state, &app, &settings).await?;
    Ok(settings)
}

/// Set the per-space notification level.  `None` removes the entry; that
/// space's rooms revert to the global default (or Element defaults).
///
/// This command only stores intent — Pass 2's reconciler is what actually
/// translates space-level intent into per-room push rules.
#[tauri::command]
pub async fn set_space_notification_level(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    space_id: String,
    level: Option<NotificationLevel>,
) -> Result<NotificationSettings, String> {
    let _guard = PAX_SETTINGS_LOCK.lock().await;
    let mut settings = load_notification_settings(&state).await?;
    match level {
        Some(l) => {
            settings.spaces.insert(space_id, l);
        }
        None => {
            settings.spaces.remove(&space_id);
        }
    }
    save_notification_settings(&state, &app, &settings).await?;
    Ok(settings)
}
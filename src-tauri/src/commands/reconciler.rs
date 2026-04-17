//! Notification-settings reconciler.
//!
//! The reconciler keeps per-room push rules in sync with the user's
//! notification intent stored in `ca.brandxtech.pax.notification_settings`
//! account data.  Account data is authoritative; push rules are a derived
//! (and lossy — see `notification_levels` module docs) projection.
//!
//! ### Resolution order (per room)
//!
//!   1. Explicit per-room entry in `settings.rooms`.
//!
//!   2. Parent-space entry in `settings.spaces`, where "parent" means
//!      direct `m.space.child` relationship.  First matching space wins.
//!
//!   3. `settings.global_default` if set.
//!
//!   4. Element-style default: `All` for DMs, `AllMentions` otherwise.
//!
//! ### Scope
//!
//! Direct-child space relationships only — rooms in a sub-space don't
//! inherit the parent space's level through the sub-space.  Recursive
//! inheritance is a possible future extension.
//!
//! ### Triggers
//!
//! Reconciliation runs when:
//!
//!   * The frontend explicitly calls `reconcile_all_notification_levels`
//!     (typically once on `sync-ready` at startup).
//!
//!   * A user writes a setting via one of the `set_*` commands in
//!     `commands::pax_settings` or `commands::notification_levels`.
//!
//! Room-join / space-child-update / `m.direct`-change triggers from the
//! sync loop are out of scope for Pass 2.  The frontend can always call
//! `reconcile_all_notification_levels` after joining rooms.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::Client;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::AppState;

use super::get_client;
use super::notification_levels::{apply_level_to_room_inner, has_suppression_installed};
use super::pax_settings::{
    load_notification_settings_inner, NotificationLevel, NotificationSettings,
};
use super::push_rules::load_push_rules_raw;

const SPACE_CHILDREN_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

// ---------- Building blocks ----------

/// Fetch each joined space's direct child room IDs.  Returns `SpaceId →
/// {RoomId}`.  Exposed to `notification_levels::get_all_room_notification_levels`
/// so bulk queries can reuse the same scan.
///
/// Matches the matrix-sdk idiom used in
/// `commands::rooms::fetch_space_children_for_room` — raw
/// `get_state_events(StateEventType::SpaceChild)` with `AnySyncOrStrippedState`
/// deserialisation.  Tolerates per-space fetch failures so one misbehaving
/// space doesn't break the whole pass.
pub(super) async fn fetch_space_children_map(
    client: &Client,
) -> HashMap<String, HashSet<String>> {
    let mut out = HashMap::new();
    let spaces = client.joined_rooms().into_iter().filter(|r| r.is_space());
    for space in spaces {
        let space_id = space.room_id().to_string();
        let mut children = HashSet::new();
        match tokio::time::timeout(
            SPACE_CHILDREN_FETCH_TIMEOUT,
            space.get_state_events(StateEventType::SpaceChild),
        )
        .await
        {
            Ok(Ok(events)) => {
                for event in events {
                    if let Ok(raw) = event.deserialize() {
                        match raw {
                            matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Sync(e) => {
                                children.insert(e.state_key().to_string());
                            }
                            matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Stripped(e) => {
                                children.insert(e.state_key().to_string());
                            }
                        }
                    }
                }
            }
            Ok(Err(e)) => {
                log::warn!(
                    "[pax reconcile] space-child fetch for {space_id} failed: {e}"
                );
            }
            Err(_) => {
                log::warn!("[pax reconcile] space-child fetch for {space_id} timed out");
            }
        }
        out.insert(space_id, children);
    }
    out
}

/// Element-style default: `All` for DMs, `AllMentions` otherwise.
/// `is_direct()` is async because it reads the `m.direct` account-data map
/// from the SDK's store.
async fn element_default_for_room(room: &matrix_sdk::Room) -> NotificationLevel {
    match room.is_direct().await {
        Ok(true) => NotificationLevel::All,
        _ => NotificationLevel::AllMentions,
    }
}

/// Resolve the effective level for a room given already-loaded `settings`
/// and `space_children`.  Pure — no IO.  Exposed to
/// `notification_levels::get_all_room_notification_levels` so bulk queries
/// can reuse the same pass.
pub(super) async fn resolve_level_with_context(
    room: &matrix_sdk::Room,
    settings: &NotificationSettings,
    space_children: &HashMap<String, HashSet<String>>,
) -> NotificationLevel {
    let room_id = room.room_id().to_string();

    // 1. Explicit per-room override.
    if let Some(level) = settings.rooms.get(&room_id) {
        return *level;
    }

    // 2. Parent-space override.  Iterate `settings.spaces` (not
    //    `space_children`) so we only consult the spaces the user has
    //    actually levelled.
    for (space_id, level) in &settings.spaces {
        if let Some(children) = space_children.get(space_id) {
            if children.contains(&room_id) {
                return *level;
            }
        }
    }

    // 3. Global default.
    if let Some(level) = settings.global_default {
        return level;
    }

    // 4. Element-style default.
    element_default_for_room(room).await
}

/// One-shot effective-level resolver for a single room.  Fetches the
/// settings and space-children map itself — intended for the
/// `get_room_notification_level` command, which is called ad-hoc and
/// can afford the extra fetch.
pub(super) async fn resolve_effective_level(
    state: &AppState,
    room_id: &str,
) -> Result<NotificationLevel, String> {
    let client = get_client(state).await?;
    let parsed = matrix_sdk::ruma::RoomId::parse(room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client
        .get_room(&parsed)
        .ok_or_else(|| "Room not found".to_string())?;

    let settings = load_notification_settings_inner(state).await?;
    let space_children = fetch_space_children_map(&client).await;
    Ok(resolve_level_with_context(&room, &settings, &space_children).await)
}

// ---------- Core reconcile ----------

/// Apply the correct push-rule state for one room.  Skips the HTTP write
/// if the existing state already matches desired — the drift check is
/// boolean (room-kind rule present or not), sufficient at the push-rule
/// layer since finer-grained levels aren't distinguishable there.
async fn reconcile_one(
    state: &AppState,
    room: &matrix_sdk::Room,
    settings: &NotificationSettings,
    space_children: &HashMap<String, HashSet<String>>,
    cached_rules: &Value,
) -> Result<bool, String> {
    let desired = resolve_level_with_context(room, settings, space_children).await;
    let room_id = room.room_id().to_string();

    let currently_suppressed = has_suppression_installed(cached_rules, &room_id);
    let wants_suppression = !matches!(desired, NotificationLevel::All);

    if currently_suppressed == wants_suppression {
        // Push-rule state already matches the desired level's projection.
        // Finer-grained account-data state is handled elsewhere.
        return Ok(false);
    }

    apply_level_to_room_inner(state, &room_id, desired).await?;
    log::info!(
        "[pax reconcile] {room_id}: push-rule {} (effective level {desired:?})",
        if wants_suppression {
            "installed"
        } else {
            "removed"
        }
    );
    Ok(true)
}

/// Reconcile one room.  Fetches its own copy of settings + space children
/// + push rules — intended for one-off triggers like "the user just
/// changed this room's level".
pub async fn reconcile_room(
    state: &AppState,
    _app: &AppHandle,
    room_id: &str,
) -> Result<(), String> {
    let client = get_client(state).await?;
    let parsed = matrix_sdk::ruma::RoomId::parse(room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client
        .get_room(&parsed)
        .ok_or_else(|| "Room not found".to_string())?;

    let settings = load_notification_settings_inner(state).await?;
    let space_children = fetch_space_children_map(&client).await;
    let rules = load_push_rules_raw(state).await?;

    reconcile_one(state, &room, &settings, &space_children, &rules).await?;
    Ok(())
}

/// Reconcile every joined room.  Called from the frontend on sync-ready
/// and internally from `set_global_default_notification_level`.
pub async fn reconcile_all(
    state: &AppState,
    _app: &AppHandle,
) -> Result<ReconcileReport, String> {
    let client = get_client(state).await?;
    let settings = load_notification_settings_inner(state).await?;
    let space_children = fetch_space_children_map(&client).await;
    let rules = load_push_rules_raw(state).await?;

    let mut report = ReconcileReport::default();
    for room in client.joined_rooms() {
        if room.is_space() {
            continue;
        }
        report.examined += 1;
        match reconcile_one(state, &room, &settings, &space_children, &rules).await {
            Ok(true) => report.applied += 1,
            Ok(false) => {}
            Err(e) => {
                report.errors += 1;
                log::warn!(
                    "[pax reconcile] room {} failed: {}",
                    room.room_id(),
                    e
                );
            }
        }
    }
    log::info!(
        "[pax reconcile] pass complete: examined={} applied={} errors={}",
        report.examined,
        report.applied,
        report.errors
    );
    Ok(report)
}

/// Scoped reconcile: just the rooms under a given space.  Called from
/// `set_space_notification_level` so a single-space change doesn't pay
/// for a full-account pass.
pub async fn reconcile_rooms_for_space(
    state: &AppState,
    _app: &AppHandle,
    space_id: &str,
) -> Result<ReconcileReport, String> {
    let client = get_client(state).await?;
    let settings = load_notification_settings_inner(state).await?;
    let space_children = fetch_space_children_map(&client).await;
    let rules = load_push_rules_raw(state).await?;

    let targets: HashSet<String> =
        space_children.get(space_id).cloned().unwrap_or_default();

    let mut report = ReconcileReport::default();
    for room in client.joined_rooms() {
        let id = room.room_id().to_string();
        if !targets.contains(&id) {
            continue;
        }
        if room.is_space() {
            continue;
        }
        report.examined += 1;
        match reconcile_one(state, &room, &settings, &space_children, &rules).await {
            Ok(true) => report.applied += 1,
            Ok(false) => {}
            Err(e) => {
                report.errors += 1;
                log::warn!("[pax reconcile] {id} (space {space_id}) failed: {e}");
            }
        }
    }
    Ok(report)
}

// ---------- Public report type + frontend commands ----------

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub examined: u32,
    pub applied: u32,
    pub errors: u32,
}

/// Frontend-triggered full reconcile.  Intended to be called once on
/// `sync-ready` so startup picks up any drift from other clients.
#[tauri::command]
pub async fn reconcile_all_notification_levels(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<ReconcileReport, String> {
    reconcile_all(&state, &app).await
}
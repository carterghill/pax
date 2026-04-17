//! Notification-level application and classification.
//!
//! Five levels — `All`, `AllMentions`, `UserMentions`, `RoomPings`, `None` —
//! represent the user's intent for a room.  The authoritative store for
//! per-room level is `ca.brandxtech.pax.notification_settings` account
//! data (`settings.rooms`); push rules are a derived, lossy projection.
//!
//! ### Why account-data-authoritative
//!
//! Synapse's push-rule API does not allow user-authored override rules to
//! be placed ahead of built-in override rules.  `before` / `after` only
//! looks up rules in the user's `push_rules` table, and Synapse refuses to
//! let users PUT new rule IDs starting with `.` (so we can't force a
//! builtin into that table by re-writing it back to itself either).  The
//! practical consequence: user-added override rules always evaluate after
//! `.m.rule.contains_user_name` and `.m.rule.roomnotif`, which means
//! *per-room mention suppression via push rules is not achievable* on
//! Synapse.  Element hits the same wall — its "Off" preset doesn't
//! actually silence mentions server-side either; the client does the
//! suppression in its local notification handler.
//!
//! So at the push-rule layer we only have two achievable states per room:
//!
//!   * no rule            — default behaviour; everything notifies.
//!   * room-kind `dont_notify` — regular messages don't notify;
//!                           mention overrides (`contains_user_name`,
//!                           `roomnotif`) and `invite_for_me` still fire.
//!
//! This maps directly onto `All` vs "anything else".  The finer-grained
//! levels (`UserMentions`, `RoomPings`, `None` as distinct from plain
//! `AllMentions`) are stored in account data and applied by the
//! client-side notification handler (to be built).  Mobile-push
//! behaviour for any non-`All` level defaults to "mentions only",
//! matching Element's behaviour.
//!
//! ### What this module owns
//!
//! * `apply_level_to_room_inner` — install or remove the room-kind
//!   `dont_notify` rule to match the given level.
//!
//! * `has_suppression_installed` — drift-detection helper for the
//!   reconciler: does this room currently have the room-kind rule or not?
//!
//! * Tauri commands that write per-room level into account data and
//!   trigger a reconcile, or read back the effective level resolved
//!   through the override chain (which lives in `reconciler`).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

use super::get_client;
use super::pax_settings::{
    load_notification_settings_inner, set_room_level_inner, NotificationLevel,
};
use super::push_rules::{delete_push_rule_raw, put_push_rule_raw};

// ---------- Push-rule synthesis (the lossy projection) ----------

/// True iff `level` should install the room-kind suppression rule.
/// Distilled down: `All` = no rule, everything else = rule.
fn level_wants_suppression(level: NotificationLevel) -> bool {
    !matches!(level, NotificationLevel::All)
}

/// Does room `room_id` currently have a room-kind `dont_notify` rule in the
/// push ruleset?  Used by the reconciler to skip no-op applies — if the
/// desired state already matches, we don't need to make any HTTP calls.
///
/// This is the complete drift signal at the push-rule layer.  The
/// finer-grained level (`UserMentions` vs `None`, etc.) isn't visible in
/// push rules and isn't drift-checked here.
pub(super) fn has_suppression_installed(rules: &Value, room_id: &str) -> bool {
    let Some(room_rules) = rules
        .get("global")
        .and_then(|g| g.get("room"))
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    room_rules.iter().any(|r| {
        let id_matches =
            r.get("rule_id").and_then(|id| id.as_str()) == Some(room_id);
        let has_dont_notify = r
            .get("actions")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().any(|v| v.as_str() == Some("dont_notify")))
            .unwrap_or(false);
        id_matches && has_dont_notify
    })
}

/// Install / uninstall the room-kind push rule so it matches the level.
/// Idempotent: re-PUTing the same rule body is a no-op; deleting a
/// non-existent rule is treated as success by `delete_push_rule_raw`.
///
/// Called from the reconciler (never directly from a Tauri command), so
/// input validation and drift-checking happen at a higher layer — this
/// function just makes the server state match.
pub(super) async fn apply_level_to_room_inner(
    state: &AppState,
    room_id: &str,
    level: NotificationLevel,
) -> Result<(), String> {
    if level_wants_suppression(level) {
        let body = json!({ "actions": ["dont_notify"] });
        // Room-kind rules are keyed by room_id (the rule_id IS the room id
        // per spec); no before/after is meaningful here.
        put_push_rule_raw(state, "room", room_id, &body, None, None).await?;
    } else {
        // `All` — tear down any suppression rule if present.  404 is
        // swallowed by delete_push_rule_raw so this is safe to call
        // unconditionally.
        delete_push_rule_raw(state, "room", room_id).await?;
    }
    Ok(())
}

// ---------- Commands ----------

/// Set the user's explicit notification level for a room.  Writes to
/// account data (which is authoritative) and triggers a reconcile so the
/// push-rule projection reflects the new intent.
///
/// Per-room intent beats inherited space / global defaults — once this
/// command runs, the room's level won't change just because a space's
/// level changes.  Use `clear_room_notification_level` to re-inherit.
#[tauri::command]
pub async fn set_room_notification_level(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    level: NotificationLevel,
) -> Result<(), String> {
    // Write intent first; the reconcile picks it up and does the HTTP.
    set_room_level_inner(&state, &app, &room_id, Some(level)).await?;
    if let Err(e) = super::reconciler::reconcile_room(&state, &app, &room_id).await {
        log::warn!(
            "[pax] set_room_notification_level: reconcile_room failed ({room_id}): {e}"
        );
    }
    let _ = app.emit(
        "pax-room-notification-level-changed",
        serde_json::json!({ "roomId": room_id, "level": level }),
    );
    Ok(())
}

/// Clear the user's explicit level for a room — it goes back to
/// inheriting from its space (if any) or the global default / Element
/// default.  Triggers a reconcile so the push rule reflects the new
/// inherited level.
#[tauri::command]
pub async fn clear_room_notification_level(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
) -> Result<(), String> {
    set_room_level_inner(&state, &app, &room_id, None).await?;
    if let Err(e) = super::reconciler::reconcile_room(&state, &app, &room_id).await {
        log::warn!(
            "[pax] clear_room_notification_level: reconcile_room failed ({room_id}): {e}"
        );
    }
    let _ = app.emit(
        "pax-room-notification-level-changed",
        serde_json::json!({ "roomId": room_id, "level": null }),
    );
    Ok(())
}

/// Read the effective level for a room — what it's actually set to given
/// explicit setting, parent space, global default, and Element defaults.
///
/// Callers that need to distinguish "explicitly set to AllMentions" from
/// "inheriting AllMentions" should read `settings.rooms[roomId]` directly
/// via `get_notification_settings`.
#[tauri::command]
pub async fn get_room_notification_level(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<NotificationLevel, String> {
    super::reconciler::resolve_effective_level(&state, &room_id).await
}

/// Bulk version of the above — effective level for every joined room.
/// Single account-data fetch, single space-children scan, then one
/// resolver call per room (each resolver call is pure; no further HTTP).
#[tauri::command]
pub async fn get_all_room_notification_levels(
    state: State<'_, Arc<AppState>>,
) -> Result<HashMap<String, NotificationLevel>, String> {
    let client = get_client(&state).await?;
    let settings = load_notification_settings_inner(&state).await?;
    let space_children = super::reconciler::fetch_space_children_map(&client).await;

    let mut out = HashMap::new();
    for room in client.joined_rooms() {
        if room.is_space() {
            continue;
        }
        let id = room.room_id().to_string();
        let level =
            super::reconciler::resolve_level_with_context(&room, &settings, &space_children)
                .await;
        out.insert(id, level);
    }
    Ok(out)
}
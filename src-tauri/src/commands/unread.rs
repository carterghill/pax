//! Read-state surface for the UI.
//!
//! Matrix tracks read state through three separate primitives: public read receipts
//! (`m.read`), private read receipts (`m.read.private`), and the user-marked unread
//! flag (MSC2867, stored in room account data).  matrix-sdk's `BaseRoom` already
//! exposes client-side-computed counts derived from all three, which are more accurate
//! than the server-reported `unread_notifications` for encrypted rooms — those are the
//! numbers we surface.
//!
//! This module provides:
//! 1. `get_room_unread_state` — a bulk snapshot read used on mount (per room).
//! 2. `send_room_read_receipt` — acknowledges a specific event, picking `Read` vs
//!    `ReadPrivate` based on the caller's `public` flag (driven by a settings toggle).
//!
//! Live diffs are emitted from the sync loop via `emit_unread_snapshot_if_changed`
//! (called from `commands::messages::start_sync` after each `sync_once`).  The
//! `RoomInfoNotableUpdate` broadcast is not used here because in matrix-sdk 0.16 the
//! `READ_RECEIPT` reason is only flagged on the sliding-sync code path; legacy
//! `sync_once` (which Pax uses) does not mark it, so the broadcast wouldn't fire on
//! incoming messages.  Polling the in-memory counts each sync iteration is cheap
//! (synchronous `RwLock` reads) and matches how Cinny/Element-web surface unread state.
//!
//! ### Push-rule-independent unread tracking
//!
//! The SDK's `num_unread_*` helpers and the server's `notification_count` are both
//! push-rule filtered — so a room muted via a `room`-kind `dont_notify` rule (what
//! Pass 2's notification levels install for anything below "All") reports zero
//! unread even when messages are actively arriving.  To keep the sidebar indicator
//! accurate for muted rooms, we augment both with `raw_unread_messages` — a counter
//! fed by the sync loop's `OriginalSyncRoomMessageEvent` handler, cleared by read
//! receipts (local sends and remote syncs from other devices).  The final
//! `messages` value is the max of all three sources, so nothing ever gets counted
//! less than reality.

use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::events::receipt::ReceiptThread;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId};
use matrix_sdk::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::AppState;

use super::{fmt_error_chain, get_client, resolve_room};

// ---------- Serialised payloads ----------

/// Counts surfaced to the UI for one room.
///
/// * `messages` — client-side-computed count of unread message events since the
///   user's last read receipt.  Used for the sidebar "primary-colour when unread"
///   treatment.  Combines three sources: the SDK's `num_unread_messages`, the
///   server's `notification_count`, and Pax's own event-handler-fed counter
///   (`raw_unread_messages` on AppState).  The last one is the fallback for
///   muted rooms where the first two are zeroed by push rules — see the module
///   doc for the full rationale.
/// * `notifications` — subset of `messages` that would push-notify per the user's
///   push rules.  Same value as `messages` with default rules; differs only if the
///   user has muted the room.  The UI can use this instead of `messages` if it
///   wants muted rooms to stay grey.
/// * `mentions` — subset of `notifications` that are highlights (explicit
///   mentions, `@room`, keywords).  Drives the red pill badge.
/// * `marked_unread` — the MSC2867 user-marked-unread flag stored in room account
///   data.  OR'd with `messages > 0` to get the final "is unread" predicate.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomUnreadState {
    pub messages: u64,
    pub notifications: u64,
    pub mentions: u64,
    pub marked_unread: bool,
}

impl RoomUnreadState {
    /// Build a snapshot, taking the `raw_unread_messages` counter into account.
    /// `raw_count` is this room's current counter value (0 if absent).
    fn from_room_with_raw(room: &matrix_sdk::Room, raw_count: u64) -> Self {
        let server = room.unread_notification_counts();
        let server_notifications = u64::from(server.notification_count);
        let server_mentions = u64::from(server.highlight_count);

        let client_messages = room.num_unread_messages();
        let client_notifications = room.num_unread_notifications();
        let client_mentions = room.num_unread_mentions();

        // For `messages`: take the max across the SDK, server, and our raw
        // counter.  The raw counter is the only source that correctly tracks
        // activity in push-rule-muted rooms.
        let messages = client_messages.max(server_notifications).max(raw_count);
        let notifications = client_notifications.max(server_notifications);
        let mentions = client_mentions.max(server_mentions);

        Self {
            messages,
            notifications,
            mentions,
            marked_unread: room.is_marked_unread(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomUnreadChangedPayload {
    pub room_id: String,
    #[serde(flatten)]
    pub state: RoomUnreadState,
}

/// Per-room last-emitted state, so we only fire `room-unread-changed` when a value
/// actually differs.  Owned by `AppState` (see `lib.rs`) because it must outlive
/// any single sync iteration and is read/written from the sync task.
pub type UnreadStateCache = Arc<Mutex<HashMap<OwnedRoomId, RoomUnreadState>>>;

/// Shared type alias for the raw-message-counter map on AppState.
pub type RawUnreadMessageCounts = Arc<Mutex<HashMap<OwnedRoomId, u64>>>;

// ---------- Commands ----------

/// Snapshot read for one room.  The frontend calls this on mount to seed its map
/// (so the sidebar paints correctly before the first live update arrives), and the
/// `room-unread-changed` event keeps it in sync afterwards.
#[tauri::command]
pub async fn get_room_unread_state(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomUnreadState, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let raw = state
        .raw_unread_messages
        .lock()
        .await
        .get(room.room_id())
        .copied()
        .unwrap_or(0);
    Ok(RoomUnreadState::from_room_with_raw(&room, raw))
}

/// Bulk snapshot over every joined room.  Cheaper than N individual invokes on
/// first render for a large account — the sidebar hook calls this once at mount.
#[tauri::command]
pub async fn get_all_unread_states(
    state: State<'_, Arc<AppState>>,
) -> Result<HashMap<String, RoomUnreadState>, String> {
    let client = get_client(&state).await?;
    let raw_map = state.raw_unread_messages.lock().await.clone();
    let mut out = HashMap::new();
    for room in client.joined_rooms() {
        let raw = raw_map.get(room.room_id()).copied().unwrap_or(0);
        out.insert(
            room.room_id().to_string(),
            RoomUnreadState::from_room_with_raw(&room, raw),
        );
    }
    Ok(out)
}

async fn apply_room_read_receipt(
    state: &Arc<AppState>,
    app: &AppHandle,
    room: &matrix_sdk::Room,
    event_id: OwnedEventId,
    as_public: bool,
) -> Result<(), String> {
    let receipt_type = if as_public {
        ReceiptType::Read
    } else {
        ReceiptType::ReadPrivate
    };

    room.send_single_receipt(receipt_type, ReceiptThread::Unthreaded, event_id)
        .await
        .map_err(|e| format!("Failed to send read receipt: {}", fmt_error_chain(&e)))?;

    // Clear the raw-message counter for this room; we've acknowledged up through
    // `event_id`.  Any fresh messages arriving after this point will be
    // counted anew via the message-event handler.
    state
        .raw_unread_messages
        .lock()
        .await
        .remove(room.room_id());

    // Echo locally so the sidebar updates immediately, even before the server's
    // next sync response returns.  `send_single_receipt` already zeroed the counts
    // in the SDK's in-memory `RoomInfo` (via `compute_unread_counts`), so this
    // just reads them and ships them to the UI.
    let new_state = RoomUnreadState::from_room_with_raw(room, 0);
    let payload = RoomUnreadChangedPayload {
        room_id: room.room_id().to_string(),
        state: new_state.clone(),
    };
    let _ = app.emit("room-unread-changed", payload);

    // Update the dedup cache so the sync-loop emitter doesn't re-emit the same value.
    let mut cache = state.unread_cache.lock().await;
    cache.insert(room.room_id().to_owned(), new_state);

    Ok(())
}

/// Send a read receipt for `event_id` in `room_id`.
///
/// When `public` is true, sends `m.read` (federated — other users see the avatar
/// indicator).  Otherwise sends `m.read.private`, which clears notifications on the
/// server and syncs the read state across the user's own devices but is NEVER
/// federated (per MSC2285 / the spec's privacy guarantees).
///
/// Both receipt types also clear the MSC2867 "marked unread" flag as a side effect
/// when the thread is `Unthreaded`.  We only ever send unthreaded receipts here —
/// thread-scoped read state is a future concern.
#[tauri::command]
pub async fn send_room_read_receipt(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    event_id: String,
    as_public: bool,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let event_id = EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    apply_room_read_receipt(&state, &app, &room, event_id, as_public).await
}

/// Mark / unmark a room as unread (MSC2867).  The Matrix server stores this flag
/// in room account data; it's fully per-user and syncs across all the user's
/// logged-in devices.  Invoked from the room context menu ("Mark as unread").
#[tauri::command]
pub async fn set_room_marked_unread(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    unread: bool,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    room.set_unread_flag(unread)
        .await
        .map_err(|e| format!("Failed to set unread flag: {}", fmt_error_chain(&e)))?;
    Ok(())
}

// ---------- Sync-loop hook ----------

/// Walk every joined room, diff its unread state against the cache, and emit
/// `room-unread-changed` for each room whose values moved.  Called from the
/// `start_sync` loop after each `sync_once` returns.
///
/// The walk is a synchronous `RwLock` read per room (no IO, no `await` on the
/// network), so even for hundreds of rooms this is sub-millisecond work.
pub async fn emit_unread_snapshot_if_changed(
    client: &Client,
    cache: &UnreadStateCache,
    raw_unread: &RawUnreadMessageCounts,
    app: &AppHandle,
) {
    // Snapshot the raw-message map first so we hold its lock briefly; the
    // matrix-sdk room reads are synchronous below.
    let raw_map: HashMap<OwnedRoomId, u64> = raw_unread.lock().await.clone();

    // Snapshot current state first (no locks held across .emit()).
    let snapshots: Vec<(OwnedRoomId, RoomUnreadState)> = client
        .joined_rooms()
        .into_iter()
        .map(|r| {
            let raw = raw_map.get(r.room_id()).copied().unwrap_or(0);
            (
                r.room_id().to_owned(),
                RoomUnreadState::from_room_with_raw(&r, raw),
            )
        })
        .collect();

    // Also detect rooms that have been left since last pass: emit a zero state so
    // the UI can drop them cleanly.
    let known_now: std::collections::HashSet<OwnedRoomId> =
        snapshots.iter().map(|(id, _)| id.clone()).collect();

    let mut cache = cache.lock().await;

    // Remove entries for rooms we no longer see (left, kicked, forgot).
    let removed: Vec<OwnedRoomId> = cache
        .keys()
        .filter(|k| !known_now.contains(*k))
        .cloned()
        .collect();
    for room_id in removed {
        cache.remove(&room_id);
        // No event emitted for left rooms — `rooms-changed` already fires in the
        // sync loop and the frontend drops them from its map when they're absent
        // from `get_rooms`.
    }

    for (room_id, new_state) in snapshots {
        let changed = match cache.get(&room_id) {
            Some(prev) => *prev != new_state,
            None => true, // First time we've seen this room — always emit.
        };
        if !changed {
            continue;
        }
        cache.insert(room_id.clone(), new_state.clone());

        let payload = RoomUnreadChangedPayload {
            room_id: room_id.to_string(),
            state: new_state,
        };
        let _ = app.emit("room-unread-changed", payload);
    }
}

/// Clear unread caches on logout / account switch so the next login starts fresh.
pub async fn clear_unread_cache(state: &Arc<AppState>) {
    state.unread_cache.lock().await.clear();
    state.raw_unread_messages.lock().await.clear();
}
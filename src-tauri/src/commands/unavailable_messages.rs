//! Acknowledge unavailable ciphertext with a private receipt, independently of
//! successful decryption. Persist only event IDs in private room account data.
use super::{
    get_client, resolve_room,
    unread::{RoomUnreadChangedPayload, RoomUnreadState},
};
use crate::AppState;
use matrix_sdk::{
    ruma::{
        api::client::receipt::create_receipt::v3::ReceiptType, events::receipt::ReceiptThread,
        EventId, OwnedEventId, OwnedRoomId,
    },
    Client, Room,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct PendingRead {
    operation: uuid::Uuid,
    event_id: OwnedEventId,
    confirmed: bool,
    newer_activity: bool,
    echoed: bool,
}
pub type PendingUnavailableReads = Arc<Mutex<HashMap<OwnedRoomId, PendingRead>>>;

pub(super) fn apply_pending(
    state: RoomUnreadState,
    pending: Option<&PendingRead>,
) -> RoomUnreadState {
    if pending.is_some_and(|p| p.confirmed && !p.newer_activity) {
        RoomUnreadState::default()
    } else {
        state
    }
}

pub(super) async fn note_incoming(pending: &PendingUnavailableReads, room: &Room) {
    if let Some(read) = pending.lock().await.get_mut(room.room_id()) {
        read.newer_activity = true;
    }
}

/// The original raw count has already been removed by the command. Do not
/// erase messages that arrived later when its own receipt echoes through sync.
pub(super) async fn note_receipt_echo(
    pending: &PendingUnavailableReads,
    room: &Room,
    events: &[OwnedEventId],
) -> bool {
    let mut reads = pending.lock().await;
    if let Some(read) = reads.get_mut(room.room_id()) {
        if events.contains(&read.event_id) {
            if read.confirmed {
                reads.remove(room.room_id());
            } else {
                read.echoed = true;
            }
            return true;
        }
    }
    false
}

const ACK_TYPE: &str = "com.carter.pax.unavailable_messages";
const MAX_ACKNOWLEDGED_EVENTS: usize = 192;

#[cfg(test)]
#[path = "unavailable_messages_tests.rs"]
mod tests;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acknowledgement {
    schema_version: u32,
    user_id: String,
    room_id: String,
    event_ids: Vec<String>,
    #[serde(default)]
    through_event_id: Option<String>,
}

fn ack_url(client: &Client, room: &Room) -> Result<String, String> {
    Ok(format!(
        "{}/_matrix/client/v3/user/{}/rooms/{}/account_data/{ACK_TYPE}",
        client.homeserver().as_str().trim_end_matches('/'),
        urlencoding::encode(client.user_id().ok_or("Not signed in")?.as_str()),
        urlencoding::encode(room.room_id().as_str())
    ))
}

async fn fetch_ack(
    http: &reqwest::Client,
    client: &Client,
    room: &Room,
) -> Result<Acknowledgement, String> {
    let user = client.user_id().ok_or("Not signed in")?.as_str();
    let response = http
        .get(ack_url(client, room)?)
        .bearer_auth(client.access_token().ok_or("Not signed in")?)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Could not check acknowledged unavailable messages. Check your connection.")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Acknowledgement {
            schema_version: 1,
            user_id: user.into(),
            room_id: room.room_id().to_string(),
            event_ids: vec![],
            through_event_id: None,
        });
    }
    if !response.status().is_success() {
        return Err("Could not check acknowledged unavailable messages.".into());
    }
    let record: Acknowledgement = response
        .json()
        .await
        .map_err(|_| "Invalid unavailable-message acknowledgement")?;
    if record.schema_version != 1
        || record.user_id != user
        || record.room_id != room.room_id().as_str()
        || record.event_ids.len() > MAX_ACKNOWLEDGED_EVENTS
        || record
            .event_ids
            .iter()
            .any(|id| EventId::parse(id).is_err())
    {
        return Err("Invalid unavailable-message acknowledgement".into());
    }
    Ok(record)
}

#[tauri::command]
pub async fn get_unavailable_message_acknowledgement(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Acknowledgement, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    fetch_ack(&state.http_client, &client, &room).await
}

fn merge_ids(previous: &[String], added: &[String]) -> Vec<String> {
    let mut ids = previous.to_vec();
    for id in added {
        ids.retain(|old| old != id);
        ids.push(id.clone());
    }
    if ids.len() > MAX_ACKNOWLEDGED_EVENTS {
        ids.drain(..ids.len() - MAX_ACKNOWLEDGED_EVENTS);
    }
    ids
}

#[tauri::command]
pub async fn acknowledge_unavailable_messages(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    event_id: String,
    unavailable_event_ids: Vec<String>,
    expected_user_id: String,
) -> Result<Acknowledgement, String> {
    // Keep auth/logout from replacing the account while counters are updated.
    let _session = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    if client.user_id().map(|u| u.as_str()) != Some(expected_user_id.as_str()) {
        return Err("The signed-in account changed. Reopen the conversation.".into());
    }
    let room = resolve_room(&client, &room_id)?;
    if unavailable_event_ids.is_empty() {
        return Err("No unavailable messages were selected.".into());
    }
    acknowledge(
        &state.http_client,
        &client,
        &room,
        &state.pending_unavailable_reads,
        &state.raw_unread_messages,
        &state.unread_cache,
        event_id,
        unavailable_event_ids,
        |snapshot| {
            let _ = app.emit("room-unread-changed", snapshot);
        },
    )
    .await
    .map(|record| {
        let _ = app.emit("room-unavailable-acknowledged", &record);
        record
    })
}

/// Available from any joined room's menu, without opening or decrypting it.
#[tauri::command]
pub async fn clear_room_notification(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    expected_user_id: String,
) -> Result<(), String> {
    let _session = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    if client.user_id().map(|u| u.as_str()) != Some(expected_user_id.as_str()) {
        return Err("The signed-in account changed. Reopen the conversation menu.".into());
    }
    let room = resolve_room(&client, &room_id)?;
    let record = clear_notification(
        &state.http_client,
        &client,
        &room,
        &state.pending_unavailable_reads,
        &state.raw_unread_messages,
        &state.unread_cache,
        |snapshot| {
            let _ = app.emit("room-unread-changed", snapshot);
        },
    )
    .await?;
    if let Some(record) = record {
        let _ = app.emit("room-unavailable-acknowledged", record);
    }
    Ok(())
}

async fn notification_target(
    http: &reqwest::Client,
    client: &Client,
    room: &Room,
) -> Result<Option<(String, Vec<String>)>, String> {
    // Fetch envelopes directly: missing keys must not prevent clearing, and
    // the server's timeline order is authoritative even if clocks are skewed.
    let response = http
        .get(format!(
            "{}/_matrix/client/v3/rooms/{}/messages",
            client.homeserver().as_str().trim_end_matches('/'),
            urlencoding::encode(room.room_id().as_str())
        ))
        .bearer_auth(client.access_token().ok_or("Not signed in")?)
        .query(&[("dir", "b"), ("limit", "100")])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| {
            "Could not load the conversation to clear its notification. Check your connection."
        })?;
    if !response.status().is_success() {
        return Err("Could not load the conversation to clear its notification.".into());
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Invalid conversation timeline response")?;
    let chunk = body["chunk"]
        .as_array()
        .ok_or("Invalid conversation timeline response")?;
    let Some(latest) = chunk.first() else {
        return Ok(None);
    };
    let event_id = EventId::parse(
        latest["event_id"]
            .as_str()
            .ok_or("Missing conversation event ID")?,
    )
    .map_err(|_| "Invalid conversation event ID")?
    .to_string();
    let unavailable = chunk
        .iter()
        .take(100)
        .filter_map(|event| {
            let raw = serde_json::value::to_raw_value(event).ok()?;
            super::messages::unavailable_message(&raw).map(|message| message.event_id)
        })
        .collect();
    Ok(Some((event_id, unavailable)))
}

async fn clear_notification(
    http: &reqwest::Client,
    client: &Client,
    room: &Room,
    pending_reads: &PendingUnavailableReads,
    raw_unread: &super::unread::RawUnreadMessageCounts,
    unread_cache: &super::unread::UnreadStateCache,
    emit: impl Fn(RoomUnreadChangedPayload),
) -> Result<Option<Acknowledgement>, String> {
    if let Some((target, unavailable)) = notification_target(http, client, room).await? {
        return acknowledge(
            http,
            client,
            room,
            pending_reads,
            raw_unread,
            unread_cache,
            target,
            unavailable,
            emit,
        )
        .await
        .map(Some);
    }
    // An empty conversation can still have a manually set unread flag.
    let count = raw_unread
        .lock()
        .await
        .get(room.room_id())
        .copied()
        .unwrap_or(0);
    let mut snapshot = RoomUnreadState::from_room_with_raw(room, count);
    if snapshot.messages > 0 || snapshot.notifications > 0 || snapshot.mentions > 0 {
        return Err("The latest event is unavailable, so its notification could not be cleared. Load the conversation and try again.".into());
    }
    room.set_unread_flag(false)
        .await
        .map_err(|_| "Could not clear the conversation’s unread flag.")?;
    snapshot.marked_unread = false;
    unread_cache
        .lock()
        .await
        .insert(room.room_id().to_owned(), snapshot.clone());
    emit(RoomUnreadChangedPayload {
        room_id: room.room_id().to_string(),
        state: snapshot,
    });
    Ok(None)
}

async fn acknowledge(
    http: &reqwest::Client,
    client: &Client,
    room: &Room,
    pending_reads: &PendingUnavailableReads,
    raw_unread: &super::unread::RawUnreadMessageCounts,
    unread_cache: &super::unread::UnreadStateCache,
    event_id: String,
    unavailable_event_ids: Vec<String>,
    emit: impl Fn(RoomUnreadChangedPayload),
) -> Result<Acknowledgement, String> {
    let room_id = room.room_id().to_string();
    let event_id = EventId::parse(event_id).map_err(|_| "Invalid message ID")?;
    if unavailable_event_ids.len() > 100
        || unavailable_event_ids
            .iter()
            .any(|id| EventId::parse(id).is_err())
    {
        return Err("Invalid unavailable message IDs".into());
    }
    let baseline = raw_unread
        .lock()
        .await
        .get(room.room_id())
        .copied()
        .unwrap_or(0);
    let operation = uuid::Uuid::new_v4();
    pending_reads.lock().await.insert(
        room.room_id().to_owned(),
        PendingRead {
            operation,
            event_id: event_id.clone(),
            confirmed: false,
            newer_activity: false,
            echoed: false,
        },
    );
    let mut record = match fetch_ack(http, client, room).await {
        Ok(record) => record,
        Err(error) => {
            let mut pending = pending_reads.lock().await;
            if pending
                .get(room.room_id())
                .is_some_and(|p| p.operation == operation)
            {
                pending.remove(room.room_id());
            }
            return Err(error);
        }
    };
    record.event_ids = merge_ids(&record.event_ids, &unavailable_event_ids);
    record.through_event_id = Some(event_id.to_string());
    if room
        .send_single_receipt(
            ReceiptType::ReadPrivate,
            ReceiptThread::Unthreaded,
            event_id,
        )
        .await
        .is_err()
    {
        let mut pending = pending_reads.lock().await;
        if pending
            .get(room.room_id())
            .is_some_and(|p| p.operation == operation)
        {
            pending.remove(room.room_id());
        }
        return Err(
            "Could not clear the notification. Check your connection and try again.".into(),
        );
    }
    let remaining = {
        let mut raw = raw_unread.lock().await;
        let count = raw.entry(room.room_id().to_owned()).or_default();
        *count = count.saturating_sub(baseline);
        *count
    };
    let pending = {
        let mut reads = pending_reads.lock().await;
        if let Some(read) = reads
            .get_mut(room.room_id())
            .filter(|r| r.operation == operation)
        {
            read.confirmed = true;
            read.newer_activity |= remaining > 0;
            if read.echoed {
                reads.remove(room.room_id());
            }
        }
        reads.get(room.room_id()).cloned()
    };
    let snapshot = apply_pending(
        RoomUnreadState::from_room_with_raw(&room, remaining),
        pending.as_ref(),
    );
    unread_cache
        .lock()
        .await
        .insert(room.room_id().to_owned(), snapshot.clone());
    emit(RoomUnreadChangedPayload {
        room_id: room_id.clone(),
        state: snapshot,
    });
    let response = http.put(ack_url(client,room)?).bearer_auth(client.access_token().ok_or("Not signed in")?)
        .timeout(Duration::from_secs(15)).json(&record).send().await
        .map_err(|_| "The notification was cleared, but acknowledgement could not be saved. Try Clear notification again.")?;
    if !response.status().is_success() {
        return Err("The notification was cleared, but acknowledgement could not be saved. Try Clear notification again.".into());
    }
    Ok(record)
}

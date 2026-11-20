use std::{collections::VecDeque, sync::Arc, time::Duration};

use matrix_sdk::{
    deserialized_responses::{TimelineEvent, TimelineEventKind},
    ruma::{
        events::{room::member::MembershipState, AnySyncTimelineEvent},
        serde::Raw,
        OwnedEventId, OwnedUserId,
    },
    sync::SyncResponse,
    Client, Room, RoomMemberships, RoomState,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use tokio::sync::Mutex;

use crate::{
    types::{DirectCallNotice, DirectCallSignalKind as SignalKind, MessageInfo},
    voice_presence::now_ms,
    AppState,
};

pub(super) const CALL_EVENT: &str = "com.carter.pax.direct_call";
const RING_MS: u64 = 30_000;
const MAX_PENDING_SIGNALS: usize = 128;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalContent {
    kind: SignalKind,
    call_id: String,
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer_device_id: Option<String>,
}

impl SignalContent {
    fn is_valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.call_id).is_ok()
            && !self.device_id.is_empty()
            && self
                .answer_device_id
                .as_ref()
                .is_none_or(|id| !id.is_empty())
            && (self.kind == SignalKind::Connect) == self.answer_device_id.is_some()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectCallSignal {
    #[serde(flatten)]
    content: SignalContent,
    room_id: String,
    peer_user_id: OwnedUserId,
    from_peer: bool,
    for_this_device: bool,
    expires_at: u64,
}

#[derive(Deserialize)]
struct CallEvent {
    event_id: OwnedEventId,
    sender: OwnedUserId,
    origin_server_ts: u64,
    content: SignalContent,
    state_key: Option<String>,
    #[serde(default)]
    unsigned: CallUnsigned,
}

#[derive(Default, Deserialize)]
struct CallUnsigned {
    redacted_because: Option<serde::de::IgnoredAny>,
}

pub(crate) type PendingDirectCalls = Mutex<VecDeque<DirectCallSignal>>;

async fn direct_call_peer(room: &Room) -> Option<OwnedUserId> {
    if room.state() != RoomState::Joined
        || room.is_space()
        || room.is_tombstoned()
        || !room.is_direct().await.ok()?
    {
        return None;
    }
    let me = room.own_user_id();
    let members = room
        .members_no_sync(RoomMemberships::JOIN | RoomMemberships::INVITE)
        .await
        .ok()?;
    if members.len() != 2 || room.active_members_count() > 2 {
        return None;
    }
    let peer = members.iter().find(|member| member.user_id() != me)?;
    (*peer.membership() == MembershipState::Join).then(|| peer.user_id().to_owned())
}

#[tauri::command]
pub(crate) async fn send_direct_call_signal(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    call_id: String,
    kind: SignalKind,
    answer_device_id: Option<String>,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    let content = SignalContent {
        kind,
        call_id,
        device_id: client.device_id().ok_or("No device ID")?.to_string(),
        answer_device_id,
    };
    if !content.is_valid() {
        return Err("Invalid call signal.".into());
    }
    if direct_call_peer(&room).await.is_none() {
        return Err("Both people must join the direct message before calling.".into());
    }

    let payload = serde_json::to_value(content).map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(12), async {
        room.send_raw(CALL_EVENT, payload).await
    })
    .await
    .map_err(|_| "The call request timed out.".to_string())?
    .map_err(|error| format!("Could not send the call request: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn take_direct_call_signals(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<DirectCallSignal>, String> {
    let now = now_ms();
    Ok(state
        .direct_calls
        .lock()
        .await
        .drain(..)
        .filter(|signal| signal.expires_at > now)
        .collect())
}

fn parse_call_event(raw: &Raw<AnySyncTimelineEvent>) -> Option<CallEvent> {
    if raw.get_field::<&str>("type").ok().flatten() != Some(CALL_EVENT) {
        return None;
    }
    let call: CallEvent = serde_json::from_str(raw.json().get()).ok()?;
    (call.content.is_valid() && call.state_key.is_none() && call.unsigned.redacted_because.is_none())
        .then_some(call)
}

pub(super) fn call_notice(
    raw: &Raw<AnySyncTimelineEvent>,
    encrypted_room: bool,
    decrypted: bool,
) -> Option<MessageInfo> {
    if encrypted_room && !decrypted {
        return None;
    }
    let call = parse_call_event(raw)?;
    Some(MessageInfo {
        direct_call_notice: Some(DirectCallNotice {
            call_id: call.content.call_id,
            kind: call.content.kind,
        }),
        event_id: call.event_id.to_string(),
        sender: call.sender.to_string(),
        timestamp: call.origin_server_ts,
        ..Default::default()
    })
}

fn fresh_call_event(event: &TimelineEvent, now: u64) -> Option<(CallEvent, u64, bool)> {
    let call = parse_call_event(event.raw())?;
    // Ignore old offers from the initial sync and limit clock skew.
    let expires_at = call.origin_server_ts.saturating_add(RING_MS);
    let decrypted = matches!(event.kind, TimelineEventKind::Decrypted(_));
    (expires_at > now && call.origin_server_ts <= now + RING_MS)
        .then_some((call, expires_at.min(now + RING_MS), decrypted))
}

pub(super) async fn receive_signals(
    state: &AppState,
    client: &Client,
    app: &tauri::AppHandle,
    response: &SyncResponse,
) {
    let (Some(me), Some(device)) = (client.user_id(), client.device_id()) else {
        return;
    };
    let now = now_ms();
    let mut incoming = Vec::new();
    for (room_id, update) in &response.rooms.joined {
        let call_events: Vec<_> = update
            .timeline
            .events
            .iter()
            .filter_map(|event| fresh_call_event(event, now))
            .collect();
        if call_events.is_empty() {
            continue;
        }
        let Some(room) = client.get_room(room_id) else {
            continue;
        };
        let Some(peer) = direct_call_peer(&room).await else {
            continue;
        };

        let encrypted_room = room.encryption_state().is_encrypted();
        for (call, expires_at, decrypted) in call_events {
            let from_peer = call.sender == peer;
            if !from_peer && (call.sender != me || call.content.device_id == device.as_str()) {
                continue;
            }
            if encrypted_room && !decrypted {
                continue;
            }
            incoming.push(DirectCallSignal {
                for_this_device: call.content.answer_device_id.as_deref() == Some(device.as_str()),
                content: call.content,
                room_id: room_id.to_string(),
                peer_user_id: peer.clone(),
                from_peer,
                expires_at,
            });
        }
    }
    if !incoming.is_empty() {
        let mut pending = state.direct_calls.lock().await;
        pending.retain(|signal| signal.expires_at > now);
        pending.extend(incoming);
        let excess = pending.len().saturating_sub(MAX_PENDING_SIGNALS);
        pending.drain(..excess);
        drop(pending);
        let _ = app.emit("direct-call-signals", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(timestamp: u64, kind: &str, answer_device: Option<&str>) -> TimelineEvent {
        let json = json!({
            "type": CALL_EVENT,
            "sender": "@peer:example.org",
            "event_id": "$call",
            "origin_server_ts": timestamp,
            "content": {
                "callId": "e2b097b1-7e21-483f-9daa-32e5d157604a",
                "deviceId": "CALLER",
                "kind": kind,
                "answerDeviceId": answer_device,
            },
        });
        TimelineEvent::from_plaintext(Raw::from_json_string(json.to_string()).unwrap())
    }

    #[test]
    fn sync_ignores_expired_offers_and_bounds_clock_skew() {
        let now = 500_000;
        let (_, expiry, _) = fresh_call_event(&event(now - 5000, "ring", None), now).unwrap();
        assert_eq!(expiry, now + 25_000);
        assert!(fresh_call_event(&event(now - RING_MS, "ring", None), now).is_none());
        assert!(fresh_call_event(&event(now + RING_MS + 1, "ring", None), now).is_none());
        let (_, expiry, _) = fresh_call_event(&event(now + 1000, "ring", None), now).unwrap();
        assert_eq!(expiry, now + RING_MS);
    }

    #[test]
    fn a_connect_signal_must_select_an_answering_device() {
        let now = 500_000;
        assert!(fresh_call_event(&event(now, "connect", None), now).is_none());
        assert!(fresh_call_event(&event(now, "ring", Some("OTHER")), now).is_none());
        let (connect, _, _) = fresh_call_event(&event(now, "connect", Some("OTHER")), now).unwrap();
        assert_eq!(connect.content.answer_device_id.as_deref(), Some("OTHER"));
    }

    #[test]
    fn old_signals_are_visible_in_history_without_ringing_again() {
        let old = event(42, "ring", None);
        assert!(fresh_call_event(&old, 500_000).is_none());
        assert!(call_notice(old.raw(), true, false).is_none());

        let notice = call_notice(old.raw(), true, true).unwrap();
        assert_eq!(notice.event_id, "$call");
        assert_eq!(notice.sender, "@peer:example.org");
        assert_eq!(notice.timestamp, 42);
        assert!(notice.direct_call_notice.unwrap().kind == SignalKind::Ring);
    }

    #[test]
    fn redacted_signals_are_not_call_history() {
        let original = event(42, "end", None);
        let mut redacted: serde_json::Value =
            serde_json::from_str(original.raw().json().get()).unwrap();
        redacted["unsigned"] = json!({ "redacted_because": {} });
        let raw = Raw::from_json_string(redacted.to_string()).unwrap();
        assert!(call_notice(&raw, false, false).is_none());
    }
}

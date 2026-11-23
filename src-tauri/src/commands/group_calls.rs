//! Room-wide MatrixRTC ringing. The membership referenced by the ring identifies
//! the shared audio session. Each response refers to the individual ring event.
use std::{collections::VecDeque, sync::Arc};

use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    ruma::{events::AnyStateEvent, serde::Raw, OwnedEventId, OwnedUserId, UserId},
    sync::SyncResponse,
    Client, Room, RoomMemberships,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use super::matrix_voip::callable_room;
use crate::{
    voice_presence::{active_membership, now_ms},
    AppState,
};

pub(crate) const RING: &str = "org.matrix.msc4075.rtc.notification";
const DECLINE: &str = "org.matrix.msc4310.rtc.decline";
const ANSWER: &str = "com.carter.pax.rtc.answer";
const LIFETIME: u64 = 30_000;
const SLOT: &str = "m.call#ROOM";
pub(crate) type Inbox = Mutex<VecDeque<GroupSignal>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ring {
    event_id: OwnedEventId,
    invitees: Vec<OwnedUserId>,
}

#[tauri::command]
pub(crate) async fn ring_group_call(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    membership_event_id: OwnedEventId,
) -> Result<Ring, String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    if !callable_room(&room)
        || !room.is_direct().await.map_err(|e| e.to_string())?
        || state.voice_room.lock().await.as_deref() != Some(&room_id)
    {
        return Err("Join the group chat’s voice session before ringing.".into());
    }
    let invitees: Vec<_> = room
        .members(RoomMemberships::JOIN)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| m.user_id().to_owned())
        .filter(|id| id != room.own_user_id())
        .collect();
    if invitees.is_empty() {
        return Err("No other members have joined this group chat.".into());
    }
    let sent = room
        .send_raw(
            RING,
            json!({
                "slot_id": SLOT, "notification_type": "ring", "m.call.intent": "audio",
                "sender_ts": now_ms(), "lifetime": LIFETIME, "m.mentions": { "user_ids": invitees },
                "m.relates_to": { "rel_type": "m.reference", "event_id": membership_event_id }
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(Ring {
        event_id: sent.event_id,
        invitees,
    })
}

pub(crate) async fn respond(
    room: &Room,
    ring: &matrix_sdk::ruma::EventId,
    action: &str,
) -> Result<(), String> {
    if action == "cancel" {
        room.redact(ring, None, None)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let kind = match action {
            "answer" => ANSWER,
            "decline" => DECLINE,
            _ => return Err("Unknown group call response.".into()),
        };
        room.send_raw(
            kind,
            json!({"m.relates_to": {"rel_type":"m.reference", "event_id":ring}}),
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn respond_to_group_call(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    ring_event_id: OwnedEventId,
    action: String,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    respond(&room, &ring_event_id, &action).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupSignal {
    kind: &'static str,
    room_id: String,
    sender: OwnedUserId,
    from_self: bool,
    ring_event_id: OwnedEventId,
    call_id: String,
    expires_at: u64,
}

fn notification_id(room: &str, ring: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("matrix-rtc\0{room}\0{ring}").as_bytes(),
    )
    .to_string()
}

fn ring_lifetime(content: &Value, me: &UserId, timestamp: u64, now: u64) -> Option<u64> {
    if content["notification_type"].as_str() != Some("ring")
        || content.get("slot_id").is_some_and(|v| v != SLOT)
        || !content["m.mentions"]["user_ids"]
            .as_array()?
            .iter()
            .any(|id| id == me.as_str())
        || timestamp > now.saturating_add(30_000)
    {
        return None;
    }
    let expiry = timestamp.saturating_add(content["lifetime"].as_u64()?.min(120_000));
    (expiry > now).then_some(expiry)
}

fn matching_membership(event: &Value, sender: &UserId, id: &str) -> bool {
    event["event_id"] == id
        && event["sender"] == sender.as_str()
        && event["type"]
            .as_str()
            .is_some_and(crate::voice_presence::membership_event_type)
        && event["content"]["application"] == "m.call"
        && event["content"]["call_id"] == ""
        && active_membership(event, now_ms()).is_some()
}

async fn current_membership(
    room: &Room,
    sender: &UserId,
    id: &str,
    state: Option<&[Raw<AnyStateEvent>]>,
) -> bool {
    // A suspended Android client has not synced the caller's new membership yet.
    if let Some(state) = state {
        return state
            .iter()
            .filter(|raw| raw.get_field::<&str>("event_id").ok().flatten() == Some(id))
            .any(|raw| {
                raw.deserialize_as()
                    .ok()
                    .is_some_and(|event| matching_membership(&event, sender, id))
            });
    }
    for ty in ["org.matrix.msc3401.call.member", "m.call.member"] {
        let Ok(events) = room.get_state_events(ty.into()).await else {
            continue;
        };
        if events.iter().any(|raw| {
            let Ok(event) = serde_json::to_value(raw) else {
                return false;
            };
            matching_membership(&event, sender, id)
        }) {
            return true;
        }
    }
    false
}

async fn parse(
    room: &Room,
    event: &TimelineEvent,
    state: Option<&[Raw<AnyStateEvent>]>,
) -> Option<GroupSignal> {
    let raw = event.raw();
    let ty = raw.get_field::<&str>("type").ok()??;
    let kind = match ty {
        RING | "m.rtc.notification" => "ring",
        DECLINE | "m.rtc.decline" => "decline",
        ANSWER => "answer",
        "m.room.redaction" => "cancel",
        _ => return None,
    };
    if !callable_room(room)
        || (kind != "cancel"
            && room.encryption_state().is_encrypted()
            && event.kind.encryption_info().is_none())
        || raw.get_field::<Value>("state_key").ok()?.is_some()
    {
        return None;
    }
    let sender = raw.get_field::<OwnedUserId>("sender").ok()??;
    let from_self = sender == room.own_user_id();
    let content = raw.get_field::<Value>("content").ok()??;
    let now = now_ms();
    let timestamp = raw.get_field::<u64>("origin_server_ts").ok()??;
    let mut expires_at = timestamp.saturating_add(120_000);
    if expires_at <= now || timestamp > now.saturating_add(30_000) {
        return None;
    }
    let related = &content["m.relates_to"];
    let ring_event_id = if kind == "cancel" {
        content["redacts"]
            .as_str()
            .and_then(|id| id.try_into().ok())
            .or_else(|| raw.get_field("redacts").ok().flatten())?
    } else {
        if related["rel_type"] != "m.reference" {
            return None;
        }
        let reference = related["event_id"].as_str()?;
        if kind == "ring" {
            if from_self {
                return None;
            }
            expires_at = ring_lifetime(&content, room.own_user_id(), timestamp, now)?;
            if !current_membership(room, &sender, reference, state).await {
                return None;
            }
            event.event_id()?
        } else {
            reference.try_into().ok()?
        }
    };
    Some(GroupSignal {
        kind,
        room_id: room.room_id().to_string(),
        sender,
        from_self,
        call_id: notification_id(room.room_id().as_str(), ring_event_id.as_str()),
        ring_event_id,
        expires_at,
    })
}

pub(super) async fn receive_signals(
    state: &AppState,
    client: &Client,
    app: &AppHandle,
    response: &SyncResponse,
) {
    let ignored = state.ignored_users.users(client).await;
    let mut incoming = Vec::new();
    for (id, update) in &response.rooms.joined {
        let Some(room) = client.get_room(id) else {
            continue;
        };
        for event in &update.timeline.events {
            if let Some(signal) = parse(&room, event, None).await {
                if !ignored.contains(&signal.sender) {
                    incoming.push(signal);
                }
            }
        }
    }
    if incoming.is_empty() {
        return;
    }
    let mut inbox = state.group_calls.lock().await;
    inbox.retain(|event| event.expires_at > now_ms());
    inbox.extend(incoming);
    let excess = inbox.len().saturating_sub(256);
    inbox.drain(..excess);
    drop(inbox);
    let _ = app.emit("group-call-signals", ());
}

#[tauri::command]
pub(crate) async fn take_group_call_signals(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<GroupSignal>, String> {
    Ok(state
        .group_calls
        .lock()
        .await
        .drain(..)
        .filter(|e| e.expires_at > now_ms())
        .collect())
}

#[cfg(target_os = "android")]
pub(crate) async fn push_event(
    room: &Room,
    event: &TimelineEvent,
    after: &[TimelineEvent],
    state: &[Raw<AnyStateEvent>],
) -> Option<Value> {
    let ty = event.raw().get_field::<&str>("type").ok()??;
    if !matches!(
        ty,
        RING | "m.rtc.notification" | DECLINE | "m.rtc.decline" | ANSWER
    ) {
        return None;
    }
    let ignored = json!({"kind":"ignore"});
    let Some(signal) = parse(room, event, Some(state)).await else {
        return Some(ignored);
    };
    if room.client().is_user_ignored(&signal.sender).await {
        return Some(ignored);
    }
    let mut kind = "ended";
    if signal.kind == "ring" {
        kind = "ring";
        for later in after {
            if let Some(other) = parse(room, later, Some(state)).await {
                if other.ring_event_id == signal.ring_event_id
                    && ((other.kind == "cancel" && other.sender == signal.sender)
                        || other.from_self)
                {
                    kind = "ended";
                    break;
                }
            }
        }
    } else if !signal.from_self {
        return Some(ignored);
    }
    let caller = room
        .cached_display_name()
        .map(|name| name.to_string())
        .unwrap_or_else(|| signal.sender.to_string());
    Some(
        json!({"kind":kind, "roomId":signal.room_id, "callId":signal.call_id, "caller":caller,
        "matrixVoip":true, "expiresAt":signal.expires_at}),
    )
}

#[cfg(target_os = "android")]
pub(crate) async fn decline_pushed_ring(room: &Room, event: &TimelineEvent, id: &str) -> bool {
    let Some(event_id) = event.event_id() else {
        return false;
    };
    if !matches!(
        event.raw().get_field::<&str>("type").ok().flatten(),
        Some(RING | "m.rtc.notification")
    ) || notification_id(room.room_id().as_str(), event_id.as_str()) != id
    {
        return false;
    }
    let Ok(context) = room
        .event_with_context(&event_id, true, 0u32.into(), None)
        .await
    else {
        return false;
    };
    let Some(ring) = parse(room, event, Some(&context.state)).await else {
        return false;
    };
    ring.kind == "ring"
        && ring.call_id == id
        && respond(room, &ring.ring_event_id, "decline").await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{matrix_voip::tests::shared_room, pax_auth::tests::USER};

    #[tokio::test]
    async fn group_ring_requires_our_invitation_and_the_callers_active_membership() {
        let (_dir, _server, room) = shared_room().await;
        let bob = "@bob:example.org";
        let carol = "@carol:example.org";
        let ring = |sender, targets: &[&str], membership: &str, ts| {
            let content = json!({"notification_type":"ring", "slot_id":SLOT, "m.mentions":{"user_ids":targets},
                "m.relates_to":{"rel_type":"m.reference","event_id":membership}, "lifetime":LIFETIME});
            TimelineEvent::from_plaintext(Raw::from_json_string(json!({
                "type":RING, "event_id":"$ring","sender":sender,"origin_server_ts":ts,"content":content
            }).to_string()).unwrap())
        };
        let now = now_ms();
        let valid = ring(bob, &[USER, carol], "$rtc", now);
        let incoming = parse(&room, &valid, None).await.unwrap();
        assert_eq!(incoming.kind, "ring");
        assert_eq!(incoming.sender.as_str(), bob);
        assert_eq!(incoming.ring_event_id.as_str(), "$ring");
        assert!(parse(&room, &ring(bob, &[carol], "$rtc", now), None)
            .await
            .is_none());
        assert!(parse(&room, &ring(carol, &[USER], "$rtc", now), None)
            .await
            .is_none());
        assert!(parse(&room, &ring(bob, &[USER], "$old", now), None)
            .await
            .is_none());
        assert!(
            parse(&room, &ring(bob, &[USER], "$rtc", now - LIFETIME), None)
                .await
                .is_none()
        );
    }
}

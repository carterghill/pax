use std::{collections::VecDeque, sync::Arc, time::Duration};

#[cfg(any(target_os = "android", test))]
use matrix_sdk::ruma::UserId;
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

use super::call_policy::{self, CallKind, CallMode};
use crate::{
    types::{
        DirectCallEndReason, DirectCallNotice, DirectCallNoticeDetails,
        DirectCallSignalKind as SignalKind, MessageInfo, JS_MAX_SAFE_INTEGER,
    },
    voice_presence::now_ms,
    AppState,
};

pub(super) const CALL_EVENT: &str = "com.carter.pax.direct_call";
const RING_MS: u64 = 30_000;
const END_SIGNAL_MS: u64 = 120_000;
const MAX_PENDING_SIGNALS: usize = 128;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalContent {
    kind: SignalKind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    video: bool,
    call_id: String,
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    connection_lost: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    declined: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    end_reason: Option<DirectCallEndReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

impl SignalKind {
    fn is_recovery(self) -> bool {
        matches!(
            self,
            Self::Resume | Self::ResumeAccepted | Self::ResumeRejected
        )
    }
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
            && (!self.declined || (self.kind == SignalKind::End && !self.connection_lost))
            && ((self.end_reason.is_none() && self.duration_ms.is_none()) || self.kind == SignalKind::End)
            && if self.kind.is_recovery() {
                self.target_device_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty())
                    && self
                        .request_id
                        .as_ref()
                        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                    && !self.connection_lost
            } else {
                self.target_device_id.is_none()
                    && self.request_id.is_none()
                    && (!self.connection_lost || self.kind == SignalKind::End)
            }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectCallSignal {
    #[serde(flatten)]
    content: SignalContent,
    event_id: OwnedEventId,
    room_id: String,
    peer_user_id: OwnedUserId,
    from_peer: bool,
    for_this_device: bool,
    silent: bool,
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

impl CallEvent {
    fn handled_by(&self, user_id: &matrix_sdk::ruma::UserId) -> bool {
        self.sender == user_id && (self.content.kind == SignalKind::Answer || self.content.declined)
    }
}

#[derive(Default, Deserialize)]
struct CallUnsigned {
    redacted_because: Option<serde::de::IgnoredAny>,
}

pub(crate) type PendingDirectCalls = Mutex<VecDeque<DirectCallSignal>>;

pub(crate) async fn direct_call_peer(room: &Room) -> Option<OwnedUserId> {
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

#[cfg(target_os = "android")]
pub(crate) async fn call_push_event(
    room: &Room,
    peer: &UserId,
    event: &TimelineEvent,
    before: &[TimelineEvent],
    after: &[TimelineEvent],
    now: u64,
) -> Option<serde_json::Value> {
    if event.raw().get_field::<&str>("type").ok().flatten() != Some(CALL_EVENT) {
        return None;
    }
    let ignored = serde_json::json!({ "kind": "ignore" });
    let encrypted = room.encryption_state().is_encrypted();
    let parse = |event: &TimelineEvent| {
        if encrypted && !matches!(event.kind, TimelineEventKind::Decrypted(_)) {
            return None;
        }
        parse_call_event(event.raw())
    };
    let Some(call) = parse(event) else {
        return Some(ignored);
    };
    let related = |events: &[TimelineEvent]| {
        events
            .iter()
            .filter_map(parse)
            .filter(|event| event.content.call_id == call.content.call_id)
            .collect::<Vec<_>>()
    };
    let before = related(before);
    let after = related(after);
    let outcome = call_push_outcome(&call, &before, &after, peer, room.own_user_id(), now);
    let (kind, expires_at, ring_event_id) = match outcome {
        CallPushOutcome::Ring(expires_at) => ("ring", expires_at, None),
        CallPushOutcome::Ended => ("ended", 0, None),
        CallPushOutcome::Missed(ring) => ("missed", 0, Some(&ring.event_id)),
        CallPushOutcome::Ignore => return Some(ignored),
    };
    if matches!(kind, "ring" | "missed")
        && !call_policy::pushed_call_can_ring(room, peer, CallKind::LiveKit).await
    {
        return Some(ignored);
    }
    let caller = room
        .get_member_no_sync(peer)
        .await
        .ok()
        .flatten()
        .and_then(|member| member.display_name().map(str::to_owned))
        .unwrap_or_else(|| peer.to_string());
    Some(serde_json::json!({
        "kind": kind,
        "callId": call.content.call_id,
        "caller": caller,
        "video": call.content.video,
        "roomId": room.room_id(),
        "expiresAt": expires_at,
        "ringEventId": ring_event_id,
    }))
}

#[cfg(any(target_os = "android", test))]
enum CallPushOutcome<'a> {
    Ring(u64),
    Ended,
    Missed(&'a CallEvent),
    Ignore,
}

#[cfg(any(target_os = "android", test))]
fn call_push_outcome<'a>(
    call: &'a CallEvent,
    before: &'a [CallEvent],
    after: &'a [CallEvent],
    peer: &UserId,
    me: &UserId,
    now: u64,
) -> CallPushOutcome<'a> {
    // An answer on any of our devices or a connect from the caller settles the ring.
    let settles_ring = |event: &CallEvent, ring: &CallEvent| {
        if event.content.call_id != ring.content.call_id {
            return false;
        }
        let from_caller =
            event.sender == ring.sender && event.content.device_id == ring.content.device_id;
        match event.content.kind {
            SignalKind::Answer => event.sender == me,
            SignalKind::Connect => from_caller,
            SignalKind::End => event.sender == me,
            _ => false,
        }
    };
    let is_caller_end = |end: &CallEvent, ring: &CallEvent| {
        end.content.kind == SignalKind::End
            && end.content.call_id == ring.content.call_id
            && end.sender == peer
            && end.content.device_id == ring.content.device_id
    };
    let from_peer = call.sender == peer;
    let expires_at = call.signal_expiry(now);
    match call.content.kind {
        SignalKind::Ring if from_peer => {
            // A delayed ring push can arrive after the caller hung up.
            if after.iter().any(|event| settles_ring(event, call)) {
                return CallPushOutcome::Ended;
            }
            if let Some(end) = after.iter().find(|event| is_caller_end(event, call)) {
                return if end.signal_expiry(now).is_some() && !end.content.connection_lost {
                    CallPushOutcome::Missed(call)
                } else {
                    CallPushOutcome::Ended
                };
            }
            expires_at.map_or(CallPushOutcome::Ignore, CallPushOutcome::Ring)
        }
        SignalKind::End if from_peer && expires_at.is_some() && !call.content.connection_lost => {
            let ring = before.iter().find(|event| {
                event.content.kind == SignalKind::Ring
                    && event.sender == peer
                    && is_caller_end(call, event)
            });
            if let Some(ring) = ring {
                if !before.iter().chain(after).any(|event| settles_ring(event, ring)) {
                    return CallPushOutcome::Missed(ring);
                }
            }
            CallPushOutcome::Ended
        }
        SignalKind::End | SignalKind::Answer | SignalKind::Connect
            if expires_at.is_some() && (from_peer || call.sender == me) =>
        {
            CallPushOutcome::Ended
        }
        _ => CallPushOutcome::Ignore,
    }
}

#[cfg(target_os = "android")]
pub(crate) async fn decline_pushed_call(
    client: &Client,
    room: &Room,
    call_id: String,
) -> bool {
    let Some(device_id) = client.device_id() else { return false };
    if direct_call_peer(room).await.is_none() || uuid::Uuid::parse_str(&call_id).is_err() {
        return false;
    }
    let content = SignalContent {
        kind: SignalKind::End,
        video: false,
        call_id,
        device_id: device_id.to_string(),
        answer_device_id: None,
        target_device_id: None,
        request_id: None,
        connection_lost: false,
        declined: true,
        end_reason: None,
        duration_ms: None,
    };
    match serde_json::to_value(content) {
        Ok(payload) => room.send_raw(CALL_EVENT, payload).await.is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
pub(crate) async fn send_direct_call_signal(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    room_id: String,
    call_id: String,
    kind: SignalKind,
    video: Option<bool>,
    answer_device_id: Option<String>,
    target_device_id: Option<String>,
    request_id: Option<String>,
    connection_lost: Option<bool>,
    declined: Option<bool>,
    end_reason: Option<DirectCallEndReason>,
    duration_ms: Option<u64>,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    let content = SignalContent {
        kind,
        video: kind == SignalKind::Ring && video.unwrap_or(false),
        call_id,
        device_id: client.device_id().ok_or("No device ID")?.to_string(),
        answer_device_id,
        target_device_id,
        request_id,
        connection_lost: connection_lost.unwrap_or_default(),
        declined: declined.unwrap_or_default(),
        end_reason,
        duration_ms,
    };
    if !content.is_valid() {
        return Err("Invalid call signal.".into());
    }
    if content.declined {
        super::unread::acknowledge_calls(&state, &app, &room, std::slice::from_ref(&content.call_id)).await;
    }
    let peer = direct_call_peer(&room)
        .await
        .ok_or("Both people must join the direct message before calling.")?;
    if kind == SignalKind::Ring {
        call_policy::require_start(&room, CallKind::LiveKit, Some(&peer)).await?;
    }

    let payload = serde_json::to_value(&content).map_err(|error| error.to_string())?;
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
    (call.content.is_valid()
        && call.state_key.is_none()
        && call.unsigned.redacted_because.is_none())
    .then_some(call)
}

pub(super) fn call_id_for_event(event: &TimelineEvent, encrypted_room: bool) -> Option<String> {
    if encrypted_room && event.kind.encryption_info().is_none() {
        return None;
    }
    parse_call_event(event.raw()).map(|call| call.content.call_id)
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
    if call.content.kind.is_recovery() {
        return None;
    }
    Some(MessageInfo {
        direct_call_notice: Some(DirectCallNotice {
            call_id: call.content.call_id,
            kind: call.content.kind,
            details: DirectCallNoticeDetails {
                expires_at: (call.content.kind == SignalKind::Ring)
                    .then(|| call.origin_server_ts.saturating_add(RING_MS)),
                end_reason: if call.content.declined {
                    Some(DirectCallEndReason::Declined)
                } else if call.content.connection_lost {
                    Some(DirectCallEndReason::Dropped)
                } else {
                    call.content.end_reason
                },
                duration_ms: call.content.duration_ms.filter(|duration| *duration <= JS_MAX_SAFE_INTEGER),
                ..Default::default()
            },
        }),
        event_id: call.event_id.to_string(),
        sender: call.sender.to_string(),
        timestamp: call.origin_server_ts,
        ..Default::default()
    })
}

impl CallEvent {
    fn signal_expiry(&self, now: u64) -> Option<u64> {
        // Ignore old offers from the initial sync and limit clock skew.
        let lifetime = if self.content.kind == SignalKind::End {
            END_SIGNAL_MS
        } else {
            RING_MS
        };
        let expires_at = self.origin_server_ts.saturating_add(lifetime);
        (expires_at > now && self.origin_server_ts <= now + RING_MS)
            .then_some(expires_at.min(now + lifetime))
    }
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
    let ignored = state.ignored_users.users(client).await;
    let mut incoming = Vec::new();
    for (room_id, update) in &response.rooms.joined {
        let call_events: Vec<_> = update
            .timeline
            .events
            .iter()
            .filter_map(|event| {
                let call = parse_call_event(event.raw())?;
                if ignored.contains(&call.sender) {
                    return None;
                }
                let expires_at = call.signal_expiry(now);
                Some((
                    call,
                    expires_at,
                    matches!(event.kind, TimelineEventKind::Decrypted(_)),
                ))
            })
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
            if encrypted_room && !decrypted {
                continue;
            }
            let from_peer = call.sender == peer;
            if from_peer {
                state.matrix_voip.remember_livekit_peer(room_id, &peer).await;
            }
            let mut silent = false;
            if from_peer && call.content.kind == SignalKind::Ring && expires_at.is_some() {
                let mode = call_policy::incoming_mode(state, &room, &peer, CallKind::LiveKit).await;
                if mode == CallMode::Block {
                    state
                        .unread_projection
                        .acknowledge_calls(&room, std::slice::from_ref(&call.content.call_id))
                        .await;
                    continue;
                }
                silent = mode == CallMode::Silent;
            }
            let handled_here = call.handled_by(me);
            // A past response can still settle an unread ring on initial sync.
            if handled_here || from_peer {
                state
                    .unread_projection
                    .note_call_event(room_id, &call.content.call_id, handled_here)
                    .await;
            }
            let Some(expires_at) = expires_at else {
                continue;
            };
            if !from_peer && (call.sender != me || call.content.device_id == device.as_str()) {
                continue;
            }
            if call.content.kind.is_recovery()
                && (!from_peer || call.content.target_device_id.as_deref() != Some(device.as_str()))
            {
                continue;
            }
            #[cfg(target_os = "ios")]
            if matches!(call.content.kind, SignalKind::End)
                || (call.sender == me && call.content.kind == SignalKind::Answer)
                || (from_peer && call.content.kind == SignalKind::Connect
                    && call.content.answer_device_id.as_deref() != Some(device.as_str()))
            {
                crate::call_notifications::close_ios_ringing_call(&call.content.call_id);
            }
            incoming.push(DirectCallSignal {
                silent,
                for_this_device: call.content.answer_device_id.as_deref() == Some(device.as_str()),
                content: call.content,
                event_id: call.event_id,
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

    fn fresh_call_event(event: &TimelineEvent, now: u64) -> Option<(CallEvent, u64, bool)> {
        let call = parse_call_event(event.raw())?;
        let expires_at = call.signal_expiry(now)?;
        Some((
            call,
            expires_at,
            matches!(event.kind, TimelineEventKind::Decrypted(_)),
        ))
    }

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
    fn video_rings_and_older_voice_rings_preserve_their_call_type() {
        let ring = event(500_000, "ring", None);
        let mut content = parse_call_event(ring.raw()).unwrap().content;
        assert!(!content.video);
        assert!(serde_json::to_value(&content).unwrap().get("video").is_none());
        content.video = true;
        let wire = serde_json::to_value(&content).unwrap();
        assert_eq!(wire["video"], true);
        assert!(serde_json::from_value::<SignalContent>(wire).unwrap().video);
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
    fn recovery_signals_require_a_device_and_request_and_stay_out_of_history() {
        let now = 500_000;
        let offer = event(now, "resume", None);
        assert!(fresh_call_event(&offer, now).is_none());
        let mut value: serde_json::Value = serde_json::from_str(offer.raw().json().get()).unwrap();
        value["content"]["targetDeviceId"] = json!("PEER_DEVICE");
        value["content"]["requestId"] = json!("invalid");
        let malformed =
            TimelineEvent::from_plaintext(Raw::from_json_string(value.to_string()).unwrap());
        assert!(fresh_call_event(&malformed, now).is_none());
        value["content"]["requestId"] = json!("81db73fd-c64e-44f0-8ee7-de5d7943b83e");
        for kind in ["resume", "resumeAccepted", "resumeRejected"] {
            value["content"]["kind"] = json!(kind);
            let valid =
                TimelineEvent::from_plaintext(Raw::from_json_string(value.to_string()).unwrap());
            let (call, _, _) = fresh_call_event(&valid, now).unwrap();
            assert_eq!(
                call.content.target_device_id.as_deref(),
                Some("PEER_DEVICE")
            );
            assert!(call_notice(valid.raw(), true, true).is_none());
        }
    }

    #[test]
    fn a_recent_hangup_can_be_delivered_after_the_ring_timeout() {
        let now = 500_000;
        assert!(fresh_call_event(&event(now - RING_MS - 1, "end", None), now).is_some());
        assert!(fresh_call_event(&event(now - END_SIGNAL_MS, "end", None), now).is_none());
    }

    fn push_event(
        id: &str,
        timestamp: u64,
        kind: &str,
        sender: &str,
        device: &str,
    ) -> CallEvent {
        let answer_device = (kind == "connect").then_some("CALLEE");
        let event = event(timestamp, kind, answer_device);
        let mut data: serde_json::Value = serde_json::from_str(event.raw().json().get()).unwrap();
        data["event_id"] = json!(id);
        data["sender"] = json!(sender);
        data["content"]["deviceId"] = json!(device);
        serde_json::from_value(data).unwrap()
    }

    #[test]
    fn only_our_explicit_decline_acknowledges_an_ended_call() {
        let me = UserId::parse("@me:example.org").unwrap();
        let peer = UserId::parse("@peer:example.org").unwrap();
        let mut event = push_event("$end", 1000, "end", me.as_str(), "CALLEE");
        assert!(!event.handled_by(&me));
        event.content.declined = true;
        assert!(event.content.is_valid());
        assert!(event.handled_by(&me));
        assert!(!event.handled_by(&peer));
        event.content.connection_lost = true;
        assert!(!event.content.is_valid());
    }

    #[test]
    fn either_push_for_an_unanswered_incoming_call_points_to_its_ring() {
        let peer = UserId::parse("@peer:example.org").unwrap();
        let me = UserId::parse("@me:example.org").unwrap();
        let ring = push_event("$ring", 1000, "ring", peer.as_str(), "CALLER");
        let end = push_event("$end", 1000 + RING_MS, "end", peer.as_str(), "CALLER");
        let now = 1000 + RING_MS + 100;
        assert!(matches!(
            call_push_outcome(&ring, &[], &[], &peer, &me, 2000),
            CallPushOutcome::Ring(expires_at) if expires_at == 1000 + RING_MS
        ));
        assert!(matches!(
            call_push_outcome(&end, std::slice::from_ref(&ring), &[], &peer, &me, now),
            CallPushOutcome::Missed(ring) if ring.event_id.as_str() == "$ring"
        ));
        assert!(matches!(
            call_push_outcome(&ring, &[], &[end], &peer, &me, now),
            CallPushOutcome::Missed(ring) if ring.event_id.as_str() == "$ring"
        ));
    }

    #[test]
    fn answered_declined_and_outgoing_calls_are_not_missed_incoming_calls() {
        let peer = UserId::parse("@peer:example.org").unwrap();
        let me = UserId::parse("@me:example.org").unwrap();
        let end = push_event("$end", 3000, "end", peer.as_str(), "CALLER");
        for (kind, sender, device) in [
            ("answer", me.as_str(), "OTHER_CALLEE"),
            ("connect", peer.as_str(), "CALLER"),
            ("end", me.as_str(), "CALLEE"),
        ] {
            let ring = push_event("$ring", 1000, "ring", peer.as_str(), "CALLER");
            let settled = push_event("$settled", 2000, kind, sender, device);
            assert!(matches!(
                call_push_outcome(&end, &[ring, settled], &[], &peer, &me, 4000),
                CallPushOutcome::Ended
            ));
        }
        let outgoing = push_event("$outgoing", 1000, "ring", me.as_str(), "CALLEE");
        assert!(matches!(
            call_push_outcome(&end, &[outgoing], &[], &peer, &me, 4000),
            CallPushOutcome::Ended
        ));
    }

    #[test]
    fn unrelated_signals_do_not_mark_a_call_missed_or_stop_a_live_ring() {
        let peer = UserId::parse("@peer:example.org").unwrap();
        let me = UserId::parse("@me:example.org").unwrap();
        let ring = push_event("$ring", 1000, "ring", peer.as_str(), "CALLER");
        let end = push_event("$other", 2000, "end", peer.as_str(), "OTHER_CALLER");
        assert!(matches!(
            call_push_outcome(&end, std::slice::from_ref(&ring), &[], &peer, &me, 3000),
            CallPushOutcome::Ended
        ));
        assert!(matches!(
            call_push_outcome(&ring, &[], &[end], &peer, &me, 3000),
            CallPushOutcome::Ring(_)
        ));
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
        let call = notice.direct_call_notice.unwrap();
        assert!(call.kind == SignalKind::Ring);
        assert_eq!(call.details.expires_at, Some(42 + RING_MS));
    }

    #[test]
    fn history_keeps_explicit_outcomes_and_elapsed_duration() {
        let end = event(80_000, "end", None);
        let mut data: serde_json::Value = serde_json::from_str(end.raw().json().get()).unwrap();
        data["content"]["durationMs"] = json!(65_000);
        let raw = Raw::from_json_string(data.to_string()).unwrap();
        let notice = call_notice(&raw, false, false).unwrap().direct_call_notice.unwrap();
        assert_eq!(notice.details.duration_ms, Some(65_000));
        assert!(notice.details.end_reason.is_none());

        data["content"].as_object_mut().unwrap().remove("durationMs");
        data["content"]["declined"] = json!(true);
        let raw = Raw::from_json_string(data.to_string()).unwrap();
        let notice = call_notice(&raw, false, false).unwrap().direct_call_notice.unwrap();
        assert!(notice.details.end_reason == Some(DirectCallEndReason::Declined));
        assert!(notice.details.duration_ms.is_none());
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

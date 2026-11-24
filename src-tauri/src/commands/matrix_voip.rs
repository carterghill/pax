use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};

use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    ruma::{
        api::client::voip::get_turn_server_info,
        events::{room::member::MembershipState, AnySyncTimelineEvent},
        serde::Raw,
        OwnedUserId, RoomId, UserId,
    },
    sync::SyncResponse,
    Client, Room, RoomMemberships, RoomState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use super::call_policy::{self, CallKind, CallMode};
use crate::{
    types::{
        DirectCallEndReason, DirectCallNotice, DirectCallNoticeDetails, DirectCallSignalKind,
        MessageInfo, JS_MAX_SAFE_INTEGER,
    },
    voice::{
        camera::CameraCapture,
        peer::{Candidate, Description, PeerMedia},
        CallVideo,
    },
    voice_presence::now_ms,
    AppState,
};

const KEEP_SIGNALS_MS: u64 = 150_000;
const MAX_SIGNALS: usize = 256;
const LIVEKIT_SUPPORT: &str = "com.carter.pax.direct_call";
const DECLINED_CALL: &str = "com.carter.pax.declined";
const CALL_DURATION: &str = "com.carter.pax.duration_ms";
const VOIP_EVENTS: &[&str] = &[
    "m.call.invite",
    "m.call.answer",
    "m.call.candidates",
    "m.call.select_answer",
    "m.call.reject",
    "m.call.hangup",
    "m.call.negotiate",
    "m.call.sdp_stream_metadata_changed",
];

#[derive(Default)]
pub(crate) struct MatrixVoip {
    media: Mutex<Option<PeerMedia>>,
    inbox: Mutex<VecDeque<Signal>>,
    participants: Mutex<VecDeque<(String, OwnedUserId)>>,
    livekit_peers: Mutex<HashSet<(String, String)>>,
}

impl MatrixVoip {
    pub async fn reset(&self) {
        self.media.lock().await.take();
        self.inbox.lock().await.clear();
        self.participants.lock().await.clear();
        self.livekit_peers.lock().await.clear();
    }

    async fn remember_participant(&self, id: &str, peer: &UserId) {
        let mut calls = self.participants.lock().await;
        if calls.iter().any(|(known, _)| known == id) {
            return;
        }
        if calls.len() >= MAX_SIGNALS {
            calls.pop_front();
        }
        calls.push_back((id.to_owned(), peer.to_owned()));
    }

    pub async fn remember_livekit_peer(&self, room_id: &RoomId, peer: &UserId) {
        self.livekit_peers
            .lock()
            .await
            .insert((room_id.to_string(), peer.to_string()));
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Signal {
    #[serde(rename(deserialize = "type"))]
    kind: String,
    #[serde(rename(deserialize = "event_id"))]
    event_id: String,
    sender: String,
    #[serde(rename(deserialize = "origin_server_ts"))]
    timestamp: u64,
    content: Value,
    #[serde(skip_serializing, default)]
    state_key: Option<String>,
    #[serde(skip_serializing, default)]
    unsigned: Value,
    #[serde(skip_deserializing)]
    room_id: String,
    #[serde(skip_deserializing)]
    silent: bool,
    #[serde(skip_deserializing)]
    video: bool,
    #[serde(skip_deserializing)]
    from_peer: bool,
    #[serde(skip_deserializing)]
    local_party: String,
    #[serde(skip_deserializing)]
    notification_id: String,
    #[serde(skip_deserializing)]
    expires_at: u64,
}

// Classify the invite before presenting an Answer action, including push notifications.
fn offers_camera(content: &Value) -> bool {
    let Some(sdp) = content["offer"]["sdp"].as_str() else { return false };
    let metadata = &content["sdp_stream_metadata"];
    sdp.split("\nm=").skip(1).any(|section| {
        let mut lines = section.lines();
        let mut header = lines.next().unwrap_or_default().split_ascii_whitespace();
        if header.next() != Some("video") {
            return false;
        }
        let port = header.next().and_then(|port| port.split('/').next()?.parse::<u16>().ok());
        if port.is_none() || (port == Some(0) && !lines.clone().any(|line| line == "a=bundle-only")) {
            return false;
        }
        !lines.any(|line| {
            matches!(line, "a=inactive" | "a=recvonly" | "a=content:slides")
                || line.strip_prefix("a=msid:").and_then(|msid| msid.split_whitespace().next())
                    .is_some_and(|id| metadata[id]["purpose"] == "m.screenshare")
        })
    })
}

impl Signal {
    fn handled_here(&self) -> bool {
        !self.from_peer
            && (matches!(self.kind.as_str(), "m.call.answer" | "m.call.reject")
                || (self.kind == "m.call.hangup"
                    && self.content[DECLINED_CALL].as_bool() == Some(true)))
    }

    fn parse_raw(raw: &Raw<AnySyncTimelineEvent>, room: &Room, decrypted: bool) -> Option<Self> {
        let kind = raw.get_field::<&str>("type").ok().flatten()?;
        if !VOIP_EVENTS.contains(&kind) || (room.encryption_state().is_encrypted() && !decrypted) {
            return None;
        }
        let mut signal: Self = serde_json::from_str(raw.json().get()).ok()?;
        let call_id = signal.content["call_id"].as_str()?;
        if !valid_id(call_id)
            || signal.state_key.is_some()
            || !signal.unsigned["redacted_because"].is_null()
            || !signal.content.is_object()
        {
            return None;
        }
        signal.room_id = room.room_id().to_string();
        signal.video = kind == "m.call.invite" && offers_camera(&signal.content);
        signal.from_peer = signal.sender != room.own_user_id().as_str();
        signal.local_party = room.client().device_id()?.to_string();
        signal.notification_id = notification_id(&signal.room_id, call_id);
        let now = now_ms();
        let age = signal.unsigned["age"].as_u64();
        let origin = match age {
            Some(age) => now.saturating_sub(age),
            None if signal.timestamp > now + 30_000 => 0,
            None => signal.timestamp.min(now),
        };
        signal.expires_at = origin.saturating_add(signal.lifetime());
        Some(signal)
    }

    fn parse(event: &TimelineEvent, room: &Room) -> Option<Self> {
        Self::parse_raw(event.raw(), room, event.kind.encryption_info().is_some())
    }

    fn lifetime(&self) -> u64 {
        if self.kind == "m.call.invite" || self.kind == "m.call.negotiate" {
            self.content["lifetime"]
                .as_u64()
                .unwrap_or(0)
                .min(KEEP_SIGNALS_MS)
        } else {
            KEEP_SIGNALS_MS
        }
    }
}

pub(super) fn call_notice(
    raw: &Raw<AnySyncTimelineEvent>,
    room: &Room,
    decrypted: bool,
) -> Option<MessageInfo> {
    let signal = Signal::parse_raw(raw, room, decrypted)?;
    let kind = match signal.kind.as_str() {
        "m.call.invite" => DirectCallSignalKind::Ring,
        "m.call.answer" => DirectCallSignalKind::Answer,
        "m.call.select_answer" if signal.content["selected_party_id"].as_str().is_some() => {
            DirectCallSignalKind::Connect
        }
        "m.call.hangup" | "m.call.reject" => DirectCallSignalKind::End,
        _ => return None,
    };
    let end_reason = if signal.kind == "m.call.reject"
        || signal.content[DECLINED_CALL].as_bool() == Some(true)
    {
        Some(DirectCallEndReason::Declined)
    } else {
        match signal.content["reason"].as_str() {
            Some("invite_timeout") => Some(DirectCallEndReason::Missed),
            Some("ice_timeout") => Some(DirectCallEndReason::Dropped),
            Some("ice_failed" | "user_media_failed" | "unknown_error" | "user_busy") => {
                Some(DirectCallEndReason::Failed)
            }
            Some("user_hangup") | None
                if signal.kind == "m.call.hangup"
                    && signal.content["version"].as_u64() == Some(0) =>
            {
                Some(DirectCallEndReason::LegacyHangup)
            }
            _ => None,
        }
    };
    Some(MessageInfo {
        direct_call_notice: Some(DirectCallNotice {
            call_id: signal.notification_id,
            kind,
            details: DirectCallNoticeDetails {
                invitee: signal.content["invitee"]
                    .as_str()
                    .and_then(|id| UserId::parse(id).ok())
                    .map(|id| id.to_string()),
                expires_at: (kind == DirectCallSignalKind::Ring).then_some(signal.expires_at),
                end_reason: if kind == DirectCallSignalKind::End {
                    end_reason
                } else {
                    None
                },
                duration_ms: signal.content[CALL_DURATION].as_u64().filter(|duration| {
                    kind == DirectCallSignalKind::End && *duration <= JS_MAX_SAFE_INTEGER
                }),
                party_id: signal.content["party_id"].as_str().map(str::to_owned),
                selected_party_id: signal.content["selected_party_id"]
                    .as_str()
                    .map(str::to_owned),
            },
        }),
        event_id: signal.event_id,
        sender: signal.sender,
        timestamp: signal.timestamp,
        ..Default::default()
    })
}

pub(super) fn call_notice_id(raw: &TimelineEvent, room: &Room) -> Option<String> {
    let signal = Signal::parse(raw, room)?;
    Some(signal.notification_id)
}

fn notification_id(room_id: &str, call_id: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("matrix-voip\0{room_id}\0{call_id}").as_bytes(),
    )
    .to_string()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 255 && id.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(super) async fn call_peer(room: &Room) -> Option<matrix_sdk::ruma::OwnedUserId> {
    if room.state() != RoomState::Joined
        || room.is_space()
        || room.is_tombstoned()
        || room.active_members_count() > 2
    {
        return None;
    }
    let members = room.members_no_sync(RoomMemberships::JOIN).await.ok()?;
    if members.len() != 2 {
        return None;
    }
    members
        .iter()
        .find(|member| member.user_id() != room.own_user_id())
        .map(|member| member.user_id().to_owned())
}

pub(super) fn callable_room(room: &Room) -> bool {
    room.state() == RoomState::Joined && !room.is_space() && !room.is_tombstoned()
}

pub(super) async fn joined_peer(room: &Room, peer: &UserId) -> bool {
    if !callable_room(room) || room.own_user_id() == peer {
        return false;
    }
    let member = match room.get_member_no_sync(peer).await {
        Ok(Some(member)) => Some(member),
        Ok(None) => room.get_member(peer).await.ok().flatten(),
        Err(_) => None,
    };
    member.is_some_and(|member| *member.membership() == MembershipState::Join)
}

async fn invite_peer(room: &Room, signal: &Signal) -> Option<OwnedUserId> {
    if signal.kind != "m.call.invite" {
        return None;
    }
    let sender = UserId::parse(&signal.sender).ok()?;
    let peer = match signal.content.get("invitee") {
        Some(target) => {
            let target = UserId::parse(target.as_str()?).ok()?;
            if !signal.from_peer {
                target
            } else if target == room.own_user_id() {
                sender
            } else {
                return None;
            }
        }
        None => {
            if signal.from_peer {
                sender
            } else {
                call_peer(room).await?
            }
        }
    };
    joined_peer(room, &peer).await.then_some(peer)
}

fn settles_invite(invite: &Signal, response: &Signal) -> bool {
    if response.notification_id != invite.notification_id {
        return false;
    }
    if response.sender == invite.sender
        && response.content["party_id"] == invite.content["party_id"]
    {
        return matches!(
            response.kind.as_str(),
            "m.call.hangup" | "m.call.select_answer"
        );
    }
    !response.from_peer
        && (matches!(response.kind.as_str(), "m.call.answer" | "m.call.reject")
            || (response.kind == "m.call.hangup"
                && response.content["version"].as_u64() == Some(0)))
}

#[cfg(target_os = "android")]
pub(crate) async fn call_push_event(
    room: &Room,
    event: &TimelineEvent,
    before: &[TimelineEvent],
    after: &[TimelineEvent],
) -> Option<Value> {
    let kind = event.raw().get_field::<&str>("type").ok().flatten()?;
    if !VOIP_EVENTS.contains(&kind) {
        return None;
    }
    let ignored = json!({ "kind": "ignore" });
    let Some(signal) = Signal::parse(event, room) else {
        return Some(ignored);
    };
    let mut peer = None;
    for invite in std::iter::once(signal.clone()).chain(
        before
            .iter()
            .chain(after)
            .filter_map(|e| Signal::parse(e, room)),
    ) {
        if invite.notification_id == signal.notification_id && invite.kind == "m.call.invite" {
            peer = invite_peer(room, &invite).await;
            break;
        }
    }
    let Some(peer) = peer else {
        return Some(ignored);
    };
    if room.client().is_user_ignored(&peer).await {
        return Some(ignored);
    }
    if signal.sender != peer.as_str() && signal.sender != room.own_user_id().as_str() {
        return Some(ignored);
    }
    let mut kind = "ignore";
    if signal.kind == "m.call.invite" && signal.from_peer {
        let settled = before
            .iter()
            .chain(after)
            .filter_map(|event| Signal::parse(event, room))
            .any(|event| settles_invite(&signal, &event));
        if signal.expires_at > now_ms() && !settled {
            kind = "ring";
        }
    } else if signal.kind == "m.call.hangup"
        || (!signal.from_peer && matches!(signal.kind.as_str(), "m.call.answer" | "m.call.reject"))
        || (signal.from_peer
            && signal.kind == "m.call.select_answer"
            && signal.content["selected_party_id"].as_str() != Some(&signal.local_party))
    {
        kind = "ended";
    }
    if kind == "ignore"
        || (kind == "ring"
            && !call_policy::pushed_call_can_ring(room, &peer, CallKind::Member).await)
    {
        return Some(ignored);
    }
    let caller = room
        .get_member_no_sync(&peer)
        .await
        .ok()
        .flatten()
        .and_then(|member| member.display_name().map(str::to_owned))
        .unwrap_or_else(|| peer.to_string());
    Some(json!({
        "kind": kind, "callId": signal.notification_id, "roomId": room.room_id(),
        "caller": caller, "expiresAt": signal.expires_at,
        "matrixVoip": true, "video": signal.video,
    }))
}

#[cfg(target_os = "android")]
pub(crate) async fn decline_pushed_call(room: &Room, call_id: &str, ring_event_id: &str) -> bool {
    let Ok(id) = matrix_sdk::ruma::EventId::parse(ring_event_id) else {
        return false;
    };
    let Ok(event) = room.event(&id, None).await else {
        return false;
    };
    let Some(invite) = Signal::parse(&event, room) else {
        return super::group_calls::decline_pushed_ring(room, &event, call_id).await;
    };
    let Some(peer) = invite_peer(room, &invite).await else {
        return false;
    };
    if invite.kind != "m.call.invite"
        || invite.sender != peer.as_str()
        || !invite.from_peer
        || invite.notification_id != call_id
        || invite.expires_at <= now_ms()
    {
        return false;
    }
    let wire_id = &invite.content["call_id"];
    if invite.content["version"].as_u64() == Some(0) {
        return room
            .send_raw(
                "m.call.hangup",
                json!({
                    "call_id": wire_id, "version": 0, "reason": "user_hangup", DECLINED_CALL: true,
                }),
            )
            .await
            .is_ok();
    }
    room.send_raw(
        "m.call.reject",
        json!({
            "call_id": wire_id, "version": "1", "party_id": invite.local_party,
        }),
    )
    .await
    .is_ok()
}

pub(super) async fn receive_signals(
    state: &AppState,
    client: &Client,
    app: &AppHandle,
    response: &SyncResponse,
) {
    close_if_participant_left(state, client, app, response).await;
    let now = now_ms();
    let mut incoming = Vec::new();
    for (room_id, update) in &response.rooms.joined {
        let Some(room) = client.get_room(room_id) else {
            continue;
        };
        let signals: Vec<_> = update
            .timeline
            .events
            .iter()
            .filter_map(|event| Signal::parse(event, &room))
            .collect();
        if signals.is_empty() {
            continue;
        }
        if !callable_room(&room) {
            continue;
        }
        let ignored = state.ignored_users.users(client).await;
        let mut suppressed_calls = Vec::new();
        for (index, signal) in signals.iter().enumerate() {
            let mut silent = false;
            let peer = if signal.kind == "m.call.invite" {
                if signal.from_peer
                    && signal.content["invitee"]
                        .as_str()
                        .is_some_and(|id| id != room.own_user_id().as_str())
                {
                    suppressed_calls.push(signal.notification_id.clone());
                    continue;
                }
                let Some(peer) = invite_peer(&room, signal).await else {
                    continue;
                };
                if signal.from_peer && signal.expires_at > now {
                    let mode =
                        call_policy::incoming_mode(state, &room, &peer, CallKind::Member).await;
                    silent = mode == CallMode::Silent;
                    if mode == CallMode::Block {
                        suppressed_calls.push(signal.notification_id.clone());
                        continue;
                    }
                }
                if signal.expires_at > now {
                    state
                        .matrix_voip
                        .remember_participant(&signal.notification_id, &peer)
                        .await;
                }
                Some(peer)
            } else {
                state
                    .matrix_voip
                    .participants
                    .lock()
                    .await
                    .iter()
                    .find(|(id, _)| id == &signal.notification_id)
                    .map(|(_, peer)| peer.clone())
            };
            let Some(peer) = peer else {
                continue;
            };
            if ignored.contains(&peer) {
                continue;
            }
            if signal.from_peer && signal.sender != peer.as_str() {
                continue;
            }
            if signal.from_peer && signal.content[LIVEKIT_SUPPORT].as_bool() == Some(true) {
                state
                    .matrix_voip
                    .remember_livekit_peer(room_id, &peer)
                    .await;
            }
            let handled_here = signal.handled_here();
            if handled_here
                || (signal.from_peer
                    && signal.kind != "m.call.candidates"
                    && signal.kind != "m.call.negotiate"
                    && signal.kind != "m.call.sdp_stream_metadata_changed")
            {
                state
                    .unread_projection
                    .note_call_event(room_id, &signal.notification_id, handled_here)
                    .await;
            }
            if signal.expires_at <= now {
                continue;
            }
            #[cfg(target_os = "ios")]
            if signal.kind == "m.call.hangup"
                || (!signal.from_peer
                    && signal.content["party_id"].as_str() != Some(&signal.local_party)
                    && matches!(signal.kind.as_str(), "m.call.answer" | "m.call.reject"))
                || (signal.from_peer
                    && signal.kind == "m.call.select_answer"
                    && signal.content["selected_party_id"].as_str() != Some(&signal.local_party))
            {
                crate::call_notifications::close_ios_ringing_call(&signal.notification_id);
            }
            if signal.kind == "m.call.invite"
                && (!signal.from_peer
                    || signals[index + 1..]
                        .iter()
                        .any(|response| settles_invite(signal, response)))
            {
                continue;
            }
            if signal.from_peer {
                log::info!("Matrix call received {}", signal.kind);
            }
            let mut signal = signal.clone();
            signal.silent = silent;
            incoming.push(signal);
        }
        if !suppressed_calls.is_empty() {
            // A homeserver can count an invite even when this device suppresses it.
            state
                .unread_projection
                .acknowledge_calls(&room, &suppressed_calls)
                .await;
        }
    }
    if incoming.is_empty() {
        return;
    }
    let mut inbox = state.matrix_voip.inbox.lock().await;
    inbox.retain(|signal| signal.expires_at > now);
    inbox.extend(incoming);
    let excess = inbox.len().saturating_sub(MAX_SIGNALS);
    inbox.drain(..excess);
    drop(inbox);
    let _ = app.emit("matrix-voip-signals", ());
}

async fn close_if_participant_left(
    state: &AppState,
    client: &Client,
    app: &AppHandle,
    response: &SyncResponse,
) {
    let current = state.matrix_voip.media.lock().await;
    let Some(media) = current.as_ref() else {
        return;
    };
    let Ok(room_id) = RoomId::parse(&media.room_id) else {
        return;
    };
    let id = media.id.clone();
    let peer = media.peer.clone();
    drop(current);
    if !response.rooms.left.contains_key(&room_id) {
        if !response.rooms.joined.contains_key(&room_id) {
            return;
        }
        if let Some(room) = client.get_room(&room_id) {
            if callable_room(&room)
                && room
                    .get_member_no_sync(&peer)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|m| *m.membership() == MembershipState::Join)
            {
                return;
            }
        }
    }
    let mut current = state.matrix_voip.media.lock().await;
    if current.as_ref().is_some_and(|media| media.id == id) {
        current.take();
        let _ = app.emit(
            "matrix-voip-status",
            json!({ "callId": id, "status": "left" }),
        );
    }
}

#[tauri::command]
pub(crate) async fn take_matrix_voip_signals(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Signal>, String> {
    let now = now_ms();
    Ok(state
        .matrix_voip
        .inbox
        .lock()
        .await
        .drain(..)
        .filter(|signal| signal.expires_at > now)
        .collect())
}

#[tauri::command]
pub(crate) async fn prefer_livekit_call(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    peer_user_id: String,
) -> Result<bool, String> {
    if !state
        .matrix_voip
        .livekit_peers
        .lock()
        .await
        .contains(&(room_id.clone(), peer_user_id.clone()))
    {
        return Ok(false);
    }
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    if super::direct_calls::direct_call_peer(&room)
        .await
        .as_deref()
        .map(UserId::as_str)
        != Some(peer_user_id.as_str())
    {
        return Ok(false);
    }
    let levels = room.power_levels().await.map_err(|e| e.to_string())?;
    let peer = UserId::parse(&peer_user_id).map_err(|e| e.to_string())?;
    if [room.own_user_id(), &peer].into_iter().any(|id| {
        !levels.user_can_send_message(id, LIVEKIT_SUPPORT.into())
            || !levels.user_can_send_state(id, call_policy::RTC_MEMBER.into())
    }) {
        return Ok(false);
    }
    Ok(tokio::time::timeout(
        Duration::from_secs(4),
        super::voice_matrix::probe_livekit_call(&room, &state.http_client),
    )
    .await
    .unwrap_or(false))
}

#[tauri::command]
pub(crate) async fn send_matrix_voip_signal(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    call_id: String,
    peer_user_id: OwnedUserId,
    version: u8,
    kind: String,
    mut content: Value,
) -> Result<(), String> {
    if !VOIP_EVENTS.contains(&kind.as_str()) || !valid_id(&call_id) || version > 1 {
        return Err("Invalid Matrix call signal.".into());
    }
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    let data = content
        .as_object_mut()
        .ok_or("Invalid Matrix call content.")?;
    let declined = kind == "m.call.reject"
        || (kind == "m.call.hangup"
            && data.get(DECLINED_CALL).and_then(Value::as_bool) == Some(true));
    if declined {
        let id = notification_id(room.room_id().as_str(), &call_id);
        super::unread::acknowledge_calls(&state, &app, &room, &[id]).await;
    }
    if kind == "m.call.invite" {
        call_policy::require_start(&room, CallKind::Member, Some(&peer_user_id)).await?;
        state
            .matrix_voip
            .remember_participant(&notification_id(&room_id, &call_id), &peer_user_id)
            .await;
        data.insert("invitee".into(), json!(peer_user_id));
    }
    if matches!(kind.as_str(), "m.call.invite" | "m.call.answer") {
        data.insert(LIVEKIT_SUPPORT.into(), json!(true));
    }
    if version > 0
        && !data.contains_key("sdp_stream_metadata")
        && matches!(
            kind.as_str(),
            "m.call.invite" | "m.call.answer" | "m.call.negotiate"
        )
    {
        data.insert(
            "sdp_stream_metadata".into(),
            json!({
                "pax-audio": { "purpose": "m.usermedia" },
            }),
        );
    }
    data.insert("call_id".into(), json!(call_id));
    data.insert(
        "version".into(),
        if version == 0 { json!(0) } else { json!("1") },
    );
    if version > 0 {
        data.insert(
            "party_id".into(),
            json!(client.device_id().ok_or("No device ID")?),
        );
    }
    tokio::time::timeout(Duration::from_secs(12), async {
        room.send_raw(&kind, content).await
    })
    .await
    .map_err(|_| "Sending the Matrix call signal timed out.".to_string())?
    .map_err(|error| format!("Could not send Matrix call signal: {error}"))?;
    log::info!("Matrix call sent {kind}");
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_matrix_voip_media(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    call_id: String,
    peer_user_id: OwnedUserId,
    offer: Option<Description>,
    video: Option<bool>,
) -> Result<Description, String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    if offer.is_none() {
        call_policy::require_start(&room, CallKind::Member, Some(&peer_user_id)).await?;
    } else if !joined_peer(&room, &peer_user_id).await
        || client.is_user_ignored(&peer_user_id).await
    {
        return Err("Both participants must join before calling.".into());
    }
    let mut current = state.matrix_voip.media.lock().await;
    if current.is_some() {
        return Err("A Matrix call is already using audio.".into());
    }
    let ice_servers = match tokio::time::timeout(
        Duration::from_secs(4),
        client.send(get_turn_server_info::v3::Request::new()),
    )
    .await
    {
        Ok(Ok(turn)) if !turn.uris.is_empty() => {
            log::info!("Matrix call received {} ICE server URLs", turn.uris.len());
            vec![libwebrtc::peer_connection_factory::IceServer {
                urls: turn.uris,
                username: turn.username,
                password: turn.password,
            }]
        }
        Ok(Ok(_)) => {
            log::info!("Matrix homeserver did not provide any ICE servers");
            vec![]
        }
        Ok(Err(_)) => {
            log::warn!("Matrix homeserver ICE server request failed");
            vec![]
        }
        Err(_) => {
            log::warn!("Matrix homeserver ICE server request timed out");
            vec![]
        }
    };
    let mut media = PeerMedia::open(&app, call_id, room_id, peer_user_id, ice_servers)?;
    let local = media.setup(offer, video.unwrap_or(false)).await?;
    *current = Some(media);
    Ok(local)
}

#[tauri::command]
pub(crate) async fn update_matrix_voip_media(
    state: State<'_, Arc<AppState>>,
    call_id: String,
    description: Option<Description>,
    candidates: Option<Vec<Candidate>>,
    start_audio: Option<bool>,
    renegotiate: Option<bool>,
    polite: Option<bool>,
    input_device_id: Option<String>,
    output_device_id: Option<String>,
) -> Result<Option<Description>, String> {
    let mut current = state.matrix_voip.media.lock().await;
    let media = current
        .as_mut()
        .filter(|media| media.id == call_id)
        .ok_or("The call ended.")?;
    let mut answer = None;
    if let Some(description) = description {
        if renegotiate.unwrap_or(false) {
            answer = media
                .renegotiate(&description, polite.unwrap_or(false))
                .await?;
        } else {
            media.remote_description(&description).await?;
        }
    }
    if let Some(candidates) = candidates {
        media.add_candidates(candidates).await;
    }
    if start_audio.unwrap_or(false) {
        media.start_audio(input_device_id.as_deref(), output_device_id.as_deref())?;
    }
    Ok(answer)
}

#[tauri::command]
pub(crate) async fn start_matrix_voip_camera(
    state: State<'_, Arc<AppState>>,
    call_id: String,
    camera_id: String,
    width: u32,
    height: u32,
    jpeg: String,
) -> Result<Option<Description>, String> {
    let mut slot = state.matrix_voip.media.lock().await;
    let media = slot
        .as_mut()
        .filter(|m| m.id == call_id)
        .ok_or("The call ended")?;
    media
        .start_camera(CameraCapture::open(camera_id, width, height, &jpeg)?)
        .await
}

#[tauri::command]
pub(crate) async fn matrix_voip_camera_frame(
    state: State<'_, Arc<AppState>>,
    call_id: String,
    camera_id: String,
    jpeg: String,
) -> Result<(), String> {
    let slot = state.matrix_voip.media.lock().await;
    slot.as_ref()
        .filter(|m| m.id == call_id)
        .ok_or("The call ended")?
        .camera_frame(&camera_id, &jpeg)
}

#[tauri::command]
pub(crate) async fn stop_matrix_voip_camera(
    state: State<'_, Arc<AppState>>,
    call_id: String,
    camera_id: String,
) -> Result<(), String> {
    let mut slot = state.matrix_voip.media.lock().await;
    if let Some(media) = slot.as_mut().filter(|m| m.id == call_id) {
        media.stop_camera(&camera_id).await?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerVideoState {
    remote_video: Vec<CallVideo>,
    camera_negotiated: bool,
}

#[tauri::command]
pub(crate) async fn sync_matrix_voip_video(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    call_id: String,
    metadata: Value,
) -> Result<PeerVideoState, String> {
    let mut slot = state.matrix_voip.media.lock().await;
    let media = slot
        .as_mut()
        .filter(|m| m.id == call_id)
        .ok_or("The call ended")?;
    Ok(PeerVideoState {
        remote_video: media.sync_video(&app, &metadata),
        camera_negotiated: media.camera_negotiated(),
    })
}

#[tauri::command]
pub(crate) async fn toggle_matrix_voip_mic(
    state: State<'_, Arc<AppState>>,
    call_id: String,
) -> Result<bool, String> {
    state
        .matrix_voip
        .media
        .lock()
        .await
        .as_ref()
        .filter(|media| media.id == call_id)
        .map(PeerMedia::toggle_mic)
        .ok_or_else(|| "The call ended.".into())
}

#[tauri::command]
pub(crate) async fn close_matrix_voip_media(
    state: State<'_, Arc<AppState>>,
    call_id: String,
) -> Result<(), String> {
    let mut current = state.matrix_voip.media.lock().await;
    if current.as_ref().is_some_and(|media| media.id == call_id) {
        current.take();
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    #[test]
    fn video_invites_distinguish_cameras_from_audio_and_screen_shares() {
        let invite = |section: &str| json!({
            "offer": { "sdp": format!("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n{section}") },
            "sdp_stream_metadata": { "desktop": { "purpose": "m.screenshare" } }
        });
        let video = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
        assert!(offers_camera(&invite(&format!("{video}a=sendrecv\r\na=msid:user camera\r\n"))));
        assert!(offers_camera(&invite("m=video 0 UDP/TLS/RTP/SAVPF 96\r\na=bundle-only\r\n")));
        for section in ["", "m=video 0 UDP/TLS/RTP/SAVPF 96\r\n"] {
            assert!(!offers_camera(&invite(section)));
        }
        for attribute in ["a=recvonly", "a=inactive", "a=content:slides", "a=msid:desktop screen"] {
            assert!(!offers_camera(&invite(&format!("{video}{attribute}\r\n"))));
        }
    }

    pub(crate) async fn shared_room() -> (
        super::super::pax_auth::tests::TestDir,
        super::super::pax_auth::tests::Server,
        Room,
    ) {
        use crate::commands::{
            auth::SavedSession,
            pax_auth::tests::{client, Server, TestDir, USER},
            room_listing::tests::joined_room,
        };
        let bob = "@bob:example.org";
        let id = "!shared:example.org";
        let mut joined = joined_room(&[
            (USER, "Alice"),
            (bob, "Bob"),
            ("@carol:example.org", "Carol"),
        ]);
        let membership = json!({
            "type":"org.matrix.msc3401.call.member", "state_key":format!("_{bob}_PHONE_m.call"), "sender":bob,
            "event_id":"$rtc", "origin_server_ts":now_ms(), "content":{"application":"m.call", "call_id":"",
                "device_id":"PHONE","expires":60000,"scope":"m.room"}
        });
        joined["state"]["events"]
            .as_array_mut()
            .unwrap()
            .push(membership);
        let server = Server::start().await;
        server.state.lock().unwrap().route_overrides.insert(
            ("GET".into(), "/_matrix/client/v3/sync".into()),
            (200, json!({"next_batch":"s1","rooms":{"join":{id:joined}}})),
        );
        let dir = TestDir::new();
        let client = client(
            &server.home,
            &dir.0.join("store"),
            SavedSession {
                user_id: USER.into(),
                device_id: "TEST".into(),
                access_token: "token".into(),
                refresh_token: None,
            },
        )
        .await;
        let room = client.get_room(&RoomId::parse(id).unwrap()).unwrap();
        (dir, server, room)
    }

    #[tokio::test]
    async fn member_call_routes_only_between_the_two_named_room_members() {
        use crate::commands::pax_auth::tests::USER;
        let (_dir, _server, room) = shared_room().await;
        let bob = "@bob:example.org";
        let carol = "@carol:example.org";
        let invite = |sender, target| {
            let raw = Raw::from_json_string(json!({
                "type":"m.call.invite", "event_id":"$ring", "sender":sender, "origin_server_ts":now_ms(),
                "content":{"call_id":"private", "invitee":target, "party_id":"phone","version":"1","lifetime":30000}
            }).to_string()).unwrap();
            Signal::parse_raw(&raw, &room, false).unwrap()
        };
        assert_eq!(
            invite_peer(&room, &invite(bob, USER))
                .await
                .unwrap()
                .as_str(),
            bob
        );
        assert_eq!(
            invite_peer(&room, &invite(USER, carol))
                .await
                .unwrap()
                .as_str(),
            carol
        );
        assert!(invite_peer(&room, &invite(bob, carol)).await.is_none());
        assert!(invite_peer(&room, &invite(USER, USER)).await.is_none());
        assert!(super::super::direct_calls::direct_call_peer(&room)
            .await
            .is_none());
    }

    #[test]
    fn a_decline_acknowledges_the_call_only_for_the_user_who_declined() {
        let mut signal: Signal = serde_json::from_value(json!({
            "type": "m.call.reject", "event_id": "$rejected", "sender": "@me:example.org",
            "origin_server_ts": 1000, "content": {"call_id": "call", "version": "1", "party_id": "CALLEE"},
        })).unwrap();
        assert!(signal.handled_here());
        signal.from_peer = true;
        assert!(!signal.handled_here());

        signal.kind = "m.call.hangup".into();
        signal.from_peer = false;
        signal.content["version"] = json!(0);
        assert!(!signal.handled_here());
        signal.content[DECLINED_CALL] = json!(true);
        assert!(signal.handled_here());
    }
}

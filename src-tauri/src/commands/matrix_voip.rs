use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};

use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    ruma::{
        api::client::voip::get_turn_server_info,
        events::{room::join_rules::JoinRule, AnySyncTimelineEvent},
        serde::Raw,
        RoomId, UserId,
    },
    sync::SyncResponse,
    Client, Room, RoomMemberships, RoomState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::{
    types::{DirectCallNotice, DirectCallSignalKind, MessageInfo},
    voice::peer::{Candidate, Description, PeerMedia},
    voice_presence::now_ms,
    AppState,
};

const KEEP_SIGNALS_MS: u64 = 150_000;
const MAX_SIGNALS: usize = 256;
const LIVEKIT_SUPPORT: &str = "com.carter.pax.direct_call";
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
    livekit_peers: Mutex<HashSet<(String, String)>>,
}

impl MatrixVoip {
    pub async fn reset(&self) {
        self.media.lock().await.take();
        self.inbox.lock().await.clear();
        self.livekit_peers.lock().await.clear();
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
    from_peer: bool,
    #[serde(skip_deserializing)]
    local_party: String,
    #[serde(skip_deserializing)]
    notification_id: String,
    #[serde(skip_deserializing)]
    expires_at: u64,
}

impl Signal {
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
        "m.call.hangup" | "m.call.reject" => DirectCallSignalKind::End,
        _ => return None,
    };
    Some(MessageInfo {
        direct_call_notice: Some(DirectCallNotice {
            call_id: signal.notification_id,
            kind,
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

fn can_ring(room: &Room, signal: &Signal) -> bool {
    !matches!(room.join_rule(), Some(JoinRule::Public))
        && signal.content["invitee"]
            .as_str()
            .is_none_or(|id| id == room.own_user_id().as_str())
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
    let Some(peer) = call_peer(room).await else {
        return Some(ignored);
    };
    if room.client().is_user_ignored(&peer).await {
        return Some(ignored);
    }
    if signal.sender != peer.as_str() && signal.sender != room.own_user_id().as_str() {
        return Some(ignored);
    }
    let mut kind = "ignore";
    if signal.kind == "m.call.invite" && signal.from_peer && can_ring(room, &signal) {
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
    if kind == "ignore" {
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
        "matrixVoip": true,
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
        return false;
    };
    let Some(peer) = call_peer(room).await else {
        return false;
    };
    if invite.kind != "m.call.invite"
        || invite.sender != peer.as_str()
        || !can_ring(room, &invite)
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
                    "call_id": wire_id, "version": 0, "reason": "user_hangup",
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
        let Some(peer) = call_peer(&room).await else {
            continue;
        };
        if state.ignored_users.users(client).await.contains(&peer) {
            continue;
        }
        for (index, signal) in signals.iter().enumerate() {
            if signal.from_peer && signal.sender != peer.as_str() {
                continue;
            }
            if signal.from_peer && signal.content[LIVEKIT_SUPPORT].as_bool() == Some(true) {
                state
                    .matrix_voip
                    .remember_livekit_peer(room_id, &peer)
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
                    || !can_ring(&room, signal)
                    || signals[index + 1..]
                        .iter()
                        .any(|response| settles_invite(signal, response)))
            {
                continue;
            }
            if signal.kind != "m.call.candidates" && signal.kind != "m.call.negotiate" {
                state
                    .unread_projection
                    .note_call_event(
                        room_id,
                        &signal.notification_id,
                        !signal.from_peer && signal.kind == "m.call.answer",
                    )
                    .await;
            }
            incoming.push(signal.clone());
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
    drop(current);
    if !response.rooms.left.contains_key(&room_id) {
        if !response.rooms.joined.contains_key(&room_id) {
            return;
        }
        if let Some(room) = client.get_room(&room_id) {
            if call_peer(&room).await.is_some() {
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
        .contains(&(room_id.clone(), peer_user_id))
    {
        return Ok(false);
    }
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
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
    room_id: String,
    call_id: String,
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
    if kind == "m.call.invite" {
        let peer = call_peer(&room)
            .await
            .ok_or("Both participants must join before calling.")?;
        data.insert("invitee".into(), json!(peer));
    }
    if matches!(kind.as_str(), "m.call.invite" | "m.call.answer") {
        data.insert(LIVEKIT_SUPPORT.into(), json!(true));
    }
    if version > 0
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
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_matrix_voip_media(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    call_id: String,
    offer: Option<Description>,
) -> Result<Description, String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    if call_peer(&room).await.is_none() {
        return Err("Both participants must join before calling.".into());
    }
    let mut current = state.matrix_voip.media.lock().await;
    if current.is_some() {
        return Err("A Matrix call is already using audio.".into());
    }
    let turn = tokio::time::timeout(
        Duration::from_secs(4),
        client.send(get_turn_server_info::v3::Request::new()),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let ice_servers = turn
        .filter(|turn| !turn.uris.is_empty())
        .map(|turn| libwebrtc::peer_connection_factory::IceServer {
            urls: turn.uris,
            username: turn.username,
            password: turn.password,
        })
        .into_iter()
        .collect();
    let media = PeerMedia::open(&app, call_id, room_id, ice_servers)?;
    let local = media.setup(offer).await?;
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
            answer = media.renegotiate(&description).await?;
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

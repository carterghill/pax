#![recursion_limit = "256"]

use std::sync::Arc;
use std::collections::HashMap;
use tauri::State;
use tauri::Emitter;
use tokio::sync::Mutex;
use matrix_sdk::{Client, Room, config::SyncSettings, media::MediaFormat};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::UInt;
use serde::Serialize;
use data_encoding::BASE64;

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub presence_map: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomInfo {
    id: String,
    name: String,
    avatar_url: Option<String>,
    is_space: bool,
    parent_space_ids: Vec<String>,
    room_type: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageInfo {
    event_id: String,
    sender: String,
    sender_name: Option<String>,
    body: String,
    timestamp: u64,
    avatar_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageBatch {
    messages: Vec<MessageInfo>,
    prev_batch: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomMemberInfo {
    user_id: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    presence: String, // "online", "offline", "unavailable"
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresencePayload {
    user_id: String,
    presence: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomMessagePayload {
    room_id: String,
    message: MessageInfo,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TypingPayload {
    room_id: String,
    user_ids: Vec<String>,
    display_names: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceParticipant {
    user_id: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
}

#[tauri::command]
async fn login(
    state: State<'_, Arc<AppState>>,
    homeserver: String,
    username: String,
    password: String,
) -> Result<String, String> {
    let client = Client::builder()
        .homeserver_url(&homeserver)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {e}"))?;

    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Pax")
        .send()
        .await
        .map_err(|e| format!("Login failed: {e}"))?;

    client
        .sync_once(SyncSettings::default().set_presence(matrix_sdk::ruma::presence::PresenceState::Offline))
        .await
        .map_err(|e| format!("Initial sync failed: {e}"))?;

    let user_id = client
        .user_id()
        .ok_or("No user ID after login")?
        .to_string();

    *state.client.lock().await = Some(client);
    Ok(user_id)
}

#[tauri::command]
async fn get_rooms(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RoomInfo>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let all_rooms = client.joined_rooms();

    // First pass: collect space IDs and their children via m.space.child state events
    let mut space_children: HashMap<String, Vec<String>> = HashMap::new();

    for room in &all_rooms {
        if room.is_space() {
            let mut children = Vec::new();
            if let Ok(events) = room.get_state_events(StateEventType::SpaceChild).await {
                for event in events {
                    if let Ok(raw) = event.deserialize() {
                        match raw {
                            matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Sync(e) => {
                                children.push(e.state_key().to_string());
                            }
                            matrix_sdk::deserialized_responses::AnySyncOrStrippedState::Stripped(e) => {
                                children.push(e.state_key().to_string());
                            }
                        }
                    }
                }
            }
            space_children.insert(room.room_id().to_string(), children);
        }
    }

    // Second pass: build room list with parent space info
    let mut room_list = Vec::new();

    for room in &all_rooms {
        let avatar_url = match room.avatar(MediaFormat::File).await {
            Ok(Some(bytes)) => {
                let b64 = BASE64.encode(&bytes);
                Some(format!("data:image/png;base64,{}", b64))
            }
            _ => None,
        };

        let room_id_str = room.room_id().to_string();

        // Find which spaces contain this room
        let parent_space_ids: Vec<String> = space_children
            .iter()
            .filter(|(_, children)| children.contains(&room_id_str))
            .map(|(space_id, _)| space_id.clone())
            .collect();

        let room_type_str = room.room_type().map(|rt| rt.to_string());

        room_list.push(RoomInfo {
            id: room_id_str,
            name: room.name().unwrap_or_else(|| "Unnamed".to_string()),
            avatar_url,
            is_space: room.is_space(),
            parent_space_ids,
            room_type: room_type_str,
        });
    }

    Ok(room_list)
}

#[tauri::command]
async fn get_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    from: Option<String>,
    limit: u32,
) -> Result<MessageBatch, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(&room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found")?;

    let mut options = MessagesOptions::backward();
    if let Some(token) = &from {
        options.from = Some(token.to_string());
    }
    options.limit = UInt::from(limit);

    let response = room
        .messages(options)
        .await
        .map_err(|e| format!("Failed to fetch messages: {e}"))?;

    let mut messages = Vec::new();

    for event in response.chunk {
        let raw = match event.raw().deserialize() {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Only handle regular message events
        if let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
            matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(msg),
        ) = raw
        {
            let original = match msg {
                matrix_sdk::ruma::events::SyncMessageLikeEvent::Original(o) => o,
                _ => continue,
            };

            let body = match &original.content.msgtype {
                matrix_sdk::ruma::events::room::message::MessageType::Text(text) => {
                    text.body.clone()
                }
                matrix_sdk::ruma::events::room::message::MessageType::Notice(notice) => {
                    notice.body.clone()
                }
                matrix_sdk::ruma::events::room::message::MessageType::Emote(emote) => {
                    format!("* {}", emote.body)
                }
                matrix_sdk::ruma::events::room::message::MessageType::Image(_) => {
                    "[Image]".to_string()
                }
                matrix_sdk::ruma::events::room::message::MessageType::File(_) => {
                    "[File]".to_string()
                }
                matrix_sdk::ruma::events::room::message::MessageType::Video(_) => {
                    "[Video]".to_string()
                }
                matrix_sdk::ruma::events::room::message::MessageType::Audio(_) => {
                    "[Audio]".to_string()
                }
                _ => "[Unsupported message]".to_string(),
            };

            let sender = original.sender.to_string();

            // Try to get the sender's display name and avatar
            let (sender_name, avatar_url) = match room
                .get_member_no_sync(&original.sender)
                .await
            {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = match member.avatar(MediaFormat::File).await {
                        Ok(Some(bytes)) => {
                            let b64 = BASE64.encode(&bytes);
                            Some(format!("data:image/png;base64,{}", b64))
                        }
                        _ => None,
                    };
                    (name, avatar)
                }
                _ => (None, None),
            };

            let timestamp = original.origin_server_ts.0.into();

            messages.push(MessageInfo {
                event_id: original.event_id.to_string(),
                sender,
                sender_name,
                body,
                timestamp,
                avatar_url,
            });
        }
    }

    Ok(MessageBatch {
        messages,
        prev_batch: response.end,
    })
}

#[tauri::command]
async fn get_room_members(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<RoomMemberInfo>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(&room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found")?;

    let members = room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get members: {e}"))?;

    let presence_map = state.presence_map.lock().await;

    let mut result = Vec::new();
    for member in members {
        let avatar_url = match member.avatar(MediaFormat::File).await {
            Ok(Some(bytes)) => {
                let b64 = BASE64.encode(&bytes);
                Some(format!("data:image/png;base64,{}", b64))
            }
            _ => None,
        };

        let user_id_str = member.user_id().to_string();
        let presence = presence_map
            .get(&user_id_str)
            .cloned()
            .unwrap_or_else(|| "offline".to_string());

        result.push(RoomMemberInfo {
            user_id: user_id_str,
            display_name: member.display_name().map(|n| n.to_string()),
            avatar_url,
            presence,
        });
    }

    Ok(result)
}

/// Check whether a call.member state event JSON represents an active participant.
/// Handles both MSC4143 (per-device content) and MSC3401 (memberships array) formats,
/// and filters out expired sessions.
fn is_call_member_active(json: &serde_json::Value) -> bool {
    let content = json.get("content");

    // MSC4143: active if content has "application" field (empty content = left)
    let active_new = content
        .and_then(|c| c.get("application"))
        .is_some();

    // MSC3401: active if non-empty "memberships" array
    let active_old = content
        .and_then(|c| c.get("memberships"))
        .and_then(|m| m.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false);

    if !active_new && !active_old {
        return false;
    }

    // Check expiry
    let origin_ts = json.get("origin_server_ts")
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let expires_ms = content
        .and_then(|c| c.get("expires"))
        .and_then(|e| e.as_u64())
        .unwrap_or(0);

    if origin_ts > 0 && expires_ms > 0 {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if origin_ts + expires_ms < now_ms {
            return false; // expired
        }
    }

    true
}

/// Scan a room's call.member state events and return the user IDs of active participants.
async fn collect_active_call_users(room: &Room) -> Vec<String> {
    let mut active: Vec<String> = Vec::new();

    for event_type_str in &["org.matrix.msc3401.call.member", "m.call.member"] {
        let event_type: StateEventType = event_type_str.to_string().into();
        if let Ok(events) = room.get_state_events(event_type).await {
            for event in &events {
                let json = match serde_json::to_value(event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let sender = json.get("sender")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string();

                if !sender.is_empty() && !active.contains(&sender) && is_call_member_active(&json) {
                    active.push(sender);
                }
            }
        }
    }

    active
}

/// Discover the LiveKit JWT service URL by scanning existing call.member events in the room.
async fn discover_livekit_service_url(room: &Room) -> Result<String, String> {
    for event_type_str in &["org.matrix.msc3401.call.member", "m.call.member"] {
        let event_type: StateEventType = event_type_str.to_string().into();
        if let Ok(events) = room.get_state_events(event_type).await {
            for event in &events {
                let json = match serde_json::to_value(event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Check content.foci_preferred[].livekit_service_url
                if let Some(url) = json.get("content")
                    .and_then(|c| c.get("foci_preferred"))
                    .and_then(|f| f.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|foci| foci.get("livekit_service_url"))
                    .and_then(|u| u.as_str())
                {
                    return Ok(url.to_string());
                }

                // Also check unsigned.prev_content for events where user already left
                if let Some(url) = json.get("unsigned")
                    .and_then(|u| u.get("prev_content"))
                    .and_then(|c| c.get("foci_preferred"))
                    .and_then(|f| f.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|foci| foci.get("livekit_service_url"))
                    .and_then(|u| u.as_str())
                {
                    return Ok(url.to_string());
                }
            }
        }
    }

    Err("Could not discover LiveKit service URL from room state. \
         Has anyone joined a call in this room via Element before?".to_string())
}

#[tauri::command]
async fn get_voice_participants(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<VoiceParticipant>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(&room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found")?;

    let active_user_ids = collect_active_call_users(&room).await;

    // Resolve display names and avatars for active users
    let mut participants = Vec::new();
    for user_id in &active_user_ids {
        let (display_name, avatar_url) = if let Ok(uid) = matrix_sdk::ruma::UserId::parse(user_id) {
            match room.get_member_no_sync(&uid).await {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = match member.avatar(MediaFormat::File).await {
                        Ok(Some(bytes)) => {
                            let b64 = BASE64.encode(&bytes);
                            Some(format!("data:image/png;base64,{}", b64))
                        }
                        _ => None,
                    };
                    (name, avatar)
                }
                _ => (None, None),
            }
        } else {
            (None, None)
        };

        participants.push(VoiceParticipant {
            user_id: user_id.clone(),
            display_name,
            avatar_url,
        });
    }

    Ok(participants)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceJoinResult {
    jwt: String,
    livekit_url: String,
}

#[tauri::command]
async fn join_voice_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<VoiceJoinResult, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(&room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found")?;

    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;

    // 1. Discover LiveKit service URL from existing call member events
    let livekit_service_url = discover_livekit_service_url(&room).await?;

    // 2. Build call.member state event content
    let state_key = format!("_{}_{}_{}", user_id, device_id, "m.call");
    let content = serde_json::json!({
        "application": "m.call",
        "call_id": "",
        "device_id": device_id.as_str(),
        "expires": 7200000,
        "foci_preferred": [{
            "livekit_alias": room_id,
            "livekit_service_url": &livekit_service_url,
            "type": "livekit"
        }],
        "focus_active": {
            "focus_selection": "oldest_membership",
            "type": "livekit"
        },
        "m.call.intent": "video",
        "scope": "m.room"
    });

    // 3. Send state event via Matrix CS API
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let state_url = format!("{}/_matrix/client/v3/rooms/{}/state/{}/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&room_id),
        urlencoding::encode("org.matrix.msc3401.call.member"),
        urlencoding::encode(&state_key),
    );

    let http = reqwest::Client::new();
    let resp = http.put(&state_url)
        .bearer_auth(access_token.to_string())
        .json(&content)
        .send()
        .await
        .map_err(|e| format!("Failed to send state event: {e}"))?;

    {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to send state event ({}): {}", status, body));
        }
    }

    // 4. Get OpenID token for authenticating with lk-jwt-service
    let openid_request = matrix_sdk::ruma::api::client::account::request_openid_token::v3::Request::new(
        user_id.to_owned(),
    );
    let openid = client.send(openid_request).await
        .map_err(|e| format!("Failed to get OpenID token: {e}"))?;

    // 5. Exchange OpenID token for a LiveKit JWT
    let jwt_body = serde_json::json!({
        "room": room_id,
        "openid_token": {
            "access_token": openid.access_token,
            "token_type": "Bearer",
            "matrix_server_name": user_id.server_name().to_string(),
            "expires_in": openid.expires_in.as_secs(),
        },
        "device_id": device_id.as_str(),
    });

    let jwt_url = format!("{}/sfu/get", livekit_service_url.trim_end_matches('/'));
    let jwt_resp = http.post(&jwt_url)
        .json(&jwt_body)
        .send()
        .await
        .map_err(|e| format!("Failed to call lk-jwt-service: {e}"))?;

    if !jwt_resp.status().is_success() {
        let status = jwt_resp.status();
        let body = jwt_resp.text().await.unwrap_or_default();
        return Err(format!("lk-jwt-service error ({}): {}", status, body));
    }

    let jwt_data: serde_json::Value = jwt_resp.json().await
        .map_err(|e| format!("Failed to parse lk-jwt-service response: {e}"))?;

    let jwt = jwt_data.get("jwt")
        .and_then(|j| j.as_str())
        .ok_or("No 'jwt' field in lk-jwt-service response")?
        .to_string();

    let livekit_url = jwt_data.get("url")
        .and_then(|u| u.as_str())
        .ok_or("No 'url' field in lk-jwt-service response")?
        .to_string();

    Ok(VoiceJoinResult { jwt, livekit_url })
}

#[tauri::command]
async fn leave_voice_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;

    let state_key = format!("_{}_{}_{}", user_id, device_id, "m.call");

    // Send empty content to signal leave
    let content = serde_json::json!({});

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let state_url = format!("{}/_matrix/client/v3/rooms/{}/state/{}/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&room_id),
        urlencoding::encode("org.matrix.msc3401.call.member"),
        urlencoding::encode(&state_key),
    );

    let http = reqwest::Client::new();
    let resp = http.put(&state_url)
        .bearer_auth(access_token.to_string())
        .json(&content)
        .send()
        .await
        .map_err(|e| format!("Failed to send leave event: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to send leave event ({}): {}", status, body));
    }

    Ok(())
}

#[tauri::command]
async fn send_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    body: String,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(&room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found")?;

    let content = matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(&body);

    room.send(content)
        .await
        .map_err(|e| format!("Failed to send message: {e}"))?;

    Ok(())
}

/// Helper to extract body text from a message event's content
fn extract_body(content: &matrix_sdk::ruma::events::room::message::RoomMessageEventContent) -> String {
    use matrix_sdk::ruma::events::room::message::MessageType;
    match &content.msgtype {
        MessageType::Text(text) => text.body.clone(),
        MessageType::Notice(notice) => notice.body.clone(),
        MessageType::Emote(emote) => format!("* {}", emote.body),
        MessageType::Image(_) => "[Image]".to_string(),
        MessageType::File(_) => "[File]".to_string(),
        MessageType::Video(_) => "[Video]".to_string(),
        MessageType::Audio(_) => "[Audio]".to_string(),
        _ => "[Unsupported message]".to_string(),
    }
}

#[tauri::command]
async fn start_sync(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?.clone();
    drop(guard);

    // Handler for incoming room messages
    let app_handle = app.clone();
    client.add_event_handler(move |ev: OriginalSyncRoomMessageEvent, room: Room| {
        let app = app_handle.clone();
        async move {
            let room_id = room.room_id().to_string();
            let body = extract_body(&ev.content);
            let sender = ev.sender.to_string();

            let (sender_name, avatar_url) = match room
                .get_member_no_sync(&ev.sender)
                .await
            {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = match member.avatar(MediaFormat::File).await {
                        Ok(Some(bytes)) => {
                            let b64 = BASE64.encode(&bytes);
                            Some(format!("data:image/png;base64,{}", b64))
                        }
                        _ => None,
                    };
                    (name, avatar)
                }
                _ => (None, None),
            };

            let timestamp: u64 = ev.origin_server_ts.0.into();

            let payload = RoomMessagePayload {
                room_id,
                message: MessageInfo {
                    event_id: ev.event_id.to_string(),
                    sender,
                    sender_name,
                    body,
                    timestamp,
                    avatar_url,
                },
            };
            let _ = app.emit("room-message", payload);
        }
    });

    // Handler for typing notifications
    let app_handle = app.clone();
    client.add_event_handler(move |ev: SyncTypingEvent, room: Room| {
        let app = app_handle.clone();
        async move {
            let room_id = room.room_id().to_string();

            let mut user_ids = Vec::new();
            let mut display_names = Vec::new();

            for uid in &ev.content.user_ids {
                user_ids.push(uid.to_string());
                let name = match room.get_member_no_sync(uid).await {
                    Ok(Some(member)) => member
                        .display_name()
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| uid.to_string()),
                    _ => uid.to_string(),
                };
                display_names.push(name);
            }

            let _ = app.emit("typing", TypingPayload {
                room_id,
                user_ids,
                display_names,
            });
        }
    });

    // Clone the presence map for use inside the sync loop
    let presence_map = state.presence_map.clone();

    // Spawn the continuous sync loop in the background
    // set_presence(Offline) tells the server: "do NOT auto-update my presence on sync"
    // We manage presence explicitly via the set_presence command instead.
    tokio::spawn(async move {
        let result = client
            .sync_with_callback(
                SyncSettings::default().set_presence(matrix_sdk::ruma::presence::PresenceState::Offline),
                |response| {
                let app = app.clone();
                let presence_map = presence_map.clone();
                async move {
                    // Extract presence updates from the sync response
                    for raw_event in &response.presence {
                        if let Ok(ev) = raw_event.deserialize() {
                            let presence_str = match ev.content.presence {
                                matrix_sdk::ruma::presence::PresenceState::Online => "online",
                                matrix_sdk::ruma::presence::PresenceState::Unavailable => "unavailable",
                                _ => "offline",
                            };

                            let user_id = ev.sender.to_string();

                            presence_map.lock().await.insert(
                                user_id.clone(),
                                presence_str.to_string(),
                            );

                            let _ = app.emit("presence", PresencePayload {
                                user_id,
                                presence: presence_str.to_string(),
                            });
                        }
                    }

                    let _ = app.emit("rooms-changed", ());

                    // Signal voice participant refresh on every sync.
                    // The frontend hook deduplicates unchanged data, so this is cheap.
                    let _ = app.emit("voice-participants-changed", ());

                    matrix_sdk::LoopCtrl::Continue
                }
            })
            .await;

        if let Err(e) = result {
            eprintln!("Sync loop error: {e}");
        }
    });

    Ok(())
}

#[tauri::command]
async fn send_typing_notice(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    typing: bool,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(&room_id)
        .map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found")?;

    room.typing_notice(typing)
        .await
        .map_err(|e| format!("Failed to send typing notice: {e}"))?;

    Ok(())
}

#[tauri::command]
async fn set_presence(
    state: State<'_, Arc<AppState>>,
    presence: String,
) -> Result<(), String> {
    let presence_state = match presence.as_str() {
        "online" => matrix_sdk::ruma::presence::PresenceState::Online,
        "unavailable" => matrix_sdk::ruma::presence::PresenceState::Unavailable,
        "offline" => matrix_sdk::ruma::presence::PresenceState::Offline,
        _ => return Err(format!("Invalid presence state: {presence}")),
    };

    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();

    let request = matrix_sdk::ruma::api::client::presence::set_presence::v3::Request::new(
        user_id,
        presence_state,
    );

    client.send(request).await
        .map_err(|e| format!("Failed to set presence: {e}"))?;

    Ok(())
}

#[tauri::command]
async fn start_idle_monitor(
    app: tauri::AppHandle,
) -> Result<(), String> {
    tokio::spawn(async move {
        let idle_threshold_secs = 300u64; // 5 minutes
        let mut was_idle = false;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;

            let idle_secs = match user_idle::UserIdle::get_time() {
                Ok(idle) => idle.as_seconds() as u64,
                Err(_) => continue,
            };

            let is_idle = idle_secs >= idle_threshold_secs;

            if is_idle != was_idle {
                was_idle = is_idle;
                let _ = app.emit("idle-changed", is_idle);
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        client: Mutex::new(None),
        presence_map: Arc::new(Mutex::new(HashMap::new())),
    });

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            login,
            get_rooms,
            get_messages,
            get_room_members,
            get_voice_participants,
            join_voice_room,
            leave_voice_room,
            send_message,
            start_sync,
            send_typing_notice,
            set_presence,
            start_idle_monitor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
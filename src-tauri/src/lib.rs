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

    // Clone the presence map Arc for use inside the sync loop
    let presence_map = state.presence_map.clone();

    // Spawn the continuous sync loop in the background
    tokio::spawn(async move {
        let result = client
            .sync_with_callback(SyncSettings::default().set_presence(matrix_sdk::ruma::presence::PresenceState::Offline), |response| {
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

                            // Update the shared presence map
                            presence_map.lock().await.insert(
                                user_id.clone(),
                                presence_str.to_string(),
                            );

                            // Emit to frontend for live updates
                            let _ = app.emit("presence", PresencePayload {
                                user_id,
                                presence: presence_str.to_string(),
                            });
                        }
                    }

                    let _ = app.emit("rooms-changed", ());
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
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let user_id = client.user_id().ok_or("No user ID")?.to_owned();

    let presence_state = match presence.as_str() {
        "online" => matrix_sdk::ruma::presence::PresenceState::Online,
        "unavailable" => matrix_sdk::ruma::presence::PresenceState::Unavailable,
        "offline" => matrix_sdk::ruma::presence::PresenceState::Offline,
        _ => return Err(format!("Invalid presence state: {presence}")),
    };

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
            send_message,
            start_sync,
            send_typing_notice,
            set_presence,
            start_idle_monitor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
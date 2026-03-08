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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomInfo {
    id: String,
    name: String,
    avatar_url: Option<String>,
    is_space: bool,
    parent_space_ids: Vec<String>,
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
        .sync_once(SyncSettings::default())
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

        room_list.push(RoomInfo {
            id: room_id_str,
            name: room.name().unwrap_or_else(|| "Unnamed".to_string()),
            avatar_url,
            is_space: room.is_space(),
            parent_space_ids,
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

    // Spawn the continuous sync loop in the background
    tokio::spawn(async move {
        let result = client
            .sync_with_callback(SyncSettings::default(), |_response| {
                let app = app.clone();
                async move {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        client: Mutex::new(None),
    });

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            login,
            get_rooms,
            get_messages,
            send_message,
            start_sync,
            send_typing_notice,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
use std::sync::Arc;

use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::UInt;
use matrix_sdk::Room;
use tauri::{Emitter, State};

use crate::types::{MessageBatch, MessageInfo, PresencePayload, RoomMessagePayload, TypingPayload};
use crate::AppState;

use super::get_or_fetch_member_avatar;

#[tauri::command]
pub async fn get_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    from: Option<String>,
    limit: u32,
) -> Result<MessageBatch, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;

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
    let avatar_cache = state.avatar_cache.clone();

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

            let body = extract_body(&original.content);
            let sender = original.sender.to_string();

            // Try to get the sender's display name and avatar
            let (sender_name, avatar_url) = match room.get_member_no_sync(&original.sender).await {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = get_or_fetch_member_avatar(&member, &avatar_cache).await;
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
pub async fn send_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    body: String,
) -> Result<(), String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;

    let content = matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(&body);

    room.send(content)
        .await
        .map_err(|e| format!("Failed to send message: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn start_sync(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?.clone();
    drop(guard);

    // Handler for incoming room messages
    let app_handle = app.clone();
    let avatar_cache = state.avatar_cache.clone();
    client.add_event_handler(move |ev: OriginalSyncRoomMessageEvent, room: Room| {
        let app = app_handle.clone();
        let avatar_cache = avatar_cache.clone();
        async move {
            let room_id = room.room_id().to_string();
            let body = extract_body(&ev.content);
            let sender = ev.sender.to_string();

            let (sender_name, avatar_url) = match room.get_member_no_sync(&ev.sender).await {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = get_or_fetch_member_avatar(&member, &avatar_cache).await;
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

            let _ = app.emit(
                "typing",
                TypingPayload {
                    room_id,
                    user_ids,
                    display_names,
                },
            );
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
                matrix_sdk::config::SyncSettings::default()
                    .set_presence(matrix_sdk::ruma::presence::PresenceState::Offline),
                |response| {
                    let app = app.clone();
                    let presence_map = presence_map.clone();
                    async move {
                        // Extract presence updates from the sync response
                        for raw_event in &response.presence {
                            if let Ok(ev) = raw_event.deserialize() {
                                let presence_str = match ev.content.presence {
                                    matrix_sdk::ruma::presence::PresenceState::Online => "online",
                                    matrix_sdk::ruma::presence::PresenceState::Unavailable => {
                                        "unavailable"
                                    }
                                    _ => "offline",
                                };

                                let user_id = ev.sender.to_string();

                                presence_map
                                    .lock()
                                    .await
                                    .insert(user_id.clone(), presence_str.to_string());

                                let _ = app.emit(
                                    "presence",
                                    PresencePayload {
                                        user_id,
                                        presence: presence_str.to_string(),
                                    },
                                );
                            }
                        }

                        let _ = app.emit("rooms-changed", ());

                        // Signal voice participant refresh on every sync.
                        // The frontend hook deduplicates unchanged data, so this is cheap.
                        let _ = app.emit("voice-participants-changed", ());

                        matrix_sdk::LoopCtrl::Continue
                    }
                },
            )
            .await;

        if let Err(e) = result {
            eprintln!("Sync loop error: {e}");
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn send_typing_notice(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    typing: bool,
) -> Result<(), String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;

    room.typing_notice(typing)
        .await
        .map_err(|e| format!("Failed to send typing notice: {e}"))?;

    Ok(())
}

/// Helper to extract body text from a message event's content.
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

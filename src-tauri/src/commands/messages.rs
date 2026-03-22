use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::room::MessagesOptions;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::room::redaction::OriginalSyncRoomRedactionEvent;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::UInt;
use matrix_sdk::Room;
use tauri::{Emitter, State};

use crate::types::{
    MessageBatch, MessageEditPayload, MessageInfo, MessageRedactedPayload, PresencePayload,
    RoomMessagePayload, RoomRedactionPolicy, TypingPayload, VoiceParticipantsChangedPayload,
};
use crate::AppState;

use super::{get_client, get_or_fetch_member_avatar, resolve_room};
use super::voice_matrix::collect_voice_participants_for_joined_voice_rooms;

#[tauri::command]
pub async fn get_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    from: Option<String>,
    limit: u32,
) -> Result<MessageBatch, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let mut options = MessagesOptions::backward();
    if let Some(token) = &from {
        options.from = Some(token.to_string());
    }
    options.limit = UInt::from(limit);

    let response = room
        .messages(options)
        .await
        .map_err(|e| format!("Failed to fetch messages: {e}"))?;

    let avatar_cache = state.avatar_cache.clone();

    // First pass: extract message data and collect unique senders
    struct RawMsg {
        event_id: String,
        sender: String,
        body: String,
        timestamp: u64,
    }
    let mut raw_msgs = Vec::new();
    let mut unique_senders = Vec::new();
    let mut seen_senders = std::collections::HashSet::new();
    // target event id -> (replacement body, origin_server_ts); keep latest edit per target
    let mut latest_replacement: HashMap<String, (String, u64)> = HashMap::new();

    for event in response.chunk {
        let raw = match event.raw().deserialize() {
            Ok(e) => e,
            Err(_) => continue,
        };

        if let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
            matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(msg),
        ) = raw
        {
            let original = match msg {
                matrix_sdk::ruma::events::SyncMessageLikeEvent::Original(o) => o,
                _ => continue,
            };

            if let Some(Relation::Replacement(repl)) = &original.content.relates_to {
                let target = repl.event_id.to_string();
                let new_body = extract_body(&RoomMessageEventContent::from(repl.new_content.clone()));
                let ts: u64 = original.origin_server_ts.0.into();
                let replace = match latest_replacement.get(&target) {
                    None => true,
                    Some((_, prev_ts)) => ts >= *prev_ts,
                };
                if replace {
                    latest_replacement.insert(target, (new_body, ts));
                }
                continue;
            }

            let sender_str = original.sender.to_string();
            if seen_senders.insert(sender_str.clone()) {
                unique_senders.push(original.sender.clone());
            }

            raw_msgs.push(RawMsg {
                event_id: original.event_id.to_string(),
                sender: sender_str,
                body: extract_body(&original.content),
                timestamp: original.origin_server_ts.0.into(),
            });
        }
    }

    // Second pass: resolve display name + avatar once per unique sender
    let mut sender_meta: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for uid in &unique_senders {
        let meta = match room.get_member_no_sync(uid).await {
            Ok(Some(member)) => {
                let name = member.display_name().map(|n| n.to_string());
                let avatar = get_or_fetch_member_avatar(&member, &avatar_cache).await;
                (name, avatar)
            }
            _ => (None, None),
        };
        sender_meta.insert(uid.to_string(), meta);
    }

    // Third pass: build final messages using the cached sender metadata
    let messages = raw_msgs
        .into_iter()
        .map(|m| {
            let (sender_name, avatar_url) = sender_meta
                .get(&m.sender)
                .cloned()
                .unwrap_or((None, None));
            let edited = latest_replacement.contains_key(&m.event_id);
            let body = latest_replacement
                .get(&m.event_id)
                .map(|(b, _)| b.clone())
                .unwrap_or(m.body);
            MessageInfo {
                event_id: m.event_id,
                sender: m.sender,
                sender_name,
                body,
                timestamp: m.timestamp,
                avatar_url,
                edited,
            }
        })
        .collect();

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
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let content = matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(&body);

    room.send(content)
        .await
        .map_err(|e| format!("Failed to send message: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn get_room_redaction_policy(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomRedactionPolicy, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let pl = room
        .power_levels()
        .await
        .map_err(|e| format!("Failed to read power levels: {e}"))?;

    let own = client.user_id().ok_or("Not logged in")?;

    Ok(RoomRedactionPolicy {
        can_redact_own: pl.user_can_redact_own_event(own),
        can_redact_other: pl.user_can_redact_event_of_other(own),
    })
}

#[tauri::command]
pub async fn edit_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
    body: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let event_id_parsed =
        EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    let new_content = RoomMessageEventContentWithoutRelation::text_plain(&body);

    let edit_content = room
        .make_edit_event(&event_id_parsed, EditedContent::RoomMessage(new_content))
        .await
        .map_err(|e| format!("Failed to prepare edit: {e}"))?;

    match edit_content {
        AnyMessageLikeEventContent::RoomMessage(content) => {
            room
                .send(content)
                .await
                .map_err(|e| format!("Failed to send edit: {e}"))?;
        }
        _ => return Err("Unexpected edit content type".to_string()),
    }

    Ok(())
}

#[tauri::command]
pub async fn redact_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let event_id_parsed =
        EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    room
        .redact(&event_id_parsed, None, None)
        .await
        .map_err(|e| format!("Failed to redact message: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn start_sync(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    let client = get_client(&state).await?;

    // `AppHandle::clone` bumps Tao's `Rc<EventLoopRunner>` — `Rc` is not thread-safe.
    // Matrix runs `sync_with_callback` and event handlers on tokio worker threads; cloning
    // `AppHandle` there races the refcount (UB), which surfaces as failed `Rc::inc_strong`
    // checks on Rust 1.81+. Share one handle with `Arc::clone` from background threads instead.
    let app = Arc::new(app);

    {
        let mut sync_running = state.sync_running.lock().await;
        if *sync_running {
            eprintln!("[Pax] start_sync: sync loop already running, skipping");
            return Ok(());
        }
        *sync_running = true;
    }

    // Handler for incoming room messages
    let app_handle = app.clone();
    let avatar_cache = state.avatar_cache.clone();
    client.add_event_handler(move |ev: OriginalSyncRoomMessageEvent, room: Room| {
        let app = app_handle.clone();
        let avatar_cache = avatar_cache.clone();
        async move {
            let room_id = room.room_id().to_string();

            if let Some(Relation::Replacement(repl)) = &ev.content.relates_to {
                let new_body = extract_body(&RoomMessageEventContent::from(repl.new_content.clone()));
                let payload = MessageEditPayload {
                    room_id,
                    target_event_id: repl.event_id.to_string(),
                    body: new_body,
                };
                let _ = app.emit("room-message-edit", payload);
                return;
            }

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
                    edited: false,
                },
            };
            let _ = app.emit("room-message", payload);
        }
    });

    // Redactions (e.g. deleted messages): drop the target from the client timeline
    let app_handle = app.clone();
    client.add_event_handler(move |ev: OriginalSyncRoomRedactionEvent, room: Room| {
        let app = app_handle.clone();
        async move {
            let room_id = room.room_id().to_string();
            let redacted = ev
                .content
                .redacts
                .as_ref()
                .or(ev.redacts.as_ref())
                .map(|id| id.to_string());
            let Some(redacted_event_id) = redacted else {
                return;
            };
            let payload = MessageRedactedPayload {
                room_id,
                redacted_event_id,
            };
            let _ = app.emit("room-message-redacted", payload);
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

    // Clone shared state needed inside the sync loop.
    let presence_map = state.presence_map.clone();
    let avatar_cache = state.avatar_cache.clone();
    let voice_client = client.clone();
    let sync_running = state.sync_running.clone();

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
                    let avatar_cache = avatar_cache.clone();
                    let voice_client = voice_client.clone();
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

                        // Push voice participants from a spawned task so we
                        // don't block the sync loop with avatar fetches.
                        let vc = voice_client.clone();
                        let ac = avatar_cache.clone();
                        let ap = app.clone();
                        tokio::spawn(async move {
                            let participants_by_room =
                                collect_voice_participants_for_joined_voice_rooms(&vc, &ac).await;
                            let _ = ap.emit(
                                "voice-participants-changed",
                                VoiceParticipantsChangedPayload { participants_by_room },
                            );
                        });

                        matrix_sdk::LoopCtrl::Continue
                    }
                },
            )
            .await;

        if let Err(e) = result {
            eprintln!("Sync loop error: {e}");
        }

        *sync_running.lock().await = false;
    });

    Ok(())
}

#[tauri::command]
pub async fn send_typing_notice(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    typing: bool,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

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
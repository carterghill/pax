use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::direct::DirectEventContent;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::member::OriginalSyncRoomMemberEvent;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::events::room::redaction::OriginalSyncRoomRedactionEvent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::events::GlobalAccountDataEvent;
use matrix_sdk::ruma::events::OriginalSyncStateEvent;
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings, UniqueKey};
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::UInt;
use matrix_sdk::Room;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::types::{
    MessageBatch, MessageEditPayload, MessageInfo, MessageRedactedPayload, PresencePayload,
    RoomMessagePayload, RoomRedactionPolicy, TypingPayload, VoiceParticipantsChangedPayload,
};
use crate::AppState;

use super::voice_matrix::collect_voice_participants_for_joined_voice_rooms;
use super::{fmt_error_chain, get_client, get_or_fetch_avatar, resolve_room, sniff_media_mime};

/// matrix-sdk sets **no HTTP timeout** for media downloads (`Duration::MAX` in
/// `Media::get_media_content`), so slow or stuck federation can block the UI for a very long time.
/// We wrap each fetch so the app fails fast with a clear message instead.
const MATRIX_IMAGE_THUMB_FETCH_TIMEOUT: Duration = Duration::from_secs(45);
/// Full-file downloads (GIF originals, video) can be large; federation may be slow.
const MATRIX_IMAGE_FULL_FETCH_TIMEOUT: Duration = Duration::from_secs(300);

async fn get_matrix_media_bytes_with_timeout(
    client: &matrix_sdk::Client,
    params: &MediaRequestParameters,
    use_cache: bool,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(timeout, client.media().get_media_content(params, use_cache)).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(fmt_error_chain(&e)),
        Err(_) => Err(format!(
            "timed out after {}s (media download; federation can be slow)",
            timeout.as_secs()
        )),
    }
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    from: Option<String>,
    limit: u32,
) -> Result<MessageBatch, String> {
    let short_room = if room_id.len() > 6 { &room_id[room_id.len()-6..] } else { &room_id };
    log::info!(
        "[get_messages] room=…{} from={} limit={}",
        short_room,
        from.as_deref().map(|t| if t.len() > 16 { &t[..16] } else { t }).unwrap_or("null"),
        limit,
    );
    let t0 = std::time::Instant::now();

    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let avatar_cache = state.avatar_cache.clone();
    let limit_usize = limit as usize;

    // First pass: extract message data and collect unique senders
    struct RawMsg {
        event_id: String,
        sender: String,
        body: String,
        timestamp: u64,
        image_media_request: Option<serde_json::Value>,
        video_media_request: Option<serde_json::Value>,
        file_media_request: Option<serde_json::Value>,
        file_mime: Option<String>,
        file_display_name: Option<String>,
    }
    let mut raw_msgs = Vec::new();
    let mut unique_senders = Vec::new();
    let mut seen_senders = std::collections::HashSet::new();
    // target event id -> replacement fields + origin_server_ts; keep latest edit per target
    let mut latest_replacement: HashMap<
        String,
        (
            String,
            Option<serde_json::Value>,
            Option<serde_json::Value>,
            Option<serde_json::Value>,
            Option<String>,
            Option<String>,
            u64,
        ),
    > = HashMap::new();

    let mut current_from = from.clone();
    let mut pages_scanned: usize = 0;
    let mut timeline_event_count_total: usize = 0;
    let mut prev_batch: Option<String>;

    loop {
        let mut options = MessagesOptions::backward();
        if let Some(token) = &current_from {
            options.from = Some(token.to_string());
        }
        options.limit = UInt::from(limit);

        let response = room
            .messages(options)
            .await
            .map_err(|e| format!("Failed to fetch messages: {}", fmt_error_chain(&e)))?;

        let matrix_sdk::room::Messages {
            chunk,
            end: pagination_end,
            ..
        } = response;

        pages_scanned += 1;

        // Per the `/messages` contract: fewer than `limit` timeline events means there
        // is nothing more to paginate backward. Homeservers often still set `end` in
        // that case, which would otherwise make the client request a useless page.
        let timeline_event_count = chunk.len();
        timeline_event_count_total += timeline_event_count;
        prev_batch = if timeline_event_count < limit_usize {
            None
        } else {
            pagination_end
        };

        for event in chunk {
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
                    let ext = extract_message_display(&RoomMessageEventContent::from(
                        repl.new_content.clone(),
                    ));
                    let ts: u64 = original.origin_server_ts.0.into();
                    let replace = match latest_replacement.get(&target) {
                        None => true,
                        Some((_, _, _, _, _, _, prev_ts)) => ts >= *prev_ts,
                    };
                    if replace {
                        latest_replacement.insert(
                            target,
                            (
                                ext.body.clone(),
                                ext.image_media_request.clone(),
                                ext.video_media_request.clone(),
                                ext.file_media_request.clone(),
                                ext.file_mime.clone(),
                                ext.file_display_name.clone(),
                                ts,
                            ),
                        );
                    }
                    continue;
                }

                let sender_str = original.sender.to_string();
                if seen_senders.insert(sender_str.clone()) {
                    unique_senders.push(original.sender.clone());
                }

                let ext = extract_message_display(&original.content);
                raw_msgs.push(RawMsg {
                    event_id: original.event_id.to_string(),
                    sender: sender_str,
                    body: ext.body,
                    timestamp: original.origin_server_ts.0.into(),
                    image_media_request: ext.image_media_request,
                    video_media_request: ext.video_media_request,
                    file_media_request: ext.file_media_request,
                    file_mime: ext.file_mime,
                    file_display_name: ext.file_display_name,
                });
            }
        }

        // A timeline page can contain only edits / filtered events, which makes the
        // frontend show "loaded" with no visible change. Keep paging until we surface
        // at least one actual message or we truly run out of history.
        if !raw_msgs.is_empty() || prev_batch.is_none() {
            break;
        }

        current_from = prev_batch.clone();
    }

    // Second pass: resolve display name + avatar once per unique sender
    let mut sender_meta: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for uid in &unique_senders {
        let meta = match room.get_member_no_sync(uid).await {
            Ok(Some(member)) => {
                let name = member.display_name().map(|n| n.to_string());
                let avatar = get_or_fetch_avatar(
                    member.avatar_url(),
                    member.avatar(matrix_sdk::media::MediaFormat::File),
                    &avatar_cache,
                )
                .await;
                (name, avatar)
            }
            _ => (None, None),
        };
        sender_meta.insert(uid.to_string(), meta);
    }

    // Third pass: build final messages using the cached sender metadata
    let messages: Vec<_> = raw_msgs
        .into_iter()
        .map(|m| {
            let (sender_name, avatar_url) =
                sender_meta.get(&m.sender).cloned().unwrap_or((None, None));
            let edited = latest_replacement.contains_key(&m.event_id);
            let (
                body,
                image_media_request,
                video_media_request,
                file_media_request,
                file_mime,
                file_display_name,
            ) = latest_replacement
                .get(&m.event_id)
                .map(|(b, img, vid, file, fm, fd, _)| {
                    (
                        b.clone(),
                        img.clone(),
                        vid.clone(),
                        file.clone(),
                        fm.clone(),
                        fd.clone(),
                    )
                })
                .unwrap_or_else(|| {
                    (
                        m.body.clone(),
                        m.image_media_request.clone(),
                        m.video_media_request.clone(),
                        m.file_media_request.clone(),
                        m.file_mime.clone(),
                        m.file_display_name.clone(),
                    )
                });
            MessageInfo {
                event_id: m.event_id,
                sender: m.sender,
                sender_name,
                body,
                timestamp: m.timestamp,
                avatar_url,
                edited,
                image_media_request,
                video_media_request,
                file_media_request,
                file_mime,
                file_display_name,
            }
        })
        .collect();

    let elapsed = t0.elapsed();
    let msg_count = messages.len();
    log::info!(
        "[get_messages] room=…{} DONE in {:?}: pages_scanned={} chunk_events_total={} actual_msgs={} edits={} prev_batch={} skipped_empty_pages={}",
        short_room,
        elapsed,
        pages_scanned,
        timeline_event_count_total,
        msg_count,
        latest_replacement.len(),
        prev_batch.as_deref().map(|t| if t.len() > 16 { &t[..16] } else { t }).unwrap_or("null"),
        pages_scanned.saturating_sub(1),
    );

    Ok(MessageBatch {
        messages,
        prev_batch,
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

    let content =
        matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(&body);

    room.send(content)
        .await
        .map_err(|e| format!("Failed to send message: {}", fmt_error_chain(&e)))?;

    Ok(())
}

/// Create a 1:1 DM only if one does not exist, then send the first (or next) text message.
/// Returns the room id (Element-style: room may not exist until this runs).
#[tauri::command]
pub async fn send_first_direct_message(
    state: State<'_, Arc<AppState>>,
    peer_user_id: String,
    body: String,
) -> Result<String, String> {
    let client = get_client(&state).await?;
    let me = client.user_id().ok_or("Not logged in")?;
    let peer = matrix_sdk::ruma::UserId::parse(peer_user_id.trim())
        .map_err(|e| format!("Invalid user ID: {e}"))?;
    if peer == me {
        return Err("You cannot message yourself.".to_string());
    }
    let room = if let Some(r) = client.get_dm_room(&peer) {
        r
    } else {
        client
            .create_dm(&peer)
            .await
            .map_err(|e| format!("Failed to create direct message: {}", fmt_error_chain(&e)))?
    };
    let room_id = room.room_id().to_string();
    let content =
        matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(&body);
    room.send(content)
        .await
        .map_err(|e| format!("Failed to send message: {}", fmt_error_chain(&e)))?;
    Ok(room_id)
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
        .map_err(|e| format!("Failed to read power levels: {}", fmt_error_chain(&e)))?;

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
        .map_err(|e| format!("Failed to prepare edit: {}", fmt_error_chain(&e)))?;

    match edit_content {
        AnyMessageLikeEventContent::RoomMessage(content) => {
            room.send(content)
                .await
                .map_err(|e| format!("Failed to send edit: {}", fmt_error_chain(&e)))?;
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

    room.redact(&event_id_parsed, None, None)
        .await
        .map_err(|e| format!("Failed to redact message: {}", fmt_error_chain(&e)))?;

    Ok(())
}

#[tauri::command]
pub async fn start_sync(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let client = get_client(&state).await?;

    // `AppHandle::clone` bumps Tao's `Rc<EventLoopRunner>` — `Rc` is not thread-safe.
    // Matrix runs `sync_with_callback` and event handlers on tokio worker threads; cloning
    // `AppHandle` there races the refcount (UB), which surfaces as failed `Rc::inc_strong`
    // checks on Rust 1.81+. Share one handle with `Arc::clone` from background threads instead.
    let app = Arc::new(app);

    {
        let mut sync_running = state.sync_running.lock().await;
        if *sync_running {
            log::warn!("start_sync: sync loop already running, skipping");
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
            let short_room = if room_id.len() > 6 { &room_id[room_id.len()-6..] } else { &room_id };

            if let Some(Relation::Replacement(repl)) = &ev.content.relates_to {
                log::debug!("[sync] room-message-edit room=…{} target={}", short_room, repl.event_id);
                let ext = extract_message_display(&RoomMessageEventContent::from(
                    repl.new_content.clone(),
                ));
                let image_media_request = ext
                    .image_media_request
                    .clone()
                    .unwrap_or(serde_json::Value::Null);
                let video_media_request = ext
                    .video_media_request
                    .clone()
                    .unwrap_or(serde_json::Value::Null);
                let file_media_request = ext
                    .file_media_request
                    .clone()
                    .unwrap_or(serde_json::Value::Null);
                let file_mime = ext
                    .file_mime
                    .clone()
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null);
                let file_display_name = ext
                    .file_display_name
                    .clone()
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null);
                let payload = MessageEditPayload {
                    room_id,
                    target_event_id: repl.event_id.to_string(),
                    body: ext.body,
                    image_media_request,
                    video_media_request,
                    file_media_request,
                    file_mime,
                    file_display_name,
                };
                let _ = app.emit("room-message-edit", payload);
                return;
            }

            let ext = extract_message_display(&ev.content);
            let sender = ev.sender.to_string();

            let (sender_name, avatar_url) = match room.get_member_no_sync(&ev.sender).await {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = get_or_fetch_avatar(
                        member.avatar_url(),
                        member.avatar(matrix_sdk::media::MediaFormat::File),
                        &avatar_cache,
                    )
                    .await;
                    (name, avatar)
                }
                _ => (None, None),
            };

            let timestamp: u64 = ev.origin_server_ts.0.into();

            log::debug!(
                "[sync] room-message room=…{} event={} sender={}",
                short_room,
                ev.event_id,
                sender,
            );

            let payload = RoomMessagePayload {
                room_id,
                message: MessageInfo {
                    event_id: ev.event_id.to_string(),
                    sender,
                    sender_name,
                    body: ext.body,
                    timestamp,
                    avatar_url,
                    edited: false,
                    image_media_request: ext.image_media_request,
                    video_media_request: ext.video_media_request,
                    file_media_request: ext.file_media_request,
                    file_mime: ext.file_mime,
                    file_display_name: ext.file_display_name,
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

    // --- Auto-reconcile triggers ------------------------------------------
    //
    // Keep per-room push rules in sync with the user's notification intent
    // without relying on the frontend to manually poke the reconciler:
    //
    //   - Self-join a room     → reconcile_room for that room (so new rooms
    //                             pick up the global/space default).
    //   - m.space.child changes → reconcile_rooms_for_space for the space
    //                             that emitted (so rooms newly under a
    //                             levelled space get that level applied).
    //   - m.direct changes      → reconcile_all (DMs vs group rooms have
    //                             different Element defaults, and the
    //                             resolver consults m.direct).
    //
    // Everything runs gated on `reconcile_gate`, which only flips true
    // after the first `sync_once` completes.  Without that gate, matrix-sdk
    // fires handlers for the state-event replay during initial sync — on a
    // fresh login that would spawn a reconcile_room per joined room in
    // addition to the startup `reconcile_all` below, thrashing the
    // homeserver for nothing since initial `reconcile_all` already covers
    // them.
    let state_arc: Arc<AppState> = (*state).clone();
    let reconcile_gate = Arc::new(AtomicBool::new(false));

    {
        let state_h = state_arc.clone();
        let app_h = app.clone();
        let gate_h = reconcile_gate.clone();
        let self_id = client
            .user_id()
            .map(|u| u.to_string())
            .unwrap_or_default();
        client.add_event_handler(move |ev: OriginalSyncRoomMemberEvent, room: Room| {
            let state = state_h.clone();
            let app = app_h.clone();
            let gate = gate_h.clone();
            let self_id = self_id.clone();
            async move {
                if !gate.load(Ordering::Relaxed) {
                    return;
                }
                // Only self-join transitions — skip other members' events,
                // self non-Join transitions, and in-place updates while
                // already Joined (e.g. avatar / displayname edits).
                if ev.state_key.as_str() != self_id {
                    return;
                }
                if ev.content.membership != MembershipState::Join {
                    return;
                }
                let prev_was_join = ev
                    .unsigned
                    .prev_content
                    .as_ref()
                    .map(|c| c.membership == MembershipState::Join)
                    .unwrap_or(false);
                if prev_was_join {
                    return;
                }

                let room_id = room.room_id().to_string();
                log::info!("[pax reconcile] self-joined {room_id}; reconciling");
                if let Err(e) =
                    super::reconciler::reconcile_room(&state, &app, &room_id).await
                {
                    log::warn!(
                        "[pax reconcile] room-join reconcile failed {room_id}: {e}"
                    );
                }
            }
        });
    }

    {
        let state_h = state_arc.clone();
        let app_h = app.clone();
        let gate_h = reconcile_gate.clone();
        client.add_event_handler(
            move |_ev: OriginalSyncStateEvent<SpaceChildEventContent>, room: Room| {
                let state = state_h.clone();
                let app = app_h.clone();
                let gate = gate_h.clone();
                async move {
                    if !gate.load(Ordering::Relaxed) {
                        return;
                    }
                    let space_id = room.room_id().to_string();
                    log::info!(
                        "[pax reconcile] m.space.child changed in {space_id}; reconciling children"
                    );
                    if let Err(e) = super::reconciler::reconcile_rooms_for_space(
                        &state, &app, &space_id,
                    )
                    .await
                    {
                        log::warn!(
                            "[pax reconcile] space-child reconcile failed {space_id}: {e}"
                        );
                    }
                }
            },
        );
    }

    {
        let state_h = state_arc.clone();
        let app_h = app.clone();
        let gate_h = reconcile_gate.clone();
        client.add_event_handler(move |_ev: GlobalAccountDataEvent<DirectEventContent>| {
            let state = state_h.clone();
            let app = app_h.clone();
            let gate = gate_h.clone();
            async move {
                if !gate.load(Ordering::Relaxed) {
                    return;
                }
                log::info!("[pax reconcile] m.direct changed; reconciling all rooms");
                if let Err(e) = super::reconciler::reconcile_all(&state, &app).await {
                    log::warn!("[pax reconcile] m.direct reconcile failed: {e}");
                }
            }
        });
    }

    // Clone shared state needed inside the sync loop.
    let presence_map = state.presence_map.clone();
    let status_msg_map = state.status_msg_map.clone();
    let avatar_cache = state.avatar_cache.clone();
    let voice_client = client.clone();
    let desired_presence = state.desired_presence.clone();
    let unread_cache = state.unread_cache.clone();
    let reconcile_state_arc = state_arc.clone();
    let reconcile_gate_for_loop = reconcile_gate.clone();
    let self_user_id = client
        .user_id()
        .map(|u| u.to_string())
        .unwrap_or_default();

    // Spawn the continuous sync loop in the background.
    // Uses sync_once in a manual loop so we can read `desired_presence` on each
    // iteration and set the sync's `set_presence` accordingly:
    //   - "online" → set_presence=Online  (Synapse auto-manages, like Cinny/Element)
    //   - anything else → set_presence=Offline (explicit PUTs from the frontend handle it)
    let join = tokio::spawn(async move {
        let mut first_sync_done = false;
        let mut sync_count: u64 = 0;

        loop {
            sync_count += 1;
            let sync_t0 = std::time::Instant::now();

            // Read the user's desired presence for this sync iteration.
            let desired = desired_presence
                .lock()
                .ok()
                .map(|g| g.clone())
                .unwrap_or_else(|| "online".to_string());

            let set_presence_value = if desired == "online" {
                matrix_sdk::ruma::presence::PresenceState::Online
            } else {
                matrix_sdk::ruma::presence::PresenceState::Offline
            };

            // The SDK tracks the `since` token internally between sync_once calls.
            let settings = matrix_sdk::config::SyncSettings::default()
                .set_presence(set_presence_value);

            let response = match client.sync_once(settings).await {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("Sync error: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };

            let sync_elapsed = sync_t0.elapsed();
            let presence_count = response.presence.len();
            log::info!(
                "[sync] iteration #{} took {:?}: presence_updates={}",
                sync_count,
                sync_elapsed,
                presence_count,
            );

            if !first_sync_done {
                first_sync_done = true;
                let _ = app.emit("sync-ready", ());

                // Initial reconcile — catches drift from other clients
                // since we last synced, plus applies global/space defaults
                // to rooms that existed before join-event tracking started.
                // Flip the gate BEFORE spawning so any join/space-child/
                // m.direct events landing during the reconcile also fire
                // their handlers.  Both paths running concurrently is fine
                // — reconciles are idempotent.
                reconcile_gate_for_loop.store(true, Ordering::Release);
                let s = reconcile_state_arc.clone();
                let a = app.clone();
                tokio::spawn(async move {
                    if let Err(e) = super::reconciler::reconcile_all(&s, &a).await {
                        log::warn!(
                            "[pax reconcile] initial sync-ready reconcile failed: {e}"
                        );
                    }
                });
            }

            // Extract presence updates from the sync response.
            // Skip our own user — we manage self-presence explicitly
            // via set_presence PUTs + heartbeat, and sync echoes for
            // self are racey/stale, causing the local display to flicker.
            for raw_event in &response.presence {
                if let Ok(ev) = raw_event.deserialize() {
                    let user_id = ev.sender.to_string();
                    if user_id == self_user_id {
                        continue;
                    }

                    let presence_str = match ev.content.presence {
                        matrix_sdk::ruma::presence::PresenceState::Online => "online",
                        matrix_sdk::ruma::presence::PresenceState::Unavailable => {
                            "unavailable"
                        }
                        _ => "offline",
                    };

                    presence_map
                        .lock()
                        .await
                        .insert(user_id.clone(), presence_str.to_string());

                    let status_msg_val = ev.content.status_msg.filter(|s| !s.is_empty());
                    {
                        let mut sm = status_msg_map.lock().await;
                        if let Some(ref msg) = status_msg_val {
                            sm.insert(user_id.clone(), msg.clone());
                        } else {
                            sm.remove(&user_id);
                        }
                    }

                    let _ = app.emit(
                        "presence",
                        PresencePayload {
                            user_id,
                            presence: presence_str.to_string(),
                            status_msg: status_msg_val,
                        },
                    );
                }
            }

            let _ = app.emit("rooms-changed", ());

            // Emit per-room unread diffs since last iteration.  Pure in-memory
            // reads (RwLock) — cheap even for hundreds of rooms.  See
            // `commands::unread` for why we poll instead of subscribing to
            // `room_info_notable_update_receiver`.
            super::unread::emit_unread_snapshot_if_changed(&client, &unread_cache, &app).await;

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
                    VoiceParticipantsChangedPayload {
                        participants_by_room,
                    },
                );
            });
        }
    });

    {
        let mut slot = state.sync_join.lock().await;
        if let Some(old) = slot.replace(join) {
            old.abort();
            let _ = old.await;
        }
    }

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
        .map_err(|e| format!("Failed to send typing notice: {}", fmt_error_chain(&e)))?;

    Ok(())
}

/// Body text for the timeline plus optional image / video / file download descriptors (`m.room.message`).
#[derive(Clone)]
struct MessageDisplayExtract {
    body: String,
    image_media_request: Option<serde_json::Value>,
    video_media_request: Option<serde_json::Value>,
    file_media_request: Option<serde_json::Value>,
    file_mime: Option<String>,
    file_display_name: Option<String>,
}

fn extract_message_display(
    content: &matrix_sdk::ruma::events::room::message::RoomMessageEventContent,
) -> MessageDisplayExtract {
    use matrix_sdk::ruma::events::room::message::MessageType;
    match &content.msgtype {
        MessageType::Image(img) => {
            let body = img
                .caption()
                .map(|s| s.to_string())
                .unwrap_or_default();
            // Thumbnails are often a single static frame for GIFs (and sometimes transcoded to PNG/JPEG).
            // Request the original file for GIFs so the WebView can animate them.
            // Non-GIF: modest thumbnail size — large thumbs stress remote-media federation and some
            // homeservers return 500s under that load.
            let format = if matrix_image_is_gif(img) {
                MediaFormat::File
            } else {
                MediaFormat::Thumbnail(MediaThumbnailSettings::new(
                    UInt::from(800u32),
                    UInt::from(800u32),
                ))
            };
            let req = MediaRequestParameters {
                source: img.source.clone(),
                format,
            };
            let json = serde_json::to_value(&req).ok();
            MessageDisplayExtract {
                body,
                image_media_request: json,
                video_media_request: None,
                file_media_request: None,
                file_mime: None,
                file_display_name: None,
            }
        }
        MessageType::Video(vid) => {
            let body = vid
                .caption()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let req = MediaRequestParameters {
                source: vid.source.clone(),
                format: MediaFormat::File,
            };
            let json = serde_json::to_value(&req).ok();
            MessageDisplayExtract {
                body,
                image_media_request: None,
                video_media_request: json,
                file_media_request: None,
                file_mime: None,
                file_display_name: None,
            }
        }
        MessageType::Text(text) => MessageDisplayExtract {
            body: text.body.clone(),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
        },
        MessageType::Notice(notice) => MessageDisplayExtract {
            body: notice.body.clone(),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
        },
        MessageType::Emote(emote) => MessageDisplayExtract {
            body: format!("* {}", emote.body),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
        },
        MessageType::File(f) => {
            let display_name = f
                .filename
                .as_ref()
                .map(|s| s.to_string())
                .unwrap_or_else(|| f.body.clone());
            // When `filename` is set, `body` is the caption; otherwise `body` is the filename only.
            let body = if f.filename.is_some() {
                f.body.clone()
            } else {
                String::new()
            };
            let mime = f
                .info
                .as_ref()
                .and_then(|i| i.mimetype.as_ref())
                .map(|m| m.to_string());
            let req = MediaRequestParameters {
                source: f.source.clone(),
                format: MediaFormat::File,
            };
            let json = serde_json::to_value(&req).ok();
            MessageDisplayExtract {
                body,
                image_media_request: None,
                video_media_request: None,
                file_media_request: json,
                file_mime: mime,
                file_display_name: Some(display_name),
            }
        }
        MessageType::Audio(_) => MessageDisplayExtract {
            body: "[Audio]".to_string(),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
        },
        _ => MessageDisplayExtract {
            body: "[Unsupported message]".to_string(),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
        },
    }
}

fn matrix_image_is_gif(
    img: &matrix_sdk::ruma::events::room::message::ImageMessageEventContent,
) -> bool {
    if let Some(info) = img.info.as_ref() {
        if let Some(mime) = info.mimetype.as_ref() {
            // `mimetype` is a typed value in Ruma; compare via string without ambiguous `AsRef`.
            if mime.to_string().eq_ignore_ascii_case("image/gif") {
                return true;
            }
        }
    }
    img.filename().to_ascii_lowercase().ends_with(".gif")
}

fn mime_to_file_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

/// Download Matrix media and return a temp **filesystem path** for [`convertFileSrc`].
///
/// Returning multi‑MB `data:` URLs over Tauri’s JSON IPC is slow and often fails or OOMs; the
/// timeline uses temp files under `$TEMP` (see `tauri.conf.json` `assetProtocol.scope`).
#[tauri::command]
pub async fn get_matrix_image_path(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: serde_json::Value,
) -> Result<String, String> {
    let params: MediaRequestParameters = serde_json::from_value(request)
        .map_err(|e| format!("Invalid media request: {e}"))?;

    let cache_key = format!("mmedia:{}", params.unique_key());

    {
        let mut cache = state.avatar_cache.lock().await;
        if let Some(existing) = cache.get(&cache_key).cloned() {
            if existing.starts_with("data:") {
                cache.remove(&cache_key);
            } else if std::path::Path::new(&existing).is_file() {
                return Ok(existing);
            } else {
                cache.remove(&cache_key);
            }
        }
    }

    let client = get_client(&state).await?;

    let first_timeout = match &params.format {
        MediaFormat::Thumbnail(_) => MATRIX_IMAGE_THUMB_FETCH_TIMEOUT,
        MediaFormat::File => MATRIX_IMAGE_FULL_FETCH_TIMEOUT,
    };

    let bytes = match get_matrix_media_bytes_with_timeout(
        &client,
        &params,
        false,
        first_timeout,
    )
    .await
    {
        Ok(b) => b,
        Err(e) => {
            if matches!(&params.format, MediaFormat::Thumbnail(_)) {
                let fallback = MediaRequestParameters {
                    source: params.source.clone(),
                    format: MediaFormat::File,
                };
                match get_matrix_media_bytes_with_timeout(
                    &client,
                    &fallback,
                    false,
                    MATRIX_IMAGE_FULL_FETCH_TIMEOUT,
                )
                .await
                {
                    Ok(b) => b,
                    Err(e2) => {
                        let msg = format!(
                            "Thumbnail failed: {} | Full image failed: {}",
                            e, e2
                        );
                        log::warn!("Matrix image: {msg}");
                        return Err(msg);
                    }
                }
            } else {
                let msg = format!("Failed to load image: {e}");
                log::warn!("Matrix image: {msg}");
                return Err(msg);
            }
        }
    };

    let mime = sniff_media_mime(&bytes);
    let ext = mime_to_file_ext(mime);

    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {e}"))?;
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let path = temp_dir.join(format!(
        "pax_matrix_media_{}.{}",
        uuid::Uuid::new_v4(),
        ext
    ));

    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write image temp file: {e}"))?;

    let path_str = path
        .to_str()
        .ok_or("Temp file path is not valid UTF-8")?
        .to_string();

    state
        .avatar_cache
        .lock()
        .await
        .insert(cache_key, path_str.clone());

    Ok(path_str)
}

/// Evict cached media + avatar temp files and their `avatar_cache`
/// entries.  Called by the frontend on room switch so images from the
/// previous room don't linger in memory / on disk.
#[tauri::command]
pub async fn clear_media_cache(
    state: State<'_, Arc<AppState>>,
) -> Result<u32, String> {
    let mut cache = state.avatar_cache.lock().await;

    // Collect keys whose entries point at temp files (mmedia: keys and
    // mxc:// avatar keys that have been migrated to file-backed URLs).
    let stale_keys: Vec<String> = cache
        .iter()
        .filter(|(k, v)| {
            k.starts_with("mmedia:")
                || (k.starts_with("mxc://") && !v.starts_with("data:"))
        })
        .map(|(k, _)| k.clone())
        .collect();

    for key in &stale_keys {
        cache.remove(key);
    }

    let evicted = stale_keys.len();
    drop(cache); // release lock before I/O

    // Walk the temp directory and delete our files.
    let temp_dir = super::temp_dir();
    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if n.starts_with("pax_avatar_") || n.starts_with("pax_matrix_media_") {
                if std::fs::remove_file(entry.path()).is_ok() {
                    deleted += 1;
                }
            }
        }
    }

    if evicted > 0 || deleted > 0 {
        log::info!(
            "[clear_media_cache] evicted {} cache entries, deleted {} temp files",
            evicted,
            deleted,
        );
    }
    Ok(deleted)
}

/// Upload a file to the Matrix media repo and send it as an `m.room.message`.
///
/// The frontend sends file bytes as base64 (same pattern as avatar upload).
/// Based on MIME type, we send `m.image`, `m.video`, `m.audio`, or `m.file`.
#[tauri::command]
pub async fn upload_and_send_file(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    file_name: String,
    mime_type: String,
    data: String,
    caption: Option<String>,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let bytes = data_encoding::BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("Invalid base64: {e}"))?;

    let content_type: mime::Mime = mime_type
        .parse()
        .unwrap_or(mime::APPLICATION_OCTET_STREAM);

    log::info!(
        "[Pax Upload] file={} mime={} size={}",
        file_name, content_type, bytes.len()
    );

    let file_size = UInt::try_from(bytes.len() as u64).ok();

    // Upload to the Matrix media repository via direct HTTP (avoids SDK hangs).
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let upload_url = format!(
        "{}/_matrix/media/v3/upload?filename={}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&file_name),
    );

    let resp = state
        .http_client
        .post(&upload_url)
        .timeout(Duration::from_secs(120))
        .bearer_auth(access_token.to_string())
        .header("Content-Type", content_type.to_string())
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Failed to upload file: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Upload failed ({}): {}", status, body));
    }

    #[derive(serde::Deserialize)]
    struct UploadResponse {
        content_uri: String,
    }

    let upload_result: UploadResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse upload response: {e}"))?;

    let mxc_uri = matrix_sdk::ruma::OwnedMxcUri::from(upload_result.content_uri);
    log::info!("[Pax Upload] uploaded → {}", mxc_uri);

    use matrix_sdk::ruma::events::room::message::MessageType;
    use matrix_sdk::ruma::events::room::MediaSource;

    // When there's a caption, it becomes the message body and the filename
    // is set separately. This makes the caption appear as message text with the
    // media attachment below it in clients that support it.
    let body_text = caption
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
        .unwrap_or_else(|| file_name.clone());
    let has_caption = caption.as_deref().map_or(false, |c| !c.is_empty());

    let content = if content_type.type_() == mime::IMAGE {
        use matrix_sdk::ruma::events::room::message::ImageMessageEventContent;
        use matrix_sdk::ruma::events::room::ImageInfo;

        let mut info = ImageInfo::new();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;

        let mut img = ImageMessageEventContent::new(
            body_text,
            MediaSource::Plain(mxc_uri),
        );
        img.info = Some(Box::new(info));
        if has_caption {
            img.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Image(img))
    } else if content_type.type_() == mime::VIDEO {
        use matrix_sdk::ruma::events::room::message::VideoMessageEventContent;

        let mut vid = VideoMessageEventContent::new(
            body_text,
            MediaSource::Plain(mxc_uri),
        );
        let mut info = vid.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        vid.info = Some(info);
        if has_caption {
            vid.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Video(vid))
    } else if content_type.type_() == mime::AUDIO {
        use matrix_sdk::ruma::events::room::message::AudioMessageEventContent;

        let mut aud = AudioMessageEventContent::new(
            body_text,
            MediaSource::Plain(mxc_uri),
        );
        let mut info = aud.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        aud.info = Some(info);
        if has_caption {
            aud.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Audio(aud))
    } else {
        use matrix_sdk::ruma::events::room::message::FileMessageEventContent;

        let mut file_msg = FileMessageEventContent::new(
            body_text,
            MediaSource::Plain(mxc_uri),
        );
        let mut info = file_msg.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        file_msg.info = Some(info);
        if has_caption {
            file_msg.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::File(file_msg))
    };

    room.send(content)
        .await
        .map_err(|e| format!("Failed to send file message: {}", fmt_error_chain(&e)))?;

    Ok(())
}
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::reply::{EnforceThread, Reply};
use matrix_sdk::room::IncludeRelations;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::room::RelationsOptions;
use matrix_sdk::ruma::events::direct::DirectEventContent;
use matrix_sdk::ruma::events::reaction::ReactionEventContent;
use matrix_sdk::ruma::events::relation::Annotation;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::member::OriginalSyncRoomMemberEvent;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent;
use matrix_sdk::ruma::events::room::redaction::OriginalSyncRoomRedactionEvent;
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::events::AnySyncMessageLikeEvent;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::GlobalAccountDataEvent;
use matrix_sdk::ruma::events::MessageLikeEventType;
use matrix_sdk::ruma::events::OriginalSyncMessageLikeEvent;
use matrix_sdk::ruma::events::OriginalSyncStateEvent;
use matrix_sdk::ruma::events::SyncMessageLikeEvent;
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::UInt;
use matrix_sdk::ruma::UserId;
use matrix_sdk::Room;
use tauri::{Emitter, State};

use crate::types::{
    MessageBatch, MessageEditPayload, MessageInfo, MessageReactionDeltaPayload,
    MessageReactionSummary, MessageRedactedPayload, MessageReplyTo, PinnedMessagePreview,
    PresencePayload, RoomMessagePayload, RoomPinPermission, RoomRedactionPolicy,
    RoomSendPermission, TypingPayload, VoiceParticipantsChangedPayload,
};
use crate::AppState;

use super::message_display::{
    extract_mentioned_user_ids, extract_message_display, reply_to_from_message_relation,
};
use super::voice_matrix::collect_voice_participants_for_joined_voice_rooms;
use super::{fmt_error_chain, get_client, get_or_fetch_avatar, resolve_room};
/// Matrix user IDs are compared case-insensitively; event `sender` and `client.user_id()` can differ in casing.
fn user_id_strings_equal(a: &str, b: &str) -> bool {
    a == b || a.to_lowercase() == b.to_lowercase()
}

/// Emoji keys from the client vs the server can differ by Unicode variation selector (U+FE0E/U+FE0F).
fn reaction_keys_match(stored: &str, from_request: &str) -> bool {
    if stored == from_request {
        return true;
    }
    let strip_vs = |s: &str| {
        s.chars()
            .filter(|&c| c != '\u{fe0e}' && c != '\u{fe0f}')
            .collect::<String>()
    };
    strip_vs(stored) == strip_vs(from_request)
}

enum ReactionFoldOp {
    Add {
        ts: u64,
        reaction_event_id: String,
        target: String,
        key: String,
        sender: String,
    },
    Redact {
        ts: u64,
        redacts: String,
    },
}

/// Build per-target reaction summaries from timeline events (chronological fold with redactions).
fn aggregate_reactions_from_timeline(
    events: &[TimelineEvent],
    my_user_id: Option<&UserId>,
) -> HashMap<String, Vec<MessageReactionSummary>> {
    let mut ops: Vec<ReactionFoldOp> = Vec::new();
    for ev in events {
        let raw = match ev.raw().deserialize() {
            Ok(e) => e,
            Err(_) => continue,
        };
        match raw {
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Reaction(r)) => {
                if let SyncMessageLikeEvent::Original(o) = r {
                    let ts: u64 = o.origin_server_ts.0.into();
                    let target = o.content.relates_to.event_id.to_string();
                    let key = o.content.relates_to.key.clone();
                    let sender = o.sender.to_string();
                    let reaction_event_id = o.event_id.to_string();
                    ops.push(ReactionFoldOp::Add {
                        ts,
                        reaction_event_id,
                        target,
                        key,
                        sender,
                    });
                }
            }
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomRedaction(r)) => {
                if let SyncRoomRedactionEvent::Original(o) = r {
                    if let Some(redacts) = o
                        .redacts
                        .as_ref()
                        .or(o.content.redacts.as_ref())
                        .map(|id| id.to_string())
                    {
                        let ts: u64 = o.origin_server_ts.0.into();
                        ops.push(ReactionFoldOp::Redact { ts, redacts });
                    }
                }
            }
            _ => {}
        }
    }
    ops.sort_by(|a, b| {
        let ta = match a {
            ReactionFoldOp::Add { ts, .. } | ReactionFoldOp::Redact { ts, .. } => *ts,
        };
        let tb = match b {
            ReactionFoldOp::Add { ts, .. } | ReactionFoldOp::Redact { ts, .. } => *ts,
        };
        ta.cmp(&tb)
    });

    let mut by_reaction_id: HashMap<String, (String, String, String)> = HashMap::new();
    let mut agg: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();

    for op in ops {
        match op {
            ReactionFoldOp::Add {
                reaction_event_id,
                target,
                key,
                sender,
                ..
            } => {
                by_reaction_id.insert(
                    reaction_event_id,
                    (target.clone(), key.clone(), sender.clone()),
                );
                agg.entry(target)
                    .or_default()
                    .entry(key)
                    .or_default()
                    .insert(sender);
            }
            ReactionFoldOp::Redact { redacts, .. } => {
                if let Some((target, key, sender)) = by_reaction_id.remove(&redacts) {
                    if let Some(keys) = agg.get_mut(&target) {
                        if let Some(users) = keys.get_mut(&key) {
                            users.remove(&sender);
                            if users.is_empty() {
                                keys.remove(&key);
                            }
                        }
                        if keys.is_empty() {
                            agg.remove(&target);
                        }
                    }
                }
            }
        }
    }

    let mut out: HashMap<String, Vec<MessageReactionSummary>> = HashMap::new();
    for (target, keys) in agg {
        let mut summaries: Vec<MessageReactionSummary> = keys
            .into_iter()
            .map(|(key, senders)| {
                let count = senders.len() as u32;
                let reacted_by_me = my_user_id.is_some_and(|me| {
                    let m = me.as_str();
                    senders.iter().any(|s| user_id_strings_equal(s.as_str(), m))
                });
                let mut reacted_by: Vec<String> = senders.into_iter().collect();
                reacted_by.sort();
                MessageReactionSummary {
                    key,
                    count,
                    reacted_by_me,
                    reacted_by,
                }
            })
            .collect();
        summaries.sort_by(|a, b| a.key.cmp(&b.key));
        if !summaries.is_empty() {
            out.insert(target, summaries);
        }
    }
    out
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    from: Option<String>,
    limit: u32,
) -> Result<MessageBatch, String> {
    let short_room = if room_id.len() > 6 {
        &room_id[room_id.len() - 6..]
    } else {
        &room_id
    };
    log::info!(
        "[get_messages] room=…{} from={} limit={}",
        short_room,
        from.as_deref()
            .map(|t| if t.len() > 16 { &t[..16] } else { t })
            .unwrap_or("null"),
        limit,
    );
    let t0 = std::time::Instant::now();

    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let avatar_cache = state.avatar_cache.clone();

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
        image_width: Option<u32>,
        image_height: Option<u32>,
        video_width: Option<u32>,
        video_height: Option<u32>,
        unsupported_matrix_msgtype: Option<String>,
        reply_to: Option<MessageReplyTo>,
        mentioned_user_ids: Vec<String>,
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
            Option<u32>,
            Option<u32>,
            Option<u32>,
            Option<u32>,
            Option<String>,
            u64,
        ),
    > = HashMap::new();

    let mut current_from = from.clone();
    let mut pages_scanned: usize = 0;
    let mut timeline_event_count_total: usize = 0;
    let mut prev_batch: Option<String>;
    let mut events_for_reactions: Vec<TimelineEvent> = Vec::new();

    // Cap on how many pages we'll walk in one `get_messages` call while looking
    // for enough visible messages.  With the end-token-based stop below we can
    // legitimately keep paging through filtered-but-non-empty pages (rooms with
    // a run of membership churn, reactions, redactions, etc. at the head), so
    // bound it to keep worst-case backend work predictable.  At limit=50 this
    // is up to ~1000 timeline events per call, which has always been enough in
    // practice.
    const MAX_PAGES_PER_CALL: usize = 20;

    // How many *visible* (`m.room.message`) events we want to surface before
    // returning.  A Matrix `/messages` page is a page of *timeline events*, so
    // a federated or state-heavy room (membership churn, reactions, receipts,
    // non-message state) can easily come back with only 1–3 actual messages
    // out of a 50-event chunk.  If that tiny result fits inside the viewport
    // there is no scrollbar, `scrollTop` stays at 0, and the user physically
    // cannot scroll up to trigger further pagination even though a valid
    // `prev_batch` token exists.  Keep paging backward until we've surfaced
    // enough messages to reliably overflow a chat viewport (bounded by the
    // caller's `limit`, so a caller asking for 5 doesn't suddenly get 20).
    let target_visible: usize = (limit as usize).min(20);

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

        events_for_reactions.extend(chunk.iter().cloned());

        pages_scanned += 1;

        // Trust the server's `end` token.  `chunk.len() < limit` is NOT a
        // reliable end-of-history signal: the `/messages` spec makes no such
        // guarantee, and Synapse routinely returns fewer than `limit` timeline
        // events per page (state events filtered server-side, lazy-loaded
        // membership, undecryptable events, matrix-sdk's own filter dropping
        // non-message-like events) while hundreds of older messages are still
        // available.  The previous heuristic caused rooms to appear to have no
        // more history whenever the first backward page happened to be mostly
        // non-`m.room.message` events — the user saw 1–2 messages with no way
        // to scroll back.
        //
        // Stop only when:
        //   * the server returns no `end` token at all (true start of room), or
        //   * the server didn't advance `end` past what we just sent (defensive:
        //     some homeservers echo the token when there is no more), or
        //   * the chunk was completely empty (no events at all — treat as end,
        //     otherwise an endlessly-repeating `end` token could spin us).
        let chunk_len = chunk.len();
        timeline_event_count_total += chunk_len;
        let end_advanced = pagination_end.as_deref() != current_from.as_deref();
        prev_batch = if chunk_len == 0 || !end_advanced {
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
                        Some((_, _, _, _, _, _, _, _, _, _, _, prev_ts)) => ts >= *prev_ts,
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
                                ext.image_width,
                                ext.image_height,
                                ext.video_width,
                                ext.video_height,
                                ext.unsupported_matrix_msgtype.clone(),
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
                let reply_to = reply_to_from_message_relation(&original.content.relates_to);
                let mentioned_user_ids = extract_mentioned_user_ids(&original.content);
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
                    image_width: ext.image_width,
                    image_height: ext.image_height,
                    video_width: ext.video_width,
                    video_height: ext.video_height,
                    unsupported_matrix_msgtype: ext.unsupported_matrix_msgtype,
                    reply_to,
                    mentioned_user_ids,
                });
            }
        }

        // Keep paging until we have enough visible messages to overflow the
        // viewport (so the user can actually scroll and re-trigger pagination),
        // we truly run out of history, or we hit the per-call page cap.
        if raw_msgs.len() >= target_visible || prev_batch.is_none() {
            break;
        }
        if pages_scanned >= MAX_PAGES_PER_CALL {
            log::warn!(
                "[get_messages] room=…{} page cap hit ({} pages, {} events walked, {} visible msgs found of target {}); returning partial result",
                short_room,
                pages_scanned,
                timeline_event_count_total,
                raw_msgs.len(),
                target_visible,
            );
            break;
        }

        current_from = prev_batch.clone();
    }

    let reaction_map = aggregate_reactions_from_timeline(&events_for_reactions, client.user_id());

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
                image_width,
                image_height,
                video_width,
                video_height,
                unsupported_matrix_msgtype,
            ) = latest_replacement
                .get(&m.event_id)
                .map(|(b, img, vid, file, fm, fd, iw, ih, vw, vh, unsup, _ts)| {
                    (
                        b.clone(),
                        img.clone(),
                        vid.clone(),
                        file.clone(),
                        fm.clone(),
                        fd.clone(),
                        *iw,
                        *ih,
                        *vw,
                        *vh,
                        unsup.clone(),
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
                        m.image_width,
                        m.image_height,
                        m.video_width,
                        m.video_height,
                        m.unsupported_matrix_msgtype.clone(),
                    )
                });
            let reactions = reaction_map.get(&m.event_id).cloned();
            MessageInfo {
                event_id: m.event_id,
                sender: m.sender,
                sender_name,
                body,
                timestamp: m.timestamp,
                avatar_url,
                edited,
                reply_to: m.reply_to,
                image_media_request,
                image_width,
                image_height,
                video_media_request,
                video_width,
                video_height,
                file_media_request,
                file_mime,
                file_display_name,
                unsupported_matrix_msgtype,
                reactions,
                mentioned_user_ids: m.mentioned_user_ids,
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
    reply_to_event_id: Option<String>,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let content = if let Some(raw) = reply_to_event_id {
        let id_str = raw.trim();
        if id_str.is_empty() {
            return Err("Invalid reply event id".to_string());
        }
        let eid: OwnedEventId = EventId::parse(id_str)
            .map_err(|e| format!("Invalid event id: {e}"))?
            .to_owned();
        let reply = Reply {
            event_id: eid,
            enforce_thread: EnforceThread::MaybeThreaded,
        };
        let without = RoomMessageEventContentWithoutRelation::text_plain(&body);
        room.make_reply_event(without, reply)
            .await
            .map_err(|e| format!("Failed to build reply: {}", fmt_error_chain(&e)))?
    } else {
        RoomMessageEventContent::text_plain(&body)
    };

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
pub async fn get_room_can_send_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomSendPermission, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let own = client.user_id().ok_or("Not logged in")?;

    let member = room
        .get_member(own)
        .await
        .map_err(|e| format!("Failed to load membership: {}", fmt_error_chain(&e)))?;

    let can_send = member
        .map(|m| m.can_send_message(MessageLikeEventType::RoomMessage))
        .unwrap_or(false);

    Ok(RoomSendPermission { can_send })
}

async fn current_pinned_event_ids(room: &Room) -> Result<Vec<OwnedEventId>, String> {
    match room.load_pinned_events().await {
        Ok(Some(v)) => Ok(v),
        Ok(None) => Ok(room.pinned_event_ids().unwrap_or_default()),
        Err(e) => {
            log::warn!(
                "load_pinned_events failed: {}; using cache",
                fmt_error_chain(&e)
            );
            Ok(room.pinned_event_ids().unwrap_or_default())
        }
    }
}

/// Build [`MessageInfo`] rows from decrypted timeline events (chronological order in, any order out).
async fn build_message_infos_from_timeline_events(
    room: &Room,
    timeline_events: Vec<TimelineEvent>,
    avatar_cache: &std::sync::Arc<crate::commands::avatar_cache::AvatarDiskCache>,
) -> Result<Vec<MessageInfo>, String> {
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
        image_width: Option<u32>,
        image_height: Option<u32>,
        video_width: Option<u32>,
        video_height: Option<u32>,
        unsupported_matrix_msgtype: Option<String>,
        reply_to: Option<MessageReplyTo>,
        mentioned_user_ids: Vec<String>,
    }

    let mut raw_msgs = Vec::new();
    let mut latest_replacement: HashMap<
        String,
        (
            String,
            Option<serde_json::Value>,
            Option<serde_json::Value>,
            Option<serde_json::Value>,
            Option<String>,
            Option<String>,
            Option<u32>,
            Option<u32>,
            Option<u32>,
            Option<u32>,
            Option<String>,
            u64,
        ),
    > = HashMap::new();
    let mut unique_senders = Vec::new();
    let mut seen_senders = HashSet::new();

    let client = room.client();
    let me = client.user_id();
    let reaction_map = aggregate_reactions_from_timeline(&timeline_events, me);

    for event in timeline_events {
        let raw = match event.kind.raw().deserialize() {
            Ok(e) => e,
            Err(_) => continue,
        };

        if let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(msg)) = raw {
            match msg {
                SyncMessageLikeEvent::Original(original) => {
                    if let Some(Relation::Replacement(repl)) = &original.content.relates_to {
                        let target = repl.event_id.to_string();
                        let ext = extract_message_display(&RoomMessageEventContent::from(
                            repl.new_content.clone(),
                        ));
                        let ts: u64 = original.origin_server_ts.0.into();
                        let replace = match latest_replacement.get(&target) {
                            None => true,
                            Some((_, _, _, _, _, _, _, _, _, _, _, prev_ts)) => ts >= *prev_ts,
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
                                    ext.image_width,
                                    ext.image_height,
                                    ext.video_width,
                                    ext.video_height,
                                    ext.unsupported_matrix_msgtype.clone(),
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
                    let reply_to = reply_to_from_message_relation(&original.content.relates_to);
                    let mentioned_user_ids = extract_mentioned_user_ids(&original.content);
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
                        image_width: ext.image_width,
                        image_height: ext.image_height,
                        video_width: ext.video_width,
                        video_height: ext.video_height,
                        unsupported_matrix_msgtype: ext.unsupported_matrix_msgtype,
                        reply_to,
                        mentioned_user_ids,
                    });
                }
                _ => {}
            }
        }
    }

    let mut sender_meta: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for uid in &unique_senders {
        let meta = match room.get_member_no_sync(uid).await {
            Ok(Some(member)) => {
                let name = member.display_name().map(|n| n.to_string());
                let avatar = get_or_fetch_avatar(
                    member.avatar_url(),
                    member.avatar(matrix_sdk::media::MediaFormat::File),
                    avatar_cache,
                )
                .await;
                (name, avatar)
            }
            _ => (None, None),
        };
        sender_meta.insert(uid.to_string(), meta);
    }

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
                image_width,
                image_height,
                video_width,
                video_height,
                unsupported_matrix_msgtype,
            ) = latest_replacement
                .get(&m.event_id)
                .map(|(b, img, vid, file, fm, fd, iw, ih, vw, vh, unsup, _ts)| {
                    (
                        b.clone(),
                        img.clone(),
                        vid.clone(),
                        file.clone(),
                        fm.clone(),
                        fd.clone(),
                        *iw,
                        *ih,
                        *vw,
                        *vh,
                        unsup.clone(),
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
                        m.image_width,
                        m.image_height,
                        m.video_width,
                        m.video_height,
                        m.unsupported_matrix_msgtype.clone(),
                    )
                });
            let reactions = reaction_map.get(&m.event_id).cloned();
            MessageInfo {
                event_id: m.event_id,
                sender: m.sender,
                sender_name,
                body,
                timestamp: m.timestamp,
                avatar_url,
                edited,
                reply_to: m.reply_to,
                image_media_request,
                image_width,
                image_height,
                video_media_request,
                video_width,
                video_height,
                file_media_request,
                file_mime,
                file_display_name,
                unsupported_matrix_msgtype,
                reactions,
                mentioned_user_ids: m.mentioned_user_ids,
            }
        })
        .collect();

    Ok(messages)
}

#[tauri::command]
pub async fn get_room_can_pin_messages(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomPinPermission, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let own = client.user_id().ok_or("Not logged in")?;

    let member = room
        .get_member(own)
        .await
        .map_err(|e| format!("Failed to load membership: {}", fmt_error_chain(&e)))?;

    let can_pin = member.map(|m| m.can_pin_or_unpin_event()).unwrap_or(false);

    Ok(RoomPinPermission { can_pin })
}

#[tauri::command]
pub async fn get_room_pinned_event_ids(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<String>, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let ids = current_pinned_event_ids(&room).await?;
    Ok(ids.into_iter().map(|id| id.to_string()).collect())
}

#[tauri::command]
pub async fn get_pinned_message_previews(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<PinnedMessagePreview>, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let ids = current_pinned_event_ids(&room).await?;

    let mut out = Vec::new();
    for id in ids {
        let eid = match EventId::parse(&id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let ev = match room.load_or_fetch_event(&eid, None).await {
            Ok(e) => e,
            Err(_) => {
                out.push(PinnedMessagePreview {
                    event_id: id.to_string(),
                    sender: String::new(),
                    preview: "Could not load message".to_string(),
                });
                continue;
            }
        };

        let raw: AnySyncTimelineEvent = match ev.kind.raw().deserialize() {
            Ok(r) => r,
            Err(_) => {
                out.push(PinnedMessagePreview {
                    event_id: id.to_string(),
                    sender: String::new(),
                    preview: "Unsupported event".to_string(),
                });
                continue;
            }
        };

        let (sender, preview) = match raw {
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(msg)) => {
                match msg {
                    SyncMessageLikeEvent::Redacted(_) => {
                        (String::new(), "Deleted message".to_string())
                    }
                    SyncMessageLikeEvent::Original(o) => {
                        let sender = o.sender.to_string();
                        let ext = extract_message_display(&o.content);
                        let mut preview_base = ext.body.clone();
                        if let Some(t) = &ext.unsupported_matrix_msgtype {
                            preview_base = format!("{preview_base} · {t}");
                        }
                        let preview = if preview_base.chars().count() > 120 {
                            format!("{}…", preview_base.chars().take(120).collect::<String>())
                        } else {
                            preview_base
                        };
                        (sender, preview)
                    }
                }
            }
            _ => (String::new(), "Unsupported message".to_string()),
        };

        let display_sender = if !sender.is_empty() {
            if let Ok(uid) = UserId::parse(&sender) {
                match room.get_member_no_sync(&uid).await {
                    Ok(Some(m)) => m
                        .display_name()
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| sender.clone()),
                    _ => sender.clone(),
                }
            } else {
                sender.clone()
            }
        } else {
            String::new()
        };

        out.push(PinnedMessagePreview {
            event_id: id.to_string(),
            sender: display_sender,
            preview,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn pin_room_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let eid = EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    let mut pinned = current_pinned_event_ids(&room).await?;
    if pinned.iter().any(|e| e == &eid) {
        return Ok(());
    }
    pinned.push(eid);
    room.send_state_event(RoomPinnedEventsEventContent::new(pinned))
        .await
        .map_err(|e| format!("Failed to pin message: {}", fmt_error_chain(&e)))?;
    Ok(())
}

#[tauri::command]
pub async fn unpin_room_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let eid = EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    let mut pinned = current_pinned_event_ids(&room).await?;
    let before = pinned.len();
    pinned.retain(|e| e != &eid);
    if pinned.len() == before {
        return Ok(());
    }
    room.send_state_event(RoomPinnedEventsEventContent::new(pinned))
        .await
        .map_err(|e| format!("Failed to unpin message: {}", fmt_error_chain(&e)))?;
    Ok(())
}

#[tauri::command]
pub async fn get_messages_around_event(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
) -> Result<MessageBatch, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let eid = EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    let response = room
        .event_with_context(&eid, false, UInt::from(15u32), None)
        .await
        .map_err(|e| format!("Failed to load message context: {}", fmt_error_chain(&e)))?;

    let mut ordered: Vec<TimelineEvent> = response.events_before.into_iter().rev().collect();
    if let Some(ev) = response.event {
        ordered.push(ev);
    }
    ordered.extend(response.events_after);

    let avatar_cache = state.avatar_cache.clone();
    let mut messages =
        build_message_infos_from_timeline_events(&room, ordered, &avatar_cache).await?;
    messages.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(MessageBatch {
        messages,
        prev_batch: response.prev_batch_token,
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
pub async fn send_room_reaction(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    target_event_id: String,
    emoji: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let target = EventId::parse(&target_event_id).map_err(|e| format!("Invalid event ID: {e}"))?;
    let trimmed = emoji.trim();
    if trimmed.is_empty() {
        return Err("Empty reaction.".to_string());
    }

    let content = ReactionEventContent::new(Annotation::new(target.into(), trimmed.to_owned()));
    room.send(content)
        .await
        .map_err(|e| format!("Failed to send reaction: {}", fmt_error_chain(&e)))?;

    Ok(())
}

/// Redact the current user's `m.reaction` with a given key on a message, if it exists.
#[tauri::command]
pub async fn remove_room_reaction(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    target_event_id: String,
    key: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let me = client.user_id().ok_or("Not logged in")?;

    let target: OwnedEventId =
        EventId::parse(&target_event_id).map_err(|e| format!("Invalid event ID: {e}"))?;
    let key = key.trim();
    if key.is_empty() {
        return Err("Empty reaction key.".to_string());
    }

    // Use `AllRelations` — some homeservers' annotation-filtered relations endpoint
    // omits or mis-orders m.reaction; we filter in-process.
    let mut from_token: Option<String> = None;
    loop {
        let mut opts = RelationsOptions {
            include_relations: IncludeRelations::AllRelations,
            limit: Some(UInt::from(200u32)),
            ..Default::default()
        };
        opts.from = from_token;

        let rels = room
            .relations(target.clone(), opts)
            .await
            .map_err(|e| format!("Failed to list reactions: {}", fmt_error_chain(&e)))?;

        for ev in rels.chunk {
            let raw: AnySyncTimelineEvent = match ev.raw().deserialize() {
                Ok(e) => e,
                Err(_) => continue,
            };
            let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Reaction(re)) = raw
            else {
                continue;
            };
            let SyncMessageLikeEvent::Original(o) = re else {
                continue;
            };
            if !user_id_strings_equal(o.sender.as_str(), me.as_str()) {
                continue;
            }
            if o.content.relates_to.event_id != target {
                continue;
            }
            if !reaction_keys_match(&o.content.relates_to.key, key) {
                continue;
            }
            let rid = o.event_id;
            room.redact(&rid, None, None)
                .await
                .map_err(|e| format!("Failed to remove reaction: {}", fmt_error_chain(&e)))?;
            return Ok(());
        }

        from_token = rels.next_batch_token;
        if from_token.is_none() {
            break;
        }
    }

    Err("You do not have a matching reaction to remove on this event.".to_string())
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
    let raw_unread_for_msg = state.raw_unread_messages.clone();
    let self_user_id_for_msg = client.user_id().map(|u| u.to_owned());
    client.add_event_handler(move |ev: OriginalSyncRoomMessageEvent, room: Room| {
        let app = app_handle.clone();
        let avatar_cache = avatar_cache.clone();
        let raw_unread = raw_unread_for_msg.clone();
        let self_uid = self_user_id_for_msg.clone();
        async move {
            // Bump the raw-message counter for any non-self, non-edit message.
            // `Relation::Replacement` is an edit (m.replace) — it shouldn't
            // bump a fresh-message counter.  All other relations (replies,
            // threads; reactions are a different event type) count.
            let is_self = self_uid.as_deref().is_some_and(|u| u == ev.sender);
            let is_edit = matches!(
                &ev.content.relates_to,
                Some(Relation::Replacement(_))
            );
            if !is_self && !is_edit {
                let mut map = raw_unread.lock().await;
                *map.entry(room.room_id().to_owned()).or_insert(0) += 1;
            }

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
                let json_u32 = |v: Option<u32>| {
                    v.map(|n| serde_json::Value::Number(serde_json::Number::from(n)))
                        .unwrap_or(serde_json::Value::Null)
                };
                let unsupported_matrix_msgtype = ext
                    .unsupported_matrix_msgtype
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
                    image_width: json_u32(ext.image_width),
                    image_height: json_u32(ext.image_height),
                    video_width: json_u32(ext.video_width),
                    video_height: json_u32(ext.video_height),
                    unsupported_matrix_msgtype,
                };
                let _ = app.emit("room-message-edit", payload);
                return;
            }

            let ext = extract_message_display(&ev.content);
            let mentioned_user_ids = extract_mentioned_user_ids(&ev.content);
            let reply_to = reply_to_from_message_relation(&ev.content.relates_to);
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

            // --- Extract structured m.mentions ---
            //
            // `RoomMessageEventContent` in ruma-common 0.17 doesn't expose
            // `m.mentions` as a public field on the struct, but the data IS
            // round-tripped through (de)serialization.  Re-serializing the
            // already-deserialized content to JSON and plucking the field is
            // cheap (in-memory, no network) and guaranteed to preserve
            // whatever the sending client included.
            //
            // This gives us the same mention signal the server uses for
            // push-rule highlight evaluation — aligning desktop notifications
            // with the red-badge mention count.
            let (mentions_me, room_ping) = {
                let mut me = false;
                let mut rp = false;
                if let Ok(val) = serde_json::to_value(&ev.content) {
                    if let Some(mentions) = val.get("m.mentions") {
                        if let Some(user_ids) =
                            mentions.get("user_ids").and_then(|v| v.as_array())
                        {
                            if let Some(uid) = self_uid.as_deref().map(|u| u.as_str()) {
                                me = user_ids
                                    .iter()
                                    .any(|v| v.as_str() == Some(uid));
                            }
                        }
                        if let Some(r) = mentions.get("room").and_then(|v| v.as_bool()) {
                            rp = r;
                        }
                    }
                }
                (me, rp)
            };

            let is_dm = room.is_direct().await.unwrap_or(false);

            log::debug!(
                "[sync] room-message room=…{} event={} sender={} mentions_me={} room_ping={} is_dm={}",
                short_room,
                ev.event_id,
                sender,
                mentions_me,
                room_ping,
                is_dm,
            );

            let payload = RoomMessagePayload {
                room_id,
                mentions_me,
                room_ping,
                is_dm,
                message: MessageInfo {
                    event_id: ev.event_id.to_string(),
                    sender,
                    sender_name,
                    body: ext.body,
                    timestamp,
                    avatar_url,
                    edited: false,
                    reply_to,
                    image_media_request: ext.image_media_request,
                    image_width: ext.image_width,
                    image_height: ext.image_height,
                    video_media_request: ext.video_media_request,
                    video_width: ext.video_width,
                    video_height: ext.video_height,
                    file_media_request: ext.file_media_request,
                    file_mime: ext.file_mime,
                    file_display_name: ext.file_display_name,
                    unsupported_matrix_msgtype: ext.unsupported_matrix_msgtype,
                    reactions: None,
                    mentioned_user_ids,
                },
            };
            let _ = app.emit("room-message", payload);
        }
    });

    // Incoming emoji reactions (m.reaction) — keep message rows in sync.
    let app_handle = app.clone();
    client.add_event_handler(
        move |ev: OriginalSyncMessageLikeEvent<ReactionEventContent>, room: Room| {
            let app = app_handle.clone();
            async move {
                let room_id = room.room_id().to_string();
                let payload = MessageReactionDeltaPayload {
                    room_id,
                    target_event_id: ev.content.relates_to.event_id.to_string(),
                    key: ev.content.relates_to.key.clone(),
                    sender: ev.sender.to_string(),
                    added: true,
                };
                let _ = app.emit("room-message-reaction", payload);
            }
        },
    );

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
                room_id: room_id.clone(),
                redacted_event_id: redacted_event_id.clone(),
            };
            let _ = app.emit("room-message-redacted", payload);

            if let Ok(eid) = EventId::parse(&redacted_event_id) {
                if let Ok(timeline_ev) = room.load_or_fetch_event(&eid, None).await {
                    if let Ok(AnySyncTimelineEvent::MessageLike(
                        AnySyncMessageLikeEvent::Reaction(r),
                    )) = timeline_ev.raw().deserialize()
                    {
                        if let SyncMessageLikeEvent::Original(o) = r {
                            let p = MessageReactionDeltaPayload {
                                room_id,
                                target_event_id: o.content.relates_to.event_id.to_string(),
                                key: o.content.relates_to.key.clone(),
                                sender: o.sender.to_string(),
                                added: false,
                            };
                            let _ = app.emit("room-message-reaction", p);
                        }
                    }
                }
            }
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
        let self_id = client.user_id().map(|u| u.to_string()).unwrap_or_default();
        client.add_event_handler(move |ev: OriginalSyncRoomMemberEvent, room: Room| {
            let state = state_h.clone();
            let app = app_h.clone();
            let gate = gate_h.clone();
            let self_id = self_id.clone();
            async move {
                if !gate.load(Ordering::Relaxed) {
                    return;
                }
                // Only self membership transitions affect the room list.
                // Skip other members' events and in-place updates while
                // already in the same membership state (e.g. avatar /
                // displayname edits).
                if ev.state_key.as_str() != self_id {
                    return;
                }
                let prev_membership = ev
                    .unsigned
                    .prev_content
                    .as_ref()
                    .map(|c| c.membership.clone());
                if prev_membership
                    .as_ref()
                    .map(|prev| prev == &ev.content.membership)
                    .unwrap_or(false)
                {
                    return;
                }

                let room_id = room.room_id().to_string();
                let _ = app.emit("rooms-changed", ());

                if ev.content.membership != MembershipState::Join {
                    return;
                }
                if prev_membership
                    .as_ref()
                    .map(|prev| prev == &MembershipState::Join)
                    .unwrap_or(false)
                {
                    return;
                }

                log::info!("[pax reconcile] self-joined {room_id}; reconciling");
                if let Err(e) = super::reconciler::reconcile_room(&state, &app, &room_id).await {
                    log::warn!("[pax reconcile] room-join reconcile failed {room_id}: {e}");
                }
            }
        });
    }

    // Watch m.room.member events for an avatar MXC change and tell the
    // frontend to drop its cached entry for that user. We do NOT prefetch
    // bytes here: initial sync delivers hundreds of member events and
    // prefetching all of them swamps the homeserver (and the UI thread)
    // — a freeze of several seconds on the home space was traced back
    // to exactly this. The frontend store refetches lazily through the
    // batched `get_user_avatars` command when a visible `<UserAvatar>`
    // actually needs the user.
    //
    // We also require `prev_content` to exist so we only react to real
    // changes, not to the initial-state firehose. A brand-new member we
    // see for the first time will be resolved on demand the moment a
    // component mounts for them.
    {
        let app_h = app.clone();
        let gate_h = reconcile_gate.clone();
        client.add_event_handler(move |ev: OriginalSyncRoomMemberEvent, _room: Room| {
            let app = app_h.clone();
            let gate = gate_h.clone();
            async move {
                if !gate.load(Ordering::Relaxed) {
                    return;
                }
                if ev.content.membership != MembershipState::Join {
                    return;
                }
                let Some(prev) = ev.unsigned.prev_content.as_ref() else {
                    return;
                };
                let new_mxc = ev.content.avatar_url.as_ref().map(|u| u.to_string());
                let prev_mxc = prev.avatar_url.as_ref().map(|u| u.to_string());
                if new_mxc == prev_mxc {
                    return;
                }
                let user_id = ev.state_key.as_str().to_string();
                let _ = app.emit(
                    "user-avatar-invalidated",
                    serde_json::json!({ "userId": user_id }),
                );
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
                    let _ = app.emit("rooms-changed", ());
                    log::info!(
                        "[pax reconcile] m.space.child changed in {space_id}; reconciling children"
                    );
                    if let Err(e) =
                        super::reconciler::reconcile_rooms_for_space(&state, &app, &space_id).await
                    {
                        log::warn!("[pax reconcile] space-child reconcile failed {space_id}: {e}");
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
                let _ = app.emit("rooms-changed", ());
                log::info!("[pax reconcile] m.direct changed; reconciling all rooms");
                if let Err(e) = super::reconciler::reconcile_all(&state, &app).await {
                    log::warn!("[pax reconcile] m.direct reconcile failed: {e}");
                }
            }
        });
    }

    // Read-receipt handler — clears the raw-message counter for a room
    // whenever a receipt for our MXID arrives.  This covers two paths:
    //
    //   * Our own `send_single_receipt` echoes back through sync; that's
    //     harmless because `send_room_read_receipt` already cleared the
    //     counter locally.
    //   * Another device of ours (Element mobile, Cinny, etc.) reads the
    //     room; the receipt syncs down and we need to drop our local
    //     unread indicator.  The matrix-sdk `num_unread_*` fields will
    //     also drop to zero on the same sync, so `from_room_with_raw`
    //     needs us to clear our counter to report `messages=0`.
    //
    // The handler filters by MXID so other users' receipts don't reset
    // our counter — they read the room, we haven't.
    {
        let raw_unread = state.raw_unread_messages.clone();
        let self_uid = client.user_id().map(|u| u.to_owned());
        client.add_event_handler(
            move |ev: matrix_sdk::ruma::events::receipt::SyncReceiptEvent, room: Room| {
                let raw_unread = raw_unread.clone();
                let self_uid = self_uid.clone();
                async move {
                    let Some(me) = self_uid else { return };
                    // `ev.content.0` is `EventId → ReceiptType → UserId → Receipt`.
                    // We just need to know "was there any receipt for our MXID
                    // anywhere in this event?"  One walk is enough.
                    let mine = ev
                        .content
                        .0
                        .values()
                        .flat_map(|by_type| by_type.values())
                        .any(|by_user| by_user.contains_key(&me));
                    if mine {
                        raw_unread.lock().await.remove(room.room_id());
                    }
                }
            },
        );
    }

    // Clone shared state needed inside the sync loop.
    let presence_map = state.presence_map.clone();
    let status_msg_map = state.status_msg_map.clone();
    let avatar_cache = state.avatar_cache.clone();
    let voice_client = client.clone();
    let desired_presence = state.desired_presence.clone();
    let unread_cache = state.unread_cache.clone();
    let raw_unread = state.raw_unread_messages.clone();
    let reconcile_state_arc = state_arc.clone();
    let reconcile_gate_for_loop = reconcile_gate.clone();
    let self_user_id = client.user_id().map(|u| u.to_string()).unwrap_or_default();

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
            let settings =
                matrix_sdk::config::SyncSettings::default().set_presence(set_presence_value);

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
                        log::warn!("[pax reconcile] initial sync-ready reconcile failed: {e}");
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
                        matrix_sdk::ruma::presence::PresenceState::Unavailable => "unavailable",
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

            // Emit per-room unread diffs since last iteration.  Pure in-memory
            // reads (RwLock) — cheap even for hundreds of rooms.  See
            // `commands::unread` for why we poll instead of subscribing to
            // `room_info_notable_update_receiver`.
            super::unread::emit_unread_snapshot_if_changed(
                &client,
                &unread_cache,
                &raw_unread,
                &app,
            )
            .await;

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

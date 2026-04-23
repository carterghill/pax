use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::TryStreamExt;
use serde::Serialize;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::time::MissedTickBehavior;
use tokio_util::io::ReaderStream;

use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::IncludeRelations;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::room::RelationsOptions;
use matrix_sdk::ruma::events::direct::DirectEventContent;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::member::OriginalSyncRoomMemberEvent;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::events::reaction::ReactionEventContent;
use matrix_sdk::ruma::events::room::redaction::OriginalSyncRoomRedactionEvent;
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::events::relation::Annotation;
use matrix_sdk::ruma::events::OriginalSyncMessageLikeEvent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::events::AnySyncMessageLikeEvent;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::GlobalAccountDataEvent;
use matrix_sdk::ruma::events::MessageLikeEventType;
use matrix_sdk::ruma::events::OriginalSyncStateEvent;
use matrix_sdk::ruma::events::SyncMessageLikeEvent;
use matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent;
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings, UniqueKey};
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::UserId;
use matrix_sdk::ruma::UInt;
use matrix_sdk::Client;
use matrix_sdk::Room;
use reqwest::header::{HeaderValue, CONTENT_LENGTH};
use reqwest::Version;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::types::{
    MessageBatch, MessageEditPayload, MessageInfo, MessageReactionDeltaPayload, MessageRedactedPayload,
    MessageReactionSummary, PinnedMessagePreview, PresencePayload, RoomMessagePayload, RoomPinPermission,
    RoomRedactionPolicy, RoomSendPermission, TypingPayload, VoiceParticipantsChangedPayload,
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
    Redact { ts: u64, redacts: String },
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
            let reactions = reaction_map.get(&m.event_id).cloned();
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
                reactions,
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
            log::warn!("load_pinned_events failed: {}; using cache", fmt_error_chain(&e));
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
            let reactions = reaction_map.get(&m.event_id).cloned();
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
                reactions,
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
                    SyncMessageLikeEvent::Redacted(_) => (String::new(), "Deleted message".to_string()),
                    SyncMessageLikeEvent::Original(o) => {
                        let sender = o.sender.to_string();
                        let body = extract_message_display(&o.content).body;
                        let preview = if body.chars().count() > 120 {
                            format!("{}…", body.chars().take(120).collect::<String>())
                        } else {
                            body
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
    let mut messages = build_message_infos_from_timeline_events(&room, ordered, &avatar_cache).await?;
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
    let self_user_id_for_msg = client
        .user_id()
        .map(|u| u.to_owned());
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
                    reactions: None,
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
                    if let Ok(AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Reaction(
                        r,
                    ))) = timeline_ev.raw().deserialize()
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
            super::unread::emit_unread_snapshot_if_changed(&client, &unread_cache, &raw_unread, &app).await;

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

    if let Some(existing) = state.avatar_cache.get(&cache_key).await {
        if existing.starts_with("data:") {
            state.avatar_cache.remove(&cache_key).await;
        } else if std::path::Path::new(&existing).is_file() {
            return Ok(existing);
        } else {
            state.avatar_cache.remove(&cache_key).await;
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
        .insert(cache_key, path_str.clone())
        .await;

    Ok(path_str)
}

/// Evict cached attachment temp files and their cache entries on room
/// switch.  Attachments (images/videos/files in message bodies) can be
/// large and there's no reason to keep the previous room's attachments
/// around while the user is looking at a different room.
///
/// **Avatars are deliberately NOT cleared here.**  They are tiny, shared
/// across every view (sidebar, home space, chat header, settings,
/// voice call, …), and cheap to keep.  Wiping them on room switch
/// broke every `<img>` currently on screen — the sidebar and DM banner
/// would 404 the moment the user clicked a room, forcing a cascade of
/// re-fetches, retries, and visible "avatar → initials → avatar-at-
/// different-resolution" flashes.  Keep avatars alive for the session;
/// they get evicted naturally on logout and on startup (see `lib.rs`).
#[tauri::command]
pub async fn clear_media_cache(
    state: State<'_, Arc<AppState>>,
) -> Result<u32, String> {
    // Evict only the `mmedia:` entries — avatars (persistent on disk,
    // tiny, shared across every view) are deliberately preserved so
    // we don't cascade 404s into every on-screen `<img>` the moment
    // the user switches rooms.
    let evicted = state.avatar_cache.remove_by_prefix("mmedia:").await.len();

    let temp_dir = super::temp_dir();
    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if n.starts_with("pax_matrix_media_") {
                if std::fs::remove_file(entry.path()).is_ok() {
                    deleted += 1;
                }
            }
        }
    }

    if evicted > 0 || deleted > 0 {
        log::info!(
            "[clear_media_cache] evicted {} attachment entries, deleted {} temp files (avatars preserved)",
            evicted,
            deleted,
        );
    }
    Ok(deleted)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomFileUploadProgressEvent {
    pub upload_id: String,
    pub room_id: String,
    pub sent: u64,
    pub total: u64,
}

fn build_file_room_message(
    mxc_uri: matrix_sdk::ruma::OwnedMxcUri,
    file_name: String,
    content_type: mime::Mime,
    file_size: Option<UInt>,
    caption: Option<String>,
) -> RoomMessageEventContent {
    use matrix_sdk::ruma::events::room::message::MessageType;
    use matrix_sdk::ruma::events::room::MediaSource;

    let body_text = caption
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
        .unwrap_or_else(|| file_name.clone());
    let has_caption = caption.as_deref().map_or(false, |c| !c.is_empty());

    if content_type.type_() == mime::IMAGE {
        use matrix_sdk::ruma::events::room::message::ImageMessageEventContent;
        use matrix_sdk::ruma::events::room::ImageInfo;

        let mut info = ImageInfo::new();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;

        let mut img = ImageMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
        img.info = Some(Box::new(info));
        if has_caption {
            img.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Image(img))
    } else if content_type.type_() == mime::VIDEO {
        use matrix_sdk::ruma::events::room::message::VideoMessageEventContent;

        let mut vid = VideoMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
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

        let mut aud = AudioMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
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

        let mut file_msg = FileMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
        let mut info = file_msg.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        file_msg.info = Some(info);
        if has_caption {
            file_msg.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::File(file_msg))
    }
}

fn validate_upload_id(upload_id: &str) -> Result<(), String> {
    if upload_id.is_empty() || upload_id.len() > 200 {
        return Err("Invalid upload id".to_string());
    }
    if !upload_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid upload id".to_string());
    }
    Ok(())
}

fn room_file_staging_path(upload_id: &str) -> PathBuf {
    super::temp_dir().join(format!("pax_upload_staging_{upload_id}.bin"))
}

/// Truncate / create the staging file for an upload (call before chunked appends).
#[tauri::command]
pub async fn room_file_staging_reset(upload_id: String) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let path = room_file_staging_path(&upload_id);
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .await
        .map_err(|e| format!("staging reset: {e}"))?;
    f.flush().await.map_err(|e| format!("staging reset: {e}"))?;
    Ok(())
}

/// Append one base64 chunk (from the webview) to the staging file — avoids multi‑GiB IPC payloads.
#[tauri::command]
pub async fn room_file_staging_append_b64(upload_id: String, chunk_b64: String) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let chunk = data_encoding::BASE64
        .decode(chunk_b64.as_bytes())
        .map_err(|e| format!("chunk base64: {e}"))?;
    let path = room_file_staging_path(&upload_id);
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("staging append: {e}"))?;
    f.write_all(&chunk)
        .await
        .map_err(|e| format!("staging append: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn room_file_staging_byte_len(upload_id: String) -> Result<u64, String> {
    validate_upload_id(&upload_id)?;
    let path = room_file_staging_path(&upload_id);
    match tokio::fs::metadata(&path).await {
        Ok(m) => Ok(m.len()),
        Err(_) => Ok(0),
    }
}

#[tauri::command]
pub async fn room_file_staging_remove(upload_id: String) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let path = room_file_staging_path(&upload_id);
    let _ = tokio::fs::remove_file(&path).await;
    Ok(())
}

fn ruma_uint_to_u64(u: UInt) -> u64 {
    i128::from(u) as u64
}

fn format_upload_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let x = n as f64;
    if x >= GB {
        format!("{:.2} GiB", x / GB)
    } else if x >= MB {
        format!("{:.2} MiB", x / MB)
    } else if x >= KB {
        format!("{:.2} KiB", x / KB)
    } else {
        format!("{n} bytes")
    }
}

async fn matrix_reported_max_upload_bytes(client: &Client) -> Option<u64> {
    match client.load_or_fetch_max_upload_size().await {
        Ok(u) => Some(ruma_uint_to_u64(u)),
        Err(e) => {
            log::warn!(
                "Could not fetch Matrix media upload limit (m.upload.size): {}",
                fmt_error_chain(&e)
            );
            None
        }
    }
}

/// Bytes for a single media upload as reported by the homeserver (`m.upload.size` from
/// `GET /_matrix/client/v1/media/config`, with legacy fallback). `None` means the client could
/// not retrieve a limit (still logged in). Uses the Matrix SDK cache after the first fetch.
#[tauri::command]
pub async fn get_matrix_max_upload_bytes(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<u64>, String> {
    let client = get_client(&state).await?;
    Ok(matrix_reported_max_upload_bytes(&client).await)
}

async fn upload_room_file_from_staging_path(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: &str,
    upload_id: &str,
    file_name: &str,
    mime_type: &str,
    staging_path: &std::path::Path,
) -> Result<(String, u64), String> {
    let client = get_client(state).await?;

    let meta = tokio::fs::metadata(staging_path)
        .await
        .map_err(|e| format!("staging metadata: {e}"))?;
    let total = meta.len();

    if total > 0 {
        if let Some(max_b) = matrix_reported_max_upload_bytes(&client).await {
            if total > max_b {
                return Err(format!(
                    "This file is {} but your homeserver only allows {} per upload (Matrix m.upload.size). \
                     Use a smaller file or ask the admin to raise the media upload limit.",
                    format_upload_bytes(total),
                    format_upload_bytes(max_b),
                ));
            }
        }
    }

    let _ = app.emit(
        "room-file-upload-progress",
        RoomFileUploadProgressEvent {
            upload_id: upload_id.to_string(),
            room_id: room_id.to_string(),
            sent: 0,
            total,
        },
    );

    let content_type: mime::Mime = mime_type
        .parse()
        .unwrap_or(mime::APPLICATION_OCTET_STREAM);

    log::info!(
        "[Pax Upload] file={} mime={} size={} (stream from disk)",
        file_name,
        content_type,
        total
    );

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let upload_url = format!(
        "{}/_matrix/media/v3/upload?filename={}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(file_name),
    );

    let sent_progress = Arc::new(AtomicU64::new(0));
    let stop_progress_emit = Arc::new(AtomicBool::new(false));

    let progress_task = if total > 0 {
        let app = app.clone();
        let uid = upload_id.to_string();
        let rid = room_id.to_string();
        let sent_progress = sent_progress.clone();
        let stop = stop_progress_emit.clone();
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                interval.tick().await;
                let sent = sent_progress.load(Ordering::Relaxed);
                let _ = app.emit(
                    "room-file-upload-progress",
                    RoomFileUploadProgressEvent {
                        upload_id: uid.clone(),
                        room_id: rid.clone(),
                        sent,
                        total,
                    },
                );
            }
        }))
    } else {
        None
    };

    let stream_body = if total == 0 {
        reqwest::Body::from(Vec::new())
    } else {
        let file = tokio::fs::File::open(staging_path)
            .await
            .map_err(|e| format!("staging open for upload: {e}"))?;
        let reader = BufReader::new(file);
        let sp = sent_progress.clone();
        let stream = ReaderStream::with_capacity(reader, 48 * 1024).map_ok(move |b: Bytes| {
            sp.fetch_add(b.len() as u64, Ordering::Relaxed);
            b
        });
        reqwest::Body::wrap_stream(stream)
    };

    // Assume ≥64 KiB/s effective throughput so huge files get enough wall time; cap at 24h.
    let timeout_secs = if total == 0 {
        120
    } else {
        total
            .saturating_div(64 * 1024)
            .max(900)
            .min(86_400)
    };

    let content_length = HeaderValue::from_str(&total.to_string())
        .map_err(|e| format!("Invalid Content-Length: {e}"))?;

    let upload_outcome: Result<(String, u64), String> = async {
        let resp = state
            .http_client
            .post(&upload_url)
            .version(Version::HTTP_11)
            .timeout(Duration::from_secs(timeout_secs))
            .bearer_auth(access_token.to_string())
            .header("Content-Type", content_type.to_string())
            .header(CONTENT_LENGTH, content_length)
            .body(stream_body)
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

        log::info!(
            "[Pax Upload] uploaded → {}",
            upload_result.content_uri
        );

        Ok((upload_result.content_uri, total))
    }
    .await;

    stop_progress_emit.store(true, Ordering::Release);
    if let Some(t) = progress_task {
        let _ = t.await;
    }

    if upload_outcome.is_ok() && total > 0 {
        let _ = app.emit(
            "room-file-upload-progress",
            RoomFileUploadProgressEvent {
                upload_id: upload_id.to_string(),
                room_id: room_id.to_string(),
                sent: total,
                total,
            },
        );
    }

    upload_outcome
}

async fn upload_room_file_staged_impl(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: &str,
    upload_id: &str,
    file_name: &str,
    mime_type: &str,
) -> Result<(String, u64), String> {
    validate_upload_id(upload_id)?;
    let path = room_file_staging_path(upload_id);
    if !path.exists() {
        return Err("Upload staging file missing (finish copying first)".to_string());
    }
    let r = upload_room_file_from_staging_path(
        app,
        state,
        room_id,
        upload_id,
        file_name,
        mime_type,
        &path,
    )
    .await;
    let _ = tokio::fs::remove_file(&path).await;
    r
}

async fn send_file_message_impl(
    state: &Arc<AppState>,
    room_id: &str,
    content_uri: &str,
    file_name: &str,
    mime_type: &str,
    file_size_bytes: Option<u64>,
    caption: Option<&str>,
) -> Result<String, String> {
    let client = get_client(state).await?;
    let room = resolve_room(&client, room_id)?;

    let mxc_uri = matrix_sdk::ruma::OwnedMxcUri::from(content_uri);

    let content_type: mime::Mime = mime_type
        .parse()
        .unwrap_or(mime::APPLICATION_OCTET_STREAM);

    let file_size = file_size_bytes.and_then(|n| UInt::try_from(n).ok());

    let content = build_file_room_message(
        mxc_uri,
        file_name.to_string(),
        content_type,
        file_size,
        caption.map(|s| s.to_string()),
    );

    let response = room
        .send(content)
        .await
        .map_err(|e| format!("Failed to send file message: {}", fmt_error_chain(&e)))?;

    Ok(response.event_id.to_string())
}

/// Upload only (emits `room-file-upload-progress`). Reads bytes from the on-disk staging file
/// built with `room_file_staging_reset` + `room_file_staging_append_b64`. Returns `(content_uri, byte_size)`.
#[tauri::command]
pub async fn upload_room_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    room_id: String,
    upload_id: String,
    file_name: String,
    mime_type: String,
) -> Result<(String, u64), String> {
    upload_room_file_staged_impl(&app, &state, &room_id, &upload_id, &file_name, &mime_type).await
}

/// Send a previously uploaded MXC as an `m.room.message`. Returns the event id.
#[tauri::command]
pub async fn send_file_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    content_uri: String,
    file_name: String,
    mime_type: String,
    file_size: Option<u64>,
    caption: Option<String>,
) -> Result<String, String> {
    send_file_message_impl(
        &state,
        &room_id,
        &content_uri,
        &file_name,
        &mime_type,
        file_size,
        caption.as_deref(),
    )
    .await
}

/// Upload a file to the Matrix media repo and send it as an `m.room.message`.
///
/// `data` is full base64 (legacy / small payloads). Decodes to a staging file on disk, then
/// streams to Matrix — avoids holding the decoded file in RAM. Prefer chunked staging from the UI for large files.
#[tauri::command]
pub async fn upload_and_send_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    room_id: String,
    file_name: String,
    mime_type: String,
    data: String,
    caption: Option<String>,
) -> Result<(), String> {
    let upload_id = uuid::Uuid::new_v4().to_string();
    validate_upload_id(&upload_id)?;

    let uid = upload_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut decoder = base64::read::DecoderReader::new(
            std::io::Cursor::new(data.as_bytes()),
            &base64::engine::general_purpose::STANDARD,
        );
        let path = room_file_staging_path(&uid);
        let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        std::io::copy(&mut decoder, &mut out).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("staging join: {e}"))??;

    let (content_uri, byte_size) =
        upload_room_file_staged_impl(&app, &state, &room_id, &upload_id, &file_name, &mime_type)
            .await?;

    let _ = send_file_message_impl(
        &state,
        &room_id,
        &content_uri,
        &file_name,
        &mime_type,
        Some(byte_size),
        caption.as_deref(),
    )
    .await?;

    Ok(())
}
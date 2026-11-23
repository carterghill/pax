use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use matrix_sdk::deserialized_responses::{EncryptionInfo, TimelineEvent, TimelineEventKind};
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::reply::{EnforceThread, Reply};
use matrix_sdk::room::IncludeRelations;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::room::RelationsOptions;
use matrix_sdk::ruma::events::direct::DirectEventContent;
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEvent;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::reaction::ReactionEventContent;
use matrix_sdk::ruma::events::relation::Annotation;
use matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent;
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
use matrix_sdk::ruma::events::AnySyncStateEvent;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::GlobalAccountDataEvent;
use matrix_sdk::ruma::events::Mentions;
use matrix_sdk::ruma::events::MessageLikeEventType;
use matrix_sdk::ruma::events::OriginalSyncMessageLikeEvent;
use matrix_sdk::ruma::events::OriginalSyncStateEvent;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::SyncMessageLikeEvent;
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::UInt;
use matrix_sdk::ruma::UserId;
use matrix_sdk::Room;
use tauri::{Emitter, State};
use tokio::time::{timeout_at, Duration, Instant};

use crate::types::{
    MessageBatch, MessageEditPayload, MessageInfo, MessageReactionDeltaPayload,
    MessageReactionSummary, MessageRedactedPayload, MessageReplyTo, MessageThreadSummary,
    PinnedMessagePreview, PresencePayload, RoomMembersChangedPayload, RoomMessagePayload,
    RoomPinPermission, RoomRedactionPolicy, RoomSendPermission, RoomTimelineNoticePayload,
    TypingPayload, VoiceParticipantsInvalidatedPayload,
};
use crate::AppState;

use super::ignored_users::{hides_event, IgnoredUserIds};
use super::message_display::{
    extract_message_display, membership_notice,
    reply_to_from_message_relation, thread_root_from_message_relation, thread_summary_from_bundle,
    MessageDisplayExtract, MessageThreadTarget,
};
use super::{
    direct_calls::{call_notice, CALL_EVENT},
    fmt_error_chain, get_client, resolve_room,
};

const TIMELINE_KEY_WAIT: Duration = Duration::from_millis(750);

pub(super) async fn retry_timeline_decryption(
    room: &Room,
    events: &mut [TimelineEvent],
    ignored: &IgnoredUserIds,
    deadline: &mut Option<Instant>,
) {
    if deadline.is_some_and(|end| end <= Instant::now()) {
        return;
    }
    let mut pending: Vec<_> = events
        .iter_mut()
        .filter(|event| {
            matches!(&event.kind, TimelineEventKind::UnableToDecrypt { utd_info, .. }
                if utd_info.reason.is_missing_room_key() && utd_info.session_id.is_some())
                && !hides_event(ignored, event.raw())
        })
        .collect();
    if pending.is_empty() {
        return;
    }

    // The SDK has already tried the local keys and queued any backup downloads.
    // Share one grace period across the pages of this history request.
    let deadline = *deadline.get_or_insert_with(|| Instant::now() + TIMELINE_KEY_WAIT);
    let Some(keys) = room.client().encryption().room_keys_received_stream().await else {
        return;
    };
    futures_util::pin_mut!(keys);
    // Retry once after subscribing in case a key arrived since the SDK's first attempt.
    let mut received_sessions: Option<HashSet<String>> = None;
    loop {
        for event in &mut pending {
            if received_sessions.as_ref().is_some_and(|sessions| {
                !event.kind.session_id().is_some_and(|id| sessions.contains(id))
            }) {
                continue;
            }
            let encrypted = event.raw().cast_ref_unchecked::<OriginalSyncRoomEncryptedEvent>();
            match room.decrypt_event(encrypted, None).await {
                Ok(decrypted) if matches!(decrypted.kind, TimelineEventKind::Decrypted(_)) => {
                    event.kind = decrypted.kind;
                }
                _ => {}
            }
        }
        pending.retain(|event| event.kind.is_utd());
        if pending.is_empty() || Instant::now() >= deadline {
            return;
        }
        received_sessions = match timeout_at(deadline, keys.next()).await {
            Ok(Some(Ok(keys))) => Some(
                keys.into_iter()
                    .filter(|key| key.room_id == room.room_id())
                    .map(|key| key.session_id)
                    .collect(),
            ),
            Ok(Some(Err(_))) => None, // A lagged stream may have skipped a key we need.
            _ => return,
        };
    }
}

/// Keep the envelope's public metadata when the SDK cannot decrypt an event.
/// Never expose ciphertext as message text or confuse redactions with missing keys.
pub(super) fn unavailable_message(raw: &serde_json::value::RawValue) -> Option<MessageInfo> {
    let event: serde_json::Value = serde_json::from_str(raw.get()).ok()?;
    if event["type"] != "m.room.encrypted"
        || event["unsigned"].get("redacted_because").is_some()
        || event["content"]["algorithm"].as_str().is_none()
        || matches!(
            event["content"]["m.relates_to"]["rel_type"].as_str(),
            Some("m.replace" | "m.annotation")
        )
    {
        return None;
    }
    let event_id = EventId::parse(event["event_id"].as_str()?)
        .ok()?
        .to_string();
    let sender = UserId::parse(event["sender"].as_str()?).ok()?.to_string();
    Some(MessageInfo {
        decryption_failed: true,
        membership_notice: None,
        direct_call_notice: None,
        event_id,
        sender,
        sender_name: None,
        body: "Message unavailable on this device".into(),
        timestamp: event["origin_server_ts"].as_u64()?,
        avatar_url: None,
        edited: false,
        reply_to: None,
        thread_root_id: (event["content"]["m.relates_to"]["rel_type"] == "m.thread")
            .then(|| event["content"]["m.relates_to"]["event_id"].as_str())
            .flatten()
            .and_then(|id| EventId::parse(id).ok())
            .map(|id| id.to_string()),
        thread_summary: None,
        image_media_request: None,
        image_width: None,
        image_height: None,
        image_blurhash: None,
        video_media_request: None,
        video_width: None,
        video_height: None,
        file_media_request: None,
        file_mime: None,
        file_display_name: None,
        unsupported_matrix_msgtype: None,
        reactions: None,
        formatted_body: None,
        mentioned_user_ids: None,
        mentions_room: false,
    })
}

fn timeline_membership_notice(event: &AnySyncTimelineEvent) -> Option<MessageInfo> {
    let AnySyncTimelineEvent::State(AnySyncStateEvent::RoomMember(SyncStateEvent::Original(
        member,
    ))) = event else {
        return None;
    };
    membership_notice(member)
}

#[cfg(test)]
mod membership_notice_tests {
    use super::timeline_membership_notice;
    use crate::types::MembershipNoticeAction as Action;
    use matrix_sdk::ruma::events::AnySyncTimelineEvent;
    use serde_json::{json, Value};

    fn member_event(sender: &str, previous: Option<&str>, membership: &str) -> Value {
        json!({
            "type": "m.room.member",
            "event_id": "$membership",
            "origin_server_ts": 42,
            "sender": sender,
            "state_key": "@bob:example.org",
            "content": { "membership": membership, "reason": "Room rules" },
            "unsigned": { "prev_content": previous.map(|value| json!({
                "membership": value, "displayname": "Bob"
            })) },
        })
    }

    #[test]
    fn membership_notice_distinguishes_removals_from_other_transitions() {
        let bob = "@bob:example.org";
        let alice = "@alice:example.org";
        for (sender, previous, membership, expected) in [
            (bob, None, "join", Action::Joined),
            (bob, Some("invite"), "join", Action::Joined),
            (bob, Some("join"), "leave", Action::Left),
            (alice, Some("join"), "leave", Action::Kicked),
            (alice, Some("invite"), "leave", Action::InviteRevoked),
            (bob, Some("invite"), "leave", Action::InviteDeclined),
            (alice, Some("leave"), "invite", Action::Invited),
            (alice, Some("join"), "ban", Action::Banned),
            (alice, Some("ban"), "leave", Action::Unbanned),
            (bob, Some("leave"), "knock", Action::Knocked),
            (alice, Some("knock"), "invite", Action::KnockAccepted),
            (alice, Some("knock"), "leave", Action::KnockDenied),
        ] {
            let event: AnySyncTimelineEvent =
                serde_json::from_value(member_event(sender, previous, membership)).unwrap();
            let message = timeline_membership_notice(&event).unwrap();
            let notice = message.membership_notice.unwrap();

            assert_eq!(notice.action, expected);
            assert_eq!(notice.target_user_id, bob);
            assert_eq!(notice.target_name.as_deref(), previous.map(|_| "Bob"));
            assert_eq!(notice.reason.as_deref(), Some("Room rules"));
            assert_eq!(message.sender, sender);
            assert_eq!(message.event_id, "$membership");
            assert_eq!(message.timestamp, 42);
        }
    }

    #[test]
    fn membership_notice_skips_profile_updates_and_redactions() {
        let mut profile = member_event("@bob:example.org", Some("join"), "join");
        profile["content"]["displayname"] = json!("Robert");
        assert!(timeline_membership_notice(&serde_json::from_value(profile).unwrap()).is_none());

        let mut redacted = member_event("@alice:example.org", Some("join"), "ban");
        redacted["content"] = json!({ "membership": "ban" });
        redacted["unsigned"] = json!({ "redacted_because": {
            "type": "m.room.redaction", "event_id": "$redaction",
            "origin_server_ts": 43, "sender": "@alice:example.org",
            "content": { "redacts": "$membership" }
        } });
        assert!(timeline_membership_notice(&serde_json::from_value(redacted).unwrap()).is_none());
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
    Redact {
        ts: u64,
        redacts: String,
    },
}

/// Build per-target reaction summaries from timeline events (chronological fold with redactions).
fn aggregate_reactions_from_timeline(
    events: &[TimelineEvent],
    my_user_id: Option<&UserId>,
    ignored_users: &IgnoredUserIds,
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
                    if ignored_users.contains(&o.sender) {
                        continue;
                    }
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
    let (ignore_list_revision, ignored) = state.ignored_users.snapshot(&client).await;

    let avatars = state.avatars.clone();
    let encrypted_room = room.encryption_state().is_encrypted();
    let mut rss = super::rss::activity::Filter::for_room(&room).await;

    // First pass: extract message data and collect unique senders
    struct RawMsg {
        position: usize,
        event_id: String,
        sender: String,
        timestamp: u64,
        display: MessageDisplayExtract,
        bundled_edit_ts: Option<u64>,
        reply_to: Option<MessageReplyTo>,
        thread_root_id: Option<String>,
        thread_summary: Option<MessageThreadSummary>,
    }
    let mut raw_msgs = Vec::new();
    let mut other_entries = Vec::new();
    let mut visible_calls = HashSet::new();
    let mut call_signal_count = 0;
    let mut unique_senders = Vec::new();
    let mut seen_senders = std::collections::HashSet::new();
    // target event id -> replacement fields + origin_server_ts; keep latest edit per target
    let mut latest_replacement: HashMap<(String, String), (u64, MessageDisplayExtract)> = HashMap::new();

    let mut current_from = from.clone();
    let mut pages_scanned: usize = 0;
    let mut timeline_event_count_total: usize = 0;
    let mut prev_batch: Option<String>;
    let mut events_for_reactions: Vec<TimelineEvent> = Vec::new();
    let mut decryption_deadline = None;

    // Cap on how many pages we'll walk in one `get_messages` call while looking
    // for enough visible messages.  With the end-token-based stop below we can
    // legitimately keep paging through filtered-but-non-empty pages (rooms with
    // a run of membership churn, reactions, redactions, etc. at the head), so
    // bound it to keep worst-case backend work predictable.  At limit=50 this
    // is up to ~1000 timeline events per call, which has always been enough in
    // practice.
    const MAX_PAGES_PER_CALL: usize = 20;

    // How many visible timeline entries we want to surface before
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
            mut chunk,
            end: pagination_end,
            ..
        } = response;

        retry_timeline_decryption(&room, &mut chunk, &ignored, &mut decryption_deadline).await;
        if let Some(filter) = &mut rss {
            filter.remember_commands(&chunk);
        }
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
        //   * the server didn't advance `end` past what we just sent.
        // An empty page can still advance when the server filters events.
        let end_advanced = pagination_end.as_deref() != current_from.as_deref();
        prev_batch = pagination_end.filter(|_| end_advanced);

        for event in chunk {
            let position = timeline_event_count_total;
            timeline_event_count_total += 1;
            if hides_event(&ignored, event.raw()) {
                continue;
            }
            if let Some(message) = unavailable_message(event.raw().json()) {
                let sender = UserId::parse(&message.sender).expect("validated sender");
                if seen_senders.insert(message.sender.clone()) {
                    unique_senders.push(sender);
                }
                other_entries.push((position, message));
                continue;
            }
            if let Some(notice) = call_notice(
                event.raw(),
                encrypted_room,
                event.kind.encryption_info().is_some(),
            ).or_else(|| super::matrix_voip::call_notice(event.raw(), &room, event.kind.encryption_info().is_some())) {
                if let Some(call) = &notice.direct_call_notice {
                    visible_calls.insert(call.call_id.clone());
                }
                call_signal_count += 1;
                other_entries.push((position, notice));
                continue;
            }
            let raw = match event.raw().deserialize() {
                Ok(e) => e,
                Err(_) => continue,
            };
            if let Some(notice) = timeline_membership_notice(&raw) {
                other_entries.push((position, notice));
                continue;
            }

            if let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
                matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(msg),
            ) = raw
            {
                let original = match msg {
                    matrix_sdk::ruma::events::SyncMessageLikeEvent::Original(o) => o,
                    _ => continue,
                };

                if let Some(filter) = &mut rss {
                    if filter.hides_message(&room, &original).await {
                        continue;
                    }
                }
                if let Some(Relation::Replacement(repl)) = &original.content.relates_to {
                    let target = (repl.event_id.to_string(), original.sender.to_string());
                    let ext = extract_message_display(&RoomMessageEventContent::from(
                        repl.new_content.clone(),
                    ));
                    let ts: u64 = original.origin_server_ts.0.into();
                    if latest_replacement.get(&target).is_none_or(|(previous_ts, _)| ts >= *previous_ts) {
                        latest_replacement.insert(target, (ts, ext));
                    }
                    continue;
                }

                let sender_str = original.sender.to_string();
                if seen_senders.insert(sender_str.clone()) {
                    unique_senders.push(original.sender.clone());
                }

                let (ext, bundled_edit_ts) = bundled_message_display(&original);
                let reply_to = reply_to_from_message_relation(&original.content.relates_to);
                raw_msgs.push(RawMsg {
                    position,
                    event_id: original.event_id.to_string(),
                    sender: sender_str,
                    timestamp: original.origin_server_ts.0.into(),
                    display: ext,
                    bundled_edit_ts,
                    reply_to,
                    thread_root_id: thread_root_from_message_relation(&original.content.relates_to),
                    thread_summary: original
                        .unsigned
                        .relations
                        .thread
                        .as_deref()
                        .map(|bundle| {
                            let mut summary = thread_summary_from_bundle(bundle);
                            summary.ignore_list_revision = Some(ignore_list_revision);
                            summary
                        }),
                });
            }
        }

        // Keep paging until we have enough visible messages to overflow the
        // viewport (so the user can actually scroll and re-trigger pagination),
        // we truly run out of history, or we hit the per-call page cap.
        let visible = raw_msgs.len() + other_entries.len() - call_signal_count + visible_calls.len();
        if visible >= target_visible || prev_batch.is_none() {
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

    let reaction_map =
        aggregate_reactions_from_timeline(&events_for_reactions, client.user_id(), &ignored);

    // Second pass: resolve display name + avatar once per unique sender
    let mut sender_meta: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for uid in &unique_senders {
        let meta = match room.get_member_no_sync(uid).await {
            Ok(Some(member)) => {
                let name = member.display_name().map(|n| n.to_string());
                let avatar = avatars.cached(member.avatar_url()).await;
                (name, avatar)
            }
            _ => (None, None),
        };
        sender_meta.insert(uid.to_string(), meta);
    }

    // Third pass: build final messages using the cached sender metadata
    let mut messages: Vec<_> = raw_msgs
        .into_iter()
        .map(|m| {
            let (sender_name, avatar_url) =
                sender_meta.get(&m.sender).cloned().unwrap_or((None, None));
            let replacement = latest_replacement
                .get(&(m.event_id.clone(), m.sender.clone()))
                .filter(|(ts, _)| m.bundled_edit_ts.is_none_or(|bundled_ts| *ts >= bundled_ts));
            let edited = replacement.is_some() || m.bundled_edit_ts.is_some();
            let display = replacement.map(|(_, display)| display.clone()).unwrap_or(m.display);
            let reactions = reaction_map.get(&m.event_id).cloned();
            let message = MessageInfo {
                decryption_failed: false,
                membership_notice: None,
                direct_call_notice: None,
                event_id: m.event_id,
                sender: m.sender,
                sender_name,
                body: display.body,
                timestamp: m.timestamp,
                avatar_url,
                edited,
                reply_to: m.reply_to,
                thread_root_id: m.thread_root_id,
                thread_summary: m.thread_summary,
                image_media_request: display.image_media_request,
                image_width: display.image_width,
                image_height: display.image_height,
                image_blurhash: display.image_blurhash,
                video_media_request: display.video_media_request,
                video_width: display.video_width,
                video_height: display.video_height,
                file_media_request: display.file_media_request,
                file_mime: display.file_mime,
                file_display_name: display.file_display_name,
                unsupported_matrix_msgtype: display.unsupported_matrix_msgtype,
                reactions,
                formatted_body: display.formatted_body,
                mentioned_user_ids: display.mentioned_user_ids,
                mentions_room: display.mentions_room,
            };
            (m.position, message)
        })
        .collect();

    extend_timeline_entries(&mut messages, other_entries, &sender_meta);
    messages.sort_by_key(|(position, message)| (std::cmp::Reverse(message.timestamp), *position));
    let messages: Vec<_> = messages.into_iter().map(|(_, message)| message).collect();
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
        latest_event_id: if from.is_none() {
            events_for_reactions
                .first()
                .and_then(|event| {
                    event
                        .raw()
                        .get_field::<OwnedEventId>("event_id")
                        .ok()
                        .flatten()
                })
                .map(|id| id.to_string())
        } else {
            None
        },
    })
}

fn bundled_message_display(
    event: &OriginalSyncRoomMessageEvent,
) -> (MessageDisplayExtract, Option<u64>) {
    if let Some(edit) = &event.unsigned.relations.replace {
        if edit.sender == event.sender {
            if let Some(Relation::Replacement(replacement)) = &edit.content.relates_to {
                if replacement.event_id == event.event_id {
                    let content = RoomMessageEventContent::from(replacement.new_content.clone());
                    return (extract_message_display(&content), Some(edit.origin_server_ts.0.into()));
                }
            }
        }
    }
    (extract_message_display(&event.content), None)
}

fn extend_timeline_entries(
    messages: &mut Vec<(usize, MessageInfo)>,
    other_entries: Vec<(usize, MessageInfo)>,
    sender_meta: &HashMap<String, (Option<String>, Option<String>)>,
) {
    messages.extend(other_entries.into_iter().map(|(position, mut message)| {
        if let Some((name, avatar)) = sender_meta.get(&message.sender) {
            message.sender_name = name.clone();
            if message.decryption_failed {
                message.avatar_url = avatar.clone();
            }
        }
        (position, message)
    }));
}

#[derive(Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ComposerMentions {
    user_ids: Vec<String>,
    room: bool,
}

impl ComposerMentions {
    pub(super) async fn into_matrix(self, room: &Room) -> Mentions {
        let own_user_id = room.own_user_id();
        let mut mentions = Mentions::with_user_ids(
            self.user_ids
                .into_iter()
                .filter(|id| id != own_user_id.as_str())
                .filter_map(|id| UserId::parse(id).ok()),
        );
        mentions.room = self.room && can_notify_room(room, own_user_id).await;
        mentions
    }
}

async fn can_notify_room(room: &Room, sender: &UserId) -> bool {
    room.power_levels_or_default()
        .await
        .user_can_trigger_room_notification(sender)
}

fn composer_text(
    body: String,
    formatted_body: Option<String>,
    mentions: Mentions,
) -> RoomMessageEventContentWithoutRelation {
    let content = match formatted_body {
        Some(html) => RoomMessageEventContentWithoutRelation::text_html(body, html),
        None => RoomMessageEventContentWithoutRelation::text_plain(body),
    };
    content.add_mentions(mentions)
}

#[cfg(test)]
#[test]
fn composer_text_sends_structured_mentions_with_a_formatted_link() {
    let user_id = UserId::parse("@alice:example.org").unwrap();
    let mut mentions = Mentions::with_user_ids([user_id.clone(), user_id]);
    mentions.room = true;
    let html = "Hey <a href=\"https://matrix.to/#/@alice:example.org\">Alice</a> and @room";
    let content = composer_text("Hey Alice and @room".into(), Some(html.into()), mentions);
    let event = serde_json::to_value(RoomMessageEventContent::from(content)).unwrap();
    assert_eq!(event["body"], "Hey Alice and @room");
    assert_eq!(event["format"], "org.matrix.custom.html");
    assert_eq!(event["formatted_body"], html);
    assert_eq!(
        event["m.mentions"],
        serde_json::json!({ "user_ids": ["@alice:example.org"], "room": true })
    );

    let plain = RoomMessageEventContent::from(composer_text("Literal @room".into(), None, Mentions::new()));
    let event = serde_json::to_value(&plain).unwrap();
    assert_eq!(event["m.mentions"], serde_json::json!({}));
    assert_eq!(extract_message_display(&plain).mentioned_user_ids, Some(vec![]));

    let legacy = RoomMessageEventContent::text_plain("Hey @alice:example.org");
    assert_eq!(extract_message_display(&legacy).mentioned_user_ids, None);
}

#[cfg(test)]
#[test]
fn edit_uses_effective_mentions_for_display_and_added_mentions_for_push() {
    use matrix_sdk::ruma::events::room::message::ReplacementMetadata;

    let alice = UserId::parse("@alice:example.org").unwrap();
    let bob = UserId::parse("@bob:example.org").unwrap();
    let original_mentions = Mentions::with_user_ids([alice.clone()]);
    let new_mentions = Mentions::with_user_ids([alice, bob]);
    let html = "Hey <a href=\"matrix:u/alice:example.org\">Alice</a> and Bob";
    let edit = composer_text("Hey Alice and Bob".into(), Some(html.into()), new_mentions)
        .make_replacement(ReplacementMetadata::new(
            EventId::parse("$original").unwrap(),
            Some(original_mentions),
        ));
    let event = serde_json::to_value(&edit).unwrap();
    assert_eq!(event["m.mentions"], serde_json::json!({ "user_ids": ["@bob:example.org"] }));
    let Some(Relation::Replacement(replacement)) = edit.relates_to else {
        panic!("expected an edit");
    };
    let display = extract_message_display(&RoomMessageEventContent::from(replacement.new_content));
    assert_eq!(display.formatted_body.as_deref(), Some(html));
    assert_eq!(
        display.mentioned_user_ids.unwrap(),
        ["@alice:example.org", "@bob:example.org"]
    );
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    body: String,
    formatted_body: Option<String>,
    mentions: Option<ComposerMentions>,
    reply_to_event_id: Option<String>,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    if !room.is_space() && room.is_tombstoned() {
        return Err("This room was upgraded. Send new messages in its replacement.".into());
    }

    let mentions = mentions.unwrap_or_default().into_matrix(&room).await;
    let without = composer_text(body, formatted_body, mentions);
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
        room.make_reply_event(without, reply)
            .await
            .map_err(|e| format!("Failed to build reply: {}", fmt_error_chain(&e)))?
    } else {
        RoomMessageEventContent::from(without)
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
    formatted_body: Option<String>,
    mentions: Option<ComposerMentions>,
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
    let mentions = mentions.unwrap_or_default().into_matrix(&room).await;
    let content = RoomMessageEventContent::from(composer_text(body, formatted_body, mentions));
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

    let can_send = !room.is_tombstoned() && member
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
    mut timeline_events: Vec<TimelineEvent>,
    avatars: &std::sync::Arc<crate::avatars::AvatarService>,
    ignored: &IgnoredUserIds,
) -> Result<Vec<MessageInfo>, String> {
    struct RawMsg {
        position: usize,
        event_id: String,
        sender: String,
        timestamp: u64,
        display: MessageDisplayExtract,
        bundled_edit_ts: Option<u64>,
        reply_to: Option<MessageReplyTo>,
        thread_root_id: Option<String>,
        thread_summary: Option<MessageThreadSummary>,
    }

    let mut raw_msgs = Vec::new();
    let mut other_entries = Vec::new();
    let mut latest_replacement: HashMap<(String, String), (u64, MessageDisplayExtract)> = HashMap::new();
    let mut unique_senders = Vec::new();
    let mut seen_senders = HashSet::new();

    let client = room.client();
    let me = client.user_id();
    let encrypted_room = room.encryption_state().is_encrypted();
    retry_timeline_decryption(room, &mut timeline_events, ignored, &mut None).await;
    let reaction_map = aggregate_reactions_from_timeline(&timeline_events, me, ignored);
    let mut rss = super::rss::activity::Filter::for_room(room).await;
    if let Some(filter) = &mut rss {
        filter.remember_commands(&timeline_events);
    }

    for (position, event) in timeline_events.into_iter().enumerate() {
        if hides_event(ignored, event.raw()) {
            continue;
        }
        if let Some(message) = unavailable_message(event.raw().json()) {
            let sender = UserId::parse(&message.sender).expect("validated sender");
            if seen_senders.insert(message.sender.clone()) {
                unique_senders.push(sender);
            }
            other_entries.push((position, message));
            continue;
        }
        if let Some(notice) = call_notice(
            event.raw(),
            encrypted_room,
            event.kind.encryption_info().is_some(),
        ).or_else(|| super::matrix_voip::call_notice(event.raw(), room, event.kind.encryption_info().is_some())) {
            other_entries.push((position, notice));
            continue;
        }
        let raw = match event.raw().deserialize() {
            Ok(e) => e,
            Err(_) => continue,
        };
        if let Some(notice) = timeline_membership_notice(&raw) {
            other_entries.push((position, notice));
            continue;
        }

        if let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(msg)) = raw {
            match msg {
                SyncMessageLikeEvent::Original(original) => {
                    if let Some(filter) = &mut rss {
                        if filter.hides_message(room, &original).await {
                            continue;
                        }
                    }
                    if let Some(Relation::Replacement(repl)) = &original.content.relates_to {
                        let target = (repl.event_id.to_string(), original.sender.to_string());
                        let ext = extract_message_display(&RoomMessageEventContent::from(
                            repl.new_content.clone(),
                        ));
                        let ts: u64 = original.origin_server_ts.0.into();
                        if latest_replacement.get(&target).is_none_or(|(previous_ts, _)| ts >= *previous_ts) {
                            latest_replacement.insert(target, (ts, ext));
                        }
                        continue;
                    }

                    let sender_str = original.sender.to_string();
                    if seen_senders.insert(sender_str.clone()) {
                        unique_senders.push(original.sender.clone());
                    }

                    let (ext, bundled_edit_ts) = bundled_message_display(&original);
                    let reply_to = reply_to_from_message_relation(&original.content.relates_to);
                    raw_msgs.push(RawMsg {
                        position,
                        event_id: original.event_id.to_string(),
                        sender: sender_str,
                        timestamp: original.origin_server_ts.0.into(),
                        display: ext,
                        bundled_edit_ts,
                        reply_to,
                        thread_root_id: thread_root_from_message_relation(
                            &original.content.relates_to,
                        ),
                        thread_summary: original
                            .unsigned
                            .relations
                            .thread
                            .as_deref()
                            .map(thread_summary_from_bundle),
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
                let avatar = avatars.cached(member.avatar_url()).await;
                (name, avatar)
            }
            _ => (None, None),
        };
        sender_meta.insert(uid.to_string(), meta);
    }

    let mut messages: Vec<_> = raw_msgs
        .into_iter()
        .map(|m| {
            let (sender_name, avatar_url) =
                sender_meta.get(&m.sender).cloned().unwrap_or((None, None));
            let replacement = latest_replacement
                .get(&(m.event_id.clone(), m.sender.clone()))
                .filter(|(ts, _)| m.bundled_edit_ts.is_none_or(|bundled_ts| *ts >= bundled_ts));
            let edited = replacement.is_some() || m.bundled_edit_ts.is_some();
            let display = replacement.map(|(_, display)| display.clone()).unwrap_or(m.display);
            let reactions = reaction_map.get(&m.event_id).cloned();
            let message = MessageInfo {
                decryption_failed: false,
                membership_notice: None,
                direct_call_notice: None,
                event_id: m.event_id,
                sender: m.sender,
                sender_name,
                body: display.body,
                timestamp: m.timestamp,
                avatar_url,
                edited,
                reply_to: m.reply_to,
                thread_root_id: m.thread_root_id,
                thread_summary: m.thread_summary,
                image_media_request: display.image_media_request,
                image_width: display.image_width,
                image_height: display.image_height,
                image_blurhash: display.image_blurhash,
                video_media_request: display.video_media_request,
                video_width: display.video_width,
                video_height: display.video_height,
                file_media_request: display.file_media_request,
                file_mime: display.file_mime,
                file_display_name: display.file_display_name,
                unsupported_matrix_msgtype: display.unsupported_matrix_msgtype,
                reactions,
                formatted_body: display.formatted_body,
                mentioned_user_ids: display.mentioned_user_ids,
                mentions_room: display.mentions_room,
            };
            (m.position, message)
        })
        .collect();

    extend_timeline_entries(&mut messages, other_entries, &sender_meta);
    messages.sort_by_key(|(position, message)| (message.timestamp, *position));
    Ok(messages.into_iter().map(|(_, message)| message).collect())
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
    let ignored = state.ignored_users.users(&client).await;
    let mut rss = super::rss::activity::Filter::for_room(&room).await;

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
                    sender_user_id: None,
                    sender: String::new(),
                    preview: "Could not load message".to_string(),
                });
                continue;
            }
        };

        if hides_event(&ignored, ev.raw()) {
            continue;
        }
        let raw: AnySyncTimelineEvent = match ev.kind.raw().deserialize() {
            Ok(r) => r,
            Err(_) => {
                out.push(PinnedMessagePreview {
                    event_id: id.to_string(),
                    sender_user_id: None,
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
                        if let Some(filter) = &mut rss {
                            if filter.hides_message(&room, &o).await {
                                continue;
                            }
                        }
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
            sender_user_id: (!sender.is_empty()).then_some(sender),
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
    let ignored = state.ignored_users.users(&client).await;
    if let Some(ev) = response.event {
        if hides_event(&ignored, ev.raw()) {
            return Err("This message was sent by an ignored user.".into());
        }
        ordered.push(ev);
    }
    ordered.extend(response.events_after);

    let avatars = state.avatars.clone();
    let mut messages =
        build_message_infos_from_timeline_events(&room, ordered, &avatars, &ignored).await?;
    messages.reverse();

    Ok(MessageBatch {
        messages,
        prev_batch: response.prev_batch_token,
        latest_event_id: None,
    })
}

#[tauri::command]
pub async fn get_room_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
) -> Result<Option<MessageInfo>, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let id = EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;
    let event = room
        .load_or_fetch_event(&id, None)
        .await
        .map_err(|e| format!("Failed to load message: {}", fmt_error_chain(&e)))?;
    let ignored = state.ignored_users.users(&client).await;
    let messages =
        build_message_infos_from_timeline_events(&room, vec![event], &state.avatars, &ignored)
            .await?;
    Ok(messages.into_iter().next())
}

#[tauri::command]
pub async fn get_rss_thread_replies(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
    from: Option<String>,
) -> Result<MessageBatch, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let root = EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;
    let relations = room.relations(
        root.clone(),
        RelationsOptions {
            from: from.clone(),
            limit: Some(UInt::from(50u32)),
            recurse: true,
            ..Default::default()
        },
    );
    // Plain rich replies predate this feature and aren't indexed by the relations endpoint.
    // Include those around the article as well as the ones already in the client's room window.
    let context = async {
        if from.is_some() {
            return Vec::new();
        }
        room.event_with_context(&root, false, UInt::from(50u32), None)
            .await
            .map(|context| context.events_after)
            .unwrap_or_default()
    };
    let (response, context) = tokio::join!(relations, context);
    let response =
        response.map_err(|e| format!("Failed to load thread: {}", fmt_error_chain(&e)))?;
    let mut ids = HashSet::new();
    let events = response
        .chunk
        .into_iter()
        .chain(context)
        .filter(|event| {
            let id = event
                .raw()
                .get_field::<OwnedEventId>("event_id")
                .ok()
                .flatten();
            id.is_some_and(|id| ids.insert(id))
        })
        .collect();
    let ignored = state.ignored_users.users(&client).await;
    let mut messages =
        build_message_infos_from_timeline_events(&room, events, &state.avatars, &ignored).await?;
    messages.sort_by_key(|message| message.timestamp);
    let mut reply_ids = HashSet::from([event_id.clone()]);
    messages.retain(|message| {
        let belongs = if let Some(thread_id) = &message.thread_root_id {
            thread_id == &event_id
        } else {
            message
                .reply_to
                .as_ref()
                .is_some_and(|reply| reply_ids.contains(&reply.event_id))
        };
        if belongs {
            reply_ids.insert(message.event_id.clone());
        }
        belongs
    });
    Ok(MessageBatch {
        messages,
        prev_batch: response
            .next_batch_token
            .filter(|next| Some(next) != from.as_ref()),
        latest_event_id: None,
    })
}

#[tauri::command]
pub async fn send_rss_thread_reply(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    thread: MessageThreadTarget,
    body: String,
    formatted_body: Option<String>,
    mentions: Option<ComposerMentions>,
) -> Result<String, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("Enter a reply.".into());
    }
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let mentions = mentions.unwrap_or_default().into_matrix(&room).await;
    let content = thread.apply(composer_text(body.to_owned(), formatted_body, mentions).into());
    let response = room
        .send(content)
        .await
        .map_err(|e| format!("Failed to send reply: {}", fmt_error_chain(&e)))?;
    Ok(response.event_id.to_string())
}

#[cfg(test)]
#[test]
fn rss_thread_reply_keeps_the_root_separate_from_the_fallback_reply() {
    let thread = MessageThreadTarget {
        root_event_id: EventId::parse("$article").unwrap(),
        latest_event_id: Some(EventId::parse("$previous-reply").unwrap()),
    };
    let content = thread.apply(RoomMessageEventContent::text_plain("A reply"));
    let json = serde_json::to_value(&content).unwrap();
    assert_eq!(json["body"], "A reply");
    assert_eq!(json["m.relates_to"]["rel_type"], "m.thread");
    assert_eq!(json["m.relates_to"]["event_id"], "$article");
    assert_eq!(
        json["m.relates_to"]["m.in_reply_to"]["event_id"],
        "$previous-reply"
    );
    assert_eq!(json["m.relates_to"]["is_falling_back"], true);
    assert_eq!(
        thread_root_from_message_relation(&content.relates_to).as_deref(),
        Some("$article")
    );
}

#[tauri::command]
pub async fn edit_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    event_id: String,
    body: String,
    formatted_body: Option<String>,
    mentions: Option<ComposerMentions>,
    previous_mentions: Option<ComposerMentions>,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let event_id_parsed =
        EventId::parse(&event_id).map_err(|e| format!("Invalid event ID: {e}"))?;

    let mentions = mentions.unwrap_or_default().into_matrix(&room).await;
    let new_content = composer_text(body, formatted_body, mentions.clone());

    let edit_content = room
        .make_edit_event(&event_id_parsed, EditedContent::RoomMessage(new_content))
        .await
        .map_err(|e| format!("Failed to prepare edit: {}", fmt_error_chain(&e)))?;

    match edit_content {
        AnyMessageLikeEventContent::RoomMessage(mut content) => {
            if let Some(previous) = previous_mentions {
                // The SDK compares with the original event. For subsequent edits,
                // compare with the effective content that was opened in the editor.
                let mut added = mentions;
                added.user_ids.retain(|id| {
                    !previous.user_ids.iter().any(|previous_id| previous_id == id.as_str())
                });
                added.room &= !previous.room;
                content.mentions = Some(added);
            }
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
    let _operation = state.encryption.operation.lock().await;
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

    state.encryption.start(&client, app.clone()).await;

    {
        let app = app.clone();
        let presence = state.presence.clone();
        let self_id = client.user_id().map(ToOwned::to_owned);
        client.add_event_handler(move |event: PresenceEvent| {
            let app = app.clone();
            let presence = presence.clone();
            let is_self = self_id.as_ref() == Some(&event.sender);
            async move {
                if !is_self {
                    presence.publish(&app, PresencePayload {
                        user_id: event.sender.to_string(),
                        presence: super::presence::presence_label(&event.content.presence).into(),
                        status_msg: event.content.status_msg.filter(|msg| !msg.is_empty()),
                    });
                }
            }
        });
    }

    let ignored_users = state.ignored_users.clone();
    let sync_ignore_revision = Arc::new(AtomicU64::new(ignored_users.revision()));
    {
        let ignored_users = ignored_users.clone();
        let revision = sync_ignore_revision.clone();
        let app = app.clone();
        client.add_event_handler(move |ev: IgnoredUserListEvent, client: matrix_sdk::Client| {
            let ignored_users = ignored_users.clone();
            let revision = revision.load(Ordering::Relaxed);
            let app = app.clone();
            async move {
                if let Err(error) = ignored_users.apply_sync(&app, &client, revision, ev.content).await {
                    log::warn!("Could not reconcile the Matrix ignore list: {error}");
                }
            }
        });
    }

    // Handler for incoming room messages
    let app_handle = app.clone();
    let avatars = state.avatars.clone();
    let raw_unread_for_msg = state.raw_unread_messages.clone();
    let pending_reads_for_msg = state.pending_unavailable_reads.clone();
    let self_user_id_for_msg = client.user_id().map(|u| u.to_owned());
    let ignored_for_msg = ignored_users.clone();
    client.add_event_handler(move |ev: OriginalSyncRoomMessageEvent, room: Room| {
        let app = app_handle.clone();
        let avatars = avatars.clone();
        let raw_unread = raw_unread_for_msg.clone();
        let pending_reads = pending_reads_for_msg.clone();
        let self_uid = self_user_id_for_msg.clone();
        let ignored = ignored_for_msg.clone();
        async move {
            if ignored.users(&room.client()).await.contains(&ev.sender) {
                return;
            }
            if super::rss::activity::hides_live_message(&room, &ev).await {
                if reply_to_from_message_relation(&ev.content.relates_to).is_some() {
                    let _ = app.emit(super::rss::RSS_FEED_CHANGED, room.room_id().as_str());
                }
                return;
            }
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
                super::unavailable_messages::note_incoming(&pending_reads, &room).await;
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
                let image_blurhash = ext
                    .image_blurhash
                    .clone()
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null);
                let payload = MessageEditPayload {
                    room_id,
                    target_event_id: repl.event_id.to_string(),
                    sender: ev.sender.to_string(),
                    body: ext.body,
                    formatted_body: ext.formatted_body,
                    mentioned_user_ids: ext.mentioned_user_ids,
                    mentions_room: ext.mentions_room,
                    image_media_request,
                    video_media_request,
                    file_media_request,
                    file_mime,
                    file_display_name,
                    image_width: json_u32(ext.image_width),
                    image_height: json_u32(ext.image_height),
                    image_blurhash,
                    video_width: json_u32(ext.video_width),
                    video_height: json_u32(ext.video_height),
                    unsupported_matrix_msgtype,
                };
                let _ = app.emit("room-message-edit", payload);
                return;
            }

            let ext = extract_message_display(&ev.content);
            let reply_to = reply_to_from_message_relation(&ev.content.relates_to);
            let sender = ev.sender.to_string();

            let (sender_name, avatar_url) = match room.get_member_no_sync(&ev.sender).await {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = avatars.cached(member.avatar_url()).await;
                    (name, avatar)
                }
                _ => (None, None),
            };

            let timestamp: u64 = ev.origin_server_ts.0.into();

            let mentions_me = self_uid.as_ref().is_some_and(|uid| {
                ev.content.mentions.as_ref().is_some_and(|mentions| mentions.user_ids.contains(uid))
            });
            let room_ping = ext.mentions_room && can_notify_room(&room, &ev.sender).await;

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
                    decryption_failed: false,
                    membership_notice: None,
                    direct_call_notice: None,
                    event_id: ev.event_id.to_string(),
                    sender,
                    sender_name,
                    body: ext.body,
                    timestamp,
                    avatar_url,
                    edited: false,
                    reply_to,
                    thread_root_id: thread_root_from_message_relation(&ev.content.relates_to),
                    thread_summary: ev.unsigned.relations.thread.as_deref().map(thread_summary_from_bundle),
                    image_media_request: ext.image_media_request,
                    image_width: ext.image_width,
                    image_height: ext.image_height,
                    image_blurhash: ext.image_blurhash,
                    video_media_request: ext.video_media_request,
                    video_width: ext.video_width,
                    video_height: ext.video_height,
                    file_media_request: ext.file_media_request,
                    file_mime: ext.file_mime,
                    file_display_name: ext.file_display_name,
                    unsupported_matrix_msgtype: ext.unsupported_matrix_msgtype,
                    reactions: None,
                    formatted_body: ext.formatted_body,
                    mentioned_user_ids: ext.mentioned_user_ids,
                    mentions_room: ext.mentions_room,
                },
            };
            let _ = app.emit("room-message", payload);
        }
    });

    // A typed member-state handler would also see the sync state snapshot.
    // Only events in the room's timeline belong in the chat history.
    {
        let app = app.clone();
        let pending = state.pending_unavailable_reads.clone();
        let ignored = ignored_users.clone();
        client.add_event_handler(
            move |event: Raw<AnySyncTimelineEvent>,
                  room: Room,
                  encryption_info: Option<EncryptionInfo>| {
                let app = app.clone();
                let pending = pending.clone();
                let ignored = ignored.clone();
                async move {
                    if room.is_space() {
                        return;
                    }
                    let users = ignored.users(&room.client()).await;
                    if hides_event(&users, &event) {
                        return;
                    }
                    let message = match event.get_field::<&str>("type").ok().flatten() {
                        Some("m.room.member") => event
                            .deserialize()
                            .ok()
                            .as_ref()
                            .and_then(timeline_membership_notice),
                        Some(CALL_EVENT) => call_notice(
                            &event,
                            room.encryption_state().is_encrypted(),
                            encryption_info.is_some(),
                        ),
                        _ => super::matrix_voip::call_notice(&event, &room, encryption_info.is_some()),
                    };
                    let Some(message) = message else {
                        return;
                    };
                    if message.direct_call_notice.is_some()
                        && message.sender != room.own_user_id().as_str()
                    {
                        super::unavailable_messages::note_incoming(&pending, &room).await;
                    }
                    let _ = app.emit(
                        "room-timeline-notice",
                        RoomTimelineNoticePayload {
                            room_id: room.room_id().to_string(),
                            message,
                        },
                    );
                }
            },
        );
    }

    // Undecrypted events still have a sender, timestamp and event ID. Surface
    // them instead of silently hiding a reply whose plaintext is unavailable.
    {
        let app = app.clone();
        let pending = state.pending_unavailable_reads.clone();
        let raw = state.raw_unread_messages.clone();
        let avatars = state.avatars.clone();
        let ignored = ignored_users.clone();
        client.add_event_handler(
            move |ev: matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent,
                  raw_event: matrix_sdk::event_handler::RawEvent,
                  room: Room| {
                let app = app.clone();
                let pending = pending.clone();
                let raw = raw.clone();
                let avatars = avatars.clone();
                let ignored = ignored.clone();
                async move {
                    if ignored.users(&room.client()).await.contains(&ev.sender) {
                        return;
                    }
                    let Some(mut message) = unavailable_message(&raw_event.0) else {
                        return;
                    };
                    if room
                        .client()
                        .user_id()
                        .is_none_or(|u| u.as_str() != message.sender)
                    {
                        super::unavailable_messages::note_incoming(&pending, &room).await;
                        *raw.lock()
                            .await
                            .entry(room.room_id().to_owned())
                            .or_default() += 1;
                    }
                    if let Ok(Some(member)) = room.get_member_no_sync(&ev.sender).await {
                        message.sender_name = member.display_name().map(str::to_owned);
                        message.avatar_url = avatars.cached(member.avatar_url()).await;
                    }
                    let _ = app.emit(
                        "room-message",
                        RoomMessagePayload {
                            room_id: room.room_id().to_string(),
                            message,
                            mentions_me: false,
                            room_ping: false,
                            is_dm: room.is_direct().await.unwrap_or(false),
                        },
                    );
                }
            },
        );
    }

    // Incoming emoji reactions (m.reaction) — keep message rows in sync.
    let app_handle = app.clone();
    let ignored_for_reactions = ignored_users.clone();
    client.add_event_handler(
        move |ev: OriginalSyncMessageLikeEvent<ReactionEventContent>, room: Room| {
            let app = app_handle.clone();
            let ignored = ignored_for_reactions.clone();
            async move {
                if ignored.users(&room.client()).await.contains(&ev.sender) {
                    return;
                }
                if ev.content.relates_to.key == "✅"
                    && super::rss::activity::hides_live_confirmation(
                        &room,
                        &ev.sender,
                        &ev.content.relates_to.event_id,
                    ).await
                {
                    let _ = app.emit(super::rss::RSS_FEED_CHANGED, room.room_id().as_str());
                    return;
                }
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

    let state_arc: Arc<AppState> = (*state).clone();
    let reconcile_gate = Arc::new(AtomicBool::new(false));

    {
        let app = app.clone();
        let feed_event = StateEventType::from(super::rss::RSS_FEED_EVENT);
        client.add_event_handler(
            move |event: AnySyncStateEvent, room: Room| {
                let app = app.clone();
                let event_type = event.event_type();
                let is_room_state = event.state_key().is_empty();
                let feed_changed = is_room_state && event_type == feed_event;
                let call_permissions_changed = is_room_state && matches!(
                    event_type,
                    StateEventType::RoomPowerLevels | StateEventType::RoomEncryption
                        | StateEventType::RoomJoinRules | StateEventType::RoomTombstone
                        | StateEventType::RoomCreate
                );
                let details_changed = is_room_state
                    && matches!(
                        event_type,
                        StateEventType::RoomName | StateEventType::RoomTopic
                            | StateEventType::RoomCreate | StateEventType::RoomEncryption
                            | StateEventType::RoomTombstone
                    );
                async move {
                    if call_permissions_changed {
                        let _ = app.emit("room-call-permissions-changed", room.room_id().as_str());
                    }
                    if feed_changed {
                        let _ = app.emit(super::rss::RSS_FEED_CHANGED, room.room_id().as_str());
                    }
                    if details_changed || feed_changed {
                        let _ = app.emit("rooms-changed", ());
                    }
                }
            },
        );
    }

    // Redactions (e.g. deleted messages): drop the target from the client timeline
    let app_handle = app.clone();
    let redaction_state = state_arc.clone();
    let redaction_gate = reconcile_gate.clone();
    client.add_event_handler(move |ev: OriginalSyncRoomRedactionEvent, room: Room| {
        let app = app_handle.clone();
        let state = redaction_state.clone();
        let gate = redaction_gate.clone();
        async move {
            // A redaction can remove a space-child event without replaying it
            // through the SpaceChild handler. The old target may be unavailable.
            if room.is_space() && gate.load(Ordering::Relaxed) {
                let _ = app.emit("rooms-changed", ());
                state.notifications.schedule(
                    &state,
                    &app,
                    super::reconciler::ReconcileScope::all(),
                );
            }
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
    let ignored_for_typing = ignored_users.clone();
    client.add_event_handler(move |ev: SyncTypingEvent, room: Room| {
        let app = app_handle.clone();
        let ignored = ignored_for_typing.clone();
        async move {
            let room_id = room.room_id().to_string();
            let ignored = ignored.users(&room.client()).await;

            let mut user_ids = Vec::new();
            let mut display_names = Vec::new();

            for uid in &ev.content.user_ids {
                if ignored.contains(uid) {
                    continue;
                }
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

    // Derived notification work runs in one session worker. Initial state
    // replay is covered by a single full pass after the first sync completes.
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

                let scope = if room.is_space() {
                    // Joining/leaving a space changes inheritance for its old
                    // and new children, including edges no longer in the store.
                    super::reconciler::ReconcileScope::all()
                } else {
                    super::reconciler::ReconcileScope::room(room_id)
                };
                state.notifications.schedule(&state, &app, scope);
            }
        });
    }

    // Scoped member updates replace broad room-list invalidation for other
    // users' joins, departures, and name edits. Avatar changes keep their own
    // event; neither path downloads data in the sync handler. Initial replay
    // is covered by the stores' sync-ready refresh.
    {
        let app_h = app.clone();
        let gate_h = reconcile_gate.clone();
        let rss_state = state_arc.clone();
        client.add_event_handler(move |ev: OriginalSyncRoomMemberEvent, room: Room| {
            let app = app_h.clone();
            let gate = gate_h.clone();
            let rss_state = rss_state.clone();
            async move {
                if ev.content.membership == MembershipState::Join
                    && ev.unsigned.prev_content.as_ref().is_none_or(|prev| prev.membership != MembershipState::Join)
                {
                    super::rss::on_provider_joined(rss_state, room.clone(), &ev.state_key).await;
                }
                if !gate.load(Ordering::Relaxed) {
                    return;
                }
                if super::members::member_list_changed(&ev) {
                    let membership_changed = ev.unsigned.prev_content.as_ref()
                        .is_none_or(|previous| previous.membership != ev.content.membership);
                    let _ = app.emit(
                        "room-members-changed",
                        RoomMembersChangedPayload {
                            room_id: room.room_id().to_string(),
                            membership_changed,
                        },
                    );
                    if membership_changed && ev.state_key.as_str() != room.own_user_id().as_str()
                        && room.is_direct().await.unwrap_or(false)
                    {
                        let _ = app.emit("rooms-changed", ());
                    }
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
            move |ev: matrix_sdk::ruma::events::SyncStateEvent<SpaceChildEventContent>,
                  _room: Room| {
                let state = state_h.clone();
                let app = app_h.clone();
                let gate = gate_h.clone();
                async move {
                    if !gate.load(Ordering::Relaxed) {
                        return;
                    }
                    let _ = app.emit("rooms-changed", ());
                    // The event's target must be reconciled even when the link
                    // was removed/redacted and is absent from the new graph.
                    state.notifications.schedule(
                        &state,
                        &app,
                        super::reconciler::ReconcileScope::room(ev.state_key().to_string()),
                    );
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
                state.notifications.schedule(
                    &state,
                    &app,
                    super::reconciler::ReconcileScope::all(),
                );
            }
        });
    }

    {
        let app_h = app.clone();
        client.add_event_handler(
            move |_ev: OriginalSyncStateEvent<
                matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent,
            >,
                  room: Room| {
                let app = app_h.clone();
                async move {
                    let _ = app.emit(
                        "room-avatar-invalidated",
                        serde_json::json!({ "roomId": room.room_id() }),
                    );
                }
            },
        );
    }

    // Read-receipt handler — clears the raw-message counter for a room
    {
        let app = app.clone();
        client.add_event_handler(
            move |_event: matrix_sdk::ruma::events::AnyRoomAccountDataEvent,
                  raw: matrix_sdk::event_handler::RawEvent,
                  room: Room| {
                let app = app.clone();
                async move {
                    let Ok(event) = serde_json::from_str::<serde_json::Value>(raw.0.get()) else {
                        return;
                    };
                    let content = &event["content"];
                    if event["type"] == "com.carter.pax.unavailable_messages"
                        && content["roomId"].as_str() == Some(room.room_id().as_str())
                        && content["userId"].as_str() == room.client().user_id().map(|u| u.as_str())
                    {
                        let _ = app.emit("room-unavailable-acknowledged", content);
                    }
                }
            },
        );
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
        let pending = state.pending_unavailable_reads.clone();
        let self_uid = client.user_id().map(|u| u.to_owned());
        client.add_event_handler(
            move |ev: matrix_sdk::ruma::events::receipt::SyncReceiptEvent, room: Room| {
                let raw_unread = raw_unread.clone();
                let pending = pending.clone();
                let self_uid = self_uid.clone();
                async move {
                    let Some(me) = self_uid else { return };
                    // `ev.content.0` is `EventId → ReceiptType → UserId → Receipt`.
                    // We just need to know "was there any receipt for our MXID
                    // anywhere in this event?"  One walk is enough.
                    let mine: Vec<OwnedEventId> = ev
                        .content
                        .0
                        .iter()
                        .filter(|(_, by_type)| by_type.iter().any(|(kind, by_user)| matches!(kind, matrix_sdk::ruma::events::receipt::ReceiptType::Read | matrix_sdk::ruma::events::receipt::ReceiptType::ReadPrivate) && by_user.contains_key(&me)))
                        .map(|(id, _)| id.clone()).collect();
                    if !mine.is_empty() && !super::unavailable_messages::note_receipt_echo(&pending, &room, &mine).await {
                        raw_unread.lock().await.remove(room.room_id());
                    }
                }
            },
        );
    }

    // Clone shared state needed inside the sync loop.
    let desired_presence = state.desired_presence.clone();
    let unread_cache = state.unread_cache.clone();
    let unread_projection = state.unread_projection.clone();
    let raw_unread = state.raw_unread_messages.clone();
    let pending_unavailable_reads = state.pending_unavailable_reads.clone();
    let reconcile_state_arc = state_arc.clone();
    let reconcile_gate_for_loop = reconcile_gate.clone();

    // Spawn the continuous sync loop in the background.
    // Uses sync_once in a manual loop so we can read `desired_presence` on each
    // iteration and set the sync's `set_presence` accordingly:
    //   - "online" → set_presence=Online  (Synapse auto-manages, like Cinny/Element)
    //   - anything else → set_presence=Offline (explicit PUTs from the frontend handle it)
    let join = tokio::spawn(async move {
        let mut first_sync_done = false;
        let mut sync_count: u64 = 0;
        let mut room_upgrade_attempts = super::room_upgrades::UpgradeAttempts::default();
        let mut room_upgrade_tasks = tokio::task::JoinSet::new();

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
            let mut settings =
                matrix_sdk::config::SyncSettings::default().set_presence(set_presence_value);
            if !first_sync_done {
                settings = settings.timeout(std::time::Duration::ZERO);
            }

            sync_ignore_revision.store(ignored_users.revision(), Ordering::Relaxed);
            let response = match client.sync_once(settings).await {
                Ok(r) => r,
                Err(e) => {
                    if super::auth::handle_sync_session_error(
                        &e,
                        &reconcile_state_arc,
                        &app,
                        &client,
                    ) {
                        break;
                    }
                    log::warn!("Sync error: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };

            // Invites arrive as stripped state, outside the full membership
            // event handler that normally invalidates the room list.
            if !response.rooms.invited.is_empty() {
                let _ = app.emit("rooms-changed", ());
            }

            unread_projection.invalidate(response.rooms.joined.iter()
                .filter(|(_, update)| !update.timeline.events.is_empty() || update.ephemeral.iter().any(|event| {
                    event.get_field::<String>("type").ok().flatten().as_deref() == Some("m.receipt")
                }))
                .map(|(room_id, _)| room_id)
                .chain(response.rooms.left.keys())).await;

            for event in &response.account_data {
                if let Ok(value) = event.deserialize_as::<serde_json::Value>() {
                    super::pax_settings::process_synced_settings(
                        &reconcile_state_arc,
                        &app,
                        &value,
                    );
                }
            }

            super::direct_calls::receive_signals(&reconcile_state_arc, &client, &app, &response)
                .await;
            super::group_calls::receive_signals(&reconcile_state_arc, &client, &app, &response).await;
            super::matrix_voip::receive_signals(&reconcile_state_arc, &client, &app, &response)
                .await;

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
                reconcile_state_arc.sync_ready.store(true, Ordering::Release);
                let _ = app.emit("sync-ready", ());

                reconcile_gate_for_loop.store(true, Ordering::Release);
                reconcile_state_arc.notifications.schedule(
                    &reconcile_state_arc,
                    &app,
                    super::reconciler::ReconcileScope::all(),
                );
            }

            if let Some(Ok(attempts)) = room_upgrade_tasks.try_join_next() {
                room_upgrade_attempts = attempts;
            }
            if room_upgrade_tasks.is_empty() {
                let mut attempts = std::mem::take(&mut room_upgrade_attempts);
                let state = reconcile_state_arc.clone();
                let client = client.clone();
                let app = app.clone();
                room_upgrade_tasks.spawn(async move {
                    let _guard = state.room_upgrade_operation.lock().await;
                    if attempts.reconcile(&state.http_client, &client).await {
                        let _ = app.emit("rooms-changed", ());
                    }
                    attempts
                });
            }

            // Emit per-room unread diffs since last iteration.  Pure in-memory
            // reads (RwLock) — cheap even for hundreds of rooms.  See
            // `commands::unread` for why we poll instead of subscribing to
            // `room_info_notable_update_receiver`.
            super::unread::emit_unread_snapshot_if_changed(
                &client,
                &unread_cache,
                &raw_unread,
                &unread_projection,
                &pending_unavailable_reads,
                &app,
            )
            .await;

            let voice_rooms = crate::voice_presence::changed_rooms(&client, &response);
            if !voice_rooms.is_empty() {
                let _ = app.emit(
                    "voice-participants-invalidated",
                    VoiceParticipantsInvalidatedPayload {
                        room_ids: voice_rooms,
                    },
                );
            }
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

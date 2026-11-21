use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};

use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    room::MessagesOptions,
    ruma::{
        events::{
            receipt::{ReceiptThread, ReceiptType},
            room::message::{OriginalSyncRoomMessageEvent, Relation},
            AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        },
        OwnedRoomId, UInt,
    },
    Room,
};
use tokio::sync::{Mutex, OnceCell, Semaphore};

use super::{direct_calls, rss::activity::Filter as RssFilter, unread::RoomUnreadState};

#[derive(Clone, Copy, Default)]
struct Counts {
    messages: u64,
    notifications: u64,
    mentions: u64,
}

impl Counts {
    fn count(&mut self, event: &TimelineEvent) {
        self.messages += u64::from(
            matches!(event.raw().deserialize().ok(),
                Some(AnySyncTimelineEvent::MessageLike(
                    AnySyncMessageLikeEvent::RoomMessage(SyncMessageLikeEvent::Original(OriginalSyncRoomMessageEvent { content, .. }))
                )) if !matches!(content.relates_to, Some(Relation::Replacement(_)))
            ) || matches!(
                event
                    .raw()
                    .get_field::<String>("type")
                    .ok()
                    .flatten()
                    .as_deref(),
                Some(
                    "m.room.encrypted"
                        | "m.sticker"
                        | "m.poll.start"
                        | "m.poll.end"
                        | "org.matrix.msc3381.poll.start"
                        | "org.matrix.msc3381.poll.end"
                )
            ),
        );
        if let Some(actions) = event.push_actions() {
            self.notifications += u64::from(actions.iter().any(|action| action.should_notify()));
            self.mentions += u64::from(actions.iter().any(|action| action.is_highlight()));
        }
    }
}

#[derive(Default)]
struct UnreadScan {
    complete: bool,
    contains_answered_call: bool,
    hidden: Counts,
    visible: Counts,
}

impl UnreadScan {
    fn adjust(&self, base: &RoomUnreadState, raw: u64) -> RoomUnreadState {
        let hidden = self.hidden;
        if !self.contains_answered_call
            && hidden.messages == 0
            && hidden.notifications == 0
            && hidden.mentions == 0
        {
            return base.clone();
        }
        let visible = self.visible;
        let (messages, notifications, mentions) = if self.complete {
            // The raw counter is fed by chat messages only. It also covers
            // messages received in sync before this page reaches the client.
            let messages = if self.contains_answered_call {
                visible.messages.max(raw)
            } else {
                visible.messages
            };
            (messages, visible.notifications, visible.mentions)
        } else {
            // An older receipt can fall outside the bounded scan. Keep unread
            // activity beyond the scanned pages while removing known events.
            (
                visible
                    .messages
                    .max(raw)
                    .max(base.messages.saturating_sub(hidden.messages)),
                visible
                    .notifications
                    .max(base.notifications.saturating_sub(hidden.notifications)),
                visible
                    .mentions
                    .max(base.mentions.saturating_sub(hidden.mentions)),
            )
        };
        RoomUnreadState {
            messages: messages.max(notifications),
            notifications,
            mentions,
            marked_unread: base.marked_unread,
        }
    }
}

async fn scan_unread(
    room: &Room,
    mut rss: Option<RssFilter>,
    answered_calls: &VecDeque<String>,
) -> Option<UnreadScan> {
    let me = room.own_user_id();
    let encrypted = room.encryption_state().is_encrypted();
    let mut receipts = HashSet::new();
    for kind in [ReceiptType::Read, ReceiptType::ReadPrivate] {
        for thread in [ReceiptThread::Unthreaded, ReceiptThread::Main] {
            if let Some((id, _)) = room
                .load_user_receipt(kind.clone(), thread, me)
                .await
                .ok()?
            {
                receipts.insert(id);
            }
        }
    }
    let mut scan = UnreadScan::default();
    let mut seen = HashSet::new();
    let mut from = None;
    for _ in 0..4 {
        let mut options = MessagesOptions::backward();
        options.limit = UInt::from(50u32);
        options.from = from.clone();
        let page = room.messages(options).await.ok()?;
        if let Some(filter) = &mut rss {
            filter.remember_commands(&page.chunk);
        }
        for event in page.chunk {
            let Some(id) = event.event_id() else { continue };
            if receipts.contains(&id) {
                scan.complete = true;
                return Some(scan);
            }
            if !seen.insert(id)
                || event
                    .raw()
                    .get_field::<String>("sender")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(me.as_str())
            {
                continue;
            }
            let answered_call = !answered_calls.is_empty()
                && direct_calls::call_id_for_event(&event, encrypted)
                    .is_some_and(|id| answered_calls.contains(&id));
            if answered_call {
                scan.contains_answered_call = true;
                scan.hidden.count(&event);
            } else if let Some(filter) = &mut rss {
                if filter.hides_event(room, &event).await {
                    scan.hidden.count(&event);
                } else {
                    scan.visible.count(&event);
                }
            } else {
                scan.visible.count(&event);
            }
        }
        if page.end.is_none() {
            scan.complete = true;
            return Some(scan);
        }
        if page.end == from {
            break;
        }
        from = page.end;
    }
    Some(scan)
}

struct CachedUnread {
    base: RoomUnreadState,
    raw: u64,
    result: Arc<OnceCell<RoomUnreadState>>,
}

#[derive(Default)]
struct RoomUnreadProjection {
    answered_calls: VecDeque<String>,
    inspect_calls: bool,
    cached: Option<CachedUnread>,
}

#[derive(Default)]
pub(crate) struct UnreadProjectionCache {
    rooms: Mutex<HashMap<OwnedRoomId, RoomUnreadProjection>>,
}

static SCAN_SLOTS: Semaphore = Semaphore::const_new(6);
const MAX_ANSWERED_CALLS_PER_ROOM: usize = 32;

impl UnreadProjectionCache {
    pub(crate) async fn invalidate<'a>(&self, ids: impl IntoIterator<Item = &'a OwnedRoomId>) {
        let mut rooms = self.rooms.lock().await;
        for id in ids {
            if let std::collections::hash_map::Entry::Occupied(mut entry) = rooms.entry(id.clone())
            {
                if entry.get().answered_calls.is_empty() {
                    entry.remove();
                } else {
                    entry.get_mut().cached = None;
                }
            }
        }
    }

    pub(crate) async fn note_call_event(
        &self,
        room_id: &matrix_sdk::ruma::RoomId,
        call_id: &str,
        answered_here: bool,
    ) {
        let mut rooms = self.rooms.lock().await;
        let room = if answered_here {
            rooms.entry(room_id.to_owned()).or_default()
        } else if let Some(room) = rooms.get_mut(room_id) {
            room
        } else {
            return;
        };
        if !room.answered_calls.iter().any(|id| id == call_id) {
            if !answered_here {
                return;
            }
            if room.answered_calls.len() >= MAX_ANSWERED_CALLS_PER_ROOM {
                room.answered_calls.pop_front();
            }
            room.answered_calls.push_back(call_id.to_owned());
        }
        room.inspect_calls = true;
        room.cached = None;
    }

    pub(crate) async fn clear(&self) {
        self.rooms.lock().await.clear();
    }

    pub(crate) async fn snapshot(&self, room: &Room, raw: u64) -> RoomUnreadState {
        let base = RoomUnreadState::from_room_with_raw(room, raw);
        // The raw counter only tracks chat. Consult the timeline when the
        // SDK or homeserver counts could include events Pax has handled.
        if room.num_unread_messages() == 0 && base.notifications == 0 && base.mentions == 0 {
            return base;
        }
        let (result, answered_calls) = {
            let mut rooms = self.rooms.lock().await;
            let entry = rooms.entry(room.room_id().to_owned()).or_default();
            if entry
                .cached
                .as_ref()
                .is_none_or(|cache| cache.base != base || cache.raw != raw)
            {
                entry.cached = Some(CachedUnread {
                    base: base.clone(),
                    raw,
                    result: Arc::new(OnceCell::new()),
                });
            }
            (
                entry.cached.as_ref().unwrap().result.clone(),
                if entry.inspect_calls {
                    entry.answered_calls.clone()
                } else {
                    VecDeque::new()
                },
            )
        };
        result
            .get_or_init(|| async {
                let rss = RssFilter::for_room(room).await;
                if rss.is_none() && answered_calls.is_empty() {
                    return base;
                }
                let attempt = tokio::time::timeout(Duration::from_secs(4), async {
                    let _slot = SCAN_SLOTS.acquire().await.ok()?;
                    scan_unread(room, rss, &answered_calls).await
                })
                .await
                .ok()
                .flatten();
                // A receipt can move past the call. Ordinary chat then uses
                // the regular counts until another call event arrives.
                if !answered_calls.is_empty()
                    && attempt
                        .as_ref()
                        .is_some_and(|scan| scan.complete && !scan.contains_answered_call)
                {
                    if let Some(entry) = self.rooms.lock().await.get_mut(room.room_id()) {
                        if entry
                            .cached
                            .as_ref()
                            .is_some_and(|cache| Arc::ptr_eq(&cache.result, &result))
                        {
                            entry.inspect_calls = false;
                        }
                    }
                }
                attempt.map(|scan| scan.adjust(&base, raw)).unwrap_or(base)
            })
            .await
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::RoomId;
    use serde_json::json;

    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client, Server, TestDir, USER},
    };

    const ROOM: &str = "!test:example.org";
    const PEER: &str = "@peer:example.org";
    const CALL_ID: &str = "e2b097b1-7e21-483f-9daa-32e5d157604a";

    fn event(event_type: &str, id: &str, ts: u64, content: serde_json::Value) -> serde_json::Value {
        json!({
            "type": event_type, "event_id": id, "sender": PEER, "room_id": ROOM,
            "origin_server_ts": ts, "content": content
        })
    }

    #[tokio::test]
    async fn answered_call_stops_counting_and_chat_stays_unread() {
        let server = Server::start().await;
        let read = event(
            "m.room.message",
            "$read",
            10,
            json!({"msgtype":"m.text","body":"Read"}),
        );
        let ring = event(
            direct_calls::CALL_EVENT,
            "$ring",
            12,
            json!({
                "kind":"ring", "callId": CALL_ID, "deviceId":"CALLER"
            }),
        );
        let connect = event(
            direct_calls::CALL_EVENT,
            "$connect",
            13,
            json!({
                "kind":"connect", "callId": CALL_ID, "deviceId":"CALLER", "answerDeviceId":"ANSWERER"
            }),
        );
        {
            let mut state = server.state.lock().unwrap();
            state.route_overrides.insert(("GET".into(), "/_matrix/client/v3/sync".into()), (200, json!({
                "next_batch": "answered-call",
                "rooms":{"join":{ROOM:{
                    "state":{"events":[
                        {"type":"m.room.create","state_key":"","sender":USER,"event_id":"$create","origin_server_ts":1,"content":{"creator":USER,"room_version":"10"}},
                        {"type":"m.room.member","state_key":USER,"sender":USER,"event_id":"$self","origin_server_ts":2,"content":{"membership":"join"}},
                        {"type":"m.room.member","state_key":PEER,"sender":PEER,"event_id":"$peer","origin_server_ts":3,"content":{"membership":"join"}}
                    ]},
                    "timeline":{"events":[read.clone(), ring.clone()],"limited":false},
                    "ephemeral":{"events":[{"type":"m.receipt","content":{"$read":{"m.read.private":{USER:{"ts":10}}}}}]},
                    "unread_notifications":{"notification_count":1,"highlight_count":1}
                }}}
            })));
            state.timeline = vec![read, ring];
        }
        let dir = TestDir::new();
        let sdk = client(
            &server.home,
            &dir.0,
            SavedSession {
                user_id: USER.into(),
                device_id: "ANSWERER".into(),
                access_token: "test-token".into(),
            },
        )
        .await;
        let room = sdk.get_room(&RoomId::parse(ROOM).unwrap()).unwrap();
        let cache = UnreadProjectionCache::default();
        assert_eq!(cache.snapshot(&room, 0).await.mentions, 1);
        cache.note_call_event(room.room_id(), CALL_ID, true).await;
        assert_eq!(cache.snapshot(&room, 0).await, RoomUnreadState::default());

        server.state.lock().unwrap().timeline.push(connect);
        cache.invalidate([&room.room_id().to_owned()]).await;
        assert_eq!(cache.snapshot(&room, 0).await, RoomUnreadState::default());

        {
            let mut state = server.state.lock().unwrap();
            state.timeline.insert(
                1,
                event(
                    "m.room.message",
                    "$before",
                    11,
                    json!({"msgtype":"m.text","body":"Before the call"}),
                ),
            );
            state.timeline.push(event(
                "m.room.message",
                "$after",
                14,
                json!({"msgtype":"m.text","body":"After the call"}),
            ));
        }
        cache.invalidate([&room.room_id().to_owned()]).await;
        let remaining = cache.snapshot(&room, 2).await;
        assert_eq!(remaining.messages, 2);
        assert_eq!(remaining.mentions, 0);
        assert!(!server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(_, path, _)| path.contains("/receipt/")));
    }
}

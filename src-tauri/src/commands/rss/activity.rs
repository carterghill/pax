use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use matrix_sdk::{
    config::RequestConfig,
    deserialized_responses::{RawAnySyncOrStrippedState, TimelineEvent},
    room::MessagesOptions,
    ruma::{
        events::{
            receipt::{ReceiptThread, ReceiptType},
            room::message::{OriginalSyncRoomMessageEvent, Relation},
            AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        },
        EventId, OwnedEventId, OwnedRoomId, UInt,
    },
    Room,
};
use serde_json::Value;
use tokio::sync::{Mutex, OnceCell, Semaphore};

use super::{parse_feed_url, RssFeedConfig, RSS_FEED_EVENT};
use crate::commands::{message_display::reply_to_from_message_relation, unread::RoomUnreadState};

pub(crate) async fn room_feed_config(room: &Room) -> Option<RssFeedConfig> {
    let event = room
        .get_state_event(RSS_FEED_EVENT.into(), "")
        .await
        .ok()??;
    let value = match event {
        RawAnySyncOrStrippedState::Sync(raw) => raw.deserialize_as::<Value>(),
        RawAnySyncOrStrippedState::Stripped(raw) => raw.deserialize_as::<Value>(),
    }
    .ok()?;
    RssFeedConfig::from_state_content(value.get("content")?).ok()
}

fn management_command(body: &str) -> bool {
    let mut words = body.split_whitespace();
    if words.next() != Some("!rss") {
        return false;
    }
    let command = words.next();
    let argument = words.next();
    if words.next().is_some() {
        return false;
    }
    match (command, argument) {
        (Some("subscriptions" | "ls" | "list" | "subs"), None) => true,
        (Some("subscribe" | "s" | "sub"), Some(url)) => parse_feed_url(url).is_ok(),
        (Some("unsubscribe" | "u" | "unsub"), Some(target)) => {
            target.parse::<u64>().is_ok() || parse_feed_url(target).is_ok()
        }
        _ => false,
    }
}

fn command_event(event: &OriginalSyncRoomMessageEvent) -> bool {
    event.content.msgtype() == "m.text"
        && event.content.relates_to.is_none()
        && management_command(event.content.body())
}

fn quoted_command(body: &str) -> bool {
    body.lines()
        .take_while(|line| line.starts_with("> "))
        .any(|line| {
            let quote = &line[2..];
            let text = if quote.starts_with('<') {
                quote
                    .split_once("> ")
                    .map(|(_, text)| text)
                    .unwrap_or(quote)
            } else {
                quote
            };
            management_command(text)
        })
}

pub(super) fn original_message(event: &TimelineEvent) -> Option<OriginalSyncRoomMessageEvent> {
    match event.raw().deserialize().ok()? {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncMessageLikeEvent::Original(message),
        )) => Some(message),
        _ => None,
    }
}

pub(crate) struct Filter {
    bot_id: String,
    commands: HashMap<OwnedEventId, bool>,
}

impl Filter {
    pub(crate) async fn for_room(room: &Room) -> Option<Self> {
        Some(Self {
            bot_id: room_feed_config(room).await?.bot_user_id,
            commands: HashMap::new(),
        })
    }

    pub(crate) fn remember_commands(&mut self, events: &[TimelineEvent]) {
        for event in events {
            if let Some(message) = original_message(event) {
                if command_event(&message) {
                    self.commands.insert(message.event_id, true);
                }
            }
        }
    }

    async fn target_is_command(&mut self, room: &Room, target: &EventId) -> bool {
        if let Some(result) = self.commands.get(target) {
            return *result;
        }
        let request = RequestConfig::new()
            .disable_retry()
            .timeout(Duration::from_secs(3));
        let Ok(event) = room.load_or_fetch_event(target, Some(request)).await else {
            return false;
        };
        let result = original_message(&event).as_ref().is_some_and(command_event);
        self.commands.insert(target.to_owned(), result);
        result
    }

    pub(crate) async fn hides_message(
        &mut self,
        room: &Room,
        event: &OriginalSyncRoomMessageEvent,
    ) -> bool {
        if command_event(event) {
            return true;
        }
        if event.sender.as_str() != self.bot_id {
            return false;
        }
        let Some(reply) = reply_to_from_message_relation(&event.content.relates_to) else {
            return false;
        };
        if quoted_command(event.content.body()) {
            return true;
        }
        match EventId::parse(reply.event_id) {
            Ok(target) => self.target_is_command(room, &target).await,
            Err(_) => false,
        }
    }

    async fn hides_event(&mut self, room: &Room, event: &TimelineEvent) -> bool {
        match event.raw().deserialize().ok() {
            Some(AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
                SyncMessageLikeEvent::Original(message),
            ))) => self.hides_message(room, &message).await,
            Some(AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Reaction(
                SyncMessageLikeEvent::Original(reaction),
            ))) if reaction.sender.as_str() == self.bot_id
                && reaction.content.relates_to.key == "✅" =>
            {
                self.target_is_command(room, &reaction.content.relates_to.event_id)
                    .await
            }
            _ => false,
        }
    }
}

pub(crate) async fn hides_live_message(room: &Room, event: &OriginalSyncRoomMessageEvent) -> bool {
    if !command_event(event) && reply_to_from_message_relation(&event.content.relates_to).is_none()
    {
        return false;
    }
    match Filter::for_room(room).await {
        Some(mut filter) => filter.hides_message(room, event).await,
        None => false,
    }
}

pub(crate) async fn hides_live_confirmation(
    room: &Room,
    sender: &matrix_sdk::ruma::UserId,
    target: &EventId,
) -> bool {
    let Some(mut filter) = Filter::for_room(room).await else {
        return false;
    };
    sender.as_str() == filter.bot_id && filter.target_is_command(room, target).await
}

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
    hidden: Counts,
    visible: Counts,
}

impl UnreadScan {
    fn adjust(&self, base: &RoomUnreadState, raw: u64) -> RoomUnreadState {
        let hidden = self.hidden;
        if hidden.messages == 0 && hidden.notifications == 0 && hidden.mentions == 0 {
            return base.clone();
        }
        let visible = self.visible;
        let (messages, notifications, mentions) = if self.complete {
            (visible.messages, visible.notifications, visible.mentions)
        } else {
            // An older receipt can fall outside the bounded scan. Keep unread
            // activity beyond the scanned pages while removing known bot traffic.
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

async fn scan_unread(room: &Room, mut filter: Filter) -> Option<UnreadScan> {
    let me = room.own_user_id();
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
        filter.remember_commands(&page.chunk);
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
            if filter.hides_event(room, &event).await {
                scan.hidden.count(&event);
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
pub(crate) struct UnreadCache {
    rooms: Mutex<HashMap<OwnedRoomId, CachedUnread>>,
}

static SCAN_SLOTS: Semaphore = Semaphore::const_new(6);

impl UnreadCache {
    pub(crate) async fn invalidate<'a>(&self, ids: impl IntoIterator<Item = &'a OwnedRoomId>) {
        let mut rooms = self.rooms.lock().await;
        for id in ids {
            rooms.remove(id);
        }
    }

    pub(crate) async fn clear(&self) {
        self.rooms.lock().await.clear();
    }

    pub(crate) async fn snapshot(&self, room: &Room, raw: u64) -> RoomUnreadState {
        let base = RoomUnreadState::from_room_with_raw(room, raw);
        // The raw counter already excludes management messages. Fetch history
        // only when SDK or homeserver totals can still include them.
        if room.num_unread_messages() == 0 && base.notifications == 0 && base.mentions == 0 {
            return base;
        }
        let result = {
            let mut rooms = self.rooms.lock().await;
            let entry = rooms
                .entry(room.room_id().to_owned())
                .or_insert_with(|| CachedUnread {
                    base: base.clone(),
                    raw,
                    result: Arc::new(OnceCell::new()),
                });
            if entry.base != base || entry.raw != raw {
                *entry = CachedUnread {
                    base: base.clone(),
                    raw,
                    result: Arc::new(OnceCell::new()),
                };
            }
            entry.result.clone()
        };
        result
            .get_or_init(|| async {
                let Some(filter) = Filter::for_room(room).await else {
                    return base.clone();
                };
                let attempt = tokio::time::timeout(Duration::from_secs(4), async {
                    let _slot = SCAN_SLOTS.acquire().await.ok()?;
                    scan_unread(room, filter).await
                })
                .await
                .ok()
                .flatten();
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

    #[test]
    fn recognizes_only_the_operations_exposed_in_rss_feeds() {
        for command in [
            "!rss subscriptions",
            "!rss list",
            "!rss subscribe https://example.org/rss",
            "!rss unsubscribe 42",
            "!rss unsubscribe https://example.org/rss",
        ] {
            assert!(management_command(command));
        }
        for message in [
            "Try !rss subscriptions",
            "!rss help",
            "!rss template 42",
            "!rss subscribe",
            "!rss unsubscribe all",
            "!rss subscriptions please",
        ] {
            assert!(!management_command(message));
        }
        assert!(quoted_command(
            "> <@alice:example.org> !rss subscriptions\n\nSubscriptions in this room:"
        ));
        assert!(!quoted_command("Try !rss subscriptions"));
    }

    fn event(id: &str, sender: &str, body: &str, reply_to: Option<&str>) -> Value {
        let mut content = json!({"msgtype":"m.text","body":body});
        if let Some(reply_to) = reply_to {
            content["m.relates_to"] = json!({"m.in_reply_to":{"event_id":reply_to}});
        }
        json!({"type":"m.room.message","event_id":id,"sender":sender,
            "room_id":"!test:example.org","origin_server_ts":100,"content":content})
    }

    #[tokio::test]
    async fn hidden_management_traffic_does_not_count_as_unread_or_hide_articles() {
        let server = Server::start().await;
        let bot = "@bot:nope.chat";
        let command = event(
            "$command",
            "@friend:example.org",
            "!rss subscriptions",
            None,
        );
        let reply = event(
            "$bot-reply",
            bot,
            "Subscriptions in this room:",
            Some("$command"),
        );
        let article = event(
            "$article",
            bot,
            "New post in Reuters: A story https://example.org/story",
            None,
        );
        let chat = event("$chat", "@friend:example.org", "Thanks!", Some("$command"));
        let read = event("$already-read", "@friend:example.org", "Earlier chat", None);
        {
            let mut state = server.state.lock().unwrap();
            state.route_overrides.insert(("GET".into(), "/_matrix/client/v3/sync".into()), (200, json!({
                "next_batch":"rss-filter-test",
                "rooms":{"join":{"!test:example.org":{
                    "state":{"events":[
                        {"type":"m.room.create","state_key":"","sender":USER,"event_id":"$create","origin_server_ts":1,"content":{"creator":USER,"room_version":"10"}},
                        {"type":"m.room.member","state_key":USER,"sender":USER,"event_id":"$self","origin_server_ts":2,"content":{"membership":"join"}},
                        {"type":RSS_FEED_EVENT,"state_key":"","sender":USER,"event_id":"$rss","origin_server_ts":3,"content":{"version":1,"provider":"rss-command","url":"https://example.org/rss","botUserId":bot}}
                    ]},
                    "timeline":{"events":[read.clone(), command.clone(), reply.clone()],"limited":false},
                    "ephemeral":{"events":[{"type":"m.receipt","content":{"$already-read":{"m.read.private":{USER:{"ts":100}}}}}]},
                    "unread_notifications":{"notification_count":2,"highlight_count":1}
                }}}
            })));
            state.timeline = vec![read.clone(), command.clone(), reply.clone()];
        }
        let dir = TestDir::new();
        let client = client(
            &server.home,
            &dir.0,
            SavedSession {
                user_id: USER.into(),
                device_id: "RSS_UNREAD_TEST".into(),
                access_token: "test-token".into(),
            },
        )
        .await;
        let room = client
            .get_room(&RoomId::parse("!test:example.org").unwrap())
            .unwrap();
        let cache = UnreadCache::default();
        assert_eq!(
            u64::from(room.unread_notification_counts().notification_count),
            2
        );
        assert_eq!(cache.snapshot(&room, 0).await, RoomUnreadState::default());

        server
            .state
            .lock()
            .unwrap()
            .timeline
            .extend([article, chat]);
        cache.invalidate([&room.room_id().to_owned()]).await;
        assert_eq!(cache.snapshot(&room, 2).await.messages, 2);
    }
}

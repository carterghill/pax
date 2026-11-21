use std::{collections::HashMap, time::Duration};

use matrix_sdk::{
    config::RequestConfig,
    deserialized_responses::TimelineEvent,
    ruma::{
        events::{
            room::message::OriginalSyncRoomMessageEvent, AnySyncMessageLikeEvent,
            AnySyncTimelineEvent, SyncMessageLikeEvent,
        },
        EventId, OwnedEventId,
    },
    Room,
};

use super::{cached_feed_event, parse_feed_url, RssRoomProvider};
use crate::commands::message_display::reply_to_from_message_relation;

async fn room_provider(room: &Room) -> Option<RssRoomProvider> {
    let value = cached_feed_event(room).await?;
    RssRoomProvider::from_state_content(value.get("content")?).ok()
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
            bot_id: room_provider(room).await?.bot_user_id,
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

    pub(crate) async fn hides_event(&mut self, room: &Room, event: &TimelineEvent) -> bool {
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

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::RoomId;
    use serde_json::{json, Value};

    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client, Server, TestDir, USER},
        rss::RSS_FEED_EVENT,
        unread::RoomUnreadState,
        unread_projection::UnreadProjectionCache,
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
                        {"type":RSS_FEED_EVENT,"state_key":"","sender":USER,"event_id":"$rss","origin_server_ts":3,"content":{"version":1,"provider":"rss-command","botUserId":bot}}
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
        let cache = UnreadProjectionCache::default();
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

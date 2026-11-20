use std::{sync::Arc, time::Duration};

use kuchikiki::{traits::TendrilSink, NodeRef};
use matrix_sdk::{
    room::Room,
    ruma::{
        events::{
            reaction::OriginalSyncReactionEvent,
            room::message::{OriginalSyncRoomMessageEvent, RoomMessageEventContent},
            MessageLikeEventType,
        },
        OwnedUserId, RoomId,
    },
    RoomState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{get_authed_client, parse_feed_url, read_feed_settings, read_provider_membership};
use crate::{
    commands::message_display::{
        extract_message_display, reply_to_from_message_relation, MessageDisplayExtract,
    },
    AppState,
};

const LIST_COMMAND: &str = "!rss subscriptions";
const EMPTY_LIST: &str = "There are no RSS subscriptions in this room";
const LIST_HEADER: &str = "Subscriptions in this room:";
const REPLY_TIMEOUT: Duration = Duration::from_secs(20);
const T2BOT: &str = "@rss:t2bot.io";

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RssSubscription {
    id: String,
    title: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssSubscriptionList {
    bot_user_id: OwnedUserId,
    can_manage: bool,
    subscriptions: Vec<RssSubscription>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RssSubscriptionChange {
    Subscribe { url: String },
    Unsubscribe { id: String },
}

struct RssRoom {
    room: Room,
    bot_user_id: OwnedUserId,
    can_manage: bool,
}

enum BotResponse {
    Reply(MessageDisplayExtract),
    Confirmed,
}

async fn rss_room(state: &AppState, room_id: &str) -> Result<RssRoom, String> {
    let room_id = RoomId::parse(room_id).map_err(|_| "Invalid room ID.")?;
    let ac = get_authed_client(state).await?;
    let room = ac
        .client
        .get_room(&room_id)
        .filter(|room| room.state() == RoomState::Joined)
        .ok_or("Join the room before managing its feeds.")?;
    let (_, settings, member) = read_feed_settings(&state.http_client, &ac, &room_id).await?;
    let bot_user_id = OwnedUserId::try_from(settings.feed.bot_user_id)
        .map_err(|_| "Invalid feed bot address.")?;
    if read_provider_membership(&state.http_client, &ac, &room_id, bot_user_id.as_str()).await?
        != "join"
    {
        return Err("The RSS bot needs to join the room before it can list subscriptions.".into());
    }
    let member = member.ok_or("Wait for the room to finish syncing and try again.")?;
    if !member.can_send_message(MessageLikeEventType::RoomMessage) {
        return Err(
            "You need permission to send messages to ask the RSS bot for subscriptions.".into(),
        );
    }
    let can_manage = if bot_user_id.as_str() == T2BOT {
        member.can_kick()
    } else {
        member.can_send_state("xyz.maubot.rss".into())
    };
    Ok(RssRoom {
        room,
        bot_user_id,
        can_manage,
    })
}

impl RssRoom {
    async fn send_command(&self, command: String) -> Result<BotResponse, String> {
        let (sender, mut replies) = tokio::sync::mpsc::channel(32);
        let bot = self.bot_user_id.clone();
        let messages = sender.clone();
        // Register before sending so that a fast reply can arrive ahead of the send response.
        let handler = self
            .room
            .add_event_handler(move |event: OriginalSyncRoomMessageEvent| {
                let sender = messages.clone();
                let from_bot = event.sender == bot;
                async move {
                    if from_bot {
                        if let Some(reply) =
                            reply_to_from_message_relation(&event.content.relates_to)
                        {
                            let response =
                                BotResponse::Reply(extract_message_display(&event.content));
                            let _ = sender.try_send((reply.event_id, response));
                        }
                    }
                }
            });
        let _handler = self.room.client().event_handler_drop_guard(handler);
        let _reaction_handler = (self.bot_user_id.as_str() == T2BOT && command != LIST_COMMAND)
            .then(|| {
                let bot = self.bot_user_id.clone();
                let handler =
                    self.room
                        .add_event_handler(move |event: OriginalSyncReactionEvent| {
                            let sender = sender.clone();
                            let from_bot = event.sender == bot;
                            async move {
                                if from_bot && event.content.relates_to.key == "✅" {
                                    let target = event.content.relates_to.event_id.to_string();
                                    let _ = sender.try_send((target, BotResponse::Confirmed));
                                }
                            }
                        });
                self.room.client().event_handler_drop_guard(handler)
            });
        let sent = self
            .room
            .send(RoomMessageEventContent::text_plain(command))
            .await
            .map_err(|e| format!("Could not send the RSS command: {e}"))?;

        tokio::time::timeout(REPLY_TIMEOUT, async {
            while let Some((event_id, response)) = replies.recv().await {
                if event_id == sent.event_id.as_str() {
                    return Ok(response);
                }
            }
            Err("Could not read the RSS bot’s reply.".into())
        })
        .await
        .map_err(|_| "The RSS bot did not reply. Refresh the subscriptions to check the room.")?
    }
}

fn normalized_title(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn subscription(id: &str, title: &str, url: &str) -> Option<RssSubscription> {
    let id = id.parse::<u64>().ok()?.to_string();
    let url = parse_feed_url(url).ok()?.to_string();
    let title = normalized_title(title);
    Some(RssSubscription {
        id,
        title: if title.is_empty() { url.clone() } else { title },
        url,
    })
}

fn url_subscription(raw_url: &str) -> Option<RssSubscription> {
    let url = parse_feed_url(raw_url).ok()?;
    let title = url.host_str()?.trim_start_matches("www.").to_owned();
    Some(RssSubscription {
        id: raw_url.trim().to_owned(),
        title,
        url: url.to_string(),
    })
}

fn reply_html(reply: &MessageDisplayExtract) -> Option<NodeRef> {
    let doc = kuchikiki::parse_html()
        .one(reply.formatted_body.as_deref()?)
        .document_node;
    if let Ok(replies) = doc.select("mx-reply") {
        for quoted in replies {
            quoted.as_node().detach();
        }
    }
    Some(doc)
}

fn formatted_subscriptions(doc: &NodeRef) -> Option<Vec<RssSubscription>> {
    doc.select("li")
        .ok()?
        .map(|row| {
            let text = row.text_contents();
            let (id, _) = text.trim().split_once(" - ")?;
            let link = row.as_node().select_first("a[href]").ok()?;
            let attrs = link.attributes.borrow();
            subscription(id, &link.text_contents(), attrs.get("href")?)
        })
        .collect()
}

fn plain_subscription(line: &str) -> Option<RssSubscription> {
    let line = line.trim().trim_start_matches(['*', '-', '•']).trim_start();
    let (id, rest) = line.split_once(" - ")?;
    let entry = rest.split(" (subscribed by ").next()?.trim_end();
    let (title, url) = entry
        .strip_prefix('[')
        .and_then(|rest| rest.rsplit_once("]("))
        .or_else(|| entry.rsplit_once(" ("))?;
    subscription(id, title, url.strip_suffix(')')?)
}

fn subscriptions_from_reply(reply: &MessageDisplayExtract) -> Result<Vec<RssSubscription>, String> {
    let body = reply.body.trim();
    if body.trim_end_matches('.') == EMPTY_LIST {
        return Ok(Vec::new());
    }
    if body.trim_start_matches('*').starts_with(LIST_HEADER) {
        if let Some(feeds) = reply_html(reply).and_then(|doc| formatted_subscriptions(&doc)) {
            if !feeds.is_empty() {
                return Ok(feeds);
            }
        }
        let feeds: Option<Vec<_>> = body
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|line| {
                line.starts_with("* ") || line.starts_with("- ") || line.starts_with("• ")
            })
            .map(plain_subscription)
            .collect();
        if let Some(feeds) = feeds.filter(|feeds| !feeds.is_empty()) {
            return Ok(feeds);
        }
    }
    Err("The RSS bot returned a subscription list Pax could not read.".into())
}

fn t2bot_subscriptions(reply: &MessageDisplayExtract) -> Option<Vec<RssSubscription>> {
    if reply.body.trim() == "No subscriptions." {
        return Some(Vec::new());
    }
    if !reply.body.trim_start().starts_with("Subscriptions:") {
        return None;
    }
    let doc = reply_html(reply)?;
    let feeds: Option<Vec<_>> = doc
        .select("li")
        .ok()?
        .map(|row| url_subscription(&row.text_contents()))
        .collect();
    feeds.filter(|feeds| !feeds.is_empty())
}

pub(super) fn subscribed_from_reply(
    reply: &MessageDisplayExtract,
    url: String,
) -> Result<RssSubscription, String> {
    let body = reply.body.trim();
    let status = body.strip_prefix("Subscribed to feed ID ").or_else(|| {
        body.split_once(" had already subscribed this room to feed ID ")
            .map(|(_, rest)| rest)
    });
    if let Some((id, title_with_link)) = status.and_then(|rest| rest.split_once(':')) {
        let title_from_html = reply_html(reply).and_then(|doc| {
            doc.select("a[href]").ok()?.find_map(|link| {
                let href = parse_feed_url(link.attributes.borrow().get("href")?).ok()?;
                (href.as_str() == url).then(|| link.text_contents())
            })
        });
        let title = title_from_html.unwrap_or_else(|| {
            let text = title_with_link.trim();
            text.split_once("](")
                .and_then(|(title, _)| title.strip_prefix('['))
                .or_else(|| text.rsplit_once(" (").map(|(title, _)| title))
                .unwrap_or(text)
                .to_owned()
        });
        if let Some(feed) = subscription(id, &title, &url) {
            return Ok(feed);
        }
    }
    Err(unconfirmed_change(reply))
}

fn unconfirmed_change(reply: &MessageDisplayExtract) -> String {
    let explanation: String = reply
        .body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect();
    format!("The RSS bot did not confirm the change. {explanation}")
}

#[tauri::command]
pub async fn list_rss_subscriptions(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RssSubscriptionList, String> {
    let room = rss_room(&state, &room_id).await?;
    let BotResponse::Reply(reply) = room.send_command(LIST_COMMAND.into()).await? else {
        return Err("The RSS bot did not send a subscription list.".into());
    };
    let subscriptions = if room.bot_user_id.as_str() == T2BOT {
        t2bot_subscriptions(&reply)
            .ok_or("The RSS bot returned a subscription list Pax could not read.")?
    } else {
        subscriptions_from_reply(&reply)?
    };
    Ok(RssSubscriptionList {
        bot_user_id: room.bot_user_id,
        can_manage: room.can_manage,
        subscriptions,
    })
}

#[tauri::command]
pub async fn update_rss_subscription(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    expected_bot_user_id: String,
    change: RssSubscriptionChange,
) -> Result<Option<RssSubscription>, String> {
    let room = rss_room(&state, &room_id).await?;
    if room.bot_user_id.as_str() != expected_bot_user_id {
        return Err("The room’s RSS bot changed. Refresh the subscriptions and try again.".into());
    }
    if !room.can_manage {
        return Err("You need room permission to manage RSS subscriptions.".into());
    }
    if room.bot_user_id.as_str() == T2BOT {
        let (command, added) = match change {
            RssSubscriptionChange::Subscribe { url } => {
                let url = parse_feed_url(&url)?.to_string();
                (format!("!rss subscribe {url}"), url_subscription(&url))
            }
            RssSubscriptionChange::Unsubscribe { id } => {
                parse_feed_url(&id)?;
                (format!("!rss unsubscribe {}", id.trim()), None)
            }
        };
        return match room.send_command(command).await? {
            BotResponse::Confirmed => Ok(added),
            BotResponse::Reply(reply) => Err(unconfirmed_change(&reply)),
        };
    }
    match change {
        RssSubscriptionChange::Subscribe { url } => {
            let url = parse_feed_url(&url)?.to_string();
            let BotResponse::Reply(reply) =
                room.send_command(format!("!rss subscribe {url}")).await?
            else {
                return Err("The RSS bot did not return a subscription ID.".into());
            };
            subscribed_from_reply(&reply, url).map(Some)
        }
        RssSubscriptionChange::Unsubscribe { id } => {
            let id = id
                .parse::<u64>()
                .map_err(|_| "Invalid RSS subscription ID.")?;
            let BotResponse::Reply(reply) =
                room.send_command(format!("!rss unsubscribe {id}")).await?
            else {
                return Err("The RSS bot did not confirm removal.".into());
            };
            let expected = format!("Unsubscribed from feed ID {id}:");
            if reply.body.trim().starts_with(&expected)
                || reply.body.trim().trim_end_matches('.')
                    == "This room is not subscribed to that feed"
            {
                Ok(None)
            } else {
                Err(unconfirmed_change(&reply))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client, RssTestRoom, Server, TestDir, USER},
    };
    use matrix_sdk::config::SyncSettings;
    use serde_json::json;

    #[tokio::test]
    async fn command_waits_for_the_configured_bots_reply_to_its_event() {
        let server = Server::start().await;
        server.state.lock().unwrap().rss_room = Some(RssTestRoom {
            settings: json!({}),
            memberships: Default::default(),
            reject_invites: false,
        });
        let dir = TestDir::new();
        let client = client(
            &server.home,
            &dir.0,
            SavedSession {
                user_id: USER.into(),
                device_id: "RSS_LIST_TEST".into(),
                access_token: "test-token".into(),
            },
        )
        .await;
        let room = RssRoom {
            room: client
                .get_room(&RoomId::parse("!test:example.org").unwrap())
                .unwrap(),
            bot_user_id: OwnedUserId::try_from("@bot:nope.chat").unwrap(),
            can_manage: true,
        };
        let deliver_replies = async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let sent =
                        server
                            .state
                            .lock()
                            .unwrap()
                            .requests
                            .iter()
                            .any(|(_, path, content)| {
                                path.contains("/send/m.room.message/")
                                    && content["body"] == LIST_COMMAND
                            });
                    if sent {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the command should be sent to the Matrix room");
            let reply = |id: &str, sender: &str, target: &str, body: &str| {
                json!({
                    "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": 5,
                    "content": {
                        "msgtype": "m.notice", "body": body,
                        "m.relates_to": {"m.in_reply_to": {"event_id": target}}
                    }
                })
            };
            let events = vec![
                reply(
                    "$other-sender",
                    "@bob:example.org",
                    "$rss-subscribe",
                    "Wrong sender",
                ),
                reply(
                    "$other-command",
                    "@bot:nope.chat",
                    "$other",
                    "Wrong command",
                ),
                reply(
                    "$bot-response",
                    "@bot:nope.chat",
                    "$rss-subscribe",
                    EMPTY_LIST,
                ),
            ];
            {
                let mut state = server.state.lock().unwrap();
                let sync_path = state
                    .requests
                    .iter()
                    .find(|(_, path, _)| path.ends_with("/sync"))
                    .unwrap()
                    .1
                    .clone();
                state.route_overrides.insert(("GET".into(), sync_path), (200, json!({
                    "next_batch": "rss-replies",
                    "rooms": {"join": {"!test:example.org": {"timeline": {"events": events, "limited": false}}}}
                })));
            }
            client.sync_once(SyncSettings::default()).await.unwrap();
        };
        let (reply, _) = tokio::join!(room.send_command(LIST_COMMAND.into()), deliver_replies);
        let BotResponse::Reply(reply) = reply.unwrap() else {
            panic!("Expected a message");
        };
        assert!(subscriptions_from_reply(&reply).unwrap().is_empty());
    }

    #[test]
    fn reads_maubot_formatted_subscriptions_and_ignores_the_quoted_reply() {
        let reply = MessageDisplayExtract {
            body: "Subscriptions in this room:\n\n* 42 - World News".into(),
            formatted_body: Some(r#"<mx-reply><ul><li>15 - <a href="https://wrong.example/feed">Quote</a></li></ul></mx-reply>
              <p><strong>Subscriptions in this room:</strong></p><ul>
              <li>42 - <a href="https://example.org/feed?q=(world)&amp;lang=en">World &amp; News</a>
              (subscribed by <a href="https://matrix.to/#/@test:example.org">@test</a>)</li>
              <li>43 - <a href="https://example.net/rss">Local</a></li></ul>"#.into()),
            ..Default::default()
        };
        assert_eq!(
            subscriptions_from_reply(&reply).unwrap(),
            [
                subscription(
                    "42",
                    "World & News",
                    "https://example.org/feed?q=(world)&lang=en"
                )
                .unwrap(),
                subscription("43", "Local", "https://example.net/rss").unwrap(),
            ]
        );
    }

    #[test]
    fn distinguishes_no_subscriptions_from_an_unsupported_reply() {
        let reply = |body: &str| MessageDisplayExtract {
            body: body.into(),
            ..Default::default()
        };
        assert!(subscriptions_from_reply(&reply(EMPTY_LIST))
            .unwrap()
            .is_empty());
        assert!(subscriptions_from_reply(&reply("Unknown subcommand")).is_err());
        assert_eq!(subscriptions_from_reply(&reply(
            "**Subscriptions in this room:**\n* 42 - [News](https://example.org/rss) (subscribed by @test)"
        )).unwrap(), [subscription("42", "News", "https://example.org/rss").unwrap()]);
    }

    #[test]
    fn retains_the_exact_url_for_removing_a_t2bot_subscription() {
        let reply = MessageDisplayExtract {
            body: "Subscriptions:\n* https://EXAMPLE.org/rss?q=topic&lang=en".into(),
            formatted_body: Some(
                "Subscriptions:<ul><li>https://EXAMPLE.org/rss?q=topic&amp;lang=en</li></ul>"
                    .into(),
            ),
            ..Default::default()
        };
        assert_eq!(
            t2bot_subscriptions(&reply).unwrap(),
            [RssSubscription {
                id: "https://EXAMPLE.org/rss?q=topic&lang=en".into(),
                title: "example.org".into(),
                url: "https://example.org/rss?q=topic&lang=en".into(),
            }]
        );
    }

    #[test]
    fn uses_the_bot_feed_id_for_new_or_existing_subscriptions() {
        let url = "https://example.org/rss";
        for status in ["Subscribed to", "You had already subscribed this room to"] {
            let reply = MessageDisplayExtract {
                body: format!("{status} feed ID 42: News ({url})"),
                ..Default::default()
            };
            assert_eq!(
                subscribed_from_reply(&reply, url.into()).unwrap(),
                subscription("42", "News", url).unwrap()
            );
        }
    }
}

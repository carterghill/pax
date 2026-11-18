use std::{sync::Arc, time::Duration};

use matrix_sdk::ruma::{
    events::{room::message::RoomMessageEventContent, MessageLikeEventType},
    RoomId, UserId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::AppState;

use super::{get_authed_client, AuthedClient};

pub(crate) const RSS_FEED_EVENT: &str = "ca.brandxtech.pax.rss";
// A remount or a second window must not race the send/status-save sequence.
static SETUP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedStatus {
    url: String,
    bot_user_id: String,
    membership: String,
    room_synced: bool,
    can_manage: bool,
    can_invite: bool,
    auto_setup: bool,
    subscription_event_id: Option<String>,
    subscription_confirmed: bool,
    confirmation_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedConfig {
    pub url: String,
    pub bot_user_id: String,
}

impl RssFeedConfig {
    fn validated(&self) -> Result<Self, String> {
        let raw_url = self.url.trim();
        if raw_url.is_empty() || raw_url.chars().any(char::is_whitespace) {
            return Err("Enter a feed URL without spaces or line breaks.".into());
        }
        let url = reqwest::Url::parse(raw_url)
            .map_err(|_| "Enter a valid feed URL starting with https:// or http://.")?;
        if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
            return Err("Feed URLs must start with https:// or http://.".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Feed URLs cannot contain a username or password.".into());
        }
        let bot_user_id = self.bot_user_id.trim();
        UserId::parse(bot_user_id)
            .map_err(|_| "Enter a Matrix bot address such as @rss:t2bot.io.")?;
        Ok(Self {
            url: url.to_string(),
            bot_user_id: bot_user_id.to_owned(),
        })
    }

    fn state_content(&self) -> Value {
        json!({ "version": 1, "provider": "rss-command", "url": self.url, "botUserId": self.bot_user_id })
    }

    fn transaction_id(&self, room_id: &str) -> String {
        // Retrying setup in the same room must not post another subscribe command.
        let key = format!("{room_id}\n{}\n{}", self.bot_user_id, self.url);
        format!(
            "pax-rss-{}",
            uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, key.as_bytes())
        )
    }
}

/// Include the feed marker and invitation in the room's initial state. Leave
/// m.room.create.type unset so other clients still treat it as a normal chat.
pub(super) fn add_feed_to_creation(
    body: &mut Value,
    feed: Option<&RssFeedConfig>,
    federate: bool,
    own_user_id: &UserId,
) -> Result<(), String> {
    let Some(feed) = feed else { return Ok(()) };
    let feed = feed.validated()?;
    let bot = UserId::parse(&feed.bot_user_id).map_err(|e| e.to_string())?;
    if bot == own_user_id {
        return Err("Choose an RSS bot account other than your own account.".into());
    }
    if !federate && bot.server_name() != own_user_id.server_name() {
        return Err("Enable federation to use a feed bot on another homeserver.".into());
    }
    if body["creation_content"].get("type").is_some() {
        return Err("RSS feeds can only be added to text rooms.".into());
    }
    let mut content = feed.state_content();
    content["createdBy"] = json!(own_user_id);
    body["initial_state"]
        .as_array_mut()
        .ok_or("Missing initial room state")?
        .push(json!({
            "type": RSS_FEED_EVENT,
            "state_key": "",
            "content": content,
        }));
    body["invite"] = json!([feed.bot_user_id]);
    Ok(())
}

async fn response_json(response: reqwest::Response, action: &str) -> Result<Value, String> {
    let status = response.status();
    let content: Value = response
        .json()
        .await
        .map_err(|_| format!("{action}: the homeserver returned an invalid response."))?;
    if !status.is_success() {
        return Err(format!(
            "{action}: {}",
            content["error"].as_str().unwrap_or(status.as_str())
        ));
    }
    Ok(content)
}

async fn read_feed_status(
    state: &AppState,
    ac: &AuthedClient,
    room_id: &RoomId,
) -> Result<(Value, RssFeedStatus), String> {
    let room_base = format!(
        "{}/_matrix/client/v3/rooms/{}",
        ac.homeserver,
        urlencoding::encode(room_id.as_str())
    );
    let response = state
        .http_client
        .get(format!("{room_base}/state/{RSS_FEED_EVENT}/"))
        .bearer_auth(&ac.access_token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Could not read the feed settings: {e}"))?;
    let settings = response_json(response, "Could not read the feed settings").await?;
    if settings["version"] != 1 || settings["provider"] != "rss-command" {
        return Err("This room uses an unsupported feed provider.".into());
    }
    let feed = serde_json::from_value::<RssFeedConfig>(settings.clone())
        .map_err(|_| "This room's feed settings are incomplete.")?
        .validated()?;
    let membership_url = format!(
        "{room_base}/state/m.room.member/{}",
        urlencoding::encode(&feed.bot_user_id)
    );
    let response = state
        .http_client
        .get(membership_url)
        .bearer_auth(&ac.access_token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Could not check the provider's membership: {e}"))?;
    let membership = if response.status() == reqwest::StatusCode::NOT_FOUND {
        "none".to_owned()
    } else {
        response_json(response, "Could not check the provider's membership").await?["membership"]
            .as_str()
            .unwrap_or("unknown")
            .to_owned()
    };
    let room = ac.client.get_room(room_id);
    let mut can_manage = false;
    let mut can_invite = false;
    let mut auto_setup = false;
    if let Some(room) = &room {
        let own_id = ac.client.user_id().ok_or("Not logged in")?;
        if let Some(member) = room
            .get_member_no_sync(own_id)
            .await
            .map_err(|e| e.to_string())?
        {
            // t2bot requires permission to kick to manage subscriptions.
            can_manage = member.can_send_state(RSS_FEED_EVENT.into())
                && member.can_send_message(MessageLikeEventType::RoomMessage)
                && member.can_kick();
            can_invite = member.can_invite();
        }
        let mut created_by = settings["createdBy"].as_str().map(str::to_owned);
        // Rooms created before createdBy was saved still resume automatically.
        if created_by.is_none() {
            if let Some(event) = room
                .get_state_event(RSS_FEED_EVENT.into(), "")
                .await
                .map_err(|e| e.to_string())?
            {
                use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
                let value = match event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.deserialize_as::<Value>(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.deserialize_as::<Value>(),
                }
                .map_err(|e| e.to_string())?;
                created_by = value["sender"].as_str().map(str::to_owned);
            }
        }
        auto_setup = can_manage && created_by.as_deref() == Some(own_id.as_str());
    }
    let status = RssFeedStatus {
        url: feed.url,
        bot_user_id: feed.bot_user_id,
        membership,
        room_synced: room.is_some(),
        can_manage,
        can_invite,
        auto_setup,
        subscription_event_id: settings["subscriptionEventId"].as_str().map(str::to_owned),
        subscription_confirmed: false,
        confirmation_error: None,
    };
    Ok((settings, status))
}

fn is_subscription_confirmation(event: &Value, bot_user_id: &str, subscription_id: &str) -> bool {
    let relation = &event["content"]["m.relates_to"];
    event["type"] == "m.reaction"
        && event["sender"] == bot_user_id
        && relation["rel_type"] == "m.annotation"
        && relation["event_id"] == subscription_id
        && relation["key"] == "✅"
}

/// Read membership from the homeserver, independently of the SDK's room sync.
#[tauri::command]
pub async fn get_rss_feed_status(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RssFeedStatus, String> {
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let (_, mut status) = read_feed_status(&state, &ac, &room_id).await?;
    if let Some(event_id) = &status.subscription_event_id {
        // Check the provider's own acknowledgement, never infer health from membership.
        let url = format!(
            "{}/_matrix/client/v1/rooms/{}/relations/{}/m.annotation/m.reaction?limit=100",
            ac.homeserver,
            urlencoding::encode(room_id.as_str()),
            urlencoding::encode(event_id)
        );
        let confirmation = async {
            let response = state
                .http_client
                .get(url)
                .bearer_auth(&ac.access_token)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let body =
                response_json(response, "Could not check the subscription confirmation").await?;
            Ok::<bool, String>(body["chunk"].as_array().is_some_and(|events| {
                events
                    .iter()
                    .any(|e| is_subscription_confirmation(e, &status.bot_user_id, event_id))
            }))
        }
        .await;
        match confirmation {
            Ok(confirmed) => status.subscription_confirmed = confirmed,
            Err(error) => status.confirmation_error = Some(error),
        }
    }
    Ok(status)
}

/// One attempt, without waiting for membership or local sync. The room UI
/// watches readiness and can retry this step without creating another room.
#[tauri::command]
pub async fn setup_rss_feed(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<(), String> {
    let _guard = SETUP_LOCK.lock().await;
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let (mut settings, status) = read_feed_status(&state, &ac, &room_id).await?;
    if status.subscription_event_id.is_some() {
        return Ok(());
    }
    if status.membership != "join" {
        return Err("Waiting for the feed provider to join.".into());
    }
    let room = ac
        .client
        .get_room(&room_id)
        .ok_or("The provider joined. Waiting for the room to finish syncing.")?;
    if !status.can_manage {
        return Err(
            "A room moderator with permission to manage feed settings must finish setup.".into(),
        );
    }
    let feed = RssFeedConfig {
        url: status.url,
        bot_user_id: status.bot_user_id,
    };

    // The SDK handles encryption if the room's settings have changed since creation.
    let sent = room
        .send(RoomMessageEventContent::text_plain(format!(
            "!rss subscribe {}",
            feed.url
        )))
        .with_transaction_id(feed.transaction_id(room_id.as_str()).into())
        .await
        .map_err(|e| format!("Could not send the feed subscription: {e}"))?;
    settings["subscriptionEventId"] = json!(sent.event_id);
    room.send_state_event_raw(RSS_FEED_EVENT, "", settings)
        .await
        .map_err(|e| {
            format!("The subscription was sent, but its status could not be saved: {e}")
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(url: &str) -> RssFeedConfig {
        RssFeedConfig {
            url: url.into(),
            bot_user_id: "@rss:t2bot.io".into(),
        }
    }

    #[test]
    fn rejects_invalid_feed_inputs_before_creating_a_room() {
        for url in [
            "",
            "example.org/feed",
            "file:///feed.xml",
            "https://user:secret@example.org/feed",
            "https://example.org/feed\n!rss unsubscribe all",
        ] {
            assert!(feed(url).validated().is_err(), "accepted {url}");
        }
        let mut config = feed("https://example.org/feed");
        config.bot_user_id = "rss:t2bot.io".into();
        assert!(config.validated().is_err());
    }

    #[test]
    fn rss_creation_preserves_normal_room_access_and_invites_only_the_selected_bot() {
        let mut body = json!({"creation_content":{"m.federate":true}, "initial_state":[
            {"type":"m.space.parent", "state_key":"!space:example.org", "content":{"canonical":true}}
        ]});
        let own = UserId::parse("@carter:example.org").unwrap();
        add_feed_to_creation(
            &mut body,
            Some(&feed(" https://example.org/feed ")),
            true,
            &own,
        )
        .unwrap();
        assert_eq!(body["invite"], json!(["@rss:t2bot.io"]));
        assert_eq!(body["initial_state"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["initial_state"][1]["content"]["url"],
            "https://example.org/feed"
        );
        assert!(body["creation_content"].get("type").is_none());
        assert!(body.get("power_level_content_override").is_none());
    }

    #[test]
    fn remote_bot_requires_federation_but_local_bot_does_not() {
        let own = UserId::parse("@carter:example.org").unwrap();
        let mut body = json!({"creation_content":{"m.federate":false}, "initial_state":[]});
        assert!(add_feed_to_creation(
            &mut body,
            Some(&feed("https://example.org/feed")),
            false,
            &own
        )
        .is_err());
        let mut local = feed("https://example.org/feed");
        local.bot_user_id = "@rss:example.org".into();
        add_feed_to_creation(&mut body, Some(&local), false, &own).unwrap();
    }

    #[test]
    fn subscription_retry_reuses_transaction_only_for_the_same_room_and_feed() {
        let config = feed("https://example.org/feed");
        assert_eq!(
            config.transaction_id("!a:example.org"),
            config.transaction_id("!a:example.org")
        );
        assert_ne!(
            config.transaction_id("!a:example.org"),
            config.transaction_id("!b:example.org")
        );
        assert_ne!(
            config.transaction_id("!a:example.org"),
            feed("https://example.org/other").transaction_id("!a:example.org")
        );
    }

    #[test]
    fn only_the_selected_providers_acknowledgement_confirms_this_subscription() {
        let event = json!({
            "type": "m.reaction", "sender": "@rss:t2bot.io",
            "content": {"m.relates_to": {
                "rel_type": "m.annotation", "event_id": "$subscribe", "key": "✅"
            }}
        });
        assert!(is_subscription_confirmation(
            &event,
            "@rss:t2bot.io",
            "$subscribe"
        ));
        assert!(!is_subscription_confirmation(
            &event,
            "@another:example.org",
            "$subscribe"
        ));
        assert!(!is_subscription_confirmation(
            &event,
            "@rss:t2bot.io",
            "$other"
        ));
        let mut redacted = event.clone();
        redacted["content"] = json!({});
        assert!(!is_subscription_confirmation(
            &redacted,
            "@rss:t2bot.io",
            "$subscribe"
        ));
        let mut other_reaction = event;
        other_reaction["content"]["m.relates_to"]["key"] = json!("👍");
        assert!(!is_subscription_confirmation(
            &other_reaction,
            "@rss:t2bot.io",
            "$subscribe"
        ));
    }
}

pub(super) mod activity;
pub mod subscriptions;

use std::{sync::Arc, time::Duration};

use matrix_sdk::ruma::{
    events::{room::message::RoomMessageEventContent, MessageLikeEventType},
    RoomId, UserId,
};
use matrix_sdk::{deserialized_responses::RawAnySyncOrStrippedState, room::RoomMember, Room};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, State};

use crate::AppState;

use super::{get_authed_client, AuthedClient};

pub(crate) const RSS_FEED_EVENT: &str = "ca.brandxtech.pax.rss";
pub(super) const RSS_FEED_CHANGED: &str = "rss-feed-changed";
// Serialize settings and membership changes with the subscription send and state save.
static RSS_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedSettings {
    #[serde(flatten)]
    provider: RssRoomProvider,
    #[serde(skip)]
    initial_feed_url: Option<String>,
    revision: Option<String>,
    invitation_cancelled: bool,
    can_edit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedStatus {
    #[serde(flatten)]
    settings: RssFeedSettings,
    membership: String,
    room_synced: bool,
    can_manage: bool,
    can_invite: bool,
    can_cancel_invitation: bool,
    auto_setup: bool,
    initial_subscription_pending: bool,
    subscription_event_id: Option<String>,
    subscription_confirmed: bool,
    subscription_replied: bool,
    confirmation_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedSaveResult {
    settings: RssFeedSettings,
    setup_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssRoomProvider {
    pub bot_user_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedConfig {
    #[serde(rename = "url")]
    initial_feed_url: String,
    #[serde(flatten)]
    provider: RssRoomProvider,
}

pub(super) fn parse_feed_url(raw_url: &str) -> Result<reqwest::Url, String> {
    let raw_url = raw_url.trim();
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
    Ok(url)
}

impl RssRoomProvider {
    pub(super) fn from_state_content(content: &Value) -> Result<Self, String> {
        if content["version"] != 1 || content["provider"] != "rss-command" {
            return Err("This room uses an unsupported feed provider.".into());
        }
        Self::deserialize(content)
            .map_err(|_| "This room's feed settings are incomplete.")?
            .validated()
    }

    fn validated(&self) -> Result<Self, String> {
        let bot_user_id = self.bot_user_id.trim();
        UserId::parse(bot_user_id)
            .map_err(|_| "Enter a Matrix bot address in the form @bot:example.org.")?;
        Ok(Self {
            bot_user_id: bot_user_id.to_owned(),
        })
    }
}

impl RssFeedConfig {
    fn validated(&self) -> Result<Self, String> {
        Ok(Self {
            initial_feed_url: parse_feed_url(&self.initial_feed_url)?.to_string(),
            provider: self.provider.validated()?,
        })
    }

    fn state_content(&self) -> Value {
        // Keep the version 1 wire key for older clients. It stores the creation request.
        json!({ "version": 1, "provider": "rss-command", "url": self.initial_feed_url, "botUserId": self.provider.bot_user_id })
    }

    fn transaction_id(&self, room_id: &str, revision: Option<&str>) -> String {
        // Keep the original ID for legacy rooms and scope edits to their own setup attempt.
        let mut key = format!(
            "{room_id}\n{}\n{}",
            self.provider.bot_user_id, self.initial_feed_url
        );
        if let Some(revision) = revision {
            key.push('\n');
            key.push_str(revision);
        }
        format!(
            "pax-rss-{}",
            uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, key.as_bytes())
        )
    }
}

impl RssFeedSettings {
    fn check_revision(&self, expected: Option<&str>) -> Result<(), String> {
        if self.revision.as_deref() != expected {
            return Err("Feed settings changed. Refresh and try again.".into());
        }
        Ok(())
    }
}

fn ensure_provider_is_not_self(bot: &UserId, own_id: &UserId) -> Result<(), String> {
    if bot == own_id {
        return Err("Choose an RSS bot account other than your own account.".into());
    }
    Ok(())
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
    let bot = UserId::parse(&feed.provider.bot_user_id).map_err(|e| e.to_string())?;
    ensure_provider_is_not_self(&bot, own_user_id)?;
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
    body["invite"] = json!([feed.provider.bot_user_id]);
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

async fn read_provider_membership(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
    bot_user_id: &str,
) -> Result<String, String> {
    let path = format!("m.room.member/{}", urlencoding::encode(bot_user_id));
    let content = super::room_settings::http_get_room_state(
        http,
        &ac.homeserver,
        &ac.access_token,
        room_id.as_str(),
        &path,
    )
    .await
    .map_err(|e| format!("Could not check the provider's membership: {e}"))?;
    Ok(match content {
        None => "none".into(),
        Some(value) => value["membership"].as_str().unwrap_or("unknown").into(),
    })
}

async fn read_feed_settings(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
) -> Result<(Value, RssFeedSettings, Option<RoomMember>), String> {
    let settings = super::room_settings::http_get_room_state(
        http,
        &ac.homeserver,
        &ac.access_token,
        room_id.as_str(),
        &format!("{RSS_FEED_EVENT}/"),
    )
    .await
    .map_err(|e| format!("Could not read the feed settings: {e}"))?
    .ok_or("This room has no RSS feed settings.")?;
    let provider = RssRoomProvider::from_state_content(&settings)?;
    let own_id = ac.client.user_id().ok_or("Not logged in")?;
    let member = match ac.client.get_room(room_id) {
        Some(room) => room
            .get_member_no_sync(own_id)
            .await
            .map_err(|e| e.to_string())?,
        None => None,
    };
    let feed_settings = RssFeedSettings {
        provider,
        initial_feed_url: settings["url"]
            .as_str()
            .and_then(|url| parse_feed_url(url).ok())
            .map(|url| url.to_string()),
        revision: settings["revision"].as_str().map(str::to_owned),
        invitation_cancelled: settings["invitationCancelled"] == true,
        can_edit: member
            .as_ref()
            .is_some_and(|m| m.can_send_state(RSS_FEED_EVENT.into())),
    };
    Ok((settings, feed_settings, member))
}

async fn cached_feed_event(room: &Room) -> Option<Value> {
    let event = room
        .get_state_event(RSS_FEED_EVENT.into(), "")
        .await
        .ok()??;
    match event {
        RawAnySyncOrStrippedState::Sync(raw) => raw.deserialize_as(),
        RawAnySyncOrStrippedState::Stripped(raw) => raw.deserialize_as(),
    }
    .ok()
}

fn can_set_up_feed(member: &RoomMember) -> bool {
    // Some providers require the sender to have permission to kick in order to subscribe.
    member.can_send_state(RSS_FEED_EVENT.into())
        && member.can_send_message(MessageLikeEventType::RoomMessage)
        && member.can_kick()
}

async fn read_feed_status(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
) -> Result<(Value, RssFeedStatus), String> {
    let (settings, feed_settings, member) = read_feed_settings(http, ac, room_id).await?;
    let membership = if feed_settings.invitation_cancelled {
        "none".into()
    } else {
        read_provider_membership(http, ac, room_id, &feed_settings.provider.bot_user_id).await?
    };
    let room = ac.client.get_room(room_id);
    let can_manage = member.as_ref().is_some_and(can_set_up_feed);
    let can_invite = member.as_ref().is_some_and(|m| m.can_invite());
    let can_cancel_invitation =
        feed_settings.can_edit && member.as_ref().is_some_and(|m| m.can_kick());
    let subscription_event_id = settings["subscriptionEventId"].as_str();
    let initial_subscription_pending =
        feed_settings.initial_feed_url.is_some() && subscription_event_id.is_none();
    let mut auto_setup = false;
    if let Some(room) = room.as_ref().filter(|_| {
        initial_subscription_pending && can_manage && !feed_settings.invitation_cancelled
    }) {
        let own_id = ac.client.user_id().ok_or("Not logged in")?;
        // Rooms created before createdBy was saved still resume automatically.
        auto_setup = match settings["createdBy"].as_str() {
            Some(creator) => creator == own_id.as_str(),
            None => cached_feed_event(room)
                .await
                .is_some_and(|event| event["sender"] == own_id.as_str()),
        };
    }
    let subscription_event_id = subscription_event_id
        .filter(|_| {
            settings["subscriptionBotUserId"]
                .as_str()
                .is_none_or(|bot| bot == feed_settings.provider.bot_user_id)
        })
        .map(str::to_owned);
    let status = RssFeedStatus {
        settings: feed_settings,
        membership,
        room_synced: room.is_some(),
        can_manage,
        can_invite,
        can_cancel_invitation,
        auto_setup,
        initial_subscription_pending,
        subscription_event_id,
        subscription_confirmed: false,
        subscription_replied: false,
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

#[tauri::command]
pub async fn get_rss_bot_settings(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RssFeedSettings, String> {
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let (_, settings, _) = read_feed_settings(&state.http_client, &ac, &room_id).await?;
    Ok(settings)
}

/// Read membership from the homeserver, independently of the SDK's room sync.
#[tauri::command]
pub async fn get_rss_feed_status(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RssFeedStatus, String> {
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let (_, mut status) = read_feed_status(&state.http_client, &ac, &room_id).await?;
    if let Some(event_id) = status
        .subscription_event_id
        .as_ref()
        .filter(|_| status.membership == "join")
    {
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
                events.iter().any(|e| {
                    is_subscription_confirmation(e, &status.settings.provider.bot_user_id, event_id)
                })
            }))
        }
        .await;
        match confirmation {
            Ok(confirmed) => status.subscription_confirmed = confirmed,
            Err(error) => status.confirmation_error = Some(error),
        }
        // Maubot acknowledges with a rich reply rather than a reaction.
        // Rich replies aren't indexed by the annotation endpoint above.
        if !status.subscription_confirmed {
            if let (Some(room), Ok(event)) = (
                ac.client.get_room(&room_id),
                matrix_sdk::ruma::EventId::parse(event_id),
            ) {
                let replies = tokio::time::timeout(
                    Duration::from_secs(4),
                    room.event_with_context(
                        &event,
                        false,
                        matrix_sdk::ruma::UInt::from(20u32),
                        None,
                    ),
                )
                .await;
                if let Ok(Ok(context)) = replies {
                    for reply in context
                        .events_after
                        .iter()
                        .filter_map(activity::original_message)
                    {
                        let target = super::message_display::reply_to_from_message_relation(
                            &reply.content.relates_to,
                        );
                        if reply.sender.as_str() != status.settings.provider.bot_user_id
                            || target.as_ref().map(|target| target.event_id.as_str())
                                != Some(event_id.as_str())
                        {
                            continue;
                        }
                        let display =
                            super::message_display::extract_message_display(&reply.content);
                        status.subscription_confirmed = status
                            .settings
                            .initial_feed_url
                            .as_ref()
                            .is_some_and(|url| {
                                subscriptions::subscribed_from_reply(&display, url.clone()).is_ok()
                            });
                        status.subscription_replied = true;
                        status.confirmation_error = None;
                        break;
                    }
                }
            }
        }
    }
    Ok(status)
}

async fn invite_provider(room: &matrix_sdk::Room, bot: &UserId) -> Result<(), String> {
    room.invite_user_by_id(bot)
        .await
        .map_err(|e| format!("Could not invite the feed provider: {e}"))
}

async fn withdraw_provider_invite(room: &matrix_sdk::Room, bot: &UserId) -> Result<(), String> {
    room.kick_user(bot, Some("Feed provider invitation cancelled"))
        .await
        .map_err(|e| format!("Could not cancel the feed provider invitation: {e}"))
}

#[tauri::command]
pub async fn invite_rss_feed_provider(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    revision: Option<String>,
) -> Result<(), String> {
    let _guard = RSS_WRITE_LOCK.lock().await;
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let (_, status) = read_feed_status(&state.http_client, &ac, &room_id).await?;
    status.settings.check_revision(revision.as_deref())?;
    if status.settings.invitation_cancelled || status.membership == "join" {
        return Ok(());
    }
    if !status.can_invite || status.membership == "ban" {
        return Err("You cannot invite this provider to the room.".into());
    }
    let room = ac.client.get_room(&room_id).ok_or("Room not found")?;
    let bot = UserId::parse(&status.settings.provider.bot_user_id).map_err(|e| e.to_string())?;
    invite_provider(&room, &bot).await
}

async fn cancel_feed_invitation(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
    revision: Option<&str>,
) -> Result<(), String> {
    let (mut content, status) = read_feed_status(http, ac, room_id).await?;
    status.settings.check_revision(revision)?;
    if status.settings.invitation_cancelled {
        return Ok(());
    }
    if !status.can_cancel_invitation {
        return Err("You need permission to edit feed settings and remove invitees.".into());
    }
    let room = ac.client.get_room(room_id).ok_or("Room not found")?;
    match status.membership.as_str() {
        "invite" => {
            let bot =
                UserId::parse(&status.settings.provider.bot_user_id).map_err(|e| e.to_string())?;
            withdraw_provider_invite(&room, &bot).await?;
        }
        // The invite may have been declined or withdrawn while this window was open.
        "leave" | "none" => {}
        _ => return Err("This provider no longer has a pending invitation.".into()),
    }
    content["invitationCancelled"] = json!(true);
    content["revision"] = json!(uuid::Uuid::new_v4().to_string());
    room.send_state_event_raw(RSS_FEED_EVENT, "", content)
        .await
        .map_err(|e| {
            format!("The invitation is no longer pending, but Pax could not pause setup: {e}")
        })?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_rss_feed_invitation(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    room_id: String,
    revision: Option<String>,
) -> Result<(), String> {
    let _guard = RSS_WRITE_LOCK.lock().await;
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    cancel_feed_invitation(&state.http_client, &ac, &room_id, revision.as_deref()).await?;
    let _ = app.emit(RSS_FEED_CHANGED, room_id.as_str());
    Ok(())
}

fn should_invite_provider(membership: &str) -> bool {
    matches!(membership, "none" | "leave" | "knock")
}

async fn apply_bot_settings(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
    provider: RssRoomProvider,
    revision: Option<&str>,
) -> Result<RssFeedSaveResult, String> {
    let (mut content, current, member) = read_feed_settings(http, ac, room_id).await?;
    current.check_revision(revision)?;
    if !current.can_edit {
        return Err("You need permission to edit this room's feed settings.".into());
    }
    let provider = provider.validated()?;
    let bot = UserId::parse(&provider.bot_user_id).map_err(|e| e.to_string())?;
    let own_id = ac.client.user_id().ok_or("Not logged in")?;
    ensure_provider_is_not_self(&bot, own_id)?;
    if current.provider == provider && !current.invitation_cancelled {
        return Ok(RssFeedSaveResult {
            settings: current,
            setup_error: None,
        });
    }

    let room = ac.client.get_room(room_id).ok_or("Room not found")?;
    let membership = read_provider_membership(http, ac, room_id, bot.as_str()).await?;
    if membership == "ban" {
        return Err("Unban this provider before selecting it for this room.".into());
    }
    if should_invite_provider(&membership) {
        if !member.as_ref().is_some_and(|m| m.can_invite()) {
            return Err("You need permission to invite this provider to the room.".into());
        }
        if bot.server_name() != own_id.server_name() {
            let create = super::room_settings::http_get_room_state(
                http,
                &ac.homeserver,
                &ac.access_token,
                room_id.as_str(),
                "m.room.create/",
            )
            .await?;
            if create.is_some_and(|content| content["m.federate"] == false) {
                return Err(
                    "This room has federation disabled. Choose a provider on your homeserver."
                        .into(),
                );
            }
        }
    }

    if current.provider != provider
        && !current.invitation_cancelled
        && read_provider_membership(http, ac, room_id, &current.provider.bot_user_id).await?
            == "invite"
    {
        let old_bot = UserId::parse(&current.provider.bot_user_id).map_err(|e| e.to_string())?;
        withdraw_provider_invite(&room, &old_bot).await?;
    }

    let revision = uuid::Uuid::new_v4().to_string();
    let initial_setup_pending =
        current.initial_feed_url.is_some() && !content["subscriptionEventId"].is_string();
    if content["subscriptionEventId"].is_string() && content["subscriptionBotUserId"].is_null() {
        content["subscriptionBotUserId"] = json!(current.provider.bot_user_id);
    }
    content["botUserId"] = json!(provider.bot_user_id);
    content["createdBy"] = json!(own_id);
    content["revision"] = json!(revision);
    if let Some(content) = content.as_object_mut() {
        content.remove("invitationCancelled");
    }
    room.send_state_event_raw(RSS_FEED_EVENT, "", content)
        .await
        .map_err(|e| format!("Could not save the feed settings: {e}"))?;
    let settings = RssFeedSettings {
        provider,
        initial_feed_url: current.initial_feed_url,
        revision: Some(revision),
        invitation_cancelled: false,
        can_edit: true,
    };

    // Membership may have changed while the settings were being saved.
    let progress = match read_provider_membership(http, ac, room_id, bot.as_str()).await {
        Ok(membership) if should_invite_provider(&membership) => invite_provider(&room, &bot).await,
        Ok(membership)
            if initial_setup_pending
                && membership == "join"
                && member.as_ref().is_some_and(can_set_up_feed) =>
        {
            send_subscription(http, ac, &room, &settings).await
        }
        Ok(_) => Ok(()),
        Err(error) => Err(error),
    };
    Ok(RssFeedSaveResult {
        settings,
        setup_error: progress.err(),
    })
}

#[tauri::command]
pub async fn save_rss_bot_settings(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    room_id: String,
    bot_user_id: String,
    revision: Option<String>,
) -> Result<RssFeedSaveResult, String> {
    let _guard = RSS_WRITE_LOCK.lock().await;
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let result = apply_bot_settings(
        &state.http_client,
        &ac,
        &room_id,
        RssRoomProvider { bot_user_id },
        revision.as_deref(),
    )
    .await?;
    let _ = app.emit(RSS_FEED_CHANGED, room_id.as_str());
    Ok(result)
}

/// One attempt, without waiting for membership or local sync. The room UI
/// watches readiness and can retry this step without creating another room.
#[tauri::command]
pub async fn setup_rss_feed(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    revision: Option<String>,
) -> Result<(), String> {
    let _guard = RSS_WRITE_LOCK.lock().await;
    let room_id = RoomId::parse(&room_id).map_err(|_| "Invalid room ID")?;
    let ac = get_authed_client(&state).await?;
    let (_, status) = read_feed_status(&state.http_client, &ac, &room_id).await?;
    status.settings.check_revision(revision.as_deref())?;
    if status.settings.invitation_cancelled || !status.initial_subscription_pending {
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
    send_subscription(&state.http_client, &ac, &room, &status.settings).await
}

pub(super) async fn on_provider_joined(state: Arc<AppState>, room: Room, joined_user_id: &UserId) {
    if room.state() != matrix_sdk::RoomState::Joined {
        return;
    }
    let Some(event) = cached_feed_event(&room).await else {
        return;
    };
    let content = &event["content"];
    if content["botUserId"] != joined_user_id.as_str()
        || content["invitationCancelled"] == true
        || content["subscriptionEventId"].is_string()
        || !content["url"].is_string()
    {
        return;
    }
    // Membership can change while the room is in the sidebar. Keep setup off the sync loop.
    tokio::spawn(async move {
        let _guard = RSS_WRITE_LOCK.lock().await;
        let result = async {
            let ac = get_authed_client(&state).await?;
            if ac.client.user_id() != Some(room.own_user_id()) {
                return Ok(());
            }
            resume_initial_subscription(&state.http_client, &ac, room.room_id()).await
        }
        .await;
        if let Err(error) = result {
            log::warn!(
                "Could not finish initial RSS setup for {}: {error}",
                room.room_id()
            );
        }
    });
}

async fn resume_initial_subscription(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
) -> Result<(), String> {
    let (_, status) = read_feed_status(http, ac, room_id).await?;
    if status.auto_setup && status.initial_subscription_pending && status.membership == "join" {
        let room = ac.client.get_room(room_id).ok_or("Room not found")?;
        send_subscription(http, ac, &room, &status.settings).await?;
    }
    Ok(())
}

async fn send_subscription(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room: &matrix_sdk::Room,
    settings: &RssFeedSettings,
) -> Result<(), String> {
    let Some(initial_feed_url) = settings.initial_feed_url.clone() else {
        return Ok(());
    };
    let feed = RssFeedConfig {
        initial_feed_url,
        provider: settings.provider.clone(),
    };
    // The SDK handles encryption if the room's settings have changed since creation.
    let sent = room
        .send(RoomMessageEventContent::text_plain(format!(
            "!rss subscribe {}",
            feed.initial_feed_url
        )))
        .with_transaction_id(
            feed.transaction_id(room.room_id().as_str(), settings.revision.as_deref())
                .into(),
        )
        .await
        .map_err(|e| format!("Could not send the feed subscription: {e}"))?;
    // A different device may have changed the provider while this request was in flight.
    let (mut content, current, _) =
        read_feed_settings(http, ac, room.room_id())
            .await
            .map_err(|e| {
                format!("The subscription was sent, but its status could not be saved: {e}")
            })?;
    current.check_revision(settings.revision.as_deref())?;
    content["subscriptionEventId"] = json!(sent.event_id);
    content["subscriptionBotUserId"] = json!(settings.provider.bot_user_id);
    room.send_state_event_raw(RSS_FEED_EVENT, "", content)
        .await
        .map_err(|e| {
            format!("The subscription was sent, but its status could not be saved: {e}")
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client, RssTestRoom, Server, TestDir, USER},
    };

    const JOINED_PROVIDER: &str = "@bot:nope.chat";

    fn feed(url: &str) -> RssFeedConfig {
        RssFeedConfig {
            initial_feed_url: url.into(),
            provider: RssRoomProvider {
                bot_user_id: "@rss:t2bot.io".into(),
            },
        }
    }

    async fn feed_room() -> (Server, TestDir, AuthedClient) {
        let server = Server::start().await;
        let dir = TestDir::new();
        let old_feed = feed("https://example.org/old-feed");
        server.state.lock().unwrap().rss_room = Some(RssTestRoom {
            settings: old_feed.state_content(),
            memberships: [
                (old_feed.provider.bot_user_id, "invite".into()),
                (JOINED_PROVIDER.into(), "join".into()),
            ]
            .into(),
            reject_invites: false,
        });
        let ac = AuthedClient {
            client: client(
                &server.home,
                &dir.0,
                SavedSession {
                    user_id: USER.into(),
                    device_id: "RSS_TEST".into(),
                    access_token: "test-token".into(),
                },
            )
            .await,
            homeserver: server.home.clone(),
            access_token: "test-token".into(),
        };
        (server, dir, ac)
    }

    #[tokio::test]
    async fn cancels_pending_invitation_and_resumes_with_joined_provider_without_reinviting() {
        let (server, _dir, ac) = feed_room().await;
        let http = reqwest::Client::new();
        let room_id = RoomId::parse("!test:example.org").unwrap();
        cancel_feed_invitation(&http, &ac, &room_id, None)
            .await
            .unwrap();
        let (_, paused) = read_feed_status(&http, &ac, &room_id).await.unwrap();
        assert!(paused.settings.invitation_cancelled);
        assert!(!paused.auto_setup);

        let provider = RssRoomProvider {
            bot_user_id: JOINED_PROVIDER.into(),
        };
        let result = apply_bot_settings(
            &http,
            &ac,
            &room_id,
            provider,
            paused.settings.revision.as_deref(),
        )
        .await
        .unwrap();
        assert!(result.setup_error.is_none(), "{:?}", result.setup_error);
        let (_, active) = read_feed_status(&http, &ac, &room_id).await.unwrap();
        assert!(!active.settings.invitation_cancelled);
        assert_eq!(active.membership, "join");
        assert_eq!(
            active.subscription_event_id.as_deref(),
            Some("$rss-subscribe")
        );
        assert!(
            cancel_feed_invitation(&http, &ac, &room_id, active.settings.revision.as_deref())
                .await
                .is_err()
        );
        let state = server.state.lock().unwrap();
        let memberships = &state.rss_room.as_ref().unwrap().memberships;
        assert_eq!(memberships["@rss:t2bot.io"], "leave");
        assert_eq!(memberships[JOINED_PROVIDER], "join");
        assert!(!state
            .requests
            .iter()
            .any(|(_, path, _)| path.ends_with("/invite")));
        let sent = state
            .requests
            .iter()
            .find(|(_, path, _)| path.contains("/send/m.room.message/"))
            .unwrap();
        assert_eq!(
            sent.2["body"],
            "!rss subscribe https://example.org/old-feed"
        );
    }

    #[tokio::test]
    async fn persists_provider_change_when_the_new_invitation_fails() {
        let (server, _dir, ac) = feed_room().await;
        server
            .state
            .lock()
            .unwrap()
            .rss_room
            .as_mut()
            .unwrap()
            .reject_invites = true;
        let http = reqwest::Client::new();
        let room_id = RoomId::parse("!test:example.org").unwrap();
        let provider = RssRoomProvider {
            bot_user_id: "@new:example.org".into(),
        };
        let result = apply_bot_settings(&http, &ac, &room_id, provider.clone(), None)
            .await
            .unwrap();
        assert!(result
            .setup_error
            .as_deref()
            .unwrap()
            .contains("Invite refused"));
        assert_eq!(result.settings.provider, provider);
        assert!(cancel_feed_invitation(&http, &ac, &room_id, None)
            .await
            .is_err());
        let (_, active) = read_feed_status(&http, &ac, &room_id).await.unwrap();
        assert_eq!(active.settings.provider, provider);
        assert_eq!(active.membership, "none");
        let state = server.state.lock().unwrap();
        assert_eq!(
            state.rss_room.as_ref().unwrap().memberships["@rss:t2bot.io"],
            "leave"
        );
        assert!(state
            .requests
            .iter()
            .any(|(_, path, body)| path.ends_with("/invite")
                && body["user_id"] == "@new:example.org"));
        assert!(!state
            .requests
            .iter()
            .any(|(_, path, _)| path.contains("/send/m.room.message/")));
    }

    #[tokio::test]
    async fn setup_after_bot_join_uses_the_saved_url_only_once_even_if_the_bot_changes() {
        let (server, _dir, ac) = feed_room().await;
        let http = reqwest::Client::new();
        let room_id = RoomId::parse("!test:example.org").unwrap();
        {
            let mut state = server.state.lock().unwrap();
            state.rss_room.as_mut().unwrap().settings["createdBy"] = json!(USER);
        }
        resume_initial_subscription(&http, &ac, &room_id)
            .await
            .unwrap();
        assert!(
            read_feed_status(&http, &ac, &room_id)
                .await
                .unwrap()
                .1
                .initial_subscription_pending
        );
        {
            let mut state = server.state.lock().unwrap();
            state
                .rss_room
                .as_mut()
                .unwrap()
                .memberships
                .insert("@rss:t2bot.io".into(), "join".into());
        }
        resume_initial_subscription(&http, &ac, &room_id)
            .await
            .unwrap();
        resume_initial_subscription(&http, &ac, &room_id)
            .await
            .unwrap();
        apply_bot_settings(
            &http,
            &ac,
            &room_id,
            RssRoomProvider {
                bot_user_id: JOINED_PROVIDER.into(),
            },
            None,
        )
        .await
        .unwrap();
        let (content, status) = read_feed_status(&http, &ac, &room_id).await.unwrap();
        assert_eq!(content["url"], "https://example.org/old-feed");
        assert_eq!(content["subscriptionEventId"], "$rss-subscribe");
        assert!(!status.initial_subscription_pending);
        assert_eq!(status.subscription_event_id, None);
        assert!(serde_json::to_value(status).unwrap().get("url").is_none());
        let state = server.state.lock().unwrap();
        let sent: Vec<_> = state
            .requests
            .iter()
            .filter(|(_, path, _)| path.contains("/send/m.room.message/"))
            .map(|(_, _, content)| content["body"].as_str().unwrap())
            .collect();
        assert_eq!(sent, ["!rss subscribe https://example.org/old-feed"]);
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
        config.provider.bot_user_id = "rss:t2bot.io".into();
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
        local.provider.bot_user_id = "@rss:example.org".into();
        add_feed_to_creation(&mut body, Some(&local), false, &own).unwrap();
    }

    #[test]
    fn subscription_retry_reuses_transaction_only_for_the_same_room_and_feed() {
        let config = feed("https://example.org/feed");
        assert_eq!(
            config.transaction_id("!a:example.org", None),
            config.transaction_id("!a:example.org", None)
        );
        assert_ne!(
            config.transaction_id("!a:example.org", None),
            config.transaction_id("!b:example.org", None)
        );
        assert_ne!(
            config.transaction_id("!a:example.org", None),
            feed("https://example.org/other").transaction_id("!a:example.org", None)
        );
        assert_ne!(
            config.transaction_id("!a:example.org", Some("first-edit")),
            config.transaction_id("!a:example.org", Some("second-edit"))
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

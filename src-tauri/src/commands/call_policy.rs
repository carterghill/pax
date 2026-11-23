//! Private incoming-call preferences and room-wide authority to initiate calls.
use std::{collections::HashMap, sync::Arc};

use matrix_sdk::{
    ruma::{
        events::room::{join_rules::JoinRule, power_levels::RoomPowerLevels},
        UserId,
    },
    Room,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{group_calls::RING, matrix_voip::callable_room};
use crate::AppState;

const INVITE: &str = "m.call.invite";
pub(super) const RTC_MEMBER: &str = "org.matrix.msc3401.call.member";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallMode {
    #[default]
    Ring,
    Silent,
    Block,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct CallPreferences {
    pub global: CallMode,
    pub rooms: HashMap<String, CallMode>,
    pub users: HashMap<String, CallMode>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

impl CallPreferences {
    fn resolve(&self, room: &str, sender: &str, quiet_by_default: bool) -> CallMode {
        let room_mode = self.rooms.get(room).copied();
        let caller_mode = self.users.get(sender).copied();
        let scoped = match (room_mode, caller_mode) {
            (Some(room), Some(caller)) => room.max(caller),
            (Some(mode), None) | (None, Some(mode)) => mode,
            (None, None) if quiet_by_default => CallMode::Silent,
            (None, None) => CallMode::Ring,
        };
        self.global.max(scoped)
    }
}

#[derive(Default, Serialize)]
pub(crate) struct Permissions {
    pub member: bool,
    pub join: bool,
    pub group: bool,
}

fn permissions(levels: &RoomPowerLevels, user: &UserId, encrypted: bool) -> Permissions {
    let send = |ty: &str| levels.user_can_send_message(user, ty.into());
    let can_send = !encrypted || send("m.room.encrypted");
    let join = levels.user_can_send_state(user, RTC_MEMBER.into());
    let stable_ring = "m.rtc.notification";
    let group =
        send(RING) && (!levels.events.contains_key(&stable_ring.into()) || send(stable_ring));
    Permissions {
        join,
        member: can_send && send(INVITE),
        group: can_send && group && join,
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CallKind {
    Member,
    LiveKit,
    Group,
}

impl CallKind {
    fn allowed(self, levels: &RoomPowerLevels, room: &Room, user: &UserId) -> bool {
        let permissions = permissions(levels, user, room.encryption_state().is_encrypted());
        match self {
            Self::Member => permissions.member,
            Self::Group => permissions.group,
            Self::LiveKit => {
                permissions.member
                    && permissions.join
                    && levels.user_can_send_message(user, super::direct_calls::CALL_EVENT.into())
            }
        }
    }

    pub(super) fn can_answer(self, levels: &RoomPowerLevels, room: &Room, user: &UserId) -> bool {
        (match self {
            Self::Member => levels.user_can_send_message(user, "m.call.answer".into()),
            Self::Group => levels.user_can_send_state(user, RTC_MEMBER.into()),
            Self::LiveKit => {
                levels.user_can_send_state(user, RTC_MEMBER.into())
                    && levels.user_can_send_message(user, super::direct_calls::CALL_EVENT.into())
            }
        }) && (!room.encryption_state().is_encrypted()
            || levels.user_can_send_message(user, "m.room.encrypted".into()))
    }
}

pub(super) async fn require_start(
    room: &Room,
    kind: CallKind,
    peer: Option<&UserId>,
) -> Result<(), String> {
    let levels = room.power_levels().await.map_err(|e| e.to_string())?;
    if let Some(peer) = peer {
        if !super::matrix_voip::joined_peer(room, peer).await
            || room.client().is_user_ignored(peer).await
            || !kind.can_answer(&levels, room, peer)
        {
            return Err("This member is unavailable for a call in this room.".into());
        }
    }
    if callable_room(room) && kind.allowed(&levels, room, room.own_user_id()) {
        Ok(())
    } else {
        Err("Your role cannot start this call in this room.".into())
    }
}

#[tauri::command]
pub(crate) async fn get_room_call_permissions(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    peer_user_id: Option<matrix_sdk::ruma::OwnedUserId>,
    check_group: Option<bool>,
) -> Result<Permissions, String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    if !callable_room(&room) {
        return Ok(Permissions::default());
    }
    let levels = room.power_levels().await.map_err(|e| e.to_string())?;
    let mut allowed = permissions(
        &levels,
        room.own_user_id(),
        room.encryption_state().is_encrypted(),
    );
    if let Some(peer) = peer_user_id {
        allowed.member = allowed.member
            && super::matrix_voip::joined_peer(&room, &peer).await
            && !state.ignored_users.users(&client).await.contains(&peer)
            && CallKind::Member.can_answer(&levels, &room, &peer);
    }
    if check_group == Some(true) && allowed.group {
        allowed.group = room.is_direct().await.map_err(|e| e.to_string())?
            && !super::group_calls::invitees(&state, &room, &levels)
                .await?
                .is_empty();
    }
    Ok(allowed)
}

#[tauri::command]
pub(crate) async fn get_incoming_call_mode(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    peer_user_id: matrix_sdk::ruma::OwnedUserId,
    kind: CallKind,
) -> Result<CallMode, String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;
    if state
        .ignored_users
        .users(&client)
        .await
        .contains(&peer_user_id)
    {
        return Ok(CallMode::Block);
    }
    Ok(incoming_mode(&state, &room, &peer_user_id, kind).await)
}

pub(super) async fn incoming_mode(
    state: &AppState,
    room: &Room,
    sender: &UserId,
    kind: CallKind,
) -> CallMode {
    if !super::matrix_voip::joined_peer(room, sender).await {
        return CallMode::Block;
    }
    let Ok(levels) = room.power_levels().await else {
        return CallMode::Block;
    };
    if !kind.allowed(&levels, room, sender) || !kind.can_answer(&levels, room, room.own_user_id()) {
        return CallMode::Block;
    }
    let Ok(settings) = super::pax_settings::load_notification_settings_inner(state).await else {
        return CallMode::Block;
    };
    let quiet = matches!(room.join_rule(), None | Some(JoinRule::Public));
    settings
        .calls
        .resolve(room.room_id().as_str(), sender.as_str(), quiet)
}

// PushKit and FCM may wake a device long after its last sync. Android can
// authenticate the current room state before asking the OS to ring.
#[cfg(any(target_os = "android", test))]
pub(crate) async fn pushed_call_can_ring(room: &Room, sender: &UserId, kind: CallKind) -> bool {
    use super::pax_settings::{NotificationSettings, NOTIFICATION_SETTINGS_TYPE};
    use matrix_sdk::ruma::{
        api::client::state::get_state_event_for_key::v3::Request,
        events::{room::power_levels::RoomPowerLevelsEventContent, StateEventType},
    };
    async fn state(room: &Room, ty: StateEventType, key: &str) -> Option<serde_json::Value> {
        let request = Request::new(room.room_id().to_owned(), ty, key.to_owned());
        let raw = room.client().send(request).await.ok()?.event_or_content;
        serde_json::from_str(raw.get()).ok()
    }
    let account = room.client().account();
    let me = room.own_user_id();
    let (prefs, own, peer, rule, power) = tokio::join!(
        account.fetch_account_data(NOTIFICATION_SETTINGS_TYPE.into()),
        state(room, StateEventType::RoomMember, me.as_str()),
        state(room, StateEventType::RoomMember, sender.as_str()),
        state(room, StateEventType::RoomJoinRules, ""),
        state(room, StateEventType::RoomPowerLevels, ""),
    );
    let joined =
        |content: Option<serde_json::Value>| content.is_some_and(|c| c["membership"] == "join");
    if !joined(own) || !joined(peer) {
        return false;
    }
    let settings: NotificationSettings = match prefs {
        Ok(None) => NotificationSettings::default(),
        Ok(Some(raw)) => match serde_json::from_str(raw.json().get()) {
            Ok(s) => s,
            Err(_) => return false,
        },
        Err(_) => return false,
    };
    let Some(power) =
        power.and_then(|p| serde_json::from_value::<RoomPowerLevelsEventContent>(p).ok())
    else {
        return false;
    };
    let Some(creators) = room.creators() else {
        return false;
    };
    let levels = RoomPowerLevels::new(
        power.into(),
        &room
            .clone_info()
            .room_version_rules_or_default()
            .authorization,
        creators,
    );
    let quiet = rule
        .as_ref()
        .and_then(|r| r["join_rule"].as_str())
        .is_none_or(|r| r == "public");
    kind.allowed(&levels, room, sender)
        && kind.can_answer(&levels, room, room.own_user_id())
        && settings
            .calls
            .resolve(room.room_id().as_str(), sender.as_str(), quiet)
            == CallMode::Ring
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_permissions_distinguish_starting_ringing_and_joining() {
        use matrix_sdk::ruma::{
            events::room::power_levels::RoomPowerLevelsEventContent,
            room_version_rules::AuthorizationRules, user_id,
        };
        let alice = user_id!("@alice:example.org");
        let moderator = user_id!("@moderator:example.org");
        let content: RoomPowerLevelsEventContent = serde_json::from_value(serde_json::json!({
            "users": {moderator: 50}, "events": {INVITE: 50, RING: 0, RTC_MEMBER: 0, "m.room.encrypted": 50},
        })).unwrap();
        let mut levels = RoomPowerLevels::new(content.into(), &AuthorizationRules::V1, []);
        let regular = permissions(&levels, alice, false);
        assert!(regular.join && regular.group && !regular.member);
        assert!(permissions(&levels, moderator, true).member);
        assert!(!permissions(&levels, alice, true).group);
        levels.events.insert(RING.into(), 50.into());
        assert!(!permissions(&levels, alice, false).group);
        assert!(permissions(&levels, alice, false).join);
        levels
            .events
            .remove(&matrix_sdk::ruma::events::TimelineEventType::from(RING));
        levels.events.insert("m.rtc.notification".into(), 50.into());
        assert!(!permissions(&levels, alice, false).group);
    }

    #[tokio::test]
    async fn background_calls_check_live_membership_power_levels_and_private_preferences() {
        use super::super::{
            matrix_voip::tests::shared_room, pax_auth::tests::USER,
            pax_settings::NOTIFICATION_SETTINGS_TYPE,
        };
        use serde_json::json;
        let (_dir, server, room) = shared_room().await;
        let bob = UserId::parse("@bob:example.org").unwrap();
        let private =
            format!("/_matrix/client/v3/user/{USER}/account_data/{NOTIFICATION_SETTINGS_TYPE}");
        let route = |path: String, body| {
            server
                .state
                .lock()
                .unwrap()
                .route_overrides
                .insert(("GET".into(), path), (200, body));
        };
        let state = |ty: &str, key: &str, body| {
            route(
                format!(
                    "/_matrix/client/v3/rooms/{}/state/{ty}/{key}",
                    room.room_id()
                ),
                body,
            );
        };
        state("m.room.member", USER, json!({"membership":"join"}));
        state("m.room.member", bob.as_str(), json!({"membership":"join"}));
        state("m.room.join_rules", "", json!({"join_rule":"public"}));
        state("m.room.power_levels", "", json!({"events":{RTC_MEMBER:0}}));
        route(private.clone(), json!({}));
        assert!(!pushed_call_can_ring(&room, &bob, CallKind::Member).await);
        let ring = json!({"calls":{"rooms":{room.room_id().as_str():"ring"}}});
        route(private.clone(), ring.clone());
        assert!(pushed_call_can_ring(&room, &bob, CallKind::Member).await);
        assert!(pushed_call_can_ring(&room, &bob, CallKind::Group).await);
        route(
            private.clone(),
            json!({"calls":{"rooms":{room.room_id().as_str():"ring"}, "users":{bob.as_str():"block"}}}),
        );
        assert!(!pushed_call_can_ring(&room, &bob, CallKind::Member).await);
        route(private, ring);
        state("m.room.member", USER, json!({"membership":"invite"}));
        assert!(!pushed_call_can_ring(&room, &bob, CallKind::Member).await);
        state("m.room.member", USER, json!({"membership":"join"}));
        state(
            "m.room.power_levels",
            "",
            json!({"events":{INVITE:50, RTC_MEMBER:0}}),
        );
        assert!(!pushed_call_can_ring(&room, &bob, CallKind::LiveKit).await);
        assert!(!pushed_call_can_ring(&room, &bob, CallKind::Member).await);
        assert!(pushed_call_can_ring(&room, &bob, CallKind::Group).await);
    }

    #[test]
    fn public_rooms_are_quiet_and_restrictions_apply_across_scopes() {
        let mut prefs = CallPreferences::default();
        assert_eq!(prefs.resolve("room", "alice", false), CallMode::Ring);
        assert_eq!(prefs.resolve("room", "alice", true), CallMode::Silent);
        prefs.users.insert("bob".into(), CallMode::Ring);
        assert_eq!(prefs.resolve("room", "bob", true), CallMode::Ring);
        prefs.rooms.insert("room".into(), CallMode::Silent);
        assert_eq!(prefs.resolve("room", "bob", true), CallMode::Silent);
        prefs.rooms.insert("room".into(), CallMode::Ring);
        assert_eq!(prefs.resolve("room", "alice", true), CallMode::Ring);
        prefs.users.insert("alice".into(), CallMode::Block);
        assert_eq!(prefs.resolve("room", "alice", false), CallMode::Block);
        prefs.global = CallMode::Silent;
        assert_eq!(prefs.resolve("room", "bob", false), CallMode::Silent);
        prefs.global = CallMode::Block;
        assert_eq!(prefs.resolve("room", "bob", true), CallMode::Block);
    }
}

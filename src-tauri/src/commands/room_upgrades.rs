use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use futures_util::{stream, StreamExt};
use matrix_sdk::{
    deserialized_responses::RawAnySyncOrStrippedState,
    ruma::{
        api::client::{discovery::get_capabilities::v3::RoomVersionStability, room::upgrade_room},
        events::StateEventType,
        OwnedRoomId, OwnedServerName, RoomId, RoomVersionId, UserId,
    },
    Client, Room, RoomState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

use super::{fmt_error_chain, get_authed_client, get_client, resolve_room, AuthedClient};

const CHAIN_LIMIT: usize = 24;
const RETRY_INTERVAL: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
pub(super) const SPACE_PREDECESSOR: &str = "ca.brandxtech.pax.predecessor";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeOptions {
    current_version: Option<RoomVersionId>,
    target_version: Option<RoomVersionId>,
    invite_only: bool,
    additional_creators: Vec<String>,
    spaces: Vec<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpgradeAccess {
    AllowOldMembers,
    InviteOldMembers,
    Keep,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    replacement_room_id: OwnedRoomId,
    warnings: Vec<String>,
}

async fn stored_state(room: &Room, event: StateEventType, key: &str) -> Option<Value> {
    match room.get_state_event(event, key).await.ok()?? {
        RawAnySyncOrStrippedState::Sync(raw) => raw.deserialize_as().ok(),
        RawAnySyncOrStrippedState::Stripped(raw) => raw.deserialize_as().ok(),
    }
}

async fn remote_state(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &RoomId,
    event_type: &str,
) -> Result<Option<Value>, String> {
    let response = http
        .get(format!(
            "{}/_matrix/client/v3/rooms/{}/state/{}/",
            ac.homeserver,
            urlencoding::encode(room_id.as_str()),
            urlencoding::encode(event_type),
        ))
        .query(&[("format", "event")])
        .bearer_auth(&ac.access_token)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| fmt_error_chain(&e))?;
    match response.status() {
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::FORBIDDEN => Ok(None),
        status if status.is_success() => response.json().await.map_err(|e| fmt_error_chain(&e)),
        status => Err(format!("Room state request failed ({status})")),
    }
}

fn content(event: &Value) -> &Value {
    event.get("content").unwrap_or(event)
}

fn pointer(event: &Value, field: &str) -> Option<OwnedRoomId> {
    let value = content(event);
    let id = match field {
        "predecessor" => value[field]["room_id"].as_str()?,
        _ => value[field].as_str()?,
    };
    RoomId::parse(id).ok()
}

fn routes(event: &Value, room_id: &RoomId, user: Option<&UserId>) -> Vec<OwnedServerName> {
    let sender = event["sender"]
        .as_str()
        .and_then(|id| UserId::parse(id).ok());
    let mut via = Vec::new();
    for name in [
        sender.as_deref().map(UserId::server_name),
        room_id.server_name(),
        user.map(UserId::server_name),
    ]
    .into_iter()
    .flatten()
    {
        if !via
            .iter()
            .any(|existing: &OwnedServerName| existing.as_str() == name.as_str())
        {
            via.push(name.to_owned());
        }
    }
    via
}

fn matching_upgrade(old: &RoomId, new: &RoomId, tombstone: &Value, create: &Value) -> bool {
    let claimed_event = content(create)["predecessor"]["event_id"].as_str();
    let actual_event = tombstone["event_id"].as_str();
    old != new
        && content(create)["type"] != "m.space"
        && pointer(tombstone, "replacement_room").as_deref() == Some(new)
        && pointer(create, "predecessor").as_deref() == Some(old)
        && claimed_event
            .zip(actual_event)
            .is_none_or(|(claimed, actual)| claimed == actual)
}

fn room_state_types(forward: bool) -> (StateEventType, &'static str) {
    if forward {
        (StateEventType::RoomTombstone, "replacement_room")
    } else {
        (StateEventType::RoomCreate, "predecessor")
    }
}

/// Follow an upgrade from a known room. Read the reverse pointer before joining
/// where it is visible. On private servers it may only be readable after joining.
async fn follow_edge(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room: &Room,
    forward: bool,
    seen: &HashSet<OwnedRoomId>,
    read_missing_source: bool,
    changed: &mut bool,
) -> Option<Room> {
    let (state_type, field) = room_state_types(forward);
    let source = match stored_state(room, state_type.clone(), "").await {
        Some(event) => event,
        None if read_missing_source => {
            remote_state(http, ac, room.room_id(), state_type.to_string().as_str())
                .await
                .ok()
                .flatten()?
        }
        None => return None,
    };
    let target_id = pointer(&source, field)?;
    if seen.contains(&target_id) {
        return None;
    }
    let known = ac.client.get_room(&target_id);
    if known.as_ref().is_some_and(|target| {
        target.is_space()
            || matches!(
                target.state(),
                RoomState::Left | RoomState::Banned | RoomState::Knocked
            )
    }) {
        return None;
    }

    let (opposite, _) = room_state_types(!forward);
    let matches = |event: &Value| {
        if forward {
            matching_upgrade(room.room_id(), &target_id, &source, event)
        } else {
            matching_upgrade(&target_id, room.room_id(), event, &source)
        }
    };
    let stored = match &known {
        Some(room) => stored_state(room, opposite.clone(), "").await,
        None => None,
    };
    let remote = match stored {
        Some(event) => Some(event),
        None => remote_state(http, ac, &target_id, opposite.to_string().as_str())
            .await
            .ok()?,
    };
    if remote.as_ref().is_some_and(|event| !matches(event)) {
        return None;
    }
    if let Some(target) = known.filter(|target| target.state() == RoomState::Joined) {
        return remote.filter(matches).map(|_| target);
    }

    let via = routes(&source, &target_id, ac.client.user_id());
    let joined = tokio::time::timeout(
        REQUEST_TIMEOUT,
        ac.client
            .join_room_by_id_or_alias(target_id.as_str().try_into().ok()?, &via),
    )
    .await
    .ok()?
    .ok()?;
    let opposite_event = if let Some(event) = remote {
        Ok(Some(event))
    } else {
        remote_state(http, ac, &target_id, opposite.to_string().as_str()).await
    };
    match opposite_event {
        Ok(Some(event)) if !joined.is_space() && matches(&event) => {
            *changed = true;
            Some(joined)
        }
        Ok(_) => {
            // The SDK's Room::leave also leaves predecessors. Only undo the
            // membership this request created.
            let _ = super::room_membership::leave_single_room(http, ac, joined.room_id().as_str())
                .await;
            None
        }
        Err(_) => {
            // A sync can still provide the other half after a failed state read.
            *changed = true;
            None
        }
    }
}

pub(super) async fn follow_room_upgrades(
    http: &reqwest::Client,
    ac: &AuthedClient,
    origin: Room,
    read_missing_source: bool,
) -> (Room, bool) {
    if origin.is_space() {
        return (origin, false);
    }
    let mut changed = false;
    let mut latest = origin;
    let mut seen = HashSet::from([latest.room_id().to_owned()]);
    for _ in 0..CHAIN_LIMIT {
        let Some(successor) = follow_edge(
            http,
            ac,
            &latest,
            true,
            &seen,
            read_missing_source,
            &mut changed,
        )
        .await
        else {
            break;
        };
        seen.insert(successor.room_id().to_owned());
        latest = successor;
    }

    let mut historical = latest.clone();
    let mut seen = HashSet::from([latest.room_id().to_owned()]);
    for _ in 0..CHAIN_LIMIT {
        let Some(predecessor) = follow_edge(
            http,
            ac,
            &historical,
            false,
            &seen,
            read_missing_source,
            &mut changed,
        )
        .await
        else {
            break;
        };
        seen.insert(predecessor.room_id().to_owned());
        historical = predecessor;
    }
    (latest, changed)
}

#[derive(Default)]
pub(super) struct UpgradeAttempts(HashMap<OwnedRoomId, (Instant, bool)>);

impl UpgradeAttempts {
    pub(super) async fn reconcile(&mut self, http: &reqwest::Client, client: &Client) -> bool {
        let Some(access_token) = client.access_token() else {
            return false;
        };
        let ac = AuthedClient {
            client: client.clone(),
            homeserver: client
                .homeserver()
                .as_str()
                .trim_end_matches('/')
                .to_owned(),
            access_token: access_token.to_string(),
        };
        let now = Instant::now();
        let needs_join = |id: &RoomId| {
            client
                .get_room(id)
                .is_none_or(|room| room.state() == RoomState::Invited)
        };
        let rooms = client.joined_rooms().into_iter().filter(|room| {
            !room.is_space()
                && (room
                    .successor_room()
                    .is_some_and(|successor| needs_join(&successor.room_id))
                    || room
                        .predecessor_room()
                        .is_some_and(|previous| needs_join(&previous.room_id)))
        });
        let candidates: Vec<_> = rooms
            .filter(|room| {
                let id = room.room_id();
                let invited = room.successor_room().is_some_and(|next| {
                    client
                        .get_room(&next.room_id)
                        .is_some_and(|r| r.state() == RoomState::Invited)
                }) || room.predecessor_room().is_some_and(|old| {
                    client
                        .get_room(&old.room_id)
                        .is_some_and(|r| r.state() == RoomState::Invited)
                });
                if self.0.get(id).is_none_or(|(last, was_invited)| {
                    (invited && !was_invited) || now.duration_since(*last) >= RETRY_INTERVAL
                }) {
                    self.0.insert(id.to_owned(), (now, invited));
                    true
                } else {
                    false
                }
            })
            .collect();
        let mut changed = false;
        // Process serially. Joining one link can satisfy several candidates.
        for room in candidates {
            changed |= follow_room_upgrades(http, &ac, room, false).await.1;
        }
        changed
    }
}

/// Verified links in the sync store, newest to oldest. Rooms keep their own IDs
/// and history permissions even when Pax presents them as one conversation.
pub(super) async fn joined_upgrade_links(
    client: &Client,
) -> (HashMap<String, String>, HashMap<String, Vec<String>>) {
    let pairs = stream::iter(client.joined_rooms())
        .filter_map(|room| async move {
            if room.is_space() {
                return None;
            }
            let next = room.successor_room()?;
            let successor = client.get_room(&next.room_id)?;
            if successor.is_space()
                || successor.state() != RoomState::Joined
                || successor.predecessor_room()?.room_id != room.room_id()
            {
                return None;
            }
            let old = stored_state(&room, StateEventType::RoomTombstone, "").await?;
            let new = stored_state(&successor, StateEventType::RoomCreate, "").await?;
            matching_upgrade(room.room_id(), successor.room_id(), &old, &new)
                .then(|| (room.room_id().to_string(), successor.room_id().to_string()))
        })
        .collect::<Vec<_>>()
        .await;
    let successors: HashMap<_, _> = pairs.into_iter().collect();
    let predecessors: HashMap<_, _> = successors.iter().map(|(old, next)| (next, old)).collect();
    let mut replacements = HashMap::new();
    let mut histories = HashMap::new();
    for latest in predecessors
        .keys()
        .copied()
        .filter(|id| !successors.contains_key(*id))
    {
        let mut history = Vec::new();
        let mut current = latest;
        for _ in 0..CHAIN_LIMIT {
            let Some(old) = predecessors.get(current).copied() else {
                break;
            };
            history.push(old.clone());
            replacements.insert(old.clone(), latest.clone());
            current = old;
        }
        histories.insert(latest.clone(), history);
    }
    (replacements, histories)
}

async fn manageable_parents(room: &Room) -> Vec<(Room, Value)> {
    let client = room.client();
    let Some(user) = client.user_id() else {
        return vec![];
    };
    stream::iter(client.joined_space_rooms())
        .map(|space| async move {
            let event =
                stored_state(&space, StateEventType::SpaceChild, room.room_id().as_str()).await?;
            let child = content(&event);
            if !child["via"].as_array().is_some_and(|via| !via.is_empty())
                || !space
                    .power_levels()
                    .await
                    .ok()?
                    .user_can_send_state(user, StateEventType::SpaceChild)
            {
                return None;
            }
            Some((space, child.clone()))
        })
        .buffer_unordered(12)
        .filter_map(|entry| async move { entry })
        .collect()
        .await
}

async fn target_version(
    client: &Client,
    current: Option<RoomVersionId>,
) -> Result<Option<RoomVersionId>, String> {
    let caps = client
        .get_capabilities()
        .await
        .map_err(|e| fmt_error_chain(&e))?;
    let current = current
        .as_ref()
        .and_then(|version| version.as_str().parse::<u32>().ok());
    // Official numeric versions are the choices Pax offers for upgrades.
    Ok(caps
        .room_versions
        .available
        .into_iter()
        .filter_map(|(version, stability)| {
            let number = version.as_str().parse::<u32>().ok()?;
            (stability == RoomVersionStability::Stable && current.is_none_or(|old| number > old))
                .then_some((number, version))
        })
        .max_by_key(|(number, _)| *number)
        .map(|(_, version)| version))
}

#[tauri::command]
pub async fn get_room_upgrade_options(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Option<UpgradeOptions>, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let user = client.user_id().ok_or("Not logged in")?;
    if room.is_space()
        || room.is_tombstoned()
        || room.state() != RoomState::Joined
        || !room
            .power_levels()
            .await
            .map_err(|e| fmt_error_chain(&e))?
            .user_can_send_state(user, StateEventType::RoomTombstone)
    {
        return Ok(None);
    }
    let current_version = room.version();
    let (target_version, parents) = tokio::join!(
        target_version(&client, current_version.clone()),
        manageable_parents(&room)
    );
    let mut spaces: Vec<_> = parents
        .into_iter()
        .map(|(space, _)| space.name().unwrap_or_else(|| space.room_id().to_string()))
        .collect();
    spaces.sort();
    Ok(Some(UpgradeOptions {
        current_version,
        target_version: target_version?,
        invite_only: room
            .join_rule()
            .is_none_or(|rule| rule.as_str() == "invite"),
        additional_creators: room
            .version()
            .filter(|version| {
                version
                    .as_str()
                    .parse::<u32>()
                    .is_ok_and(|number| number >= 12)
            })
            .and_then(|_| room.creators())
            .unwrap_or_default()
            .into_iter()
            .filter(|id| id.as_str() != user.as_str())
            .map(|id| id.to_string())
            .collect(),
        spaces,
    }))
}

#[tauri::command]
pub async fn upgrade_room(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    room_id: String,
    version: RoomVersionId,
    access: UpgradeAccess,
) -> Result<UpgradeResult, String> {
    let _guard = state.room_upgrade_operation.lock().await;
    let ac = get_authed_client(&state).await?;
    let result = perform_upgrade(&state.http_client, &ac, &room_id, version, access).await?;
    let _ = app.emit("rooms-changed", ());
    Ok(result)
}

async fn perform_upgrade(
    http: &reqwest::Client,
    ac: &AuthedClient,
    room_id: &str,
    version: RoomVersionId,
    access: UpgradeAccess,
) -> Result<UpgradeResult, String> {
    let old = resolve_room(&ac.client, room_id)?;
    let user = ac.client.user_id().ok_or("Not logged in")?;
    if old.is_space() || old.state() != RoomState::Joined {
        return Err("Only joined chat rooms can be upgraded.".into());
    }
    if !old
        .power_levels()
        .await
        .map_err(|e| fmt_error_chain(&e))?
        .user_can_send_state(user, StateEventType::RoomTombstone)
    {
        return Err("You do not have permission to upgrade this room.".into());
    }

    let (parents, members) = tokio::join!(manageable_parents(&old), async {
        if matches!(access, UpgradeAccess::InviteOldMembers) {
            old.sync_members().await.map_err(|e| fmt_error_chain(&e))?;
            old.joined_user_ids().await.map_err(|e| fmt_error_chain(&e))
        } else {
            Ok(Vec::new())
        }
    });
    let members = members?;
    let old_rule = remote_state(http, ac, old.room_id(), "m.room.join_rules")
        .await?
        .and_then(|event| content(&event)["join_rule"].as_str().map(str::to_owned));
    let existing = remote_state(http, ac, old.room_id(), "m.room.tombstone").await?;
    let replacement_room_id = if let Some(id) = existing
        .as_ref()
        .and_then(|event| pointer(event, "replacement_room"))
    {
        // A previous request may have succeeded before the response arrived.
        let create = remote_state(http, ac, &id, "m.room.create")
            .await?
            .ok_or("This room was already upgraded. Open its replacement to continue.")?;
        if !matching_upgrade(old.room_id(), &id, existing.as_ref().unwrap(), &create)
            || content(&create)["room_version"].as_str() != Some(version.as_str())
        {
            return Err("This room was already upgraded.".into());
        }
        id
    } else {
        let supported = ac
            .client
            .get_capabilities()
            .await
            .map_err(|e| fmt_error_chain(&e))?;
        if old.version().as_ref() == Some(&version)
            || supported.room_versions.available.get(&version)
                != Some(&RoomVersionStability::Stable)
        {
            return Err(
                "Choose a different stable room version supported by this homeserver.".into(),
            );
        }
        let mut request = upgrade_room::v3::Request::new(old.room_id().to_owned(), version.clone());
        if version
            .as_str()
            .parse::<u32>()
            .is_ok_and(|number| number >= 12)
            && old.version().is_some_and(|version| {
                version
                    .as_str()
                    .parse::<u32>()
                    .is_ok_and(|number| number >= 12)
            })
        {
            request.additional_creators = old
                .creators()
                .unwrap_or_default()
                .into_iter()
                .filter(|id| id.as_str() != user.as_str())
                .collect();
        }
        ac.client
            .send(request)
            .await
            .map_err(|e| fmt_error_chain(&e))?
            .replacement_room
    };

    let mut warnings = Vec::new();
    let replacement = match ac
        .client
        .get_room(&replacement_room_id)
        .filter(|room| room.state() == RoomState::Joined)
    {
        Some(room) => Ok(room),
        None => ac.client.join_room_by_id(&replacement_room_id).await,
    };
    match replacement {
        Ok(room) => {
            if matches!(access, UpgradeAccess::AllowOldMembers)
                && old_rule.as_deref().unwrap_or("invite") == "invite"
            {
                if let Err(e) = room
                    .send_state_event_raw(
                        "m.room.join_rules",
                        "",
                        json!({
                            "join_rule": "restricted",
                            "allow": [{"type": "m.room_membership", "room_id": old.room_id()}],
                        }),
                    )
                    .await
                {
                    warnings.push(format!(
                        "Could not allow members of the old room to join: {e}"
                    ));
                }
            }

            if !members.is_empty() {
                let failures = stream::iter(
                    members
                        .into_iter()
                        .filter(|id| id.as_str() != user.as_str()),
                )
                .map(|id| {
                    let room = &room;
                    async move {
                        if room
                            .get_member(&id)
                            .await
                            .ok()
                            .flatten()
                            .is_some_and(|member| {
                                matches!(member.membership().as_str(), "join" | "invite" | "ban")
                            })
                        {
                            return false;
                        }
                        room.invite_user_by_id(&id).await.is_err()
                    }
                })
                .buffer_unordered(4)
                .filter(|failed| std::future::ready(*failed))
                .count()
                .await;
                if failures > 0 {
                    warnings.push(format!("Could not send {failures} invitation(s)."));
                }
            }

            for (space, mut child) in parents {
                let next = replacement_room_id.as_str();
                let already_linked = stored_state(&space, StateEventType::SpaceChild, next)
                    .await
                    .is_some_and(|event| {
                        content(&event)["via"]
                            .as_array()
                            .is_some_and(|via| !via.is_empty())
                    });
                let name = space.name().unwrap_or_else(|| space.room_id().to_string());
                if !already_linked {
                    child[SPACE_PREDECESSOR] = json!(old.room_id());
                    let via = child["via"]
                        .as_array_mut()
                        .expect("space child has a via array");
                    if !via
                        .iter()
                        .any(|value| value.as_str() == Some(user.server_name().as_str()))
                    {
                        via.insert(0, json!(user.server_name()));
                        via.truncate(3);
                    }
                    if let Err(e) = space
                        .send_state_event_raw("m.space.child", next, child)
                        .await
                    {
                        warnings.push(format!("Could not add the replacement to {name}: {e}"));
                        continue;
                    }
                }
                let space_id = space.room_id().as_str();
                if let Some(parent) =
                    stored_state(&old, StateEventType::SpaceParent, space_id).await
                {
                    let parent = content(&parent);
                    if parent["via"].as_array().is_some_and(|via| !via.is_empty()) {
                        if let Err(error) = room
                            .send_state_event_raw("m.space.parent", space_id, parent.clone())
                            .await
                        {
                            warnings.push(format!(
                                "Could not carry over the parent link for {name}: {error}"
                            ));
                        }
                    }
                }
            }
        }
        Err(e) => warnings.push(format!(
            "Could not open the replacement to finish setup: {e}"
        )),
    }
    Ok(UpgradeResult {
        replacement_room_id,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::auth::SavedSession;
    use crate::commands::pax_auth::tests::{client, Server, TestDir, USER};

    const OLD: &str = "!original:example.org";
    const NEW: &str = "!replacement";

    fn room_state(event_type: &str, id: &str, content: Value) -> Value {
        json!({
            "type": event_type,
            "state_key": "",
            "event_id": id,
            "sender": USER,
            "origin_server_ts": 1,
            "content": content,
        })
    }

    fn tombstone() -> Value {
        room_state(
            "m.room.tombstone",
            "$upgrade",
            json!({
                "replacement_room": NEW, "body": "Room upgraded",
            }),
        )
    }

    fn replacement() -> Value {
        room_state(
            "m.room.create",
            "$replacement",
            json!({
                "room_version": "12", "predecessor": {"room_id": OLD},
            }),
        )
    }

    fn joined(state: &[Value]) -> Value {
        let mut events = state.to_vec();
        events.push(json!({
            "type": "m.room.member",
            "state_key": USER,
            "sender": USER,
            "event_id": "$membership",
            "origin_server_ts": 2,
            "content": {"membership": "join"},
        }));
        json!({
            "state": {"events": events},
            "timeline": {"events": [], "limited": false, "prev_batch": "start"},
        })
    }

    #[test]
    fn matching_requires_reciprocal_room_ids_and_checks_a_known_event_id() {
        let old = RoomId::parse(OLD).unwrap();
        let new = RoomId::parse(NEW).unwrap();
        assert!(matching_upgrade(&old, &new, &tombstone(), &replacement()));
        let mut bad = replacement();
        bad["content"]["predecessor"]["event_id"] = json!("$different");
        assert!(!matching_upgrade(&old, &new, &tombstone(), &bad));
        bad["content"]["predecessor"]["event_id"] = json!("$upgrade");
        assert!(matching_upgrade(&old, &new, &tombstone(), &bad));
        bad["content"]["predecessor"]["room_id"] = json!("!unrelated");
        assert!(!matching_upgrade(&old, &new, &tombstone(), &bad));
    }

    #[tokio::test]
    async fn joins_replacement_and_joinable_history_through_the_matrix_api() {
        for from_old in [true, false] {
            let server = Server::start().await;
            let dir = TestDir::new();
            let old_room = joined(&[
                room_state(
                    "m.room.create",
                    "$original",
                    json!({"room_version": "10", "creator": USER}),
                ),
                tombstone(),
            ]);
            let new_room = joined(&[replacement()]);
            let (origin, target) = if from_old { (OLD, NEW) } else { (NEW, OLD) };
            {
                let mut state = server.state.lock().unwrap();
                let routes = &mut state.route_overrides;
                routes.insert(
                    ("GET".into(), "/_matrix/client/v3/sync".into()),
                    (
                        200,
                        json!({"next_batch": "before", "rooms": {"join": {
                            origin: if from_old { old_room.clone() } else { new_room.clone() },
                        }}}),
                    ),
                );
                routes.insert(
                    ("POST".into(), format!("/_matrix/client/v3/join/{target}")),
                    (200, json!({"room_id": target})),
                );
                routes.insert(
                    (
                        "GET".into(),
                        format!("/_matrix/client/v3/rooms/{OLD}/state/m.room.tombstone/"),
                    ),
                    (200, tombstone()),
                );
                routes.insert(
                    (
                        "GET".into(),
                        format!("/_matrix/client/v3/rooms/{NEW}/state/m.room.create/"),
                    ),
                    (200, replacement()),
                );
            }

            let client = client(
                &server.home,
                &dir.0,
                SavedSession {
                    user_id: USER.into(),
                    device_id: "UPGRADE".into(),
                    access_token: "token".into(),
                },
            )
            .await;
            let ac = AuthedClient {
                client: client.clone(),
                homeserver: server.home.clone(),
                access_token: "token".into(),
            };
            let origin = client.get_room(&RoomId::parse(origin).unwrap()).unwrap();
            let (latest, changed) =
                follow_room_upgrades(&reqwest::Client::new(), &ac, origin, false).await;
            assert!(changed);
            assert_eq!(latest.room_id().as_str(), NEW);
            assert_eq!(
                client
                    .get_room(&RoomId::parse(target).unwrap())
                    .unwrap()
                    .state(),
                RoomState::Joined
            );

            server.state.lock().unwrap().route_overrides.insert(
                ("GET".into(), "/_matrix/client/v3/sync".into()),
                (
                    200,
                    json!({"next_batch": "after", "rooms": {"join": {
                        OLD: old_room, NEW: new_room,
                    }}}),
                ),
            );
            client
                .sync_once(matrix_sdk::config::SyncSettings::default())
                .await
                .unwrap();
            let (replacements, histories) = joined_upgrade_links(&client).await;
            assert_eq!(replacements[OLD], NEW);
            assert_eq!(histories[NEW], [OLD]);
        }
    }

    #[tokio::test]
    async fn upgrading_an_invite_only_room_keeps_both_space_links() {
        let server = Server::start().await;
        let dir = TestDir::new();
        let space = "!space:example.org";
        let power = room_state(
            "m.room.power_levels",
            "$power",
            json!({"users": {USER: 100}}),
        );
        let original = joined(&[
            room_state(
                "m.room.create",
                "$original",
                json!({"room_version": "10", "creator": USER}),
            ),
            power.clone(),
        ]);
        let mut child = room_state(
            "m.space.child",
            "$oldchild",
            json!({"via": ["example.org"], "order": "general"}),
        );
        child["state_key"] = json!(OLD);
        let parent = joined(&[
            room_state(
                "m.room.create",
                "$space",
                json!({"room_version": "10", "creator": USER, "type": "m.space"}),
            ),
            power,
            child,
        ]);
        {
            let mut state = server.state.lock().unwrap();
            let mut route = |method: &str, path: String, body| {
                state
                    .route_overrides
                    .insert((method.into(), path), (200, body));
            };
            route(
                "GET",
                "/_matrix/client/v3/sync".into(),
                json!({
                    "next_batch": "first", "rooms": {"join": { OLD: original, space: parent }},
                }),
            );
            route(
                "GET",
                "/_matrix/client/v3/capabilities".into(),
                json!({
                    "capabilities": {"m.room_versions": {"default": "10", "available": {"10": "stable", "12": "stable"}}},
                }),
            );
            route(
                "GET",
                format!("/_matrix/client/v3/rooms/{OLD}/state/m.room.join_rules/"),
                json!({"join_rule": "invite"}),
            );
            route(
                "POST",
                format!("/_matrix/client/v3/rooms/{OLD}/upgrade"),
                json!({"replacement_room": NEW}),
            );
            route(
                "POST",
                format!("/_matrix/client/v3/rooms/{NEW}/join"),
                json!({"room_id": NEW}),
            );
            route(
                "PUT",
                format!("/_matrix/client/v3/rooms/{NEW}/state/m.room.join_rules/"),
                json!({"event_id": "$restricted"}),
            );
            route(
                "PUT",
                format!("/_matrix/client/v3/rooms/{space}/state/m.space.child/{NEW}"),
                json!({"event_id": "$newchild"}),
            );
        }
        let client = client(
            &server.home,
            &dir.0,
            SavedSession {
                user_id: USER.into(),
                device_id: "ADMIN".into(),
                access_token: "token".into(),
            },
        )
        .await;
        assert_eq!(
            target_version(&client, Some(RoomVersionId::V10))
                .await
                .unwrap(),
            Some(RoomVersionId::V12)
        );
        let ac = AuthedClient {
            client,
            homeserver: server.home.clone(),
            access_token: "token".into(),
        };
        let result = perform_upgrade(
            &reqwest::Client::new(),
            &ac,
            OLD,
            RoomVersionId::V12,
            UpgradeAccess::AllowOldMembers,
        )
        .await
        .unwrap();
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.replacement_room_id.as_str(), NEW);
        let state = server.state.lock().unwrap();
        let writes: Vec<_> = state
            .requests
            .iter()
            .filter(|(method, _, _)| method == "PUT")
            .collect();
        assert!(writes.iter().any(|(_, path, body)| path.contains("/state/m.room.join_rules")
            && body == &json!({"join_rule": "restricted", "allow": [{"type": "m.room_membership", "room_id": OLD}]})));
        assert!(writes.iter().any(|(_, path, body)| path
            .ends_with(&format!("/state/m.space.child/{NEW}"))
            && body["order"] == "general"
            && body[SPACE_PREDECESSOR] == OLD));
        assert!(writes
            .iter()
            .all(|(_, path, _)| !path.ends_with(&format!("/state/m.space.child/{OLD}"))));
    }
}

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures_util::stream::{self, StreamExt};
use matrix_sdk::RoomMemberships;
use tauri::State;
use tokio::sync::Mutex;

use crate::types::{RoomInfo, SpaceChildOrder};
use crate::AppState;

use crate::room_relationships::{
    index_parent_spaces, load_space_children, ParentSpaces, SpaceChildMeta,
};

async fn fetch_space_children_for_room(room: matrix_sdk::Room) -> (String, Vec<SpaceChildMeta>) {
    let children = load_space_children(&room).await.unwrap_or_else(|error| {
        log::warn!("get_rooms: {error}");
        Vec::new()
    });
    (room.room_id().to_string(), children)
}

/// Concurrent local space-child and summary reads; sequential was very slow with many spaces/rooms.
const GET_ROOMS_SPACE_CHILD_CONCURRENCY: usize = 16;
const GET_ROOMS_INFO_CONCURRENCY: usize = 24;

async fn build_room_info(
    room: &matrix_sdk::Room,
    parents: &ParentSpaces,
    avatars: &Arc<crate::avatars::AvatarService>,
    presence_map: &Arc<Mutex<HashMap<String, String>>>,
    status_msg_map: &Arc<Mutex<HashMap<String, String>>>,
    membership: &str,
) -> RoomInfo {
    let room_id_str = room.room_id().to_string();

    let mut parent_space_ids: Vec<String> = Vec::new();
    let mut space_child_orders: HashMap<String, SpaceChildOrder> = HashMap::new();
    if let Some(spaces) = parents.get(&room_id_str) {
        for (space_id, meta) in spaces {
            parent_space_ids.push(space_id.clone());
            space_child_orders.insert(
                space_id.clone(),
                SpaceChildOrder {
                    order: meta.order.clone(),
                    origin_server_ts: meta.origin_server_ts,
                },
            );
        }
    }

    let room_type_str = room.room_type().map(|rt| rt.to_string());
    let topic = room.topic();

    let mut name = room.name().unwrap_or_else(|| "Unnamed".to_string());
    let mut avatar_url = avatars.cached(room.avatar_url().as_deref()).await;
    let mut is_direct = false;
    let mut dm_peer_user_id: Option<String> = None;
    let mut dm_peer_presence: Option<String> = None;
    let mut dm_peer_status_msg: Option<String> = None;

    if let Some((dname, dav, pid, pres, smsg)) =
        dm_one_to_one_peer_summary(room, avatars, presence_map, status_msg_map).await
    {
        name = dname;
        avatar_url = dav;
        is_direct = true;
        dm_peer_user_id = Some(pid);
        dm_peer_presence = Some(pres);
        dm_peer_status_msg = smsg;
    }

    RoomInfo {
        id: room_id_str,
        name,
        avatar_url,
        is_space: room.is_space(),
        parent_space_ids,
        space_child_orders,
        room_type: room_type_str,
        topic,
        membership: membership.to_string(),
        is_direct,
        dm_peer_user_id,
        dm_peer_presence,
        dm_peer_status_msg,
    }
}

/// 1:1 direct message: use peer display name, avatar, and presence (like Element).
pub(super) async fn dm_one_to_one_peer_summary(
    room: &matrix_sdk::Room,
    avatars: &Arc<crate::avatars::AvatarService>,
    presence_map: &Arc<Mutex<HashMap<String, String>>>,
    status_msg_map: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<(String, Option<String>, String, String, Option<String>)> {
    if room.is_space() {
        return None;
    }
    let is_dm = room.is_direct().await.ok()?;
    if !is_dm {
        return None;
    }
    let client = room.client();
    let me = client.user_id()?;
    // Include invited members so 1:1 DMs still resolve the peer before they accept (we're joined, they're invited).
    let members = room
        .members_no_sync(RoomMemberships::JOIN | RoomMemberships::INVITE)
        .await
        .ok()?;
    let others: Vec<_> = members.into_iter().filter(|m| m.user_id() != me).collect();
    if others.len() != 1 {
        return None;
    }
    let m = others.into_iter().next()?;
    let peer_id = m.user_id().to_string();
    let display = m
        .display_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| peer_id.clone());
    let avatar = avatars.cached(m.avatar_url()).await;
    let presence = presence_map
        .lock()
        .await
        .get(&peer_id)
        .cloned()
        .unwrap_or_else(|| "offline".to_string());
    let status_msg = status_msg_map.lock().await.get(&peer_id).cloned();
    Some((display, avatar, peer_id, presence, status_msg))
}

#[tauri::command]
pub async fn get_rooms(state: State<'_, Arc<AppState>>) -> Result<Vec<RoomInfo>, String> {
    let client = super::get_client(&state).await?;

    let joined_rooms = client.joined_rooms();
    let invited_rooms = client.invited_rooms();
    let avatars = state.avatars.clone();
    let presence_map = state.presence_map.clone();
    let status_msg_map_rooms = state.status_msg_map.clone();

    let space_rooms: Vec<matrix_sdk::Room> = joined_rooms
        .iter()
        .filter(|r| r.is_space())
        .cloned()
        .collect();

    // Space → child rooms (parallel; was one 10s timeout per space in series).
    // Each child entry carries its `m.space.child` `order` and
    // `origin_server_ts` so the frontend can sort children within a space.
    let space_child_pairs: Vec<(String, Vec<SpaceChildMeta>)> = stream::iter(
        space_rooms
            .into_iter()
            .map(|room| async move { fetch_space_children_for_room(room).await }),
    )
    .buffer_unordered(GET_ROOMS_SPACE_CHILD_CONCURRENCY)
    .collect()
    .await;

    let mut space_children: HashMap<String, Vec<SpaceChildMeta>> =
        space_child_pairs.into_iter().collect();

    // Do not call the federating hierarchy API from the passive room-list path.
    // `get_rooms` is used to keep the sidebars fresh; it should project the
    // local sync store only. Explicit space browsing (`get_space_info`) may
    // federate for discoverable, unjoined children, but an idle client must not
    // repeatedly ask the homeserver to resolve every remote space tree.

    // Flatten through non-joined intermediate sub-spaces.  Matrix allows
    // a space tree where the user has joined a top-level space and a
    // deeply-nested sub-space but NOT the intermediate levels.  The
    // sidebar groups rooms by *joined* parent, so we propagate each
    // joined space's children transitively through any non-joined
    // intermediate sub-spaces.  This ensures a room whose direct parent
    // is a non-joined intermediate still gets the joined ancestor in its
    // `parent_space_ids`.
    {
        let joined_space_ids: HashSet<String> = joined_rooms
            .iter()
            .filter(|r| r.is_space())
            .map(|r| r.room_id().to_string())
            .collect();

        let mut additions: Vec<(String, Vec<SpaceChildMeta>)> = Vec::new();

        for space_id in joined_space_ids.iter() {
            let mut extra: Vec<SpaceChildMeta> = Vec::new();
            let mut queue: Vec<String> = Vec::new();
            let mut visited = HashSet::new();
            visited.insert(space_id.clone());

            if let Some(direct) = space_children.get(space_id) {
                for child in direct {
                    if !joined_space_ids.contains(&child.child_id)
                        && space_children.contains_key(&child.child_id)
                    {
                        queue.push(child.child_id.clone());
                    }
                }
            }

            while let Some(non_joined) = queue.pop() {
                if !visited.insert(non_joined.clone()) {
                    continue;
                }
                if let Some(children) = space_children.get(&non_joined) {
                    for child in children {
                        extra.push(child.clone());
                        if !joined_space_ids.contains(&child.child_id)
                            && space_children.contains_key(&child.child_id)
                        {
                            queue.push(child.child_id.clone());
                        }
                    }
                }
            }

            if !extra.is_empty() {
                additions.push((space_id.clone(), extra));
            }
        }

        let mut flattened = 0usize;
        for (space_id, extra) in additions {
            let entry = space_children.entry(space_id).or_default();
            let existing: HashSet<String> = entry.iter().map(|c| c.child_id.clone()).collect();
            for child in extra {
                if !existing.contains(&child.child_id) {
                    entry.push(child);
                    flattened += 1;
                }
            }
        }
        if flattened > 0 {
            log::info!(
                "get_rooms: flattened {} children through non-joined intermediate spaces",
                flattened
            );
        }
    }

    let parent_spaces = Arc::new(index_parent_spaces(&space_children));

    // Joined rooms: project cached metadata, preserving sidebar order via index sort.
    let mut joined_parts: Vec<(usize, RoomInfo)> =
        stream::iter(joined_rooms.into_iter().enumerate().map(|(idx, room)| {
            let sc = parent_spaces.clone();
            let ac = avatars.clone();
            let pm = presence_map.clone();
            let sm = status_msg_map_rooms.clone();
            async move {
                let info = build_room_info(&room, &sc, &ac, &pm, &sm, "joined").await;
                (idx, info)
            }
        }))
        .buffer_unordered(GET_ROOMS_INFO_CONCURRENCY)
        .collect()
        .await;

    joined_parts.sort_by_key(|(i, _)| *i);
    let mut room_list: Vec<RoomInfo> = joined_parts.into_iter().map(|(_, r)| r).collect();

    // Invited rooms (same pattern).
    let mut invited_parts: Vec<(usize, RoomInfo)> =
        stream::iter(invited_rooms.into_iter().enumerate().map(|(idx, room)| {
            let sc = parent_spaces.clone();
            let ac = avatars.clone();
            let pm = presence_map.clone();
            let sm = status_msg_map_rooms.clone();
            async move {
                let info = build_room_info(&room, &sc, &ac, &pm, &sm, "invited").await;
                (idx, info)
            }
        }))
        .buffer_unordered(GET_ROOMS_INFO_CONCURRENCY)
        .collect()
        .await;

    invited_parts.sort_by_key(|(i, _)| *i);
    room_list.extend(invited_parts.into_iter().map(|(_, r)| r));

    Ok(room_list)
}

#[tauri::command]
pub async fn current_homeserver(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    Ok(client.homeserver().to_string())
}

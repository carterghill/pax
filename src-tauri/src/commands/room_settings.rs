use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::types::{SpaceChildInfo, SpaceInfo};
use crate::AppState;

use super::room_discovery::discover_client_base_urls;
use super::room_listing::dm_one_to_one_peer_summary;
use super::{fmt_error_chain, get_or_fetch_avatar};

/// Convert an MXC URI to an unauthenticated thumbnail URL.
fn mxc_to_thumbnail_url(base_url: &str, mxc: &str, width: u32, height: u32) -> Option<String> {
    let stripped = mxc.strip_prefix("mxc://")?;
    let (server, media_id) = stripped.split_once('/')?;
    Some(format!(
        "{}/_matrix/media/v3/thumbnail/{}/{}?width={}&height={}&method=crop",
        base_url.trim_end_matches('/'),
        server,
        media_id,
        width,
        height,
    ))
}

pub(super) async fn mxc_to_discovered_thumbnail_url(
    http_client: &reqwest::Client,
    discovery_cache: &mut std::collections::HashMap<String, String>,
    mxc: &str,
    width: u32,
    height: u32,
) -> Option<String> {
    let stripped = mxc.strip_prefix("mxc://")?;
    let (server, _) = stripped.split_once('/')?;

    let base_url = if let Some(base_url) = discovery_cache.get(server) {
        base_url.clone()
    } else {
        let discovered = discover_client_base_urls(http_client, server)
            .await
            .into_iter()
            .next()
            .unwrap_or_else(|| format!("https://{server}"));
        discovery_cache.insert(server.to_string(), discovered.clone());
        discovered
    };

    mxc_to_thumbnail_url(&base_url, mxc, width, height)
}

#[tauri::command]
pub async fn get_space_info(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<SpaceInfo, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&space_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let space = client.get_room(&parsed).ok_or("Space not found")?;

    let avatar_cache = state.avatar_cache.clone();
    let space_avatar = get_or_fetch_avatar(
        space.avatar_url().as_deref(),
        space.avatar(matrix_sdk::media::MediaFormat::File),
        &avatar_cache,
    )
    .await;

    let space_name = space.name().unwrap_or_else(|| "Unnamed".to_string());
    let space_topic = space.topic();

    // Call the room hierarchy API to discover child rooms (including ones not yet joined)
    let session = client.matrix_auth().session().ok_or("Not logged in")?;
    let homeserver = client.homeserver().to_string();
    let url = format!(
        "{}/_matrix/client/v1/rooms/{}/hierarchy?limit=50",
        homeserver.trim_end_matches('/'),
        space_id,
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header(
            "Authorization",
            format!("Bearer {}", session.tokens.access_token),
        )
        .send()
        .await
        .map_err(|e| format!("Hierarchy request failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Hierarchy API error ({}): {}", status, text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse hierarchy response: {e}"))?;

    let mut children = Vec::new();
    let mut media_base_url_cache = std::collections::HashMap::new();

    if let Some(rooms) = body["rooms"].as_array() {
        let mut room_index_by_id: HashMap<String, usize> = HashMap::new();
        for (idx, room_data) in rooms.iter().enumerate() {
            if let Some(room_id) = room_data["room_id"].as_str() {
                room_index_by_id.insert(room_id.to_string(), idx);
            }
        }

        let mut direct_child_ids: Vec<String> = Vec::new();
        if let Some(root) = rooms
            .iter()
            .find(|room_data| room_data["room_id"].as_str() == Some(space_id.as_str()))
        {
            if let Some(children_state) = root["children_state"].as_array() {
                let mut seen = HashSet::new();
                for event in children_state {
                    if event["type"].as_str() != Some("m.space.child") {
                        continue;
                    }
                    let Some(child_id) = event["state_key"].as_str() else {
                        continue;
                    };
                    let has_via = event["content"]["via"]
                        .as_array()
                        .map(|arr| !arr.is_empty())
                        .unwrap_or(false);
                    if !has_via || !seen.insert(child_id.to_string()) {
                        continue;
                    }
                    direct_child_ids.push(child_id.to_string());
                }
            }
        }

        // Some homeservers omit `children_state` for inaccessible roots. Fall
        // back to the old behaviour instead of showing an empty space, but keep
        // the normal path direct-child only so nested rooms don't flash under
        // the parent while sub-space fetches catch up.
        if direct_child_ids.is_empty() {
            for room_data in rooms {
                let Some(child_id) = room_data["room_id"].as_str() else {
                    continue;
                };
                if child_id != space_id {
                    direct_child_ids.push(child_id.to_string());
                }
            }
        }

        for child_id in direct_child_ids {
            let Some(idx) = room_index_by_id.get(&child_id).copied() else {
                continue;
            };
            let room_data = &rooms[idx];

            let mut name = room_data["name"].as_str().unwrap_or("Unnamed").to_string();
            let topic = room_data["topic"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string());
            let join_rule = room_data["join_rule"].as_str().map(|s| s.to_string());
            let room_type = room_data["room_type"].as_str().map(|s| s.to_string());
            let num_joined_members = room_data["num_joined_members"].as_u64().unwrap_or(0);

            // Determine this user's membership in the child room
            let membership = if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(&child_id) {
                if let Some(r) = client.get_room(&rid) {
                    match r.state() {
                        matrix_sdk::RoomState::Joined => "joined",
                        matrix_sdk::RoomState::Invited => "invited",
                        _ => "none",
                    }
                } else {
                    "none"
                }
            } else {
                "none"
            }
            .to_string();

            // Avatar: use cache for joined rooms, convert MXC thumbnail URL for others
            let mut avatar_url = if membership == "joined" {
                if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(&child_id) {
                    if let Some(r) = client.get_room(&rid) {
                        get_or_fetch_avatar(
                            r.avatar_url().as_deref(),
                            r.avatar(matrix_sdk::media::MediaFormat::File),
                            &avatar_cache,
                        )
                        .await
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                match room_data["avatar_url"].as_str() {
                    Some(mxc) => {
                        mxc_to_discovered_thumbnail_url(
                            &state.http_client,
                            &mut media_base_url_cache,
                            mxc,
                            64,
                            64,
                        )
                        .await
                    }
                    None => None,
                }
            };

            let mut is_direct = false;
            let mut dm_peer_user_id: Option<String> = None;
            let mut dm_peer_presence: Option<String> = None;
            let mut dm_peer_status_msg: Option<String> = None;

            if membership == "joined" {
                if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(&child_id) {
                    if let Some(r) = client.get_room(&rid) {
                        if let Some((dname, dav, pid, pres, smsg)) = dm_one_to_one_peer_summary(
                            &r,
                            &avatar_cache,
                            &state.presence_map,
                            &state.status_msg_map,
                        )
                        .await
                        {
                            name = dname;
                            avatar_url = dav;
                            is_direct = true;
                            dm_peer_user_id = Some(pid);
                            dm_peer_presence = Some(pres);
                            dm_peer_status_msg = smsg;
                        }
                    }
                }
            }

            children.push(SpaceChildInfo {
                id: child_id,
                name,
                topic,
                avatar_url,
                membership,
                join_rule,
                room_type,
                num_joined_members,
                is_direct,
                dm_peer_user_id,
                dm_peer_presence,
                dm_peer_status_msg,
            });
        }
    }

    Ok(SpaceInfo {
        name: space_name,
        topic: space_topic,
        avatar_url: space_avatar,
        children,
    })
}

#[tauri::command]
pub async fn get_history_visibility(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    // Validate the room exists
    let _ = super::resolve_room(&client, &room_id)?;

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.history_visibility/",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&room_id),
    );

    let resp = state
        .http_client
        .get(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to get history visibility: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !resp.status().is_success() {
        // If the event doesn't exist yet, the spec default is "shared"
        return Ok("shared".to_string());
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse history visibility response: {e}"))?;

    Ok(body
        .get("history_visibility")
        .and_then(|v| v.as_str())
        .unwrap_or("shared")
        .to_string())
}

#[tauri::command]
pub async fn set_history_visibility(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    visibility: String,
) -> Result<(), String> {
    let valid = ["joined", "shared", "invited", "world_readable"];
    if !valid.contains(&visibility.as_str()) {
        return Err(format!(
            "Invalid history_visibility '{}'. Must be one of: {}",
            visibility,
            valid.join(", ")
        ));
    }

    let client = super::get_client(&state).await?;
    // Validate the room exists
    let _ = super::resolve_room(&client, &room_id)?;

    let content = serde_json::json!({
        "history_visibility": visibility,
    });

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.history_visibility/",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&room_id),
    );

    let resp = state
        .http_client
        .put(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to send history visibility event: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to set history visibility ({}): {}",
            status, body
        ));
    }

    log::info!(
        "set_history_visibility: room={} visibility={}",
        room_id,
        visibility
    );
    Ok(())
}

// ─── Space settings (edit existing space; excludes m.federate — immutable after creation) ───

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSettingsSnapshot {
    pub room_id: String,
    pub name: String,
    pub topic: String,
    pub avatar_url: Option<String>,
    pub join_rule: String,
    pub history_visibility: String,
    pub guest_access: String,
    pub listed_in_directory: bool,
    pub room_alias_local: Option<String>,
    pub homeserver_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSettingsPermissions {
    pub name: bool,
    pub topic: bool,
    pub avatar: bool,
    pub join_rules: bool,
    pub history_visibility: bool,
    pub guest_access: bool,
    pub directory_listing: bool,
    pub room_alias: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSettingsData {
    pub snapshot: SpaceSettingsSnapshot,
    pub permissions: SpaceSettingsPermissions,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySpaceSettingsPatch {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_data: Option<String>,
    pub avatar_mime: Option<String>,
    #[serde(default)]
    pub remove_avatar: bool,
    pub listed_in_directory: Option<bool>,
    pub join_rule: Option<String>,
    pub room_alias_local: Option<String>,
    pub history_visibility: Option<String>,
    pub guest_access: Option<String>,
}

fn homeserver_name_from_room_id(room_id: &str) -> String {
    room_id
        .rsplit_once(':')
        .map(|(_, s)| s.to_string())
        .unwrap_or_else(|| "localhost".to_string())
}

fn alias_local_part(canonical_alias: &str) -> Option<String> {
    let s = canonical_alias.strip_prefix('#')?;
    s.split_once(':').map(|(local, _)| local.to_string())
}

fn power_level_for_user(pl: &serde_json::Value, user_id: &str) -> i64 {
    pl.get("users")
        .and_then(|u| u.get(user_id))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("users_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        })
}

fn power_required_for_state_event(pl: &serde_json::Value, event_type: &str) -> i64 {
    pl.get("events")
        .and_then(|e| e.get(event_type))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("state_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(50)
        })
}

pub(super) async fn http_get_room_state(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    room_id: &str,
    event_path: &str,
) -> Result<Option<serde_json::Value>, String> {
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        event_path
    );
    let resp = http_client
        .get(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("State GET failed: {}", fmt_error_chain(&e)))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("State GET error ({}): {}", status, t));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("State GET parse: {e}"))?;
    Ok(Some(body))
}

async fn http_put_room_state(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    room_id: &str,
    event_path: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        event_path
    );
    let resp = http_client
        .put(&state_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(body)
        .send()
        .await
        .map_err(|e| format!("State PUT failed: {}", fmt_error_chain(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("State PUT error ({}): {}", status, t));
    }
    Ok(())
}

/// Normal chat room `creation_content`: federation flag plus optional custom `type` (e.g. voice).
pub(super) fn build_chat_room_creation_content(
    room_type: Option<&str>,
    federate: bool,
) -> serde_json::Value {
    let mut cc = serde_json::json!({
        "m.federate": federate,
    });
    if let Some(rt) = room_type {
        if !rt.is_empty() {
            cc["type"] = serde_json::json!(rt);
        }
    }
    cc
}

// ─── Room general settings (address / federation display; federation is immutable) ───

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomGeneralSettingsSnapshot {
    pub room_id: String,
    pub homeserver_name: String,
    /// From `m.room.create` (`m.federate`); defaults to true if absent.
    pub federate: bool,
    pub join_rule: String,
    pub room_alias_local: Option<String>,
    /// Full canonical alias when set (e.g. `#name:server`), for display/copy.
    pub canonical_alias: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomGeneralSettingsPermissions {
    pub room_alias: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomGeneralSettingsData {
    pub snapshot: RoomGeneralSettingsSnapshot,
    pub permissions: RoomGeneralSettingsPermissions,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRoomGeneralSettingsPatch {
    pub room_alias_local: Option<String>,
}

/// Address, join rule, and federation (read-only) for a normal room.
#[tauri::command]
pub async fn get_room_general_settings(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomGeneralSettingsData, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let _ = client.get_room(&parsed).ok_or("Room not found")?;

    let user_id = client.user_id().ok_or("No user ID")?.to_string();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');

    let pl_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.power_levels/",
    )
    .await?;

    let perms = if let Some(pl) = pl_body {
        let u = power_level_for_user(&pl, &user_id);
        RoomGeneralSettingsPermissions {
            room_alias: u >= power_required_for_state_event(&pl, "m.room.canonical_alias"),
        }
    } else {
        RoomGeneralSettingsPermissions { room_alias: false }
    };

    let create_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.create/",
    )
    .await?;
    let federate = create_body
        .as_ref()
        .and_then(|b| b.get("m.federate"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let join_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.join_rules/",
    )
    .await?;
    let join_rule = join_body
        .as_ref()
        .and_then(|b| b.get("join_rule"))
        .and_then(|v| v.as_str())
        .unwrap_or("invite")
        .to_string();

    let canon_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.canonical_alias/",
    )
    .await?;
    let canonical_alias = canon_body
        .as_ref()
        .and_then(|b| b.get("alias"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let room_alias_local = canonical_alias.as_deref().and_then(|a| alias_local_part(a));

    let homeserver_name = homeserver_name_from_room_id(&room_id);

    Ok(RoomGeneralSettingsData {
        snapshot: RoomGeneralSettingsSnapshot {
            room_id: room_id.clone(),
            homeserver_name,
            federate,
            join_rule,
            room_alias_local,
            canonical_alias,
        },
        permissions: perms,
    })
}

#[tauri::command]
pub async fn apply_room_general_settings(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    patch: ApplyRoomGeneralSettingsPatch,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    client.get_room(&parsed).ok_or("Room not found")?;

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');
    let http = &state.http_client;

    if let Some(local_raw) = &patch.room_alias_local {
        let local = local_raw.trim();
        if !local.is_empty() {
            let server = homeserver_name_from_room_id(&room_id);
            let alias = format!("#{local}:{server}");
            let encoded_alias = urlencoding::encode(&alias);

            let alias_url = format!(
                "{}/_matrix/client/v3/directory/room/{}",
                hs_trim, encoded_alias
            );
            let alias_resp = http
                .put(&alias_url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(access_token.to_string())
                .json(&serde_json::json!({ "room_id": room_id }))
                .send()
                .await
                .map_err(|e| format!("Alias PUT failed: {}", fmt_error_chain(&e)))?;
            let alias_status = alias_resp.status();
            if !alias_status.is_success() && alias_status.as_u16() != 409 {
                let t = alias_resp.text().await.unwrap_or_default();
                return Err(format!("Failed to create alias ({alias_status}): {t}"));
            }

            http_put_room_state(
                http,
                hs_trim,
                &access_token,
                &room_id,
                "m.room.canonical_alias/",
                &serde_json::json!({ "alias": alias }),
            )
            .await?;
        }
    }

    Ok(())
}

/// Full `m.room.power_levels` content plus whether the current user may edit it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPowerLevelsSettings {
    pub content: serde_json::Value,
    pub can_edit: bool,
    pub user_power_level: i64,
    /// True when `m.room.create` has `type: "m.space"`.
    pub is_space: bool,
}

#[tauri::command]
pub async fn get_room_power_levels_settings(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomPowerLevelsSettings, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let _ = client.get_room(&parsed).ok_or("Room not found")?;

    let user_id = client.user_id().ok_or("No user ID")?.to_string();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');

    let create_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.create/",
    )
    .await?;
    let is_space = create_body
        .as_ref()
        .and_then(|b| b.get("type"))
        .and_then(|v| v.as_str())
        == Some("m.space");

    let pl_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.power_levels/",
    )
    .await?
    .ok_or("This room has no power levels state (unexpected).")?;

    let u = power_level_for_user(&pl_body, &user_id);
    let required_edit = power_required_for_state_event(&pl_body, "m.room.power_levels");
    let can_edit = u >= required_edit;

    Ok(RoomPowerLevelsSettings {
        content: pl_body,
        can_edit,
        user_power_level: u,
        is_space,
    })
}

#[tauri::command]
pub async fn set_room_power_levels(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    content: serde_json::Value,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    client.get_room(&parsed).ok_or("Room not found")?;

    let user_id = client.user_id().ok_or("No user ID")?.to_string();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');

    let pl_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.power_levels/",
    )
    .await?
    .ok_or("Power levels not found")?;

    let u = power_level_for_user(&pl_body, &user_id);
    let required_edit = power_required_for_state_event(&pl_body, "m.room.power_levels");
    if u < required_edit {
        return Err("You don't have permission to change power levels.".to_string());
    }

    if !content.is_object() {
        return Err("Power levels must be a JSON object.".to_string());
    }

    http_put_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &room_id,
        "m.room.power_levels/",
        &content,
    )
    .await
}

/// Snapshot and per-field edit permissions for a space room (from `m.room.power_levels`).
#[tauri::command]
pub async fn get_space_settings(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<SpaceSettingsData, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&space_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client.get_room(&parsed).ok_or("Space not found")?;

    let user_id = client.user_id().ok_or("No user ID")?.to_string();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');

    let pl_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.power_levels/",
    )
    .await?;

    let (_user_pl, perms) = if let Some(pl) = pl_body {
        let u = power_level_for_user(&pl, &user_id);
        let join_editable = {
            let jr = http_get_room_state(
                &state.http_client,
                hs_trim,
                &access_token,
                &space_id,
                "m.room.join_rules/",
            )
            .await
            .ok()
            .flatten();
            let rule = jr
                .as_ref()
                .and_then(|b| b.get("join_rule"))
                .and_then(|v| v.as_str())
                .unwrap_or("invite");
            matches!(rule, "public" | "invite" | "knock")
        };
        (
            u,
            SpaceSettingsPermissions {
                name: u >= power_required_for_state_event(&pl, "m.room.name"),
                topic: u >= power_required_for_state_event(&pl, "m.room.topic"),
                avatar: u >= power_required_for_state_event(&pl, "m.room.avatar"),
                join_rules: join_editable
                    && u >= power_required_for_state_event(&pl, "m.room.join_rules"),
                history_visibility: u
                    >= power_required_for_state_event(&pl, "m.room.history_visibility"),
                guest_access: u >= power_required_for_state_event(&pl, "m.room.guest_access"),
                directory_listing: u >= power_required_for_state_event(&pl, "m.room.join_rules"),
                room_alias: u >= power_required_for_state_event(&pl, "m.room.canonical_alias"),
            },
        )
    } else {
        (
            0i64,
            SpaceSettingsPermissions {
                name: false,
                topic: false,
                avatar: false,
                join_rules: false,
                history_visibility: false,
                guest_access: false,
                directory_listing: false,
                room_alias: false,
            },
        )
    };

    let name_state = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.name/",
    )
    .await?;
    let name = name_state
        .as_ref()
        .and_then(|b| b.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| room.name())
        .unwrap_or_else(|| "Unnamed".to_string());

    let topic_state = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.topic/",
    )
    .await?;
    let topic = topic_state
        .as_ref()
        .and_then(|b| b.get("topic"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let avatar_state = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.avatar/",
    )
    .await?;
    let avatar_mxc = avatar_state
        .as_ref()
        .and_then(|b| b.get("url"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let avatar_url = if let Some(mxc) = avatar_mxc {
        mxc_to_thumbnail_url(hs_trim, mxc, 96, 96)
    } else {
        get_or_fetch_avatar(
            room.avatar_url().as_deref(),
            room.avatar(matrix_sdk::media::MediaFormat::File),
            &state.avatar_cache,
        )
        .await
    };

    let join_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.join_rules/",
    )
    .await?;
    let join_rule = join_body
        .as_ref()
        .and_then(|b| b.get("join_rule"))
        .and_then(|v| v.as_str())
        .unwrap_or("invite")
        .to_string();

    let guest_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.guest_access/",
    )
    .await?;
    let guest_access = guest_body
        .as_ref()
        .and_then(|b| b.get("guest_access"))
        .and_then(|v| v.as_str())
        .unwrap_or("forbidden")
        .to_string();

    let history_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.history_visibility/",
    )
    .await?;
    let history_visibility = history_body
        .as_ref()
        .and_then(|b| b.get("history_visibility"))
        .and_then(|v| v.as_str())
        .unwrap_or("shared")
        .to_string();

    let dir_url = format!(
        "{}/_matrix/client/v3/directory/list/room/{}",
        hs_trim,
        urlencoding::encode(&space_id)
    );
    let listed_in_directory = match state
        .http_client
        .get(&dir_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|b| {
                b.get("visibility")
                    .and_then(|v| v.as_str())
                    .map(|v| v == "public")
            })
            .unwrap_or(false),
        _ => false,
    };

    let canon_body = http_get_room_state(
        &state.http_client,
        hs_trim,
        &access_token,
        &space_id,
        "m.room.canonical_alias/",
    )
    .await?;
    let room_alias_local = canon_body
        .as_ref()
        .and_then(|b| b.get("alias"))
        .and_then(|v| v.as_str())
        .and_then(|a| alias_local_part(a));

    let homeserver_name = homeserver_name_from_room_id(&space_id);

    Ok(SpaceSettingsData {
        snapshot: SpaceSettingsSnapshot {
            room_id: space_id.clone(),
            name,
            topic,
            avatar_url,
            join_rule,
            history_visibility,
            guest_access,
            listed_in_directory,
            room_alias_local,
            homeserver_name,
        },
        permissions: perms,
    })
}

/// Apply updates to space profile, join rules, directory listing, history, and guest access.
#[tauri::command]
pub async fn apply_space_settings(
    state: State<'_, Arc<AppState>>,
    space_id: String,
    patch: ApplySpaceSettingsPatch,
) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&space_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    client.get_room(&parsed).ok_or("Space not found")?;

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs_trim = homeserver.trim_end_matches('/');
    let http = &state.http_client;

    if let Some(name) = &patch.name {
        let t = name.trim();
        if t.is_empty() {
            return Err("Space name cannot be empty.".to_string());
        }
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.name/",
            &serde_json::json!({ "name": t }),
        )
        .await?;
    }

    if let Some(topic) = &patch.topic {
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.topic/",
            &serde_json::json!({ "topic": topic }),
        )
        .await?;
    }

    if patch.remove_avatar {
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.avatar/",
            &serde_json::json!({}),
        )
        .await?;
    } else if let (Some(data), Some(mime)) = (&patch.avatar_data, &patch.avatar_mime) {
        let bytes = data_encoding::BASE64
            .decode(data.as_bytes())
            .map_err(|e| format!("Invalid base64 avatar data: {e}"))?;

        let upload_url = format!("{}/_matrix/media/v3/upload", hs_trim);
        let resp = http
            .post(&upload_url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(access_token.to_string())
            .header("Content-Type", mime.as_str())
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Avatar upload failed: {}", fmt_error_chain(&e)))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Avatar upload failed ({}): {}", status, text));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Upload response parse: {e}"))?;
        let mxc = body["content_uri"]
            .as_str()
            .ok_or("No content_uri in upload response")?;
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.avatar/",
            &serde_json::json!({ "url": mxc }),
        )
        .await?;
    }

    if let Some(jr) = &patch.join_rule {
        let valid = ["public", "invite", "knock"];
        if !valid.contains(&jr.as_str()) {
            return Err(format!(
                "Invalid join_rule '{}'. Must be one of: {}",
                jr,
                valid.join(", ")
            ));
        }
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.join_rules/",
            &serde_json::json!({ "join_rule": jr }),
        )
        .await?;
    }

    if let Some(ga) = &patch.guest_access {
        let valid = ["can_join", "forbidden"];
        if !valid.contains(&ga.as_str()) {
            return Err(format!(
                "Invalid guest_access '{}'. Must be one of: {}",
                ga,
                valid.join(", ")
            ));
        }
        http_put_room_state(
            http,
            hs_trim,
            &access_token,
            &space_id,
            "m.room.guest_access/",
            &serde_json::json!({ "guest_access": ga }),
        )
        .await?;
    }

    if let Some(hv) = &patch.history_visibility {
        set_history_visibility(state.clone(), space_id.clone(), hv.clone()).await?;
    }

    if let Some(local_raw) = &patch.room_alias_local {
        let local = local_raw.trim();
        if !local.is_empty() {
            let server = homeserver_name_from_room_id(&space_id);
            let alias = format!("#{local}:{server}");
            let encoded_alias = urlencoding::encode(&alias);

            // Create the alias mapping in the room directory first
            let alias_url = format!(
                "{}/_matrix/client/v3/directory/room/{}",
                hs_trim, encoded_alias
            );
            let alias_resp = http
                .put(&alias_url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(access_token.to_string())
                .json(&serde_json::json!({ "room_id": space_id }))
                .send()
                .await
                .map_err(|e| format!("Alias PUT failed: {}", fmt_error_chain(&e)))?;
            let alias_status = alias_resp.status();
            // 409 means alias already exists, which is fine
            if !alias_status.is_success() && alias_status.as_u16() != 409 {
                let t = alias_resp.text().await.unwrap_or_default();
                return Err(format!("Failed to create alias ({alias_status}): {t}"));
            }

            // Now set it as canonical
            http_put_room_state(
                http,
                hs_trim,
                &access_token,
                &space_id,
                "m.room.canonical_alias/",
                &serde_json::json!({ "alias": alias }),
            )
            .await?;
        }
    }

    if let Some(listed) = patch.listed_in_directory {
        let dir_url = format!(
            "{}/_matrix/client/v3/directory/list/room/{}",
            hs_trim,
            urlencoding::encode(&space_id)
        );
        if !listed {
            let resp = http
                .delete(&dir_url)
                .timeout(Duration::from_secs(30))
                .bearer_auth(access_token.to_string())
                .send()
                .await
                .map_err(|e| format!("Directory DELETE failed: {}", fmt_error_chain(&e)))?;
            let status = resp.status();
            if !status.is_success() && status.as_u16() != 404 {
                let t = resp.text().await.unwrap_or_default();
                return Err(format!("Directory DELETE ({}): {}", status, t));
            }
        } else {
            let body = serde_json::json!({ "visibility": "public" });
            let resp = http
                .put(&dir_url)
                .timeout(Duration::from_secs(30))
                .bearer_auth(access_token.to_string())
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Directory PUT failed: {}", fmt_error_chain(&e)))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let t = resp.text().await.unwrap_or_default();
                return Err(format!("Directory PUT ({}): {}", status, t));
            }
        }
    }

    log::info!("apply_space_settings: applied patch for room {}", space_id);
    Ok(())
}

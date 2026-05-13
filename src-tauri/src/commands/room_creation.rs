use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::AppState;

use super::room_settings::build_chat_room_creation_content;
use super::upload_media_b64;

/// Shared parameters for creating a Matrix space (used by both top-level and sub-space creation).
struct SpaceCreationParams<'a> {
    name: &'a str,
    topic: Option<&'a str>,
    is_public: bool,
    room_alias: Option<&'a str>,
    federate: bool,
    avatar_mxc: Option<&'a str>,
    history_visibility: Option<&'a str>,
    guest_access: Option<&'a str>,
    join_rule: Option<&'a str>,
    extra_initial_state: Vec<serde_json::Value>,
}

/// Build the createRoom body, send it, and return the new room ID.
async fn create_space_room(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    params: SpaceCreationParams<'_>,
) -> Result<String, String> {
    let mut initial_state = params.extra_initial_state;

    if let Some(mxc) = params.avatar_mxc {
        initial_state.push(serde_json::json!({
            "type": "m.room.avatar",
            "state_key": "",
            "content": { "url": mxc }
        }));
    }

    if let Some(hv) = params.history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": { "history_visibility": hv }
            }));
        }
    }

    if let Some(ga) = params.guest_access {
        let valid = ["can_join", "forbidden"];
        if valid.contains(&ga) {
            initial_state.push(serde_json::json!({
                "type": "m.room.guest_access",
                "state_key": "",
                "content": { "guest_access": ga }
            }));
        }
    }

    if let Some(jr) = params.join_rule {
        let valid = ["public", "invite", "knock"];
        if valid.contains(&jr) {
            initial_state.push(serde_json::json!({
                "type": "m.room.join_rules",
                "state_key": "",
                "content": { "join_rule": jr }
            }));
        }
    }

    let effective_join_rule = params
        .join_rule
        .unwrap_or(if params.is_public { "public" } else { "invite" });
    let preset = if effective_join_rule == "public" {
        "public_chat"
    } else {
        "private_chat"
    };
    let visibility = if params.is_public { "public" } else { "private" };

    let mut body = serde_json::json!({
        "name": params.name,
        "preset": preset,
        "visibility": visibility,
        "creation_content": {
            "type": "m.space",
            "m.federate": params.federate,
        },
        "initial_state": initial_state,
        "power_level_content_override": {
            "events_default": 100,
        },
    });

    if let Some(t) = params.topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = params.room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create space: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    resp_body["room_id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No room_id in create response".to_string())
}

/// Link a child room/space to a parent space via `m.space.child`.
async fn link_space_child(
    http_client: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    parent_space_id: &str,
    child_room_id: &str,
    server_name: &str,
) -> Result<(), String> {
    let child_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.child/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(parent_space_id),
        urlencoding::encode(child_room_id),
    );

    let child_content = serde_json::json!({
        "via": [server_name],
        "suggested": false,
    });

    let child_resp = http_client
        .put(&child_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .json(&child_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Room created but failed to link to space: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !child_resp.status().is_success() {
        let status = child_resp.status();
        let text = child_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Room created ({}) but linking to space failed ({}): {}",
            child_room_id, status, text
        ));
    }

    Ok(())
}

/// Check whether the logged-in user is allowed to create rooms on the homeserver.
///
/// There is no standard Matrix client API to query this permission directly.
/// Synapse controls it via the `enable_room_creation` config (defaults to `true`).
/// We probe by inspecting the server capabilities endpoint and fall back to
/// assuming creation is allowed — the actual create request will fail with
/// `M_FORBIDDEN` if the server disallows it, and we surface that error in the UI.
#[tauri::command]
pub async fn can_create_rooms(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    let client = super::get_client(&state).await?;

    // The capabilities endpoint doesn't expose room creation directly, but if
    // we can reach it we know the session is valid. Room creation is almost
    // universally enabled, so default to true.
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let url = format!(
        "{}/_matrix/client/v3/capabilities",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => Ok(true),
        Ok(r) if r.status().as_u16() == 403 => Ok(false),
        Ok(_) => Ok(true), // Assume allowed if capabilities endpoint returns unexpected status
        Err(_) => Ok(true), // Network error — optimistic default
    }
}

/// Create a new Matrix space.
///
/// Calls `POST /_matrix/client/v3/createRoom` with `creation_content.type = "m.space"`.
/// If an avatar is provided (base64 + MIME), it is uploaded first and included
/// in the initial room state.
#[tauri::command]
pub async fn create_space(
    state: State<'_, Arc<AppState>>,
    name: String,
    topic: Option<String>,
    is_public: bool,
    room_alias: Option<String>,
    federate: bool,
    avatar_data: Option<String>,
    avatar_mime: Option<String>,
    history_visibility: Option<String>,
    guest_access: Option<String>,
    join_rule: Option<String>,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs = homeserver.trim_end_matches('/');

    let avatar_mxc = match (&avatar_data, &avatar_mime) {
        (Some(data), Some(mime)) => {
            Some(upload_media_b64(&state.http_client, hs, &access_token, data, mime).await?)
        }
        _ => None,
    };

    let room_id = create_space_room(
        &state.http_client,
        hs,
        &access_token,
        SpaceCreationParams {
            name: &name,
            topic: topic.as_deref(),
            is_public,
            room_alias: room_alias.as_deref(),
            federate,
            avatar_mxc: avatar_mxc.as_deref(),
            history_visibility: history_visibility.as_deref(),
            guest_access: guest_access.as_deref(),
            join_rule: join_rule.as_deref(),
            extra_initial_state: Vec::new(),
        },
    )
    .await?;

    log::info!(
        "create_space: created '{}' → {} (public={}, federate={})",
        name,
        room_id,
        is_public,
        federate,
    );

    Ok(room_id)
}

/// Create a nested Matrix space under a parent space.
///
/// Same options as [`create_space`], plus linking the new space to `parent_space_id`
/// via `m.space.parent` / `m.space.child`. Requires permission to send `m.space.child`
/// in the parent (same as [`create_room_in_space`]).
#[tauri::command]
pub async fn create_sub_space(
    state: State<'_, Arc<AppState>>,
    parent_space_id: String,
    name: String,
    topic: Option<String>,
    is_public: bool,
    room_alias: Option<String>,
    federate: bool,
    avatar_data: Option<String>,
    avatar_mime: Option<String>,
    history_visibility: Option<String>,
    guest_access: Option<String>,
    join_rule: Option<String>,
) -> Result<String, String> {
    if !can_manage_space_children_for_user(&state, &parent_space_id).await? {
        return Err(
            "You don't have permission to add rooms to this space (insufficient power level). Ask a space admin to raise your level or create the sub-space for you.".to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs = homeserver.trim_end_matches('/');

    let server_name = parent_space_id
        .split(':')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    let avatar_mxc = match (&avatar_data, &avatar_mime) {
        (Some(data), Some(mime)) => {
            Some(upload_media_b64(&state.http_client, hs, &access_token, data, mime).await?)
        }
        _ => None,
    };

    let parent_event = serde_json::json!({
        "type": "m.space.parent",
        "state_key": parent_space_id,
        "content": {
            "via": [server_name.clone()],
            "canonical": true,
        }
    });

    let room_id = create_space_room(
        &state.http_client,
        hs,
        &access_token,
        SpaceCreationParams {
            name: &name,
            topic: topic.as_deref(),
            is_public,
            room_alias: room_alias.as_deref(),
            federate,
            avatar_mxc: avatar_mxc.as_deref(),
            history_visibility: history_visibility.as_deref(),
            guest_access: guest_access.as_deref(),
            join_rule: join_rule.as_deref(),
            extra_initial_state: vec![parent_event],
        },
    )
    .await?;

    link_space_child(
        &state.http_client,
        hs,
        &access_token,
        &parent_space_id,
        &room_id,
        &server_name,
    )
    .await?;

    log::info!(
        "create_sub_space: created '{}' → {} under parent {}",
        name,
        room_id,
        parent_space_id
    );

    Ok(room_id)
}

/// Check whether the logged-in user has permission to add/remove children
/// in a space (i.e. can send `m.space.child` state events).
///
/// Compares the user's power level against the level required for
/// `m.space.child` in the space's `m.room.power_levels` state.
async fn can_manage_space_children_for_user(
    state: &AppState,
    space_id: &str,
) -> Result<bool, String> {
    let client = super::get_client(state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Fetch m.room.power_levels from the space
    let pl_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.power_levels/",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(space_id),
    );

    let resp = state
        .http_client
        .get(&pl_url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to fetch power levels: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !resp.status().is_success() {
        // If we can't read power levels, assume no permission
        return Ok(false);
    }

    let pl: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse power levels: {e}"))?;

    // Determine the required power level for m.space.child state events.
    // Check events["m.space.child"] first, then fall back to state_default (spec default 50).
    let required = pl
        .get("events")
        .and_then(|e| e.get("m.space.child"))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("state_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(50)
        });

    // Determine this user's power level.
    // Check users[user_id] first, then fall back to users_default (spec default 0).
    let user_id_str = user_id.to_string();
    let user_pl = pl
        .get("users")
        .and_then(|u| u.get(&user_id_str))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            pl.get("users_default")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        });

    Ok(user_pl >= required)
}

#[tauri::command]
pub async fn can_manage_space_children(
    state: State<'_, Arc<AppState>>,
    space_id: String,
) -> Result<bool, String> {
    can_manage_space_children_for_user(&state, &space_id).await
}

/// Create a new room and add it as a child of the specified space.
///
/// Creates the room via `POST /createRoom`, then sends an `m.space.child`
/// state event in the parent space and an `m.space.parent` state event
/// in the new room to link them bidirectionally.
///
/// `space_room_access` controls directory visibility and join rules:
/// - `space_members` (default): not in the public directory; joined members of
///   the parent space may join without an invite (`join_rule: restricted`).
/// - `public`: public directory + open join.
/// - `invite`: not in the public directory; invite-only.
#[tauri::command]
pub async fn create_room_in_space(
    state: State<'_, Arc<AppState>>,
    space_id: String,
    name: String,
    topic: Option<String>,
    space_room_access: String,
    room_type: Option<String>,
    room_alias: Option<String>,
    history_visibility: Option<String>,
    federate: bool,
) -> Result<String, String> {
    if !can_manage_space_children_for_user(&state, &space_id).await? {
        return Err(
            "You don't have permission to add rooms to this space (insufficient power level). Ask a space admin to raise your level or create the channel for you.".to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Derive the server name from the space ID (e.g. "!abc:matrix.example.com" → "matrix.example.com")
    let server_name = space_id
        .split(':')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    // Build initial state
    let mut initial_state: Vec<serde_json::Value> = Vec::new();

    // Link back to the parent space
    initial_state.push(serde_json::json!({
        "type": "m.space.parent",
        "state_key": space_id,
        "content": {
            "via": [server_name.clone()],
            "canonical": true,
        }
    }));

    let access = space_room_access.trim().to_ascii_lowercase();
    let access = match access.as_str() {
        "public" => "public",
        "invite" => "invite",
        _ => "space_members",
    };

    // Restricted join: members of the parent space can join without an invite.
    // Use private_chat preset and override join_rules (same idea as knock in create_space).
    if access == "space_members" {
        initial_state.push(serde_json::json!({
            "type": "m.room.join_rules",
            "state_key": "",
            "content": {
                "join_rule": "restricted",
                "allow": [
                    {
                        "type": "m.room_membership",
                        "room_id": space_id,
                    }
                ]
            }
        }));
    }

    // History visibility
    if let Some(hv) = &history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {
                    "history_visibility": hv,
                }
            }));
        }
    }

    // Build createRoom body
    let (preset, visibility) = match access {
        "public" => ("public_chat", "public"),
        _ => ("private_chat", "private"),
    };

    let mut body = serde_json::json!({
        "name": name,
        "preset": preset,
        "visibility": visibility,
        "initial_state": initial_state,
    });

    // Room versions that support restricted join rules (MSC3083).
    if access == "space_members" {
        body["room_version"] = serde_json::json!("10");
    }

    if let Some(t) = &topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = &room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    let rt = room_type.as_deref().filter(|s| !s.is_empty());
    body["creation_content"] = build_chat_room_creation_content(rt, federate);

    // Create the room
    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create room: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    let new_room_id = resp_body["room_id"]
        .as_str()
        .ok_or("No room_id in create response")?
        .to_string();

    link_space_child(
        &state.http_client,
        homeserver.trim_end_matches('/'),
        &access_token,
        &space_id,
        &new_room_id,
        &server_name,
    )
    .await?;

    log::info!(
        "create_room_in_space: created '{}' → {} in space {} (access={}, type={:?})",
        name,
        new_room_id,
        space_id,
        access,
        room_type,
    );

    Ok(new_room_id)
}

/// Create a normal room not attached to any space (appears under the global Home list).
///
/// `room_access` matches [`create_room_in_space`] semantics except `space_members` is treated as
/// a private room (not in the public directory; invite to join), since there is no parent space.
#[tauri::command]
pub async fn create_standalone_room(
    state: State<'_, Arc<AppState>>,
    name: String,
    topic: Option<String>,
    room_access: String,
    room_type: Option<String>,
    room_alias: Option<String>,
    history_visibility: Option<String>,
    federate: bool,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let mut initial_state: Vec<serde_json::Value> = Vec::new();

    let access = room_access.trim().to_ascii_lowercase();
    let access = match access.as_str() {
        "public" => "public",
        "invite" => "invite",
        _ => "private", // space_members or unknown: private chat, not in public directory
    };

    let (preset, visibility) = match access {
        "public" => ("public_chat", "public"),
        _ => ("private_chat", "private"),
    };

    if let Some(hv) = &history_visibility {
        let valid = ["joined", "shared", "invited", "world_readable"];
        if valid.contains(&hv.as_str()) {
            initial_state.push(serde_json::json!({
                "type": "m.room.history_visibility",
                "state_key": "",
                "content": {
                    "history_visibility": hv,
                }
            }));
        }
    }

    let mut body = serde_json::json!({
        "name": name,
        "preset": preset,
        "visibility": visibility,
        "initial_state": initial_state,
    });

    if let Some(t) = &topic {
        if !t.is_empty() {
            body["topic"] = serde_json::json!(t);
        }
    }

    if let Some(alias) = &room_alias {
        if !alias.is_empty() {
            body["room_alias_name"] = serde_json::json!(alias);
        }
    }

    let rt = room_type.as_deref().filter(|s| !s.is_empty());
    body["creation_content"] = build_chat_room_creation_content(rt, federate);

    let create_url = format!(
        "{}/_matrix/client/v3/createRoom",
        homeserver.trim_end_matches('/')
    );

    let resp = state
        .http_client
        .post(&create_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create room: {}", super::fmt_error_chain(&e)))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse create response: {e}"))?;

    if !status.is_success() {
        let errcode = resp_body["errcode"].as_str().unwrap_or("UNKNOWN");
        let error = resp_body["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("{}: {}", errcode, error));
    }

    let new_room_id = resp_body["room_id"]
        .as_str()
        .ok_or("No room_id in create response")?
        .to_string();

    log::info!(
        "create_standalone_room: created '{}' → {} (access={}, type={:?})",
        name,
        new_room_id,
        access,
        room_type,
    );

    Ok(new_room_id)
}

/// Link an existing room or sub-space to a parent space via `m.space.parent` / `m.space.child`.
///
/// The user must be able to send `m.space.child` in the parent and `m.space.parent` in the
/// child (typically admin in both rooms).
#[tauri::command]
pub async fn link_room_to_space(
    state: State<'_, Arc<AppState>>,
    parent_space_id: String,
    child_room_id: String,
) -> Result<(), String> {
    if parent_space_id == child_room_id {
        return Err("Cannot link a room to itself.".to_string());
    }

    if !can_manage_space_children_for_user(&state, &parent_space_id).await? {
        return Err(
            "You don't have permission to add rooms to this space (insufficient power level)."
                .to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let server_name = parent_space_id
        .split(':')
        .nth(1)
        .unwrap_or("localhost")
        .to_string();

    // 1) Child points to parent (same shape as create_room_in_space / create_sub_space)
    let parent_state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.parent/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&child_room_id),
        urlencoding::encode(&parent_space_id),
    );

    let parent_content = serde_json::json!({
        "via": [server_name.clone()],
        "canonical": true,
    });

    let parent_resp = state
        .http_client
        .put(&parent_state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&parent_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to link room to parent space: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !parent_resp.status().is_success() {
        let status = parent_resp.status();
        let text = parent_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Could not add parent link in the room ({}): {}",
            status, text
        ));
    }

    link_space_child(
        &state.http_client,
        homeserver.trim_end_matches('/'),
        &access_token,
        &parent_space_id,
        &child_room_id,
        &server_name,
    )
    .await
    .map_err(|e| format!("Parent link was set but failed to update the space: {e}"))?;

    log::info!(
        "link_room_to_space: linked {} as child of {}",
        child_room_id,
        parent_space_id
    );

    Ok(())
}

/// Update the `order` field on a space's `m.space.child` state event for a
/// given child room or sub-space.
///
/// Reads the existing event content, preserves `via` and `suggested`, and
/// replaces only the `order` field.  Passing `order: None` clears the field
/// (so the child falls back to `origin_server_ts` / room id sort order per
/// MSC2946).
///
/// Permission is gated on `can_manage_space_children_for_user` — i.e. the
/// caller's power level must be >= the required level for `m.space.child`
/// state events in this space.  The homeserver will enforce this too, but we
/// check up front so we can return a clear error without a round-trip.
///
/// `order` must contain only ASCII characters in the 0x20..=0x7e range per
/// MSC1772 and be <= 50 codepoints.  The frontend's order-string generator
/// satisfies both constraints.
#[tauri::command]
pub async fn set_space_child_order(
    state: State<'_, Arc<AppState>>,
    space_id: String,
    child_room_id: String,
    order: Option<String>,
) -> Result<(), String> {
    if space_id == child_room_id {
        return Err("A space cannot be its own child.".to_string());
    }

    // Validate the order string before hitting the homeserver so we can
    // return a helpful error.  MSC1772: printable ASCII (0x20..=0x7e) only,
    // length <= 50.
    if let Some(ref s) = order {
        if s.len() > 50 {
            return Err("Order string must be 50 characters or fewer.".to_string());
        }
        if !s.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
            return Err("Order string must only contain printable ASCII (0x20–0x7e).".to_string());
        }
    }

    if !can_manage_space_children_for_user(&state, &space_id).await? {
        return Err(
            "You don't have permission to reorder rooms in this space (insufficient power level)."
                .to_string(),
        );
    }

    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Read the existing `m.space.child` event so we preserve `via` and
    // `suggested` — both are load-bearing and not ours to clobber.  A 404
    // here means the child isn't actually linked to this space, so there's
    // nothing to reorder.
    let read_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.child/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&space_id),
        urlencoding::encode(&child_room_id),
    );

    let read_resp = state
        .http_client
        .get(&read_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to read existing m.space.child event: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if read_resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(
            "This room isn't listed as a child of the space — nothing to reorder.".to_string(),
        );
    }
    if !read_resp.status().is_success() {
        let status = read_resp.status();
        let text = read_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to read m.space.child ({}): {}",
            status, text
        ));
    }

    let existing: serde_json::Value = read_resp.json().await.map_err(|e| {
        format!(
            "Malformed m.space.child response: {}",
            super::fmt_error_chain(&e)
        )
    })?;

    // Preserve `via` (required) and `suggested` (optional).  If `via` is
    // missing or empty per some odd server state, fail rather than write an
    // event that would tombstone the relationship.
    let via = existing
        .get("via")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if via.is_empty() {
        return Err(
            "Existing m.space.child event has no `via`; refusing to rewrite \
and tombstone the child relationship."
                .to_string(),
        );
    }

    let suggested = existing.get("suggested").cloned();

    // Build the new content.  Only include `order` when the caller supplied
    // one; leaving it out is a valid "no order" state per MSC1772.
    let mut new_content = serde_json::json!({ "via": via });
    if let Some(s) = suggested {
        new_content["suggested"] = s;
    }
    if let Some(order_val) = order {
        new_content["order"] = serde_json::Value::String(order_val);
    }

    let write_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.space.child/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&space_id),
        urlencoding::encode(&child_room_id),
    );

    let write_resp = state
        .http_client
        .put(&write_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&new_content)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to update m.space.child event: {}",
                super::fmt_error_chain(&e)
            )
        })?;

    if !write_resp.status().is_success() {
        let status = write_resp.status();
        let text = write_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to update m.space.child order ({}): {}",
            status, text
        ));
    }

    log::info!(
        "set_space_child_order: space={} child={} order={:?}",
        space_id,
        child_room_id,
        new_content.get("order")
    );

    Ok(())
}

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use serde::Deserialize;
use tauri::{Emitter, State};

use crate::types::{
    MatrixUserProfile, RoomManagementMemberInfo, RoomManagementMembersResponse, RoomMemberInfo,
    RoomMemberProfile,
};
use crate::AppState;

use super::{fmt_error_chain, get_client, get_or_fetch_avatar, resolve_room, encode_bytes_data_url, sniff_image_mime};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::ruma::api::client::profile::get_profile::v3::Request as GetProfileRequest;
use matrix_sdk::ruma::api::client::profile::{AvatarUrl, DisplayName};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;

/// True when `own` has strictly higher power than `target` (Matrix kick/ban rules).
fn user_power_outranks(own: UserPowerLevel, target: UserPowerLevel) -> bool {
    match (own, target) {
        (UserPowerLevel::Infinite, UserPowerLevel::Infinite) => false,
        (UserPowerLevel::Infinite, _) => true,
        (_, UserPowerLevel::Infinite) => false,
        (UserPowerLevel::Int(a), UserPowerLevel::Int(b)) => a > b,
        _ => false,
    }
}

fn room_member_role_label(member: &matrix_sdk::room::RoomMember) -> String {
    use matrix_sdk::room::RoomMemberRole;

    match member.suggested_role_for_power_level() {
        RoomMemberRole::Creator => "creator",
        RoomMemberRole::Administrator => "administrator",
        RoomMemberRole::Moderator => "moderator",
        RoomMemberRole::User => "user",
    }
    .to_string()
}

#[tauri::command]
pub async fn get_room_members(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<RoomMemberInfo>, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let members = room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get members: {}", fmt_error_chain(&e)))?;

    let avatar_cache = state.avatar_cache.clone();
    let presence_map = state.presence_map.lock().await.clone();
    let status_msg_snapshot = state.status_msg_map.lock().await.clone();

    // Cache-only avatar lookup — no HTTP, returns instantly.
    let cache_snapshot = avatar_cache.lock().await;
    let mut missing_avatars: Vec<(String, matrix_sdk::room::RoomMember)> = Vec::new();

    let result: Vec<RoomMemberInfo> = members
        .iter()
        .map(|member| {
            let user_id_str = member.user_id().to_string();
            let presence = presence_map
                .get(&user_id_str)
                .cloned()
                .unwrap_or_else(|| "offline".to_string());
            let status_msg = status_msg_snapshot.get(&user_id_str).cloned();
            let avatar_url = member
                .avatar_url()
                .and_then(|mxc| cache_snapshot.get(&mxc.to_string()).cloned());
            if avatar_url.is_none() && member.avatar_url().is_some() {
                missing_avatars.push((user_id_str.clone(), member.clone()));
            }
            RoomMemberInfo {
                user_id: user_id_str,
                display_name: member.display_name().map(|n| n.to_string()),
                avatar_url,
                presence,
                status_msg,
            }
        })
        .collect();
    drop(cache_snapshot);

    // Background task: fetch uncached avatars and push updates to the frontend.
    if !missing_avatars.is_empty() {
        let cache = avatar_cache.clone();
        let rid = room_id.clone();
        tauri::async_runtime::spawn(async move {
            // Process in small batches to avoid hammering the homeserver.
            for chunk in missing_avatars.chunks(10) {
                let futs: Vec<_> = chunk
                    .iter()
                    .map(|(uid, member)| {
                        let cache = cache.clone();
                        let uid = uid.clone();
                        let member = member.clone();
                        async move {
                            let url = get_or_fetch_avatar(
                                member.avatar_url(),
                                member.avatar(matrix_sdk::media::MediaFormat::File),
                                &cache,
                            )
                            .await;
                            (uid, url)
                        }
                    })
                    .collect();

                let results = join_all(futs).await;
                for (uid, url) in results {
                    if let Some(data_url) = url {
                        let _ = app.emit("member-avatar-updated", serde_json::json!({
                            "roomId": rid,
                            "userId": uid,
                            "avatarUrl": data_url,
                        }));
                    }
                }
            }
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn get_room_management_members(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomManagementMembersResponse, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;

    let joined_members = room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get members: {}", fmt_error_chain(&e)))?;

    let presence_map = state.presence_map.lock().await.clone();
    let status_msg_snapshot = state.status_msg_map.lock().await.clone();
    let avatar_snapshot = state.avatar_cache.lock().await.clone();

    let my_id = client.user_id().ok_or("Not logged in")?;
    let self_member_opt = room
        .get_member(my_id)
        .await
        .map_err(|e| format!("Failed to load own membership: {}", fmt_error_chain(&e)))?;

    let joined = joined_members
        .iter()
        .map(|member| {
            let user_id = member.user_id().to_string();
            let avatar_url = member
                .avatar_url()
                .and_then(|mxc| avatar_snapshot.get(&mxc.to_string()).cloned());

            let (can_kick, can_ban) = if member.user_id() == my_id {
                (false, false)
            } else if *member.membership() != MembershipState::Join {
                (false, false)
            } else if let Some(ref sm) = self_member_opt {
                let own_pl = sm.power_level();
                let target_pl = member.power_level();
                let can_kick = sm.can_kick() && user_power_outranks(own_pl, target_pl);
                let can_ban = sm.can_ban() && user_power_outranks(own_pl, target_pl);
                (can_kick, can_ban)
            } else {
                (false, false)
            };

            RoomManagementMemberInfo {
                user_id: user_id.clone(),
                display_name: member.display_name().map(|n| n.to_string()),
                avatar_url,
                presence: presence_map
                    .get(&user_id)
                    .cloned()
                    .unwrap_or_else(|| "offline".to_string()),
                status_msg: status_msg_snapshot.get(&user_id).cloned(),
                role: room_member_role_label(member),
                can_kick,
                can_ban,
            }
        })
        .collect();

    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);
    let members_url = format!(
        "{}/_matrix/client/v3/rooms/{}/members?membership=ban",
        hs, encoded_room
    );

    let resp = state
        .http_client
        .get(&members_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch banned members: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Banned members request failed ({status}): {text}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse banned members: {e}"))?;

    let banned = body["chunk"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|event| {
            let user_id = event["state_key"].as_str()?.to_string();
            let content = &event["content"];
            let avatar_url = content["avatar_url"]
                .as_str()
                .and_then(|mxc| avatar_snapshot.get(mxc).cloned());

            Some(RoomManagementMemberInfo {
                user_id,
                display_name: content["displayname"].as_str().map(|s| s.to_string()),
                avatar_url,
                presence: "offline".to_string(),
                status_msg: None,
                role: "banned".to_string(),
                can_kick: false,
                can_ban: false,
            })
        })
        .collect();

    Ok(RoomManagementMembersResponse { joined, banned })
}

/// Room-scoped profile for a single member (power level, join time, permissions, etc.).
#[tauri::command]
pub async fn get_room_member_profile(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    member_user_id: String,
) -> Result<RoomMemberProfile, String> {
    use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;

    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let uid = matrix_sdk::ruma::UserId::parse(&member_user_id)
        .map_err(|e| format!("Invalid user ID: {e}"))?;

    let Some(member) = room
        .get_member(&uid)
        .await
        .map_err(|e| format!("Failed to load member: {}", fmt_error_chain(&e)))?
    else {
        return Err("Member not found in this room".into());
    };

    let avatar_url = get_or_fetch_avatar(
        member.avatar_url(),
        member.avatar(matrix_sdk::media::MediaFormat::File),
        &state.avatar_cache,
    )
    .await;

    let presence = state
        .presence_map
        .lock()
        .await
        .get(&member_user_id)
        .cloned()
        .unwrap_or_else(|| "offline".to_string());

    let status_msg = state
        .status_msg_map
        .lock()
        .await
        .get(&member_user_id)
        .cloned();

    let role = room_member_role_label(&member);

    let power_level = match member.power_level() {
        UserPowerLevel::Infinite => None,
        UserPowerLevel::Int(n) => i64::try_from(n).ok(),
        _ => None,
    };

    let joined_at_ms = member.event().timestamp().map(|u| {
        let v: u64 = u.into();
        v
    });

    let homeserver = member.user_id().server_name().to_string();
    let display_name = member.display_name().map(|s| s.to_string());

    Ok(RoomMemberProfile {
        user_id: member_user_id,
        display_name,
        avatar_url,
        presence,
        status_msg,
        role,
        power_level,
        joined_at_ms,
        name_ambiguous: member.name_ambiguous(),
        homeserver,
        is_ignored: member.is_ignored(),
        can_invite: member.can_invite(),
        can_kick: member.can_kick(),
        can_ban: member.can_ban(),
    })
}

/// Fetch display name + avatar (data URL) for any user via the Matrix profile API.
#[tauri::command]
pub async fn get_matrix_user_profile(
    state: State<'_, Arc<AppState>>,
    user_id: String,
) -> Result<MatrixUserProfile, String> {
    let client = get_client(&state).await?;
    let uid = matrix_sdk::ruma::UserId::parse(&user_id)
        .map_err(|e| format!("Invalid user ID: {e}"))?;

    let response = client
        .send(GetProfileRequest::new(uid))
        .await
        .map_err(|e| format!("Failed to load profile: {}", fmt_error_chain(&e)))?;

    let display_name = response
        .get_static::<DisplayName>()
        .map_err(|e| format!("Profile displayname: {}", e))?;
    let owned_mxc = response
        .get_static::<AvatarUrl>()
        .map_err(|e| format!("Profile avatar_url: {}", e))?;
    let mxc_ref = owned_mxc.as_deref();

    let client_clone = client.clone();
    let owned_mxc_for_fetch = owned_mxc.clone();
    let fetch_bytes = async move {
        let Some(u) = owned_mxc_for_fetch else {
            return Ok(None);
        };
        let request = MediaRequestParameters {
            source: MediaSource::Plain(u),
            format: MediaFormat::File,
        };
        client_clone
            .media()
            .get_media_content(&request, true)
            .await
            .map(Some)
    };

    let avatar_url = get_or_fetch_avatar(mxc_ref, fetch_bytes, &state.avatar_cache).await;

    Ok(MatrixUserProfile {
        display_name,
        avatar_url,
    })
}

/// Fetch the logged-in user's own avatar as a data URL.
#[tauri::command]
pub async fn get_user_avatar(state: State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let client = get_client(&state).await?;
    let mxc = client
        .account()
        .get_avatar_url()
        .await
        .map_err(|e| format!("Failed to get avatar URL: {}", fmt_error_chain(&e)))?;
    let avatar = get_or_fetch_avatar(
        mxc.as_deref(),
        client
            .account()
            .get_avatar(matrix_sdk::media::MediaFormat::File),
        &state.avatar_cache,
    )
    .await;
    Ok(avatar)
}

// ── Knock / invite / kick ────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnockMembersResponse {
    pub members: Vec<KnockMemberInfo>,
    pub can_invite: bool,
    pub can_kick: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnockMemberInfo {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub reason: Option<String>,
}

/// Fetch members with `membership: knock` for a room, plus whether the
/// current user has permission to invite (accept) or kick (deny) them.
#[tauri::command]
pub async fn get_knock_members(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<KnockMembersResponse, String> {
    let client = get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);
    let user_id = client
        .user_id()
        .ok_or("Not logged in")?
        .to_string();

    // Fetch knock members via CS API
    let members_url = format!(
        "{}/_matrix/client/v3/rooms/{}/members?membership=knock",
        hs, encoded_room
    );
    let resp = state
        .http_client
        .get(&members_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("Failed to fetch knock members: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Knock members request failed ({status}): {text}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse knock members: {e}"))?;

    let chunk = body["chunk"].as_array();
    let avatar_cache = state.avatar_cache.clone();

    let mut members = Vec::new();
    if let Some(events) = chunk {
        for event in events {
            let uid = event["state_key"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let content = &event["content"];
            let display_name = content["displayname"]
                .as_str()
                .map(|s| s.to_string());
            let reason = content["reason"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let mxc = content["avatar_url"].as_str();

            // Resolve avatar to data URL if available
            let avatar_url = if let Some(mxc_uri) = mxc {
                // Check cache first
                let cached = {
                    let cache = avatar_cache.lock().await;
                    cache.get(mxc_uri).cloned()
                };
                if let Some(data_url) = cached {
                    Some(data_url)
                } else {
                    // Build thumbnail URL and fetch
                    let thumb = mxc_uri
                        .strip_prefix("mxc://")
                        .and_then(|stripped| stripped.split_once('/'))
                        .map(|(server, media_id)| {
                            format!(
                                "{}/_matrix/media/v3/thumbnail/{}/{}?width=64&height=64&method=crop",
                                hs, server, media_id
                            )
                        });
                    if let Some(thumb_url) = thumb {
                        match state
                            .http_client
                            .get(&thumb_url)
                            .timeout(Duration::from_secs(10))
                            .send()
                            .await
                        {
                            Ok(r) if r.status().is_success() => {
                                if let Ok(bytes) = r.bytes().await {
                                    let mime = sniff_image_mime(&bytes);
                                    let data_url = encode_bytes_data_url(&bytes, mime);
                                    avatar_cache.lock().await
                                        .insert(mxc_uri.to_string(), data_url.clone());
                                    Some(data_url)
                                } else {
                                    None
                                }
                            }
                            _ => None,
                        }
                    } else {
                        None
                    }
                }
            } else {
                None
            };

            members.push(KnockMemberInfo {
                user_id: uid,
                display_name,
                avatar_url,
                reason,
            });
        }
    }

    // Fetch power levels to determine permissions
    let pl_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.power_levels/",
        hs, encoded_room
    );
    let (can_invite, can_kick) = match state
        .http_client
        .get(&pl_url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let pl: serde_json::Value = resp.json().await.unwrap_or_default();
            let user_pl = pl
                .get("users")
                .and_then(|u| u.get(&user_id))
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| {
                    pl.get("users_default")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0)
                });
            let invite_pl = pl
                .get("invite")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let kick_pl = pl.get("kick").and_then(|v| v.as_i64()).unwrap_or(50);
            (user_pl >= invite_pl, user_pl >= kick_pl)
        }
        _ => (false, false),
    };

    Ok(KnockMembersResponse {
        members,
        can_invite,
        can_kick,
    })
}

/// Power level at or above which a member is treated as a room/space "admin" for leave warnings.
const ADMIN_POWER_LEVEL: i64 = 100;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLeaveSpaceResponse {
    /// True when the current user is the only joined member with power ≥ 100.
    pub is_only_admin: bool,
}

/// Whether leaving this space would remove the last user with admin-level power (typically 100).
#[tauri::command]
pub async fn preview_leave_space(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<PreviewLeaveSpaceResponse, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    if !room.is_space() {
        return Ok(PreviewLeaveSpaceResponse {
            is_only_admin: false,
        });
    }

    let user_id = client
        .user_id()
        .ok_or("Not logged in")?
        .to_string();

    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let members = room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get members: {}", fmt_error_chain(&e)))?;

    let pl_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/m.room.power_levels/",
        hs, encoded_room
    );
    let pl_resp = state
        .http_client
        .get(&pl_url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("Failed to load power levels: {}", fmt_error_chain(&e)))?;

    if !pl_resp.status().is_success() {
        return Ok(PreviewLeaveSpaceResponse {
            is_only_admin: false,
        });
    }

    let pl: serde_json::Value = pl_resp.json().await.unwrap_or_default();
    let users_default = pl
        .get("users_default")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let admin_count = members
        .iter()
        .filter(|m| {
            let uid = m.user_id().to_string();
            let level = pl
                .get("users")
                .and_then(|u| u.get(&uid))
                .and_then(|v| v.as_i64())
                .unwrap_or(users_default);
            level >= ADMIN_POWER_LEVEL
        })
        .count();

    let my_level = pl
        .get("users")
        .and_then(|u| u.get(&user_id))
        .and_then(|v| v.as_i64())
        .unwrap_or(users_default);

    let is_only_admin = admin_count == 1 && my_level >= ADMIN_POWER_LEVEL;

    Ok(PreviewLeaveSpaceResponse { is_only_admin })
}

/// A user row for the invite dialog (search or suggestions).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteUserCandidate {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Homeserver user-directory search (`POST /_matrix/client/v3/user_directory/search`).
#[tauri::command]
pub async fn search_user_directory(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    search_term: String,
    limit: u32,
) -> Result<Vec<InviteUserCandidate>, String> {
    let trimmed = search_term.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    let client = get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');

    let target_room = resolve_room(&client, &room_id)?;
    let target_members: HashSet<String> = target_room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get room members: {}", fmt_error_chain(&e)))?
        .iter()
        .map(|m| m.user_id().to_string())
        .collect();

    let self_id = client
        .user_id()
        .ok_or("Not logged in")?
        .to_string();

    let url = format!("{}/_matrix/client/v3/user_directory/search", hs);
    let cap = limit.clamp(1, 50);
    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(20))
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "search_term": trimmed,
            "limit": cap,
        }))
        .send()
        .await
        .map_err(|e| format!("User search failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("User search failed ({status}): {text}"));
    }

    #[derive(Deserialize)]
    struct UserDirectorySearchResponse {
        results: Vec<UserDirectoryHit>,
    }
    #[derive(Deserialize)]
    struct UserDirectoryHit {
        user_id: String,
        display_name: Option<String>,
        avatar_url: Option<String>,
    }

    let body: UserDirectorySearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse user search: {e}"))?;

    let avatar_cache = state.avatar_cache.clone();
    let mut out = Vec::new();

    for hit in body.results {
        if hit.user_id == self_id || target_members.contains(&hit.user_id) {
            continue;
        }
        let avatar_url = if let Some(ref mxc) = hit.avatar_url {
            resolve_mxc_avatar_data_url(
                &state.http_client,
                hs,
                mxc,
                &avatar_cache,
            )
            .await
        } else {
            None
        };
        out.push(InviteUserCandidate {
            user_id: hit.user_id,
            display_name: hit.display_name,
            avatar_url,
        });
    }

    Ok(out)
}

/// Users you share other joined rooms with (excluding members already in `room_id`), for suggested invites.
#[tauri::command]
pub async fn get_invite_suggestions(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    limit: usize,
) -> Result<Vec<InviteUserCandidate>, String> {
    let client = get_client(&state).await?;
    let target_room = resolve_room(&client, &room_id)?;
    let target_members: HashSet<String> = target_room
        .members(matrix_sdk::RoomMemberships::JOIN)
        .await
        .map_err(|e| format!("Failed to get room members: {}", fmt_error_chain(&e)))?
        .iter()
        .map(|m| m.user_id().to_string())
        .collect();

    let self_id = client
        .user_id()
        .ok_or("Not logged in")?
        .to_string();

    let rooms: Vec<matrix_sdk::Room> = client
        .joined_rooms()
        .into_iter()
        .filter(|r| r.room_id().as_str() != room_id)
        .take(50)
        .collect();

    let futures: Vec<_> = rooms
        .into_iter()
        .map(|room| async move {
            room.members(matrix_sdk::RoomMemberships::JOIN)
                .await
                .map_err(|e| fmt_error_chain(&e))
        })
        .collect();

    let member_lists = join_all(futures).await;

    // user_id -> (shared_room_count, display_name, avatar_mxc)
    let mut agg: HashMap<String, (usize, Option<String>, Option<String>)> = HashMap::new();

    for members_res in member_lists {
        let members = members_res.map_err(|e| format!("Failed to list members: {e}"))?;
        for m in members {
            let uid = m.user_id().to_string();
            if uid == self_id || target_members.contains(&uid) {
                continue;
            }
            let dn = m.display_name().map(|s| s.to_string());
            let mxc = m.avatar_url().map(|u| u.to_string());
            agg.entry(uid)
                .and_modify(|e| {
                    e.0 += 1;
                    if e.1.is_none() {
                        e.1 = dn.clone();
                    }
                    if e.2.is_none() {
                        e.2 = mxc.clone();
                    }
                })
                .or_insert((1, dn, mxc));
        }
    }

    let mut pairs: Vec<(String, (usize, Option<String>, Option<String>))> = agg.into_iter().collect();
    pairs.sort_by(|a, b| {
        b.1.0
            .cmp(&a.1.0)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });

    let cap = limit.max(1).min(40);
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let avatar_cache = state.avatar_cache.clone();

    let mut out = Vec::new();
    for (user_id, (_, display_name, mxc)) in pairs.into_iter().take(cap) {
        let avatar_url = if let Some(ref uri) = mxc {
            resolve_mxc_avatar_data_url(&state.http_client, hs, uri, &avatar_cache).await
        } else {
            None
        };
        out.push(InviteUserCandidate {
            user_id,
            display_name,
            avatar_url,
        });
    }

    Ok(out)
}

async fn resolve_mxc_avatar_data_url(
    http: &reqwest::Client,
    homeserver: &str,
    mxc_uri: &str,
    avatar_cache: &Arc<tokio::sync::Mutex<HashMap<String, String>>>,
) -> Option<String> {
    {
        let cache = avatar_cache.lock().await;
        if let Some(cached) = cache.get(mxc_uri) {
            return Some(cached.clone());
        }
    }

    let thumb = mxc_uri
        .strip_prefix("mxc://")
        .and_then(|stripped| stripped.split_once('/'))
        .map(|(server, media_id)| {
            format!(
                "{}/_matrix/media/v3/thumbnail/{}/{}?width=64&height=64&method=crop",
                homeserver, server, media_id
            )
        })?;

    match http
        .get(&thumb)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            if let Ok(bytes) = r.bytes().await {
                let mime = sniff_image_mime(&bytes);
                let data_url = encode_bytes_data_url(&bytes, mime);
                avatar_cache
                    .lock()
                    .await
                    .insert(mxc_uri.to_string(), data_url.clone());
                return Some(data_url);
            }
        }
        _ => {}
    }
    None
}

/// Invite a user to a room. Used to accept knock requests.
#[tauri::command]
pub async fn invite_user(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    user_id: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let url = format!("{}/_matrix/client/v3/rooms/{}/invite", hs, encoded_room);
    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "user_id": user_id }))
        .send()
        .await
        .map_err(|e| format!("Invite failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Invite failed ({status}): {text}"));
    }
    Ok(())
}

/// Kick a user from a room. Used to deny knock requests.
#[tauri::command]
pub async fn kick_user(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    user_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let url = format!("{}/_matrix/client/v3/rooms/{}/kick", hs, encoded_room);
    let mut body = serde_json::json!({ "user_id": user_id });
    if let Some(r) = reason {
        body["reason"] = serde_json::json!(r);
    }

    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Kick failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Kick failed ({status}): {text}"));
    }
    Ok(())
}

/// Whether the current user may kick or ban `member_user_id` in this room (power levels + membership).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberModerationPermissions {
    pub can_kick: bool,
    pub can_ban: bool,
}

#[tauri::command]
pub async fn get_member_moderation_permissions(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    member_user_id: String,
) -> Result<MemberModerationPermissions, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let my_id = client.user_id().ok_or("Not logged in")?;
    let target_uid = matrix_sdk::ruma::UserId::parse(&member_user_id)
        .map_err(|e| format!("Invalid user ID: {e}"))?;

    if target_uid == *my_id {
        return Ok(MemberModerationPermissions {
            can_kick: false,
            can_ban: false,
        });
    }

    let Some(self_member) = room
        .get_member(my_id)
        .await
        .map_err(|e| format!("Failed to load own membership: {}", fmt_error_chain(&e)))?
    else {
        return Ok(MemberModerationPermissions {
            can_kick: false,
            can_ban: false,
        });
    };

    let Some(target_member) = room
        .get_member(&target_uid)
        .await
        .map_err(|e| format!("Failed to load member: {}", fmt_error_chain(&e)))?
    else {
        return Ok(MemberModerationPermissions {
            can_kick: false,
            can_ban: false,
        });
    };

    if *target_member.membership() != MembershipState::Join {
        return Ok(MemberModerationPermissions {
            can_kick: false,
            can_ban: false,
        });
    }

    let own_pl = self_member.power_level();
    let target_pl = target_member.power_level();

    let can_kick =
        self_member.can_kick() && user_power_outranks(own_pl, target_pl);
    let can_ban = self_member.can_ban() && user_power_outranks(own_pl, target_pl);

    Ok(MemberModerationPermissions { can_kick, can_ban })
}

/// Ban a user from a room or space.
#[tauri::command]
pub async fn ban_user(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    user_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let url = format!("{}/_matrix/client/v3/rooms/{}/ban", hs, encoded_room);
    let mut body = serde_json::json!({ "user_id": user_id });
    if let Some(r) = reason {
        body["reason"] = serde_json::json!(r);
    }

    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ban failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Ban failed ({status}): {text}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn unban_user(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    user_id: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let url = format!("{}/_matrix/client/v3/rooms/{}/unban", hs, encoded_room);
    let body = serde_json::json!({ "user_id": user_id });

    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Unban failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Unban failed ({status}): {text}"));
    }
    Ok(())
}

async fn get_space_tree_room_ids(
    state: &Arc<AppState>,
    client: &matrix_sdk::Client,
    space_id: &str,
) -> Result<Vec<String>, String> {
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(space_id);
    let url = format!(
        "{}/_matrix/client/v1/rooms/{}/hierarchy?limit=200",
        hs, encoded_room
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Hierarchy request failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Hierarchy request failed ({status}): {text}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse hierarchy response: {e}"))?;

    let mut room_ids = vec![space_id.to_string()];
    if let Some(rooms) = body["rooms"].as_array() {
        for room_data in rooms {
            if let Some(room_id) = room_data["room_id"].as_str() {
                if room_id != space_id {
                    room_ids.push(room_id.to_string());
                }
            }
        }
    }

    Ok(room_ids)
}

#[tauri::command]
pub async fn unban_user_from_space_tree(
    state: State<'_, Arc<AppState>>,
    space_id: String,
    user_id: String,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let room_ids = get_space_tree_room_ids(&state, &client, &space_id).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');

    let mut failures = Vec::new();
    for room_id in room_ids {
        let encoded_room = urlencoding::encode(&room_id);
        let url = format!("{}/_matrix/client/v3/rooms/{}/unban", hs, encoded_room);
        let body = serde_json::json!({ "user_id": user_id });

        match state
            .http_client
            .post(&url)
            .timeout(Duration::from_secs(15))
            .bearer_auth(access_token.clone())
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                failures.push(format!("{room_id} ({status}): {text}"));
            }
            Err(e) => failures.push(format!("{room_id}: {}", fmt_error_chain(&e))),
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unbanned in some rooms, but failed in {} room(s): {}",
            failures.len(),
            failures.join(" | ")
        ))
    }
}
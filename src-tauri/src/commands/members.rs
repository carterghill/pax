use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use tauri::State;

use crate::types::RoomMemberInfo;
use crate::AppState;

use super::{fmt_error_chain, get_client, get_or_fetch_avatar, resolve_room, encode_bytes_data_url, sniff_image_mime};

#[tauri::command]
pub async fn get_room_members(
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

    // Fetch all avatars concurrently
    let avatar_futures: Vec<_> = members
        .iter()
        .map(|member| {
            let cache = avatar_cache.clone();
            let member = member.clone();
            async move {
                get_or_fetch_avatar(
                    member.avatar_url(),
                    member.avatar(matrix_sdk::media::MediaFormat::File),
                    &cache,
                )
                .await
            }
        })
        .collect();
    let avatars = join_all(avatar_futures).await;

    let result = members
        .iter()
        .zip(avatars)
        .map(|(member, avatar_url)| {
            let user_id_str = member.user_id().to_string();
            let presence = presence_map
                .get(&user_id_str)
                .cloned()
                .unwrap_or_else(|| "offline".to_string());
            RoomMemberInfo {
                user_id: user_id_str,
                display_name: member.display_name().map(|n| n.to_string()),
                avatar_url,
                presence,
            }
        })
        .collect();

    Ok(result)
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
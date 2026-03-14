use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::{Client, Room};
use tauri::State;

use crate::types::{VoiceJoinResult, VoiceParticipant};
use crate::{screen, voice, AppState};

use super::{fmt_error_chain, get_or_fetch_member_avatar};

const VOICE_ROOM_TYPE: &str = "org.matrix.msc3417.call";

/// Check whether a call.member state event JSON represents an active participant.
/// Handles both MSC4143 (per-device content) and MSC3401 (memberships array) formats,
/// and filters out expired sessions.
fn is_call_member_active(json: &serde_json::Value) -> bool {
    let content = json.get("content");

    // MSC4143: active if content has "application" field (empty content = left)
    let active_new = content.and_then(|c| c.get("application")).is_some();

    // MSC3401: active if non-empty "memberships" array
    let active_old = content
        .and_then(|c| c.get("memberships"))
        .and_then(|m| m.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false);

    if !active_new && !active_old {
        return false;
    }

    // Check expiry
    let origin_ts = json
        .get("origin_server_ts")
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let expires_ms = content
        .and_then(|c| c.get("expires"))
        .and_then(|e| e.as_u64())
        .unwrap_or(0);

    if origin_ts > 0 && expires_ms > 0 {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if origin_ts + expires_ms < now_ms {
            return false; // expired
        }
    }

    true
}

/// Scan a room's call.member state events and return the user IDs of active participants.
async fn collect_active_call_users(room: &Room) -> Vec<String> {
    let mut active: Vec<String> = Vec::new();

    for event_type_str in &["org.matrix.msc3401.call.member", "m.call.member"] {
        let event_type: StateEventType = event_type_str.to_string().into();
        if let Ok(events) = room.get_state_events(event_type).await {
            for event in &events {
                let json = match serde_json::to_value(event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let sender = json
                    .get("sender")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string();

                if !sender.is_empty() && !active.contains(&sender) && is_call_member_active(&json)
                {
                    active.push(sender);
                }
            }
        }
    }

    active
}

async fn collect_room_voice_participants(
    room: &Room,
    avatar_cache: &Arc<tokio::sync::Mutex<HashMap<String, String>>>,
) -> Vec<VoiceParticipant> {
    let active_user_ids = collect_active_call_users(room).await;
    let mut participants = Vec::new();

    for user_id in &active_user_ids {
        let (display_name, avatar_url) = if let Ok(uid) = matrix_sdk::ruma::UserId::parse(user_id) {
            match room.get_member_no_sync(&uid).await {
                Ok(Some(member)) => {
                    let name = member.display_name().map(|n| n.to_string());
                    let avatar = get_or_fetch_member_avatar(&member, avatar_cache).await;
                    (name, avatar)
                }
                _ => (None, None),
            }
        } else {
            (None, None)
        };

        participants.push(VoiceParticipant {
            user_id: user_id.clone(),
            display_name,
            avatar_url,
        });
    }

    participants
}

pub(crate) async fn collect_voice_participants_for_joined_voice_rooms(
    client: &Client,
    avatar_cache: &Arc<tokio::sync::Mutex<HashMap<String, String>>>,
) -> HashMap<String, Vec<VoiceParticipant>> {
    let mut participants_by_room: HashMap<String, Vec<VoiceParticipant>> = HashMap::new();

    for room in client.joined_rooms() {
        let is_voice_room = room
            .room_type()
            .map(|rt| rt.to_string() == VOICE_ROOM_TYPE)
            .unwrap_or(false);
        if !is_voice_room {
            continue;
        }

        let room_id = room.room_id().to_string();
        let participants = collect_room_voice_participants(&room, avatar_cache).await;
        participants_by_room.insert(room_id, participants);
    }

    participants_by_room
}

#[tauri::command]
pub async fn get_all_voice_participants(
    state: State<'_, Arc<AppState>>,
) -> Result<HashMap<String, Vec<VoiceParticipant>>, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    Ok(collect_voice_participants_for_joined_voice_rooms(&client, &state.avatar_cache).await)
}

/// Discover the LiveKit JWT service URL by scanning existing call.member events in the room.
pub(crate) async fn discover_livekit_service_url(room: &Room) -> Result<String, String> {
    for event_type_str in &["org.matrix.msc3401.call.member", "m.call.member"] {
        let event_type: StateEventType = event_type_str.to_string().into();
        if let Ok(events) = room.get_state_events(event_type).await {
            for event in &events {
                let json = match serde_json::to_value(event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Check content.foci_preferred[].livekit_service_url
                if let Some(url) = json
                    .get("content")
                    .and_then(|c| c.get("foci_preferred"))
                    .and_then(|f| f.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|foci| foci.get("livekit_service_url"))
                    .and_then(|u| u.as_str())
                {
                    return Ok(url.to_string());
                }

                // Also check unsigned.prev_content for events where user already left
                if let Some(url) = json
                    .get("unsigned")
                    .and_then(|u| u.get("prev_content"))
                    .and_then(|c| c.get("foci_preferred"))
                    .and_then(|f| f.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|foci| foci.get("livekit_service_url"))
                    .and_then(|u| u.as_str())
                {
                    return Ok(url.to_string());
                }
            }
        }
    }

    Err(
        "Could not discover LiveKit service URL from room state. \
         Has anyone joined a call in this room via Element before?"
            .to_string(),
    )
}

#[tauri::command]
pub async fn get_voice_participants(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<VoiceParticipant>, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not logged in")?.clone()
    };

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;

    let avatar_cache = state.avatar_cache.clone();
    let participants = collect_room_voice_participants(&room, &avatar_cache).await;

    Ok(participants)
}

/// Internal helper: do the Matrix state event + JWT exchange.
/// Returns (jwt, livekit_url).
pub(crate) async fn matrix_voice_join(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
) -> Result<VoiceJoinResult, String> {
    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;

    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;

    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;

    // 1. Discover LiveKit service URL from existing call member events
    let livekit_service_url = discover_livekit_service_url(&room).await?;

    // 2. Build call.member state event content
    let state_key = format!("_{}_{}_{}", user_id, device_id, "m.call");
    let content = serde_json::json!({
        "application": "m.call",
        "call_id": "",
        "device_id": device_id.as_str(),
        "expires": 7200000,
        "foci_preferred": [{
            "livekit_alias": room_id,
            "livekit_service_url": &livekit_service_url,
            "type": "livekit"
        }],
        "focus_active": {
            "focus_selection": "oldest_membership",
            "type": "livekit"
        },
        "m.call.intent": "video",
        "scope": "m.room"
    });

    // 3. Send state event via Matrix CS API
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        urlencoding::encode("org.matrix.msc3401.call.member"),
        urlencoding::encode(&state_key),
    );

    let resp = http
        .put(&state_url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token.to_string())
        .json(&content)
        .send()
        .await
        .map_err(|e| format!("Failed to send state event (join): {}", fmt_error_chain(&e)))?;

    {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to send state event ({}): {}", status, body));
        }
    }

    // 4. Get OpenID token for authenticating with lk-jwt-service
    let openid_request = matrix_sdk::ruma::api::client::account::request_openid_token::v3::Request::new(
        user_id.to_owned(),
    );
    let openid = client
        .send(openid_request)
        .await
        .map_err(|e| format!("Failed to get OpenID token: {e}"))?;

    // 5. Exchange OpenID token for a LiveKit JWT
    let jwt_body = serde_json::json!({
        "room": room_id,
        "openid_token": {
            "access_token": openid.access_token,
            "token_type": "Bearer",
            "matrix_server_name": user_id.server_name().to_string(),
            "expires_in": openid.expires_in.as_secs(),
        },
        "device_id": device_id.as_str(),
    });

    let jwt_url = format!("{}/sfu/get", livekit_service_url.trim_end_matches('/'));
    let jwt_resp = http
        .post(&jwt_url)
        .timeout(Duration::from_secs(30))
        .json(&jwt_body)
        .send()
        .await
        .map_err(|e| format!("Failed to call lk-jwt-service: {}", fmt_error_chain(&e)))?;

    if !jwt_resp.status().is_success() {
        let status = jwt_resp.status();
        let body = jwt_resp.text().await.unwrap_or_default();
        return Err(format!("lk-jwt-service error ({}): {}", status, body));
    }

    let jwt_data: serde_json::Value = jwt_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse lk-jwt-service response: {e}"))?;

    let jwt = jwt_data
        .get("jwt")
        .and_then(|j| j.as_str())
        .ok_or("No 'jwt' field in lk-jwt-service response")?
        .to_string();

    let livekit_url = jwt_data
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or("No 'url' field in lk-jwt-service response")?
        .to_string();

    Ok(VoiceJoinResult { jwt, livekit_url })
}

/// Send a single leave (empty content) for one (event_type, state_key) in a room.
/// 404 is treated as success (already no state). Reuses `http` to avoid creating a client per PUT.
async fn matrix_voice_leave_state_key(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
    event_type: &str,
    state_key: &str,
) -> Result<(), String> {
    let content = serde_json::json!({});
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        urlencoding::encode(event_type),
        urlencoding::encode(state_key),
    );

    let resp = http
        .put(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&content)
        .send()
        .await
        .map_err(|e| format!("Failed to send leave event: {}", fmt_error_chain(&e)))?;

    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to send leave event for {} ({}): {}",
            event_type, status, body
        ));
    }
    Ok(())
}

/// Clear all of this user's call.member state in one room (any device).
/// Reads room state and sends leave for every call.member event whose sender is us.
/// If `skip_state_key` is Some(key), we do not send leave for that state_key (used when
/// we're about to join so we don't leave-then-immediately-join the same key).
async fn matrix_voice_clear_my_memberships_in_room(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
    skip_state_key: Option<&str>,
) -> Result<(), String> {
    let user_id_str = client.user_id().ok_or("No user ID")?.to_string();

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = match client.get_room(&room_id_parsed) {
        Some(r) => r,
        None => return Ok(()),
    };

    for event_type_str in &["org.matrix.msc3401.call.member", "m.call.member"] {
        let event_type: StateEventType = event_type_str.to_string().into();
        let events = match room.get_state_events(event_type).await {
            Ok(evs) => evs,
            Err(_) => continue,
        };
        for event in &events {
            let json = match serde_json::to_value(event) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let sender = json
                .get("sender")
                .and_then(|s| s.as_str())
                .unwrap_or_default();
            let state_key = json
                .get("state_key")
                .and_then(|s| s.as_str())
                .unwrap_or_default();
            if sender != user_id_str || state_key.is_empty() {
                continue;
            }
            if skip_state_key == Some(state_key) {
                continue;
            }
            let _ =
                matrix_voice_leave_state_key(client, http, room_id, event_type_str, state_key).await;
        }
    }
    Ok(())
}

/// Clear this device's call.member state in every joined room.
/// If `join_room_state_key` is Some((room_id, state_key)), we skip sending leave for that
/// state_key in that room (avoids leave-then-join for same key, which can fail on some servers).
/// Runs room cleanups in parallel to reduce total time.
pub(crate) async fn matrix_voice_leave_all_joined_rooms(
    client: &Client,
    http: &reqwest::Client,
    join_room_state_key: Option<(&str, &str)>,
) -> Result<(), String> {
    let room_ids: Vec<String> = client
        .joined_rooms()
        .iter()
        .map(|r| r.room_id().to_string())
        .collect();
    let tasks: Vec<_> = room_ids
        .into_iter()
        .map(|room_id| {
            let client = client.clone();
            let http = http.clone();
            let skip =
                join_room_state_key.and_then(|(r, sk)| if r == room_id { Some(sk.to_string()) } else { None });
            async move {
                matrix_voice_clear_my_memberships_in_room(&client, &http, &room_id, skip.as_deref())
                    .await
            }
        })
        .collect();
    let _ = join_all(tasks).await;
    Ok(())
}

#[tauri::command]
pub async fn voice_connect(
    state: State<'_, Arc<AppState>>,
    voice_mgr: State<'_, voice::VoiceManager>,
    app_handle: tauri::AppHandle,
    room_id: String,
) -> Result<(), String> {
    let (client, http_client) = {
        let guard = state.client.lock().await;
        let client = guard.as_ref().ok_or("Not logged in")?.clone();
        let http = state.http_client.clone();
        (client, http)
    };

    let state_key = format!(
        "_{}_{}_{}",
        client.user_id().ok_or("No user ID")?,
        client.device_id().ok_or("No device ID")?,
        "m.call"
    );

    // Optimistic join: start the Matrix join + LiveKit connect immediately.
    // Run leave-all-rooms cleanup in parallel as fire-and-forget so the user
    // sees the new room almost instantly. Stale memberships get cleaned up
    // a moment later; briefly appearing in two rooms is cosmetic and resolves quickly.
    // Note: cleanup and join hit the homeserver concurrently. skip_state_key avoids
    // clearing our new membership, but stale keys from other devices could race
    // with the join PUT — harmless flicker possible, no functional impact.
    let client_cleanup = client.clone();
    let http_cleanup = http_client.clone();
    let room_id_cleanup = room_id.clone();
    let state_key_cleanup = state_key.clone();
    tokio::spawn(async move {
        let _ = matrix_voice_leave_all_joined_rooms(
            &client_cleanup,
            &http_cleanup,
            Some((&room_id_cleanup, &state_key_cleanup)),
        )
        .await;
    });

    // 1. Do the Matrix join (state event + JWT)
    let result = matrix_voice_join(&client, &http_client, &room_id).await?;
    let identity = client.user_id().ok_or("No user ID")?.to_string();

    // 2. Connect to LiveKit natively via the Rust SDK
    voice_mgr
        .connect(
            room_id.clone(),
            result.livekit_url,
            result.jwt,
            identity,
            app_handle,
        )
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn voice_disconnect(
    state: State<'_, Arc<AppState>>,
    voice_mgr: State<'_, voice::VoiceManager>,
    room_id: String,
) -> Result<(), String> {
    // 1. Disconnect from LiveKit
    voice_mgr.disconnect().await;

    // 2. Clear all of our call.member state in this room (any device, removes phantoms)
    let guard = state.client.lock().await;
    if let Some(client) = guard.as_ref() {
        let _ =
            matrix_voice_clear_my_memberships_in_room(client, &state.http_client, &room_id, None)
                .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn voice_toggle_mic(voice_mgr: State<'_, voice::VoiceManager>) -> Result<bool, String> {
    voice_mgr.toggle_mic()
}

#[tauri::command]
pub async fn voice_toggle_deafen(voice_mgr: State<'_, voice::VoiceManager>) -> Result<bool, String> {
    voice_mgr.toggle_deafen()
}

#[tauri::command]
pub async fn voice_toggle_noise_suppression(
    voice_mgr: State<'_, voice::VoiceManager>,
) -> Result<bool, String> {
    voice_mgr.toggle_noise_suppression()
}

#[tauri::command]
pub async fn voice_start_screen_share(
    voice_mgr: State<'_, voice::VoiceManager>,
    app: tauri::AppHandle,
    mode: String,
    window_title: Option<String>,
) -> Result<(), String> {
    eprintln!(
        "[Pax] voice_start_screen_share: mode={} window_title={:?}",
        mode, window_title
    );
    let screen_mode = match mode.as_str() {
        "window" => screen::ScreenShareMode::Window,
        _ => screen::ScreenShareMode::Screen,
    };
    voice_mgr
        .start_screen_share(screen_mode, window_title, &app)
        .await
}

#[tauri::command]
pub fn enumerate_screen_share_windows() -> Result<Vec<(String, String)>, String> {
    screen::enumerate_screen_share_windows()
}

#[tauri::command]
pub fn get_screen_share_preset() -> screen::ScreenSharePreset {
    screen::get_screen_share_preset()
}

#[tauri::command]
pub fn set_screen_share_preset(preset: screen::ScreenSharePreset) {
    screen::set_screen_share_preset(preset);
}

#[tauri::command]
pub fn get_noise_suppression_config(
    voice_mgr: State<'_, voice::VoiceManager>,
) -> Result<voice::NoiseSuppressionConfig, String> {
    voice_mgr.get_noise_suppression_config()
}

#[tauri::command]
pub fn set_noise_suppression_config(
    voice_mgr: State<'_, voice::VoiceManager>,
    config: voice::NoiseSuppressionConfig,
) -> Result<(), String> {
    voice_mgr.set_noise_suppression_config(config)
}

#[tauri::command]
pub async fn voice_stop_screen_share(
    voice_mgr: State<'_, voice::VoiceManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    voice_mgr.stop_screen_share(&app).await
}

#[tauri::command]
pub async fn voice_set_participant_volume(
    voice_mgr: State<'_, voice::VoiceManager>,
    identity: String,
    volume: f32,
) -> Result<(), String> {
    voice_mgr.set_participant_volume(identity, volume);
    Ok(())
}

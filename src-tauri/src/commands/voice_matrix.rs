use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use jsonwebtoken::{encode, EncodingKey, Header};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::{Client, Room};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::types::{LivekitVoiceParticipantInfo, VoiceJoinResult, VoiceParticipant};
use crate::{screen, voice, AppState, LivekitConfig};

use super::{fmt_error_chain, get_or_fetch_avatar};

/// Matrix room type for voice channels (MSC3417).
/// Also defined in the frontend at `src/utils/matrix.ts` — keep both in sync.
const VOICE_ROOM_TYPE: &str = "org.matrix.msc3417.call";

/// `m.call.member` `expires` field (ms). 4 hours, matching matrix-js-sdk DEFAULT_EXPIRE_DURATION.
const VOICE_CALL_MEMBER_EXPIRES_MS: u64 = 4 * 60 * 60 * 1000;
/// Delayed leave event timeout (ms). If the client crashes, the server
/// fires the leave event after this many ms without a heartbeat restart.
/// 60 s is generous enough to survive brief computer sleep/suspend cycles
/// while still cleaning up ghost participants within a minute of a real crash.
const DELAYED_LEAVE_DELAY_MS: u64 = 60_000;
/// Heartbeat interval: restart the delayed leave timer this often.
/// Must be well under DELAYED_LEAVE_DELAY_MS / 1000 to guarantee at least
/// one restart arrives before the server fires the leave.
const HEARTBEAT_INTERVAL_SECS: u64 = 15;
/// Re-PUT `m.call.member` this often to bump `origin_server_ts` and keep the
/// membership alive. Must be well under VOICE_CALL_MEMBER_EXPIRES_MS (4 h).
/// 3.5 hours = 12 600 s, matching matrix-js-sdk's membershipExpiryTimeout pattern.
const MEMBERSHIP_REFRESH_INTERVAL_SECS: u64 = 3 * 60 * 60 + 30 * 60;

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
    let mut seen = std::collections::HashSet::new();

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

                if !sender.is_empty() && is_call_member_active(&json) {
                    seen.insert(sender);
                }
            }
        }
    }

    seen.into_iter().collect()
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
                    let avatar = get_or_fetch_avatar(
                        member.avatar_url(),
                        member.avatar(matrix_sdk::media::MediaFormat::File),
                        avatar_cache,
                    ).await;
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
    let client = super::get_client(&state).await?;

    Ok(collect_voice_participants_for_joined_voice_rooms(&client, &state.avatar_cache).await)
}

/// Discover the LiveKit JWT service URL.
///
/// 1. Scan existing `m.call.member` state events in the room (fast, no network).
/// 2. Fall back to the homeserver's `/.well-known/matrix/client` endpoint,
///    reading `org.matrix.msc4143.rtc_foci` — the same mechanism Element uses.
pub(crate) async fn discover_livekit_service_url(
    room: &Room,
    http: &reqwest::Client,
    homeserver: &str,
) -> Result<String, String> {
    // ── 1. Room state scan (existing call.member events) ────────────────
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

    // ── 2. .well-known/matrix/client → org.matrix.msc4143.rtc_foci ─────
    log::info!(
        "No livekit_service_url in room state — fetching .well-known/matrix/client from {}",
        homeserver
    );
    let well_known_url = format!(
        "{}/.well-known/matrix/client",
        homeserver.trim_end_matches('/')
    );

    let resp = http
        .get(&well_known_url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!(".well-known fetch failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        return Err(format!(
            ".well-known/matrix/client returned {} — make sure org.matrix.msc4143.rtc_foci \
             is configured (see Element Call self-hosting docs)",
            resp.status()
        ));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!(".well-known JSON parse error: {e}"))?;

    json.get("org.matrix.msc4143.rtc_foci")
        .and_then(|f| f.as_array())
        .and_then(|arr| {
            arr.iter().find(|foci| {
                foci.get("type").and_then(|t| t.as_str()) == Some("livekit")
            })
        })
        .and_then(|foci| foci.get("livekit_service_url"))
        .and_then(|u| u.as_str())
        .map(|url| {
            log::info!("Discovered livekit_service_url from .well-known: {}", url);
            url.to_string()
        })
        .ok_or_else(|| {
            "No org.matrix.msc4143.rtc_foci with type 'livekit' found in \
             .well-known/matrix/client. Add it to your homeserver config — \
             see https://github.com/element-hq/element-call/blob/livekit/docs/self-hosting.md"
                .to_string()
        })
}

#[tauri::command]
pub async fn get_voice_participants(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<VoiceParticipant>, String> {
    let client = super::get_client(&state).await?;
    let room = super::resolve_room(&client, &room_id)?;

    let avatar_cache = state.avatar_cache.clone();
    let participants = collect_room_voice_participants(&room, &avatar_cache).await;

    Ok(participants)
}

// ─── MSC4140 Delayed Events API ─────────────────────────────────────────────
// Instead of client-side refresh timers, we use server-side delayed events:
//   1. On join: PUT a delayed leave (empty content, 60s timeout) → get delay_id
//   2. PUT the actual join state event
//   3. Heartbeat: POST restart every 15s to keep the delayed leave from firing
//   4. On leave: POST send to fire the delayed leave immediately
// If the client crashes, the server fires the leave event after 60s automatically.
// If the client sleeps and the delayed leave fires, the heartbeat loop detects
// the 404 on restart and re-registers + re-PUTs to recover the session.

/// PUT a delayed leave event (empty content) for this device.
/// The server will auto-fire it after `DELAYED_LEAVE_DELAY_MS` unless restarted.
/// Returns the `delay_id` used for heartbeat restarts and graceful leave.
async fn send_delayed_leave_event(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
) -> Result<String, String> {
    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;
    let state_key = format!("_{}_{}_{}", user_id, device_id, "m.call");
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    // Same state endpoint as a normal PUT, but with the delay query parameter.
    // Body is empty {} (= leave content). Server holds it for DELAYED_LEAVE_DELAY_MS.
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}/{}?org.matrix.msc4140.delay={}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        urlencoding::encode("org.matrix.msc3401.call.member"),
        urlencoding::encode(&state_key),
        DELAYED_LEAVE_DELAY_MS,
    );

    let resp = http
        .put(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("send_delayed_leave: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("send_delayed_leave ({}): {}", status, body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("send_delayed_leave JSON: {e}"))?;

    json.get("delay_id")
        .and_then(|d| d.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "send_delayed_leave: no delay_id in response".to_string())
}

/// Restart the delayed leave timer (heartbeat). Must be called every ~15s.
/// Returns Ok(true) on success, Ok(false) if the delayed event is gone (404 —
/// the server already fired it), or Err on transient/network errors.
async fn restart_delayed_event(
    http: &reqwest::Client,
    homeserver: &str,
    access_token: &str,
    delay_id: &str,
) -> Result<bool, String> {
    let url = format!(
        "{}/_matrix/client/unstable/org.matrix.msc4140/delayed_events/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(delay_id),
    );

    let resp = http
        .post(&url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "action": "restart" }))
        .send()
        .await
        .map_err(|e| format!("restart_delayed: {}", fmt_error_chain(&e)))?;

    let status = resp.status();
    if status.is_success() {
        Ok(true)
    } else if status.as_u16() == 404 {
        // The delayed event no longer exists — it was already fired by the server
        // (e.g. after computer sleep exceeded the timeout).
        let body = resp.text().await.unwrap_or_default();
        log::warn!("Delayed event {} is gone (404): {}", delay_id, body);
        Ok(false)
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(format!("restart_delayed ({}): {}", status, body))
    }
}

/// Immediately fire the delayed leave event (graceful disconnect).
/// Falls back to manually PUTting empty content if the delayed event is gone.
async fn send_or_fallback_leave(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
    delay_id: Option<&str>,
) -> Result<(), String> {
    // Try to fire the delayed event first
    if let Some(did) = delay_id {
        let homeserver = client.homeserver().to_string();
        let access_token = client.access_token().ok_or("No access token")?;
        let url = format!(
            "{}/_matrix/client/unstable/org.matrix.msc4140/delayed_events/{}",
            homeserver.trim_end_matches('/'),
            urlencoding::encode(did),
        );

        let resp = http
            .post(&url)
            .timeout(Duration::from_secs(10))
            .bearer_auth(access_token.to_string())
            .json(&serde_json::json!({ "action": "send" }))
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                log::info!("Graceful leave: fired delayed event {}", did);
                return Ok(());
            }
            Ok(r) => {
                log::warn!("send delayed leave failed ({}), falling back to manual PUT", r.status());
            }
            Err(e) => {
                log::warn!("send delayed leave error: {}, falling back to manual PUT", e);
            }
        }
    }

    // Fallback: clear all memberships manually (same as before)
    matrix_voice_clear_my_memberships_in_room(client, http, room_id, None).await
}

/// Force-emit a `voice-participants-changed` event so the sidebar updates immediately
/// without waiting for the next sync response.
pub(crate) async fn force_emit_voice_participants(
    client: &Client,
    avatar_cache: &Arc<tokio::sync::Mutex<HashMap<String, String>>>,
    app_handle: &tauri::AppHandle,
) {
    let participants_by_room =
        collect_voice_participants_for_joined_voice_rooms(client, avatar_cache).await;
    let _ = app_handle.emit(
        "voice-participants-changed",
        crate::types::VoiceParticipantsChangedPayload { participants_by_room },
    );
}

/// PUT `org.matrix.msc3401.call.member` for this device. Returns the LiveKit JWT service URL.
async fn matrix_voice_put_call_member(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
) -> Result<String, String> {
    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;
    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;

    let homeserver = client.homeserver().to_string();
    let livekit_service_url = discover_livekit_service_url(&room, http, &homeserver).await?;
    let state_key = format!("_{}_{}_{}", user_id, device_id, "m.call");
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let content = serde_json::json!({
        "application": "m.call",
        "call_id": "",
        "created_ts": now_ms,
        "device_id": device_id.as_str(),
        "expires": VOICE_CALL_MEMBER_EXPIRES_MS,
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

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to send state event ({}): {}", status, body));
    }

    Ok(livekit_service_url)
}

/// Internal helper: do the Matrix state event + JWT exchange.
/// Returns (jwt, livekit_url).
pub(crate) async fn matrix_voice_join(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
) -> Result<VoiceJoinResult, String> {
    let livekit_service_url = matrix_voice_put_call_member(client, http, room_id).await?;

    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;

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

    // Log the JWT's expiry so we can correlate with ConnectionTimeout kicks
    if let Some(ttl_info) = decode_jwt_expiry(&jwt) {
        log::info!("LiveKit JWT: {}", ttl_info);
    }

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

/// JWT claims for a LiveKit admin token (used to kick participants).
#[derive(Serialize)]
struct LivekitAdminClaims {
    iss: String,
    sub: String,
    iat: u64,
    nbf: u64,
    exp: u64,
    video: LivekitVideoGrant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LivekitVideoGrant {
    room_admin: bool,
    room_list: bool,
    room: String,
}

/// Unpack LiveKit credentials or return `None` if any are missing.
fn livekit_credentials(config: &LivekitConfig) -> Option<(&str, &str, &str)> {
    match (&config.api_key, &config.api_secret, &config.url) {
        (Some(k), Some(s), Some(u)) => Some((k.as_str(), s.as_str(), u.as_str())),
        _ => None,
    }
}

/// Mint a LiveKit admin JWT.  Pass an empty `room_name` for account-level
/// operations (ListRooms), or a specific room name for room-scoped
/// operations (ListParticipants, RemoveParticipant).
fn make_livekit_admin_jwt(
    api_key: &str,
    api_secret: &str,
    room_name: &str,
) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let claims = LivekitAdminClaims {
        iss: api_key.to_string(),
        sub: String::new(),
        iat: now,
        nbf: now,
        exp: now + 60,
        video: LivekitVideoGrant {
            room_admin: true,
            room_list: room_name.is_empty(),
            room: room_name.to_string(),
        },
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )
    .map_err(|e| format!("LiveKit admin JWT: {e}"))
}

/// Remove a single participant from a LiveKit room via Room Service API.
async fn livekit_remove_participant(
    http: &reqwest::Client,
    lk_url: &str,
    room_admin_jwt: &str,
    room_name: &str,
    identity: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/twirp/livekit.RoomService/RemoveParticipant",
        lk_url.trim_end_matches('/')
    );
    let resp = http
        .post(&url)
        .timeout(Duration::from_secs(5))
        .bearer_auth(room_admin_jwt)
        .json(&serde_json::json!({ "room": room_name, "identity": identity }))
        .send()
        .await
        .map_err(|e| format!("RemoveParticipant: {}", fmt_error_chain(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("RemoveParticipant {} ({}): {}", identity, status, body));
    }
    Ok(())
}

/// Kick other devices of the same user from a LiveKit room.
/// Uses the extracted `livekit_list_rooms` / `livekit_list_participants_for_room`
/// helpers and the `make_livekit_admin_jwt` helper to avoid code duplication.
/// Best-effort: errors are logged but do not block the join flow.
async fn kick_other_devices_from_livekit(
    http: &reqwest::Client,
    user_id: &str,
    our_device_id: &str,
    config: &LivekitConfig,
) {
    let (api_key, api_secret, lk_url) = match livekit_credentials(config) {
        Some(creds) => creds,
        None => {
            log::warn!("kick: no LiveKit credentials configured, skipping");
            return;
        }
    };

    let admin_jwt = match make_livekit_admin_jwt(api_key, api_secret, "") {
        Ok(t) => t,
        Err(e) => {
            log::warn!("kick: {e}");
            return;
        }
    };

    let rooms = match livekit_list_rooms(http, lk_url, &admin_jwt).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("kick: {e}");
            return;
        }
    };

    log::debug!("kick: found {} LiveKit rooms", rooms.len());
    let our_prefix = format!("{}:", user_id);
    let our_identity = format!("{}:{}", user_id, our_device_id);

    for lk_room in &rooms {
        let room_name = lk_room.get("name").and_then(|n| n.as_str()).unwrap_or_default();
        if room_name.is_empty() {
            continue;
        }

        let room_jwt = match make_livekit_admin_jwt(api_key, api_secret, room_name) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let participants = match livekit_list_participants_for_room(http, lk_url, &room_jwt, room_name).await {
            Ok(p) => p,
            Err(e) => {
                log::warn!("kick: {e}");
                continue;
            }
        };

        for p in &participants {
            if p.identity.starts_with(&our_prefix) && p.identity != our_identity {
                log::info!("Kicking stale LiveKit participant: {} (room={})", p.identity, room_name);
                if let Err(e) = livekit_remove_participant(http, lk_url, &room_jwt, room_name, &p.identity).await {
                    log::warn!("{e}");
                }
            }
        }
    }
}

/// Start the MSC4140 heartbeat loop: restart the delayed leave event every 15s.
/// If the heartbeat stops (crash, network), the server fires the leave after 60s.
///
/// Also re-PUTs the `m.call.member` state event every ~3.5 hours so that the
/// `origin_server_ts + expires` window never lapses while the user is connected.
///
/// **Recovery after sleep/suspend:** If the delayed event has been fired by the
/// server (404 on restart), the loop re-registers a new delayed leave and
/// re-PUTs the call.member state event to rejoin transparently.
fn start_heartbeat_loop(state: Arc<AppState>, initial_delay_id: String, room_id: String) {
    state.stop_heartbeat_loop();
    state
        .heartbeat_stop
        .store(false, Ordering::SeqCst);
    let stop = state.heartbeat_stop.clone();
    let st = state.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await; // skip immediate first tick

        let mut current_delay_id = initial_delay_id;
        let mut last_membership_refresh = tokio::time::Instant::now();
        let refresh_threshold = Duration::from_secs(MEMBERSHIP_REFRESH_INTERVAL_SECS);

        loop {
            interval.tick().await;
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let client = {
                let guard = st.client.lock().await;
                guard.clone()
            };
            let Some(ref c) = client else {
                break;
            };
            let homeserver = c.homeserver().to_string();
            let access_token = match c.access_token() {
                Some(t) => t.to_string(),
                None => break,
            };

            // 1. Restart the delayed leave (the core heartbeat)
            match restart_delayed_event(
                &st.http_client,
                &homeserver,
                &access_token,
                &current_delay_id,
            )
            .await
            {
                Ok(true) => {
                    // Normal heartbeat success — nothing else to do
                }
                Ok(false) => {
                    // 404: the delayed event was already fired (computer slept, network
                    // outage exceeded the timeout, etc.). We need to re-register and
                    // re-PUT call.member to rejoin the call.
                    log::warn!(
                        "Delayed leave was fired while we were away — recovering session"
                    );
                    match recover_session(c, &st.http_client, &room_id).await {
                        Ok(new_delay_id) => {
                            log::info!(
                                "Session recovered: new delay_id={}",
                                new_delay_id
                            );
                            current_delay_id = new_delay_id.clone();
                            last_membership_refresh = tokio::time::Instant::now();
                            // Update the shared delay_id so voice_disconnect uses the new one
                            if let Ok(mut g) = st.delayed_leave_id.lock() {
                                *g = Some(new_delay_id);
                            }
                        }
                        Err(e) => {
                            log::error!("Session recovery failed: {}", e);
                            // Will retry on the next tick
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Heartbeat restart failed: {}", e);
                    // Transient error — the next tick will retry.
                }
            }

            // 2. Periodically re-PUT call.member to bump origin_server_ts
            if last_membership_refresh.elapsed() >= refresh_threshold {
                log::info!("Refreshing m.call.member to extend expiry window");
                match matrix_voice_put_call_member(c, &st.http_client, &room_id).await {
                    Ok(_) => {
                        log::info!("m.call.member refreshed successfully");
                        last_membership_refresh = tokio::time::Instant::now();
                    }
                    Err(e) => {
                        log::warn!("m.call.member refresh failed: {}", e);
                        // Will retry on the next tick that crosses the threshold
                    }
                }
            }
        }
    });
    if let Ok(mut g) = state.heartbeat_task.lock() {
        *g = Some(handle);
    }
}

/// Re-register a delayed leave + re-PUT the call.member state event after the
/// previous delayed leave was fired by the server (e.g. after computer sleep).
async fn recover_session(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
) -> Result<String, String> {
    // 1. Register a new delayed leave (dead man's switch)
    let new_delay_id = send_delayed_leave_event(client, http, room_id).await?;
    // 2. Re-PUT the call.member to rejoin
    matrix_voice_put_call_member(client, http, room_id).await?;
    Ok(new_delay_id)
}

/// Decode a JWT's payload (without signature verification) to log its expiry.
/// Helps diagnose the recurring ~4h LiveKit ConnectionTimeout kicks.
fn decode_jwt_expiry(jwt: &str) -> Option<String> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.insecure_disable_signature_validation();
    validation.validate_exp = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();

    let key = jsonwebtoken::DecodingKey::from_secret(b"unused");
    let token_data =
        jsonwebtoken::decode::<serde_json::Value>(jwt, &key, &validation).ok()?;
    let claims = token_data.claims;

    let exp = claims.get("exp")?.as_u64()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let ttl_secs = exp.saturating_sub(now);
    let total_validity = claims
        .get("iat")
        .and_then(|v| v.as_u64())
        .map(|iat| exp.saturating_sub(iat))
        .unwrap_or(ttl_secs);

    Some(format!(
        "expires in {}h{}m (total validity: {}h{}m, exp={})",
        ttl_secs / 3600,
        (ttl_secs % 3600) / 60,
        total_validity / 3600,
        (total_validity % 3600) / 60,
        exp,
    ))
}

#[tauri::command]
pub async fn voice_connect(
    state: State<'_, Arc<AppState>>,
    voice_mgr: State<'_, voice::VoiceManager>,
    app_handle: tauri::AppHandle,
    room_id: String,
) -> Result<(), String> {
    log::debug!("voice_connect called for room {}", room_id);
    let state_arc: Arc<AppState> = (*state).clone();
    state_arc.stop_heartbeat_loop();
    let client = super::get_client(&state).await?;
    let http_client = state.http_client.clone();

    let state_key = format!(
        "_{}_{}_{}",
        client.user_id().ok_or("No user ID")?,
        client.device_id().ok_or("No device ID")?,
        "m.call"
    );

    // Kick other devices of the same user from the LiveKit room.
    let user_id_str = client.user_id().ok_or("No user ID")?.to_string();
    let device_id_str = client.device_id().ok_or("No device ID")?.to_string();
    log::debug!("About to kick other devices (user={}, device={})", user_id_str, device_id_str);
    kick_other_devices_from_livekit(
        &http_client,
        &user_id_str,
        &device_id_str,
        &state.livekit,
    )
    .await;
    log::debug!("Kick check complete, proceeding with join");

    // Clean up stale memberships in other rooms (fire-and-forget)
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

    // ── MSC4140 join sequence ──
    // 1. Send delayed leave event (dead man's switch) — server will fire it
    //    in 8s unless we keep restarting it via heartbeat.
    let delay_id = send_delayed_leave_event(&client, &http_client, &room_id).await?;
    log::info!("Delayed leave registered: delay_id={}", delay_id);

    // 2. PUT the actual join state event + get LiveKit JWT
    let result = matrix_voice_join(&client, &http_client, &room_id).await?;
    let identity = client.user_id().ok_or("No user ID")?.to_string();

    // 3. Start heartbeat (restarts the delayed leave every 5s, refreshes membership before expiry)
    start_heartbeat_loop(state_arc.clone(), delay_id.clone(), room_id.clone());

    // Store the delay_id so voice_disconnect can fire it
    if let Ok(mut g) = state_arc.delayed_leave_id.lock() {
        *g = Some(delay_id);
    }

    // 4. Connect to LiveKit
    let app_handle_for_emit = app_handle.clone();
    voice_mgr
        .connect(
            room_id.clone(),
            result.livekit_url,
            result.jwt,
            identity,
            app_handle,
        )
        .await?;

    if let Some((mid, lk_name)) = voice_mgr.current_matrix_room_and_livekit_sfu_name() {
        if let Ok(mut m) = state_arc.livekit_matrix_to_sfu_room.lock() {
            m.insert(mid, lk_name);
        }
    }

    // 5. Force-emit participant update so sidebar refreshes immediately
    let emit_client = client.clone();
    let emit_avatar_cache = state_arc.avatar_cache.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        force_emit_voice_participants(&emit_client, &emit_avatar_cache, &app_handle_for_emit).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn voice_disconnect(
    state: State<'_, Arc<AppState>>,
    voice_mgr: State<'_, voice::VoiceManager>,
    room_id: String,
) -> Result<(), String> {
    // 1. Stop the heartbeat so the delayed leave fires naturally (or we fire it now)
    state.stop_heartbeat_loop();

    // 2. Grab the delay_id before disconnecting
    let delay_id = state
        .delayed_leave_id
        .lock()
        .ok()
        .and_then(|mut g| g.take());

    // 3. Disconnect from LiveKit
    voice_mgr.disconnect().await;

    // 4. Fire the delayed leave immediately (graceful) or fall back to manual PUT
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let guard = state_clone.client.lock().await;
        if let Some(client) = guard.as_ref() {
            let _ = send_or_fallback_leave(
                client,
                &state_clone.http_client,
                &room_id,
                delay_id.as_deref(),
            )
            .await;
        }
    });

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
    log::info!(
        "voice_start_screen_share: mode={} window_title={:?}",
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
pub fn get_screen_share_quality() -> screen::ScreenShareQuality {
    screen::get_screen_share_quality()
}

#[tauri::command]
pub async fn set_screen_share_quality(
    quality: screen::ScreenShareQuality,
    voice_mgr: State<'_, voice::VoiceManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    voice_mgr.set_screen_share_quality(quality, &app).await
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
    source: String,
) -> Result<(), String> {
    voice_mgr.set_participant_volume(identity, volume, source);
    Ok(())
}

fn livekit_room_name_candidates(matrix_room_id: &str) -> Vec<String> {
    let mut v = vec![matrix_room_id.to_string()];
    if let Some(s) = matrix_room_id.strip_prefix('!') {
        v.push(s.to_string());
    }
    v.push(urlencoding::encode(matrix_room_id).to_string());
    v
}

fn pick_livekit_room_name(rooms: &[serde_json::Value], matrix_room_id: &str) -> Option<String> {
    let cands = livekit_room_name_candidates(matrix_room_id);

    // 1. Exact name match (room name IS the matrix room ID or a simple encoding)
    for r in rooms {
        let name = r.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        if cands.iter().any(|c| c == name) {
            return Some(name.to_string());
        }
    }

    // 2. Substring match (room name contains the matrix room ID)
    let short = matrix_room_id.trim_start_matches('!');
    for r in rooms {
        let name = r.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !short.is_empty() && name.contains(short) {
            return Some(name.to_string());
        }
    }

    // 3. Check room metadata — lk-jwt-service may store the original room alias there
    for r in rooms {
        let name = r.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let metadata = r.get("metadata").and_then(|m| m.as_str()).unwrap_or("");
        if !metadata.is_empty() && cands.iter().any(|c| metadata.contains(c.as_str())) {
            return Some(name.to_string());
        }
    }

    // 4. Fallback: if there is exactly one active room (num_participants > 0), use it.
    //    lk-jwt-service hashes the room name so we can't reverse-match, but with a
    //    single active room the mapping is unambiguous.
    let active: Vec<&str> = rooms
        .iter()
        .filter_map(|r| {
            let name = r.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let count = r
                .get("numParticipants")
                .or_else(|| r.get("num_participants"))
                .and_then(|n| n.as_u64())
                .unwrap_or(0);
            if !name.is_empty() && count > 0 {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    if active.len() == 1 {
        return Some(active[0].to_string());
    }

    None
}

fn track_is_microphone_or_voice_audio(track: &serde_json::Value) -> bool {
    if let Some(s) = track.get("source").and_then(|v| v.as_str()) {
        let u = s.to_ascii_uppercase();
        if u.contains("MICROPHONE") || u.contains("SCREEN_SHARE_AUDIO") {
            return true;
        }
    }
    let src_num = track
        .get("source")
        .and_then(|v| v.as_u64())
        .or_else(|| track.get("source").and_then(|v| v.as_i64()).map(|i| i as u64));
    if let Some(n) = src_num {
        if n == 2 || n == 4 {
            return true;
        }
    }
    // TrackType::Audio = 0 in LiveKit protos
    if let Some(s) = track.get("type").and_then(|v| v.as_str()) {
        let u = s.to_ascii_uppercase();
        if u == "AUDIO" || s.eq_ignore_ascii_case("audio") {
            return true;
        }
    }
    let ty_num = track
        .get("type")
        .and_then(|v| v.as_u64())
        .or_else(|| track.get("type").and_then(|v| v.as_i64()).map(|i| i as u64));
    if ty_num == Some(0) {
        return true;
    }
    let mime = track
        .get("mimeType")
        .or_else(|| track.get("mime_type"))
        .and_then(|v| v.as_str());
    if let Some(mime) = mime {
        if mime.to_ascii_lowercase().starts_with("audio/") {
            return true;
        }
    }
    false
}

fn participant_track_nodes(p: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for key in ["tracks", "trackPublications", "publications"] {
        if let Some(arr) = p.get(key).and_then(|t| t.as_array()) {
            for t in arr {
                out.push(t.clone());
            }
        }
    }
    out
}

fn track_muted_flag(track: &serde_json::Value) -> bool {
    if track.get("muted").and_then(|m| m.as_bool()).unwrap_or(false) {
        return true;
    }
    if let Some(inner) = track.get("track") {
        if inner.get("muted").and_then(|m| m.as_bool()).unwrap_or(false) {
            return true;
        }
    }
    false
}

fn parse_livekit_participant_json(p: &serde_json::Value) -> Option<LivekitVoiceParticipantInfo> {
    let identity = p.get("identity").and_then(|v| v.as_str())?.to_string();
    let is_speaking = p
        .get("isSpeaking")
        .or_else(|| p.get("is_speaking"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut mic_muted_from_track = false;
    let mut saw_mic = false;
    for t in participant_track_nodes(p) {
        if track_is_microphone_or_voice_audio(&t) {
            saw_mic = true;
            if track_muted_flag(&t) {
                mic_muted_from_track = true;
            }
        }
    }
    let mut is_deafened = false;
    let mut pax_muted: Option<bool> = None;
    if let Some(attrs) = p.get("attributes").and_then(|a| a.as_object()) {
        if let Some(v) = attrs.get("pax.deafened").and_then(|x| x.as_str()) {
            is_deafened = v == "true";
        }
        if let Some(v) = attrs.get("pax.muted").and_then(|x| x.as_str()) {
            pax_muted = Some(v == "true");
        }
    }
    // Unknown layout: do not assume muted (avoids wrong sidebar icons).
    let is_muted = if let Some(pm) = pax_muted {
        pm
    } else if saw_mic {
        mic_muted_from_track
    } else {
        false
    };
    Some(LivekitVoiceParticipantInfo {
        identity,
        is_muted,
        is_deafened,
        is_speaking,
    })
}

async fn livekit_list_rooms(
    http: &reqwest::Client,
    lk_url: &str,
    admin_jwt: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let list_rooms_url = format!(
        "{}/twirp/livekit.RoomService/ListRooms",
        lk_url.trim_end_matches('/')
    );
    let resp = http
        .post(&list_rooms_url)
        .timeout(Duration::from_secs(8))
        .bearer_auth(admin_jwt)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("ListRooms: {}", fmt_error_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("ListRooms status {}", resp.status()));
    }
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("ListRooms JSON: {e}"))?;
    Ok(json
        .get("rooms")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default())
}

async fn livekit_list_participants_for_room(
    http: &reqwest::Client,
    lk_url: &str,
    room_admin_jwt: &str,
    livekit_room_name: &str,
) -> Result<Vec<LivekitVoiceParticipantInfo>, String> {
    let list_url = format!(
        "{}/twirp/livekit.RoomService/ListParticipants",
        lk_url.trim_end_matches('/')
    );
    let resp = http
        .post(&list_url)
        .timeout(Duration::from_secs(8))
        .bearer_auth(room_admin_jwt)
        .json(&serde_json::json!({ "room": livekit_room_name }))
        .send()
        .await
        .map_err(|e| format!("ListParticipants: {}", fmt_error_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("ListParticipants status {}", resp.status()));
    }
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("ListParticipants JSON: {e}"))?;
    let parts = json
        .get("participants")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(parts
        .iter()
        .filter_map(|p| parse_livekit_participant_json(p))
        .collect())
}

/// Second value: SFU room name to persist when it was discovered (not read from cache).
async fn fetch_livekit_voice_snapshot_for_matrix_room(
    http: &reqwest::Client,
    config: &LivekitConfig,
    matrix_room_id: &str,
    cached_sfu_room_name: Option<&str>,
) -> Result<(Vec<LivekitVoiceParticipantInfo>, Option<String>), String> {
    let (api_key, api_secret, lk_url) = match livekit_credentials(config) {
        Some(creds) => creds,
        _ => return Ok((vec![], None)),
    };

    let (lk_room, discovered_sfu_name) =
        if let Some(name) = cached_sfu_room_name.map(str::trim).filter(|s| !s.is_empty()) {
            (name.to_string(), None)
        } else {
            let admin_jwt = make_livekit_admin_jwt(api_key, api_secret, "")?;
            let rooms = livekit_list_rooms(http, lk_url, &admin_jwt).await?;
            let Some(picked) = pick_livekit_room_name(&rooms, matrix_room_id) else {
                log::debug!(
                    "LiveKit snapshot ({}): no SFU room matched among {} rooms",
                    matrix_room_id, rooms.len()
                );
                return Ok((vec![], None));
            };
            log::debug!("LiveKit snapshot ({}): resolved SFU room '{}'", matrix_room_id, picked);
            (picked.clone(), Some(picked))
        };

    let room_jwt = make_livekit_admin_jwt(api_key, api_secret, &lk_room)?;
    let participants =
        livekit_list_participants_for_room(http, lk_url, &room_jwt, &lk_room).await?;
    Ok((participants, discovered_sfu_name))
}

/// Best-effort LiveKit participant mute/deafen/speaking (requires `LIVEKIT_*` admin env vars).
/// Returns an empty list when credentials are missing or the SFU room name cannot be matched.
#[tauri::command]
pub async fn get_livekit_voice_room_snapshot(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<LivekitVoiceParticipantInfo>, String> {
    let cached = state
        .livekit_matrix_to_sfu_room
        .lock()
        .ok()
        .and_then(|g| g.get(&room_id).cloned());
    let cached_ref = cached.as_deref();
    match fetch_livekit_voice_snapshot_for_matrix_room(
        &state.http_client,
        &state.livekit,
        &room_id,
        cached_ref,
    )
    .await
    {
        Ok((participants, discovered)) => {
            if cached_ref.is_none() {
                if let Some(sfu) = discovered {
                    if let Ok(mut g) = state.livekit_matrix_to_sfu_room.lock() {
                        g.insert(room_id.clone(), sfu);
                    }
                }
            }
            Ok(participants)
        }
        Err(e) => {
            log::debug!("LiveKit voice snapshot ({}): {}", room_id, e);
            Ok(vec![])
        }
    }
}

/// Batched version: fetch LiveKit participant state for multiple Matrix voice rooms
/// in a single call. Calls `ListRooms` once and `ListParticipants` per matched room.
#[tauri::command]
pub async fn get_all_livekit_voice_snapshots(
    state: State<'_, Arc<AppState>>,
    room_ids: Vec<String>,
) -> Result<HashMap<String, Vec<LivekitVoiceParticipantInfo>>, String> {
    let (api_key, api_secret, lk_url) = match livekit_credentials(&state.livekit) {
        Some(creds) => creds,
        _ => {
            // No credentials — return empty for all rooms
            return Ok(room_ids.into_iter().map(|id| (id, vec![])).collect());
        }
    };

    // Read the SFU room name cache
    let sfu_cache: HashMap<String, String> = state
        .livekit_matrix_to_sfu_room
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();

    // Figure out which rooms need a ListRooms lookup (not in cache)
    let needs_discovery: Vec<&String> = room_ids
        .iter()
        .filter(|id| !sfu_cache.contains_key(id.as_str()))
        .collect();

    // Only call ListRooms if at least one room needs discovery
    let discovered_rooms: Vec<serde_json::Value> = if needs_discovery.is_empty() {
        vec![]
    } else {
        let admin_jwt = make_livekit_admin_jwt(api_key, api_secret, "")?;
        livekit_list_rooms(&state.http_client, lk_url, &admin_jwt)
            .await
            .unwrap_or_default()
    };

    let mut result: HashMap<String, Vec<LivekitVoiceParticipantInfo>> = HashMap::new();

    for matrix_room_id in &room_ids {
        // Resolve SFU room name: cache first, then discovery
        let sfu_room_name = if let Some(cached) = sfu_cache.get(matrix_room_id) {
            Some(cached.clone())
        } else {
            pick_livekit_room_name(&discovered_rooms, matrix_room_id)
        };

        let Some(sfu_name) = sfu_room_name else {
            result.insert(matrix_room_id.clone(), vec![]);
            continue;
        };

        // Cache newly discovered SFU room names
        if !sfu_cache.contains_key(matrix_room_id) {
            if let Ok(mut g) = state.livekit_matrix_to_sfu_room.lock() {
                g.insert(matrix_room_id.clone(), sfu_name.clone());
            }
        }

        // Fetch participants for this room
        let room_jwt = match make_livekit_admin_jwt(api_key, api_secret, &sfu_name) {
            Ok(t) => t,
            Err(e) => {
                log::debug!("LiveKit snapshot JWT for {}: {}", matrix_room_id, e);
                result.insert(matrix_room_id.clone(), vec![]);
                continue;
            }
        };

        match livekit_list_participants_for_room(&state.http_client, lk_url, &room_jwt, &sfu_name).await {
            Ok(participants) => {
                result.insert(matrix_room_id.clone(), participants);
            }
            Err(e) => {
                log::debug!("LiveKit snapshot for {}: {}", matrix_room_id, e);
                result.insert(matrix_room_id.clone(), vec![]);
            }
        }
    }

    Ok(result)
}
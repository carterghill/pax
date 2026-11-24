use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::config::RequestConfig;
use matrix_sdk::ruma::{api::client::state::send_state_event, events::StateEventType};
use matrix_sdk::utils::IntoRawStateEventContent;
use matrix_sdk::{Client, Room, RoomState};
use tauri::{Emitter, State};

use crate::types::{LivekitVoiceParticipantInfo, VoiceJoinResult, VoiceParticipant};
use crate::voice_presence::{
    self, LivekitVoiceSnapshot, VoiceMembershipSnapshot,
};
use crate::{screen, voice, AppState};

use super::fmt_error_chain;

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
const FALLBACK_MEMBERSHIP_EXPIRES_MS: u64 = 2 * 60_000;
const FALLBACK_MEMBERSHIP_REFRESH_SECS: u64 = 45;
const MEMBERSHIP_REPAIR_SECS: u64 = 30;
const CALL_MEMBER_EVENT: &str = "org.matrix.msc3401.call.member";

fn call_member_key(client: &Client) -> Result<String, String> {
    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;
    Ok(format!("_{user_id}_{device_id}_m.call"))
}

/// A scoped read also returns the joined voice-room catalog. Failed rooms are
/// omitted so consumers can retain their last successful snapshot.
#[tauri::command]
pub async fn get_all_voice_participants(
    state: State<'_, Arc<AppState>>,
    room_ids: Option<Vec<String>>,
) -> Result<VoiceMembershipSnapshot, String> {
    let session = state.voice_presence.session();
    session
        .run(async {
            let _guard = session.matrix_read.lock().await;
            let client = super::get_client(&state).await?;
            Ok(voice_presence::read_memberships(&client, &state.avatars, room_ids).await)
        })
        .await
}

/// Result of [discover_livekit_service_url]: URL and whether it came from room state (may be stale).
pub(crate) struct DiscoveredLivekitServiceUrl {
    pub url: String,
    /// True when the URL was taken from an existing `m.call.member` event.
    pub from_room_state: bool,
}

/// Discover the LiveKit JWT service URL.
///
/// 1. Unless `skip_room_state`, scan existing `m.call.member` state events in the room
///    (fast, no network).
/// 2. Fall back to the homeserver's `/.well-known/matrix/client` endpoint,
///    reading `org.matrix.msc4143.rtc_foci` — the same mechanism Element uses.
pub(crate) async fn discover_livekit_service_url(
    room: &Room,
    http: &reqwest::Client,
    homeserver: &str,
    skip_room_state: bool,
) -> Result<DiscoveredLivekitServiceUrl, String> {
    // ── 1. Room state scan (existing call.member events) ────────────────
    if !skip_room_state {
        let mut previous_focus = None;
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
                        return Ok(DiscoveredLivekitServiceUrl {
                            url: url.to_string(),
                            from_room_state: true,
                        });
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
                        previous_focus.get_or_insert_with(|| url.to_string());
                    }
                }
            }
        }
        if let Some(url) = previous_focus {
            return Ok(DiscoveredLivekitServiceUrl {
                url,
                from_room_state: true,
            });
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
            arr.iter()
                .find(|foci| foci.get("type").and_then(|t| t.as_str()) == Some("livekit"))
        })
        .and_then(|foci| foci.get("livekit_service_url"))
        .and_then(|u| u.as_str())
        .map(|url| {
            log::info!("Discovered livekit_service_url from .well-known: {}", url);
            DiscoveredLivekitServiceUrl {
                url: url.to_string(),
                from_room_state: false,
            }
        })
        .ok_or_else(|| {
            "No org.matrix.msc4143.rtc_foci with type 'livekit' found in \
             .well-known/matrix/client. Add it to your homeserver config — \
             see https://github.com/element-hq/element-call/blob/livekit/docs/self-hosting.md"
                .to_string()
        })
}

/// POST to `{livekit_service_url}/sfu/get` to validate the JWT service and obtain a LiveKit token.
async fn fetch_livekit_jwt(
    http: &reqwest::Client,
    livekit_service_url: &str,
    room_id: &str,
    user_id: &matrix_sdk::ruma::UserId,
    device_id: &matrix_sdk::ruma::DeviceId,
    openid_access_token: &str,
    openid_expires_in_secs: u64,
) -> Result<VoiceJoinResult, String> {
    let jwt_body = serde_json::json!({
        "room": room_id,
        "openid_token": {
            "access_token": openid_access_token,
            "token_type": "Bearer",
            "matrix_server_name": user_id.server_name().to_string(),
            "expires_in": openid_expires_in_secs,
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

/// Check that the configured focus can admit this device without joining the room.
pub(super) async fn probe_livekit_call(room: &Room, http: &reqwest::Client) -> bool {
    let client = room.client();
    let (Some(user), Some(device)) = (client.user_id(), client.device_id()) else { return false };
    let Ok(focus) = discover_livekit_service_url(room, http, client.homeserver().as_str(), false).await
        else { return false };
    let request = matrix_sdk::ruma::api::client::account::request_openid_token::v3::Request::new(user.to_owned());
    let Ok(token) = client.send(request).await else { return false };
    fetch_livekit_jwt(http, &focus.url, room.room_id().as_str(), user, device,
        token.access_token.as_str(), token.expires_in.as_secs()).await.is_ok()
}

/// JWT service URL for membership PUT during heartbeat / recovery: prefer the validated session URL.
async fn livekit_jwt_service_url_for_refresh(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
    app: &AppState,
) -> Result<String, String> {
    if let Some(u) = app
        .voice_livekit_jwt_service_url
        .lock()
        .ok()
        .and_then(|g| g.clone())
    {
        return Ok(u);
    }

    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client
        .get_room(&room_id_parsed)
        .ok_or("Room not found for JWT service URL fallback")?;
    let homeserver = client.homeserver().to_string();
    // Prefer well-known over room state — room state may still hold a stale URL.
    Ok(discover_livekit_service_url(&room, http, &homeserver, true)
        .await?
        .url)
}

#[tauri::command]
pub async fn get_voice_participants(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<VoiceParticipant>, String> {
    let session = state.voice_presence.session();
    session
        .run(async {
            let _guard = session.matrix_read.lock().await;
            let client = super::get_client(&state).await?;
            let room = super::resolve_room(&client, &room_id)?;
            voice_presence::read_room(&room, &state.avatars)
                .await
                .map(|(participants, _)| participants)
        })
        .await
}

// ─── MSC4140 Delayed Events API ─────────────────────────────────────────────
// When the homeserver supports MSC4140:
//   1. On join: PUT a delayed leave (empty content, 60s timeout) → get delay_id
//   2. PUT the actual join state event
//   3. Heartbeat: POST restart every 15s to keep the delayed leave from firing
//   4. On leave: POST send to fire the delayed leave immediately
// If the client crashes, the server fires the leave event after 60s automatically.
// If the client sleeps and the delayed leave fires, the heartbeat loop detects
// the 404 on restart and re-registers + re-PUTs to recover the session.
// If the server does not support delayed events (M_MAX_DELAY_UNSUPPORTED), we
// skip this path and rely on `m.call.member` `expires` plus periodic re-PUT.

#[derive(Debug)]
enum DelayedLeaveError {
    Unsupported,
    Other(String),
}

fn body_indicates_msc4140_unsupported(body: &str) -> bool {
    if body.contains("M_MAX_DELAY_UNSUPPORTED") {
        return true;
    }
    if body.contains("Delayed events are not supported") {
        return true;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if v.get("errcode").and_then(|x| x.as_str()) == Some("M_UNRECOGNIZED")
            || v.get("org.matrix.msc4140.errcode").and_then(|x| x.as_str()) == Some("M_MAX_DELAY_UNSUPPORTED")
        {
            return true;
        }
    }
    false
}

fn delayed_leave_id(response: &serde_json::Value) -> Result<String, DelayedLeaveError> {
    if let Some(id) = response["delay_id"].as_str().filter(|id| !id.is_empty()) {
        return Ok(id.to_owned());
    }
    // A server that ignores the delay parameter returns a normal state event.
    // The join that follows can publish membership with a short expiry.
    if response["event_id"].as_str().is_some_and(|id| !id.is_empty()) {
        return Err(DelayedLeaveError::Unsupported);
    }
    Err(DelayedLeaveError::Other("send_delayed_leave: no delay_id in response".into()))
}

/// PUT a delayed leave event (empty content) for this device.
/// The server will auto-fire it after `DELAYED_LEAVE_DELAY_MS` unless restarted.
/// Returns the `delay_id` used for heartbeat restarts and graceful leave.
async fn send_delayed_leave_event(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
) -> Result<String, DelayedLeaveError> {
    let state_key = call_member_key(client).map_err(DelayedLeaveError::Other)?;
    let homeserver = client.homeserver().to_string();
    let access_token = client
        .access_token()
        .ok_or_else(|| DelayedLeaveError::Other("No access token".into()))?;

    // Same state endpoint as a normal PUT, but with the delay query parameter.
    // Body is empty {} (= leave content). Server holds it for DELAYED_LEAVE_DELAY_MS.
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state/{}/{}?org.matrix.msc4140.delay={}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(room_id),
        urlencoding::encode(CALL_MEMBER_EVENT),
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
        .map_err(|e| {
            DelayedLeaveError::Other(format!("send_delayed_leave: {}", fmt_error_chain(&e)))
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if body_indicates_msc4140_unsupported(&body) {
            return Err(DelayedLeaveError::Unsupported);
        }
        return Err(DelayedLeaveError::Other(format!(
            "send_delayed_leave ({}): {}",
            status, body
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| DelayedLeaveError::Other(format!("send_delayed_leave JSON: {e}")))?;

    delayed_leave_id(&json)
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
                log::warn!(
                    "send delayed leave failed ({}), falling back to manual PUT",
                    r.status()
                );
            }
            Err(e) => {
                log::warn!(
                    "send delayed leave error: {}, falling back to manual PUT",
                    e
                );
            }
        }
    }

    let key = call_member_key(client)?;
    // The join may have reached the server before it appeared in local sync.
    // Clear the event Pax writes directly, even when the cached roster is empty.
    matrix_voice_leave_state_key(client, http, room_id, CALL_MEMBER_EVENT, &key).await?;
    let room_id_parsed = matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| e.to_string())?;
    if let Some(room) = client.get_room(&room_id_parsed) {
        use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
        if let Ok(Some(RawAnySyncOrStrippedState::Sync(raw))) = room
            .get_state_event("m.call.member".into(), key.as_str())
            .await
        {
            let sender = raw.get_field::<String>("sender").ok().flatten();
            if own_device_membership(
                sender.as_deref().unwrap_or_default(),
                &key,
                room.own_user_id().as_str(),
                client.device_id().ok_or("No device ID")?.as_str(),
            ) {
                matrix_voice_leave_state_key(client, http, room_id, "m.call.member", &key).await?;
            }
        }
    }
    Ok(())
}

/// PUT `org.matrix.msc3401.call.member` for this device using a validated JWT service base URL.
async fn matrix_voice_put_call_member(
    client: &Client,
    room_id: &str,
    livekit_service_url: &str,
    expires_ms: u64,
) -> Result<matrix_sdk::ruma::OwnedEventId, String> {
    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client
        .get_room(&room_id_parsed)
        .filter(|room| room.state() == RoomState::Joined && !room.is_tombstoned())
        .ok_or("You no longer have access to this voice call")?;
    let device_id = client.device_id().ok_or("No device ID")?;

    let state_key = call_member_key(client)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let content = serde_json::json!({
        "application": "m.call",
        "call_id": "",
        "created_ts": now_ms,
        "device_id": device_id.as_str(),
        "expires": expires_ms,
        "foci_preferred": [{
            "livekit_alias": room_id,
            "livekit_service_url": livekit_service_url,
            "type": "livekit"
        }],
        "focus_active": {
            "focus_selection": "oldest_membership",
            "type": "livekit"
        },
        "m.call.intent": if room.room_type().is_some_and(|kind| kind.as_str() == voice_presence::VOICE_ROOM_TYPE) { "video" } else { "audio" },
        "scope": "m.room"
    });

    let request = send_state_event::v3::Request::new_raw(
        room_id_parsed,
        CALL_MEMBER_EVENT.into(),
        state_key,
        content.into_raw_state_event_content(),
    );
    client
        .send(request)
        .with_request_config(
            RequestConfig::new().timeout(Duration::from_secs(30)).disable_retry(),
        )
        .await
        .map(|response| response.event_id)
        .map_err(|e| format!("Failed to publish voice membership: {}", fmt_error_chain(&e)))
}

/// Discover JWT service URL, validate via `/sfu/get`, then PUT `m.call.member` with the working URL.
/// Returns the join payload and the validated JWT service base URL (for heartbeat refresh).
async fn matrix_voice_join(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
    expires_ms: u64,
) -> Result<(VoiceJoinResult, String, matrix_sdk::ruma::OwnedEventId), String> {
    let room_id_parsed =
        matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let room = client.get_room(&room_id_parsed).ok_or("Room not found")?;
    let homeserver = client.homeserver().to_string();

    let user_id = client.user_id().ok_or("No user ID")?;
    let device_id = client.device_id().ok_or("No device ID")?;

    let openid_request =
        matrix_sdk::ruma::api::client::account::request_openid_token::v3::Request::new(
            user_id.to_owned(),
        );
    let openid = client
        .send(openid_request)
        .await
        .map_err(|e| format!("Failed to get OpenID token: {e}"))?;

    let openid_expires = openid.expires_in.as_secs();
    let openid_token = openid.access_token.as_str();

    let mut discovered = discover_livekit_service_url(&room, http, &homeserver, false).await?;

    let mut join = fetch_livekit_jwt(
        http,
        &discovered.url,
        room_id,
        user_id,
        device_id,
        openid_token,
        openid_expires,
    )
    .await;

    if join.is_err() && discovered.from_room_state {
        log::warn!(
            "lk-jwt-service request failed with URL from room state ({}); retrying from .well-known",
            discovered.url
        );
        discovered = discover_livekit_service_url(&room, http, &homeserver, true).await?;
        join = fetch_livekit_jwt(
            http,
            &discovered.url,
            room_id,
            user_id,
            device_id,
            openid_token,
            openid_expires,
        )
        .await;
    }

    let join = join?;
    let service_url = discovered.url;
    let membership = matrix_voice_put_call_member(client, room_id, &service_url, expires_ms).await?;

    Ok((join, service_url, membership))
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

/// A missing event can follow server-side expiry even while LiveKit is healthy.
async fn own_voice_membership_missing(room: &Room, state_key: &str) -> bool {
    match room
        .get_state_event(CALL_MEMBER_EVENT.into(), state_key)
        .await
    {
        Ok(Some(matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState::Sync(raw))) => {
            raw.deserialize_as().ok().is_some_and(|event| {
                voice_presence::active_membership(&event, voice_presence::now_ms()).is_none()
            })
        }
        Ok(None) => true,
        _ => false,
    }
}

fn own_device_membership(sender: &str, state_key: &str, user_id: &str, device_id: &str) -> bool {
    sender == user_id && state_key == format!("_{user_id}_{device_id}_m.call")
}

/// Heartbeat loop: when MSC4140 is in use, restart the delayed leave every 15s
/// (server fires leave after 60s if restarts stop). Otherwise only the membership
/// refresh below runs on this tick.
///
/// Also re-PUTs the `m.call.member` state event every ~3.5 hours so that the
/// `origin_server_ts + expires` window never lapses while the user is connected.
///
/// **Recovery after sleep/suspend (MSC4140 only):** If the delayed event was
/// fired (404 on restart), the loop re-registers a delayed leave and re-PUTs
/// call.member; if the server no longer supports MSC4140, recovery falls back
/// to membership-only mode.
fn start_heartbeat_loop(
    state: Arc<AppState>,
    initial_delay_id: Option<String>,
    room_id: String,
    media: voice::VoiceMembershipHeartbeat,
) {
    state.stop_heartbeat_loop();
    state.heartbeat_stop.store(false, Ordering::SeqCst);
    let stop = state.heartbeat_stop.clone();
    let st = state.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await; // skip immediate first tick

        let mut current_delay_id = initial_delay_id;
        let mut last_membership_refresh = tokio::time::Instant::now();
        let mut membership_missing_since = None;
        let Ok(parsed_room) = matrix_sdk::ruma::RoomId::parse(&room_id) else {
            return;
        };

        loop {
            // Wait for either the regular heartbeat tick OR a LiveKit reconnect signal.
            // On reconnect we want to immediately re-PUT call.member so the server
            // knows we're still alive, rather than waiting up to 15s for the next tick.
            let reconnected = tokio::select! {
                _ = interval.tick() => false,
                _ = media.reconnected.notified() => true,
            };
            if stop.load(Ordering::SeqCst)
                || media.room.connection_state() == livekit::ConnectionState::Disconnected
            {
                break;
            }
            let client = {
                let guard = st.client.lock().await;
                guard.clone()
            };
            let Some(ref c) = client else {
                break;
            };
            let Some(matrix_room) = c
                .get_room(&parsed_room)
                .filter(|room| room.state() == RoomState::Joined && !room.is_tombstoned())
            else {
                let _ = media.room.close().await;
                break;
            };
            let Ok(state_key) = call_member_key(c) else {
                break;
            };
            let homeserver = c.homeserver().to_string();
            let access_token = match c.access_token() {
                Some(t) => t.to_string(),
                None => break,
            };

            if last_membership_refresh.elapsed() >= Duration::from_secs(HEARTBEAT_INTERVAL_SECS)
                && own_voice_membership_missing(&matrix_room, &state_key).await
            {
                let first_missing =
                    membership_missing_since.get_or_insert_with(tokio::time::Instant::now);
                if first_missing.elapsed() >= Duration::from_secs(MEMBERSHIP_REPAIR_SECS) {
                    media.reconnect_after_membership_loss().await;
                    break;
                }
            } else {
                membership_missing_since = None;
            }

            // 1. Restart the delayed leave (MSC4140 only)
            if let Some(ref did) = current_delay_id {
                match restart_delayed_event(&st.http_client, &homeserver, &access_token, did).await
                {
                    Ok(true) => {
                        // Normal heartbeat success — nothing else to do
                    }
                    Ok(false) => {
                        // 404: the delayed event was already fired (computer slept, network
                        // outage exceeded the timeout, etc.). Re-register and/or re-PUT.
                        log::warn!(
                            "Delayed leave was fired while we were away — recovering session"
                        );
                        match recover_session(c, &st.http_client, &room_id, &st).await {
                            Ok(Some(new_delay_id)) => {
                                log::info!("Session recovered: new delay_id={}", new_delay_id);
                                current_delay_id = Some(new_delay_id.clone());
                                last_membership_refresh = tokio::time::Instant::now();
                                membership_missing_since = None;
                                if let Ok(mut g) = st.delayed_leave_id.lock() {
                                    *g = Some(new_delay_id);
                                }
                            }
                            Ok(None) => {
                                log::info!(
                                    "Session recovered without MSC4140 delayed leave (membership only)"
                                );
                                current_delay_id = None;
                                last_membership_refresh = tokio::time::Instant::now();
                                membership_missing_since = None;
                                if let Ok(mut g) = st.delayed_leave_id.lock() {
                                    *g = None;
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
            }

            let delayed_leave = current_delay_id.is_some();
            let (refresh_secs, expires_ms) = if delayed_leave {
                (
                    MEMBERSHIP_REFRESH_INTERVAL_SECS,
                    VOICE_CALL_MEMBER_EXPIRES_MS,
                )
            } else {
                (
                    FALLBACK_MEMBERSHIP_REFRESH_SECS,
                    FALLBACK_MEMBERSHIP_EXPIRES_MS,
                )
            };
            let elapsed = last_membership_refresh.elapsed();
            if reconnected
                || membership_missing_since.is_some()
                || elapsed >= Duration::from_secs(refresh_secs)
            {
                log::info!("Refreshing m.call.member to extend expiry window");
                match livekit_jwt_service_url_for_refresh(c, &st.http_client, &room_id, &st).await {
                    Ok(url) => {
                        match matrix_voice_put_call_member(
                            c,
                            &room_id,
                            &url,
                            expires_ms,
                        )
                        .await
                        {
                            Ok(_) => {
                                log::info!("m.call.member refreshed successfully");
                                last_membership_refresh = tokio::time::Instant::now();
                                membership_missing_since = None;
                            }
                            Err(e) => {
                                log::warn!("m.call.member refresh failed: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("m.call.member refresh: no JWT service URL: {}", e);
                    }
                }
            }
        }
    });
    if let Ok(mut g) = state.heartbeat_task.lock() {
        *g = Some(handle);
    }
}

/// Re-register a delayed leave + re-PUT `m.call.member` after the server fired
/// the previous delayed leave (e.g. sleep). Returns `None` for delay_id if the
/// server no longer supports MSC4140.
async fn recover_session(
    client: &Client,
    http: &reqwest::Client,
    room_id: &str,
    app: &AppState,
) -> Result<Option<String>, String> {
    match send_delayed_leave_event(client, http, room_id).await {
        Ok(new_delay_id) => {
            let jwt_url = livekit_jwt_service_url_for_refresh(client, http, room_id, app).await?;
            matrix_voice_put_call_member(
                client,
                room_id,
                &jwt_url,
                VOICE_CALL_MEMBER_EXPIRES_MS,
            )
            .await?;
            Ok(Some(new_delay_id))
        }
        Err(DelayedLeaveError::Unsupported) => {
            log::warn!("MSC4140 unsupported during session recovery — re-PUT call.member only");
            app.msc4140_supported.store(false, Ordering::SeqCst);
            let jwt_url = livekit_jwt_service_url_for_refresh(client, http, room_id, app).await?;
            matrix_voice_put_call_member(
                client,
                room_id,
                &jwt_url,
                FALLBACK_MEMBERSHIP_EXPIRES_MS,
            )
            .await?;
            Ok(None)
        }
        Err(DelayedLeaveError::Other(e)) => Err(e),
    }
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
    let token_data = jsonwebtoken::decode::<serde_json::Value>(jwt, &key, &validation).ok()?;
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
pub async fn voice_device_id(
    state: State<'_, Arc<AppState>>,
    user_id: String,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    if !client.user_id().is_some_and(|id| id.as_str() == user_id) {
        return Err("The voice account changed".into());
    }
    client
        .device_id()
        .map(ToString::to_string)
        .ok_or("No device ID".into())
}

#[tauri::command]
pub async fn voice_find_previous_room(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    use futures_util::{stream, StreamExt};
    use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;

    let client = super::get_client(&state).await?;
    let key = call_member_key(&client)?;
    let now = voice_presence::now_ms();
    let rooms = client.joined_rooms().into_iter().filter(|room| {
        !room.is_tombstoned()
            && room
                .room_type()
                .is_some_and(|kind| kind.as_str() == crate::voice_presence::VOICE_ROOM_TYPE)
    });
    let reads = stream::iter(rooms)
        .map(|room| {
            let key = &key;
            async move {
                let Ok(Some(RawAnySyncOrStrippedState::Sync(raw))) =
                    room.get_state_event(CALL_MEMBER_EVENT.into(), key).await
                else {
                    return None;
                };
                let event: serde_json::Value = raw.deserialize_as().ok()?;
                if event.get("sender")?.as_str()? != room.own_user_id().as_str() {
                    return None;
                }
                voice_presence::active_membership(&event, now)?;
                Some((
                    event.get("origin_server_ts")?.as_u64()?,
                    room.room_id().to_string(),
                ))
            }
        })
        .buffer_unordered(8)
        .filter_map(std::future::ready);
    let latest = tokio::time::timeout(
        Duration::from_secs(2),
        reads.fold(None, |latest, candidate| {
            std::future::ready(Some(match latest {
                Some(previous) => std::cmp::max(previous, candidate),
                None => candidate,
            }))
        }),
    )
    .await
    .map_err(|_| "Voice membership lookup timed out")?;
    Ok(latest.map(|(_, room_id)| room_id))
}

#[tauri::command]
pub async fn voice_connect(
    state: State<'_, Arc<AppState>>,
    voice_mgr: State<'_, voice::VoiceManager>,
    app_handle: tauri::AppHandle,
    room_id: String,
    attempt_id: String,
    input_device_id: Option<String>,
    output_device_id: Option<String>,
    replace_other_sessions: Option<bool>,
    require_session_replacement: Option<bool>,
) -> Result<matrix_sdk::ruma::OwnedEventId, String> {
    log::debug!("voice_connect called for room {}", room_id);
    let state_arc: Arc<AppState> = (*state).clone();
    let presence_session = state_arc.voice_presence.session();
    let mut voice_room = state_arc.voice_room.lock().await;
    let client = super::get_client(&state).await?;
    let parsed_room = matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room)
        .filter(|room| room.state() == RoomState::Joined && !room.is_tombstoned())
        .ok_or("You no longer have access to this voice call")?;
    let levels = room.power_levels().await.map_err(|e| e.to_string())?;
    if !levels.user_can_send_state(room.own_user_id(), super::call_policy::RTC_MEMBER.into()) {
        return Err("Your role cannot join the voice session in this room.".into());
    }
    state_arc.stop_heartbeat_loop();
    if let Ok(mut g) = state_arc.voice_livekit_jwt_service_url.lock() {
        *g = None;
    }
    state_arc.msc4140_supported.store(true, Ordering::SeqCst);
    let http_client = state.http_client.clone();
    let previous_delay = state_arc
        .delayed_leave_id
        .lock()
        .ok()
        .and_then(|mut id| id.take());
    let mut reused_delay = None;
    if let Some(previous_room) = voice_room.take() {
        voice_mgr.disconnect().await;
        if previous_room == room_id {
            if let (Some(id), Some(token)) = (previous_delay, client.access_token()) {
                if restart_delayed_event(&http_client, client.homeserver().as_str(), &token, &id)
                    .await
                    .unwrap_or(false)
                {
                    reused_delay = Some(id);
                }
            }
        } else {
            let _ = send_or_fallback_leave(
                &client,
                &http_client,
                &previous_room,
                previous_delay.as_deref(),
            )
            .await;
        }
    }

    // ── Join: delayed leave (MSC4140) when supported, else expires + refresh only ──
    let delay_id_opt = match reused_delay {
        Some(id) => Ok(id),
        None => send_delayed_leave_event(&client, &http_client, &room_id).await,
    };
    let delay_id_opt = match delay_id_opt {
        Ok(id) => {
            log::info!("Delayed leave registered: delay_id={}", id);
            Some(id)
        }
        Err(DelayedLeaveError::Unsupported) => {
            log::warn!(
                "Homeserver does not support MSC4140 delayed leave — using m.call.member \
                 expires + periodic refresh (ghost cleanup may take up to the expiry window \
                 if the client crashes)"
            );
            state_arc.msc4140_supported.store(false, Ordering::SeqCst);
            None
        }
        Err(DelayedLeaveError::Other(e)) => return Err(e),
    };

    // Discover + validate `/sfu/get`, PUT `m.call.member` with the working JWT service URL
    let expires_ms = if delay_id_opt.is_some() {
        VOICE_CALL_MEMBER_EXPIRES_MS
    } else {
        FALLBACK_MEMBERSHIP_EXPIRES_MS
    };
    let (result, jwt_service_url, membership) =
        match matrix_voice_join(&client, &http_client, &room_id, expires_ms).await {
            Ok(result) => result,
            Err(error) => {
                let _ = send_or_fallback_leave(
                    &client,
                    &http_client,
                    &room_id,
                    delay_id_opt.as_deref(),
                )
                .await;
                return Err(error);
            }
        };
    // A normal join can proceed without replacement. An explicit handoff needs
    // the service to acknowledge replacement before we connect this device.
    let handoff = require_session_replacement.unwrap_or(false);
    if handoff || replace_other_sessions.unwrap_or(true) {
        let replacement = tokio::time::timeout(
            Duration::from_secs(6),
            presence_session.run(
                presence_session.voice_api.replace_own_sessions(&client, &jwt_service_url),
            ),
        ).await;
        let error = match replacement {
            Ok(Ok(false)) if handoff => Some("This voice service does not support moving the call".into()),
            Ok(Ok(_)) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("The voice service timed out".into()),
        };
        if let Some(error) = error {
            if handoff {
                let _ = send_or_fallback_leave(&client, &http_client, &room_id, delay_id_opt.as_deref()).await;
                return Err(format!("Could not confirm the move to this device. {error}"));
            }
            log::warn!("Optional voice session replacement: {error}");
        }
    }
    let identity = client.user_id().ok_or("No user ID")?.to_string();

    // Connect to LiveKit after the homeserver accepts this device's membership.
    let app_handle_for_emit = app_handle.clone();
    let connect_result = voice_mgr
        .connect(
            room_id.clone(),
            attempt_id,
            result.livekit_url,
            result.jwt,
            identity,
            app_handle,
            input_device_id,
            output_device_id,
        )
        .await;
    if let Err(error) = connect_result {
        let _ =
            send_or_fallback_leave(&client, &http_client, &room_id, delay_id_opt.as_deref()).await;
        return Err(error);
    }

    *voice_room = Some(room_id.clone());
    if let Ok(mut g) = state_arc.delayed_leave_id.lock() {
        *g = delay_id_opt.clone();
    }
    if let Ok(mut g) = state_arc.voice_livekit_jwt_service_url.lock() {
        *g = Some(jwt_service_url);
    }

    // 5. Start heartbeat (restarts the delayed leave every 15s, refreshes membership before expiry).
    //    Started after connect so we can pass the reconnect_notify from the VoiceSession —
    //    on LiveKit reconnection it triggers an immediate call.member refresh instead of
    //    waiting up to 15s for the next tick. Safe timing: delayed leave timeout is 60s,
    //    connect takes ~1-2s, and the heartbeat's first tick fires at 15s.
    let membership_heartbeat = voice_mgr
        .membership_heartbeat()
        .expect("voice session missing right after connect");
    start_heartbeat_loop(
        state_arc.clone(),
        delay_id_opt,
        room_id.clone(),
        membership_heartbeat,
    );

    // The shared store refreshes this room; sync supplies the authoritative
    // membership echo. No delayed task can publish a stale full-room scan.
    if presence_session.is_active() {
        let _ = app_handle_for_emit.emit(
            "voice-participants-invalidated",
            crate::types::VoiceParticipantsInvalidatedPayload {
                room_ids: vec![room_id],
            },
        );
    }

    Ok(membership)
}

#[tauri::command]
pub async fn voice_disconnect(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    voice_mgr: State<'_, voice::VoiceManager>,
    room_id: String,
) -> Result<(), String> {
    disconnect_from_room(&app_handle, &state, &voice_mgr, room_id).await
}

pub(crate) async fn disconnect_from_room(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    voice_mgr: &voice::VoiceManager,
    room_id: String,
) -> Result<(), String> {
    let mut voice_room = state.voice_room.lock().await;
    let mut delay_id = None;
    if voice_room.as_deref() == Some(room_id.as_str()) {
        state.stop_heartbeat_loop();
        if let Ok(mut g) = state.voice_livekit_jwt_service_url.lock() {
            *g = None;
        }
        delay_id = state
            .delayed_leave_id
            .lock()
            .ok()
            .and_then(|mut id| id.take());
        voice_mgr.disconnect().await;
        *voice_room = None;
    }
    let presence_session = state.voice_presence.session();
    let result = if let Ok(client) = super::get_client(state).await {
        send_or_fallback_leave(&client, &state.http_client, &room_id, delay_id.as_deref()).await
    } else {
        Ok(())
    };
    if presence_session.is_active() {
        let _ = app_handle.emit(
            "voice-participants-invalidated",
            crate::types::VoiceParticipantsInvalidatedPayload {
                room_ids: vec![room_id],
            },
        );
    }

    result
}

#[tauri::command]
pub async fn voice_toggle_mic(voice_mgr: State<'_, voice::VoiceManager>) -> Result<bool, String> {
    voice_mgr.toggle_mic()
}

#[tauri::command]
pub async fn voice_toggle_deafen(
    voice_mgr: State<'_, voice::VoiceManager>,
) -> Result<bool, String> {
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
    window_handle: Option<String>,
) -> Result<(), String> {
    log::info!(
        "voice_start_screen_share: mode={} window_title={:?} window_handle={:?}",
        mode,
        window_title,
        window_handle
    );
    let screen_mode = match mode.as_str() {
        "window" => screen::ScreenShareMode::Window,
        _ => screen::ScreenShareMode::Screen,
    };
    voice_mgr
        .start_screen_share(screen_mode, window_title, window_handle, &app)
        .await
}

#[tauri::command]
pub async fn enumerate_screen_share_windows() -> Result<Vec<screen::ScreenShareWindowOption>, String>
{
    tokio::task::spawn_blocking(screen::enumerate_screen_share_windows)
        .await
        .map_err(|e| format!("Window picker task failed: {}", e))?
}

#[tauri::command]
pub fn get_low_bandwidth_mode() -> bool {
    screen::is_low_bandwidth_mode()
}

#[tauri::command]
pub fn set_low_bandwidth_mode(enabled: bool) {
    screen::set_low_bandwidth_mode(enabled);
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
    state: State<'_, Arc<AppState>>,
    identity: String,
    volume: f32,
    source: String,
) -> Result<(), String> {
    voice_mgr.set_participant_volume(&identity, volume, &source);
    if source == "microphone" {
        state.matrix_voip.set_peer_volume(&identity, volume).await;
    }
    Ok(())
}

#[tauri::command]
pub fn voice_list_audio_devices() -> Result<voice::AudioDeviceList, String> {
    voice::list_audio_devices()
}

/// Reads the optional service advertised by this account's homeserver.
#[tauri::command]
pub async fn get_livekit_voice_room_snapshot(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<LivekitVoiceParticipantInfo>, String> {
    let session = state.voice_presence.session();
    session.run(async {
        let _guard = session.livekit_read.lock().await;
        let client = super::get_client(&state).await?;
        let mut snapshot = session.voice_api.snapshots(&client, vec![room_id.clone()]).await?;
        snapshot.participants_by_room.remove(&room_id)
            .ok_or_else(|| "LiveKit snapshot unavailable".into())
    }).await
}

#[tauri::command]
pub async fn get_all_livekit_voice_snapshots(
    state: State<'_, Arc<AppState>>,
    room_ids: Vec<String>,
) -> Result<LivekitVoiceSnapshot, String> {
    let session = state.voice_presence.session();
    session.run(async {
        let _guard = session.livekit_read.lock().await;
        let client = super::get_client(&state).await?;
        session.voice_api.snapshots(&client, room_ids).await
    }).await
}

#[cfg(test)]
mod voice_membership_cleanup_tests {
    use super::{body_indicates_msc4140_unsupported, delayed_leave_id, own_device_membership, DelayedLeaveError};

    #[tokio::test]
    async fn expired_membership_request_refreshes_and_retries_on_the_same_device() {
        use crate::commands::{
            auth::SavedSession,
            pax_auth::tests::{client, Server, TestDir, USER},
        };
        use serde_json::json;

        let server = Server::start().await;
        let directory = TestDir::new();
        let room = "!test:example.org";
        let endpoint = format!(
            "/_matrix/client/v3/rooms/{room}/state/{}/_{USER}_TEST_m.call",
            super::CALL_MEMBER_EVENT
        );
        {
            let mut mock = server.state.lock().unwrap();
            mock.joined_test_room = true;
            mock.expired_request_token = Some((endpoint.clone(), "expired".into()));
            mock.route_overrides.insert(
                ("POST".into(), "/_matrix/client/v3/refresh".into()),
                (200, json!({"access_token":"renewed", "refresh_token":"next"})),
            );
            mock.route_overrides.insert(
                ("PUT".into(), endpoint.clone()),
                (200, json!({"event_id":"$membership"})),
            );
        }
        let sdk = client(
            &server.home,
            &directory.0.join("store"),
            SavedSession {
                user_id: USER.into(),
                device_id: "TEST".into(),
                access_token: "expired".into(),
                refresh_token: Some("refresh".into()),
            },
        ).await;
        let event = super::matrix_voice_put_call_member(
            &sdk, room, "https://rtc.example.org", super::FALLBACK_MEMBERSHIP_EXPIRES_MS,
        ).await.unwrap();
        assert_eq!(event.as_str(), "$membership");
        let mock = server.state.lock().unwrap();
        let writes: Vec<_> = mock.requests.iter()
            .filter(|(_, path, _)| path == &endpoint)
            .collect();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[0].2, writes[1].2);
        assert_eq!(writes[1].2["device_id"], "TEST");
    }

    #[test]
    fn ordinary_state_writes_allow_join_without_delayed_events() {
        use serde_json::json;
        assert_eq!(delayed_leave_id(&json!({"delay_id":"timer"})).unwrap(), "timer");
        assert!(matches!(delayed_leave_id(&json!({"event_id":"$leave"})), Err(DelayedLeaveError::Unsupported)));
        assert!(matches!(delayed_leave_id(&json!({})), Err(DelayedLeaveError::Other(_))));
        assert!(body_indicates_msc4140_unsupported(r#"{"errcode":"M_UNRECOGNIZED"}"#));
        assert!(!body_indicates_msc4140_unsupported(r#"{"errcode":"M_FORBIDDEN"}"#));
    }

    #[test]
    fn a_replaced_device_can_only_clear_its_own_membership() {
        assert!(own_device_membership("@alice:s", "_@alice:s_PHONE_m.call", "@alice:s", "PHONE"));
        assert!(!own_device_membership("@alice:s", "_@alice:s_DESKTOP_m.call", "@alice:s", "PHONE"));
        assert!(!own_device_membership("@bob:s", "_@alice:s_PHONE_m.call", "@alice:s", "PHONE"));
        assert!(!own_device_membership("@alice:s", "@alice:s", "@alice:s", "PHONE"));
    }
}

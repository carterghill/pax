//! Optional, discovered Pax voice APIs. The login token stays in Rust and is
//! sent only to a verified API on the account homeserver's HTTPS origin.

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use futures_util::{stream, StreamExt};
use matrix_sdk::{ruma::events::StateEventType, Client, Room};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{
    types::{LivekitVoiceParticipantInfo, RemoteVoiceJoin},
    voice_presence::{self, LivekitVoiceSnapshot},
};

const NAMESPACE: &str = "ca.brandxtech.pax.voice";
const UNSUPPORTED_RETRY_MS: u64 = 60_000;
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug)]
struct VoiceApi {
    base_url: Url,
    backend: Url,
    local_backends: Vec<Url>,
    snapshots: bool,
    max_rooms: usize,
    replace_sessions: bool,
}

struct CachedDiscovery {
    homeserver: Url,
    api: Option<VoiceApi>,
    expires: Instant,
}

pub(crate) struct VoiceApiClient {
    http: reqwest::Client,
    discovery: Mutex<Option<CachedDiscovery>>,
}

impl Default for VoiceApiClient {
    fn default() -> Self {
        Self {
            // In particular, never forward a bearer token through a redirect.
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()
                .expect("Failed to initialize the voice service HTTP client"),
            discovery: Mutex::new(None),
        }
    }
}

fn https_base(value: &str) -> Option<Url> {
    let mut url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Some(url)
}

fn advertised_base(homeserver: &Url, document: &Value) -> Option<Url> {
    let entry = document.get(NAMESPACE)?;
    if entry.get("api_version")?.as_u64()? != 1 {
        return None;
    }
    let base = https_base(entry.get("base_url")?.as_str()?)?;
    (base.origin() == homeserver.origin()).then_some(base)
}

fn validate_capabilities(
    homeserver: &Url,
    base: Url,
    well_known: &Value,
    caps: &Value,
) -> Option<VoiceApi> {
    if caps.get("namespace")?.as_str()? != NAMESPACE
        || caps.get("api_version")?.as_u64()? != 1
        || https_base(caps.get("base_url")?.as_str()?)? != base
        || caps.get("account_scope")?.as_str()? != "local_homeserver"
    {
        return None;
    }
    let auth = caps.get("authentication")?;
    if auth.get("type")?.as_str()? != "matrix_access_token"
        || auth.get("same_origin_required")?.as_bool()? != true
        || https_base(auth.get("homeserver_url")?.as_str()?)? != *homeserver
    {
        return None;
    }
    let backend = https_base(caps.get("livekit_service_url")?.as_str()?)?;
    let features = caps.get("features")?;
    let snapshots = features.get("participant_snapshots");
    let max_rooms = snapshots
        .and_then(|value| value.get("max_rooms"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(32) as usize;
    let snapshots = snapshots
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
        && max_rooms > 0;
    let replacement = features.get("replace_own_sessions");
    let replace_sessions = replacement.is_some_and(|value| {
        value.get("enabled").and_then(Value::as_bool) == Some(true)
            && value.get("identity_format").and_then(Value::as_str)
                == Some("matrix_user_id:device_id")
            && value
                .get("registered_devices_only")
                .and_then(Value::as_bool)
                == Some(true)
    });
    let local_backends = well_known
        .get("org.matrix.msc4143.rtc_foci")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|focus| focus.get("type").and_then(Value::as_str) == Some("livekit"))
        .filter_map(|focus| {
            focus
                .get("livekit_service_url")
                .and_then(Value::as_str)
                .and_then(https_base)
        })
        .collect();
    Some(VoiceApi {
        base_url: base,
        backend,
        local_backends,
        snapshots,
        max_rooms,
        replace_sessions,
    })
}

async fn response_json(mut response: reqwest::Response) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_JSON_BYTES as u64)
    {
        return Err("Voice service response exceeds the size limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Unable to read voice service response")?
    {
        if bytes.len() + chunk.len() > MAX_JSON_BYTES {
            return Err("Voice service response exceeds the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid voice service response".into())
}

fn supported_room_backend(api: &VoiceApi, events: &[Value]) -> bool {
    let mut active_backends = Vec::new();
    let mut has_active_backend = false;
    for event in events {
        if voice_presence::active_membership(event, voice_presence::now_ms()).is_none() {
            continue;
        }
        let content = &event["content"];
        for focus in content
            .get("foci_preferred")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(raw) = focus.get("livekit_service_url").and_then(Value::as_str) {
                has_active_backend = true;
                if let Some(url) = https_base(raw) {
                    active_backends.push(url);
                }
            }
        }
        for membership in content
            .get("memberships")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let individual = json!({
                "origin_server_ts": event.get("origin_server_ts"),
                "content": {
                    "memberships": [membership],
                    "created_ts": content.get("created_ts"),
                    "expires": content.get("expires"),
                }
            });
            if voice_presence::active_membership(&individual, voice_presence::now_ms()).is_none() {
                continue;
            }
            for focus in membership
                .get("foci_active")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(raw) = focus.get("livekit_service_url").and_then(Value::as_str) {
                    has_active_backend = true;
                    if let Some(url) = https_base(raw) {
                        active_backends.push(url);
                    }
                }
            }
        }
    }
    if !has_active_backend {
        api.local_backends.contains(&api.backend)
    } else {
        active_backends.contains(&api.backend)
    }
}

async fn room_supported(api: &VoiceApi, room: &Room) -> Result<bool, String> {
    let mut values = Vec::new();
    for kind in ["m.call.member", "org.matrix.msc3401.call.member"] {
        let events = room
            .get_state_events(StateEventType::from(kind))
            .await
            .map_err(|_| "Unable to read the room's voice backend")?;
        for event in events {
            values.push(serde_json::to_value(event).map_err(|_| "Invalid voice room state")?);
        }
    }
    Ok(supported_room_backend(api, &values))
}

fn unavailable(room_ids: Vec<String>) -> LivekitVoiceSnapshot {
    LivekitVoiceSnapshot {
        available: false,
        unsupported_room_ids: room_ids,
        retry_after_ms: UNSUPPORTED_RETRY_MS,
        ..Default::default()
    }
}

#[derive(Deserialize)]
struct ServerSnapshot {
    available: bool,
    participants_by_room: HashMap<String, Vec<LivekitVoiceParticipantInfo>>,
    #[serde(default)]
    failed_room_ids: Vec<String>,
}

fn decode_snapshot(
    value: Value,
    requested: &[String],
) -> Result<HashMap<String, Vec<LivekitVoiceParticipantInfo>>, String> {
    let mut response: ServerSnapshot =
        serde_json::from_value(value).map_err(|_| "Invalid participant snapshot response")?;
    if !response.available {
        return Err("Participant snapshots are temporarily unavailable".into());
    }
    let failed: HashSet<_> = response.failed_room_ids.into_iter().collect();
    response.participants_by_room.retain(|room_id, rows| {
        requested.contains(room_id)
            && !failed.contains(room_id)
            && rows.iter().all(|row| !row.identity.is_empty())
    });
    Ok(response.participants_by_room)
}

fn remote_voice_join(
    identity: &str,
    user_id: &str,
    device_id: &str,
    replace_sessions: bool,
) -> Option<RemoteVoiceJoin> {
    let suffix = identity.strip_prefix(user_id)?;
    let (device, action) = if let Some(device) = suffix.strip_prefix('|') {
        // Older snapshot identities can identify a device, but the replacement
        // API only advertises support for user_id:device_id identities.
        (device, RemoteVoiceJoin::Join)
    } else {
        let device = suffix.strip_prefix(':')?;
        // A server port can look like a device suffix. Without the advertised
        // identity format, a bare MXID is insufficient to confirm a device.
        if device.contains(':')
            || device.contains('|')
            || (!replace_sessions && matrix_sdk::ruma::UserId::parse(identity).is_ok())
        {
            return None;
        }
        (device, if replace_sessions { RemoteVoiceJoin::Handoff } else { RemoteVoiceJoin::Join })
    };
    (!device.is_empty() && device != device_id).then_some(action)
}

impl VoiceApiClient {
    async fn discover(&self, homeserver: &Url) -> Result<Option<VoiceApi>, String> {
        let Some(homeserver) = https_base(homeserver.as_str()) else {
            return Ok(None);
        };
        let mut cache = self.discovery.lock().await;
        if let Some(cached) = cache
            .as_ref()
            .filter(|entry| entry.homeserver == homeserver && entry.expires > Instant::now())
        {
            return Ok(cached.api.clone());
        }
        let response = self
            .http
            .get(homeserver.join("/.well-known/matrix/client").unwrap())
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .map_err(|_| "Unable to discover optional voice capabilities")?;
        let api = if matches!(
            response.status(),
            StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED
        ) {
            None
        } else {
            if !response.status().is_success() {
                return Err("Voice discovery is temporarily unavailable".into());
            }
            let well_known = response_json(response).await?;
            if let Some(base) = advertised_base(&homeserver, &well_known) {
                let response = self
                    .http
                    .get(base.join("capabilities").unwrap())
                    .timeout(Duration::from_secs(4))
                    .send()
                    .await
                    .map_err(|_| "Unable to read optional voice capabilities")?;
                if matches!(
                    response.status(),
                    StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED
                ) {
                    None
                } else {
                    if !response.status().is_success() {
                        return Err("Voice capabilities are temporarily unavailable".into());
                    }
                    validate_capabilities(
                        &homeserver,
                        base,
                        &well_known,
                        &response_json(response).await?,
                    )
                }
            } else {
                None
            }
        };
        let ttl = if api.is_some() { 300 } else { 60 };
        *cache = Some(CachedDiscovery {
            homeserver,
            api: api.clone(),
            expires: Instant::now() + Duration::from_secs(ttl),
        });
        Ok(api)
    }

    async fn authenticated_request(
        &self,
        api: &VoiceApi,
        token: &str,
        operation: &str,
        body: Value,
    ) -> Result<Value, String> {
        let endpoint = api
            .base_url
            .join(operation)
            .map_err(|_| "Invalid voice service endpoint")?;
        let response = self
            .http
            .post(endpoint)
            .bearer_auth(token)
            .json(&body)
            .timeout(Duration::from_secs(22))
            .send()
            .await
            .map_err(|_| "Optional voice service request failed")?;
        let status = response.status();
        if matches!(status, StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED) {
            *self.discovery.lock().await = None;
        }
        if !status.is_success() {
            // No response body or reqwest debug output: neither tokens nor
            // service-provided error messages belong in frontend errors/logs.
            return Err(format!(
                "Optional voice service request failed (HTTP {})",
                status.as_u16()
            ));
        }
        response_json(response).await
    }

    pub(crate) async fn snapshots(
        &self,
        client: &Client,
        mut room_ids: Vec<String>,
    ) -> Result<LivekitVoiceSnapshot, String> {
        room_ids.sort();
        room_ids.dedup();
        if room_ids.len() > 256 {
            return Err("Too many voice rooms requested".into());
        }
        let Some(api) = self
            .discover(&client.homeserver())
            .await?
            .filter(|api| api.snapshots)
        else {
            return Ok(unavailable(room_ids));
        };
        let mut snapshot = LivekitVoiceSnapshot {
            available: true,
            retry_after_ms: UNSUPPORTED_RETRY_MS,
            ..Default::default()
        };
        let joined: HashMap<_, _> = client
            .joined_rooms()
            .into_iter()
            .map(|room| (room.room_id().to_string(), room))
            .collect();
        let api_ref = &api;
        let mut reads = stream::iter(room_ids.into_iter().map(|id| {
            let room = joined.get(&id).cloned();
            async move {
                let supported = match room {
                    Some(room) => room_supported(api_ref, &room).await,
                    None => Ok(false),
                };
                (id, supported)
            }
        }))
        .buffer_unordered(8);
        let mut supported = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(4), async {
            while let Some((id, result)) = reads.next().await {
                match result {
                    Ok(true) => supported.push(id),
                    Ok(false) => snapshot.unsupported_room_ids.push(id),
                    Err(_) => {} // Failed local state reads remain absent for retry.
                }
            }
        })
        .await;
        let token = client.access_token().ok_or("Not logged in")?;
        let chunks: Vec<_> = supported
            .chunks(api.max_rooms)
            .map(|chunk| chunk.to_vec())
            .collect();
        let mut requests = stream::iter(chunks.into_iter().map(|chunk| {
            let token = &token;
            async move {
                self.authenticated_request(
                    api_ref,
                    token,
                    "snapshots",
                    json!({ "room_ids": chunk }),
                )
                .await
                .and_then(|value| decode_snapshot(value, &chunk))
            }
        }))
        .buffer_unordered(2);
        // Keep completed batches when a slow service exceeds the overall budget.
        // Including cold discovery and local reads, this fits the session's 25s timeout.
        let _ = tokio::time::timeout(Duration::from_secs(12), async {
            while let Some(result) = requests.next().await {
                match result {
                    Ok(rooms) => snapshot.participants_by_room.extend(rooms),
                    Err(error) => log::debug!("{error}"),
                }
            }
        })
        .await;
        if let (Some(user), Some(device)) = (client.user_id(), client.device_id()) {
            for row in snapshot.participants_by_room.values_mut().flatten() {
                row.remote_join = remote_voice_join(
                    &row.identity, user.as_str(), device.as_str(), api.replace_sessions,
                );
            }
        }
        Ok(snapshot)
    }

    pub(crate) async fn replace_own_sessions(
        &self,
        client: &Client,
        backend: &str,
    ) -> Result<bool, String> {
        let Some(api) = self
            .discover(&client.homeserver())
            .await?
            .filter(|api| api.replace_sessions)
        else {
            return Ok(false);
        };
        if https_base(backend).as_ref() != Some(&api.backend) || client.device_id().is_none() {
            return Ok(false);
        }
        let token = client.access_token().ok_or("Not logged in")?;
        let response = self
            .authenticated_request(&api, &token, "replace-own-sessions", json!({}))
            .await?;
        let removed = response
            .get("removed_count")
            .and_then(Value::as_u64)
            .ok_or("Invalid session replacement response")?;
        let failed = response
            .get("failed_count")
            .and_then(Value::as_u64)
            .ok_or("Invalid session replacement response")?;
        if failed > 0 {
            return Err("Some other voice sessions could not be disconnected".into());
        }
        log::debug!("Voice service replaced {removed} other device sessions");
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_calls_distinguish_device_presence_from_replacement_support() {
        use RemoteVoiceJoin::{Handoff, Join};
        let user = "@alice:host:8448";
        for replace in [true, false] {
            let action = |identity| remote_voice_join(identity, user, "MAC", replace);
            assert_eq!(action("@alice:host:8448:PC"), Some(if replace { Handoff } else { Join }));
            assert_eq!(action("@alice:host:8448|PC"), Some(Join));
            for identity in [user, "@alice:host:8448:", "@alice:host:8448:MAC",
                "@alice:host:8448|MAC", "@alice:host:PC", "@bob:host:8448:PC"] {
                assert_eq!(action(identity), None);
            }
        }
        assert_eq!(remote_voice_join(user, "@alice:host", "MAC", false), None);
        assert_eq!(remote_voice_join("@alice:host:8448:PC", "@alice:host", "MAC", true), None);
    }

    fn fixture() -> (Url, Url, Value, Value) {
        let home = https_base("https://matrix.example.org").unwrap();
        let base = https_base("https://matrix.example.org/_pax/voice/v1").unwrap();
        let discovery = json!({
            NAMESPACE: {"api_version": 1, "base_url": base},
            "org.matrix.msc4143.rtc_foci": [{"type":"livekit", "livekit_service_url":"https://rtc.example.org"}]
        });
        let caps = json!({"namespace":NAMESPACE,"api_version":1,"base_url":base,
            "account_scope":"local_homeserver","livekit_service_url":"https://rtc.example.org",
            "authentication":{"type":"matrix_access_token","same_origin_required":true,"homeserver_url":home},
            "features":{"participant_snapshots":{"enabled":true,"max_rooms":32},
                "replace_own_sessions":{"enabled":true,"identity_format":"matrix_user_id:device_id","registered_devices_only":true}}});
        (home, base, discovery, caps)
    }

    #[test]
    fn requires_advertisement_and_rejects_cross_origin_or_credential_bearing_urls() {
        let (home, base, mut discovery, _) = fixture();
        assert_eq!(advertised_base(&home, &discovery), Some(base));
        assert!(advertised_base(&home, &json!({})).is_none());
        for unsafe_url in [
            "https://attacker.example/api",
            "http://matrix.example.org/api",
            "https://user:pass@matrix.example.org/api",
            "https://matrix.example.org/api?token=x",
            "https://matrix.example.org/api#fragment",
        ] {
            discovery[NAMESPACE]["base_url"] = json!(unsafe_url);
            assert!(advertised_base(&home, &discovery).is_none());
        }
    }

    #[test]
    fn validates_deployed_contract_and_independent_features() {
        let (home, base, discovery, mut caps) = fixture();
        let api = validate_capabilities(&home, base.clone(), &discovery, &caps).unwrap();
        assert!(api.snapshots && api.replace_sessions);
        assert_eq!(api.max_rooms, 32);
        let features = caps["features"].clone();
        for (snapshots, replacement) in [(true, false), (false, true), (false, false)] {
            caps["features"] = json!({});
            if snapshots {
                caps["features"]["participant_snapshots"] = features["participant_snapshots"].clone();
            }
            if replacement {
                caps["features"]["replace_own_sessions"] = features["replace_own_sessions"].clone();
            }
            let api = validate_capabilities(&home, base.clone(), &discovery, &caps).unwrap();
            assert_eq!((api.snapshots, api.replace_sessions), (snapshots, replacement));
        }
        caps["features"] = features;
        caps["features"]["replace_own_sessions"]["enabled"] = json!(false);
        let api = validate_capabilities(&home, base.clone(), &discovery, &caps).unwrap();
        assert!(api.snapshots && !api.replace_sessions);
        caps["authentication"]["homeserver_url"] = json!("https://other.example");
        assert!(validate_capabilities(&home, base, &discovery, &caps).is_none());
    }

    #[test]
    fn another_rooms_backend_does_not_disable_the_accounts_own_backend() {
        let (home, base, discovery, caps) = fixture();
        let api = validate_capabilities(&home, base, &discovery, &caps).unwrap();
        assert!(supported_room_backend(&api, &[]));
        let event = |url| json!({"content":{"application":"m.call","foci_preferred":[{"livekit_service_url":url}]}});
        assert!(!supported_room_backend(
            &api,
            &[event("https://remote.example")]
        ));
        assert!(!supported_room_backend(
            &api,
            &[event("http://remote.example")]
        ));
        assert!(supported_room_backend(
            &api,
            &[event("https://rtc.example.org/")]
        ));
        assert!(supported_room_backend(&api, &[]));
    }

    #[test]
    fn expired_legacy_foci_do_not_override_a_live_remote_backend() {
        let (home, base, discovery, caps) = fixture();
        let api = validate_capabilities(&home, base, &discovery, &caps).unwrap();
        let events = vec![json!({"origin_server_ts":1,"content":{"memberships":[
            {"created_ts":1,"expires":1,"foci_active":[{"livekit_service_url":"https://rtc.example.org"}]},
            {"foci_active":[{"livekit_service_url":"https://remote.example"}]}
        ]}})];
        assert!(!supported_room_backend(&api, &events));
        let inherited_expiry = vec![
            json!({"origin_server_ts":1,"content":{"expires":1,"memberships":[
                {"foci_active":[{"livekit_service_url":"https://rtc.example.org"}]},
                {"created_ts":voice_presence::now_ms(),"expires":60000,"foci_active":[{"livekit_service_url":"https://remote.example"}]}
            ]}}),
        ];
        assert!(!supported_room_backend(&api, &inherited_expiry));
    }

    #[test]
    fn nullable_flags_and_failed_rooms_are_not_reported_as_false_or_empty() {
        let result = decode_snapshot(json!({"available":true,
            "participants_by_room":{"!good:s":[{"identity":"@alice:s:D","is_muted":null,"is_deafened":true,"is_speaking":null}],"!bad:s":[],"!unrequested:s":[]},
            "failed_room_ids":["!bad:s"]}), &["!good:s".into(), "!bad:s".into()]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result["!good:s"][0].is_muted, None);
        assert_eq!(result["!good:s"][0].is_deafened, Some(true));
        assert_eq!(result["!good:s"][0].is_speaking, None);
    }

    #[tokio::test]
    #[ignore = "Opt-in read-only live check; requires private credential-file and room-ID environment variables"]
    async fn deployed_discovery_and_authenticated_snapshot() {
        let credentials_path = std::env::var("PAX_VOICE_SMOKE_CREDENTIALS")
            .expect("Set PAX_VOICE_SMOKE_CREDENTIALS to the saved credentials file path");
        let room = std::env::var("PAX_VOICE_SMOKE_ROOM")
            .expect("Set PAX_VOICE_SMOKE_ROOM to a joined Matrix room ID");
        let credentials: crate::commands::auth::SavedCredentials = serde_json::from_str(
            &std::fs::read_to_string(credentials_path).expect("Unable to read credentials file"),
        )
        .expect("Invalid credentials file");
        let session = credentials.session.expect("No saved login session");
        let client = VoiceApiClient::default();
        let home = Url::parse(&credentials.homeserver).expect("Invalid saved homeserver");
        let api = client
            .discover(&home)
            .await
            .expect("Discovery failed")
            .expect("Voice service is not advertised");
        assert!(api.snapshots);
        let response = client
            .authenticated_request(
                &api,
                &session.access_token,
                "snapshots",
                json!({"room_ids":[room]}),
            )
            .await
            .expect("Authenticated request failed");
        let rooms = decode_snapshot(response, std::slice::from_ref(&room))
            .expect("Invalid snapshot response");
        let rows = rooms.get(&room).expect("The requested room failed to read");
        println!(
            "Live discovery and authenticated snapshot succeeded: {} participant(s)",
            rows.len()
        );
    }
}

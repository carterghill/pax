use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::AppState;

use super::fmt_error_chain;
use super::room_discovery::{discover_federation_server_names, push_unique};

async fn federation_hints(
    http: &reqwest::Client,
    room_id: &str,
    via_servers: Option<Vec<String>>,
    resolve_via: Option<bool>,
) -> Vec<String> {
    let mut servers = via_servers.unwrap_or_default();
    if let Some((_, server)) = room_id.split_once(':') {
        push_unique(&mut servers, server.to_owned());
    }
    // A shared link supplies Matrix federation hints, not URLs for the app to fetch.
    // Pass those names to the user's homeserver so it can apply its federation rules.
    if resolve_via == Some(false) {
        return servers;
    }
    let mut resolved = Vec::new();
    for server in servers {
        for discovered in discover_federation_server_names(http, &server).await {
            push_unique(&mut resolved, discovered);
        }
    }
    resolved
}

#[tauri::command]
pub async fn join_room(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    room_id: String,
    via_servers: Option<Vec<String>>,
    resolve_via: Option<bool>,
) -> Result<String, String> {
    let ac = super::get_authed_client(&state).await?;
    let client = &ac.client;

    let room_or_alias = <&matrix_sdk::ruma::RoomOrAliasId>::try_from(room_id.as_str())
        .map_err(|e| format!("Invalid room ID or alias: {e}"))?;

    let server_names =
        federation_hints(&state.http_client, &room_id, via_servers, resolve_via).await;

    let via: Vec<matrix_sdk::ruma::OwnedServerName> = server_names
        .iter()
        .filter_map(|s| matrix_sdk::ruma::OwnedServerName::try_from(s.as_str()).ok())
        .collect();

    // Use the SDK join so `finish_join_room` registers the room in the in-memory client
    // immediately. A raw POST /join succeeds before sliding sync runs, so `get_room` would
    // miss and `get_messages` / `get_room_members` returned "Room not found" until sync caught up.
    //
    // Accepts `!roomid:server` or `#alias:server` (public directory often returns canonical_alias).
    let room = client
        .join_room_by_id_or_alias(room_or_alias, &via)
        .await
        .map_err(|e| format!("Failed to join room: {}", fmt_error_chain(&e)))?;

    let _guard = state.room_upgrade_operation.lock().await;
    let (latest, changed) =
        super::room_upgrades::follow_room_upgrades(&state.http_client, &ac, room, true).await;
    if changed {
        use tauri::Emitter;
        let _ = app.emit("rooms-changed", ());
    }
    Ok(latest.room_id().to_string())
}

#[tauri::command]
pub async fn leave_room(state: State<'_, Arc<AppState>>, room_id: String) -> Result<(), String> {
    let _guard = state.room_upgrade_operation.lock().await;
    let ac = super::get_authed_client(&state).await?;
    let (_, mut histories) = super::room_upgrades::joined_upgrade_links(&ac.client).await;
    if let Some(history) = histories.remove(&room_id) {
        for id in history {
            leave_single_room(&state.http_client, &ac, &id).await?;
        }
    }
    leave_single_room(&state.http_client, &ac, &room_id).await
}

pub(super) async fn leave_single_room(
    http: &reqwest::Client,
    ac: &super::AuthedClient,
    room_id: &str,
) -> Result<(), String> {
    let encoded_room = urlencoding::encode(room_id);
    let url = format!(
        "{}/_matrix/client/v3/rooms/{}/leave",
        ac.homeserver, encoded_room
    );
    let resp = http
        .post(&url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(&ac.access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Leave failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Leave failed ({status}): {text}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn knock_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    reason: Option<String>,
    via_servers: Option<Vec<String>>,
    resolve_via: Option<bool>,
) -> Result<String, String> {
    let ac = super::get_authed_client(&state).await?;

    let encoded = urlencoding::encode(&room_id);
    let mut url = format!("{}/_matrix/client/v3/knock/{}", ac.homeserver, encoded);

    let via_parts = federation_hints(&state.http_client, &room_id, via_servers, resolve_via).await;
    if !via_parts.is_empty() {
        let query: Vec<String> = via_parts
            .iter()
            .map(|s| format!("server_name={}", urlencoding::encode(s)))
            .collect();
        url = format!("{}?{}", url, query.join("&"));
    }

    let mut body = serde_json::json!({});
    if let Some(reason) = reason {
        body["reason"] = serde_json::json!(reason);
    }

    let resp = state
        .http_client
        .post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .bearer_auth(&ac.access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Knock failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Knock failed ({status}): {text}"));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse knock response: {e}"))?;

    Ok(result["room_id"].as_str().unwrap_or(&room_id).to_string())
}

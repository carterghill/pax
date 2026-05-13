use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::AppState;

use super::fmt_error_chain;
use super::room_discovery::{discover_federation_server_names, push_unique};

#[tauri::command]
pub async fn join_room(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    via_servers: Option<Vec<String>>,
) -> Result<String, String> {
    let client = super::get_client(&state).await?;

    let room_or_alias = <&matrix_sdk::ruma::RoomOrAliasId>::try_from(room_id.as_str())
        .map_err(|e| format!("Invalid room ID or alias: {e}"))?;

    // Federation hints (same discovery as the old raw HTTP join).
    let mut server_names = Vec::new();
    if let Some(via_servers) = via_servers.as_deref() {
        for via_server in via_servers {
            for discovered in discover_federation_server_names(&state.http_client, via_server).await
            {
                push_unique(&mut server_names, discovered);
            }
        }
    }
    if let Some((_, server_name)) = room_id.rsplit_once(':') {
        for discovered in discover_federation_server_names(&state.http_client, server_name).await {
            push_unique(&mut server_names, discovered);
        }
    }

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

    Ok(room.room_id().to_string())
}

#[tauri::command]
pub async fn leave_room(state: State<'_, Arc<AppState>>, room_id: String) -> Result<(), String> {
    let client = super::get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');
    let encoded_room = urlencoding::encode(&room_id);

    let url = format!("{}/_matrix/client/v3/rooms/{}/leave", hs, encoded_room);
    let resp = state
        .http_client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(access_token)
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
) -> Result<String, String> {
    let client = super::get_client(&state).await?;
    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs_trim = homeserver.trim_end_matches('/');

    let encoded = urlencoding::encode(&room_id);
    let mut url = format!("{}/_matrix/client/v3/knock/{}", hs_trim, encoded);

    // Add via servers as query params
    let mut via_parts = Vec::new();
    if let Some(servers) = via_servers.as_deref() {
        for server in servers {
            for discovered in discover_federation_server_names(&state.http_client, server).await {
                if !via_parts.contains(&discovered) {
                    via_parts.push(discovered);
                }
            }
        }
    }
    if let Some((_, server_name)) = room_id.rsplit_once(':') {
        for discovered in discover_federation_server_names(&state.http_client, server_name).await {
            if !via_parts.contains(&discovered) {
                via_parts.push(discovered);
            }
        }
    }
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
        .bearer_auth(access_token)
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

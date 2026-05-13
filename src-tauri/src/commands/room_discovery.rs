use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::Client;
use tauri::State;

use crate::types::ParentSpaceInfo;
use crate::AppState;

use super::room_settings::{http_get_room_state, mxc_to_discovered_thumbnail_url};
use super::{fmt_error_chain, get_or_fetch_avatar};

/// Search the public room directory for spaces.
///
/// Uses `POST /publicRooms` with `filter.room_types: ["m.space"]` to find
/// only spaces. Supports an optional search term and a `server` parameter
/// to browse a remote server's directory over federation.
pub(super) fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn parse_server_input_url(input: &str) -> Option<reqwest::Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(url) = reqwest::Url::parse(trimmed) {
        return Some(url);
    }

    reqwest::Url::parse(&format!("https://{trimmed}")).ok()
}

fn normalize_server_name(input: &str) -> Option<String> {
    let url = parse_server_input_url(input)?;
    let host = url.host_str()?.to_string();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

fn canonicalize_homeserver_base_url(input: &str) -> Option<String> {
    let mut url = parse_server_input_url(input)?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn discovery_hosts_for_server_input(input: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let Some(url) = parse_server_input_url(input) else {
        return hosts;
    };
    let Some(host) = url.host_str() else {
        return hosts;
    };

    push_unique(&mut hosts, host.to_string());
    if let Some(stripped) = host.strip_prefix("matrix.") {
        push_unique(&mut hosts, stripped.to_string());
    }

    hosts
}

async fn parse_public_rooms_response(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Public rooms query failed ({}): {}", status, text));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse public rooms response: {e}"))
}

fn public_room_matches_search(room_data: &serde_json::Value, search_term: Option<&str>) -> bool {
    let Some(term) = search_term else {
        return true;
    };

    [
        room_data["name"].as_str(),
        room_data["topic"].as_str(),
        room_data["canonical_alias"].as_str(),
        room_data["room_id"].as_str(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(term))
}

fn enrich_public_rooms_with_membership(
    client: &Client,
    mut result: serde_json::Value,
) -> serde_json::Value {
    let Some(chunk) = result["chunk"].as_array().cloned() else {
        return result;
    };

    let mut enriched = Vec::new();
    for room_data in &chunk {
        let mut entry = room_data.clone();
        let room_id = room_data["room_id"].as_str().unwrap_or("");
        let membership = if let Ok(rid) = matrix_sdk::ruma::RoomId::parse(room_id) {
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
        };
        entry["membership"] = serde_json::json!(membership);
        enriched.push(entry);
    }

    result["chunk"] = serde_json::json!(enriched);
    result
}

async fn normalize_public_room_avatar_urls(
    http_client: &reqwest::Client,
    mut result: serde_json::Value,
) -> serde_json::Value {
    let Some(chunk) = result["chunk"].as_array().cloned() else {
        return result;
    };

    let mut normalized = Vec::new();
    let mut media_base_url_cache = std::collections::HashMap::new();

    for room_data in chunk {
        let mut entry = room_data.clone();
        if let Some(mxc) = room_data["avatar_url"].as_str() {
            if let Some(url) =
                mxc_to_discovered_thumbnail_url(http_client, &mut media_base_url_cache, mxc, 64, 64)
                    .await
            {
                entry["avatar_url"] = serde_json::json!(url);
            }
        }
        normalized.push(entry);
    }

    result["chunk"] = serde_json::json!(normalized);
    result
}

pub(super) async fn discover_federation_server_names(
    http_client: &reqwest::Client,
    server_input: &str,
) -> Vec<String> {
    let mut federation_servers = Vec::new();

    let Some(url) = parse_server_input_url(server_input) else {
        return federation_servers;
    };
    let Some(host) = url.host_str() else {
        return federation_servers;
    };

    let stripped_host = host.strip_prefix("matrix.").map(str::to_string);

    if let Some(apex) = &stripped_host {
        let well_known_url = format!("https://{apex}/.well-known/matrix/server");
        match http_client
            .get(&well_known_url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(body) => {
                        push_unique(&mut federation_servers, apex.clone());
                        if let Some(advertised) = body["m.server"].as_str() {
                            push_unique(&mut federation_servers, advertised.to_string());
                        }
                    }
                    Err(e) => {
                        log::warn!("search_public_spaces: failed to parse {well_known_url}: {e}");
                    }
                }
            }
            Ok(resp) => {
                log::debug!(
                    "search_public_spaces: {} returned {}",
                    well_known_url,
                    resp.status()
                );
            }
            Err(e) => {
                log::debug!(
                    "search_public_spaces: failed to fetch {}: {}",
                    well_known_url,
                    fmt_error_chain(&e)
                );
            }
        }
    }

    let well_known_url = format!("https://{host}/.well-known/matrix/server");
    match http_client
        .get(&well_known_url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                if let Some(normalized) = normalize_server_name(server_input) {
                    push_unique(&mut federation_servers, normalized);
                }
                if let Some(advertised) = body["m.server"].as_str() {
                    push_unique(&mut federation_servers, advertised.to_string());
                }
            }
            Err(e) => {
                log::warn!("search_public_spaces: failed to parse {well_known_url}: {e}");
            }
        },
        Ok(resp) => {
            log::debug!(
                "search_public_spaces: {} returned {}",
                well_known_url,
                resp.status()
            );
        }
        Err(e) => {
            log::debug!(
                "search_public_spaces: failed to fetch {}: {}",
                well_known_url,
                fmt_error_chain(&e)
            );
        }
    }

    if let Some(normalized) = normalize_server_name(server_input) {
        push_unique(&mut federation_servers, normalized);
    }

    federation_servers
}

pub(super) async fn discover_client_base_urls(
    http_client: &reqwest::Client,
    server_input: &str,
) -> Vec<String> {
    let mut base_urls = Vec::new();

    for host in discovery_hosts_for_server_input(server_input) {
        let well_known_url = format!("https://{host}/.well-known/matrix/client");
        match http_client
            .get(&well_known_url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(body) => {
                        if let Some(base_url) = body["m.homeserver"]["base_url"].as_str() {
                            if let Some(normalized) = canonicalize_homeserver_base_url(base_url) {
                                push_unique(&mut base_urls, normalized);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("search_public_spaces: failed to parse {well_known_url}: {e}");
                    }
                }
            }
            Ok(resp) => {
                log::debug!(
                    "search_public_spaces: {} returned {}",
                    well_known_url,
                    resp.status()
                );
            }
            Err(e) => {
                log::debug!(
                    "search_public_spaces: failed to fetch {}: {}",
                    well_known_url,
                    fmt_error_chain(&e)
                );
            }
        }
    }

    if let Some(base_url) = canonicalize_homeserver_base_url(server_input) {
        push_unique(&mut base_urls, base_url);
    }

    base_urls
}

async fn search_public_spaces_direct_fallback(
    state: &AppState,
    base_urls: &[String],
    server_input: &str,
    search_term: Option<&str>,
    limit: u32,
) -> Result<serde_json::Value, String> {
    if base_urls.is_empty() {
        return Err(format!(
            "No direct homeserver URL could be discovered for {}",
            server_input
        ));
    }

    let normalized_search_term = search_term.map(|term| term.to_lowercase());
    let per_page = limit.max(50).min(100);
    let max_pages = if normalized_search_term.is_some() {
        5
    } else {
        2
    };
    let mut last_err: Option<String> = None;

    'base_urls: for base_url in base_urls {
        let mut matched_spaces = Vec::new();
        let mut next_batch: Option<String> = None;
        let mut saw_success = false;

        for _ in 0..max_pages {
            let mut url = format!(
                "{}/_matrix/client/v3/publicRooms?limit={}",
                base_url, per_page
            );
            if let Some(since) = &next_batch {
                url.push_str("&since=");
                url.push_str(&urlencoding::encode(since));
            }

            let resp = match state
                .http_client
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    let err = format!("Direct public rooms query failed: {}", fmt_error_chain(&e));
                    if saw_success {
                        log::warn!("search_public_spaces: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                let text = resp.text().await.unwrap_or_default();
                let err = format!(
                    "Remote homeserver does not allow unauthenticated direct /publicRooms lookup (401 Unauthorized): {}",
                    text
                );
                if saw_success {
                    log::warn!("search_public_spaces: {err}");
                    break;
                }
                last_err = Some(err);
                continue 'base_urls;
            }

            let body = match parse_public_rooms_response(resp).await {
                Ok(body) => body,
                Err(err) => {
                    if saw_success {
                        log::warn!("search_public_spaces: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            saw_success = true;

            if let Some(chunk) = body["chunk"].as_array() {
                for room_data in chunk {
                    if room_data["room_type"].as_str() != Some("m.space") {
                        continue;
                    }
                    if !public_room_matches_search(room_data, normalized_search_term.as_deref()) {
                        continue;
                    }
                    matched_spaces.push(room_data.clone());
                    if matched_spaces.len() >= limit as usize {
                        break;
                    }
                }
            }

            if matched_spaces.len() >= limit as usize {
                break;
            }

            next_batch = body["next_batch"].as_str().map(String::from);
            if next_batch.is_none() {
                break;
            }
        }

        if saw_success {
            return Ok(serde_json::json!({ "chunk": matched_spaces }));
        }
    }

    Err(last_err
        .unwrap_or_else(|| format!("Direct public rooms lookup failed for {}", server_input)))
}

/// Remove spaces from a `publicRooms` chunk so the directory lists chat/voice rooms only.
fn filter_public_chunk_exclude_spaces(mut result: serde_json::Value) -> serde_json::Value {
    let Some(chunk) = result["chunk"].as_array().cloned() else {
        return result;
    };
    let filtered: Vec<_> = chunk
        .into_iter()
        .filter(|r| r["room_type"].as_str() != Some("m.space"))
        .collect();
    result["chunk"] = serde_json::json!(filtered);
    result
}

async fn search_public_rooms_direct_fallback(
    state: &AppState,
    base_urls: &[String],
    server_input: &str,
    search_term: Option<&str>,
    limit: u32,
) -> Result<serde_json::Value, String> {
    if base_urls.is_empty() {
        return Err(format!(
            "No direct homeserver URL could be discovered for {}",
            server_input
        ));
    }

    let normalized_search_term = search_term.map(|term| term.to_lowercase());
    let per_page = limit.max(50).min(100);
    let max_pages = if normalized_search_term.is_some() {
        5
    } else {
        2
    };
    let mut last_err: Option<String> = None;

    'base_urls: for base_url in base_urls {
        let mut matched_rooms = Vec::new();
        let mut next_batch: Option<String> = None;
        let mut saw_success = false;

        for _ in 0..max_pages {
            let mut url = format!(
                "{}/_matrix/client/v3/publicRooms?limit={}",
                base_url, per_page
            );
            if let Some(since) = &next_batch {
                url.push_str("&since=");
                url.push_str(&urlencoding::encode(since));
            }

            let resp = match state
                .http_client
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    let err = format!("Direct public rooms query failed: {}", fmt_error_chain(&e));
                    if saw_success {
                        log::warn!("search_public_rooms: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                let text = resp.text().await.unwrap_or_default();
                let err = format!(
                    "Remote homeserver does not allow unauthenticated direct /publicRooms lookup (401 Unauthorized): {}",
                    text
                );
                if saw_success {
                    log::warn!("search_public_rooms: {err}");
                    break;
                }
                last_err = Some(err);
                continue 'base_urls;
            }

            let body = match parse_public_rooms_response(resp).await {
                Ok(body) => body,
                Err(err) => {
                    if saw_success {
                        log::warn!("search_public_rooms: {err}");
                        break;
                    }
                    last_err = Some(err);
                    continue 'base_urls;
                }
            };

            saw_success = true;

            if let Some(chunk) = body["chunk"].as_array() {
                for room_data in chunk {
                    if room_data["room_type"].as_str() == Some("m.space") {
                        continue;
                    }
                    if !public_room_matches_search(room_data, normalized_search_term.as_deref()) {
                        continue;
                    }
                    matched_rooms.push(room_data.clone());
                    if matched_rooms.len() >= limit as usize {
                        break;
                    }
                }
            }

            if matched_rooms.len() >= limit as usize {
                break;
            }

            next_batch = body["next_batch"].as_str().map(String::from);
            if next_batch.is_none() {
                break;
            }
        }

        if saw_success {
            return Ok(serde_json::json!({ "chunk": matched_rooms }));
        }
    }

    Err(last_err
        .unwrap_or_else(|| format!("Direct public rooms lookup failed for {}", server_input)))
}

#[tauri::command]
pub async fn search_public_spaces(
    state: State<'_, Arc<AppState>>,
    search_term: Option<String>,
    server: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let search_term = search_term
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty());
    let server = server
        .map(|server| server.trim().to_string())
        .filter(|server| !server.is_empty());

    let mut filter = serde_json::json!({
        "room_types": ["m.space"],
    });
    if let Some(term) = &search_term {
        filter["generic_search_term"] = serde_json::json!(term);
    }

    let body = serde_json::json!({
        "filter": filter,
        "limit": limit,
    });

    if let Some(server_input) = server.as_deref() {
        let federation_servers =
            discover_federation_server_names(&state.http_client, server_input).await;
        let direct_base_urls = discover_client_base_urls(&state.http_client, server_input).await;
        let mut last_federation_err: Option<String> = None;

        for federation_server in federation_servers {
            let url = format!(
                "{}/_matrix/client/v3/publicRooms?server={}",
                homeserver.trim_end_matches('/'),
                urlencoding::encode(&federation_server)
            );

            let result = match state
                .http_client
                .post(&url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(&access_token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) => parse_public_rooms_response(resp).await,
                Err(e) => Err(format!(
                    "Failed to search public spaces: {}",
                    super::fmt_error_chain(&e)
                )),
            };

            match result {
                Ok(result) => {
                    let result =
                        normalize_public_room_avatar_urls(&state.http_client, result).await;
                    return Ok(enrich_public_rooms_with_membership(&client, result));
                }
                Err(err) => {
                    log::warn!(
                        "search_public_spaces: federation lookup via '{}' failed: {}",
                        federation_server,
                        err
                    );
                    last_federation_err = Some(format!(
                        "Federated public rooms query failed via {}: {}",
                        federation_server, err
                    ));
                }
            }
        }

        let primary_err = last_federation_err.unwrap_or_else(|| {
            format!(
                "Failed to resolve a federation server name for {}",
                server_input
            )
        });

        match search_public_spaces_direct_fallback(
            &state,
            &direct_base_urls,
            server_input,
            search_term.as_deref(),
            limit,
        )
        .await
        {
            Ok(result) => {
                let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
                Ok(enrich_public_rooms_with_membership(&client, result))
            }
            Err(fallback_err) => Err(format!(
                "{} | Direct lookup fallback failed: {}",
                primary_err, fallback_err
            )),
        }
    } else {
        let url = format!(
            "{}/_matrix/client/v3/publicRooms",
            homeserver.trim_end_matches('/')
        );

        let result = match state
            .http_client
            .post(&url)
            .timeout(Duration::from_secs(15))
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => parse_public_rooms_response(resp).await,
            Err(e) => Err(format!(
                "Failed to search public spaces: {}",
                super::fmt_error_chain(&e)
            )),
        }?;

        let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
        Ok(enrich_public_rooms_with_membership(&client, result))
    }
}

/// Search the public room directory for non-space rooms (chat/voice).
///
/// Uses `POST /publicRooms` without `room_types`, then drops `m.space` entries.
#[tauri::command]
pub async fn search_public_rooms(
    state: State<'_, Arc<AppState>>,
    search_term: Option<String>,
    server: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let search_term = search_term
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty());
    let server = server
        .map(|server| server.trim().to_string())
        .filter(|server| !server.is_empty());

    let mut filter = serde_json::json!({});
    if let Some(term) = &search_term {
        filter["generic_search_term"] = serde_json::json!(term);
    }

    let body = serde_json::json!({
        "filter": filter,
        "limit": limit,
    });

    if let Some(server_input) = server.as_deref() {
        let federation_servers =
            discover_federation_server_names(&state.http_client, server_input).await;
        let direct_base_urls = discover_client_base_urls(&state.http_client, server_input).await;
        let mut last_federation_err: Option<String> = None;

        for federation_server in federation_servers {
            let url = format!(
                "{}/_matrix/client/v3/publicRooms?server={}",
                homeserver.trim_end_matches('/'),
                urlencoding::encode(&federation_server)
            );

            let result = match state
                .http_client
                .post(&url)
                .timeout(Duration::from_secs(15))
                .bearer_auth(&access_token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) => parse_public_rooms_response(resp).await,
                Err(e) => Err(format!(
                    "Failed to search public rooms: {}",
                    super::fmt_error_chain(&e)
                )),
            };

            match result {
                Ok(result) => {
                    let result =
                        normalize_public_room_avatar_urls(&state.http_client, result).await;
                    let result = filter_public_chunk_exclude_spaces(result);
                    return Ok(enrich_public_rooms_with_membership(&client, result));
                }
                Err(err) => {
                    log::warn!(
                        "search_public_rooms: federation lookup via '{}' failed: {}",
                        federation_server,
                        err
                    );
                    last_federation_err = Some(format!(
                        "Federated public rooms query failed via {}: {}",
                        federation_server, err
                    ));
                }
            }
        }

        let primary_err = last_federation_err.unwrap_or_else(|| {
            format!(
                "Failed to resolve a federation server name for {}",
                server_input
            )
        });

        match search_public_rooms_direct_fallback(
            &state,
            &direct_base_urls,
            server_input,
            search_term.as_deref(),
            limit,
        )
        .await
        {
            Ok(result) => {
                let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
                Ok(enrich_public_rooms_with_membership(&client, result))
            }
            Err(fallback_err) => Err(format!(
                "{} | Direct lookup fallback failed: {}",
                primary_err, fallback_err
            )),
        }
    } else {
        let url = format!(
            "{}/_matrix/client/v3/publicRooms",
            homeserver.trim_end_matches('/')
        );

        let result = match state
            .http_client
            .post(&url)
            .timeout(Duration::from_secs(15))
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => parse_public_rooms_response(resp).await,
            Err(e) => Err(format!(
                "Failed to search public rooms: {}",
                super::fmt_error_chain(&e)
            )),
        }?;

        let result = normalize_public_room_avatar_urls(&state.http_client, result).await;
        let result = filter_public_chunk_exclude_spaces(result);
        Ok(enrich_public_rooms_with_membership(&client, result))
    }
}

/// Resolve a room alias (e.g. `#my-space:example.com`) to its room ID.
///
/// Uses `GET /directory/room/{roomAlias}` which works across federation.
#[tauri::command]
pub async fn resolve_room_alias(
    state: State<'_, Arc<AppState>>,
    alias: String,
) -> Result<serde_json::Value, String> {
    let client = super::get_client(&state).await?;
    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let url = format!(
        "{}/_matrix/client/v3/directory/room/{}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(&alias),
    );

    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(10))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("Failed to resolve alias: {}", super::fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Alias not found ({}): {}", status, text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse alias response: {e}"))?;

    Ok(body)
}

// ─── Parent spaces discovery ───────────────────────────────────────────────────

#[tauri::command]
pub async fn get_room_parent_spaces(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<Vec<ParentSpaceInfo>, String> {
    let client = super::get_client(&state).await?;
    let parsed =
        matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| format!("Invalid room ID: {e}"))?;
    let _ = client.get_room(&parsed).ok_or("Room not found")?;

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;
    let hs = homeserver.trim_end_matches('/');

    // Fetch all room state and filter for m.space.parent events
    let state_url = format!(
        "{}/_matrix/client/v3/rooms/{}/state",
        hs,
        urlencoding::encode(&room_id),
    );
    let resp = state
        .http_client
        .get(&state_url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(access_token.to_string())
        .send()
        .await
        .map_err(|e| format!("State fetch failed: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("State fetch error ({}): {}", status, text));
    }

    let all_state: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("State parse error: {e}"))?;

    // Collect parent space IDs from m.space.parent events
    let parent_entries: Vec<(String, bool)> = all_state
        .iter()
        .filter(|ev| ev.get("type").and_then(|t| t.as_str()) == Some("m.space.parent"))
        .filter_map(|ev| {
            let space_id = ev.get("state_key")?.as_str()?.to_string();
            // Only include parents whose content is non-empty (not redacted)
            let content = ev.get("content")?;
            if content.as_object().map_or(true, |o| o.is_empty()) {
                return None;
            }
            let canonical = content
                .get("canonical")
                .and_then(|c| c.as_bool())
                .unwrap_or(false);
            Some((space_id, canonical))
        })
        .collect();

    if parent_entries.is_empty() {
        return Ok(Vec::new());
    }

    let avatar_cache = state.avatar_cache.clone();
    let mut results = Vec::new();
    let mut media_base_url_cache = std::collections::HashMap::new();

    for (space_id, canonical) in &parent_entries {
        // Check if user is already a member via the SDK
        let local_room = matrix_sdk::ruma::RoomId::parse(space_id.as_str())
            .ok()
            .and_then(|rid| client.get_room(&rid));

        if let Some(room) = &local_room {
            let membership = match room.state() {
                matrix_sdk::RoomState::Joined => "joined",
                matrix_sdk::RoomState::Invited => "invited",
                _ => "none",
            };

            let name = room.name().unwrap_or_else(|| space_id.clone());
            let topic = room.topic();
            let avatar_url = get_or_fetch_avatar(
                room.avatar_url().as_deref(),
                room.avatar(matrix_sdk::media::MediaFormat::File),
                &avatar_cache,
            )
            .await;

            // Member count: expensive to query all members for spaces we've
            // already joined; the UI hides the count badge when 0 so this is fine.
            let joined_count = 0u64;

            // Try to get join_rule from state
            let join_rule = http_get_room_state(
                &state.http_client,
                hs,
                &access_token,
                space_id,
                "m.room.join_rules/",
            )
            .await
            .ok()
            .flatten()
            .and_then(|b| {
                b.get("join_rule")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });

            results.push(ParentSpaceInfo {
                id: space_id.clone(),
                name,
                topic,
                avatar_url,
                membership: membership.to_string(),
                join_rule,
                num_joined_members: joined_count,
                canonical: *canonical,
            });
        } else {
            // Not joined — try the hierarchy API to peek at the space
            let hierarchy_url = format!(
                "{}/_matrix/client/v1/rooms/{}/hierarchy?limit=1",
                hs,
                urlencoding::encode(space_id),
            );
            let hierarchy_resp = state
                .http_client
                .get(&hierarchy_url)
                .timeout(Duration::from_secs(10))
                .bearer_auth(access_token.to_string())
                .send()
                .await;

            match hierarchy_resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(body) = r.json::<serde_json::Value>().await {
                        // The first entry in "rooms" is always the queried room/space itself
                        let space_data = body["rooms"].as_array().and_then(|arr| arr.first());

                        if let Some(sd) = space_data {
                            let name = sd["name"].as_str().unwrap_or("Unnamed").to_string();
                            let topic = sd["topic"]
                                .as_str()
                                .filter(|t| !t.is_empty())
                                .map(|t| t.to_string());
                            let join_rule = sd["join_rule"].as_str().map(|s| s.to_string());
                            let num_joined = sd["num_joined_members"].as_u64().unwrap_or(0);

                            let avatar_url = match sd["avatar_url"].as_str() {
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
                            };

                            results.push(ParentSpaceInfo {
                                id: space_id.clone(),
                                name,
                                topic,
                                avatar_url,
                                membership: "none".to_string(),
                                join_rule,
                                num_joined_members: num_joined,
                                canonical: *canonical,
                            });
                            continue;
                        }
                    }
                }
                _ => {}
            }

            // Fallback: hierarchy API failed (private space, forbidden, etc.)
            results.push(ParentSpaceInfo {
                id: space_id.clone(),
                name: space_id.clone(),
                topic: None,
                avatar_url: None,
                membership: "none".to_string(),
                join_rule: None,
                num_joined_members: 0,
                canonical: *canonical,
            });
        }
    }

    // Sort: canonical parents first, then by name
    results.sort_by(|a, b| {
        b.canonical
            .cmp(&a.canonical)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_homeserver_base_url, discover_federation_server_names,
        discovery_hosts_for_server_input, normalize_server_name, public_room_matches_search,
    };

    #[test]
    fn normalizes_server_name_from_plain_host_or_url() {
        assert_eq!(
            normalize_server_name("matrix.tchncs.de"),
            Some("matrix.tchncs.de".to_string())
        );
        assert_eq!(
            normalize_server_name("https://matrix.4d2.org/"),
            Some("matrix.4d2.org".to_string())
        );
        assert_eq!(
            normalize_server_name("https://matrix.grin.hu:8448/foo"),
            Some("matrix.grin.hu:8448".to_string())
        );
    }

    #[test]
    fn preserves_homeserver_base_url_path_when_present() {
        assert_eq!(
            canonicalize_homeserver_base_url("https://example.com/matrix/"),
            Some("https://example.com/matrix".to_string())
        );
    }

    #[test]
    fn includes_apex_domain_for_matrix_subdomains() {
        assert_eq!(
            discovery_hosts_for_server_input("matrix.tchncs.de"),
            vec!["matrix.tchncs.de".to_string(), "tchncs.de".to_string()]
        );
    }

    #[test]
    fn matches_search_against_space_metadata() {
        let room = serde_json::json!({
            "name": "Privacy Guides",
            "topic": "Security and privacy discussions",
            "canonical_alias": "#privacy:privacyguides.org",
            "room_id": "!abc:privacyguides.org",
        });

        assert!(public_room_matches_search(&room, Some("privacy")));
        assert!(public_room_matches_search(&room, Some("security")));
        assert!(public_room_matches_search(&room, Some("!abc")));
        assert!(!public_room_matches_search(&room, Some("matrix.org")));
    }

    #[tokio::test]
    async fn prefers_apex_federation_server_name_for_matrix_subdomains() {
        let client = reqwest::Client::new();
        let candidates = discover_federation_server_names(&client, "matrix.tchncs.de").await;

        assert!(!candidates.is_empty());
        assert_eq!(candidates[0], "matrix.tchncs.de".to_string());
    }

    #[test]
    fn extracts_server_name_from_matrix_identifiers_with_rsplit_once() {
        assert_eq!(
            "!MfAmcoFvXtYUOhFCRt:4d2.org"
                .rsplit_once(':')
                .map(|(_, s)| s),
            Some("4d2.org")
        );
        assert_eq!(
            "#tune-zone:4d2.org".rsplit_once(':').map(|(_, s)| s),
            Some("4d2.org")
        );
    }
}

use std::collections::HashSet;
use std::sync::Arc;

use tauri::{Emitter, State};

use crate::types::PresencePayload;
use crate::{idle, AppState};

use super::{fmt_error_chain, get_client};

#[tauri::command]
pub async fn set_presence(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    presence: String,
    status_msg: Option<String>,
) -> Result<(), String> {
    let presence_state = match presence.as_str() {
        "online" => matrix_sdk::ruma::presence::PresenceState::Online,
        "unavailable" => matrix_sdk::ruma::presence::PresenceState::Unavailable,
        "offline" => matrix_sdk::ruma::presence::PresenceState::Offline,
        _ => return Err(format!("Invalid presence state: {presence}")),
    };

    let client = get_client(&state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();
    let user_id_str = user_id.to_string();

    let mut request = matrix_sdk::ruma::api::client::presence::set_presence::v3::Request::new(
        user_id,
        presence_state,
    );
    // Normalise: treat empty string the same as None.
    let status_msg_normalised = status_msg.filter(|s| !s.is_empty());
    request.status_msg = status_msg_normalised.clone();

    client
        .send(request)
        .await
        .map_err(|e| format!("Failed to set presence: {}", fmt_error_chain(&e)))?;

    // Sync only fills `presence_map` from presence events in the sync response; our own
    // presence is set out-of-band and may not echo back immediately, so keep the map
    // in sync with what we actually sent (avoids showing the local user as offline).
    state
        .presence_map
        .lock()
        .await
        .insert(user_id_str.clone(), presence.clone());

    // Keep status_msg_map in sync for local user as well.
    {
        let mut sm = state.status_msg_map.lock().await;
        if let Some(ref msg) = status_msg_normalised {
            sm.insert(user_id_str.clone(), msg.clone());
        } else {
            sm.remove(&user_id_str);
        }
    }

    // Store the desired presence so the sync loop can set `set_presence` on each
    // `/sync` request accordingly: "online" → sync auto-manages (like Cinny/Element),
    // anything else → sync uses Offline and we rely on explicit PUTs.
    if let Ok(mut dp) = state.desired_presence.lock() {
        *dp = presence.clone();
    }

    let _ = app.emit(
        "presence",
        PresencePayload {
            user_id: user_id_str,
            presence,
            status_msg: status_msg_normalised,
        },
    );

    Ok(())
}

/// Actively fetch current presence for all members of all joined rooms and
/// populate the presence_map.  This covers the gap where `restore_session`
/// resumes from a stored `since` token and the incremental sync response
/// doesn't include presence for users whose status hasn't changed since then.
#[tauri::command]
pub async fn sync_presence(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let client = get_client(&state).await?;
    let self_id = client
        .user_id()
        .ok_or("No user ID")?
        .to_string();

    // Collect unique user IDs across all joined rooms.
    let mut user_ids = HashSet::new();
    for room in client.joined_rooms() {
        if let Ok(members) = room.members(matrix_sdk::RoomMemberships::JOIN).await {
            for m in members {
                let uid = m.user_id().to_string();
                if uid != self_id {
                    user_ids.insert(uid);
                }
            }
        }
    }

    let access_token = client.access_token().ok_or("No access token")?;
    let homeserver = client.homeserver().to_string();
    let hs = homeserver.trim_end_matches('/');

    // Fetch presence for each user via the Matrix CS API.
    // Fire-and-forget individual failures — a single user 403 shouldn't block the rest.
    for uid in &user_ids {
        let encoded = urlencoding::encode(uid);
        let url = format!("{}/_matrix/client/v3/presence/{}/status", hs, encoded);
        let resp = match state
            .http_client
            .get(&url)
            .bearer_auth(&access_token)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };

        #[derive(serde::Deserialize)]
        struct PresenceResponse {
            presence: String,
            #[serde(default)]
            status_msg: Option<String>,
        }

        let body: PresenceResponse = match resp.json().await {
            Ok(b) => b,
            Err(_) => continue,
        };

        let presence_str = match body.presence.as_str() {
            "online" => "online",
            "unavailable" => "unavailable",
            _ => "offline",
        };

        state
            .presence_map
            .lock()
            .await
            .insert(uid.clone(), presence_str.to_string());

        let status_msg_normalised = body.status_msg.filter(|s| !s.is_empty());
        {
            let mut sm = state.status_msg_map.lock().await;
            if let Some(ref msg) = status_msg_normalised {
                sm.insert(uid.clone(), msg.clone());
            } else {
                sm.remove(uid);
            }
        }

        let _ = app.emit(
            "presence",
            PresencePayload {
                user_id: uid.clone(),
                presence: presence_str.to_string(),
                status_msg: status_msg_normalised,
            },
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn start_idle_monitor(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let display_server = state.display_server;
    // Avoid AppHandle::clone from the idle loop task when emitting (Rc in Tauri/Tao).
    let app = Arc::new(app);

    tokio::spawn(async move {
        idle::run_idle_monitor(app, display_server).await;
    });

    Ok(())
}
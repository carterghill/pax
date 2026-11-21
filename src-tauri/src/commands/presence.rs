use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{stream, StreamExt};
use matrix_sdk::config::RequestConfig;
use matrix_sdk::ruma::api::client::presence::{get_presence, set_presence};
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk::ruma::{OwnedUserId, UserId};
use matrix_sdk::{Client, RoomMemberships};
use tauri::{Emitter, State};

use crate::types::PresencePayload;
use crate::{idle, AppState};

use super::{fmt_error_chain, get_client};

#[derive(Default)]
pub(crate) struct PresenceCache(Mutex<PresenceCacheState>);

#[derive(Default)]
struct PresenceCacheState {
    session: u64,
    revision: u64,
    users: HashMap<String, (u64, PresencePayload)>,
}

#[derive(Clone, Copy)]
struct PresenceRefresh {
    session: u64,
    revision: u64,
}

impl PresenceCache {
    pub(super) fn get(&self, user_id: &str) -> (String, Option<String>) {
        self.0
            .lock()
            .unwrap()
            .users
            .get(user_id)
            .map(|(_, update)| (update.presence.clone(), update.status_msg.clone()))
            .unwrap_or_else(|| ("offline".into(), None))
    }

    pub(crate) fn clear(&self) {
        let mut state = self.0.lock().unwrap();
        state.users.clear();
        state.session += 1;
    }

    fn begin_refresh(&self) -> PresenceRefresh {
        let mut state = self.0.lock().unwrap();
        state.revision += 1;
        PresenceRefresh {
            session: state.session,
            revision: state.revision,
        }
    }

    fn update(
        &self,
        update: PresencePayload,
        refresh: Option<PresenceRefresh>,
        emit: impl FnOnce(&PresencePayload),
    ) {
        let mut state = self.0.lock().unwrap();
        let revision = match refresh {
            Some(refresh) => {
                // Order lookups by when they started. A late response must not
                // overwrite a newer lookup or an intervening /sync event.
                if refresh.session != state.session
                    || state
                        .users
                        .get(&update.user_id)
                        .is_some_and(|(revision, _)| *revision > refresh.revision)
                {
                    return;
                }
                refresh.revision
            }
            None => {
                state.revision += 1;
                state.revision
            }
        };
        emit(&update);
        state
            .users
            .insert(update.user_id.clone(), (revision, update));
    }

    pub(super) fn publish(&self, app: &tauri::AppHandle, update: PresencePayload) {
        self.update(update, None, |update| {
            let _ = app.emit("presence", update);
        });
    }
}

pub(super) fn presence_label(state: &PresenceState) -> &'static str {
    match state {
        PresenceState::Online => "online",
        PresenceState::Unavailable => "unavailable",
        _ => "offline",
    }
}

async fn fetch_presence(client: &Client, user_id: OwnedUserId) -> Option<PresencePayload> {
    let uid = user_id.to_string();
    let response = client
        .send(get_presence::v3::Request::new(user_id))
        .with_request_config(
            RequestConfig::new()
                .timeout(Duration::from_secs(5))
                .disable_retry(),
        )
        .await
        .ok()?;
    Some(PresencePayload {
        user_id: uid,
        presence: presence_label(&response.presence).into(),
        status_msg: response.status_msg.filter(|msg| !msg.is_empty()),
    })
}

#[tauri::command]
pub fn is_sync_ready(state: State<'_, Arc<AppState>>) -> bool {
    state.sync_ready.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn set_presence(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    presence: String,
    status_msg: Option<String>,
    expected_user_id: String,
) -> Result<(), String> {
    let presence_state = match presence.as_str() {
        "online" => PresenceState::Online,
        "unavailable" => PresenceState::Unavailable,
        "offline" => PresenceState::Offline,
        _ => return Err(format!("Invalid presence state: {presence}")),
    };

    let client = get_client(&state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();
    if user_id.as_str() != expected_user_id {
        return Err("The signed-in account changed.".into());
    }
    let refresh = state.presence.begin_refresh();

    let mut request = set_presence::v3::Request::new(user_id, presence_state);
    // Normalise: treat empty string the same as None.
    let status_msg_normalised = status_msg.filter(|s| !s.is_empty());
    request.status_msg = status_msg_normalised.clone();

    // Let /sync advertise Online even when the explicit PUT is slow or fails.
    if let Ok(mut dp) = state.desired_presence.lock() {
        *dp = presence.clone();
    }

    client.send(request).await.map_err(|e| {
        let error = format!("Failed to set presence: {}", fmt_error_chain(&e));
        log::warn!("{error}");
        error
    })?;

    // Our new presence may not echo back through sync immediately.
    state.presence.update(
        PresencePayload {
            user_id: expected_user_id,
            presence,
            status_msg: status_msg_normalised,
        },
        Some(refresh),
        |update| {
            let _ = app.emit("presence", update);
        },
    );

    Ok(())
}

/// Seed presence for joined members after startup, or refresh specific users
/// after unignoring them. Incremental sync may omit unchanged presence.
#[tauri::command]
pub async fn sync_presence(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    user_ids: Option<Vec<String>>,
    expected_user_id: String,
) -> Result<(), String> {
    let session = state.presence.begin_refresh().session;
    let client = get_client(&state).await?;
    let self_id = client.user_id().ok_or("No user ID")?;
    if self_id.as_str() != expected_user_id {
        return Err("The signed-in account changed.".into());
    }

    let users = if let Some(user_ids) = user_ids {
        stream::iter(user_ids.into_iter().filter_map(|id| UserId::parse(id).ok())).boxed()
    } else {
        stream::iter(client.joined_rooms())
            .map(|room| async move {
                room.members(RoomMemberships::JOIN)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(|member| member.user_id().to_owned())
                    .collect::<Vec<_>>()
            })
            .buffer_unordered(6)
            .flat_map(stream::iter)
            .boxed()
    };

    let mut seen = HashSet::new();
    users
        .filter(|user_id| {
            std::future::ready(user_id.as_str() != self_id.as_str() && seen.insert(user_id.clone()))
        })
        .for_each_concurrent(8, |user_id| {
            let (cache, client, app) = (&state.presence, &client, &app);
            async move {
                let refresh = cache.begin_refresh();
                if refresh.session != session {
                    return;
                }
                if let Some(update) = fetch_presence(client, user_id).await {
                    cache.update(update, Some(refresh), |update| {
                        let _ = app.emit("presence", update);
                    });
                }
            }
        })
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client_without_sync, Server, TestDir, USER},
    };

    const PEER: &str = "@peer:example.org";

    fn update(presence: &str) -> PresencePayload {
        PresencePayload {
            user_id: PEER.into(),
            presence: presence.into(),
            status_msg: None,
        }
    }

    #[tokio::test]
    async fn targeted_lookup_restores_online_presence_without_a_sync_event() {
        let server = Server::start().await;
        let dir = TestDir::new();
        server.state.lock().unwrap().route_overrides.insert(
            (
                "GET".into(),
                format!("/_matrix/client/v3/presence/{PEER}/status"),
            ),
            (
                200,
                serde_json::json!({ "presence": "online", "status_msg": "Available" }),
            ),
        );
        let client = client_without_sync(
            &server.home,
            &dir.0,
            SavedSession {
                user_id: USER.into(),
                device_id: "TEST".into(),
                access_token: "test".into(),
            },
        )
        .await;
        let cache = PresenceCache::default();
        cache.update(update("offline"), None, |_| {});
        let refresh = cache.begin_refresh();

        let presence = fetch_presence(&client, UserId::parse(PEER).unwrap())
            .await
            .unwrap();
        cache.update(presence, Some(refresh), |payload| {
            assert_eq!(payload.presence, "online")
        });
        assert_eq!(cache.get(PEER), ("online".into(), Some("Available".into())));
    }

    #[test]
    fn late_presence_lookup_cannot_replace_a_newer_lookup_or_sync_update() {
        let cache = PresenceCache::default();
        let startup = cache.begin_refresh();
        let unignore = cache.begin_refresh();
        cache.update(update("offline"), Some(startup), |_| {});
        cache.update(update("online"), Some(unignore), |_| {});
        assert_eq!(cache.get(PEER).0, "online");

        cache.update(update("offline"), Some(startup), |_| {
            panic!("Stale lookup was emitted")
        });
        let in_flight = cache.begin_refresh();
        cache.update(update("unavailable"), None, |_| {});
        cache.update(update("offline"), Some(in_flight), |_| {
            panic!("Lookup superseded /sync")
        });
        assert_eq!(cache.get(PEER).0, "unavailable");

        let previous_session = cache.begin_refresh();
        cache.clear();
        cache.update(update("online"), Some(previous_session), |_| {
            panic!("Previous session emitted presence")
        });
        assert_eq!(cache.get(PEER), ("offline".into(), None));
    }
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

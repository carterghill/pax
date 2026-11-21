use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use matrix_sdk::ruma::events::ignored_user_list::{IgnoredUser, IgnoredUserListEventContent};
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedUserId, UserId};
use matrix_sdk::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{fmt_error_chain, get_client};
use crate::AppState;

pub(crate) type IgnoredUserIds = HashSet<OwnedUserId>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredUsersSnapshot {
    revision: u64,
    user_ids: Vec<OwnedUserId>,
}

impl IgnoredUsersSnapshot {
    fn new(revision: u64, users: &IgnoredUserIds) -> Self {
        let mut user_ids: Vec<_> = users.iter().cloned().collect();
        user_ids.sort_unstable();
        Self { revision, user_ids }
    }
}

// Account data writes replace the entire map. Serialize edits and keep the
// successful server response visible while /sync is still catching up.
#[derive(Default)]
pub(crate) struct IgnoredUsers {
    update: tokio::sync::Mutex<()>,
    current: Mutex<(u64, Option<Arc<IgnoredUserIds>>)>,
}

impl IgnoredUsers {
    pub(crate) fn revision(&self) -> u64 {
        self.current.lock().unwrap().0
    }

    pub(crate) fn reset(&self) {
        let mut current = self.current.lock().unwrap();
        *current = (current.0 + 1, None);
    }

    pub(super) async fn snapshot(&self, client: &Client) -> (u64, Arc<IgnoredUserIds>) {
        let (revision, users) = self.current.lock().unwrap().clone();
        if let Some(users) = users {
            return (revision, users);
        }
        let cached = client
            .account()
            .account_data::<IgnoredUserListEventContent>()
            .await
            .ok()
            .flatten()
            .and_then(|content| content.deserialize().ok())
            .unwrap_or_default();
        let cached = Arc::new(user_ids(cached));
        let mut current = self.current.lock().unwrap();
        if current.0 == revision && current.1.is_none() {
            current.1 = Some(cached.clone());
        }
        (current.0, current.1.clone().unwrap_or(cached))
    }

    pub(crate) async fn users(&self, client: &Client) -> Arc<IgnoredUserIds> {
        self.snapshot(client).await.1
    }

    fn publish(&self, app: &AppHandle, users: IgnoredUserIds) -> IgnoredUsersSnapshot {
        let mut current = self.current.lock().unwrap();
        let changed = current.1.as_deref() != Some(&users);
        if changed {
            *current = (current.0 + 1, Some(Arc::new(users)));
        }
        let snapshot = IgnoredUsersSnapshot::new(current.0, current.1.as_deref().unwrap());
        drop(current);
        if changed {
            let _ = app.emit("ignored-users-changed", &snapshot);
            let _ = app.emit("rooms-changed", ());
        }
        snapshot
    }

    pub(super) async fn apply_sync(
        &self,
        app: &AppHandle,
        client: &Client,
        sync_revision: u64,
        content: IgnoredUserListEventContent,
    ) -> Result<(), String> {
        let _update = self.update.lock().await;
        let mut users = user_ids(content);
        let (revision, current) = self.current.lock().unwrap().clone();
        if revision != sync_revision && current.as_deref() != Some(&users) {
            // This sync may have read account data before our last write.
            // Re-read the current value so an older echo cannot undo it.
            users = user_ids(fetch(client).await?);
        }
        self.publish(app, users);
        Ok(())
    }
}

fn user_ids(content: IgnoredUserListEventContent) -> IgnoredUserIds {
    content.ignored_users.into_keys().collect()
}

async fn fetch(client: &Client) -> Result<IgnoredUserListEventContent, String> {
    client
        .account()
        .fetch_account_data_static::<IgnoredUserListEventContent>()
        .await
        .map_err(|e| fmt_error_chain(&e))?
        .map(|content| content.deserialize())
        .transpose()
        .map_err(|e| fmt_error_chain(&e))
        .map(Option::unwrap_or_default)
}

pub(crate) fn hides_event(users: &IgnoredUserIds, event: &Raw<AnySyncTimelineEvent>) -> bool {
    !users.is_empty()
        && event
            .get_field::<&str>("state_key")
            .ok()
            .flatten()
            .is_none()
        && event
            .get_field::<OwnedUserId>("sender")
            .ok()
            .flatten()
            .is_some_and(|sender| users.contains(&sender))
}

#[tauri::command]
pub async fn get_ignored_users(
    state: State<'_, Arc<AppState>>,
) -> Result<IgnoredUsersSnapshot, String> {
    let client = get_client(&state).await?;
    let (revision, users) = state.ignored_users.snapshot(&client).await;
    Ok(IgnoredUsersSnapshot::new(revision, &users))
}

#[tauri::command]
pub async fn set_user_ignored(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    user_id: String,
    ignored: bool,
    expected_user_id: String,
) -> Result<IgnoredUsersSnapshot, String> {
    let _session = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    if client.user_id().map(UserId::as_str) != Some(expected_user_id.as_str()) {
        return Err("The signed-in account changed.".into());
    }
    let target = UserId::parse(&user_id).map_err(|e| format!("Invalid Matrix user ID: {e}"))?;
    if ignored && client.user_id() == Some(target.as_ref()) {
        return Err("You cannot ignore your own account.".into());
    }

    let _update = state.ignored_users.update.lock().await;
    let users = update_account_data(&client, target, ignored).await?;
    Ok(state.ignored_users.publish(&app, users))
}

async fn update_account_data(
    client: &Client,
    target: OwnedUserId,
    ignored: bool,
) -> Result<IgnoredUserIds, String> {
    let mut content = fetch(&client).await?;
    if content.ignored_users.contains_key(&target) != ignored {
        if ignored {
            content.ignored_users.insert(target, IgnoredUser::new());
        } else {
            content.ignored_users.remove(&target);
        }
        client
            .account()
            .set_account_data(content.clone())
            .await
            .map_err(|e| fmt_error_chain(&e))?;
    }
    Ok(user_ids(content))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client, Server, TestDir, USER},
    };
    use serde_json::json;

    const EVENT_TYPE: &str = "m.ignored_user_list";
    const BOB: &str = "@bob:example.org";
    const CAROL: &str = "@carol:example.org";

    fn next_sync(server: &Server, token: &str) {
        let mut state = server.state.lock().unwrap();
        let content = state.account_data[EVENT_TYPE].clone();
        state.route_overrides.insert(
            ("GET".into(), "/_matrix/client/v3/sync".into()),
            (
                200,
                json!({
                    "next_batch": token,
                    "account_data": { "events": [{ "type": EVENT_TYPE, "content": content }] },
                }),
            ),
        );
    }

    #[tokio::test]
    async fn writes_merge_with_server_account_data_and_sync_to_another_device() {
        let server = Server::start().await;
        let dir = TestDir::new();
        let session = SavedSession {
            user_id: USER.into(),
            device_id: "ONE".into(),
            access_token: "one".into(),
            refresh_token: None,
        };
        let first = client(&server.home, &dir.0.join("first"), session.clone()).await;
        let second = client(
            &server.home,
            &dir.0.join("second"),
            SavedSession {
                device_id: "TWO".into(),
                ..session
            },
        )
        .await;
        let sync = matrix_sdk::config::SyncSettings::default();
        let bob = UserId::parse(BOB).unwrap();
        let carol = UserId::parse(CAROL).unwrap();

        update_account_data(&first, bob.clone(), true)
            .await
            .unwrap();
        update_account_data(&second, carol.clone(), true)
            .await
            .unwrap();
        assert_eq!(
            server.state.lock().unwrap().account_data[EVENT_TYPE],
            json!({ "ignored_users": { BOB: {}, CAROL: {} } }),
        );
        next_sync(&server, "s2");
        first.sync_once(sync.clone()).await.unwrap();
        let before = IgnoredUsers::default();
        assert_eq!(
            before.users(&first).await.as_ref(),
            &HashSet::from([bob.clone(), carol.clone()])
        );

        update_account_data(&first, bob.clone(), false)
            .await
            .unwrap();
        next_sync(&server, "s3");
        second.sync_once(sync).await.unwrap();
        assert!(!second.is_user_ignored(&bob).await);
        assert!(second.is_user_ignored(&carol).await);
        update_account_data(&second, carol, false).await.unwrap();
        assert_eq!(
            server.state.lock().unwrap().account_data[EVENT_TYPE],
            json!({ "ignored_users": {} })
        );
    }

    #[test]
    fn filters_message_like_events_but_preserves_room_state() {
        let users = HashSet::from([UserId::parse(BOB).unwrap()]);
        for event_type in ["m.room.message", "m.reaction", "m.room.encrypted"] {
            let event = Raw::new(&json!({ "type": event_type, "sender": BOB }))
                .unwrap()
                .cast_unchecked();
            assert!(hides_event(&users, &event));
        }
        let name = Raw::new(&json!({
            "type": "m.room.name", "sender": BOB, "state_key": ""
        }))
        .unwrap()
        .cast_unchecked();
        let message = Raw::new(&json!({ "type": "m.room.message", "sender": CAROL }))
            .unwrap()
            .cast_unchecked();
        assert!(!hides_event(&users, &name));
        assert!(!hides_event(&users, &message));
    }
}

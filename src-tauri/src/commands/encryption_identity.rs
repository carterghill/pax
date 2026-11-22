use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures_util::StreamExt;
use matrix_sdk::{encryption::identities::UserIdentity, Client};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::{sync::Mutex, time::timeout};

use super::fmt_error_chain;
use crate::commands::pax_auth;

const CHANGE_EVENT: &str = "encryption-identity-changed";
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
static RECORD_LOCK: Mutex<()> = Mutex::const_new(());

/// Public account identity only. Keep an unresolved change across app restarts
/// and across password sign-ins on this installation.
#[derive(Deserialize, Serialize)]
struct IdentityRecord {
    master_key: String,
    change_id: Option<String>,
    reviewed: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityChange {
    id: String,
    device_verified: bool,
    #[serde(skip)]
    reviewed: bool,
    #[serde(skip)]
    master_key: String,
}

impl IdentityChange {
    pub(super) fn id_for_key(&self, key: Option<&str>) -> Option<String> {
        (key == Some(self.master_key.as_str())).then(|| self.id.clone())
    }
}

fn record_path(app: &tauri::AppHandle, client: &Client) -> Result<PathBuf, String> {
    let user = client.user_id().ok_or("Not signed in")?;
    let home = client.homeserver();
    let scope = format!("{}\0{user}", home.as_str().trim_end_matches('/'));
    let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, scope.as_bytes());
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate encryption identity information.")?
        .join("encryption_identities");
    std::fs::create_dir_all(&dir).map_err(|_| "Could not open encryption identity information.")?;
    Ok(dir.join(format!("{id}.json")))
}

fn load(path: &Path) -> Result<Option<IdentityRecord>, String> {
    match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data)
            .map(Some)
            .map_err(|_| "Could not read encryption identity information.".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read encryption identity information.".into()),
    }
}

fn save(path: &Path, record: &IdentityRecord) -> Result<(), String> {
    let data = serde_json::to_vec(record)
        .map_err(|_| "Could not encode encryption identity information.")?;
    pax_auth::atomic_write(path, &data)
        .map_err(|_| "Could not save encryption identity information.".into())
}

fn record_observation(
    path: &Path,
    key: Option<&str>,
    verification_violation: bool,
) -> Result<Option<IdentityRecord>, String> {
    let saved = load(path)?;
    let Some(key) = key else { return Ok(saved) };
    if saved
        .as_ref()
        .is_some_and(|record| record.master_key == key)
    {
        return Ok(saved);
    }
    let record = IdentityRecord {
        master_key: key.to_owned(),
        change_id: (saved.is_some() || verification_violation)
            .then(|| uuid::Uuid::new_v4().to_string()),
        reviewed: false,
    };
    save(path, &record)?;
    Ok(Some(record))
}

pub(super) fn master_key(identity: &UserIdentity) -> Option<String> {
    identity
        .master_key()
        .get_first_key()
        .map(|key| key.to_base64())
}

async fn cached_identity(client: &Client) -> Result<Option<UserIdentity>, String> {
    let user = client.user_id().ok_or("Not signed in")?;
    client
        .encryption()
        .get_user_identity(user)
        .await
        .map_err(|error| fmt_error_chain(&error))
}

pub(super) async fn cached_master_key(client: &Client) -> Result<Option<String>, String> {
    Ok(cached_identity(client).await?.as_ref().and_then(master_key))
}

async fn observe_locked(path: &Path, client: &Client) -> Result<Option<IdentityChange>, String> {
    let identity = cached_identity(client).await?;
    let key = identity.as_ref().and_then(master_key);
    // On upgrade the SDK may already know that a verified identity was replaced.
    let violated = identity
        .as_ref()
        .is_some_and(UserIdentity::has_verification_violation);
    let Some(record) = record_observation(path, key.as_deref(), violated)? else {
        return Ok(None);
    };
    let Some(id) = record.change_id else {
        return Ok(None);
    };
    let device_verified = key.as_deref() == Some(record.master_key.as_str())
        && client
            .encryption()
            .get_own_device()
            .await
            .map_err(|error| fmt_error_chain(&error))?
            .is_some_and(|device| device.is_verified_with_cross_signing())
        && cached_master_key(client).await? == key;
    Ok(Some(IdentityChange {
        id,
        device_verified,
        reviewed: record.reviewed,
        master_key: record.master_key,
    }))
}

async fn observe(path: &Path, client: &Client) -> Result<Option<IdentityChange>, String> {
    let _lock = RECORD_LOCK.lock().await;
    observe_locked(path, client).await
}

pub(in crate::commands) async fn current(
    app: &tauri::AppHandle,
    client: &Client,
) -> Result<Option<IdentityChange>, String> {
    Ok(observe(&record_path(app, client)?, client)
        .await?
        .filter(|change| !change.reviewed))
}

/// A valid Pax session can enter verification after recovery fails only if
/// this installation detected an identity replacement for that account.
pub(in crate::commands) async fn refresh_known_change(
    app: &tauri::AppHandle,
    client: &Client,
) -> bool {
    let Ok(path) = record_path(app, client) else {
        return false;
    };
    refresh_observed_change(&path, client).await
}

async fn refresh_observed_change(path: &Path, client: &Client) -> bool {
    let Some(user) = client.user_id() else {
        return false;
    };
    let encryption = client.encryption();
    if !matches!(
        timeout(QUERY_TIMEOUT, encryption.request_user_identity(user)).await,
        Ok(Ok(Some(_)))
    ) {
        return false;
    }
    // After review the device can keep using the identity it verified even
    // when the password recovery envelope still needs to be updated.
    matches!(observe(path, client).await, Ok(Some(change)) if !change.reviewed || change.device_verified)
}

pub(super) async fn acknowledge(
    app: &tauri::AppHandle,
    client: &Client,
    id: &str,
) -> Result<(), String> {
    let path = record_path(app, client)?;
    acknowledge_record(&path, client, id).await?;
    let _ = app.emit(CHANGE_EVENT, ());
    Ok(())
}

async fn acknowledge_record(path: &Path, client: &Client, id: &str) -> Result<(), String> {
    let _lock = RECORD_LOCK.lock().await;
    let Some(change) = observe_locked(path, client).await? else {
        return Ok(());
    };
    if change.id != id {
        return Err("The encryption identity changed again. Review the latest change.".into());
    }
    if !change.device_verified {
        return Err("Verify this device under the new encryption identity first.".into());
    }
    let Some(mut record) = load(path)? else {
        return Ok(());
    };
    record.reviewed = true;
    save(path, &record)
}

pub(super) async fn watch(app: Arc<tauri::AppHandle>, client: Client) -> Result<(), String> {
    let path = record_path(&app, &client)?;
    let user = client.user_id().ok_or("Not signed in")?;
    let device = client.device_id().ok_or("Missing device ID")?;
    let encryption = client.encryption();
    let identities = encryption
        .user_identities_stream()
        .await
        .map_err(|error| fmt_error_chain(&error))?;
    let devices = encryption
        .devices_stream()
        .await
        .map_err(|error| fmt_error_chain(&error))?;
    futures_util::pin_mut!(identities, devices);

    let mut previous = None;
    publish(&app, &path, &client, &mut previous).await;
    // Catch a reset while Pax was closed even when sync has no device-list delta.
    let mut needs_startup_check = true;
    let mut startup_retry = tokio::time::interval(Duration::from_secs(30));
    startup_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let relevant = tokio::select! {
            _ = startup_retry.tick(), if needs_startup_check => {
                needs_startup_check = !matches!(
                    timeout(QUERY_TIMEOUT, encryption.request_user_identity(user)).await,
                    Ok(Ok(_))
                );
                !needs_startup_check
            }
            update = identities.next() => {
                let Some(update) = update else { return Ok(()) };
                update.new.contains_key(user) || update.changed.contains_key(user)
            }
            update = devices.next() => {
                let Some(update) = update else { return Ok(()) };
                update.new.get(user).is_some_and(|list| list.contains_key(device))
                    || update.changed.get(user).is_some_and(|list| list.contains_key(device))
            }
        };
        if relevant {
            publish(&app, &path, &client, &mut previous).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::{
        encryption::CrossSigningResetAuthType,
        ruma::api::client::uiaa::{AuthData, Password, UserIdentifier},
    };

    use super::*;
    use crate::commands::{
        auth::SavedSession,
        pax_auth::tests::{client, client_without_sync, Server, TestDir, USER},
    };

    #[test]
    fn first_identity_and_repeated_observations_are_quiet() {
        let dir = TestDir::new();
        let path = dir.0.join("identity.json");
        assert!(record_observation(&path, None, false).unwrap().is_none());
        let first = record_observation(&path, Some("original"), false)
            .unwrap()
            .unwrap();
        assert!(first.change_id.is_none());
        let repeated = record_observation(&path, Some("original"), false)
            .unwrap()
            .unwrap();
        assert!(repeated.change_id.is_none());

        let changed = record_observation(&path, Some("replacement"), false)
            .unwrap()
            .unwrap();
        assert!(changed.change_id.is_some());
        assert_eq!(
            record_observation(&path, None, false)
                .unwrap()
                .unwrap()
                .change_id,
            changed.change_id
        );
        assert_eq!(
            record_observation(&path, Some("replacement"), false)
                .unwrap()
                .unwrap()
                .change_id,
            changed.change_id
        );
        assert_ne!(
            record_observation(&path, Some("original"), false)
                .unwrap()
                .unwrap()
                .change_id,
            changed.change_id
        );
    }

    fn session(device_id: &str) -> SavedSession {
        SavedSession {
            user_id: USER.into(),
            device_id: device_id.into(),
            access_token: "token".into(),
            refresh_token: None,
        }
    }

    #[tokio::test]
    async fn detects_another_devices_reset_after_restart_and_requires_current_verification() {
        const PASSWORD: &str = "identity test password";
        let server = Server::start().await;
        server.state.lock().unwrap().credential = Some(PASSWORD.into());
        let dir = TestDir::new();
        let path = dir.0.join("identity.json");
        let observing_store = dir.0.join("observing");
        let observing = client(&server.home, &observing_store, session("WATCHING")).await;
        pax_auth::bootstrap_identity(&observing, PASSWORD)
            .await
            .unwrap();
        assert!(observe(&path, &observing).await.unwrap().is_none());
        assert!(!refresh_observed_change(&path, &observing).await);
        let old_key = cached_master_key(&observing).await.unwrap().unwrap();

        let resetting = client(&server.home, &dir.0.join("resetting"), session("RESETTING")).await;
        assert!(!refresh_observed_change(&path, &observing).await);
        drop(observing);
        let reset = resetting
            .encryption()
            .reset_cross_signing()
            .await
            .unwrap()
            .unwrap();
        let CrossSigningResetAuthType::Uiaa(challenge) = reset.auth_type() else {
            panic!("expected a password challenge");
        };
        let mut auth = Password::new(
            UserIdentifier::UserIdOrLocalpart(USER.into()),
            PASSWORD.into(),
        );
        auth.session = challenge.session.clone();
        reset.auth(Some(AuthData::Password(auth))).await.unwrap();
        let recovery_key = resetting.encryption().recovery().enable().await.unwrap();

        let observing =
            client_without_sync(&server.home, &observing_store, session("WATCHING")).await;
        assert_eq!(
            cached_master_key(&observing).await.unwrap(),
            Some(old_key.clone())
        );
        assert!(observe(&path, &observing).await.unwrap().is_none());
        let encryption = observing.encryption();
        let updates = encryption.user_identities_stream().await.unwrap();
        futures_util::pin_mut!(updates);
        let new_identity = observing
            .encryption()
            .request_user_identity(observing.user_id().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(master_key(&new_identity), Some(old_key));
        let update = timeout(Duration::from_secs(2), updates.next())
            .await
            .unwrap()
            .unwrap();
        assert!(update.changed.contains_key(observing.user_id().unwrap()));
        let change = observe(&path, &observing).await.unwrap().unwrap();
        assert!(!change.device_verified);
        assert!(!change.reviewed);
        assert!(refresh_observed_change(&path, &observing).await);
        assert!(acknowledge_record(&path, &observing, &change.id)
            .await
            .is_err());

        observing
            .encryption()
            .recovery()
            .recover(&recovery_key)
            .await
            .unwrap();
        let verified = observe(&path, &observing).await.unwrap().unwrap();
        let user = cached_identity(&observing).await.unwrap().unwrap();
        let device = observing
            .encryption()
            .get_own_device()
            .await
            .unwrap()
            .unwrap();
        assert!(
            verified.device_verified,
            "identity verified: {}, device signed by owner: {}",
            user.is_verified(),
            device.is_cross_signed_by_owner()
        );
        assert_eq!(verified.id, change.id);
        assert!(acknowledge_record(&path, &observing, "a-stale-change")
            .await
            .is_err());
        acknowledge_record(&path, &observing, &change.id)
            .await
            .unwrap();
        assert!(load(&path).unwrap().unwrap().reviewed);
        assert!(refresh_observed_change(&path, &observing).await);
    }
}

async fn publish(
    app: &tauri::AppHandle,
    path: &Path,
    client: &Client,
    previous: &mut Option<IdentityChange>,
) {
    match observe(path, client)
        .await
        .map(|change| change.filter(|change| !change.reviewed))
    {
        Ok(next) if next != *previous => {
            *previous = next;
            let _ = app.emit(CHANGE_EVENT, ());
        }
        Ok(_) => {}
        Err(error) => log::warn!("Could not check for an encryption identity change: {error}"),
    }
}

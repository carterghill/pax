//! In-place Matrix -> Pax enrollment. Private keys and backup versions survive
//! the switch. A durable encrypted journal bridges the non-transactional Matrix
//! profile, account-data and password APIs; a transition never permits a raw
//! password fallback on the ordinary login screen.

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use matrix_sdk::{ruma::serde::Raw, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, State};
use zeroize::Zeroizing;

use super::{
    auth,
    pax_auth::{self, AccountMode, Descriptor, Enrollment, PaxKeys, RecoveryEnvelope},
};
use crate::AppState;

pub const PENDING_MESSAGE: &str = "PAX_CONVERSION_PENDING: Finish switching this account to Pax sign-in using the new Pax password you chose.";
const RECORD_TYPE: &str = "com.carter.pax.conversion";
const PROOF_TEXT: &str = "pax-conversion-password-check-v1";

#[cfg(test)]
#[path = "account_conversion_tests.rs"]
mod tests;

// No plaintext password, credential, recovery key, or access token. The old
// account-data snapshot is already encrypted by Matrix Secret Storage.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ConversionRecord {
    schema_version: u32,
    user_id: String,
    transaction_id: String,
    password_check: RecoveryEnvelope,
    envelope: Option<RecoveryEnvelope>,
    original_recovery: BTreeMap<String, Value>,
    snapshot_saved: bool,
    password_change_requested: bool,
    pub complete: bool,
}

impl ConversionRecord {
    fn new(user: &str, keys: &PaxKeys) -> Result<Self, String> {
        let transaction_id = uuid::Uuid::new_v4().to_string();
        Ok(Self {
            schema_version: 1,
            user_id: user.into(),
            password_check: RecoveryEnvelope::encrypt(
                user,
                &format!("conversion:{transaction_id}"),
                PROOF_TEXT,
                keys,
            )?,
            transaction_id,
            envelope: None,
            original_recovery: BTreeMap::new(),
            snapshot_saved: false,
            password_change_requested: false,
            complete: false,
        })
    }

    fn validate(&self, user: &str) -> Result<(), String> {
        if self.schema_version != 1
            || self.user_id != user
            || uuid::Uuid::parse_str(&self.transaction_id).is_err()
            || (self.password_change_requested && self.envelope.is_none())
            || (self.complete && !self.password_change_requested)
        {
            return Err(
                "Invalid account conversion progress. Your encryption store has been preserved."
                    .into(),
            );
        }
        Ok(())
    }

    fn check_password(&self, keys: &PaxKeys) -> Result<(), String> {
        let plain = self
            .password_check
            .decrypt(
                &self.user_id,
                &format!("conversion:{}", self.transaction_id),
                keys,
            )
            .map_err(|_| {
                "Enter the same new Pax password you chose when you started switching this account."
            })?;
        if plain.as_str() != PROOF_TEXT {
            return Err("Invalid account conversion record".into());
        }
        Ok(())
    }

    fn descriptor(&self) -> Descriptor {
        let mut descriptor = Descriptor::new(&self.user_id, AccountMode::Pax, false);
        descriptor.state = "converting".into();
        descriptor.conversion_id = Some(self.transaction_id.clone());
        descriptor
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ConversionJournal {
    homeserver: String,
    store_dir: String,
    device_id: String,
    pub record: ConversionRecord,
}

fn journal_path(app: &tauri::AppHandle, home: &str, user: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("{}\0{user}", home.trim_end_matches('/')).as_bytes(),
    );
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate account data")?
        .join("pax_conversions");
    std::fs::create_dir_all(&dir).map_err(|_| "Could not create account conversion journal")?;
    Ok(dir.join(format!("{id}.json")))
}

pub(super) fn read_journal(
    app: &tauri::AppHandle,
    home: &str,
    user: &str,
) -> Result<Option<ConversionJournal>, String> {
    let bytes = match std::fs::read(journal_path(app, home, user)?) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read account conversion progress".into()),
    };
    let journal: ConversionJournal =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid account conversion progress")?;
    journal.record.validate(user)?;
    if journal.homeserver.trim_end_matches('/') != home.trim_end_matches('/')
        || journal.store_dir.is_empty()
        || journal.device_id.is_empty()
        || std::path::Path::new(&journal.store_dir)
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
    {
        return Err("Invalid account conversion store".into());
    }
    Ok(Some(journal))
}

fn save_journal(app: &tauri::AppHandle, journal: &ConversionJournal) -> Result<(), String> {
    pax_auth::atomic_write(
        &journal_path(app, &journal.homeserver, &journal.record.user_id)?,
        &serde_json::to_vec(journal).map_err(|_| "Could not encode account conversion progress")?,
    )
}

pub(super) fn discard_device_binding(
    app: &tauri::AppHandle,
    home: &str,
    user: &str,
    device: &str,
) -> Result<(), String> {
    if let Some(mut journal) = read_journal(app, home, user)? {
        if !journal.record.complete && journal.device_id == device {
            journal.device_id = uuid::Uuid::new_v4().simple().to_string();
            journal.store_dir = format!("matrix_sessions/pw_{}", uuid::Uuid::new_v4());
            save_journal(app, &journal)?;
        }
    }
    Ok(())
}

async fn account_data(client: &Client, kind: &str) -> Result<Option<Value>, String> {
    let raw = client
        .account()
        .fetch_account_data(kind.into())
        .await
        .map_err(|_| "Could not read encrypted account data")?;
    raw.map(|r| {
        serde_json::from_str(r.json().get()).map_err(|_| "Invalid encrypted account data".into())
    })
    .transpose()
}

async fn put_data<T: Serialize>(client: &Client, kind: &str, value: &T) -> Result<(), String> {
    let raw = Raw::new(value)
        .map_err(|_| "Could not encode encrypted account data")?
        .cast_unchecked();
    client
        .account()
        .set_account_data_raw(kind.into(), raw)
        .await
        .map(|_| ())
        .map_err(|_| {
            "Could not save encrypted account data. Retry with the same new Pax password.".into()
        })
}

async fn fetch_record(client: &Client) -> Result<Option<ConversionRecord>, String> {
    account_data(client, RECORD_TYPE)
        .await?
        .map(|v| {
            let r: ConversionRecord =
                serde_json::from_value(v).map_err(|_| "Invalid account conversion record")?;
            r.validate(client.user_id().ok_or("Not signed in")?.as_str())?;
            Ok(r)
        })
        .transpose()
}

async fn persist(
    client: &Client,
    record: &ConversionRecord,
    save: &mut impl FnMut(&ConversionRecord) -> Result<(), String>,
) -> Result<(), String> {
    // Local progress always precedes requests that could have succeeded despite
    // a lost response. The server copy allows finishing on another installation
    // after the derived password has taken effect.
    save(record)?;
    if let Some(existing) = fetch_record(client).await? {
        if !existing.complete && existing.transaction_id != record.transaction_id {
            return Err("Another device has started a different conversion. Finish switching on that device.".into());
        }
    }
    put_data(client, RECORD_TYPE, record).await?;
    let remote = fetch_record(client)
        .await?
        .ok_or("The homeserver did not retain conversion progress")?;
    if serde_json::to_value(&remote).unwrap() != serde_json::to_value(record).unwrap() {
        return Err("The homeserver returned inconsistent conversion progress".into());
    }
    Ok(())
}

async fn preflight(http: &reqwest::Client, client: &Client) -> Result<(), String> {
    pax_auth::check_profile_support(http, client.homeserver().as_str()).await
        .map_err(|_| "This homeserver could not confirm support for Pax account settings. No password has been changed.")?;
    let response = http
        .get(format!(
            "{}/_matrix/client/v3/capabilities",
            client.homeserver().as_str().trim_end_matches('/')
        ))
        .bearer_auth(client.access_token().ok_or("Not signed in")?)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Could not check whether this account can change its password")?;
    if !response.status().is_success() {
        return Err("Could not check whether this account can change its password".into());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid account capabilities")?;
    if !value["capabilities"].is_object() {
        return Err("Invalid account capabilities".into());
    }
    if value["capabilities"]["m.change_password"]["enabled"].as_bool() == Some(false) {
        return Err("This homeserver does not allow password changes for this account.".into());
    }
    Ok(())
}

/// Prepare recovery without changing the identity or an existing backup. An
/// inaccessible old backup must be unlocked, never silently replaced.
async fn ensure_recovery_access(client: &Client) -> Result<bool, String> {
    client
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;
    let user = client.user_id().ok_or("Not signed in")?;
    let identity = client
        .encryption()
        .request_user_identity(user)
        .await
        .map_err(|_| "Could not check your encryption identity")?;
    let complete = client
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete());
    if identity.is_some() && !complete {
        return Err("Unlock recovery or verify this device in Encryption settings before switching sign-in methods. Your existing identity has been preserved.".into());
    }
    let backups = client.encryption().backups();
    let backup_exists = backups
        .fetch_exists_on_server()
        .await
        .map_err(|_| "Could not check your existing message backup")?;
    if backup_exists && !backups.are_enabled().await {
        return Err("Unlock your existing message backup in Encryption settings before switching sign-in methods. No backup has been replaced.".into());
    }
    Ok(identity.is_some() && complete)
}

async fn prepare_recovery(
    client: &Client,
    keys: &PaxKeys,
    current_password: &str,
    record: &mut ConversionRecord,
    save: &mut impl FnMut(&ConversionRecord) -> Result<(), String>,
) -> Result<(), String> {
    record.check_password(keys)?;
    client
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;
    if record.envelope.is_some() {
        return Ok(());
    }

    let complete = ensure_recovery_access(client).await?;
    let backups = client.encryption().backups();
    if !record.snapshot_saved {
        let mut kinds = vec![
            "m.secret_storage.default_key".to_owned(),
            "m.cross_signing.master".into(),
            "m.cross_signing.self_signing".into(),
            "m.cross_signing.user_signing".into(),
            "m.megolm_backup.v1".into(),
            pax_auth::RECOVERY_TYPE.into(),
        ];
        if let Some(default) = account_data(client, "m.secret_storage.default_key").await? {
            if let Some(id) = default["key"].as_str() {
                kinds.push(format!("m.secret_storage.key.{id}"));
            }
        }
        for kind in kinds {
            if let Some(data) = account_data(client, &kind).await? {
                record.original_recovery.insert(kind, data);
            }
        }
        record.snapshot_saved = true;
        persist(client, record, save).await?;
    }
    if !complete {
        pax_auth::bootstrap_identity(client, current_password).await?;
    }
    let recovery = client.encryption().recovery();
    let ssss = client
        .encryption()
        .secret_storage()
        .is_enabled()
        .await
        .map_err(|_| "Could not check encrypted recovery")?;
    let recovery_key = Zeroizing::new(if ssss {
        if !backups.are_enabled().await {
            recovery
                .enable_backup()
                .await
                .map_err(|_| "Could not enable a message backup")?;
        }
        // Only the Secret Storage wrapper changes. The SDK retains old
        // encrypted slots, cross-signing keys and the active backup key.
        recovery
            .reset_key()
            .await
            .map_err(|_| "Could not protect your existing recovery secrets")?
    } else {
        recovery
            .enable()
            .await
            .map_err(|_| "Could not enable encrypted recovery")?
    });
    let key_id = pax_auth::secret_key_id(client).await?;
    record.envelope = Some(RecoveryEnvelope::encrypt(
        &record.user_id,
        &key_id,
        &recovery_key,
        keys,
    )?);
    persist(client, record, save).await
}

async fn publish_staged_recovery(
    http: &reqwest::Client,
    client: &Client,
    keys: &PaxKeys,
    record: &ConversionRecord,
) -> Result<(), String> {
    if let Some(existing) =
        pax_auth::discover(http, client.homeserver().as_str(), &record.user_id).await?
    {
        if existing.state == "converting"
            && existing.conversion_id.as_deref() != Some(&record.transaction_id)
        {
            return Err("Another conversion is already in progress. Finish it on the device where it started.".into());
        }
    }
    pax_auth::publish(http, client, &record.descriptor()).await?;
    let envelope = record
        .envelope
        .as_ref()
        .ok_or("Recovery must be prepared before changing the password")?;
    put_data(client, pax_auth::RECOVERY_TYPE, envelope).await?;
    let downloaded = pax_auth::fetch_envelope(client)
        .await?
        .ok_or("The homeserver did not retain encrypted recovery")?;
    if serde_json::to_value(&downloaded).unwrap() != serde_json::to_value(envelope).unwrap() {
        return Err("The homeserver returned inconsistent encrypted recovery".into());
    }
    pax_auth::unlock(client, keys, &downloaded).await
}

/// UIAA uses only the old Matrix password; the new memorable password is never
/// an authentication field. Keep this request bounded and redact server bodies.
async fn change_password(
    http: &reqwest::Client,
    client: &Client,
    old: &str,
    credential: &str,
) -> Result<(), String> {
    let mut body = json!({"new_password":credential,"logout_devices":false});
    for attempt in 0..4 {
        let response = http.post(format!("{}/_matrix/client/v3/account/password",client.homeserver().as_str().trim_end_matches('/')))
            .bearer_auth(client.access_token().ok_or("Not signed in")?).timeout(Duration::from_secs(30))
            .json(&body).send().await.map_err(|_| "The password-change response was interrupted. Retry with the same new Pax password to finish safely.")?;
        if response.status().is_success() {
            return Ok(());
        }
        if response.status() != reqwest::StatusCode::UNAUTHORIZED || attempt == 3 {
            return Err("The homeserver did not confirm the password change. Check your current Matrix password and retry with the same new Pax password.".into());
        }
        let challenge: Value = response
            .json()
            .await
            .map_err(|_| "Invalid password-change challenge")?;
        if challenge.get("errcode").is_some() {
            return Err("The homeserver rejected your current Matrix password. Retry with the same new Pax password.".into());
        }
        let completed = challenge["completed"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let flow = challenge["flows"].as_array().and_then(|flows| flows.iter().find(|flow| {
            flow["stages"].as_array().is_some_and(|stages| stages.iter().all(|s| matches!(s.as_str(),Some("m.login.password"|"m.login.dummy"))))
        })).ok_or("This account requires a password-change verification method Pax does not support yet")?;
        let next = flow["stages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| !completed.contains(s))
            .and_then(Value::as_str)
            .ok_or("The password-change challenge did not make progress")?;
        let session = challenge["session"]
            .as_str()
            .ok_or("Missing password-change session")?;
        body["auth"] = match next {
            "m.login.password" => {
                if old.is_empty() {
                    return Err(
                        "Enter your current Matrix password to finish switching sign-in methods."
                            .into(),
                    );
                }
                json!({"type":next,"session":session,"identifier":{"type":"m.id.user","user":client.user_id().ok_or("Not signed in")?.as_str()},"password":old})
            }
            _ => json!({"type":next,"session":session}),
        };
    }
    Err("Could not complete the password change".into())
}

async fn prepare_switch(
    http: &reqwest::Client,
    client: &Client,
    keys: &PaxKeys,
    old: &str,
    record: &mut ConversionRecord,
    save: &mut impl FnMut(&ConversionRecord) -> Result<(), String>,
) -> Result<(), String> {
    preflight(http, client).await?;
    record.check_password(keys)?;
    if let Some(remote) = fetch_record(client).await? {
        if !remote.complete && remote.transaction_id != record.transaction_id {
            return Err(
                "Another conversion is in progress. Finish it before starting another.".into(),
            );
        }
    }
    if let Some(descriptor) =
        pax_auth::discover(http, client.homeserver().as_str(), &record.user_id).await?
    {
        if descriptor.state == "converting"
            && descriptor.conversion_id.as_deref() != Some(&record.transaction_id)
        {
            return Err("Another conversion is already in progress. Finish it on the device where it started.".into());
        }
    }
    // Persist first and advertise before any slow recovery writes. Ordinary
    // login must not try the new password through standard Matrix fallback.
    persist(client, record, save).await?;
    pax_auth::publish(http, client, &record.descriptor()).await?;
    prepare_recovery(client, keys, old, record, save).await?;
    persist(client, record, save).await?;
    publish_staged_recovery(http, client, keys, record).await?;
    record.password_change_requested = true;
    persist(client, record, save).await
}

async fn finalize_remote(
    http: &reqwest::Client,
    client: &Client,
    keys: &PaxKeys,
    record: &ConversionRecord,
) -> Result<(), String> {
    record.check_password(keys)?;
    let envelope = record
        .envelope
        .as_ref()
        .ok_or("Encrypted recovery is missing from the conversion journal")?;
    let active = pax_auth::fetch_envelope(client)
        .await?
        .ok_or("Encrypted account recovery is missing")?;
    if serde_json::to_value(&active).unwrap() != serde_json::to_value(envelope).unwrap() {
        return Err("Encrypted recovery changed during conversion. Your existing encryption store has been preserved.".into());
    }
    let remote = fetch_record(client)
        .await?
        .ok_or("Conversion progress is missing on the homeserver")?;
    if remote.transaction_id != record.transaction_id {
        return Err("Account conversion progress changed on another device".into());
    }
    pax_auth::unlock(client, keys, envelope).await?;
    pax_auth::publish(
        http,
        client,
        &Descriptor::new(&record.user_id, AccountMode::Pax, true),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionStatus {
    pax_login: bool,
    pending: bool,
}

#[tauri::command]
pub async fn get_account_conversion_status(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<ConversionStatus, String> {
    let _operation = state.encryption.operation.lock().await;
    let client = super::get_client(&state).await?;
    let user = client.user_id().ok_or("Not signed in")?;
    let local = read_journal(&app, client.homeserver().as_str(), user.as_str())?;
    let remote = fetch_record(&client).await?;
    Ok(ConversionStatus {
        pax_login: *state.account_mode.lock().await == AccountMode::Pax,
        pending: local.is_some_and(|j| !j.record.complete) || remote.is_some_and(|r| !r.complete),
    })
}

fn validate_passwords(old: &str, new: &str) -> Result<(), String> {
    if new.chars().count() < 12 {
        return Err("Choose a new Pax password of at least 12 characters.".into());
    }
    if !old.is_empty() && old == new {
        return Err("Choose a different Pax password. Your old Matrix password has already been shared with the homeserver.".into());
    }
    Ok(())
}

// A new login can invalidate the previous token for the same device. Build a
// client with the SAME persistent store, and install it immediately so failures
// after this point can still be resumed from Settings.
async fn reauthenticate(
    state: &AppState,
    app: &tauri::AppHandle,
    journal: &ConversionJournal,
    keys: &PaxKeys,
) -> Result<Option<Client>, String> {
    let session = match auth::request_password_session(
        &state.http_client,
        &journal.homeserver,
        &journal.record.user_id,
        &keys.credential,
        Some(&journal.device_id),
    )
    .await
    {
        Ok(session) => session,
        Err(auth::PasswordLoginError::Rejected) => return Ok(None),
        Err(e) => return Err(e.message()),
    };
    if session.user_id != journal.record.user_id || session.device_id != journal.device_id {
        return Err("The homeserver returned a different account or device".into());
    }
    state.stop_sync_task().await;
    let client = auth::restore_authenticated_client(
        app,
        &journal.homeserver,
        &session,
        &journal.store_dir,
        AccountMode::Pax,
    )
    .await?;
    *state.client.lock().await = Some(client.clone());
    *state.session_store_dir.lock().await = Some(journal.store_dir.clone());
    Ok(Some(client))
}

async fn finish(
    state: &AppState,
    app: &tauri::AppHandle,
    client: &Client,
    keys: &PaxKeys,
    journal: &mut ConversionJournal,
    remember: bool,
) -> Result<(), String> {
    finalize_remote(&state.http_client, client, keys, &journal.record).await?;
    // Persist the pin before allowing ordinary login again on this installation.
    pax_auth::save_enrollment(
        app,
        &Enrollment {
            user_id: journal.record.user_id.clone(),
            homeserver: journal.homeserver.clone(),
            store_dir: journal.store_dir.clone(),
            device_id: Some(journal.device_id.clone()),
            registered: false,
            ready: true,
        },
    )?;
    if remember {
        auth::save_client_session(app, client, &journal.store_dir, AccountMode::Pax)?;
    }
    // Server completion first: a lost response leaves local progress pending,
    // which can safely rerun finalization using derived authentication.
    let mut complete = journal.record.clone();
    complete.complete = true;
    put_data(client, RECORD_TYPE, &complete).await?;
    journal.record = complete;
    save_journal(app, journal)?;
    *state.account_mode.lock().await = AccountMode::Pax;
    *state.client.lock().await = Some(client.clone());
    *state.session_store_dir.lock().await = Some(journal.store_dir.clone());
    state.reauthentication.lock().await.take();
    Ok(())
}

#[tauri::command]
pub async fn convert_account_to_pax(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    expected_user_id: String,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let old = Zeroizing::new(current_password);
    let new = Zeroizing::new(new_password);
    validate_passwords(&old, &new)?;
    let mut client = super::get_client(&state).await?;
    if client.user_id().map(|u| u.as_str()) != Some(expected_user_id.as_str()) {
        return Err("The signed-in account changed. Reopen Account settings.".into());
    }
    if super::encryption::has_pending_recovery_setup(&app, &client)? {
        return Err(
            "Finish recovery setup in Encryption settings before switching sign-in methods.".into(),
        );
    }
    let home = client.homeserver().to_string();
    pax_auth::ensure_trusted(&home, &state.auth_config)?;
    let keys = pax_auth::derive(&expected_user_id, &new).await?;
    let local = read_journal(&app, &home, &expected_user_id)?;
    let mut journal = if let Some(journal) = local.filter(|j| !j.record.complete) {
        journal
    } else {
        if *state.account_mode.lock().await == AccountMode::Pax {
            return Err("This account already uses Pax sign-in.".into());
        }
        preflight(&state.http_client, &client).await?;
        let descriptor = pax_auth::discover(&state.http_client, &home, &expected_user_id).await?;
        let remote = fetch_record(&client).await?;
        let record = match remote {
            Some(record) if !record.complete => {
                record.check_password(&keys)?;
                record
            }
            _ => {
                if descriptor.is_some_and(|d| d.mode == AccountMode::Pax) {
                    return Err("This account already has Pax sign-in settings. Finish signing in with your Pax password.".into());
                }
                if old.is_empty() {
                    return Err("Enter your current Matrix password.".into());
                }
                ensure_recovery_access(&client).await?;
                ConversionRecord::new(&expected_user_id, &keys)?
            }
        };
        let journal = ConversionJournal { homeserver: home.clone(), store_dir: state.session_store_dir.lock().await.clone().ok_or("Sign out and sign back in before switching sign-in methods; the current encryption store could not be identified.")?,
            device_id: client.device_id().ok_or("Missing device")?.to_string(), record };
        save_journal(&app, &journal)?;
        journal
    };
    journal.record.check_password(&keys)?;
    let remember = auth::read_credentials(&app)?.is_some_and(|c| {
        c.session.is_some_and(|s| s.user_id == expected_user_id)
            && c.homeserver.trim_end_matches('/') == home.trim_end_matches('/')
    });
    if journal.record.password_change_requested {
        if let Some(verified) = reauthenticate(&state, &app, &journal, &keys).await? {
            return finish(&state, &app, &verified, &keys, &mut journal, remember).await;
        }
    }
    // A journal from another installation can be resumed here, but its local
    // device/store must remain the current device rather than the source's path.
    if journal.device_id != client.device_id().ok_or("Missing device")?.as_str() {
        return Err("Finish this conversion on its original device, or use Finish switching on the login screen.".into());
    }
    let template = journal.clone();
    let mut save = |record: &ConversionRecord| {
        let mut j = template.clone();
        j.record = record.clone();
        save_journal(&app, &j)
    };
    prepare_switch(
        &state.http_client,
        &client,
        &keys,
        &old,
        &mut journal.record,
        &mut save,
    )
    .await?;
    change_password(&state.http_client, &client, &old, &keys.credential).await?;
    client = reauthenticate(&state, &app, &journal, &keys).await?.ok_or(
        "The new sign-in method could not be confirmed. Retry with the same new Pax password.",
    )?;
    finish(&state, &app, &client, &keys, &mut journal, remember).await
}

/// Login-screen repair path. Never sends a human password without a matching
/// LOCAL journal and AEAD password check. A fresh device may only use derived
/// authentication, then retrieve and verify the private server journal.
async fn authenticate_resume(
    http: &reqwest::Client,
    home: &str,
    user: &str,
    identifier: &str,
    keys: &PaxKeys,
    old: &str,
    local: Option<&ConversionJournal>,
) -> Result<(auth::SavedSession, bool), String> {
    if let Some(local) = local {
        local.record.validate(user)?;
        local.record.check_password(keys)?;
    }
    let device = local.map(|j| j.device_id.as_str());
    let derived = auth::request_password_session(http, home, user, &keys.credential, device).await;
    let (session, changed) = match derived {
        Ok(session) => (session, true),
        Err(auth::PasswordLoginError::Rejected) if local.is_some() => {
            if old.is_empty() {
                return Err("The password has not switched yet. Enter your old Matrix password as well as the new Pax password.".into());
            }
            (auth::request_password_session(http, home, identifier, old, device).await.map_err(|e| e.message())?, false)
        },
        Err(auth::PasswordLoginError::Rejected) => return Err("Finish this conversion on the installation where you started it. The new Pax password is not active yet.".into()),
        Err(e) => return Err(e.message()),
    };
    if session.user_id != user || device.is_some_and(|d| d != session.device_id) {
        return Err("The homeserver returned a different account or device".into());
    }
    Ok((session, changed))
}

#[tauri::command]
pub async fn resume_pax_conversion(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    homeserver: String,
    username: String,
    current_password: String,
    new_password: String,
    persist_session: bool,
) -> Result<String, String> {
    let _operation = state.encryption.operation.lock().await;
    let old = Zeroizing::new(current_password);
    let new = Zeroizing::new(new_password);
    validate_passwords(&old, &new)?;
    pax_auth::ensure_trusted(&homeserver, &state.auth_config)?;
    let user = pax_auth::account_id(
        &state.http_client,
        &homeserver,
        &username,
        &state.auth_config,
    )
    .await?;
    let keys = pax_auth::derive(&user, &new).await?;
    let local = read_journal(&app, &homeserver, &user)?;
    let (session, changed) = authenticate_resume(
        &state.http_client,
        &homeserver,
        &user,
        username.trim(),
        &keys,
        &old,
        local.as_ref(),
    )
    .await?;
    state.stop_sync_task().await;
    let rel = local
        .as_ref()
        .map(|j| j.store_dir.clone())
        .unwrap_or_else(|| format!("matrix_sessions/pw_{}", uuid::Uuid::new_v4()));
    let client =
        auth::restore_authenticated_client(&app, &homeserver, &session, &rel, AccountMode::Pax)
            .await?;
    let record = match local {
        Some(local) => local.record,
        None => fetch_record(&client)
            .await?
            .ok_or("Conversion progress is missing. Use the original installation.")?,
    };
    record.check_password(&keys)?;
    let mut journal = ConversionJournal {
        homeserver,
        store_dir: rel,
        device_id: session.device_id,
        record,
    };
    save_journal(&app, &journal)?;
    if !changed {
        let template = journal.clone();
        let mut save = |record: &ConversionRecord| {
            let mut j = template.clone();
            j.record = record.clone();
            save_journal(&app, &j)
        };
        prepare_switch(
            &state.http_client,
            &client,
            &keys,
            &old,
            &mut journal.record,
            &mut save,
        )
        .await?;
        change_password(&state.http_client, &client, &old, &keys.credential).await?;
        let verified = reauthenticate(&state, &app, &journal, &keys)
            .await?
            .ok_or("Could not confirm the new Pax password. Retry to finish switching.")?;
        finish(
            &state,
            &app,
            &verified,
            &keys,
            &mut journal,
            persist_session,
        )
        .await?;
    } else {
        // Repair a server commit whose response was lost before the local
        // requested flag could be observed on this installation.
        journal.record.password_change_requested = true;
        finish(&state, &app, &client, &keys, &mut journal, persist_session).await?;
    }
    if !persist_session {
        auth::clear_saved_credentials(app)?;
    }
    state.notifications.start_session();
    state.voice_presence.start_session();
    state.attachments.start_session();
    Ok(user)
}

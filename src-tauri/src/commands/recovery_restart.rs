//! An explicit escape from an unconfigured account's lost private secrets.
//! Never called by login or conversion. Keep older backup versions and already
//! encrypted secret records; only the user can authorize changing verification.

use matrix_sdk::{
    encryption::CrossSigningResetAuthType,
    ruma::{
        api::client::uiaa::{AuthData, Password, UserIdentifier},
        serde::Raw,
    },
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};
use tauri::Manager;

use super::{status, EncryptionService};
use crate::commands::pax_auth;

#[derive(Clone, Serialize, Deserialize)]
struct Progress {
    schema_version: u32,
    user_id: String,
    device_id: String,
    transaction_id: String,
    // All secret contents here are the original Matrix ciphertext, not private
    // signing/backup keys. The previous backup's version and public auth data
    // are retained so it can still be found if an older key turns up later.
    original_account_data: BTreeMap<String, Value>,
    original_backup: Option<Value>,
    complete: bool,
}

fn path(app: &tauri::AppHandle, client: &Client) -> Result<PathBuf, String> {
    let id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!(
            "{}\0{}\0{}",
            client.homeserver(),
            client.user_id().ok_or("Not signed in")?,
            client.device_id().ok_or("Missing device")?
        )
        .as_bytes(),
    );
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate recovery progress")?
        .join("recovery_restarts");
    std::fs::create_dir_all(&dir).map_err(|_| "Could not save recovery progress")?;
    Ok(dir.join(format!("{id}.json")))
}

fn load(app: &tauri::AppHandle, client: &Client) -> Result<Option<Progress>, String> {
    match std::fs::read(path(app, client)?) {
        Ok(bytes) => {
            let record: Progress =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid recovery setup progress")?;
            if record.schema_version != 1
                || Some(record.user_id.as_str()) != client.user_id().map(|u| u.as_str())
                || Some(record.device_id.as_str()) != client.device_id().map(|d| d.as_str())
                || uuid::Uuid::parse_str(&record.transaction_id).is_err()
            {
                return Err("Recovery setup progress does not match this device".into());
            }
            Ok(Some(record))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read recovery setup progress".into()),
    }
}

pub(super) fn is_pending(app: &tauri::AppHandle, client: &Client) -> Result<bool, String> {
    Ok(load(app, client)?.is_some_and(|r| !r.complete))
}

fn save(app: &tauri::AppHandle, client: &Client, record: &Progress) -> Result<(), String> {
    pax_auth::atomic_write(
        &path(app, client)?,
        &serde_json::to_vec(record).map_err(|_| "Could not encode recovery setup progress")?,
    )
}

async fn snapshot(client: &Client) -> Result<Progress, String> {
    let mut original_account_data = BTreeMap::new();
    for kind in [
        "m.secret_storage.default_key",
        "m.cross_signing.master",
        "m.cross_signing.self_signing",
        "m.cross_signing.user_signing",
        "m.megolm_backup.v1",
    ] {
        if let Some(raw) = client
            .account()
            .fetch_account_data(kind.into())
            .await
            .map_err(|_| "Could not preserve existing encrypted recovery records")?
        {
            original_account_data.insert(
                kind.into(),
                serde_json::from_str(raw.json().get())
                    .map_err(|_| "Invalid encrypted recovery record")?,
            );
        }
    }
    let request = matrix_sdk::ruma::api::client::backup::get_latest_backup_info::v3::Request::new();
    let original_backup = if client
        .encryption()
        .backups()
        .fetch_exists_on_server()
        .await
        .map_err(|_| "Could not check the existing backup")?
    {
        let response = client
            .send(request)
            .await
            .map_err(|_| "Could not preserve the old backup version")?;
        let mut info: Value = serde_json::from_str(response.algorithm.json().get())
            .map_err(|_| "Could not encode old backup information")?;
        info["version"] = response.version.into();
        info["count"] = serde_json::to_value(response.count)
            .map_err(|_| "Could not encode old backup information")?;
        info["etag"] = response.etag.into();
        Some(info)
    } else {
        None
    };
    Ok(Progress {
        schema_version: 1,
        user_id: client.user_id().ok_or("Not signed in")?.to_string(),
        device_id: client.device_id().ok_or("Missing device")?.to_string(),
        transaction_id: uuid::Uuid::new_v4().to_string(),
        original_account_data,
        original_backup,
        complete: false,
    })
}

async fn archive(client: &Client, record: &Progress) -> Result<(), String> {
    let kind = format!("com.carter.pax.recovery_restart.{}", record.transaction_id);
    client
        .account()
        .set_account_data_raw(
            kind.clone().into(),
            Raw::new(record)
                .map_err(|_| "Could not encode old recovery information")?
                .cast_unchecked(),
        )
        .await
        .map_err(|_| "Could not preserve old recovery information on the homeserver")?;
    let downloaded = client
        .account()
        .fetch_account_data(kind.into())
        .await
        .map_err(|_| "Could not check the saved recovery information")?
        .ok_or("The homeserver did not retain the old recovery information")?;
    let downloaded: Value = serde_json::from_str(downloaded.json().get())
        .map_err(|_| "Invalid saved recovery information")?;
    if downloaded != serde_json::to_value(record).unwrap() {
        return Err("The homeserver returned inconsistent recovery information".into());
    }
    Ok(())
}

/// Reuse available private keys on retry. Before the authenticated upload has
/// succeeded, the SDK may discard generated keys when it sees the old server
/// identity again; recreating unaccepted keys does not rotate a published one.
/// `Recovery::reset_identity()` is deliberately avoided: it deletes the backup.
async fn prepare_new_recovery(client: &Client, password: &str) -> Result<(), String> {
    let encryption = client.encryption();
    encryption.wait_for_e2ee_initialization_tasks().await;
    if !encryption
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete())
    {
        if let Some(handle) = encryption.reset_cross_signing().await.map_err(|_| {
            "Could not start new encryption verification. Retry on this same device."
        })? {
            let CrossSigningResetAuthType::Uiaa(challenge) = handle.auth_type() else {
                return Err("This account requires a verification method Pax does not support for this action yet.".into());
            };
            let mut auth = Password::new(
                UserIdentifier::UserIdOrLocalpart(
                    client.user_id().ok_or("Not signed in")?.to_string(),
                ),
                password.into(),
            );
            auth.session = challenge.session.clone();
            tokio::time::timeout(std::time::Duration::from_secs(30), handle.auth(Some(AuthData::Password(auth)))).await
                .map_err(|_| "Encryption verification timed out. Retry on this same device.")?
                .map_err(|_| "The homeserver could not verify the new identity. Check your Matrix password and retry on this device.")?;
        }
    } else {
        // Also finishes an earlier reset whose generated keys never completed
        // their authenticated upload. This call reuses the same keys.
        pax_auth::bootstrap_identity(client, password).await?;
    }
    if !encryption
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete())
    {
        return Err("Encryption verification is incomplete. Retry on this same device.".into());
    }
    let backups = encryption.backups();
    if !backups.are_enabled().await {
        // POST creates a separate version. Never DELETE an old version or its
        // ciphertext; a newly found old key may still be useful later.
        backups.create().await.map_err(|_| "Could not create a backup for this device’s available history. Retry on this same device.")?;
    }
    Ok(())
}

pub(super) async fn start(
    app: &tauri::AppHandle,
    client: &Client,
    service: &EncryptionService,
    password: &str,
) -> Result<String, String> {
    if password.is_empty() {
        return Err("Enter your current Matrix password.".into());
    }
    let mut record = match load(app, client)?.filter(|r| !r.complete) {
        Some(record) => record,
        None => {
            let current = status(client, service).await?;
            if current.secret_storage_exists || current.can_setup {
                return Err("Use the existing recovery controls for this account. A new encryption identity is not needed.".into());
            }
            let record = snapshot(client).await?;
            save(app, client, &record)?;
            record
        }
    };
    // Archive before any changes. A failed request leaves only the local
    // journal, and the explicit Finish setup action can retry safely.
    archive(client, &record).await?;
    if let Some(key) = service.pending_key.lock().await.clone() {
        record.complete = true;
        save(app, client, &record)?;
        return Ok(key);
    }
    prepare_new_recovery(client, password).await?;
    super::mark_key_needs_save(app, client, service)?;
    let recovery = client.encryption().recovery();
    let key = if client
        .encryption()
        .secret_storage()
        .is_enabled()
        .await
        .map_err(|_| "Could not check recovery storage")?
    {
        recovery.reset_key().await
    } else {
        recovery.enable().await
    }
    .map_err(|_| "Could not finish recovery setup. Retry on this same device.")?;
    *service.pending_key.lock().await = Some(key.clone());
    record.complete = true;
    save(app, client, &record)?;
    Ok(key)
}

#[cfg(test)]
#[path = "recovery_restart_tests.rs"]
mod tests;

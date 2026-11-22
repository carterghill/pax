//! Account recovery uses the SDK's recovery API. Never replace a remote backup
//! or reset a cryptographic identity as a side effect of logging in.

use std::future::IntoFuture;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use matrix_sdk::encryption::backups::UploadState;
use matrix_sdk::encryption::verification::{VerificationRequest, VerificationRequestState};
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::key::verification::VerificationMethod;
use matrix_sdk::Client;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::{fmt_error_chain, get_client};
use crate::AppState;

#[path = "encryption_identity.rs"]
pub(super) mod identity;
#[path = "recovery_restart.rs"]
mod restart;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub state: String,
    pub backed_up: Option<usize>,
    pub total: Option<usize>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct ActiveVerification {
    request: VerificationRequest,
    master_key: Option<String>,
    identity_change_id: Option<String>,
}

impl ActiveVerification {
    fn identity_changed(&self, current_key: Option<&str>) -> bool {
        self.master_key
            .as_deref()
            .is_some_and(|key| current_key != Some(key))
    }
}

#[derive(Default)]
pub struct EncryptionService {
    /// Serialize recovery changes with logout, login, and each other.
    pub operation: Mutex<()>,
    progress: Arc<Mutex<BackupProgress>>,
    task: Mutex<Option<JoinHandle<()>>>,
    verification: Arc<Mutex<Option<ActiveVerification>>>,
    confirmed_flow: Mutex<Option<String>>,
    // Keep an unacknowledged key available if the webview is reloaded. Do not
    // put recovery secrets in logs, events, credentials.json, or localStorage.
    pending_key: Mutex<Option<String>>,
    key_needs_save: std::sync::atomic::AtomicBool,
    backup_operation: Arc<Mutex<()>>,
    generation: Arc<std::sync::atomic::AtomicU64>,
}

impl EncryptionService {
    pub async fn stop(&self) {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        if let Some(task) = self.task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
        *self.verification.lock().await = None;
        *self.confirmed_flow.lock().await = None;
        *self.pending_key.lock().await = None;
        *self.progress.lock().await = BackupProgress::default();
        self.key_needs_save
            .store(false, std::sync::atomic::Ordering::Release);
    }

    pub async fn start(&self, client: &Client, app: Arc<tauri::AppHandle>) {
        let mut task = self.task.lock().await;
        if task.is_some() {
            return;
        }
        if let Ok(path) = recovery_marker_path(&app, client) {
            self.key_needs_save
                .store(path.exists(), std::sync::atomic::Ordering::Release);
        }

        let verification = self.verification.clone();
        let generation = self.generation.clone();
        let session_generation = generation.load(std::sync::atomic::Ordering::Acquire);
        let request_app = app.clone();
        client.add_event_handler(
            move |event: ToDeviceKeyVerificationRequestEvent, client: Client| {
                let verification = verification.clone();
                let generation = generation.clone();
                let app = request_app.clone();
                async move {
                    // Recovery verifies this user's devices, never arbitrary users.
                    if Some(event.sender.as_ref()) != client.user_id() {
                        return;
                    }
                    if let Some(request) = client
                        .encryption()
                        .get_verification_request(
                            &event.sender,
                            event.content.transaction_id.as_str(),
                        )
                        .await
                    {
                        let master_key = identity::cached_master_key(&client).await.ok().flatten();
                        let mut active = verification.lock().await;
                        if generation.load(std::sync::atomic::Ordering::Acquire)
                            != session_generation
                        {
                            return;
                        }
                        if active.as_ref().is_none_or(|entry| {
                            entry.request.is_done()
                                || entry.request.is_cancelled()
                                || entry.identity_changed(master_key.as_deref())
                        }) {
                            *active = Some(ActiveVerification {
                                request,
                                master_key,
                                identity_change_id: None,
                            });
                            let _ = app.emit("encryption-verification-request", ());
                        }
                    }
                }
            },
        );

        let client = client.clone();
        let progress = self.progress.clone();
        let backup_operation = self.backup_operation.clone();
        let identity_client = client.clone();
        let identity_app = app.clone();
        *task = Some(tokio::spawn(async move {
            let identity_loop = async {
                if let Err(error) = identity::watch(identity_app, identity_client).await {
                    log::warn!("Could not watch for encryption identity changes: {error}");
                }
            };
            let backup_updates = async {
                let Some(keys) = client.encryption().room_keys_received_stream().await else {
                    return;
                };
                futures_util::pin_mut!(keys);
                let backup_loop = async {
                    let mut timer = tokio::time::interval(Duration::from_secs(30));
                    loop {
                        timer.tick().await;
                        if client.encryption().backups().are_enabled().await {
                            let _backup = backup_operation.lock().await;
                            run_backup(&client, &progress, &app).await;
                        }
                    }
                };
                let keys_loop = async {
                    while let Some(update) = keys.next().await {
                        *progress.lock().await = BackupProgress {
                            state: "pending".into(),
                            ..Default::default()
                        };
                        let room_ids = update.ok().map(|keys| {
                            keys.into_iter()
                                .map(|key| key.room_id.to_string())
                                .collect::<Vec<_>>()
                        });
                        let _ = app.emit("encryption-keys-received", room_ids);
                    }
                };
                // A slow backup request must not hold up restored-message updates.
                tokio::select! { _ = backup_loop => {}, _ = keys_loop => {} }
            };
            tokio::join!(identity_loop, backup_updates);
        }));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionStatus {
    pub pax_login: bool,
    pub recovery_state: String,
    pub backup_state: String,
    pub backup_exists: bool,
    pub backup_enabled: bool,
    pub secret_storage_exists: bool,
    pub cross_signing_ready: bool,
    pub has_identity: bool,
    pub can_setup: bool,
    pub can_start_from_device: bool,
    pub new_recovery_pending: bool,
    pub progress: BackupProgress,
    pub pending_recovery_key: bool,
    pub recovery_key_needs_save: bool,
}

fn recovery_marker_path(
    app: &tauri::AppHandle,
    client: &Client,
) -> Result<std::path::PathBuf, String> {
    let identity = format!(
        "{}\0{}",
        client.homeserver(),
        client.user_id().ok_or("Not logged in")?
    );
    let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, identity.as_bytes());
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("encryption_recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{id}.pending")))
}

fn mark_key_needs_save(
    app: &tauri::AppHandle,
    client: &Client,
    service: &EncryptionService,
) -> Result<(), String> {
    // Persist only a reminder, never the recovery key itself. A crash after the
    // server changes must not silently turn an unsaved key into "recovery ready".
    std::fs::write(
        recovery_marker_path(app, client)?,
        b"Recovery key has not been confirmed saved\n",
    )
    .map_err(|e| format!("Could not save recovery setup progress: {e}"))?;
    service
        .key_needs_save
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}

fn clear_key_reminder(
    app: &tauri::AppHandle,
    client: &Client,
    service: &EncryptionService,
) -> Result<(), String> {
    let path = recovery_marker_path(app, client)?;
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not save recovery setup progress: {e}")),
    }
    service
        .key_needs_save
        .store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}

async fn status(client: &Client, service: &EncryptionService) -> Result<EncryptionStatus, String> {
    let encryption = client.encryption();
    // On restore, the SDK initializes backup and identity asynchronously.
    timeout(
        Duration::from_secs(15),
        encryption.wait_for_e2ee_initialization_tasks(),
    )
    .await
    .map_err(|_| "Encryption is still connecting. Please try again.".to_string())?;
    let backup_exists = encryption
        .backups()
        .fetch_exists_on_server()
        .await
        .map_err(|e| format!("Could not check key backup: {}", fmt_error_chain(&e)))?;
    let secret_storage_exists = encryption
        .secret_storage()
        .is_enabled()
        .await
        .map_err(|e| format!("Could not check recovery: {}", fmt_error_chain(&e)))?;
    let backup_enabled = encryption.backups().are_enabled().await;
    let cross_signing_ready = encryption
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete());
    let user_id = client.user_id().ok_or("Not logged in")?;
    let has_identity = encryption
        .request_user_identity(user_id)
        .await
        .map_err(|e| format!("Could not check your identity: {}", fmt_error_chain(&e)))?
        .is_some();
    Ok(EncryptionStatus {
        pax_login: false,
        recovery_state: format!("{:?}", encryption.recovery().state()).to_lowercase(),
        backup_state: format!("{:?}", encryption.backups().state()).to_lowercase(),
        backup_exists,
        backup_enabled,
        secret_storage_exists,
        cross_signing_ready,
        has_identity,
        can_setup: can_setup_recovery(
            secret_storage_exists,
            cross_signing_ready,
            has_identity,
            backup_enabled,
            backup_exists,
        ),
        can_start_from_device: false,
        new_recovery_pending: false,
        progress: service.progress.lock().await.clone(),
        pending_recovery_key: service.pending_key.lock().await.is_some(),
        recovery_key_needs_save: service
            .key_needs_save
            .load(std::sync::atomic::Ordering::Acquire),
    })
}

fn can_setup_recovery(
    secret_storage_exists: bool,
    cross_signing_ready: bool,
    has_identity: bool,
    backup_enabled: bool,
    backup_exists: bool,
) -> bool {
    !secret_storage_exists
        && (cross_signing_ready || !has_identity)
        && (backup_enabled || !backup_exists)
}

fn setup_blocked_message(current: &EncryptionStatus) -> &'static str {
    if current.secret_storage_exists {
        "Recovery is already configured. Use your recovery key or verify with another device to unlock it."
    } else if current.has_identity && !current.cross_signing_ready {
        "Recovery has not been configured, but this account already has an encryption identity whose private keys are missing on this device. Verify using a device that still has those keys before setting up recovery."
    } else if current.backup_exists && !current.backup_enabled {
        "This account already has an encrypted message backup, but this device cannot unlock it. Recovery may never have been configured. Use a device that still has the backup key; creating a recovery key here cannot unlock that existing backup."
    } else {
        "Encryption is not ready for recovery setup. Check status and try again."
    }
}

pub(super) fn has_pending_recovery_setup(
    app: &tauri::AppHandle,
    client: &Client,
) -> Result<bool, String> {
    restart::is_pending(app, client)
}

async fn prepare_recovery_setup(
    client: &Client,
    service: &EncryptionService,
    password: Option<&str>,
) -> Result<(), String> {
    let current = status(client, service).await?;
    if !current.can_setup {
        return Err(setup_blocked_message(&current).into());
    }
    // An automatic bootstrap or earlier attempt may have created the local
    // keys without completing their UIAA upload. Re-upload those SAME keys;
    // local completeness alone does not prove the server has accepted them.
    super::pax_auth::bootstrap_identity(client, password.unwrap_or("")).await?;
    if !client
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete())
    {
        return Err(
            "Verify this device using another signed-in device before setting up recovery.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::can_setup_recovery;

    #[test]
    fn existing_recovery_is_never_replaced_by_setup() {
        for local_identity in [false, true] {
            for local_backup in [false, true] {
                assert!(!can_setup_recovery(
                    true,
                    local_identity,
                    true,
                    local_backup,
                    true
                ));
            }
        }
    }

    #[test]
    fn missing_secrets_require_recovery_instead_of_a_new_backup_or_identity() {
        assert!(!can_setup_recovery(false, true, true, false, true));
        assert!(!can_setup_recovery(false, false, true, true, true));
        assert!(!can_setup_recovery(false, false, true, false, false));
        // First account setup and an existing locally unlocked backup are safe.
        assert!(can_setup_recovery(false, false, false, false, false));
        assert!(can_setup_recovery(false, true, true, true, true));
    }
}

#[tauri::command]
pub async fn get_encryption_identity_change(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Option<identity::IdentityChange>, String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    identity::current(&app, &client).await
}

#[tauri::command]
pub async fn acknowledge_encryption_identity_change(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    change_id: String,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    identity::acknowledge(&app, &client, &change_id).await
}

#[tauri::command]
pub async fn get_encryption_status(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<EncryptionStatus, String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    let mut current = timeout(Duration::from_secs(20), status(&client, &state.encryption))
        .await
        .map_err(|_| {
            "Could not check encrypted backup. Check your connection and try again.".to_string()
        })??;
    current.pax_login = *state.account_mode.lock().await == super::pax_auth::AccountMode::Pax;
    current.new_recovery_pending = restart::is_pending(&app, &client)?;
    current.can_start_from_device = !current.pax_login
        && (current.new_recovery_pending || (!current.secret_storage_exists && !current.can_setup));
    if current.pax_login {
        current.can_setup = false;
        current.pending_recovery_key = false;
        current.recovery_key_needs_save = false;
        current.can_start_from_device = false;
    }
    Ok(current)
}

#[tauri::command]
pub async fn start_encryption_recovery_from_device(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    expected_user_id: String,
    password: String,
    confirmed: bool,
) -> Result<String, String> {
    let _operation = state.encryption.operation.lock().await;
    if !confirmed {
        return Err("Confirm the new recovery setup before continuing.".into());
    }
    if *state.account_mode.lock().await != super::pax_auth::AccountMode::Matrix {
        return Err("This action is only available for standard Matrix accounts.".into());
    }
    let client = get_client(&state).await?;
    if client.user_id().map(|u| u.as_str()) != Some(expected_user_id.as_str()) {
        return Err("The signed-in account changed. Reopen Encryption settings.".into());
    }
    if super::account_conversion::read_journal(
        &app,
        client.homeserver().as_str(),
        &expected_user_id,
    )?
    .is_some_and(|j| !j.record.complete)
    {
        return Err(
            "Finish switching sign-in methods before starting new encryption recovery.".into(),
        );
    }
    let password = zeroize::Zeroizing::new(password);
    // Pause incoming key queries while changing verification so an old public
    // identity cannot invalidate new keys during their authenticated upload.
    let pending_key = state.encryption.pending_key.lock().await.clone();
    state.stop_sync_task().await;
    *state.encryption.pending_key.lock().await = pending_key;
    restart::start(&app, &client, &state.encryption, &password).await
}

#[tauri::command]
pub async fn get_pending_encryption_recovery_key(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let _operation = state.encryption.operation.lock().await;
    get_client(&state).await?;
    Ok(state.encryption.pending_key.lock().await.clone())
}

#[tauri::command]
pub async fn setup_encryption_recovery(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    password: Option<String>,
) -> Result<String, String> {
    let _operation = state.encryption.operation.lock().await;
    if *state.account_mode.lock().await == super::pax_auth::AccountMode::Pax {
        return Err(
            "Sign in again with your Pax password to restore automatic encrypted recovery.".into(),
        );
    }
    let client = get_client(&state).await?;
    if restart::is_pending(&app, &client)? {
        return Err(
            "Use Finish recovery setup on this device to continue the interrupted setup.".into(),
        );
    }
    if let Some(key) = state.encryption.pending_key.lock().await.as_ref() {
        return Ok(key.clone());
    }
    let password = password.map(zeroize::Zeroizing::new);
    prepare_recovery_setup(
        &client,
        &state.encryption,
        password.as_ref().map(|p| p.as_str()),
    )
    .await?;
    mark_key_needs_save(&app, &client, &state.encryption)?;
    let key = client
        .encryption()
        .recovery()
        .enable()
        .await
        .map_err(|e| format!("Could not set up recovery: {}", fmt_error_chain(&e)))?;
    *state.encryption.pending_key.lock().await = Some(key.clone());
    Ok(key)
}

#[tauri::command]
pub async fn acknowledge_encryption_recovery_key(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    clear_key_reminder(&app, &client, &state.encryption)?;
    state.encryption.pending_key.lock().await.take();
    Ok(())
}

#[tauri::command]
pub async fn restore_encryption_recovery(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    recovery_key: String,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    let key = recovery_key.trim();
    if key.is_empty() {
        return Err("Enter your recovery key or recovery passphrase.".into());
    }
    client
        .encryption()
        .recovery()
        .recover(key)
        .await
        .map_err(|e| {
            format!(
                "Could not unlock recovery. Check your key and connection. {}",
                fmt_error_chain(&e)
            )
        })?;
    clear_key_reminder(&app, &client, &state.encryption)?;
    state.encryption.pending_key.lock().await.take();
    Ok(())
}

/// This changes only the recovery key; it preserves the identity and room-key
/// backup. Called only after the user explicitly chooses to replace the key.
#[tauri::command]
pub async fn replace_encryption_recovery_key(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let _operation = state.encryption.operation.lock().await;
    if *state.account_mode.lock().await == super::pax_auth::AccountMode::Pax {
        return Err("Pax sign-in manages your recovery key automatically. Replacing it here would prevent password-based history recovery.".into());
    }
    let client = get_client(&state).await?;
    let current = status(&client, &state.encryption).await?;
    if !current.cross_signing_ready || !current.backup_enabled {
        return Err("Unlock recovery on this device before creating a new recovery key.".into());
    }
    if let Some(key) = state.encryption.pending_key.lock().await.as_ref() {
        return Ok(key.clone());
    }
    mark_key_needs_save(&app, &client, &state.encryption)?;
    let key = client
        .encryption()
        .recovery()
        .reset_key()
        .await
        .map_err(|e| {
            format!(
                "Could not create a new recovery key: {}",
                fmt_error_chain(&e)
            )
        })?;
    *state.encryption.pending_key.lock().await = Some(key.clone());
    Ok(key)
}

async fn run_backup(client: &Client, progress: &Mutex<BackupProgress>, app: &tauri::AppHandle) {
    let backups = client.encryption().backups();
    let upload = backups.wait_for_steady_state();
    let updates = upload.subscribe_to_progress();
    let upload = upload.into_future();
    futures_util::pin_mut!(updates);
    let result = timeout(Duration::from_secs(30), async {
        tokio::pin!(upload);
        loop {
            tokio::select! {
                result = &mut upload => return result.map_err(|e| fmt_error_chain(&e)),
                update = updates.next() => {
                    if let Some(Ok(UploadState::Uploading(counts))) = update {
                        *progress.lock().await = BackupProgress {
                            state: "uploading".into(), backed_up: Some(counts.backed_up),
                            total: Some(counts.total), error: None,
                        };
                        let _ = app.emit("encryption-status-changed", ());
                    }
                }
            }
        }
    })
    .await;
    *progress.lock().await = match result {
        Ok(Ok(())) => BackupProgress {
            state: "complete".into(),
            ..Default::default()
        },
        Ok(Err(error)) => BackupProgress {
            state: "error".into(),
            error: Some(error),
            ..Default::default()
        },
        Err(_) => BackupProgress {
            state: "error".into(),
            error: Some(
                "Backup is taking longer than expected. Pax will retry while you're signed in."
                    .into(),
            ),
            ..Default::default()
        },
    };
    let _ = app.emit("encryption-status-changed", ());
}

#[tauri::command]
pub async fn sync_encryption_backup(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    let _backup = state.encryption.backup_operation.lock().await;
    if !client.encryption().backups().are_enabled().await {
        return Err("Set up or unlock recovery before backing up keys.".into());
    }
    run_backup(&client, &state.encryption.progress, &app).await;
    let progress = state.encryption.progress.lock().await;
    if let Some(error) = &progress.error {
        return Err(error.clone());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationStatus {
    flow_id: String,
    identity_change_id: Option<String>,
    state: String,
    emojis: Vec<(String, String)>,
    decimals: Option<(u16, u16, u16)>,
}

#[tauri::command]
pub async fn request_encryption_verification(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    let identity = client
        .encryption()
        .request_user_identity(client.user_id().ok_or("Not logged in")?)
        .await
        .map_err(|e| fmt_error_chain(&e))?
        .ok_or(
            "No encryption identity exists yet. Set up recovery on your original device first.",
        )?;
    let master_key = identity::master_key(&identity);
    let identity_change_id = identity::current(&app, &client)
        .await?
        .and_then(|change| change.id_for_key(master_key.as_deref()));
    let mut active = state.encryption.verification.lock().await;
    if active.as_ref().is_some_and(|entry| {
        !entry.request.is_done()
            && !entry.request.is_cancelled()
            && !entry.identity_changed(master_key.as_deref())
    }) {
        return Ok(());
    }
    let request = identity
        .request_verification_with_methods(vec![VerificationMethod::SasV1])
        .await
        .map_err(|e| fmt_error_chain(&e))?;
    *active = Some(ActiveVerification {
        request,
        master_key,
        identity_change_id,
    });
    *state.encryption.confirmed_flow.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn get_encryption_verification(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<VerificationStatus>, String> {
    let _operation = state.encryption.operation.lock().await;
    let active = state.encryption.verification.lock().await.clone();
    let Some(active) = active else {
        return Ok(None);
    };
    let request = &active.request;
    let mut result = VerificationStatus {
        flow_id: request.flow_id().into(),
        identity_change_id: active.identity_change_id.clone(),
        state: "waiting".into(),
        emojis: vec![],
        decimals: None,
    };
    let client = get_client(&state).await?;
    let master_key = identity::cached_master_key(&client).await?;
    if request.is_passive() || active.identity_changed(master_key.as_deref()) {
        result.state = "cancelled".into();
        return Ok(Some(result));
    }
    match request.state() {
        VerificationRequestState::Requested { .. } => result.state = "requested".into(),
        VerificationRequestState::Ready { .. } => {
            if request.we_started() {
                request.start_sas().await.map_err(|e| fmt_error_chain(&e))?;
            }
        }
        VerificationRequestState::Transitioned { verification } => {
            if let Some(sas) = verification.sas() {
                sas.accept().await.map_err(|e| fmt_error_chain(&e))?;
                result.state = if sas.is_done() {
                    "done"
                } else if sas.is_cancelled() {
                    "cancelled"
                } else if state.encryption.confirmed_flow.lock().await.as_deref()
                    == Some(request.flow_id())
                {
                    "confirmed"
                } else if sas.can_be_presented() {
                    "comparing"
                } else {
                    "waiting"
                }
                .into();
                result.emojis = sas
                    .emoji()
                    .map(|emojis| {
                        emojis
                            .into_iter()
                            .map(|e| (e.symbol.into(), e.description.into()))
                            .collect()
                    })
                    .unwrap_or_default();
                result.decimals = sas.decimals();
            }
        }
        VerificationRequestState::Done => result.state = "done".into(),
        VerificationRequestState::Cancelled(_) => result.state = "cancelled".into(),
        _ => {}
    }
    Ok(Some(result))
}

#[tauri::command]
pub async fn respond_encryption_verification(
    state: State<'_, Arc<AppState>>,
    flow_id: String,
    action: String,
) -> Result<(), String> {
    let _operation = state.encryption.operation.lock().await;
    let active = state
        .encryption
        .verification
        .lock()
        .await
        .clone()
        .ok_or("No verification is active")?;
    let request = active.request.clone();
    if request.flow_id() != flow_id {
        return Err("This verification is no longer active.".into());
    }
    if action != "cancel" {
        let client = get_client(&state).await?;
        let master_key = identity::cached_master_key(&client).await?;
        if active.identity_changed(master_key.as_deref()) {
            return Err("Your encryption identity changed again. Start a new verification.".into());
        }
    }
    match action.as_str() {
        "accept" => {
            request
                .accept_with_methods(vec![VerificationMethod::SasV1])
                .await
        }
        "cancel" => request.cancel().await,
        "confirm" | "mismatch" => {
            let VerificationRequestState::Transitioned { verification } = request.state() else {
                return Err("Verification is not ready to compare yet.".into());
            };
            let sas = verification
                .sas()
                .ok_or("This verification method is not supported")?;
            if !sas.can_be_presented() {
                return Err("Wait until both devices show the comparison.".into());
            }
            if action == "mismatch" {
                sas.mismatch().await
            } else {
                sas.confirm().await.map_err(|e| fmt_error_chain(&e))?;
                *state.encryption.confirmed_flow.lock().await = Some(flow_id);
                return Ok(());
            }
        }
        _ => return Err("Unknown verification action".into()),
    }
    .map_err(|e| fmt_error_chain(&e))
}

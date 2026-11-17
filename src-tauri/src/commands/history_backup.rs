//! Offline, encrypted room-key snapshots. These operations never reset an
//! identity, change Secret Storage, or create/replace a server-side backup.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use matrix_sdk::Client;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

use super::get_client;
use crate::AppState;

// Keep the file-input limit in HistoryBackupPanel.tsx in sync. The SDK imports
// the entire archive in memory, so bound both exported and imported files.
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMPORT_ROUNDS: u32 = 2_000_000;
const HEADER: &str = "-----BEGIN MEGOLM SESSION DATA-----";
const FOOTER: &str = "-----END MEGOLM SESSION DATA-----";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryExport {
    pub saved_path: String,
    pub key_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImport {
    pub imported_count: usize,
    pub total_count: usize,
    #[serde(skip)]
    rooms: Vec<String>,
}

/// Only ciphertext is ever written here. A private directory and pre-created
/// mode-0600 file also keep partially written archives private on Unix.
struct WorkingArchive {
    directory: PathBuf,
    path: PathBuf,
}
impl WorkingArchive {
    fn new(parent: &Path) -> Result<Self, String> {
        let directory = parent.join(format!(".pax-history-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| "Could not create a temporary encrypted backup file.")?;
        let archive = Self {
            path: directory.join("keys.txt"),
            directory,
        };
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&archive.path)
            .map_err(|_| "Could not create a temporary encrypted backup file.")?;
        Ok(archive)
    }
}
impl Drop for WorkingArchive {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

async fn export_to_directory(
    client: &Client,
    directory: &Path,
    passphrase: &str,
) -> Result<HistoryExport, String> {
    if passphrase.chars().count() < 12 {
        return Err("Choose a backup password of at least 12 characters.".into());
    }
    fs::create_dir_all(directory).map_err(|_| "Could not open your Downloads folder.")?;
    let working = WorkingArchive::new(directory)?;
    let mut key_count = 0;
    client
        .encryption()
        .export_room_keys(working.path.clone(), passphrase, |_| {
            key_count += 1;
            true
        })
        .await
        .map_err(|_| {
            "Could not export this device's message keys. The original keys have been preserved."
        })?;
    if key_count == 0 {
        return Err("No message keys are stored on this device yet. Open an encrypted conversation on this device and try again.".into());
    }
    let size = fs::metadata(&working.path)
        .map_err(|_| "Could not read the encrypted backup.")?
        .len();
    if size > MAX_ARCHIVE_BYTES as u64 {
        return Err("This encrypted backup exceeds the current 64 MiB file limit. No message keys have been removed.".into());
    }
    let path = directory.join(format!("pax-history-{}.txt", uuid::Uuid::new_v4()));
    let source = working.path.clone();
    let destination = path.clone();
    tokio::task::spawn_blocking(move || {
        // Reserve a fresh name; never overwrite an earlier backup. Only the
        // already encrypted SDK export is copied to the final destination.
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&destination)
            .map_err(|_| "Could not save the encrypted backup in Downloads.")?;
        let result = (|| -> std::io::Result<()> {
            std::io::copy(&mut fs::File::open(source)?, &mut file)?;
            file.flush()?;
            file.sync_all()
        })();
        if result.is_err() {
            drop(file);
            let _ = fs::remove_file(&destination);
        }
        result.map_err(|_| "Could not finish saving the encrypted backup. Try again.".to_string())
    })
    .await
    .map_err(|_| "Saving the encrypted backup was interrupted.".to_string())??;
    Ok(HistoryExport {
        saved_path: path.to_string_lossy().into_owned(),
        key_count,
    })
}

/// Validate framing and bound unauthenticated KDF parameters before asking the
/// SDK to decrypt. Authentication, decryption and key import remain SDK work.
fn validate_archive(contents: &str) -> Result<String, String> {
    if contents.len() > MAX_ARCHIVE_BYTES {
        return Err("Choose an encrypted backup file smaller than 64 MiB.".into());
    }
    let payload = contents.trim().strip_prefix(HEADER).and_then(|s| s.strip_suffix(FOOTER))
        .ok_or("Choose a Matrix encrypted message-key backup file, such as one exported by Pax or Element.")?;
    let payload: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let bytes = STANDARD_NO_PAD
        .decode(&payload)
        .or_else(|_| STANDARD.decode(&payload))
        .map_err(|_| "The encrypted backup file is damaged or has an unsupported format.")?;
    // Version 1: version(1), salt(16), IV(16), PBKDF2 rounds(4), ciphertext,
    // and an HMAC-SHA256 tag(32). Never accept plaintext room-key JSON.
    if bytes.len() < 69 || bytes[0] != 1 {
        return Err("The encrypted backup file is damaged or has an unsupported format.".into());
    }
    let rounds = u32::from_be_bytes(bytes[33..37].try_into().unwrap());
    if rounds == 0 || rounds > MAX_IMPORT_ROUNDS {
        return Err("This backup uses unsupported password-hardening parameters. Import it using the app that created it.".into());
    }
    Ok(format!("{HEADER}\n{payload}\n{FOOTER}"))
}

async fn import_contents(
    client: &Client,
    contents: &str,
    passphrase: &str,
) -> Result<HistoryImport, String> {
    if passphrase.is_empty() {
        return Err("Enter the password for this encrypted backup file.".into());
    }
    let contents = validate_archive(contents)?;
    let working = WorkingArchive::new(&std::env::temp_dir())?;
    fs::write(&working.path, contents).map_err(|_| "Could not open the encrypted backup file.")?;
    let imported = client.encryption().import_room_keys(working.path.clone(), passphrase).await
        .map_err(|_| "Could not import this backup. Check its password and that the file is complete. Existing message keys have been preserved.")?;
    Ok(HistoryImport {
        imported_count: imported.imported_count,
        total_count: imported.total_count,
        rooms: imported.keys.keys().map(ToString::to_string).collect(),
    })
}

#[tauri::command]
pub async fn export_available_history(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    passphrase: String,
    expected_user_id: String,
) -> Result<HistoryExport, String> {
    let passphrase = Zeroizing::new(passphrase);
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    require_account(&client, &expected_user_id)?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|_| "Could not find your Downloads folder.")?;
    export_to_directory(&client, &downloads, &passphrase).await
}

#[tauri::command]
pub async fn import_available_history(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    contents: String,
    passphrase: String,
    expected_user_id: String,
) -> Result<HistoryImport, String> {
    let passphrase = Zeroizing::new(passphrase);
    let _operation = state.encryption.operation.lock().await;
    let client = get_client(&state).await?;
    require_account(&client, &expected_user_id)?;
    let result = import_contents(&client, &contents, &passphrase).await?;
    if result.imported_count > 0 {
        let _ = app.emit("encryption-keys-received", &result.rooms);
    }
    Ok(result)
}

fn require_account(client: &Client, expected: &str) -> Result<(), String> {
    if !client
        .user_id()
        .is_some_and(|user| user.as_str() == expected)
    {
        return Err("The signed-in account changed. Open Encryption settings again before backing up or restoring history.".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "history_backup_tests.rs"]
mod tests;

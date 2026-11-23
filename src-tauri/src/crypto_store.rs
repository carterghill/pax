//! The crypto store has its own directory so state, media, and event caches can
//! keep their existing layout. The session directory and device ID stay stable.

mod migration;
#[cfg(test)]
mod tests;
mod vault;

#[cfg(target_os = "android")]
pub(crate) use vault::initialize_android;

use std::{
    fs::{self, File},
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
};

use matrix_sdk::config::StoreConfig;
use matrix_sdk_sqlite::{
    SqliteCryptoStore, SqliteEventCacheStore, SqliteMediaStore, SqliteStateStore,
};

const DATABASE: &str = "matrix-sdk-crypto.sqlite3";
const PROTECTED: &str = "protected-crypto";
const STAGING: &str = ".crypto-migration";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenMode {
    Migrate,
    DeferMigration,
    Existing,
}

pub(crate) fn session_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid Matrix store path.".into());
    }
    let mut path = base.to_path_buf();
    for part in relative.components() {
        path.push(part);
        if present(&path, true)? {
            continue;
        }
        break;
    }
    Ok(base.join(relative))
}

fn present(path: &Path, directory: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if if directory {
                meta.is_dir()
            } else {
                meta.is_file()
            } =>
        {
            Ok(true)
        }
        Ok(_) => Err("The Matrix store contains an unexpected file or directory.".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect the Matrix store: {error}")),
    }
}

pub(crate) fn has_legacy_store(root: &Path) -> Result<bool, String> {
    present(&root.join(DATABASE), false)
}

async fn open_crypto(
    base: &Path,
    root: &Path,
    mode: OpenMode,
) -> Result<SqliteCryptoStore, String> {
    open_crypto_with(base, root, mode, vault::load).await
}

async fn open_crypto_with(
    base: &Path,
    root: &Path,
    mode: OpenMode,
    load_key: fn(&Path, bool) -> Result<vault::Key, String>,
) -> Result<SqliteCryptoStore, String> {
    let lock_path = base.join(".matrix-store.lock");
    let lock = tokio::task::spawn_blocking(move || -> Result<File, String> {
        let file = File::options()
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| format!("Could not open the Matrix store lock: {error}"))?;
        file.lock()
            .map_err(|error| format!("Could not lock the Matrix store: {error}"))?;
        Ok(file)
    })
    .await
    .map_err(|_| "Could not lock the Matrix store.")??;

    let protected = root.join(PROTECTED);
    let legacy_exists = has_legacy_store(root)?;
    let protected_exists = present(&protected, true)?;

    if !protected_exists && mode != OpenMode::Migrate {
        if legacy_exists {
            return SqliteCryptoStore::open(root, None)
                .await
                .map_err(store_error);
        }
        if mode == OpenMode::Existing {
            return Err("The Matrix device store is missing.".into());
        }
    }

    let key_base = base.to_owned();
    let (key, lock) = tokio::task::spawn_blocking(move || {
        Ok::<_, String>((load_key(&key_base, !protected_exists)?, lock))
    })
    .await
    .map_err(|_| "Could not read the local Matrix store key.")??;

    if !protected_exists {
        let staging = root.join(STAGING);
        if present(&staging, true)? {
            retry_store_file_operation(|| fs::remove_dir_all(&staging))
                .await
                .map_err(|error| {
                    format!("Could not clear an unfinished Matrix store migration: {error}")
                })?;
        }
        if legacy_exists {
            log::info!("Migrating the local Matrix crypto store");
            // Upgrade old SDK schemas through the SDK before copying their records.
            drop(
                SqliteCryptoStore::open(root, None)
                    .await
                    .map_err(store_error)?,
            );
        }
        drop(
            SqliteCryptoStore::open_with_key(&staging, Some(&key))
                .await
                .map_err(store_error)?,
        );
        let (source, target) = (root.join(DATABASE), staging.join(DATABASE));
        let (key, _lock) = tokio::task::spawn_blocking(move || {
            if legacy_exists {
                migration::copy_and_verify(&source, &target, &key)?;
            }
            Ok::<_, String>((key, lock))
        })
        .await
        .map_err(|_| "Local Matrix store migration was interrupted.")??;
        // Verify that a fresh SDK store can open the copied database before publishing it.
        drop(
            SqliteCryptoStore::open_with_key(&staging, Some(&key))
                .await
                .map_err(store_error)?,
        );
        retry_store_file_operation(|| fs::rename(&staging, &protected))
            .await
            .map_err(|error| format!("Could not publish the encrypted Matrix store: {error}"))?;
        sync_directory(root)?;
        return open_protected(root, &protected, &key, legacy_exists).await;
    }

    if !present(&protected.join(DATABASE), false)? {
        return Err("The encrypted Matrix crypto store is missing.".into());
    }
    let _lock = lock;
    open_protected(
        root,
        &protected,
        &key,
        legacy_exists && mode == OpenMode::Migrate,
    )
    .await
}

async fn open_protected(
    root: &Path,
    protected: &Path,
    key: &vault::Key,
    retire_legacy: bool,
) -> Result<SqliteCryptoStore, String> {
    migration::verify_store_key(&protected.join(DATABASE), key)?;
    let store = SqliteCryptoStore::open_with_key(protected, Some(key))
        .await
        .map_err(store_error)?;
    if retire_legacy {
        // Remove the main database last so an interrupted cleanup is retried.
        for file in [
            "matrix-sdk-crypto.sqlite3-wal",
            "matrix-sdk-crypto.sqlite3-shm",
            "matrix-sdk-crypto.sqlite3-journal",
            DATABASE,
        ] {
            match retry_store_file_operation(|| fs::remove_file(root.join(file))).await {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not remove the old Matrix crypto store: {error}"
                    ))
                }
            }
        }
        sync_directory(root)?;
    }
    Ok(store)
}

async fn retry_store_file_operation<T>(
    mut operation: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    use tokio::time::{sleep, Duration, Instant};

    // The SDK's connection pool closes SQLite handles on background threads
    // after the store is dropped. Windows cannot rename or remove their files
    // until those handles close. Keep the migration lock while waiting, and
    // bound retries so a persistent permissions problem still reaches the user.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match operation() {
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && Instant::now() < deadline =>
            {
                sleep(Duration::from_millis(25)).await;
            }
            result => return result,
        }
    }
}

fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(store_error)?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn store_error(error: impl std::fmt::Display) -> String {
    format!("Could not open or protect the local Matrix store: {error}")
}

pub(crate) async fn config(
    base: &Path,
    root: &Path,
    mode: OpenMode,
) -> Result<StoreConfig, String> {
    let crypto = open_crypto(base, root, mode).await?;
    Ok(StoreConfig::new("main".into())
        .state_store(
            SqliteStateStore::open(root, None)
                .await
                .map_err(store_error)?,
        )
        .event_cache_store(
            SqliteEventCacheStore::open(root, None)
                .await
                .map_err(store_error)?,
        )
        .media_store(
            SqliteMediaStore::open(root, None)
                .await
                .map_err(store_error)?,
        )
        .crypto_store(crypto))
}

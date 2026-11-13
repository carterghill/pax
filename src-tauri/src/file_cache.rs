//! Keyed file storage, persistence, and duplicate-load coordination.
//!
//! Persistent stores keep an index.json; temporary stores have no disk index.
//! Content identity, fetching, concurrency limits, and eviction policy belong
//! to callers. Files created here are published atomically.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use tokio::sync::{Mutex, Notify};

pub static TEMP_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn temp_dir() -> PathBuf {
    TEMP_DIR.get().cloned().unwrap_or_else(std::env::temp_dir)
}

/// Filename that holds the MXC → relative-filename mapping, inside the
/// persistent directory. Plain JSON, written atomically via rename.
const INDEX_FILENAME: &str = "index.json";
const TMP_INDEX_FILENAME: &str = "index.json.tmp";
/// How long we wait after a dirty-marking notification before flushing
/// the index to disk. Coalesces burst writes (batch member fetches
/// call `insert` tens of times back-to-back).
const PERSIST_DEBOUNCE_MS: u64 = 250;

#[derive(Debug)]
pub struct FileCache {
    /// Set by `init_with_dir`. While unset, the cache works entirely
    /// in-memory — useful for the window between AppState construction
    /// and the Tauri `setup` hook running, and as a graceful fallback
    /// if `app_cache_dir()` is unavailable on some exotic platform.
    dir: OnceLock<PathBuf>,
    entries: Mutex<HashMap<String, String>>,
    /// Flipped by any write; cleared by the persist task when it
    /// flushes. A separate flag (rather than "persist every write")
    /// lets a burst of N inserts coalesce into one index.json write.
    dirty: AtomicBool,
    /// Wakes the persist task after a write.
    wake: Notify,
    generation: AtomicU64,
    /// Serializes file publication, index persistence, and clearing.
    io: Mutex<()>,
    loads: StdMutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl FileCache {
    pub fn new() -> Self {
        Self {
            dir: OnceLock::new(),
            entries: Mutex::new(HashMap::new()),
            dirty: AtomicBool::new(false),
            wake: Notify::new(),
            generation: AtomicU64::new(0),
            io: Mutex::new(()),
            loads: StdMutex::new(HashMap::new()),
        }
    }

    /// Directory the cache is persisting to, if initialised.
    pub fn dir(&self) -> Option<PathBuf> {
        self.dir.get().cloned()
    }

    /// Configure a temporary store without hydrating or starting persistence.
    /// Returns true only for the first initialization.
    pub(crate) async fn init_temporary_dir(&self, dir: PathBuf) -> std::io::Result<bool> {
        tokio::fs::create_dir_all(&dir).await?;
        let dir = tokio::fs::canonicalize(dir).await?;
        Ok(self.dir.set(dir).is_ok())
    }

    /// Invalidate pending fills while leaving published files available to
    /// callers that still hold them. Retention policy decides which to delete.
    pub(crate) fn invalidate_loads(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Point the cache at a persistent directory, hydrate the
    /// in-memory map from its `index.json`, and spawn the background
    /// persist task. Idempotent: the first successful call wins;
    /// later calls are no-ops.
    pub async fn init_with_dir(self: Arc<Self>, dir: PathBuf) -> std::io::Result<()> {
        if self.dir.get().is_some() {
            return Ok(());
        }
        std::fs::create_dir_all(&dir)?;
        // `set` returns Err if the value was already set (lost the
        // race with another init). That's fine — we just continue
        // with the already-set dir.
        if self.dir.set(dir).is_err() {
            return Ok(());
        }

        self.hydrate_from_disk().await;

        let task_self = Arc::clone(&self);
        tokio::spawn(async move {
            task_self.persist_loop().await;
        });

        Ok(())
    }

    async fn hydrate_from_disk(&self) {
        let dir = match self.dir.get() {
            Some(d) => d.clone(),
            None => return,
        };
        let idx_path = dir.join(INDEX_FILENAME);
        let bytes = match std::fs::read(&idx_path) {
            Ok(b) => b,
            // Missing is fine on first run; anything else we just log
            // and start empty rather than panic.
            Err(_) => return,
        };
        let rel_map: HashMap<String, String> = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[file_cache] index.json parse failed ({e}); starting fresh");
                return;
            }
        };

        let mut entries = self.entries.lock().await;
        let mut kept = 0usize;
        let mut dropped = 0usize;
        for (mxc, rel) in rel_map {
            // Reject absolute paths and `..` traversals — we only
            // ever wrote plain filenames, and anything else would
            // mean the index was tampered with.
            let rel_path = Path::new(&rel);
            if rel_path.is_absolute()
                || rel_path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                dropped += 1;
                continue;
            }
            let full = dir.join(rel_path);
            if !full.is_file() {
                dropped += 1;
                continue;
            }
            match full.to_str() {
                Some(s) => {
                    entries.insert(mxc, s.to_string());
                    kept += 1;
                }
                None => dropped += 1,
            }
        }
        if kept > 0 || dropped > 0 {
            log::info!(
                "[file_cache] Hydrated {kept} entries from disk ({dropped} stale / invalid entries dropped)"
            );
        }
    }

    pub async fn get(&self, key: &str) -> Option<String> {
        self.entries.lock().await.get(key).cloned()
    }

    /// Return only a usable file. Legacy data URLs and deleted files are misses.
    pub async fn get_file(&self, key: &str) -> Option<String> {
        let path = self.get(key).await?;
        if !path.starts_with("data:") && tokio::fs::try_exists(&path).await.unwrap_or(false) {
            Some(path)
        } else {
            None
        }
    }

    /// One active fill per key; cancellation releases the lock for another caller.
    /// The loader supplies the bytes and extension, keeping content policy outside
    /// the cache. Failed loads never become successful or empty cache entries.
    pub async fn get_or_load(
        &self,
        key: &str,
        fetch: impl std::future::Future<Output = Result<(Vec<u8>, &'static str), String>>,
    ) -> Result<String, String> {
        let generation = self.generation.load(Ordering::Acquire);
        let key_lock = {
            let mut loads = self.loads.lock().unwrap();
            loads.retain(|_, lock| lock.strong_count() > 0);
            match loads.get(key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    loads.insert(key.to_owned(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let _load = key_lock.lock().await;
        if generation != self.generation.load(Ordering::Acquire) {
            return Err("Cache cleared during load".into());
        }
        if let Some(path) = self.get_file(key).await {
            return Ok(path);
        }
        let (bytes, ext) = fetch.await?;
        let _io = self.io.lock().await;
        if generation != self.generation.load(Ordering::Acquire) {
            return Err("Cache cleared during load".into());
        }
        let dir = self.dir().unwrap_or_else(temp_dir);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        let path = dir.join(Self::filename_for_key(key, ext));
        let staging = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&staging, bytes)
            .await
            .map_err(|e| e.to_string())?;
        if generation != self.generation.load(Ordering::Acquire) {
            let _ = tokio::fs::remove_file(staging).await;
            return Err("Cache cleared during load".into());
        }
        if let Err(e) = tokio::fs::rename(&staging, &path).await {
            let _ = tokio::fs::remove_file(staging).await;
            return Err(e.to_string());
        }
        let path = path.to_string_lossy().into_owned();
        self.insert(key.to_owned(), path.clone()).await;
        Ok(path)
    }

    pub async fn insert(&self, key: String, value: String) {
        {
            let mut entries = self.entries.lock().await;
            entries.insert(key, value);
        }
        self.mark_dirty();
    }

    /// Delete a published, owned file and its index entry. Failed unlinks keep
    /// the entry so callers can account for disk usage and retry eviction.
    pub(crate) async fn discard(&self, key: &str) -> Result<bool, String> {
        let _io = self.io.lock().await;
        let Some(path) = self.get(key).await else {
            return Ok(false);
        };
        if Path::new(&path).parent() != self.dir.get().map(PathBuf::as_path) {
            return Err("Refusing to delete a file outside the cache directory".into());
        }
        let removed = match tokio::fs::remove_file(&path).await {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        self.entries.lock().await.remove(key);
        self.mark_dirty();
        Ok(removed)
    }

    /// Snapshot the current map. The returned `HashMap` is
    /// disconnected from the live cache — callers that read many
    /// entries back-to-back (batch member resolution) use this so
    /// they don't hold the mutex across a large loop.
    pub async fn snapshot(&self) -> HashMap<String, String> {
        self.entries.lock().await.clone()
    }

    /// Wipe in-memory state, wipe every file inside the persistent directory,
    /// delete `index.json`. Callers must release active readers first.
    pub async fn clear(&self) {
        self.invalidate_loads();
        let _io = self.io.lock().await;
        self.entries.lock().await.clear();
        self.mark_dirty();
        if let Some(dir) = self.dir.get() {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
        self.wake.notify_one();
    }

    async fn persist_loop(self: Arc<Self>) {
        loop {
            self.wake.notified().await;
            // Coalesce further writes that arrive in the debounce
            // window — one disk write per burst of updates, not one
            // per insert.
            tokio::time::sleep(Duration::from_millis(PERSIST_DEBOUNCE_MS)).await;
            if !self.dirty.swap(false, Ordering::Relaxed) {
                continue;
            }
            if let Err(e) = self.persist_now().await {
                log::warn!("[file_cache] persist failed: {e}");
                // Restore the dirty bit so the next wake retries.
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    async fn persist_now(&self) -> std::io::Result<()> {
        let _io = self.io.lock().await;
        let dir = match self.dir.get() {
            Some(d) => d.clone(),
            None => return Ok(()),
        };

        // Build the serialisable form (relative filenames) under the
        // lock, then release it before doing any I/O. We don't want
        // to block inserts while we write to disk.
        let snapshot = {
            let entries = self.entries.lock().await;
            let mut rel_map: HashMap<String, String> = HashMap::with_capacity(entries.len());
            for (mxc, value) in entries.iter() {
                // Persistence filter:
                //  - `data:` URLs (legacy knock-member thumbnails) are
                //    always ephemeral.
                //  - External paths are never owned by this store.
                if value.starts_with("data:") {
                    continue;
                }
                let p = Path::new(value);
                let Ok(rel) = p.strip_prefix(&dir) else {
                    continue;
                };
                if let Some(rel_str) = rel.to_str() {
                    rel_map.insert(mxc.clone(), rel_str.to_string());
                }
            }
            rel_map
        };

        let bytes = serde_json::to_vec_pretty(&snapshot)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        let tmp_path = dir.join(TMP_INDEX_FILENAME);
        let idx_path = dir.join(INDEX_FILENAME);

        tokio::fs::write(&tmp_path, &bytes).await?;
        tokio::fs::rename(&tmp_path, &idx_path).await?;
        Ok(())
    }

    /// Deterministic filename for a content key and extension.
    /// Uses the existing UUID-v5 scheme so persisted files remain reusable.
    pub fn filename_for_key(key: &str, ext: &str) -> String {
        let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, key.as_bytes());
        format!("{}.{}", id.as_simple(), ext)
    }
}

impl Default for FileCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    pub(crate) struct TestDir(pub PathBuf);

    impl TestDir {
        pub(crate) fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pax-cache-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn cache(dir: &TestDir) -> Arc<FileCache> {
        let cache = Arc::new(FileCache::new());
        cache.dir.set(dir.0.clone()).unwrap();
        cache
    }

    #[tokio::test]
    async fn concurrent_requests_fill_the_same_file_once() {
        let dir = TestDir::new();
        let cache = cache(&dir);
        let calls = AtomicUsize::new(0);
        let fill = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok((b"image".to_vec(), "png"))
        };
        let (first, second) = tokio::join!(
            cache.get_or_load("same", fill()),
            cache.get_or_load("same", fill())
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_slow_key_does_not_block_other_files_or_cache_reads() {
        let dir = TestDir::new();
        let cache = cache(&dir);
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let slow_cache = cache.clone();
        let slow = tokio::spawn(async move {
            slow_cache
                .get_or_load("slow", async {
                    started.send(()).unwrap();
                    wait.await.unwrap();
                    Ok((vec![1], "png"))
                })
                .await
        });
        ready.await.unwrap();
        assert!(cache.get_file("slow").await.is_none());
        let fast = tokio::time::timeout(
            Duration::from_secs(1),
            cache.get_or_load("fast", async { Ok((vec![2], "png")) }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(tokio::fs::read(fast).await.unwrap(), vec![2]);
        release.send(()).unwrap();
        slow.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn failure_and_external_deletion_can_be_retried() {
        let dir = TestDir::new();
        let cache = cache(&dir);
        assert!(cache
            .get_or_load("retry", async { Err("offline".into()) })
            .await
            .is_err());
        assert!(cache.get("retry").await.is_none());
        let path = cache
            .get_or_load("retry", async { Ok((vec![1], "png")) })
            .await
            .unwrap();
        tokio::fs::remove_file(&path).await.unwrap();
        assert!(cache.get_file("retry").await.is_none());
        cache
            .get_or_load("retry", async { Ok((vec![2], "png")) })
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(path).await.unwrap(), vec![2]);
    }

    #[tokio::test]
    async fn clear_rejects_an_inflight_fill() {
        let dir = TestDir::new();
        let cache = cache(&dir);
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let old_cache = cache.clone();
        let old = tokio::spawn(async move {
            old_cache
                .get_or_load("old-session", async {
                    started.send(()).unwrap();
                    wait.await.unwrap();
                    Ok((vec![1], "png"))
                })
                .await
        });
        ready.await.unwrap();
        cache.clear().await;
        release.send(()).unwrap();
        assert!(old.await.unwrap().is_err());
        assert!(cache.get("old-session").await.is_none());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn persistence_restores_owned_files_and_excludes_external_paths() {
        let dir = TestDir::new();
        let cache = cache(&dir);
        let path = cache
            .get_or_load("avatar", async { Ok((vec![1], "png")) })
            .await
            .unwrap();
        cache
            .insert(
                "attachment".into(),
                "/outside/persistent-directory.png".into(),
            )
            .await;
        cache.persist_now().await.unwrap();
        let restored = FileCache::new();
        restored.dir.set(dir.0.clone()).unwrap();
        restored.hydrate_from_disk().await;
        assert_eq!(restored.get_file("avatar").await, Some(path));
        assert!(restored.get("attachment").await.is_none());
    }

    #[tokio::test]
    async fn discard_deletes_only_owned_files() {
        let dir = TestDir::new();
        let other = TestDir::new();
        let cache = cache(&dir);
        let owned = cache
            .get_or_load("owned", async { Ok((vec![1], "bin")) })
            .await
            .unwrap();
        assert!(cache.discard("owned").await.unwrap());
        assert!(!Path::new(&owned).exists());
        assert!(cache.get("owned").await.is_none());
        let external = other.0.join("saved.bin");
        tokio::fs::write(&external, [2]).await.unwrap();
        cache
            .insert("external".into(), external.to_string_lossy().into_owned())
            .await;
        assert!(cache.discard("external").await.is_err());
        assert!(external.is_file());
        assert!(cache.get("external").await.is_some());
    }

    #[tokio::test]
    async fn failed_eviction_keeps_the_entry_and_a_missing_file_can_be_forgotten() {
        let dir = TestDir::new();
        let cache = cache(&dir);
        let path = dir.0.join("not-a-regular-file");
        tokio::fs::create_dir(&path).await.unwrap();
        cache
            .insert("retry".into(), path.to_string_lossy().into_owned())
            .await;
        assert!(cache.discard("retry").await.is_err());
        assert!(cache.get("retry").await.is_some());
        tokio::fs::remove_dir(path).await.unwrap();
        assert!(!cache.discard("retry").await.unwrap());
        assert!(cache.get("retry").await.is_none());
    }
}

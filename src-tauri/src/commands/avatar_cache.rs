//! Persistent disk cache for Matrix avatars and media paths.
//!
//! Replaces the in-memory `HashMap<String, String>` that previously
//! lived on `AppState::avatar_cache`. The in-memory map is still the
//! fast lookup path, but entries whose values point into the
//! persistent avatar directory are mirrored to an on-disk `index.json`
//! so they survive app restart. File bytes are written with
//! deterministic UUID-v5 filenames, so the same MXC URI always maps
//! to the same path on disk and the disk-cached file is reusable
//! across sessions.
//!
//! Entries whose values are `data:` URLs (legacy knock-member
//! thumbnails) or point at the Tauri temp dir (inline matrix media
//! files with `mmedia:` keys) are kept in memory only — they were
//! already session-scoped by design and flushing them to disk would
//! just bloat the cache.
//!
//! Why this exists: without disk persistence, every warm restart had
//! to re-render the sidebar with `avatarUrl = null` (stripped on
//! persist because paths pointed into the now-wiped temp dir), which
//! produced the frame-or-two flash of initials before the first
//! `get_rooms` / `get_user_avatars` response landed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};

/// Filename that holds the MXC → relative-filename mapping, inside the
/// avatar dir. Plain JSON, written atomically via rename.
const INDEX_FILENAME: &str = "index.json";
const TMP_INDEX_FILENAME: &str = "index.json.tmp";
/// How long we wait after a dirty-marking notification before flushing
/// the index to disk. Coalesces burst writes (batch member fetches
/// call `insert` tens of times back-to-back).
const PERSIST_DEBOUNCE_MS: u64 = 250;

#[derive(Debug)]
pub struct AvatarDiskCache {
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
}

impl AvatarDiskCache {
    pub fn new() -> Self {
        Self {
            dir: OnceLock::new(),
            entries: Mutex::new(HashMap::new()),
            dirty: AtomicBool::new(false),
            wake: Notify::new(),
        }
    }

    /// Directory the cache is persisting to, if initialised.
    pub fn dir(&self) -> Option<PathBuf> {
        self.dir.get().cloned()
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
        let _ = self.dir.set(dir);

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
                log::warn!("[avatar_cache] index.json parse failed ({e}); starting fresh");
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
                "[avatar_cache] Hydrated {kept} entries from disk ({dropped} stale / invalid entries dropped)"
            );
        }
    }

    pub async fn get(&self, key: &str) -> Option<String> {
        self.entries.lock().await.get(key).cloned()
    }

    pub async fn insert(&self, key: String, value: String) {
        {
            let mut entries = self.entries.lock().await;
            entries.insert(key, value);
        }
        self.mark_dirty();
    }

    pub async fn remove(&self, key: &str) -> Option<String> {
        let old = self.entries.lock().await.remove(key);
        if old.is_some() {
            self.mark_dirty();
        }
        old
    }

    /// Remove every entry whose key starts with `prefix` and return
    /// the removed keys. Used by `clear_media_cache` to evict the
    /// `mmedia:` matrix-media entries on room switch without touching
    /// any avatar entries.
    pub async fn remove_by_prefix(&self, prefix: &str) -> Vec<String> {
        let mut entries = self.entries.lock().await;
        let keys: Vec<String> = entries
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        for k in &keys {
            entries.remove(k);
        }
        drop(entries);
        if !keys.is_empty() {
            self.mark_dirty();
        }
        keys
    }

    /// Snapshot the current map. The returned `HashMap` is
    /// disconnected from the live cache — callers that read many
    /// entries back-to-back (batch member resolution) use this so
    /// they don't hold the mutex across a large loop.
    pub async fn snapshot(&self) -> HashMap<String, String> {
        self.entries.lock().await.clone()
    }

    /// Wipe in-memory state, wipe every file inside the avatar dir,
    /// delete `index.json`. Called on login / register / logout /
    /// avatar change — mirrors the pre-existing `clear-everything`
    /// semantics of the old HashMap. `mmedia:` temp files (in the
    /// Tauri temp dir) are untouched here; they're managed by
    /// `clear_media_cache` on their own lifecycle.
    pub async fn clear(&self) {
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
                log::warn!("[avatar_cache] persist failed: {e}");
                // Restore the dirty bit so the next wake retries.
                self.dirty.store(true, Ordering::Relaxed);
            }
        }
    }

    async fn persist_now(&self) -> std::io::Result<()> {
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
                //  - Paths outside the avatar dir are `mmedia:` temp
                //    files that get swept on startup anyway.
                if value.starts_with("data:") {
                    continue;
                }
                let p = Path::new(value);
                let Ok(rel) = p.strip_prefix(&dir) else { continue };
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

    /// Deterministic cache filename for a given MXC URI + extension.
    /// UUID v5 keyed by `NAMESPACE_URL` — stable across Rust versions
    /// and app runs, so the same MXC always maps to the same on-disk
    /// file and the bytes downloaded last session are directly
    /// reusable this session.
    pub fn filename_for_mxc(mxc: &str, ext: &str) -> String {
        let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, mxc.as_bytes());
        format!("{}.{}", id.as_simple(), ext)
    }
}

impl Default for AvatarDiskCache {
    fn default() -> Self {
        Self::new()
    }
}
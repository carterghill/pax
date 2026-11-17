//! Attachment policy over the shared file store: session-scoped identity,
//! bounded LRU retention, and leases for viewers and download copies.

use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{watch, Mutex, Semaphore};

use crate::file_cache::FileCache;

pub(crate) const RETAINED_BYTES: u64 = 256 * 1024 * 1024;
const RETAINED_FILES: usize = 1024;

pub(crate) fn request_key(
    params: &matrix_sdk::media::MediaRequestParameters,
) -> Result<String, String> {
    // Include format and encrypted-source metadata, without placing encryption
    // keys in filenames or a persisted index.
    Ok(uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        &serde_json::to_vec(params).map_err(|e| e.to_string())?,
    )
    .to_string())
}

struct Entry {
    path: Option<String>,
    bytes: u64,
    last_used: u64,
    pins: usize,
    retain: bool,
}

struct Lease {
    key: String,
    frontend: bool,
}

#[derive(Default)]
struct Retention {
    entries: HashMap<String, Entry>,
    leases: HashMap<String, Lease>,
    clock: u64,
}

pub struct AttachmentCache {
    files: FileCache,
    state: Mutex<Retention>,
    init_lock: Mutex<()>,
    initialized: AtomicBool,
    session: watch::Sender<u64>,
    active: AtomicBool,
    downloads: Semaphore,
    budget: u64,
    max_files: usize,
}

/// Backend readers hold this until their copy completes. A successful frontend
/// acquisition transfers its lease to the webview, which releases it on cleanup.
pub(crate) struct AttachmentPin {
    cache: Arc<AttachmentCache>,
    id: Option<String>,
}

impl Drop for AttachmentPin {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let cache = self.cache.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    cache.release(&id).await;
                });
            }
        }
    }
}

impl AttachmentCache {
    pub(crate) fn new(budget: u64) -> Self {
        Self {
            files: FileCache::new(),
            state: Mutex::new(Retention::default()),
            init_lock: Mutex::new(()),
            initialized: AtomicBool::new(false),
            session: watch::channel(0).0,
            active: AtomicBool::new(false),
            downloads: Semaphore::new(4),
            budget,
            max_files: RETAINED_FILES,
        }
    }

    pub(crate) async fn init(&self, dir: PathBuf) -> Result<(), String> {
        let _init = self.init_lock.lock().await;
        if self.initialized.load(Ordering::Acquire) {
            return Ok(());
        }
        self.files
            .init_temporary_dir(dir)
            .await
            .map_err(|e| e.to_string())?;
        // This store is session-only. Clean leftovers from a previous crash
        // once at startup; navigation never scans the temp directory.
        self.files.clear().await;
        self.initialized.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn start_session(&self) {
        self.active.store(true, Ordering::Release);
    }

    pub(crate) async fn reset(&self) {
        self.active.store(false, Ordering::Release);
        self.files.invalidate_loads();
        self.session.send_modify(|epoch| *epoch += 1);
        let mut state = self.state.lock().await;
        // The old webview is no longer a reader. Background user downloads keep
        // their pins so sign-out cannot truncate a copy already in progress.
        let frontend: Vec<_> = state
            .leases
            .iter()
            .filter(|(_, lease)| lease.frontend)
            .map(|(id, _)| id.clone())
            .collect();
        for id in frontend {
            Self::unpin(&mut state, &id);
        }
        for entry in state.entries.values_mut() {
            entry.retain = false;
        }
        self.trim(&mut state).await;
    }

    async fn pin(self: &Arc<Self>, key: &str, id: &str) -> Result<AttachmentPin, String> {
        let mut state = self.state.lock().await;
        if state.leases.contains_key(id) {
            return Err("Duplicate attachment lease".into());
        }
        state.clock += 1;
        let clock = state.clock;
        let entry = state.entries.entry(key.to_owned()).or_insert(Entry {
            path: None,
            bytes: 0,
            last_used: clock,
            pins: 0,
            retain: true,
        });
        entry.pins += 1;
        entry.last_used = clock;
        state.leases.insert(
            id.to_owned(),
            Lease {
                key: key.to_owned(),
                frontend: true,
            },
        );
        Ok(AttachmentPin {
            cache: self.clone(),
            id: Some(id.to_owned()),
        })
    }

    pub(crate) async fn acquire(
        self: &Arc<Self>,
        identity: &str,
        lease_id: &str,
        fetch: impl Future<Output = Result<(Vec<u8>, &'static str), String>>,
    ) -> Result<String, String> {
        uuid::Uuid::parse_str(lease_id).map_err(|_| "Invalid attachment lease".to_string())?;
        let mut session = self.session.subscribe();
        if !self.active.load(Ordering::Acquire) {
            return Err("Attachment session ended".into());
        }
        let epoch = *session.borrow();
        let key = format!("{epoch}:{identity}");
        tokio::select! {
            biased;
            _ = session.changed() => Err("Attachment session ended".into()),
            result = async {
                if !self.initialized.load(Ordering::Acquire) { self.init(crate::file_cache::temp_dir().join("pax_attachments")).await?; }
                let mut pin = self.pin(&key, lease_id).await?;
                // Keep the permit through publication, bounding both requests
                // and completed byte buffers waiting for disk. Cache hits and
                // callers sharing another fill need no download permit.
                let mut download_permit = None;
                let path = self.files.get_or_load(&key, async {
                    download_permit = Some(self.downloads.acquire().await.map_err(|e| e.to_string())?);
                    fetch.await
                }).await?;
                drop(download_permit);
                let bytes = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?.len();
                let mut state = self.state.lock().await;
                let Some(entry) = state.entries.get_mut(&key) else {
                    // An explicit early release can retire a pending request.
                    // Do not leave its newly published file outside accounting.
                    self.files.discard(&key).await?;
                    return Err("Attachment lease ended".into());
                };
                entry.path = Some(path.clone());
                entry.bytes = bytes;
                if epoch != *self.session.borrow() || !self.active.load(Ordering::Acquire) {
                    entry.retain = false;
                    return Err("Attachment session ended".into());
                }
                self.trim(&mut state).await;
                pin.id = None; // Frontend now owns this lease.
                Ok(path)
            } => result,
        }
    }

    fn unpin(state: &mut Retention, id: &str) {
        let Some(lease) = state.leases.remove(id) else {
            return;
        };
        state.clock += 1;
        if let Some(entry) = state.entries.get_mut(&lease.key) {
            entry.pins = entry.pins.saturating_sub(1);
            entry.last_used = state.clock;
        }
    }

    pub(crate) async fn release(&self, lease_id: &str) {
        let mut state = self.state.lock().await;
        Self::unpin(&mut state, lease_id);
        self.trim(&mut state).await;
    }

    /// Reserve the source before a background copy is launched. The viewer can
    /// then close without making eviction race the Downloads job.
    pub(crate) async fn pin_path(
        self: &Arc<Self>,
        path: &Path,
    ) -> Result<Option<AttachmentPin>, String> {
        let mut state = self.state.lock().await;
        let key = state
            .entries
            .iter()
            .find(|(_, entry)| entry.path.as_deref().is_some_and(|p| Path::new(p) == path))
            .map(|(key, _)| key.clone());
        let Some(key) = key else {
            if path.parent() == self.files.dir().as_deref() {
                return Err("Attachment is no longer cached".into());
            }
            return Ok(None); // Other existing temp-file download sources.
        };
        let id = uuid::Uuid::new_v4().to_string();
        state.entries.get_mut(&key).unwrap().pins += 1;
        state.leases.insert(
            id.clone(),
            Lease {
                key,
                frontend: false,
            },
        );
        Ok(Some(AttachmentPin {
            cache: self.clone(),
            id: Some(id),
        }))
    }

    pub(crate) async fn clear_unused(&self) -> u32 {
        let mut state = self.state.lock().await;
        for entry in state.entries.values_mut() {
            entry.retain = false;
        }
        self.trim(&mut state).await
    }

    async fn trim(&self, state: &mut Retention) -> u32 {
        let mut removed = 0;
        // Oversized files are usable while pinned, then immediately discarded;
        // opening one must not flush a useful cache of smaller attachments.
        let mut bytes: u64 = state
            .entries
            .values()
            .filter(|e| e.retain && e.bytes <= self.budget)
            .map(|e| e.bytes)
            .sum();
        let mut count = state
            .entries
            .values()
            .filter(|e| e.retain && e.bytes <= self.budget)
            .count();
        let mut candidates: Vec<_> = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.pins == 0)
            .map(|(key, entry)| {
                (
                    key.clone(),
                    !entry.retain || entry.path.is_none() || entry.bytes > self.budget,
                    entry.last_used,
                )
            })
            .collect();
        candidates.sort_by_key(|(_, discard, used)| (!*discard, *used));
        for (key, discard, _) in candidates {
            if !discard && bytes <= self.budget && count <= self.max_files {
                break;
            }
            match self.files.discard(&key).await {
                Ok(deleted) => {
                    let entry = state.entries.remove(&key).unwrap();
                    if entry.retain && entry.bytes <= self.budget {
                        bytes -= entry.bytes;
                        count -= 1;
                    }
                    removed += u32::from(deleted);
                }
                Err(error) => log::warn!("Attachment eviction failed: {error}"),
            }
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_cache::tests::TestDir;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::oneshot;

    #[test]
    fn request_identity_distinguishes_thumbnails_and_encryption_metadata() {
        use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
        use matrix_sdk::ruma::{
            events::room::{EncryptedFile, MediaSource},
            UInt,
        };
        use serde_json::json;
        let mut params = MediaRequestParameters {
            source: MediaSource::Plain("mxc://example.org/media".into()),
            format: MediaFormat::File,
        };
        let full = request_key(&params).unwrap();
        assert_eq!(request_key(&params).unwrap(), full);
        params.format = MediaFormat::Thumbnail(MediaThumbnailSettings::new(
            UInt::from(800u32),
            UInt::from(800u32),
        ));
        assert_ne!(request_key(&params).unwrap(), full);
        let encrypted: EncryptedFile = serde_json::from_value(json!({
            "url":"mxc://example.org/media", "v":"v2", "iv":"AAAAAAAAAAAAAAAAAAAAAA",
            "key":{"kty":"oct", "alg":"A256CTR", "key_ops":["encrypt", "decrypt"], "ext":true, "k":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
            "hashes":{"sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
        })).unwrap();
        params.format = MediaFormat::File;
        params.source = MediaSource::Encrypted(Box::new(encrypted));
        let first_key = request_key(&params).unwrap();
        assert_ne!(first_key, full);
        let mut changed = serde_json::to_value(&params).unwrap();
        // Round-trip through the actual SDK schema before changing key metadata.
        let MediaSource::Encrypted(file) = &mut params.source else {
            unreachable!()
        };
        file.key.k =
            serde_json::from_value(json!("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB")).unwrap();
        assert_ne!(request_key(&params).unwrap(), first_key);
        let restored: MediaRequestParameters = serde_json::from_value(changed.take()).unwrap();
        assert_eq!(request_key(&restored).unwrap(), first_key);
    }

    async fn cache(budget: u64) -> (TestDir, Arc<AttachmentCache>) {
        let dir = TestDir::new();
        let cache = Arc::new(AttachmentCache::new(budget));
        cache.init(dir.0.clone()).await.unwrap();
        cache.start_session();
        (dir, cache)
    }

    fn lease() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    async fn load(cache: &Arc<AttachmentCache>, key: &str, size: usize) -> (String, String) {
        let id = lease();
        let path = cache
            .acquire(key, &id, async { Ok((vec![1; size], "bin")) })
            .await
            .unwrap();
        (path, id)
    }

    async fn until(mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !ready() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn revisiting_reuses_the_file_and_evicts_the_least_recently_used_one() {
        let (_dir, cache) = cache(8).await;
        let (a, first) = load(&cache, "a", 4).await;
        cache.release(&first).await;
        let (b, second) = load(&cache, "b", 4).await;
        cache.release(&second).await;
        let revisit = lease();
        let reused = cache
            .acquire("a", &revisit, async {
                panic!("retained media must not download again")
            })
            .await
            .unwrap();
        assert_eq!(a, reused);
        cache.release(&revisit).await;
        let (c, third) = load(&cache, "c", 4).await;
        cache.release(&third).await;
        assert!(Path::new(&a).is_file());
        assert!(!Path::new(&b).exists());
        assert!(Path::new(&c).is_file());
    }

    #[tokio::test]
    async fn active_readers_are_not_evicted_and_release_restores_the_budget() {
        let (_dir, cache) = cache(4).await;
        let (a, first) = load(&cache, "a", 4).await;
        let (b, second) = load(&cache, "b", 4).await;
        assert!(Path::new(&a).is_file() && Path::new(&b).is_file());
        cache.release(&first).await;
        assert!(!Path::new(&a).exists());
        assert!(Path::new(&b).is_file());
        cache.release(&second).await;
        assert_eq!(
            cache
                .state
                .lock()
                .await
                .entries
                .values()
                .map(|entry| entry.bytes)
                .sum::<u64>(),
            4
        );
    }

    #[tokio::test]
    async fn an_oversized_open_file_does_not_flush_smaller_retained_files() {
        let (_dir, cache) = cache(8).await;
        let (small, id) = load(&cache, "small", 4).await;
        cache.release(&id).await;
        let (big, id) = load(&cache, "big", 20).await;
        assert!(Path::new(&small).is_file() && Path::new(&big).is_file());
        cache.release(&id).await;
        assert!(!Path::new(&big).exists());
        assert!(Path::new(&small).is_file());
    }

    #[tokio::test]
    async fn duplicate_requests_download_once_and_each_reader_keeps_its_lease() {
        let (_dir, cache) = cache(8).await;
        let calls = AtomicUsize::new(0);
        let first = lease();
        let second = lease();
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok((vec![1; 4], "bin"))
        };
        let (a, b) = tokio::join!(
            cache.acquire("same", &first, fetch()),
            cache.acquire("same", &second, fetch())
        );
        let path = a.unwrap();
        assert_eq!(path, b.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.clear_unused().await, 0);
        cache.release(&first).await;
        assert!(Path::new(&path).is_file());
        cache.release(&second).await;
        assert!(!Path::new(&path).exists());
    }

    #[tokio::test]
    async fn a_slow_download_does_not_block_cached_reads_or_other_files() {
        let (_dir, cache) = cache(16).await;
        let (old, id) = load(&cache, "old", 4).await;
        cache.release(&id).await;
        let (started, ready) = oneshot::channel();
        let (finish, done) = oneshot::channel();
        let slow_cache = cache.clone();
        let slow_id = lease();
        let worker_id = slow_id.clone();
        let slow = tokio::spawn(async move {
            slow_cache
                .acquire("slow", &worker_id, async {
                    started.send(()).unwrap();
                    done.await.unwrap();
                    Ok((vec![2; 4], "bin"))
                })
                .await
        });
        ready.await.unwrap();
        let revisit = lease();
        let hit = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            cache.acquire("old", &revisit, async { panic!("cache hit") }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(hit, old);
        let (fast, fast_id) = load(&cache, "fast", 4).await;
        assert!(Path::new(&fast).is_file());
        finish.send(()).unwrap();
        slow.await.unwrap().unwrap();
        for id in [slow_id, revisit, fast_id] {
            cache.release(&id).await;
        }
    }

    #[tokio::test]
    async fn downloads_survive_viewer_release_explicit_clear_and_logout() {
        let (_dir, cache) = cache(8).await;
        let (path, id) = load(&cache, "download", 4).await;
        let copy = cache.pin_path(Path::new(&path)).await.unwrap().unwrap();
        cache.release(&id).await;
        assert_eq!(cache.clear_unused().await, 0);
        cache.reset().await;
        assert!(Path::new(&path).is_file());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), vec![1; 4]);
        drop(copy);
        until(|| !Path::new(&path).exists()).await;
    }

    #[tokio::test]
    async fn session_reset_cancels_downloads_and_does_not_reuse_the_old_account() {
        let (_dir, cache) = cache(8).await;
        let (old, id) = load(&cache, "shared-id", 4).await;
        let (started, ready) = oneshot::channel();
        let worker = cache.clone();
        let pending_id = lease();
        let pending = tokio::spawn(async move {
            worker
                .acquire("pending", &pending_id, async {
                    started.send(()).unwrap();
                    std::future::pending::<()>().await;
                    Ok((vec![1], "bin"))
                })
                .await
        });
        ready.await.unwrap();
        cache.reset().await;
        assert!(pending.await.unwrap().is_err());
        assert!(!Path::new(&old).exists());
        assert!(cache
            .acquire("shared-id", &lease(), async {
                panic!("closed session fetched")
            })
            .await
            .is_err());
        cache.start_session();
        let (new, new_id) = load(&cache, "shared-id", 3).await;
        assert_ne!(old, new);
        cache.release(&id).await; // Stale cleanup cannot release the new file.
        assert_eq!(tokio::fs::read(&new).await.unwrap().len(), 3);
        cache.release(&new_id).await;
    }

    #[tokio::test]
    async fn a_failed_load_is_retryable_and_does_not_leak_a_pin() {
        let (_dir, cache) = cache(8).await;
        let id = lease();
        assert!(cache
            .acquire("retry", &id, async { Err("offline".into()) })
            .await
            .is_err());
        cache.release(&id).await;
        assert!(cache.state.lock().await.leases.is_empty());
        let (path, id) = load(&cache, "retry", 4).await;
        assert!(Path::new(&path).is_file());
        cache.release(&id).await;
        cache.release(&id).await;
        assert!(cache.state.lock().await.leases.is_empty());
    }

    #[tokio::test]
    async fn externally_deleted_media_is_fetched_again() {
        let (_dir, cache) = cache(8).await;
        let (path, id) = load(&cache, "missing", 4).await;
        cache.release(&id).await;
        tokio::fs::remove_file(&path).await.unwrap();
        let (repaired, id) = load(&cache, "missing", 3).await;
        assert_eq!(path, repaired);
        assert_eq!(tokio::fs::read(&repaired).await.unwrap().len(), 3);
        cache.release(&id).await;
    }

    #[tokio::test]
    async fn cached_reads_bypass_a_full_download_budget() {
        let (_dir, cache) = cache(100).await;
        let (warm, id) = load(&cache, "warm", 4).await;
        cache.release(&id).await;
        let slots = Arc::new(Semaphore::new(0));
        let (started, mut ready) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        for n in 0..4 {
            let worker = cache.clone();
            let slots = slots.clone();
            let started = started.clone();
            tasks.push(tokio::spawn(async move {
                let id = lease();
                let result = worker
                    .acquire(&format!("pending-{n}"), &id, async {
                        started.send(()).unwrap();
                        slots.acquire().await.unwrap().forget();
                        Ok((vec![1; 4], "bin"))
                    })
                    .await;
                (result, id)
            }));
        }
        for _ in 0..4 {
            tokio::time::timeout(std::time::Duration::from_secs(1), ready.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(cache.downloads.available_permits(), 0);
        let id = lease();
        let hit = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            cache.acquire("warm", &id, async { panic!("cached media fetched") }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(hit, warm);
        cache.release(&id).await;
        slots.add_permits(4);
        for task in tasks {
            let (result, id) = task.await.unwrap();
            result.unwrap();
            cache.release(&id).await;
        }
    }

    #[tokio::test]
    async fn file_count_limit_bounds_tiny_or_empty_attachments() {
        let dir = TestDir::new();
        let mut policy = AttachmentCache::new(100);
        policy.max_files = 2;
        let cache = Arc::new(policy);
        cache.init(dir.0.clone()).await.unwrap();
        cache.start_session();
        let (first, id) = load(&cache, "first", 0).await;
        cache.release(&id).await;
        let (_, id) = load(&cache, "second", 0).await;
        cache.release(&id).await;
        let (_, id) = load(&cache, "third", 0).await;
        cache.release(&id).await;
        assert_eq!(cache.state.lock().await.entries.len(), 2);
        assert!(!Path::new(&first).exists());
    }

    #[tokio::test]
    async fn initialization_cleans_only_the_owned_directory_and_does_not_persist_an_index() {
        let dir = TestDir::new();
        let owned = dir.0.join("attachments");
        tokio::fs::create_dir(&owned).await.unwrap();
        tokio::fs::write(owned.join("leftover.tmp"), [1])
            .await
            .unwrap();
        let avatar = dir.0.join("avatar.png");
        tokio::fs::write(&avatar, [2]).await.unwrap();
        let cache = Arc::new(AttachmentCache::new(8));
        cache.init(owned.clone()).await.unwrap();
        cache.start_session();
        assert!(!owned.join("leftover.tmp").exists());
        let (file, id) = load(&cache, "new", 4).await;
        cache.init(owned.clone()).await.unwrap();
        assert!(Path::new(&file).is_file());
        assert!(!owned.join("index.json").exists());
        cache.release(&id).await;
        cache.clear_unused().await;
        assert!(avatar.is_file());
    }

    #[tokio::test]
    async fn an_explicit_release_during_a_fill_does_not_leave_an_unaccounted_file() {
        let (dir, cache) = cache(8).await;
        let id = lease();
        let worker_id = id.clone();
        let (started, ready) = oneshot::channel();
        let (finish, done) = oneshot::channel();
        let worker = cache.clone();
        let pending = tokio::spawn(async move {
            worker
                .acquire("released", &worker_id, async {
                    started.send(()).unwrap();
                    done.await.unwrap();
                    Ok((vec![1; 4], "bin"))
                })
                .await
        });
        ready.await.unwrap();
        cache.release(&id).await;
        finish.send(()).unwrap();
        assert!(pending.await.unwrap().is_err());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }
}

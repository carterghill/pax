//! Matrix avatar policy over the shared file cache. Passive projections use
//! `cached`; visible avatar requests use `load`. No network work is started by
//! reading a message, room list, or voice participant snapshot.

use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::MxcUri;
use matrix_sdk::Client;
use tokio::sync::{watch, Semaphore};

use crate::file_cache::FileCache;

pub struct AvatarService {
    files: Arc<FileCache>,
    downloads: Semaphore,
    session: watch::Sender<u64>,
}

/// Captured before profile/state lookup, preserving the session across awaits
/// that happen before the media download starts.
pub struct AvatarSession<'a> {
    service: &'a AvatarService,
    session: watch::Receiver<u64>,
}

impl AvatarSession<'_> {
    async fn run<T>(
        &self,
        work: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut session = self.session.clone();
        tokio::select! {
            biased;
            _ = session.changed() => Err("Avatar request cancelled".into()),
            result = work => result,
        }
    }

    pub async fn load(&self, client: &Client, mxc: &MxcUri) -> Result<String, String> {
        self.run(self.service.load(client, mxc)).await
    }
}

impl AvatarService {
    pub fn new(files: Arc<FileCache>) -> Self {
        Self {
            files,
            downloads: Semaphore::new(8),
            session: watch::channel(0).0,
        }
    }

    /// Wake and cancel active loads when the authenticated session is replaced.
    pub fn reset(&self) {
        self.session.send_modify(|generation| *generation += 1);
    }

    pub fn session(&self) -> AvatarSession<'_> {
        AvatarSession {
            service: self,
            session: self.session.subscribe(),
        }
    }

    pub async fn in_session<T>(
        &self,
        work: impl std::future::Future<Output = T>,
    ) -> Result<T, String> {
        self.session().run(async { Ok(work.await) }).await
    }

    pub async fn cached(&self, mxc: Option<&MxcUri>) -> Option<String> {
        self.files.get_file(mxc?.as_str()).await
    }

    pub async fn load(&self, client: &Client, mxc: &MxcUri) -> Result<String, String> {
        self.fetch(mxc, async {
            let request = MediaRequestParameters {
                source: MediaSource::Plain(mxc.to_owned()),
                format: MediaFormat::File,
            };
            client.media().get_media_content(&request, true).await
        })
        .await
    }

    async fn fetch(
        &self,
        mxc: &MxcUri,
        bytes: impl std::future::Future<Output = Result<Vec<u8>, matrix_sdk::Error>>,
    ) -> Result<String, String> {
        self.session()
            .run(self.files.get_or_load(mxc.as_str(), async {
                let _permit = self.downloads.acquire().await.map_err(|e| e.to_string())?;
                let bytes = tokio::time::timeout(Duration::from_secs(10), bytes)
                    .await
                    .map_err(|_| "Avatar download timed out".to_string())?
                    .map_err(|e| e.to_string())?;
                let ext = match crate::commands::sniff_image_mime(&bytes) {
                    "image/jpeg" => "jpg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    _ => "png",
                };
                Ok((bytes, ext))
            }))
            .await
    }

    /// Includes profile lookup in the session lifetime, so a late profile
    /// response cannot start a download after logout.
    pub async fn user_avatar(
        &self,
        client: &Client,
        user_id: &str,
    ) -> Result<Option<String>, String> {
        self.session().run(self.resolve_user(client, user_id)).await
    }

    async fn resolve_user(&self, client: &Client, user_id: &str) -> Result<Option<String>, String> {
        use matrix_sdk::ruma::api::client::profile::{get_profile::v3::Request, AvatarUrl};
        let uid = matrix_sdk::ruma::UserId::parse(user_id).map_err(|e| e.to_string())?;
        // Profile edits may reach this device before their room-state echoes.
        if client.user_id() != Some(&*uid) {
            for room in client.joined_rooms() {
                if let Some(member) = room
                    .get_member_no_sync(&uid)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    if let Some(mxc) = member.avatar_url() {
                        return self.load(client, mxc).await.map(Some);
                    }
                }
            }
        }
        // An absent local reference may be incomplete room state. Only a
        // successful profile response confirms that the user has no avatar.
        let profile = tokio::time::timeout(Duration::from_secs(5), client.send(Request::new(uid)))
            .await
            .map_err(|_| "Avatar profile lookup timed out".to_string())?
            .map_err(|e| e.to_string())?;
        match profile
            .get_static::<AvatarUrl>()
            .map_err(|e| e.to_string())?
        {
            Some(mxc) => self.load(client, &mxc).await.map(Some),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn a_late_profile_cannot_start_loading_in_a_replacement_session() {
        let service = AvatarService::new(Arc::new(FileCache::new()));
        let request = service.session();
        service.reset();
        let called = AtomicUsize::new(0);
        assert!(request
            .run(async {
                called.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert_eq!(called.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reset_cancels_downloads_and_passive_lookup_never_waits_for_them() {
        let files = Arc::new(FileCache::new());
        let service = Arc::new(AvatarService::new(files.clone()));
        let (started, ready) = tokio::sync::oneshot::channel();
        let background = service.clone();
        let download = tokio::spawn(async move {
            background
                .fetch("mxc://server/pending".into(), async {
                    started.send(()).unwrap();
                    std::future::pending().await
                })
                .await
        });
        ready.await.unwrap();
        assert!(service
            .cached(Some("mxc://server/pending".into()))
            .await
            .is_none());
        service.reset();
        assert!(tokio::time::timeout(Duration::from_secs(1), download)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(files.snapshot().await.is_empty());
    }

    #[tokio::test]
    async fn downloads_are_limited_across_distinct_avatars() {
        let dir = crate::file_cache::tests::TestDir::new();
        let files = Arc::new(FileCache::new());
        files.clone().init_with_dir(dir.0.clone()).await.unwrap();
        let service = Arc::new(AvatarService::new(files));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Semaphore::new(0));
        let mut jobs = Vec::new();
        for id in 0..16 {
            let service = service.clone();
            let active = active.clone();
            let maximum = maximum.clone();
            let started = started.clone();
            let gate = gate.clone();
            jobs.push(tokio::spawn(async move {
                let uri = format!("mxc://server/{id}");
                service
                    .fetch(uri.as_str().into(), async {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(count, Ordering::SeqCst);
                        started.fetch_add(1, Ordering::SeqCst);
                        gate.acquire().await.unwrap().forget();
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(vec![1])
                    })
                    .await
            }));
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while started.load(Ordering::SeqCst) < 8 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 8);
        gate.add_permits(16);
        for job in jobs {
            job.await.unwrap().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 8);
    }
}

//! Session lifetime, bounded reads, and Matrix membership snapshots for voice
//! presence. The frontend session store owns refresh scheduling and snapshots.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{stream, StreamExt};
use matrix_sdk::{ruma::events::StateEventType, Client, Room};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::{avatars::AvatarService, types::VoiceParticipant};

pub(crate) const VOICE_ROOM_TYPE: &str = "org.matrix.msc3417.call";

pub struct VoicePresenceService {
    current: Mutex<Arc<VoicePresenceSession>>,
}

impl Default for VoicePresenceService {
    fn default() -> Self {
        Self {
            current: Mutex::new(Arc::new(VoicePresenceSession::new(true))),
        }
    }
}

impl VoicePresenceService {
    pub(crate) fn session(&self) -> Arc<VoicePresenceSession> {
        self.current.lock().unwrap().clone()
    }
    pub(crate) fn reset(&self) {
        self.replace(true);
    }
    pub(crate) fn start_session(&self) {
        self.replace(false);
    }
    fn replace(&self, closed: bool) {
        let mut session = self.current.lock().unwrap();
        session.cancelled.send_replace(true);
        *session = Arc::new(VoicePresenceSession::new(closed));
    }
}

pub(crate) struct VoicePresenceSession {
    cancelled: watch::Sender<bool>,
    pub matrix_read: AsyncMutex<()>,
    pub livekit_read: AsyncMutex<()>,
    pub sfu_rooms: Mutex<HashMap<String, String>>,
}

impl VoicePresenceSession {
    fn new(closed: bool) -> Self {
        Self {
            cancelled: watch::channel(closed).0,
            matrix_read: AsyncMutex::new(()),
            livekit_read: AsyncMutex::new(()),
            sfu_rooms: Mutex::new(HashMap::new()),
        }
    }
    pub(crate) fn is_active(&self) -> bool {
        !*self.cancelled.borrow()
    }
    pub(crate) async fn run<T>(
        &self,
        work: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut cancelled = self.cancelled.subscribe();
        if *cancelled.borrow() {
            return Err("Voice presence session ended".into());
        }
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err("Voice presence session ended".into()),
            result = tokio::time::timeout(Duration::from_secs(25), work) => result.map_err(|_| "Voice presence read timed out".to_string())?,
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceMembershipSnapshot {
    /// Authoritative joined voice-room catalog, also on a scoped refresh.
    pub room_ids: Vec<String>,
    /// Missing entries are failed reads; an empty list is a confirmed empty room.
    pub participants_by_room: HashMap<String, Vec<VoiceParticipant>>,
    pub expires_at_by_room: HashMap<String, u64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LivekitVoiceSnapshot {
    pub available: bool,
    /// Missing entries are unavailable, never an instruction to erase rows.
    pub participants_by_room: HashMap<String, Vec<crate::types::LivekitVoiceParticipantInfo>>,
}

pub(crate) enum LivekitRoomRead {
    Participants(Vec<crate::types::LivekitVoiceParticipantInfo>),
    Missing,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Active until the earliest future expiry. Legacy membership arrays can have
/// per-device expiry fields; empty/redacted content represents a departure.
fn active_membership(value: &Value, now: u64) -> Option<Option<u64>> {
    let content = value.get("content")?;
    let origin = value
        .get("origin_server_ts")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let expiry = |entry: &Value| {
        let start = entry
            .get("created_ts")
            .and_then(Value::as_u64)
            .filter(|ts| *ts > 0)
            .unwrap_or(origin);
        entry
            .get("expires")
            .and_then(Value::as_u64)
            .filter(|ms| *ms > 0 && start > 0)
            .map(|ms| start.saturating_add(ms))
    };
    if content.get("application").is_some() {
        let expires = expiry(content);
        return (!expires.is_some_and(|at| at <= now)).then_some(expires);
    }
    let entries = content.get("memberships")?.as_array()?;
    let mut active = false;
    let mut next = None;
    for entry in entries {
        let expires = expiry(entry).or_else(|| expiry(content));
        if expires.is_some_and(|at| at <= now) {
            continue;
        }
        active = true;
        if let Some(at) = expires {
            next = Some(next.map_or(at, |old: u64| old.min(at)));
        }
    }
    active.then_some(next)
}

pub(crate) fn membership_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "m.call.member" | "org.matrix.msc3401.call.member"
    )
}

fn affects_memberships(event_type: &str) -> bool {
    membership_event_type(event_type)
        || matches!(
            event_type,
            "m.room.member" | "m.room.redaction" | "m.room.create"
        )
}

/// Inspect only rooms/events in this sync batch, with no state-store reads or
/// spawned scans. Ordinary messages, typing, and presence need no voice work.
pub(crate) fn changed_rooms(
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
) -> Vec<String> {
    let mut changed = HashSet::new();
    for (id, update) in &response.rooms.joined {
        if !client.get_room(id).is_some_and(|room| {
            room.room_type()
                .is_some_and(|kind| kind.as_str() == VOICE_ROOM_TYPE)
        }) {
            continue;
        }
        let state = match &update.state {
            matrix_sdk::sync::State::Before(events) | matrix_sdk::sync::State::After(events) => {
                events
            }
        };
        if state.iter().any(|event| {
            event
                .get_field::<String>("type")
                .ok()
                .flatten()
                .is_some_and(|kind| affects_memberships(&kind))
        }) || update.timeline.events.iter().any(|event| {
            event
                .raw()
                .get_field::<String>("type")
                .ok()
                .flatten()
                .is_some_and(|kind| affects_memberships(&kind))
        }) {
            changed.insert(id.to_string());
        }
    }
    for id in response.rooms.left.keys() {
        if client.get_room(id).is_some_and(|room| {
            room.room_type()
                .is_some_and(|kind| kind.as_str() == VOICE_ROOM_TYPE)
        }) {
            changed.insert(id.to_string());
        }
    }
    changed.into_iter().collect()
}

/// Deduplicate devices and the two event type spellings before reading profiles.
async fn active_call_users(room: &Room) -> Result<(HashSet<String>, Option<u64>), String> {
    let mut users = HashSet::new();
    let mut next = None;
    let now = now_ms();
    for name in ["org.matrix.msc3401.call.member", "m.call.member"] {
        let events = room
            .get_state_events(StateEventType::from(name))
            .await
            .map_err(|e| e.to_string())?;
        for event in events {
            let value = serde_json::to_value(event).map_err(|e| e.to_string())?;
            let Some(expires) = active_membership(&value, now) else {
                continue;
            };
            if let Some(user) = value.get("sender").and_then(Value::as_str) {
                users.insert(user.to_owned());
            }
            if let Some(at) = expires {
                next = Some(next.map_or(at, |old: u64| old.min(at)));
            }
        }
    }
    Ok((users, next))
}

pub(crate) async fn read_room(
    room: &Room,
    avatars: &AvatarService,
) -> Result<(Vec<VoiceParticipant>, Option<u64>), String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let (users, expires) = active_call_users(room).await?;
        let mut participants = Vec::new();
        for user_id in users {
            let user = matrix_sdk::ruma::UserId::parse(&user_id).map_err(|e| e.to_string())?;
            let member = room
                .get_member_no_sync(&user)
                .await
                .map_err(|e| e.to_string())?;
            let display_name = member
                .as_ref()
                .and_then(|m| m.display_name())
                .map(str::to_owned);
            let avatar_url = match member {
                Some(member) => avatars.cached(member.avatar_url()).await,
                None => None,
            };
            participants.push(VoiceParticipant {
                user_id,
                display_name,
                avatar_url,
            });
        }
        Ok((participants, expires))
    })
    .await
    .map_err(|_| "Matrix voice membership read timed out".to_string())?
}

pub(crate) async fn read_memberships(
    client: &Client,
    avatars: &AvatarService,
    requested: Option<Vec<String>>,
) -> VoiceMembershipSnapshot {
    let requested = requested.map(|ids| ids.into_iter().collect::<HashSet<_>>());
    let rooms: Vec<_> = client
        .joined_rooms()
        .into_iter()
        .filter(|room| {
            room.room_type()
                .is_some_and(|kind| kind.as_str() == VOICE_ROOM_TYPE)
        })
        .collect();
    let mut snapshot = VoiceMembershipSnapshot {
        room_ids: rooms
            .iter()
            .map(|room| room.room_id().to_string())
            .collect(),
        ..Default::default()
    };
    let mut reads = stream::iter(
        rooms
            .into_iter()
            .filter(|room| {
                requested
                    .as_ref()
                    .is_none_or(|ids| ids.contains(room.room_id().as_str()))
            })
            .map(|room| async move {
                let result = read_room(&room, avatars).await;
                (room.room_id().to_string(), result)
            }),
    )
    .buffer_unordered(8);
    // Preserve completed rooms if an unusually large/busy store hits the budget.
    let _ = tokio::time::timeout(Duration::from_secs(12), async {
        while let Some((id, result)) = reads.next().await {
            match result {
                Ok((participants, expires)) => {
                    snapshot
                        .participants_by_room
                        .insert(id.clone(), participants);
                    if let Some(at) = expires {
                        snapshot.expires_at_by_room.insert(id, at);
                    }
                }
                Err(error) => log::warn!("Voice membership {id}: {error}"),
            }
        }
    })
    .await;
    snapshot
}

/// A single discovery feeds this bounded set of per-room requests. Return
/// completed results even if the batch budget expires; pending rooms remain
/// absent from the snapshot and can be retried without erasing cached rows.
pub(crate) async fn collect_livekit_reads<F, Fut>(
    targets: Vec<(String, String)>,
    budget: Duration,
    fetch: F,
) -> Vec<(String, String, Result<LivekitRoomRead, String>)>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<LivekitRoomRead, String>>,
{
    let mut requests = stream::iter(targets.into_iter().map(|(id, name)| {
        let result = fetch(name.clone());
        async move { (id, name, result.await) }
    }))
    .buffer_unordered(4);
    let mut completed = Vec::new();
    let _ = tokio::time::timeout(budget, async {
        while let Some(result) = requests.next().await {
            completed.push(result);
        }
    })
    .await;
    completed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn modern_membership_expires_at_created_timestamp_or_event_timestamp() {
        let mut value =
            json!({"origin_server_ts":1000,"content":{"application":"m.call","expires":200}});
        assert_eq!(active_membership(&value, 1199), Some(Some(1200)));
        assert_eq!(active_membership(&value, 1200), None);
        value["content"]["created_ts"] = json!(900);
        assert_eq!(active_membership(&value, 1099), Some(Some(1100)));
        assert_eq!(active_membership(&value, 1100), None);
    }

    #[test]
    fn legacy_devices_expire_individually_and_schedule_the_next_expiry() {
        let value = json!({"origin_server_ts":1000,"content":{"memberships":[
            {"expires":100}, {"created_ts":1200,"expires":300}, {"created_ts":1100,"expires":300}
        ]}});
        assert_eq!(active_membership(&value, 1200), Some(Some(1400)));
        assert_eq!(active_membership(&value, 1400), Some(Some(1500)));
        assert_eq!(active_membership(&value, 1500), None);
    }

    #[test]
    fn departures_and_redacted_content_are_inactive_but_unexpiring_sessions_work() {
        for content in [json!({}), json!({"memberships":[]})] {
            assert_eq!(active_membership(&json!({"content":content}), 1000), None);
        }
        assert_eq!(
            active_membership(&json!({"content":{"application":"m.call"}}), 1000),
            Some(None)
        );
    }

    #[test]
    fn unrelated_sync_events_do_not_request_voice_reads() {
        for kind in [
            "m.call.member",
            "org.matrix.msc3401.call.member",
            "m.room.member",
            "m.room.redaction",
            "m.room.create",
        ] {
            assert!(affects_memberships(kind));
        }
        for kind in [
            "m.room.message",
            "m.typing",
            "m.presence",
            "m.reaction",
            "m.room.avatar",
        ] {
            assert!(!affects_memberships(kind));
        }
    }

    #[tokio::test]
    async fn session_reset_cancels_active_and_queued_reads_and_drops_old_mapping() {
        let service = VoicePresenceService::default();
        assert!(service.session().run(async { Ok(()) }).await.is_err());
        service.start_session();
        let old = service.session();
        old.sfu_rooms
            .lock()
            .unwrap()
            .insert("!room:server".into(), "old-sfu".into());
        let (started, ready) = tokio::sync::oneshot::channel();
        let active_session = old.clone();
        let active = tokio::spawn(async move {
            active_session
                .run(async {
                    let _guard = active_session.livekit_read.lock().await;
                    let _ = started.send(());
                    std::future::pending::<Result<(), String>>().await
                })
                .await
        });
        ready.await.unwrap();
        let queued_session = old.clone();
        let queued = tokio::spawn(async move {
            queued_session
                .run(async {
                    let _guard = queued_session.livekit_read.lock().await;
                    Err::<(), _>("obsolete request ran".into())
                })
                .await
        });
        service.reset();
        for task in [active, queued] {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err(),
                "Voice presence session ended"
            );
        }
        service.start_session();
        let current = service.session();
        assert!(current.sfu_rooms.lock().unwrap().is_empty());
        assert!(current.run(async { Ok(()) }).await.is_ok());
        assert!(!old.is_active());
    }

    #[tokio::test]
    async fn livekit_batch_limits_concurrency_and_keeps_partial_failures_distinct() {
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        let targets = (0..12).map(|id| (id.to_string(), id.to_string())).collect();
        let results = collect_livekit_reads(targets, Duration::from_secs(1), |name| {
            let active = &active;
            let maximum = &maximum;
            async move {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(count, Ordering::SeqCst);
                tokio::task::yield_now().await;
                active.fetch_sub(1, Ordering::SeqCst);
                if name == "2" {
                    Err("unavailable".into())
                } else {
                    Ok(LivekitRoomRead::Participants(vec![]))
                }
            }
        })
        .await;
        assert_eq!(results.len(), 12);
        assert_eq!(maximum.load(Ordering::SeqCst), 4);
        assert!(results
            .iter()
            .find(|(id, _, _)| id == "2")
            .unwrap()
            .2
            .is_err());
        assert_eq!(
            results
                .iter()
                .filter(|(_, _, result)| result.is_ok())
                .count(),
            11
        );
    }

    #[tokio::test]
    async fn a_slow_livekit_room_does_not_discard_completed_rooms_at_the_deadline() {
        let results = collect_livekit_reads(
            vec![
                ("fast".into(), "fast".into()),
                ("slow".into(), "slow".into()),
            ],
            Duration::from_millis(5),
            |name| async move {
                if name == "slow" {
                    std::future::pending::<()>().await;
                }
                Ok(LivekitRoomRead::Participants(vec![]))
            },
        )
        .await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "fast");
    }
}

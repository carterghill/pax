//! Session-owned notification resolution and push-rule maintenance. Account
//! data is authoritative; the server rules are a lossy derived projection.
//! Sync handlers only enqueue work. One worker combines scopes and retries
//! unavailable servers without holding up sync or settings commands.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use futures_util::{stream, StreamExt, TryStreamExt};
use matrix_sdk::Client;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

use super::{
    get_authed_client, get_client,
    notification_levels::{apply_level_to_room_for_client, has_suppression_installed},
    pax_settings::{load_settings_for_session, NotificationLevel, NotificationSettings},
    push_rules::load_push_rules_for_client,
};
use crate::{
    room_relationships::{index_parent_spaces, load_space_graph, ParentSpaces, SpaceChildren},
    AppState,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ReconcileScope {
    all: bool,
    rooms: HashSet<String>,
    spaces: HashSet<String>,
}

impl ReconcileScope {
    pub(crate) fn all() -> Self {
        Self {
            all: true,
            ..Self::default()
        }
    }
    pub(crate) fn room(id: impl Into<String>) -> Self {
        Self {
            rooms: HashSet::from([id.into()]),
            ..Self::default()
        }
    }
    pub(crate) fn space(id: impl Into<String>) -> Self {
        Self {
            spaces: HashSet::from([id.into()]),
            ..Self::default()
        }
    }
    pub(super) fn is_empty(&self) -> bool {
        !self.all && self.rooms.is_empty() && self.spaces.is_empty()
    }
    /// Compute all affected scopes when a fresh server read also discovers
    /// edits from another device beyond the setting this command changed.
    fn settings_changed(
        before: Option<&NotificationSettings>,
        after: &NotificationSettings,
    ) -> Self {
        let Some(before) = before else {
            return Self::all();
        };
        if before.global_default != after.global_default {
            return Self::all();
        }
        let mut scope = Self::default();
        for id in before.rooms.keys().chain(after.rooms.keys()) {
            if before.rooms.get(id) != after.rooms.get(id) {
                scope.merge(Self::room(id));
            }
        }
        for id in before.spaces.keys().chain(after.spaces.keys()) {
            if before.spaces.get(id) != after.spaces.get(id) {
                scope.merge(Self::space(id));
            }
        }
        scope
    }
    fn merge(&mut self, other: Self) {
        if self.all {
            return;
        }
        if other.all {
            *self = Self::all();
            return;
        }
        self.rooms.extend(other.rooms);
        self.spaces.extend(other.spaces);
        // A burst cannot create an unbounded maintenance queue.
        if self.rooms.len() + self.spaces.len() > 1024 {
            *self = Self::all();
        }
    }
    fn targets(&self, snapshot: &ResolutionSnapshot) -> HashSet<String> {
        if self.all {
            return snapshot.levels.keys().cloned().collect();
        }
        let mut rooms = self.rooms.clone();
        for space in &self.spaces {
            if let Some(children) = snapshot.children.get(space) {
                rooms.extend(children.iter().map(|child| child.child_id.clone()));
            }
        }
        rooms.retain(|id| snapshot.levels.contains_key(id));
        rooms
    }
}

pub struct NotificationService {
    session: Mutex<Arc<NotificationSession>>,
}

impl Default for NotificationService {
    fn default() -> Self {
        Self {
            session: Mutex::new(Arc::new(NotificationSession::closed())),
        }
    }
}

impl NotificationService {
    pub(crate) fn session(&self) -> Arc<NotificationSession> {
        self.session.lock().unwrap().clone()
    }
    pub(crate) fn reset(&self) {
        let mut current = self.session.lock().unwrap();
        current.cancelled.send_replace(true);
        *current = Arc::new(NotificationSession::closed());
    }
    pub(crate) fn start_session(&self) {
        let mut current = self.session.lock().unwrap();
        current.cancelled.send_replace(true);
        *current = Arc::new(NotificationSession::default());
    }
    pub(crate) fn schedule(&self, state: &Arc<AppState>, app: &AppHandle, scope: ReconcileScope) {
        self.session().schedule(state, app, scope);
    }
}

#[derive(Default)]
struct Control {
    revision: u64,
    settings_revision: u64,
    settings: Option<NotificationSettings>,
    settings_error: Option<(Instant, String)>,
    snapshot: Option<Arc<ResolutionSnapshot>>,
    snapshot_error: Option<(Instant, String)>,
    pending: ReconcileScope,
    running: bool,
}

pub(crate) struct NotificationSession {
    cancelled: watch::Sender<bool>,
    control: Mutex<Control>,
    pub(super) settings_load: AsyncMutex<()>,
    snapshot_load: AsyncMutex<()>,
    wake: Notify,
}

impl Default for NotificationSession {
    fn default() -> Self {
        Self {
            cancelled: watch::channel(false).0,
            control: Mutex::new(Control::default()),
            settings_load: AsyncMutex::new(()),
            snapshot_load: AsyncMutex::new(()),
            wake: Notify::new(),
        }
    }
}

pub(crate) struct ResolutionSnapshot {
    revision: u64,
    children: SpaceChildren,
    pub levels: HashMap<String, NotificationLevel>,
}

impl NotificationSession {
    fn closed() -> Self {
        let session = Self::default();
        session.cancelled.send_replace(true);
        session
    }
    pub(super) async fn run<T>(
        &self,
        work: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut cancelled = self.cancelled.subscribe();
        if *cancelled.borrow() {
            return Err("Notification session ended".into());
        }
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err("Notification session ended".into()),
            result = work => result,
        }
    }

    pub(super) fn settings(&self) -> (u64, Option<NotificationSettings>) {
        let control = self.control.lock().unwrap();
        (control.settings_revision, control.settings.clone())
    }

    pub(super) fn cache_settings(&self, revision: u64, settings: NotificationSettings) -> bool {
        let mut control = self.control.lock().unwrap();
        if control.settings_revision != revision {
            return false;
        }
        control.settings = Some(settings);
        control.settings_error = None;
        true
    }

    pub(super) fn settings_error(&self) -> Option<String> {
        self.control
            .lock()
            .unwrap()
            .settings_error
            .as_ref()
            .filter(|(failed_at, _)| failed_at.elapsed() < Duration::from_secs(1))
            .map(|(_, error)| error.clone())
    }

    pub(super) fn fail_settings(&self, revision: u64, error: String) -> bool {
        let mut control = self.control.lock().unwrap();
        if control.settings_revision != revision {
            return false;
        }
        control.settings_error = Some((Instant::now(), error));
        true
    }

    /// A successful local write or account-data sync supersedes pending reads.
    pub(super) fn set_settings(&self, settings: NotificationSettings) -> ReconcileScope {
        let mut control = self.control.lock().unwrap();
        let scope = ReconcileScope::settings_changed(control.settings.as_ref(), &settings);
        if control.settings.as_ref() == Some(&settings) {
            return scope;
        }
        control.settings_revision += 1;
        control.settings = Some(settings);
        control.settings_error = None;
        if !scope.is_empty() {
            control.revision += 1;
            control.snapshot = None;
            control.snapshot_error = None;
        }
        scope
    }

    pub(super) fn invalidate_settings_if_different(&self, settings: &NotificationSettings) -> bool {
        let mut control = self.control.lock().unwrap();
        if control.settings.as_ref() == Some(settings) {
            return false;
        }
        control.settings_revision += 1;
        control.settings = None;
        control.settings_error = None;
        control.revision += 1;
        control.snapshot = None;
        control.snapshot_error = None;
        true
    }

    fn enqueue(&self, scope: ReconcileScope, invalidate_levels: bool) -> bool {
        let mut control = self.control.lock().unwrap();
        if invalidate_levels {
            control.revision += 1;
            control.snapshot = None;
            control.snapshot_error = None;
        }
        control.pending.merge(scope);
        self.wake.notify_one();
        if control.running {
            false
        } else {
            control.running = true;
            true
        }
    }

    fn take_work(&self) -> Option<ReconcileScope> {
        let mut control = self.control.lock().unwrap();
        if control.pending.is_empty() {
            control.running = false;
            None
        } else {
            Some(std::mem::take(&mut control.pending))
        }
    }

    pub(super) fn schedule(
        self: &Arc<Self>,
        state: &Arc<AppState>,
        app: &AppHandle,
        scope: ReconcileScope,
    ) {
        self.request(state, app, scope, true);
    }

    /// Push-rule echoes do not change intent or relationships. Queue a drift
    /// check without discarding levels or interrupting the current writer.
    pub(super) fn schedule_projection(self: &Arc<Self>, state: &Arc<AppState>, app: &AppHandle) {
        self.request(state, app, ReconcileScope::all(), false);
    }

    fn request(
        self: &Arc<Self>,
        state: &Arc<AppState>,
        app: &AppHandle,
        scope: ReconcileScope,
        invalidate_levels: bool,
    ) {
        if *self.cancelled.borrow() {
            return;
        }
        let start = self.enqueue(scope, invalidate_levels);
        if invalidate_levels {
            let _ = app.emit("pax-notification-levels-invalidated", ());
        }
        if !start {
            return;
        }
        let session = self.clone();
        let state = state.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let _ = session
                .run(session.work_loop(Duration::from_millis(100), |scope| {
                    reconcile_pass(&state, &session, &app, scope)
                }))
                .await;
        });
    }

    async fn work_loop<F, Fut>(&self, debounce: Duration, mut work: F) -> Result<(), String>
    where
        F: FnMut(ReconcileScope) -> Fut,
        Fut: Future<Output = Result<ReconcileReport, String>>,
    {
        let mut delay = debounce;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = self.wake.notified() => tokio::time::sleep(debounce).await,
            }
            let Some(scope) = self.take_work() else {
                return Ok(());
            };
            let result = tokio::time::timeout(Duration::from_secs(60), work(scope.clone()))
                .await
                .unwrap_or_else(|_| Err("Notification pass timed out".into()));
            match result {
                Ok(report) if report.errors == 0 => {
                    delay = debounce;
                }
                result => {
                    if let Err(error) = result {
                        log::warn!("[pax reconcile] {error}; retrying");
                    }
                    self.control.lock().unwrap().pending.merge(scope);
                    delay = (delay * 2)
                        .max(Duration::from_secs(1))
                        .min(Duration::from_secs(30));
                }
            }
        }
    }

    fn is_current(&self, snapshot: &ResolutionSnapshot) -> bool {
        self.control.lock().unwrap().revision == snapshot.revision
    }

    pub(super) async fn snapshot(
        &self,
        state: &AppState,
    ) -> Result<Arc<ResolutionSnapshot>, String> {
        self.load_snapshot(|revision| async move {
            let client = get_client(state).await?;
            build_snapshot(state, self, &client, revision).await
        })
        .await
    }

    async fn load_snapshot<F, Fut>(&self, mut build: F) -> Result<Arc<ResolutionSnapshot>, String>
    where
        F: FnMut(u64) -> Fut,
        Fut: Future<Output = Result<ResolutionSnapshot, String>>,
    {
        self.run(async {
            // Include time spent waiting for another reader, so a failed server
            // cannot leave a queue of notification requests waiting indefinitely.
            tokio::time::timeout(Duration::from_secs(20), async {
                let _guard = self.snapshot_load.lock().await;
                loop {
                    let revision = {
                        let control = self.control.lock().unwrap();
                        if let Some(snapshot) = &control.snapshot {
                            return Ok(snapshot.clone());
                        }
                        if let Some((failed_at, error)) = &control.snapshot_error {
                            if failed_at.elapsed() < Duration::from_secs(1) {
                                return Err(error.clone());
                            }
                        }
                        control.revision
                    };
                    let result = build(revision).await;
                    let mut control = self.control.lock().unwrap();
                    if control.revision != revision {
                        continue;
                    }
                    match result {
                        Ok(snapshot) => {
                            let snapshot = Arc::new(snapshot);
                            control.snapshot = Some(snapshot.clone());
                            control.snapshot_error = None;
                            return Ok(snapshot);
                        }
                        Err(error) => {
                            // Concurrent readers share failures as well as
                            // successes; they must not each retry the same GET.
                            control.snapshot_error = Some((Instant::now(), error.clone()));
                            return Err(error);
                        }
                    }
                }
            })
            .await
            .map_err(|_| "Notification snapshot timed out".to_string())?
        })
        .await
    }
}

/// Room → direct parent space → global → room-type default. When multiple
/// configured parents disagree, the lexicographically smallest space ID wins.
/// This keeps the result stable across HashMap iteration and all consumers.
fn inherited_level(
    room_id: &str,
    settings: &NotificationSettings,
    parents: &ParentSpaces,
) -> Option<NotificationLevel> {
    settings
        .rooms
        .get(room_id)
        .copied()
        .or_else(|| {
            parents.get(room_id).and_then(|parents| {
                parents
                    .keys()
                    .find_map(|id| settings.spaces.get(id).copied())
            })
        })
        .or(settings.global_default)
}

async fn build_snapshot(
    state: &AppState,
    session: &NotificationSession,
    client: &Client,
    revision: u64,
) -> Result<ResolutionSnapshot, String> {
    let settings = load_settings_for_session(state, session).await?;
    let children = load_space_graph(client).await?;
    let parents = index_parent_spaces(&children);
    let levels = stream::iter(
        client
            .joined_rooms()
            .into_iter()
            .filter(|room| !room.is_space())
            .map(|room| {
                let settings = &settings;
                let parents = &parents;
                async move {
                    let id = room.room_id().to_string();
                    let level = match inherited_level(&id, settings, parents) {
                        Some(level) => level,
                        None => {
                            let direct =
                                tokio::time::timeout(Duration::from_secs(5), room.is_direct())
                                    .await
                                    .map_err(|_| "Direct-room lookup timed out".to_string())?
                                    .map_err(|e| format!("Direct-room lookup failed: {e}"))?;
                            if direct {
                                NotificationLevel::All
                            } else {
                                NotificationLevel::AllMentions
                            }
                        }
                    };
                    Ok::<_, String>((id, level))
                }
            }),
    )
    .buffer_unordered(24)
    .try_collect()
    .await?;
    Ok(ResolutionSnapshot {
        revision,
        children,
        levels,
    })
}

async fn reconcile_pass(
    state: &AppState,
    session: &NotificationSession,
    app: &AppHandle,
    scope: ReconcileScope,
) -> Result<ReconcileReport, String> {
    let snapshot = session.snapshot(state).await?;
    let targets = scope.targets(&snapshot);
    let mut report = ReconcileReport::default();
    if targets.is_empty() {
        let _ = app.emit("pax-notification-reconciled", &report);
        return Ok(report);
    }
    // Capture authentication once. An obsolete pass must never acquire the
    // credentials of a replacement session partway through its writes.
    let auth = get_authed_client(state).await?;
    let rules = load_push_rules_for_client(&state.http_client, &auth).await?;
    let snapshot_ref = &snapshot;
    let rules_ref = &rules;
    let auth_ref = &auth;
    let mut writes = stream::iter(targets.into_iter().map(|room_id| async move {
        if !session.is_current(snapshot_ref) {
            return Ok(false);
        }
        let desired = snapshot_ref.levels[&room_id];
        if has_suppression_installed(rules_ref, &room_id) == (desired != NotificationLevel::All) {
            return Ok(false);
        }
        apply_level_to_room_for_client(&state.http_client, auth_ref, &room_id, desired, rules_ref)
            .await
            .map(|()| true)
            .map_err(|error| format!("{room_id}: {error}"))
    }))
    .buffer_unordered(4);
    while let Some(result) = writes.next().await {
        if !session.is_current(&snapshot) {
            return Err("Notification intent changed during pass".into());
        }
        report.examined += 1;
        match result {
            Ok(true) => report.applied += 1,
            Ok(false) => {}
            Err(error) => {
                report.errors += 1;
                log::warn!("[pax reconcile] {error}");
            }
        }
    }
    let _ = app.emit("pax-notification-reconciled", &report);
    Ok(report)
}

pub(super) async fn resolve_effective_level(
    state: &AppState,
    room_id: &str,
) -> Result<NotificationLevel, String> {
    state
        .notifications
        .session()
        .snapshot(state)
        .await?
        .levels
        .get(room_id)
        .copied()
        .ok_or_else(|| "Joined room not found".into())
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub examined: u32,
    pub applied: u32,
    pub errors: u32,
}

/// Enqueue a full pass. Completion is reported by pax-notification-reconciled.
#[tauri::command]
pub async fn reconcile_all_notification_levels(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    get_client(&state).await?;
    state
        .notifications
        .schedule(&state, &app, ReconcileScope::all());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room_relationships::SpaceChildMeta;
    use tokio::sync::{mpsc, Semaphore};

    fn graph(edges: &[(&str, &[&str])]) -> SpaceChildren {
        edges
            .iter()
            .map(|(parent, children)| {
                (
                    parent.to_string(),
                    children
                        .iter()
                        .map(|id| SpaceChildMeta {
                            child_id: id.to_string(),
                            order: None,
                            origin_server_ts: 0,
                        })
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn room_space_and_global_precedence_and_link_removal() {
        let mut settings = NotificationSettings::default();
        settings.global_default = Some(NotificationLevel::AllMentions);
        settings
            .spaces
            .insert("!parent:server".into(), NotificationLevel::None);
        let children = graph(&[("!parent:server", &["!room:server"])]);
        assert_eq!(
            inherited_level("!room:server", &settings, &index_parent_spaces(&children)),
            Some(NotificationLevel::None)
        );
        settings
            .rooms
            .insert("!room:server".into(), NotificationLevel::All);
        assert_eq!(
            inherited_level("!room:server", &settings, &index_parent_spaces(&children)),
            Some(NotificationLevel::All)
        );
        settings.rooms.clear();
        // A tombstoned edge is absent from the shared parser's graph.
        assert_eq!(
            inherited_level(
                "!room:server",
                &settings,
                &index_parent_spaces(&graph(&[("!parent:server", &[])]))
            ),
            Some(NotificationLevel::AllMentions)
        );
        settings.global_default = None;
        assert_eq!(
            inherited_level(
                "!unrelated:server",
                &settings,
                &index_parent_spaces(&children)
            ),
            None
        );
    }

    #[test]
    fn inheritance_is_direct_and_multiple_parent_precedence_is_stable() {
        let mut settings = NotificationSettings::default();
        settings
            .spaces
            .insert("!z:server".into(), NotificationLevel::All);
        settings
            .spaces
            .insert("!a:server".into(), NotificationLevel::None);
        let children = graph(&[
            ("!z:server", &["!room:server"]),
            ("!a:server", &["!room:server", "!sub:server"]),
            ("!sub:server", &["!nested:server"]),
        ]);
        assert_eq!(
            inherited_level("!room:server", &settings, &index_parent_spaces(&children)),
            Some(NotificationLevel::None)
        );
        assert_eq!(
            inherited_level("!nested:server", &settings, &index_parent_spaces(&children)),
            None
        );
        let removed_target = ReconcileScope::room("!removed:server");
        let snapshot = ResolutionSnapshot {
            revision: 0,
            children,
            levels: HashMap::from([("!removed:server".into(), NotificationLevel::All)]),
        };
        assert!(removed_target
            .targets(&snapshot)
            .contains("!removed:server"));
    }

    #[test]
    fn bursts_merge_scopes_and_full_pass_supersedes_them() {
        let session = NotificationSession::default();
        assert!(session.enqueue(ReconcileScope::room("!one:server"), true));
        assert!(!session.enqueue(ReconcileScope::room("!one:server"), true));
        assert!(!session.enqueue(ReconcileScope::space("!space:server"), true));
        let pending = session.take_work().unwrap();
        assert_eq!(pending.rooms.len(), 1);
        assert_eq!(pending.spaces.len(), 1);
        session.enqueue(pending, true);
        assert!(!session.enqueue(ReconcileScope::all(), true));
        assert!(!session.enqueue(ReconcileScope::room("!two:server"), true));
        assert_eq!(session.take_work(), Some(ReconcileScope::all()));
        assert_eq!(session.take_work(), None);
        assert!(session.enqueue(ReconcileScope::room("!new:server"), true));
    }

    #[test]
    fn settings_diff_includes_discovered_remote_edits_and_ignores_tray_changes() {
        let mut before = NotificationSettings::default();
        before
            .spaces
            .insert("!space:server".into(), NotificationLevel::None);
        let mut after = before.clone();
        after.tray_unread_indicator = super::super::pax_settings::TrayUnreadIndicatorMode::Never;
        assert!(ReconcileScope::settings_changed(Some(&before), &after).is_empty());
        after.spaces.clear();
        after
            .rooms
            .insert("!edited:server".into(), NotificationLevel::All);
        after
            .rooms
            .insert("!remote:server".into(), NotificationLevel::None);
        let scope = ReconcileScope::settings_changed(Some(&before), &after);
        assert_eq!(scope.spaces, HashSet::from(["!space:server".into()]));
        assert_eq!(
            scope.rooms,
            HashSet::from(["!edited:server".into(), "!remote:server".into()])
        );
        after.global_default = Some(NotificationLevel::None);
        assert_eq!(
            ReconcileScope::settings_changed(Some(&before), &after),
            ReconcileScope::all()
        );
        assert_eq!(
            ReconcileScope::settings_changed(None, &after),
            ReconcileScope::all()
        );
    }

    #[test]
    fn push_rule_echo_does_not_discard_levels_or_supersede_an_active_pass() {
        let session = NotificationSession::default();
        let snapshot = Arc::new(ResolutionSnapshot {
            revision: 0,
            children: SpaceChildren::new(),
            levels: HashMap::new(),
        });
        session.control.lock().unwrap().snapshot = Some(snapshot.clone());
        assert!(session.enqueue(ReconcileScope::all(), false));
        assert!(session.is_current(&snapshot));
        assert!(Arc::ptr_eq(
            session.control.lock().unwrap().snapshot.as_ref().unwrap(),
            &snapshot
        ));
        session.enqueue(ReconcileScope::room("!changed:server"), true);
        assert!(!session.is_current(&snapshot));
        assert!(session.control.lock().unwrap().snapshot.is_none());
    }

    #[tokio::test]
    async fn concurrent_snapshot_readers_share_failures_and_invalidation_retries() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let session = NotificationSession::default();
        let loads = AtomicUsize::new(0);
        let results = futures_util::future::join_all((0..10).map(|_| {
            session.load_snapshot(|_| async {
                loads.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Err("server offline".into())
            })
        }))
        .await;
        assert!(results.iter().all(|result| result
            .as_ref()
            .err()
            .is_some_and(|error| error == "server offline")));
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        session.enqueue(ReconcileScope::all(), true);
        let snapshot = session
            .load_snapshot(|revision| async move {
                Ok(ResolutionSnapshot {
                    revision,
                    children: SpaceChildren::new(),
                    levels: HashMap::new(),
                })
            })
            .await
            .unwrap();
        let cached = session
            .load_snapshot(|_| async { panic!("cached snapshot should be reused") })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&snapshot, &cached));
    }

    #[tokio::test]
    async fn relationship_change_during_snapshot_load_rejects_the_old_result() {
        let session = NotificationSession::default();
        let mut loads = 0;
        let snapshot = session
            .load_snapshot(|revision| {
                loads += 1;
                if loads == 1 {
                    session.enqueue(ReconcileScope::room("!changed:server"), true);
                }
                async move {
                    Ok(ResolutionSnapshot {
                        revision,
                        children: SpaceChildren::new(),
                        levels: HashMap::new(),
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(loads, 2);
        assert!(session.is_current(&snapshot));
    }

    #[tokio::test]
    async fn stalled_maintenance_allows_enqueue_and_one_followup_pass() {
        let session = Arc::new(NotificationSession::default());
        session.enqueue(ReconcileScope::room("!first:server"), true);
        let permit = Arc::new(Semaphore::new(0));
        let (sent, mut received) = mpsc::unbounded_channel();
        let worker_session = session.clone();
        let worker_permit = permit.clone();
        let task = tokio::spawn(async move {
            let mut first = true;
            worker_session
                .run(worker_session.work_loop(Duration::ZERO, |scope| {
                    let block = first;
                    first = false;
                    let permit = worker_permit.clone();
                    sent.send(scope).unwrap();
                    async move {
                        if block {
                            permit.acquire().await.unwrap().forget();
                        }
                        Ok(ReconcileReport::default())
                    }
                }))
                .await
        });
        assert_eq!(
            received.recv().await.unwrap(),
            ReconcileScope::room("!first:server")
        );
        // These calls complete while the simulated HTTP request is blocked.
        for _ in 0..50 {
            assert!(!session.enqueue(ReconcileScope::room("!second:server"), true));
        }
        assert!(received.try_recv().is_err());
        permit.add_permits(1);
        let next = tokio::time::timeout(Duration::from_secs(1), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next, ReconcileScope::room("!second:server"));
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
        assert!(received.try_recv().is_err());
    }

    #[tokio::test]
    async fn session_replacement_cancels_active_work_and_rejects_late_requests() {
        let service = NotificationService::default();
        assert!(service.session().run(async { Ok(()) }).await.is_err());
        service.start_session();
        let session = service.session();
        let (sent, mut received) = mpsc::unbounded_channel();
        let old = session.clone();
        let task = tokio::spawn(async move {
            old.run(async {
                sent.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            })
            .await
        });
        received.recv().await.unwrap();
        service.reset();
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(session
            .run(async {
                panic!("cancelled work must not run");
                #[allow(unreachable_code)]
                Ok(())
            })
            .await
            .is_err());
        service.start_session();
        assert!(service.session().settings().1.is_none());
    }

    #[test]
    fn late_settings_fetch_cannot_overwrite_a_save_or_invalidation() {
        let session = NotificationSession::default();
        let old_revision = session.settings().0;
        assert!(session.fail_settings(old_revision, "offline".into()));
        assert_eq!(session.settings_error().as_deref(), Some("offline"));
        let mut latest = NotificationSettings::default();
        latest.global_default = Some(NotificationLevel::None);
        session.set_settings(latest.clone());
        assert!(session.settings_error().is_none());
        assert!(!session.fail_settings(old_revision, "late failure".into()));
        assert!(!session.cache_settings(old_revision, NotificationSettings::default()));
        assert_eq!(session.settings().1, Some(latest.clone()));
        assert!(!session.invalidate_settings_if_different(&latest));
        let revision = session.settings().0;
        assert!(session.invalidate_settings_if_different(&NotificationSettings::default()));
        assert!(!session.cache_settings(revision, latest));
        assert!(session.settings().1.is_none());
    }

    #[tokio::test]
    async fn new_intent_wakes_a_failed_pass_without_waiting_for_backoff() {
        let session = Arc::new(NotificationSession::default());
        session.enqueue(ReconcileScope::room("!one:server"), true);
        let (sent, mut received) = mpsc::unbounded_channel();
        let worker_session = session.clone();
        let task = tokio::spawn(async move {
            worker_session
                .run(worker_session.work_loop(Duration::ZERO, |scope| {
                    sent.send(scope).unwrap();
                    async { Err("server unavailable".into()) }
                }))
                .await
        });
        received.recv().await.unwrap();
        // Let the failed pass enter its one-second retry wait.
        tokio::task::yield_now().await;
        session.enqueue(ReconcileScope::room("!two:server"), true);
        let next = tokio::time::timeout(Duration::from_millis(250), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(next.rooms.contains("!one:server"));
        assert!(next.rooms.contains("!two:server"));
        session.cancelled.send_replace(true);
        assert!(task.await.unwrap().is_err());
    }
}

use std::{
    path::{Path, PathBuf},
    ptr,
    sync::{Arc, OnceLock, Weak},
    time::Duration,
};

use jni::{
    objects::{JObject, JString},
    sys::{jboolean, jstring, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};
use matrix_sdk::{
    authentication::matrix::MatrixSession,
    deserialized_responses::TimelineEvent,
    ruma::{EventId, OwnedUserId, RoomId, UserId},
    Client, Room, SessionMeta,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{
    commands::{
        auth::{persist_refreshed_tokens, read_credentials_at, CREDENTIALS_FILENAME},
        direct_calls, group_calls, matrix_voip,
    },
    crypto_store::{self, OpenMode},
    voice_presence::now_ms,
    AppState,
};

static APP: OnceLock<Weak<AppState>> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
pub(crate) static COLD_STORE: Mutex<()> = Mutex::const_new(());

pub(crate) fn set_app_state(state: &Arc<AppState>) {
    let _ = APP.set(Arc::downgrade(state));
}

pub(crate) fn runtime() -> Option<&'static tokio::runtime::Runtime> {
    if let Some(runtime) = RUNTIME.get() {
        return Some(runtime);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .ok()?;
    Some(RUNTIME.get_or_init(|| runtime))
}

pub(crate) fn app_state() -> Option<Arc<AppState>> {
    APP.get().and_then(Weak::upgrade)
}

pub(crate) async fn saved_client(base: &Path) -> Option<Client> {
    let path = base.join(CREDENTIALS_FILENAME);
    let credentials = read_credentials_at(&path).ok()??;
    if credentials.pax_enrollment_pending {
        return None;
    }
    if option_env!("PAX_HOMESERVER").is_some_and(|configured| {
        configured.trim_end_matches('/') != credentials.homeserver.trim_end_matches('/')
    }) {
        return None;
    }
    let session = credentials.session?;
    let root = crypto_store::session_path(
        base,
        credentials.sqlite_store_dir.as_deref().unwrap_or("matrix_store"),
    )
    .ok()?;
    let store = crypto_store::config(base, &root, OpenMode::Existing).await.ok()?;
    // A cold push can read the existing device keys. It must not create a new identity
    // or advance the normal sync token before the UI sees the ringing event.
    let client = Client::builder()
        .homeserver_url(&credentials.homeserver)
        .store_config(store)
        .handle_refresh_tokens()
        .build()
        .await
        .ok()?;
    persist_refreshed_tokens(&client, path, &session).ok()?;
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: UserId::parse(&session.user_id).ok()?,
                device_id: session.device_id.clone().into(),
            },
            tokens: session.tokens(),
        })
        .await
        .ok()?;
    Some(client)
}

async fn push_client(base: &Path) -> Option<Client> {
    if let Some(state) = app_state() {
        return state.client.lock().await.clone();
    }
    saved_client(base).await
}

async fn inspect_event(base: PathBuf, room_id: String, event_id: String) -> Option<Value> {
    let room_id = RoomId::parse(room_id).ok()?;
    let event_id = EventId::parse(event_id).ok()?;
    let _store = COLD_STORE.lock().await;
    let client = push_client(&base).await?;
    let room = client.get_room(&room_id)?;
    let context = room
        .event_with_context(&event_id, true, 24u32.into(), None)
        .await
        .ok()?;
    let event = context.event.as_ref()?;
    if let Some(outcome) = group_calls::push_event(&room, event, &context.events_after, &context.state).await { return Some(outcome); }
    if let Some(outcome) =
        matrix_voip::call_push_event(&room, event, &context.events_before, &context.events_after)
            .await
    {
        return Some(outcome);
    }

    if event.raw().get_field::<&str>("type").ok().flatten() == Some("com.carter.pax.direct_call") {
        let ignored = json!({ "kind": "ignore" });
        let Some(peer) = direct_calls::direct_call_peer(&room).await else {
            return Some(ignored);
        };
        if is_ignored(&client, &peer).await {
            return Some(ignored);
        }
        return direct_calls::call_push_event(
            &room,
            &peer,
            event,
            &context.events_before,
            &context.events_after,
            now_ms(),
        )
        .await
        .or(Some(ignored));
    }
    message_push_event(&room, event).await
}

async fn is_ignored(client: &Client, sender: &UserId) -> bool {
    if let Some(state) = app_state() {
        state.ignored_users.users(client).await.contains(sender)
    } else {
        client.is_user_ignored(sender).await
    }
}

async fn message_push_event(room: &Room, event: &TimelineEvent) -> Option<Value> {
    let raw = event.raw();
    let sender = raw.get_field::<OwnedUserId>("sender").ok()??;
    let sender: &UserId = &sender;
    if sender == room.own_user_id() || is_ignored(&room.client(), sender).await {
        return Some(json!({ "kind": "ignore" }));
    }

    // The SDK evaluated the actions against the event after decryption.
    let actions = event.push_actions()?;
    if !actions.iter().any(|action| action.should_notify()) {
        return Some(json!({ "kind": "ignore" }));
    }
    if raw.get_field::<&str>("type").ok()?? == "m.room.encrypted" {
        return None;
    }

    let content: Option<Value> = raw.get_field("content").ok()?;
    let preview = content
        .as_ref()
        .and_then(|content| content["body"].as_str());
    let sender_name = room
        .get_member_no_sync(sender)
        .await
        .ok()
        .flatten()
        .and_then(|member| member.display_name().map(str::to_owned));
    Some(json!({
        "kind": "message",
        "sender": sender_name.as_deref().unwrap_or(sender.as_str()),
        "roomName": room.cached_display_name().map(|name| name.to_string()).unwrap_or_default(),
        "preview": preview.unwrap_or_default(),
        "silent": !actions.iter().any(|action| action.sound().is_some()),
    }))
}

#[no_mangle]
pub extern "system" fn Java_com_carter_pax_PaxCallPush_resolve(
    mut env: JNIEnv<'_>,
    _this: JObject<'_>,
    base: JString<'_>,
    room_id: JString<'_>,
    event_id: JString<'_>,
) -> jstring {
    let run = || -> Option<jstring> {
        let base = PathBuf::from(String::from(env.get_string(&base).ok()?));
        let room_id: String = env.get_string(&room_id).ok()?.into();
        let event_id: String = env.get_string(&event_id).ok()?.into();
        let value = runtime()?.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(4),
                inspect_event(base, room_id, event_id),
            )
            .await
            .ok()
            .flatten()
        })?;
        Some(env.new_string(value.to_string()).ok()?.into_raw())
    };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
        .ok()
        .flatten()
        .unwrap_or(ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_com_carter_pax_PaxCallPush_decline(
    mut env: JNIEnv<'_>,
    _this: JObject<'_>,
    base: JString<'_>,
    room_id: JString<'_>,
    call_id: JString<'_>,
    matrix_ring_event_id: JString<'_>,
) -> jboolean {
    let run = || -> Option<bool> {
        let base = PathBuf::from(String::from(env.get_string(&base).ok()?));
        let room_id = RoomId::parse(String::from(env.get_string(&room_id).ok()?)).ok()?;
        let call_id: String = env.get_string(&call_id).ok()?.into();
        let matrix_ring_event_id: String = env.get_string(&matrix_ring_event_id).ok()?.into();
        runtime()?.block_on(async {
            tokio::time::timeout(Duration::from_secs(6), async {
                let _store = COLD_STORE.lock().await;
                let client = push_client(&base).await?;
                let room = client.get_room(&room_id)?;
                Some(if matrix_ring_event_id.is_empty() {
                    direct_calls::decline_pushed_call(&client, &room, call_id).await
                } else {
                    matrix_voip::decline_pushed_call(&room, &call_id, &matrix_ring_event_id).await
                })
            })
            .await
            .ok()
            .flatten()
        })
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(Some(true)) => JNI_TRUE,
        _ => JNI_FALSE,
    }
}

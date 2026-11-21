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
    authentication::{matrix::MatrixSession, SessionTokens},
    ruma::{EventId, RoomId, UserId},
    Client, SessionMeta,
};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    commands::{
        auth::{SavedCredentials, CREDENTIALS_FILENAME},
        direct_calls,
    },
    voice_presence::now_ms,
    AppState,
};

static APP: OnceLock<Weak<AppState>> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
pub(crate) static COLD_STORE: Mutex<()> = Mutex::const_new(());

pub(crate) fn set_app_state(state: &Arc<AppState>) {
    let _ = APP.set(Arc::downgrade(state));
}

fn runtime() -> Option<&'static tokio::runtime::Runtime> {
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

async fn saved_client(base: &Path) -> Option<Client> {
    let credentials: SavedCredentials =
        serde_json::from_slice(&std::fs::read(base.join(CREDENTIALS_FILENAME)).ok()?).ok()?;
    if credentials.pax_enrollment_pending {
        return None;
    }
    if option_env!("PAX_HOMESERVER").is_some_and(|configured| {
        configured.trim_end_matches('/') != credentials.homeserver.trim_end_matches('/')
    }) {
        return None;
    }
    let session = credentials.session?;
    let store = base
        .join(
            credentials
                .sqlite_store_dir
                .as_deref()
                .unwrap_or("matrix_store"),
        )
        .canonicalize()
        .ok()?;
    if !store.starts_with(base.canonicalize().ok()?) {
        return None;
    }
    // A cold push can read the existing device keys. It must not create a new identity
    // or advance the normal sync token before the UI sees the ringing event.
    let client = Client::builder()
        .homeserver_url(&credentials.homeserver)
        .sqlite_store(store, None)
        .build()
        .await
        .ok()?;
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: UserId::parse(&session.user_id).ok()?,
                device_id: session.device_id.into(),
            },
            tokens: SessionTokens {
                access_token: session.access_token,
                refresh_token: None,
            },
        })
        .await
        .ok()?;
    Some(client)
}

async fn push_client(base: &Path) -> Option<Client> {
    if let Some(state) = APP.get().and_then(Weak::upgrade) {
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
    let peer = direct_calls::direct_call_peer(&room).await?;
    let ignored = if let Some(state) = APP.get().and_then(Weak::upgrade) {
        state.ignored_users.users(&client).await.contains(&peer)
    } else {
        client.is_user_ignored(&peer).await
    };
    if ignored {
        return Some(serde_json::json!({ "kind": "ignore" }));
    }
    let context = room
        .event_with_context(&event_id, true, 24u32.into(), None)
        .await
        .ok()?;
    direct_calls::call_push_event(
        &room,
        &peer,
        context.event.as_ref()?,
        &context.events_before,
        &context.events_after,
        now_ms(),
    )
    .await
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
) -> jboolean {
    let run = || -> Option<bool> {
        let base = PathBuf::from(String::from(env.get_string(&base).ok()?));
        let room_id = RoomId::parse(String::from(env.get_string(&room_id).ok()?)).ok()?;
        let call_id: String = env.get_string(&call_id).ok()?.into();
        runtime()?.block_on(async {
            tokio::time::timeout(Duration::from_secs(6), async {
                let _store = COLD_STORE.lock().await;
                let client = push_client(&base).await?;
                let room = client.get_room(&room_id)?;
                Some(direct_calls::decline_pushed_call(&client, &room, call_id).await)
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

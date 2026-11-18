use super::*;
use crate::commands::{
    auth::SavedSession,
    messages::unavailable_message,
    pax_auth::tests::{client, Server, TestDir, USER},
};
use serde_json::json;

const ROOM: &str = "!test:example.org";

#[tokio::test]
async fn context_menu_clears_a_readable_conversation_without_loading_it_in_the_ui() {
    let (server, _dir, sdk, room) = setup().await;
    {
        let mut state = server.state.lock().unwrap();
        // Timeline order, not a sender's clock, chooses the acknowledgement.
        state.timeline = vec![
            json!({"type":"m.room.message","event_id":"$older","sender":"@bob:example.org","origin_server_ts":900,"content":{"msgtype":"m.text","body":"older"}}),
            json!({"type":"m.room.message","event_id":"$latest","sender":"@bob:example.org","origin_server_ts":100,"content":{"msgtype":"m.text","body":"latest"}}),
        ];
    }
    let http = reqwest::Client::new();
    let pending = Default::default();
    let raw = Default::default();
    let cache = Default::default();
    let record = clear_notification(&http, &sdk, &room, &pending, &raw, &cache, |_| {})
        .await
        .unwrap()
        .unwrap();
    assert!(
        record.event_ids.is_empty(),
        "No unavailable messages are needed to clear a room"
    );
    assert_eq!(record.through_event_id.as_deref(), Some("$latest"));
    assert_eq!(
        server.state.lock().unwrap().private_receipt.as_deref(),
        Some("$latest")
    );
    assert_eq!(
        cache.lock().await[room.room_id()],
        RoomUnreadState::default()
    );
    assert!(server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(_, path, _)| !path.contains("/receipt/m.read/")));
}

#[tokio::test]
async fn context_menu_clears_unavailable_messages_and_preserves_their_placeholders() {
    let (server, _dir, sdk, room) = setup().await;
    let http = reqwest::Client::new();
    let pending = Default::default();
    let raw = Default::default();
    let cache = Default::default();
    let record = clear_notification(&http, &sdk, &room, &pending, &raw, &cache, |_| {})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.event_ids, vec!["$missing"]);
    assert_eq!(
        server.state.lock().unwrap().private_receipt.as_deref(),
        Some("$missing")
    );
    assert_eq!(
        cache.lock().await[room.room_id()],
        RoomUnreadState::default()
    );
    let stored = fetch_ack(&http, &sdk, &room).await.unwrap();
    assert_eq!(stored.event_ids, record.event_ids);
    assert!(unavailable_message(
        &serde_json::value::to_raw_value(&server.state.lock().unwrap().timeline[0]).unwrap()
    )
    .is_some());
}

#[tokio::test]
async fn context_menu_handles_empty_conversations_without_inventing_a_receipt() {
    let server = Server::start().await;
    server.state.lock().unwrap().joined_test_room = true;
    let dir = TestDir::new();
    let sdk = client(
        &server.home,
        &dir.0.join("empty"),
        SavedSession {
            user_id: USER.into(),
            device_id: "EMPTY".into(),
            access_token: "token".into(),
        },
    )
    .await;
    let room = sdk
        .get_room(&matrix_sdk::ruma::RoomId::parse(ROOM).unwrap())
        .unwrap();
    let http = reqwest::Client::new();
    let pending = Default::default();
    let raw = Default::default();
    let cache = Default::default();
    assert!(
        clear_notification(&http, &sdk, &room, &pending, &raw, &cache, |_| {})
            .await
            .unwrap()
            .is_none()
    );
    assert!(server.state.lock().unwrap().private_receipt.is_none());
}

#[tokio::test]
async fn context_menu_reports_missing_timeline_instead_of_claiming_unread_was_cleared() {
    let (server, _dir, sdk, room) = setup().await;
    server.state.lock().unwrap().timeline.clear();
    let http = reqwest::Client::new();
    let pending = Default::default();
    let raw = Default::default();
    let cache = Default::default();
    assert!(
        clear_notification(&http, &sdk, &room, &pending, &raw, &cache, |_| panic!(
            "A failed clear must preserve the indicator"
        ))
        .await
        .err().unwrap()
        .contains("latest event is unavailable")
    );
    assert!(server.state.lock().unwrap().private_receipt.is_none());
}

fn encrypted(id: &str, timestamp: u64) -> serde_json::Value {
    json!({"type":"m.room.encrypted","event_id":id,"sender":"@bob:example.org","origin_server_ts":timestamp,
        "content":{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"AwgA","sender_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "session_id":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","device_id":"BOB"}})
}

async fn setup() -> (Server, TestDir, Client, Room) {
    let server = Server::start().await;
    let dir = TestDir::new();
    {
        let mut s = server.state.lock().unwrap();
        s.joined_test_room = true;
        s.unread_count = 1;
        s.timeline = vec![encrypted("$missing", 100)];
    }
    let sdk = client(
        &server.home,
        &dir.0.join("original"),
        SavedSession {
            user_id: USER.into(),
            device_id: "ORIGINAL".into(),
            access_token: "token".into(),
        },
    )
    .await;
    let room = sdk
        .get_room(&matrix_sdk::ruma::RoomId::parse(ROOM).unwrap())
        .unwrap();
    (server, dir, sdk, room)
}

#[test]
fn ciphertext_placeholder_preserves_metadata_and_excludes_redactions_and_encrypted_edits() {
    let original = encrypted("$missing", 100);
    let raw = serde_json::value::to_raw_value(&original).unwrap();
    let placeholder = unavailable_message(&raw).unwrap();
    assert!(placeholder.decryption_failed);
    assert_eq!(placeholder.event_id, "$missing");
    assert_eq!(placeholder.sender, "@bob:example.org");
    assert_eq!(placeholder.timestamp, 100);
    let sent = serde_json::to_string(&placeholder).unwrap();
    assert!(!sent.contains("ciphertext") && !sent.contains("AwgA") && !sent.contains("session_id"));
    let mut redacted = original.clone();
    redacted["unsigned"] = json!({"redacted_because":{}});
    assert!(unavailable_message(&serde_json::value::to_raw_value(&redacted).unwrap()).is_none());
    for relation in ["m.replace", "m.annotation"] {
        let mut value = original.clone();
        value["content"]["m.relates_to"] = json!({"rel_type":relation,"event_id":"$other"});
        assert!(unavailable_message(&serde_json::value::to_raw_value(&value).unwrap()).is_none());
    }
    let mut plaintext = original;
    plaintext["type"] = "m.room.message".into();
    assert!(unavailable_message(&serde_json::value::to_raw_value(&plaintext).unwrap()).is_none());
}

#[tokio::test]
async fn private_clear_is_immediate_persistent_and_independent_of_decryption() {
    let (server, dir, sdk, room) = setup().await;
    let http = reqwest::Client::new();
    let pending: PendingUnavailableReads = Default::default();
    let raw: super::super::unread::RawUnreadMessageCounts = Default::default();
    let cache: super::super::unread::UnreadStateCache = Default::default();
    raw.lock().await.insert(room.room_id().to_owned(), 1);
    let page = room
        .messages(matrix_sdk::room::MessagesOptions::backward())
        .await
        .unwrap();
    assert_eq!(page.chunk.len(), 1);
    assert!(
        unavailable_message(page.chunk[0].raw().json()).is_some(),
        "The real SDK must retain the undecrypted event"
    );
    assert!(RoomUnreadState::from_room_with_raw(&room, 1).messages > 0);
    let emitted = Arc::new(std::sync::Mutex::new(vec![]));
    let events = emitted.clone();
    let saved = acknowledge(
        &http,
        &sdk,
        &room,
        &pending,
        &raw,
        &cache,
        "$missing".into(),
        vec!["$missing".into()],
        move |event| events.lock().unwrap().push(event),
    )
    .await
    .unwrap();
    assert_eq!(saved.event_ids, vec!["$missing"]);
    assert_eq!(saved.through_event_id.as_deref(), Some("$missing"));
    assert_eq!(emitted.lock().unwrap()[0].state, RoomUnreadState::default());
    assert_eq!(
        cache.lock().await[room.room_id()],
        RoomUnreadState::default()
    );
    assert_eq!(
        server.state.lock().unwrap().private_receipt.as_deref(),
        Some("$missing")
    );
    assert!(server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(_, path, _)| !path.contains("/receipt/m.read/")));
    let fresh = client(
        &server.home,
        &dir.0.join("fresh"),
        SavedSession {
            user_id: USER.into(),
            device_id: "FRESH".into(),
            access_token: "fresh".into(),
        },
    )
    .await;
    let fresh_room = fresh
        .get_room(&matrix_sdk::ruma::RoomId::parse(ROOM).unwrap())
        .unwrap();
    let restored = fetch_ack(&http, &fresh, &fresh_room).await.unwrap();
    assert_eq!(restored.event_ids, saved.event_ids);
    assert_eq!(
        fresh_room.unread_notification_counts().notification_count,
        0
    );
    // Clearing is acknowledgement only. The ciphertext still has a placeholder.
    assert!(unavailable_message(
        fresh_room
            .messages(matrix_sdk::room::MessagesOptions::backward())
            .await
            .unwrap()
            .chunk[0]
            .raw()
            .json()
    )
    .is_some());
}

#[tokio::test]
async fn failed_private_receipt_keeps_unread_and_can_be_retried() {
    let (server, _dir, sdk, room) = setup().await;
    let http = reqwest::Client::new();
    let pending: PendingUnavailableReads = Default::default();
    let raw: super::super::unread::RawUnreadMessageCounts = Default::default();
    let cache: super::super::unread::UnreadStateCache = Default::default();
    raw.lock().await.insert(room.room_id().to_owned(), 2);
    server.state.lock().unwrap().fail_receipt = true;
    assert!(acknowledge(
        &http,
        &sdk,
        &room,
        &pending,
        &raw,
        &cache,
        "$missing".into(),
        vec!["$missing".into()],
        |_| panic!("A failed receipt must not clear the badge")
    )
    .await
    .is_err());
    assert!(pending.lock().await.is_empty());
    assert_eq!(raw.lock().await[room.room_id()], 2);
    assert!(fetch_ack(&http, &sdk, &room)
        .await
        .unwrap()
        .event_ids
        .is_empty());
    server.state.lock().unwrap().fail_receipt = false;
    acknowledge(
        &http,
        &sdk,
        &room,
        &pending,
        &raw,
        &cache,
        "$missing".into(),
        vec!["$missing".into()],
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(cache.lock().await[room.room_id()].messages, 0);
}

#[tokio::test]
async fn a_message_arriving_during_clear_remains_unread_even_after_the_receipt_echo() {
    let (server, _dir, sdk, room) = setup().await;
    let http = reqwest::Client::new();
    let pending: PendingUnavailableReads = Default::default();
    let raw: super::super::unread::RawUnreadMessageCounts = Default::default();
    let cache: super::super::unread::UnreadStateCache = Default::default();
    raw.lock().await.insert(room.room_id().to_owned(), 4);
    server.state.lock().unwrap().receipt_delay_ms = 100;
    let future = acknowledge(
        &http,
        &sdk,
        &room,
        &pending,
        &raw,
        &cache,
        "$missing".into(),
        vec!["$missing".into()],
        |_| {},
    );
    let arrival = async {
        loop {
            if server.state.lock().unwrap().private_receipt.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        {
            let mut s = server.state.lock().unwrap();
            s.timeline.push(encrypted("$new", 101));
            s.unread_count = 1;
        }
        note_incoming(&pending, &room).await;
        *raw.lock().await.get_mut(room.room_id()).unwrap() += 1;
    };
    let (result, _) = tokio::join!(future, arrival);
    result.unwrap();
    assert_eq!(
        raw.lock().await[room.room_id()],
        1,
        "Only the pre-existing raw count is cleared"
    );
    assert!(cache.lock().await[room.room_id()].messages > 0);
    sdk.sync_once(matrix_sdk::config::SyncSettings::default())
        .await
        .unwrap();
    assert!(note_receipt_echo(&pending, &room, &["$missing".try_into().unwrap()]).await);
    assert_eq!(
        raw.lock().await[room.room_id()],
        1,
        "An acknowledgement echo must not erase later arrivals"
    );
    assert!(RoomUnreadState::from_room_with_raw(&room, 1).messages > 0);
    let ack = fetch_ack(&http, &sdk, &room).await.unwrap();
    assert!(!ack.event_ids.contains(&"$new".to_owned()));
}

#[test]
fn acknowledgement_storage_is_bounded_and_keeps_the_most_recent_ids() {
    let previous = (0..250).map(|i| format!("$event{i}")).collect::<Vec<_>>();
    let merged = merge_ids(&previous, &["$event249".into(), "$new".into()]);
    assert_eq!(merged.len(), MAX_ACKNOWLEDGED_EVENTS);
    assert_eq!(merged.last().map(String::as_str), Some("$new"));
    assert_eq!(
        merged
            .iter()
            .filter(|id| id.as_str() == "$event249")
            .count(),
        1
    );
}

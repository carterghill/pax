use std::{collections::HashMap, sync::Arc};

use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    ruma::{push::Action, OwnedRoomId, OwnedUserId},
    sync::SyncResponse,
    Client, Room,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::{
    commands::{
        ignored_users::IgnoredUserIds, pax_settings::NotificationLevel,
        reconciler::NotificationSession, rss::activity::Filter as RssFilter,
    },
    AppState,
};

struct Message {
    sender: OwnedUserId,
    body: String,
    earns_badge: bool,
}

// Use the same Matrix actions as the unread projection. This includes custom push
// rules and keyword highlights which do not appear in the event's m.mentions.
fn earns_badge(actions: &[Action]) -> bool {
    actions
        .iter()
        .any(|action| action.should_notify() || action.is_highlight())
}

fn message(
    event: &TimelineEvent,
    me: &matrix_sdk::ruma::UserId,
    ignored: &IgnoredUserIds,
) -> Option<Message> {
    let raw = event.raw();
    let kind = raw.get_field::<String>("type").ok()??;
    if !matches!(
        kind.as_str(),
        "m.room.message"
            | "m.room.encrypted"
            | "m.sticker"
            | "m.poll.start"
            | "m.poll.end"
            | "org.matrix.msc3381.poll.start"
            | "org.matrix.msc3381.poll.end"
    ) {
        return None;
    }
    let sender = raw.get_field::<OwnedUserId>("sender").ok()??;
    if sender == me || ignored.contains(&sender) {
        return None;
    }
    let content = raw.get_field::<serde_json::Value>("content").ok()??;
    if matches!(
        content["m.relates_to"]["rel_type"].as_str(),
        Some("m.replace" | "m.annotation")
    ) || raw
        .get_field::<serde_json::Value>("unsigned")
        .ok()
        .flatten()
        .is_some_and(|u| u.get("redacted_because").is_some())
    {
        return None;
    }
    let body = match kind.as_str() {
        "m.room.encrypted" => "New message",
        _ => content["body"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or("New message"),
    };
    Some(Message {
        sender,
        body: truncate(body, 200),
        earns_badge: earns_badge(event.push_actions().unwrap_or_default()),
    })
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().nth(limit).is_none() {
        return text.to_owned();
    }
    text.chars().take(limit - 1).chain(['…']).collect()
}

pub(in crate::commands) fn dispatch(
    app: &Arc<AppHandle>,
    session: &Arc<NotificationSession>,
    client: &Client,
    response: &SyncResponse,
    badge_increases: &HashMap<OwnedRoomId, u64>,
) {
    for (id, update) in &response.rooms.joined {
        if update.timeline.events.is_empty() {
            continue;
        }
        let Some(room) = client.get_room(id) else {
            continue;
        };
        let events = update.timeline.events.clone();
        let increase = badge_increases.get(id).copied().unwrap_or_default();
        let app = app.clone();
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = session
                .run(show_room(&app, &session, room, events, increase))
                .await
            {
                log::warn!("Desktop message notification skipped: {error}");
            }
        });
    }
}

async fn show_room(
    app: &AppHandle,
    session: &NotificationSession,
    room: Room,
    events: Vec<TimelineEvent>,
    increase: u64,
) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    let ignored = state.ignored_users.users(&room.client()).await;
    let mut candidates = Vec::new();
    let mut other_badges = 0;
    let mut feed = RssFilter::for_room(&room).await;
    if let Some(feed) = &mut feed {
        feed.remember_commands(&events);
    }
    for event in &events {
        if let Some(candidate) = message(event, room.own_user_id(), &ignored) {
            if let Some(feed) = &mut feed {
                if feed.hides_event(&room, event).await {
                    continue;
                }
            }
            candidates.push(candidate);
        } else if earns_badge(event.push_actions().unwrap_or_default()) {
            other_badges += 1;
        }
    }
    if candidates.is_empty() {
        return Ok(());
    }
    let is_dm = room.is_direct().await.unwrap_or(false);
    let level = session.banner_level(&room, is_dm).await?;
    let one_to_one = is_dm && room.active_members_count() <= 2 && room.direct_targets_length() <= 1;
    let room_name = room
        .cached_display_name()
        .map(|name| name.to_string())
        .or_else(|| room.name());
    let (messages, generic) = select_banners(
        &candidates,
        level,
        is_dm,
        increase.saturating_sub(other_badges),
    );
    for message in messages {
        show_message(app, &room, message, one_to_one, room_name.as_deref()).await?;
    }
    for _ in 0..generic {
        post(
            app,
            &room,
            room_name.as_deref().unwrap_or("Pax"),
            "New message",
        )?;
    }
    Ok(())
}

fn select_banners(
    messages: &[Message],
    level: NotificationLevel,
    is_dm: bool,
    badge_increase: u64,
) -> (Vec<&Message>, u64) {
    if level == NotificationLevel::None {
        return (Vec::new(), 0);
    }
    if is_dm || level == NotificationLevel::All {
        return (messages.iter().collect(), 0);
    }
    let matched: Vec<_> = messages.iter().filter(|m| m.earns_badge).collect();
    let missing = badge_increase.saturating_sub(matched.len() as u64);
    if missing >= (messages.len() - matched.len()) as u64 {
        return (messages.iter().collect(), 0);
    }
    // Server-only counts can identify a room without identifying which messages
    // matched. Keep the banner generic when attributing a sender would be a guess.
    (matched, missing)
}

async fn show_message(
    app: &AppHandle,
    room: &Room,
    message: &Message,
    one_to_one: bool,
    room_name: Option<&str>,
) -> Result<(), String> {
    let member = room
        .get_member_no_sync(&message.sender)
        .await
        .ok()
        .flatten();
    let sender = member
        .as_ref()
        .and_then(|member| member.display_name())
        .unwrap_or(message.sender.as_str());
    let title = match room_name {
        Some(name) if !one_to_one => format!("{sender} ({name})"),
        _ => sender.to_owned(),
    };
    post(app, room, &truncate(&title, 80), &message.body)
}

fn post(app: &AppHandle, room: &Room, title: &str, body: &str) -> Result<(), String> {
    if !super::notification_permission(app)? {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let shown_in_dev = show_unbundled_message(title, body);
    #[cfg(not(target_os = "macos"))]
    let shown_in_dev = false;
    if !shown_in_dev {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())?;
    }
    let _ = app.emit_to(
        "main",
        "desktop-message-notified",
        room.own_user_id().as_str(),
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_unbundled_message(title: &str, body: &str) -> bool {
    use std::ffi::{c_char, CString};
    extern "C" {
        fn pax_show_unbundled_message(
            title: *const c_char,
            body: *const c_char,
            icon_png: *const u8,
            icon_length: usize,
        ) -> bool;
    }
    let title = CString::new(title.replace('\0', " ")).expect("NULs replaced");
    let body = CString::new(body.replace('\0', " ")).expect("NULs replaced");
    const ICON: &[u8] = include_bytes!("../../../icons/128x128.png");
    // AppKit copies the strings immediately. The embedded icon lives for the process lifetime.
    unsafe { pax_show_unbundled_message(title.as_ptr(), body.as_ptr(), ICON.as_ptr(), ICON.len()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::{push::Tweak, serde::Raw, UserId};
    use serde_json::json;

    fn candidate(body: &str, actions: Vec<Action>) -> Message {
        let event = json!({
            "type": "m.room.message", "sender": "@peer:example.org", "event_id": "$message",
            "origin_server_ts": 1, "content": { "msgtype": "m.text", "body": body }
        });
        let mut event =
            TimelineEvent::from_plaintext(Raw::from_json_string(event.to_string()).unwrap());
        event.set_push_actions(actions);
        let me = UserId::parse("@me:example.org").unwrap();
        assert!(message(
            &event,
            &UserId::parse("@peer:example.org").unwrap(),
            &IgnoredUserIds::new()
        )
        .is_none());
        let ignored = [UserId::parse("@peer:example.org").unwrap()]
            .into_iter()
            .collect();
        assert!(message(&event, &me, &ignored).is_none());
        message(&event, &me, &IgnoredUserIds::new()).unwrap()
    }

    #[test]
    fn push_notifications_and_keyword_highlights_show_once_per_message() {
        let batch = [
            candidate("ordinary", vec![]),
            candidate("keyword", vec![Action::SetTweak(Tweak::Highlight(true))]),
            candidate("notification", vec![Action::Notify]),
        ];
        let (banners, generic) = select_banners(&batch, NotificationLevel::AllMentions, false, 2);
        assert_eq!(generic, 0);
        assert_eq!(
            banners.iter().map(|b| b.body.as_str()).collect::<Vec<_>>(),
            ["keyword", "notification"]
        );
        assert_eq!(
            select_banners(&batch, NotificationLevel::RoomPings, true, 0)
                .0
                .len(),
            3
        );
        assert!(select_banners(&batch, NotificationLevel::None, true, 3)
            .0
            .is_empty());
    }

    #[test]
    fn server_only_badge_increases_do_not_double_count_or_guess_the_sender() {
        let batch = [
            candidate("one", vec![]),
            candidate("two", vec![]),
            candidate("three", vec![Action::Notify]),
        ];
        for (increase, known, generic) in [(0, 1, 0), (1, 1, 0), (2, 1, 1), (3, 3, 0), (99, 3, 0)] {
            let result = select_banners(&batch, NotificationLevel::UserMentions, false, increase);
            assert_eq!((result.0.len(), result.1), (known, generic));
        }
    }

    #[test]
    fn preview_limits_preserve_unicode() {
        assert_eq!(truncate("🌼🌼🌼🌼", 3), "🌼🌼…");
    }
}

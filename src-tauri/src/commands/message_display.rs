use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::events::relation::{BundledThread, Thread};
use matrix_sdk::ruma::events::room::member::{MembershipChange, OriginalSyncRoomMemberEvent};
use matrix_sdk::ruma::events::room::message::{MessageFormat, Relation};
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::{OwnedEventId, UInt};

use crate::types::{
    MembershipNotice, MembershipNoticeAction, MessageInfo, MessageReplyTo, MessageThreadSummary,
};

pub(super) fn membership_notice(event: &OriginalSyncRoomMemberEvent) -> Option<MessageInfo> {
    use MembershipChange as Change;
    use MembershipNoticeAction as Action;

    let action = match event.membership_change() {
        Change::Joined | Change::InvitationAccepted => Action::Joined,
        Change::Left => Action::Left,
        Change::Invited => Action::Invited,
        Change::InvitationRejected => Action::InviteDeclined,
        Change::InvitationRevoked => Action::InviteRevoked,
        Change::Kicked => Action::Kicked,
        Change::Banned | Change::KickedAndBanned => Action::Banned,
        Change::Unbanned => Action::Unbanned,
        Change::Knocked => Action::Knocked,
        Change::KnockAccepted => Action::KnockAccepted,
        Change::KnockRetracted => Action::KnockRetracted,
        Change::KnockDenied => Action::KnockDenied,
        _ => return None,
    };

    let target_name = event
        .content
        .displayname
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| event.prev_content()?.displayname.as_deref())
        .map(str::to_owned);

    Some(MessageInfo {
        membership_notice: Some(MembershipNotice {
            action,
            target_user_id: event.state_key.to_string(),
            target_name,
            reason: event.content.reason.clone(),
        }),
        event_id: event.event_id.to_string(),
        sender: event.sender.to_string(),
        timestamp: event.origin_server_ts.0.into(),
        ..Default::default()
    })
}

fn strip_rich_reply_plain_text(s: &str) -> String {
    if !s.contains('\n') {
        return s.to_string();
    }
    let mut s = s;
    while s.starts_with("> ") {
        s = s.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
    }
    s.trim_start_matches('\n').to_string()
}

/// `m.in_reply_to` or a thread with `m.in_reply_to` (Matrix SDK `ForwardThread` / thread replies).
pub(super) fn reply_to_from_message_relation(
    rel: &Option<Relation<RoomMessageEventContentWithoutRelation>>,
) -> Option<MessageReplyTo> {
    let event_id: String = match rel {
        Some(Relation::Reply { in_reply_to }) => in_reply_to.event_id.to_string(),
        Some(Relation::Thread(t)) => t.in_reply_to.as_ref().map(|i| i.event_id.to_string())?,
        _ => return None,
    };
    Some(MessageReplyTo { event_id })
}

pub(super) fn thread_root_from_message_relation(
    rel: &Option<Relation<RoomMessageEventContentWithoutRelation>>,
) -> Option<String> {
    match rel {
        Some(Relation::Thread(thread)) => Some(thread.event_id.to_string()),
        _ => None,
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageThreadTarget {
    pub root_event_id: OwnedEventId,
    pub latest_event_id: Option<OwnedEventId>,
}

impl MessageThreadTarget {
    pub(super) fn apply(self, mut content: RoomMessageEventContent) -> RoomMessageEventContent {
        let latest = self.latest_event_id.unwrap_or_else(|| self.root_event_id.clone());
        content.relates_to = Some(Relation::Thread(Thread::plain(self.root_event_id, latest)));
        content
    }
}

pub(super) fn thread_summary_from_bundle(bundle: &BundledThread) -> MessageThreadSummary {
    MessageThreadSummary {
        count: bundle.count.into(),
        ignore_list_revision: None,
        latest_event_id: bundle.latest_event.get_field("event_id").ok().flatten(),
        latest_timestamp: bundle
            .latest_event
            .get_field("origin_server_ts")
            .ok()
            .flatten(),
    }
}

/// Whether the event is a *reply* that may embed a `> ` plain-text quote block.
fn is_reply_plain_strip_context(
    rel: &Option<Relation<RoomMessageEventContentWithoutRelation>>,
) -> bool {
    match rel {
        Some(Relation::Reply { .. }) => true,
        Some(Relation::Thread(t)) => t.in_reply_to.is_some() && !t.is_falling_back,
        _ => false,
    }
}

/// Body text for the timeline plus optional image / video / file download descriptors (`m.room.message`).
#[derive(Clone, Default)]
pub(super) struct MessageDisplayExtract {
    pub(super) body: String,
    pub(super) formatted_body: Option<String>,
    pub(super) mentioned_user_ids: Option<Vec<String>>,
    pub(super) mentions_room: bool,
    pub(super) image_media_request: Option<serde_json::Value>,
    pub(super) video_media_request: Option<serde_json::Value>,
    pub(super) file_media_request: Option<serde_json::Value>,
    pub(super) file_mime: Option<String>,
    pub(super) file_display_name: Option<String>,
    pub(super) image_width: Option<u32>,
    pub(super) image_height: Option<u32>,
    pub(super) image_blurhash: Option<String>,
    pub(super) video_width: Option<u32>,
    pub(super) video_height: Option<u32>,
    pub(super) unsupported_matrix_msgtype: Option<String>,
}

/// Matrix `info.w` / `info.h` when present and non-zero (for inline layout / loading placeholder).
fn matrix_media_width_height(
    width: Option<UInt>,
    height: Option<UInt>,
) -> (Option<u32>, Option<u32>) {
    match (width, height) {
        (Some(w), Some(h)) => {
            let w64 = u64::from(w);
            let h64 = u64::from(h);
            if w64 == 0 || h64 == 0 || w64 > u32::MAX as u64 || h64 > u32::MAX as u64 {
                (None, None)
            } else {
                (Some(w64 as u32), Some(h64 as u32))
            }
        }
        _ => (None, None),
    }
}

/// `m.image` / `m.file` image: prefer full `info.w`/`h`, else thumbnail (many clients only publish one).
fn image_event_display_dimensions(
    img: &matrix_sdk::ruma::events::room::message::ImageMessageEventContent,
) -> (Option<u32>, Option<u32>) {
    let Some(info) = img.info.as_deref() else {
        return (None, None);
    };
    let main = matrix_media_width_height(info.width, info.height);
    if main.0.is_some() && main.1.is_some() {
        return main;
    }
    if let Some(th) = info.thumbnail_info.as_deref() {
        let t = matrix_media_width_height(th.width, th.height);
        if t.0.is_some() && t.1.is_some() {
            return t;
        }
    }
    (None, None)
}

/// Human-readable `[]` tag for `m.room.message` kinds Pax does not render natively (Element effects, …).
fn bracket_label_for_unhandled_matrix_msgtype(msgtype: &str) -> Option<&'static str> {
    match msgtype {
        "nic.custom.confetti" => Some("Confetti"),
        "nic.custom.fireworks" => Some("Fireworks"),
        "io.element.effect.rainfall" => Some("Rainfall"),
        "io.element.effect.snowfall" => Some("Snowfall"),
        "io.element.effects.space_invaders" => Some("Space invaders"),
        "io.element.effect.hearts" => Some("Hearts"),
        "m.location" => Some("Location"),
        "m.server_notice" => Some("Server notice"),
        "m.key.verification.request" => Some("Verification"),
        _ => None,
    }
}

/// Fallback timeline text for [`MessageType`] variants Pax does not specialize: prefer Matrix `body`,
/// with a short tag for known Element chat effects and similar types.
fn body_for_unhandled_room_message(
    msgtype: &str,
    stripped_body: String,
) -> (String, Option<String>) {
    let stripped_trim = stripped_body.trim();
    if let Some(label) = bracket_label_for_unhandled_matrix_msgtype(msgtype) {
        let body = if stripped_trim.is_empty() {
            format!("[{label}]")
        } else {
            format!("[{label}] {stripped_trim}")
        };
        return (body, None);
    }
    if !stripped_trim.is_empty() {
        return (stripped_trim.to_owned(), None);
    }
    (
        "[Unsupported message]".to_string(),
        Some(msgtype.to_owned()),
    )
}

pub(super) fn extract_message_display(
    content: &matrix_sdk::ruma::events::room::message::RoomMessageEventContent,
) -> MessageDisplayExtract {
    use matrix_sdk::ruma::events::room::message::MessageType;
    let strip = is_reply_plain_strip_context(&content.relates_to);
    let apply_reply_strip = |s: &str| -> String {
        if strip {
            strip_rich_reply_plain_text(s)
        } else {
            s.to_string()
        }
    };
    let mut out = match &content.msgtype {
        MessageType::Image(img) => {
            let body = apply_reply_strip(&img.caption().map(|s| s.to_string()).unwrap_or_default());
            // Thumbnails are often a single static frame for GIFs (and sometimes transcoded to PNG/JPEG).
            // Request the original file for GIFs so the WebView can animate them.
            // Non-GIF: modest thumbnail size — large thumbs stress remote-media federation and some
            // homeservers return 500s under that load.
            let format = if matrix_image_is_gif(img) {
                MediaFormat::File
            } else {
                MediaFormat::Thumbnail(MediaThumbnailSettings::new(
                    UInt::from(800u32),
                    UInt::from(800u32),
                ))
            };
            let req = MediaRequestParameters {
                source: img.source.clone(),
                format,
            };
            let json = serde_json::to_value(&req).ok();
            let (image_width, image_height) = image_event_display_dimensions(img);
            let image_blurhash = img
                .info
                .as_deref()
                .and_then(|info| info.blurhash.clone());
            MessageDisplayExtract {
                body,
                image_media_request: json,
                image_width,
                image_height,
                image_blurhash,
                ..Default::default()
            }
        }
        MessageType::Video(vid) => {
            let body = apply_reply_strip(&vid.caption().map(|s| s.to_string()).unwrap_or_default());
            let req = MediaRequestParameters {
                source: vid.source.clone(),
                format: MediaFormat::File,
            };
            let json = serde_json::to_value(&req).ok();
            let (video_width, video_height) = vid
                .info
                .as_deref()
                .map(|info| matrix_media_width_height(info.width, info.height))
                .unwrap_or((None, None));
            MessageDisplayExtract {
                body,
                video_media_request: json,
                video_width,
                video_height,
                ..Default::default()
            }
        }
        MessageType::Text(text) => MessageDisplayExtract {
            body: apply_reply_strip(&text.body),
            ..Default::default()
        },
        MessageType::Notice(notice) => MessageDisplayExtract {
            body: apply_reply_strip(&notice.body),
            ..Default::default()
        },
        MessageType::Emote(emote) => MessageDisplayExtract {
            body: format!("* {}", apply_reply_strip(&emote.body)),
            ..Default::default()
        },
        MessageType::File(f) => {
            let display_name = f
                .filename
                .as_ref()
                .map(|s| s.to_string())
                .unwrap_or_else(|| f.body.clone());
            // When `filename` is set, `body` is the caption; otherwise `body` is the filename only.
            let body = if f.filename.is_some() {
                apply_reply_strip(&f.body)
            } else {
                String::new()
            };
            let mime = f
                .info
                .as_ref()
                .and_then(|i| i.mimetype.as_ref())
                .map(|m| m.to_string());
            let req = MediaRequestParameters {
                source: f.source.clone(),
                format: MediaFormat::File,
            };
            let json = serde_json::to_value(&req).ok();
            MessageDisplayExtract {
                body,
                file_media_request: json,
                file_mime: mime,
                file_display_name: Some(display_name),
                ..Default::default()
            }
        }
        MessageType::Audio(_) => MessageDisplayExtract {
            body: "[Audio]".to_string(),
            ..Default::default()
        },
        _ => {
            let stripped = apply_reply_strip(content.body());
            let (body, unsupported_matrix_msgtype) =
                body_for_unhandled_room_message(content.msgtype(), stripped);
            MessageDisplayExtract {
                body,
                unsupported_matrix_msgtype,
                ..Default::default()
            }
        }
    };
    let formatted = match &content.msgtype {
        MessageType::Text(text) => text.formatted.as_ref(),
        MessageType::Notice(notice) => notice.formatted.as_ref(),
        MessageType::Emote(emote) => emote.formatted.as_ref(),
        MessageType::Image(image) => image.formatted_caption(),
        MessageType::Video(video) => video.formatted_caption(),
        MessageType::File(file) => file.formatted_caption(),
        _ => None,
    };
    out.formatted_body = formatted
        .filter(|formatted| formatted.format == MessageFormat::Html)
        .map(|formatted| match &content.msgtype {
            MessageType::Emote(_) => format!("* {}", formatted.body),
            _ => formatted.body.clone(),
        });
    if let Some(mentions) = &content.mentions {
        out.mentioned_user_ids = Some(mentions.user_ids.iter().map(ToString::to_string).collect());
        out.mentions_room = mentions.room;
    }
    out
}

fn matrix_image_is_gif(
    img: &matrix_sdk::ruma::events::room::message::ImageMessageEventContent,
) -> bool {
    if let Some(info) = img.info.as_ref() {
        if let Some(mime) = info.mimetype.as_ref() {
            // `mimetype` is a typed value in Ruma; compare via string without ambiguous `AsRef`.
            if mime.to_string().eq_ignore_ascii_case("image/gif") {
                return true;
            }
        }
    }
    img.filename().to_ascii_lowercase().ends_with(".gif")
}

pub(super) fn mime_to_file_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

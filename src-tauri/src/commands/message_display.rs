use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::UInt;

use crate::types::MessageReplyTo;

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

/// Whether the event is a *reply* that may embed a `> ` plain-text quote block.
fn is_reply_plain_strip_context(
    rel: &Option<Relation<RoomMessageEventContentWithoutRelation>>,
) -> bool {
    match rel {
        Some(Relation::Reply { .. }) => true,
        Some(Relation::Thread(t)) => t.in_reply_to.is_some(),
        _ => false,
    }
}

/// Body text for the timeline plus optional image / video / file download descriptors (`m.room.message`).
#[derive(Clone)]
pub(super) struct MessageDisplayExtract {
    pub(super) body: String,
    pub(super) image_media_request: Option<serde_json::Value>,
    pub(super) video_media_request: Option<serde_json::Value>,
    pub(super) file_media_request: Option<serde_json::Value>,
    pub(super) file_mime: Option<String>,
    pub(super) file_display_name: Option<String>,
    pub(super) image_width: Option<u32>,
    pub(super) image_height: Option<u32>,
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

/// Extract the list of mentioned user MXIDs from a message's `m.mentions.user_ids`.
///
/// Uses the same `serde_json::to_value` round-trip as the notification payload's
/// `mentions_me` / `room_ping` extraction.  Returns an empty vec when the event
/// has no structured mentions (old client, plain text, etc.).
pub(super) fn extract_mentioned_user_ids(
    content: &matrix_sdk::ruma::events::room::message::RoomMessageEventContent,
) -> Vec<String> {
    let Ok(val) = serde_json::to_value(content) else {
        return Vec::new();
    };
    let Some(user_ids) = val
        .get("m.mentions")
        .and_then(|m| m.get("user_ids"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };
    user_ids
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_owned()))
        .collect()
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
    let out = match &content.msgtype {
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
            MessageDisplayExtract {
                body,
                image_media_request: json,
                video_media_request: None,
                file_media_request: None,
                file_mime: None,
                file_display_name: None,
                image_width,
                image_height,
                video_width: None,
                video_height: None,
                unsupported_matrix_msgtype: None,
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
                image_media_request: None,
                video_media_request: json,
                file_media_request: None,
                file_mime: None,
                file_display_name: None,
                image_width: None,
                image_height: None,
                video_width,
                video_height,
                unsupported_matrix_msgtype: None,
            }
        }
        MessageType::Text(text) => MessageDisplayExtract {
            body: apply_reply_strip(&text.body),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
            image_width: None,
            image_height: None,
            video_width: None,
            video_height: None,
            unsupported_matrix_msgtype: None,
        },
        MessageType::Notice(notice) => MessageDisplayExtract {
            body: apply_reply_strip(&notice.body),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
            image_width: None,
            image_height: None,
            video_width: None,
            video_height: None,
            unsupported_matrix_msgtype: None,
        },
        MessageType::Emote(emote) => MessageDisplayExtract {
            body: format!("* {}", apply_reply_strip(&emote.body)),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
            image_width: None,
            image_height: None,
            video_width: None,
            video_height: None,
            unsupported_matrix_msgtype: None,
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
                image_media_request: None,
                video_media_request: None,
                file_media_request: json,
                file_mime: mime,
                file_display_name: Some(display_name),
                image_width: None,
                image_height: None,
                video_width: None,
                video_height: None,
                unsupported_matrix_msgtype: None,
            }
        }
        MessageType::Audio(_) => MessageDisplayExtract {
            body: "[Audio]".to_string(),
            image_media_request: None,
            video_media_request: None,
            file_media_request: None,
            file_mime: None,
            file_display_name: None,
            image_width: None,
            image_height: None,
            video_width: None,
            video_height: None,
            unsupported_matrix_msgtype: None,
        },
        _ => {
            let stripped = apply_reply_strip(content.body());
            let (body, unsupported_matrix_msgtype) =
                body_for_unhandled_room_message(content.msgtype(), stripped);
            MessageDisplayExtract {
                body,
                image_media_request: None,
                video_media_request: None,
                file_media_request: None,
                file_mime: None,
                file_display_name: None,
                image_width: None,
                image_height: None,
                video_width: None,
                video_height: None,
                unsupported_matrix_msgtype,
            }
        }
    };
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

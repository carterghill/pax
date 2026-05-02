use serde::Serialize;
use std::collections::HashMap;

/// Per-parent `m.space.child` ordering metadata for a room or sub-space.
///
/// Carried on each child `RoomInfo` keyed by parent space id so the client can
/// sort children of a given space using the MSC1772 / MSC2946 algorithm
/// (`order` lex → `origin_server_ts` → room id).  `order` is `None` when the
/// `m.space.child` event has no `order` field; `origin_server_ts` falls back
/// to `0` for stripped state events (where it isn't present).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceChildOrder {
    pub order: Option<String>,
    pub origin_server_ts: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub is_space: bool,
    pub parent_space_ids: Vec<String>,
    /// For every parent space this room/sub-space is a child of: the
    /// `m.space.child` event's `order` string (when present) and its
    /// `origin_server_ts` — used client-side to sort children of a given
    /// space per the MSC1772 / MSC2946 rules.  Keys are parent space ids
    /// and will be a subset of `parent_space_ids`.
    #[serde(default)]
    pub space_child_orders: HashMap<String, SpaceChildOrder>,
    pub room_type: Option<String>,
    /// `m.room.topic` when known (spaces and rooms).
    pub topic: Option<String>,
    /// "joined" or "invited"
    pub membership: String,
    /// True when this is a 1:1 DM (name/avatar are the peer).
    pub is_direct: bool,
    /// Other participant in a 1:1 DM (for presence / display).
    pub dm_peer_user_id: Option<String>,
    /// Last known presence for `dm_peer_user_id` from sync (`online`, `offline`, …).
    pub dm_peer_presence: Option<String>,
    /// Matrix `status_msg` for the DM peer (may contain `[dnd]` prefix).
    pub dm_peer_status_msg: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactionSummary {
    pub key: String,
    pub count: u32,
    pub reacted_by_me: bool,
    /// Matrix user IDs who added this reaction key (lexicographically sorted).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reacted_by: Vec<String>,
}

/// `m.in_reply_to` for an [`m.room.message`]; the UI resolves the parent row by `event_id` when present in the window.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReplyTo {
    pub event_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInfo {
    pub event_id: String,
    pub sender: String,
    pub sender_name: Option<String>,
    pub body: String,
    pub timestamp: u64,
    pub avatar_url: Option<String>,
    pub edited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageReplyTo>,
    /// When set, the message is an image; the frontend fetches a temp path via `get_matrix_image_path`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_media_request: Option<serde_json::Value>,
    /// Matrix `m.image` `info.w` / `info.h` when known (inline layout / loading placeholder).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<u32>,
    /// When set, the message is a video; same download path as images (`get_matrix_image_path`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_media_request: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_height: Option<u32>,
    /// Matrix `m.file`: serialized `MediaRequestParameters` for `get_matrix_image_path`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_media_request: Option<serde_json::Value>,
    /// MIME from event `info` (for attachment icon / viewer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_mime: Option<String>,
    /// Filename for the attachment chip (Matrix `filename` or `body` when uncaptioned).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_display_name: Option<String>,
    /// Matrix `msgtype` when [`Self::body`] is the unsupported placeholder (e.g. `m.location`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_matrix_msgtype: Option<String>,
    /// Aggregated `m.reaction` annotations for this event (Matrix annotation key → senders).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<MessageReactionSummary>>,
    /// MXIDs from `m.mentions.user_ids` on this event.  Used by the frontend
    /// to render mention pills: only MXIDs that appear in this list AND in the
    /// body text are pill-ified, avoiding false positives from body-substring
    /// matching alone.  Empty vec when the event has no structured mentions.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mentioned_user_ids: Vec<String>,
}

/// Live sync: add or remove one reaction annotation on `target_event_id`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactionDeltaPayload {
    pub room_id: String,
    pub target_event_id: String,
    pub key: String,
    pub sender: String,
    pub added: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBatch {
    pub messages: Vec<MessageInfo>,
    pub prev_batch: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMemberInfo {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub presence: String, // "online", "offline", "unavailable"
    pub status_msg: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomManagementMemberInfo {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub presence: String,
    pub status_msg: Option<String>,
    pub role: String,
    /// Whether the current user may kick this member (joined members only).
    pub can_kick: bool,
    /// Whether the current user may ban this member (joined members only).
    pub can_ban: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomManagementMembersResponse {
    pub joined: Vec<RoomManagementMemberInfo>,
    pub banned: Vec<RoomManagementMemberInfo>,
}

/// Global profile (`GET /profile/{userId}`) for DM UI when no room member state exists yet.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixUserProfile {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Extended member details for the profile dialog (room-scoped).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMemberProfile {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub presence: String,
    pub status_msg: Option<String>,
    /// `creator` | `administrator` | `moderator` | `user`
    pub role: String,
    /// Raw power level when not a room creator (`None` when infinite / creator).
    pub power_level: Option<i64>,
    pub joined_at_ms: Option<u64>,
    pub name_ambiguous: bool,
    pub homeserver: String,
    pub is_ignored: bool,
    pub can_invite: bool,
    pub can_kick: bool,
    pub can_ban: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePayload {
    pub user_id: String,
    pub presence: String,
    pub status_msg: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessagePayload {
    pub room_id: String,
    pub message: MessageInfo,
    /// True when this event's `m.mentions.user_ids` includes the current user's
    /// MXID.  Derived from the structured `m.mentions` content — the same data
    /// the server uses for push-rule highlight evaluation.  The desktop
    /// notification hook uses this instead of body-substring matching so that
    /// notifications stay aligned with the red-badge mention count.
    pub mentions_me: bool,
    /// True when `m.mentions.room` is set (the sender pinged `@room`).
    pub room_ping: bool,
    /// True when the room is a 1:1 DM (matrix-sdk `is_direct()`).  The
    /// notification hook mirrors the badge's DM-promotion rule: in a non-muted
    /// DM, every message is treated as notification-worthy for levels that care
    /// about mentions, matching `effectiveMentionCount` behaviour.
    pub is_dm: bool,
}

/// Live edit: merge into the existing timeline row with `target_event_id` (do not append).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEditPayload {
    pub room_id: String,
    pub target_event_id: String,
    pub body: String,
    /// `null` when the edited event is no longer an image; otherwise the same shape as `MessageInfo.image_media_request`.
    pub image_media_request: serde_json::Value,
    /// `null` when the edited event is no longer a video; otherwise the same shape as `MessageInfo.video_media_request`.
    pub video_media_request: serde_json::Value,
    /// `null` when the edited event is no longer a file attachment.
    pub file_media_request: serde_json::Value,
    pub file_mime: serde_json::Value,
    pub file_display_name: serde_json::Value,
    pub image_width: serde_json::Value,
    pub image_height: serde_json::Value,
    pub video_width: serde_json::Value,
    pub video_height: serde_json::Value,
    /// `null` when the edited event is not an unsupported `msgtype` row.
    pub unsupported_matrix_msgtype: serde_json::Value,
}

/// Remove a timeline row when an event is redacted (e.g. message deleted).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRedactedPayload {
    pub room_id: String,
    pub redacted_event_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingPayload {
    pub room_id: String,
    pub user_ids: Vec<String>,
    pub display_names: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipant {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceJoinResult {
    pub jwt: String,
    pub livekit_url: String,
}

/// LiveKit participant row from Room Service API (mute/deafen/speaking) for UI when not in the SFU.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivekitVoiceParticipantInfo {
    pub identity: String,
    pub is_muted: bool,
    pub is_deafened: bool,
    pub is_speaking: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipantsChangedPayload {
    pub participants_by_room: HashMap<String, Vec<VoiceParticipant>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRedactionPolicy {
    pub can_redact_own: bool,
    pub can_redact_other: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSendPermission {
    pub can_send: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPinPermission {
    pub can_pin: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMessagePreview {
    pub event_id: String,
    pub sender: String,
    pub preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceChildInfo {
    pub id: String,
    pub name: String,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    /// "joined", "invited", or "none"
    pub membership: String,
    pub join_rule: Option<String>,
    pub room_type: Option<String>,
    pub num_joined_members: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_direct: bool,
    pub dm_peer_user_id: Option<String>,
    pub dm_peer_presence: Option<String>,
    pub dm_peer_status_msg: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInfo {
    pub name: String,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub children: Vec<SpaceChildInfo>,
}

/// A parent space discovered via `m.space.parent` state events on a room.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentSpaceInfo {
    pub id: String,
    pub name: String,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    /// "joined", "invited", or "none"
    pub membership: String,
    pub join_rule: Option<String>,
    pub num_joined_members: u64,
    /// Whether this parent was marked as the canonical parent in the `m.space.parent` event.
    pub canonical: bool,
}
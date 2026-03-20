use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub is_space: bool,
    pub parent_space_ids: Vec<String>,
    pub room_type: Option<String>,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePayload {
    pub user_id: String,
    pub presence: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessagePayload {
    pub room_id: String,
    pub message: MessageInfo,
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

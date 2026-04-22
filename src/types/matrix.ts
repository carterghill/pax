export interface Room {
  id: string;
  name: string;
  avatarUrl: string | null;
  isSpace: boolean;
  parentSpaceIds: string[];
  roomType: string | null;
  /** `m.room.topic` when the homeserver includes it (e.g. after sync). */
  topic?: string | null;
  /** "joined" or "invited" */
  membership: string;
  /** 1:1 DM: `name` / `avatarUrl` are the peer; use for sidebar/home display. */
  isDirect?: boolean;
  dmPeerUserId?: string | null;
  dmPeerPresence?: string | null;
  dmPeerStatusMsg?: string | null;
}

export interface Message {
  eventId: string;
  sender: string;
  senderName: string | null;
  body: string;
  timestamp: number;
  avatarUrl: string | null;
  /** True when the latest content comes from an m.replace edit */
  edited?: boolean;
  /** Matrix `m.image` payload: serialized `MediaRequestParameters` for authenticated download. */
  imageMediaRequest?: unknown;
  /** Matrix `m.video` payload: serialized `MediaRequestParameters` for authenticated download. */
  videoMediaRequest?: unknown;
  /** Matrix `m.file`: serialized `MediaRequestParameters` for authenticated download. */
  fileMediaRequest?: unknown;
  fileMime?: string | null;
  /** Filename shown on the attachment chip. */
  fileDisplayName?: string | null;
  /**
   * Client-only: in-flight file send (local echo). Cleared when the timeline event is synced.
   */
  localFileUpload?: {
    phase: "encoding" | "uploading" | "sending" | "syncing" | "failed";
    /** Combined progress 0–1 for encoding + upload + send. */
    progress: number;
    errorMessage?: string;
  };
  /** `blob:` URL for image preview before `imageMediaRequest` exists. */
  localImagePreviewObjectUrl?: string | null;
  /** Client-only: correlates Matrix upload progress events with this row. */
  localPipelineUploadId?: string;
}

export interface MessageBatch {
  messages: Message[];
  prevBatch: string | null;
}

export interface RoomRedactionPolicy {
  canRedactOwn: boolean;
  canRedactOther: boolean;
}

export interface RoomSendPermission {
  canSend: boolean;
}

export interface RoomPinPermission {
  canPin: boolean;
}

export interface PinnedMessagePreview {
  eventId: string;
  sender: string;
  preview: string;
}

export interface RoomMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  presence: string; // "online" | "offline" | "unavailable"
  statusMsg: string | null;
}

export interface RoomManagementMember extends RoomMember {
  role: "creator" | "administrator" | "moderator" | "user" | "banned";
  /** Present for joined members; whether the current user may kick. */
  canKick?: boolean;
  /** Present for joined members; whether the current user may ban. */
  canBan?: boolean;
}

export interface RoomManagementMembersResponse {
  joined: RoomManagementMember[];
  banned: RoomManagementMember[];
}

/** From `get_member_moderation_permissions` — whether the current user may kick/ban this member. */
export interface MemberModerationPermissions {
  canKick: boolean;
  canBan: boolean;
}

/** From `get_room_member_profile` — room-scoped member details. */
export interface RoomMemberProfile {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  presence: string;
  statusMsg: string | null;
  role: "creator" | "administrator" | "moderator" | "user";
  powerLevel: number | null;
  joinedAtMs: number | null;
  nameAmbiguous: boolean;
  homeserver: string;
  isIgnored: boolean;
  canInvite: boolean;
  canKick: boolean;
  canBan: boolean;
}

export interface VoiceParticipant {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** From LiveKit Room Service when LIVEKIT_* admin credentials are set */
export interface LivekitVoiceParticipantInfo {
  identity: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
}

export interface VoiceJoinResult {
  jwt: string;
  livekitUrl: string;
}
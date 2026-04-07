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
}

export interface MessageBatch {
  messages: Message[];
  prevBatch: string | null;
}

export interface RoomRedactionPolicy {
  canRedactOwn: boolean;
  canRedactOther: boolean;
}

export interface RoomMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  presence: string; // "online" | "offline" | "unavailable"
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
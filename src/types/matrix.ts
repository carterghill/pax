export interface Room {
  id: string;
  name: string;
  avatarUrl: string | null;
  isSpace: boolean;
  parentSpaceIds: string[];
  roomType: string | null;
}

export interface Message {
  eventId: string;
  sender: string;
  senderName: string | null;
  body: string;
  timestamp: number;
  avatarUrl: string | null;
}

export interface MessageBatch {
  messages: Message[];
  prevBatch: string | null;
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
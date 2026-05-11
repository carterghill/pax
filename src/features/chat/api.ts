import { invoke } from "@tauri-apps/api/core";
import type {
  MessageBatch,
  PinnedMessagePreview,
  RoomPinPermission,
  RoomRedactionPolicy,
  RoomSendPermission,
} from "../../types/matrix";

export interface GetMessagesRequest {
  roomId: string;
  from?: string | null;
  limit: number;
}

export interface SendMessageRequest {
  roomId: string;
  body: string;
  replyToEventId?: string | null;
}

export interface SendFirstDirectMessageRequest {
  peerUserId: string;
  body: string;
}

export interface MessageEventRequest {
  roomId: string;
  eventId: string;
}

export interface EditMessageRequest extends MessageEventRequest {
  body: string;
}

export interface SendReactionRequest {
  roomId: string;
  targetEventId: string;
  emoji: string;
}

export interface RemoveReactionRequest {
  roomId: string;
  targetEventId: string;
  key: string;
}

export interface TypingNoticeRequest {
  roomId: string;
  typing: boolean;
}

export interface UploadRoomFileRequest {
  roomId: string;
  uploadId: string;
  fileName: string;
  mimeType: string;
}

export interface SendFileMessageRequest {
  roomId: string;
  contentUri: string;
  fileName: string;
  mimeType: string;
  fileSize?: number | null;
  caption?: string | null;
}

export interface UploadAndSendFileRequest {
  roomId: string;
  fileName: string;
  mimeType: string;
  data: string;
  caption?: string | null;
}

export type UploadRoomFileResult = [contentUri: string, byteSize: number];

function invokeArgs<T extends object>(request: T): Record<string, unknown> {
  return { ...request } as Record<string, unknown>;
}

export function getMessages(request: GetMessagesRequest): Promise<MessageBatch> {
  return invoke<MessageBatch>("get_messages", invokeArgs(request));
}

export function getMessagesAroundEvent(request: MessageEventRequest): Promise<MessageBatch> {
  return invoke<MessageBatch>("get_messages_around_event", invokeArgs(request));
}

export function sendMessage(request: SendMessageRequest): Promise<void> {
  return invoke("send_message", {
    roomId: request.roomId,
    body: request.body,
    replyToEventId: request.replyToEventId ?? null,
  });
}

export function sendFirstDirectMessage(
  request: SendFirstDirectMessageRequest,
): Promise<string> {
  return invoke<string>("send_first_direct_message", invokeArgs(request));
}

export function editMessage(request: EditMessageRequest): Promise<void> {
  return invoke("edit_message", invokeArgs(request));
}

export function redactMessage(request: MessageEventRequest): Promise<void> {
  return invoke("redact_message", invokeArgs(request));
}

export function sendRoomReaction(request: SendReactionRequest): Promise<void> {
  return invoke("send_room_reaction", invokeArgs(request));
}

export function removeRoomReaction(request: RemoveReactionRequest): Promise<void> {
  return invoke("remove_room_reaction", invokeArgs(request));
}

export function getRoomRedactionPolicy(roomId: string): Promise<RoomRedactionPolicy> {
  return invoke<RoomRedactionPolicy>("get_room_redaction_policy", { roomId });
}

export function getRoomCanSendMessages(roomId: string): Promise<RoomSendPermission> {
  return invoke<RoomSendPermission>("get_room_can_send_messages", { roomId });
}

export function getRoomCanPinMessages(roomId: string): Promise<RoomPinPermission> {
  return invoke<RoomPinPermission>("get_room_can_pin_messages", { roomId });
}

export function getRoomPinnedEventIds(roomId: string): Promise<string[]> {
  return invoke<string[]>("get_room_pinned_event_ids", { roomId });
}

export function getPinnedMessagePreviews(
  roomId: string,
): Promise<PinnedMessagePreview[]> {
  return invoke<PinnedMessagePreview[]>("get_pinned_message_previews", { roomId });
}

export function pinRoomMessage(request: MessageEventRequest): Promise<void> {
  return invoke("pin_room_message", invokeArgs(request));
}

export function unpinRoomMessage(request: MessageEventRequest): Promise<void> {
  return invoke("unpin_room_message", invokeArgs(request));
}

export function sendTypingNotice(request: TypingNoticeRequest): Promise<void> {
  return invoke("send_typing_notice", invokeArgs(request));
}

export function getMatrixImagePath(request: unknown): Promise<string> {
  return invoke<string>("get_matrix_image_path", { request });
}

export function clearMediaCache(): Promise<number> {
  return invoke<number>("clear_media_cache");
}

export function getMatrixMaxUploadBytes(): Promise<number | null> {
  return invoke<number | null>("get_matrix_max_upload_bytes");
}

export function roomFileStagingReset(uploadId: string): Promise<void> {
  return invoke("room_file_staging_reset", { uploadId });
}

export function roomFileStagingAppendBase64(
  uploadId: string,
  chunkB64: string,
): Promise<void> {
  return invoke("room_file_staging_append_b64", { uploadId, chunkB64 });
}

export function roomFileStagingByteLen(uploadId: string): Promise<number> {
  return invoke<number>("room_file_staging_byte_len", { uploadId });
}

export function roomFileStagingRemove(uploadId: string): Promise<void> {
  return invoke("room_file_staging_remove", { uploadId });
}

export function uploadRoomFile(
  request: UploadRoomFileRequest,
): Promise<UploadRoomFileResult> {
  return invoke<UploadRoomFileResult>("upload_room_file", invokeArgs(request));
}

export function sendFileMessage(request: SendFileMessageRequest): Promise<string> {
  return invoke<string>("send_file_message", {
    roomId: request.roomId,
    contentUri: request.contentUri,
    fileName: request.fileName,
    mimeType: request.mimeType,
    fileSize: request.fileSize ?? null,
    caption: request.caption ?? null,
  });
}

export function uploadAndSendFile(request: UploadAndSendFileRequest): Promise<void> {
  return invoke("upload_and_send_file", {
    roomId: request.roomId,
    fileName: request.fileName,
    mimeType: request.mimeType,
    data: request.data,
    caption: request.caption ?? null,
  });
}

export const chatApi = {
  getMessages,
  getMessagesAroundEvent,
  sendMessage,
  sendFirstDirectMessage,
  editMessage,
  redactMessage,
  sendRoomReaction,
  removeRoomReaction,
  getRoomRedactionPolicy,
  getRoomCanSendMessages,
  getRoomCanPinMessages,
  getRoomPinnedEventIds,
  getPinnedMessagePreviews,
  pinRoomMessage,
  unpinRoomMessage,
  sendTypingNotice,
  getMatrixImagePath,
  clearMediaCache,
  getMatrixMaxUploadBytes,
  roomFileStagingReset,
  roomFileStagingAppendBase64,
  roomFileStagingByteLen,
  roomFileStagingRemove,
  uploadRoomFile,
  sendFileMessage,
  uploadAndSendFile,
};

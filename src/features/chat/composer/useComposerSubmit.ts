import { useCallback, type RefObject } from "react";
import type { Message } from "../../../types/matrix";
import {
  editMessage,
  roomFileStagingRemove,
  sendFileMessage,
  sendFirstDirectMessage,
  sendMessage,
  sendRssThreadReply,
  uploadRoomFile,
  type MessageThreadTarget,
} from "../api";
import {
  stagingByteLenMatchesFile,
  streamFileToStaging,
  type AttachmentPreparation,
  type PendingAttachment,
  UPLOAD_STAGING_END,
} from "./fileUpload";
import {
  getActiveFormats,
  serializeComposerEditor,
  type ComposerMessageContent,
} from "../../../utils/composerEditorDom";
import { formatInvokeErr } from "../formatInvokeErr";

export type EditingMessageRef = Pick<Message,
  "eventId" | "body" | "formattedBody" | "mentionedUserIds" | "mentionsRoom" | "edited"
>;

export type SentThreadReply = Pick<Message, "eventId" | "body" | "formattedBody" | "mentionedUserIds">;

export type MessageFileSendBridge = {
  addOptimistic: (msg: Message) => void;
  patchMessage: (eventId: string, patch: Partial<Message>) => void;
  patchMessageByUploadId: (uploadId: string, patch: Partial<Message>) => void;
  replaceMessageEventId: (oldId: string, newId: string, patch?: Partial<Message>) => void;
  removeMessage: (eventId: string) => void;
};

type UseComposerSubmitArgs = {
  roomId: string;
  interactionLocked: boolean;
  sending: boolean;
  setSending: (sending: boolean) => void;
  editorRef: RefObject<HTMLDivElement | null>;
  pendingFile: PendingAttachment | null;
  pendingFileRef: RefObject<PendingAttachment | null>;
  preparationRef: RefObject<AttachmentPreparation | null>;
  setPendingFile: (file: PendingAttachment | null) => void;
  fileSendBridge: MessageFileSendBridge | null;
  selfUserId: string;
  resolveMemberLabel: (userId: string) => string;
  selfDisplayName: string | null;
  selfAvatarUrl: string | null;
  draftDmPeerUserId: string | null;
  onDraftDmFirstMessage?: (roomId: string) => void | Promise<void>;
  replyDraft?: Message | null;
  onCancelReply?: () => void;
  editingMessage?: EditingMessageRef | null;
  onCancelEdit?: () => void;
  thread?: MessageThreadTarget;
  onMessageSent: (reply?: SentThreadReply) => void;
  onSendError?: (error: string | null) => void;
  setPlainText: (text: string) => void;
  setHasComposerMedia: (hasMedia: boolean) => void;
  setPickerOpen: (open: boolean) => void;
  sendTyping: (active: boolean) => void;
  clearTypingTimeout: () => void;
  refreshFormats: () => void;
  syncHeight: () => void;
};

function restoreStickyInlineFormats(el: HTMLDivElement, prevFormats: Set<string>) {
  if (!prevFormats.has("bold") && !prevFormats.has("italic") && !prevFormats.has("strikethrough")) {
    return;
  }

  document.execCommand("insertText", false, "\u200b");
  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(el);
  }
  for (const fmt of prevFormats) {
    if (fmt === "bold") document.execCommand("bold");
    else if (fmt === "italic") document.execCommand("italic");
    else if (fmt === "strikethrough") document.execCommand("strikeThrough");
  }
  if (sel) {
    sel.collapseToEnd();
  }
}

function clearEditorAfterSend(
  el: HTMLDivElement,
  setPlainText: (text: string) => void,
  setHasComposerMedia: (hasMedia: boolean) => void,
): Set<string> {
  const prevFormats = getActiveFormats(el);
  el.innerHTML = "";
  setPlainText("");
  setHasComposerMedia(false);
  return prevFormats;
}

function restoreEditorAfterSend(
  el: HTMLDivElement,
  prevFormats: Set<string>,
  refreshFormats: () => void,
  syncHeight: () => void,
) {
  el.focus();
  restoreStickyInlineFormats(el, prevFormats);
  refreshFormats();
  syncHeight();
}

export function useComposerSubmit({
  roomId,
  interactionLocked,
  sending,
  setSending,
  editorRef,
  pendingFile,
  pendingFileRef,
  preparationRef,
  setPendingFile,
  fileSendBridge,
  selfUserId,
  resolveMemberLabel,
  selfDisplayName,
  selfAvatarUrl,
  draftDmPeerUserId,
  onDraftDmFirstMessage,
  replyDraft,
  onCancelReply,
  editingMessage,
  onCancelEdit,
  thread,
  onMessageSent,
  onSendError,
  setPlainText,
  setHasComposerMedia,
  setPickerOpen,
  sendTyping,
  clearTypingTimeout,
  refreshFormats,
  syncHeight,
}: UseComposerSubmitArgs) {
  const runFileSendPipeline = useCallback(
    async (
      localEventId: string,
      snapshot: PendingAttachment,
      caption: ComposerMessageContent,
      bridge: MessageFileSendBridge,
      preparation?: AttachmentPreparation,
    ) => {
      try {
        const uploaded = snapshot.contentUri ? null : await preparation?.result;
        let contentUri = snapshot.contentUri ?? uploaded?.[0];
        let byteSize = snapshot.byteSize ?? uploaded?.[1];
        let encryptedFile = snapshot.encryptedFile ?? uploaded?.[2];
        if (!contentUri) {
          if (snapshot.sourceFile && !await stagingByteLenMatchesFile(snapshot.uploadId, snapshot.sourceFile.size)) {
            await streamFileToStaging(snapshot.sourceFile, snapshot.uploadId, (f) => {
              bridge.patchMessage(localEventId, {
                localFileUpload: {
                  phase: "encoding",
                  progress: f * UPLOAD_STAGING_END,
                },
              });
            });
          }

          bridge.patchMessage(localEventId, {
            localFileUpload: { phase: "uploading", progress: UPLOAD_STAGING_END },
          });
          const res = await uploadRoomFile({
            roomId,
            uploadId: snapshot.uploadId,
            fileName: snapshot.name,
            mimeType: snapshot.mimeType,
          });
          [contentUri, byteSize, encryptedFile] = res;
        }

        const meta = await preparation?.imageMeta;
        const imageWidth = meta?.width ?? snapshot.imageWidth;
        const imageHeight = meta?.height ?? snapshot.imageHeight;
        bridge.patchMessage(localEventId, {
          localFileUpload: { phase: "sending", progress: 0.92 },
          imageWidth: imageWidth ?? undefined,
          imageHeight: imageHeight ?? undefined,
        });

        const serverEventId = await sendFileMessage({
          roomId,
          contentUri,
          encryptedFile,
          fileName: snapshot.name,
          mimeType: snapshot.mimeType,
          fileSize: byteSize ?? null,
          caption: caption.body || null,
          formattedBody: caption.formattedBody,
          mentions: caption.mentions,
          blurhash: meta?.blurhash ?? snapshot.blurhash,
          imageWidth,
          imageHeight,
          audioDurationMs: snapshot.audioDurationMs,
          thread,
        });

        bridge.replaceMessageEventId(localEventId, serverEventId, {
          localPipelineUploadId: undefined,
          localFileUpload: { phase: "syncing", progress: 1 },
        });
      } catch (e) {
        const msg = formatInvokeErr(e);
        console.error("Failed to send file message:", e);
        void roomFileStagingRemove(snapshot.uploadId).catch(() => {});
        bridge.patchMessage(localEventId, {
          localFileUpload: { phase: "failed", progress: 0, errorMessage: msg },
        });
      }
    },
    [roomId, thread],
  );

  const handleSend = useCallback(async () => {
    if (interactionLocked) return;
    const el = editorRef.current;
    if (!el) return;
    const content = serializeComposerEditor(el, resolveMemberLabel);
    if ((!content.body && !pendingFile) || sending) return;

    setPickerOpen(false);
    sendTyping(false);
    clearTypingTimeout();

    setSending(true);
    onSendError?.(null);
    try {
      if (draftDmPeerUserId) {
        if (pendingFile || !content.body || editingMessage) {
          setSending(false);
          return;
        }
        const rid = await sendFirstDirectMessage({
          peerUserId: draftDmPeerUserId,
          ...content,
        });
        const prevFormats = clearEditorAfterSend(el, setPlainText, setHasComposerMedia);
        await onDraftDmFirstMessage?.(rid);
        onMessageSent();
        restoreEditorAfterSend(el, prevFormats, refreshFormats, syncHeight);
        setSending(false);
        return;
      }

      if (pendingFile) {
        if (!fileSendBridge || !selfUserId || editingMessage) {
          setSending(false);
          return;
        }
        const snap = pendingFileRef.current;
        if (!snap) {
          setSending(false);
          return;
        }
        const localEventId = `local:${crypto.randomUUID()}`;
        const optimPhase =
          snap.phase === "ready"
            ? "sending"
            : snap.phase === "uploading"
              ? "uploading"
              : snap.phase === "error"
                ? "failed"
                : "encoding";

        fileSendBridge.addOptimistic({
          eventId: localEventId,
          sender: selfUserId,
          senderName: selfDisplayName?.trim() || selfUserId,
          body: content.body,
          formattedBody: content.formattedBody,
          mentionedUserIds: content.mentions.userIds,
          timestamp: Date.now(),
          avatarUrl: selfAvatarUrl ?? null,
          fileDisplayName: snap.name,
          fileMime: snap.mimeType,
          localPipelineUploadId: snap.uploadId,
          localFileUpload: {
            phase: optimPhase,
            progress: Math.min(1, snap.progress01),
          },
          localImagePreviewObjectUrl: snap.mimeType.startsWith("image/") ? snap.previewUrl : null,
          imageWidth: snap.imageWidth ?? undefined,
          imageHeight: snap.imageHeight ?? undefined,
          threadRootId: thread?.rootEventId,
        });

        const preparation = preparationRef.current;
        preparationRef.current = null;
        pendingFileRef.current = null;
        setPendingFile(null);
        const prevFormats = clearEditorAfterSend(el, setPlainText, setHasComposerMedia);
        restoreEditorAfterSend(el, prevFormats, refreshFormats, syncHeight);

        void runFileSendPipeline(localEventId, snap, content, fileSendBridge,
          preparation?.uploadId === snap.uploadId ? preparation : undefined).finally(() => {
          onMessageSent();
        });

        setSending(false);
        return;
      }

      let sentReply: SentThreadReply | undefined;
      if (content.body) {
        if (editingMessage) {
          await editMessage({
            roomId,
            eventId: editingMessage.eventId,
            ...content,
            previousMentions: editingMessage.edited ? {
              userIds: editingMessage.mentionedUserIds ?? [],
              room: Boolean(editingMessage.mentionsRoom),
            } : undefined,
          });
          onCancelEdit?.();
        } else if (thread) {
          const eventId = await sendRssThreadReply({ roomId, thread, ...content });
          sentReply = {
            eventId,
            body: content.body,
            formattedBody: content.formattedBody,
            mentionedUserIds: content.mentions.userIds,
          };
        } else {
          await sendMessage({
            roomId,
            ...content,
            replyToEventId: replyDraft?.eventId ?? null,
          });
          onCancelReply?.();
        }
      }

      const prevFormats = clearEditorAfterSend(el, setPlainText, setHasComposerMedia);
      onMessageSent(sentReply);
      restoreEditorAfterSend(el, prevFormats, refreshFormats, syncHeight);
    } catch (e) {
      console.error(editingMessage ? "Failed to edit:" : "Failed to send:", e);
      onSendError?.(formatInvokeErr(e));
    }
    setSending(false);
  }, [
    clearTypingTimeout,
    draftDmPeerUserId,
    editingMessage,
    editorRef,
    fileSendBridge,
    interactionLocked,
    onCancelEdit,
    onCancelReply,
    onDraftDmFirstMessage,
    onMessageSent,
    onSendError,
    pendingFile,
    pendingFileRef,
    preparationRef,
    refreshFormats,
    resolveMemberLabel,
    replyDraft?.eventId,
    roomId,
    runFileSendPipeline,
    selfAvatarUrl,
    selfDisplayName,
    selfUserId,
    sendTyping,
    sending,
    setHasComposerMedia,
    setPendingFile,
    setPickerOpen,
    setPlainText,
    setSending,
    syncHeight,
    thread,
  ]);

  return { handleSend };
}

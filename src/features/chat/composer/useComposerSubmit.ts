import { useCallback, type RefObject } from "react";
import type { Message } from "../../../types/matrix";
import {
  editMessage,
  roomFileStagingRemove,
  sendFileMessage,
  sendFirstDirectMessage,
  sendMessage,
  uploadRoomFile,
} from "../api";
import {
  stagingByteLenMatchesFile,
  streamFileToStaging,
  type PendingAttachment,
  UPLOAD_STAGING_END,
} from "./fileUpload";
import {
  getActiveFormats,
  serializeComposerEditor,
} from "../../../utils/composerEditorDom";

export interface EditingMessageRef {
  eventId: string;
  body: string;
}

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
  setPendingFile: (file: PendingAttachment | null) => void;
  fileSendBridge: MessageFileSendBridge | null;
  selfUserId: string;
  selfDisplayName: string | null;
  selfAvatarUrl: string | null;
  draftDmPeerUserId: string | null;
  onDraftDmFirstMessage?: (roomId: string) => void | Promise<void>;
  replyDraft?: Message | null;
  onCancelReply?: () => void;
  editingMessage?: EditingMessageRef | null;
  onCancelEdit?: () => void;
  onMessageSent: () => void;
  setPlainText: (text: string) => void;
  setHasComposerMedia: (hasMedia: boolean) => void;
  setPickerOpen: (open: boolean) => void;
  sendTyping: (active: boolean) => void;
  clearTypingTimeout: () => void;
  refreshFormats: () => void;
  syncHeight: () => void;
};

function formatInvokeErr(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

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
  setPendingFile,
  fileSendBridge,
  selfUserId,
  selfDisplayName,
  selfAvatarUrl,
  draftDmPeerUserId,
  onDraftDmFirstMessage,
  replyDraft,
  onCancelReply,
  editingMessage,
  onCancelEdit,
  onMessageSent,
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
      caption: string,
      bridge: MessageFileSendBridge,
    ) => {
      try {
        let contentUri = snapshot.contentUri;
        let byteSize = snapshot.byteSize;
        if (!contentUri) {
          const ok = await stagingByteLenMatchesFile(snapshot.uploadId, snapshot.sourceFile.size);
          if (!ok) {
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
          contentUri = res[0];
          byteSize = res[1];
        }

        bridge.patchMessage(localEventId, {
          localFileUpload: { phase: "sending", progress: 0.92 },
        });

        const cap = caption.trim();
        const serverEventId = await sendFileMessage({
          roomId,
          contentUri,
          fileName: snapshot.name,
          mimeType: snapshot.mimeType,
          fileSize: byteSize ?? null,
          caption: cap.length > 0 ? cap : null,
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
    [roomId],
  );

  const handleSend = useCallback(async () => {
    if (interactionLocked) return;
    const el = editorRef.current;
    if (!el) return;
    const markdown = serializeComposerEditor(el);
    const trimmed = markdown.trim();
    if ((!trimmed && !pendingFile) || sending) return;

    setPickerOpen(false);
    sendTyping(false);
    clearTypingTimeout();

    setSending(true);
    try {
      if (draftDmPeerUserId) {
        if (pendingFile || !trimmed || editingMessage) {
          setSending(false);
          return;
        }
        const rid = await sendFirstDirectMessage({
          peerUserId: draftDmPeerUserId,
          body: trimmed,
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
        const cap = trimmed;
        const body = cap.trim().length > 0 ? cap.trim() : "";

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
          body,
          timestamp: Date.now(),
          avatarUrl: selfAvatarUrl ?? null,
          fileDisplayName: snap.name,
          fileMime: snap.mimeType,
          localPipelineUploadId: snap.uploadId,
          localFileUpload: {
            phase: optimPhase,
            progress: Math.min(1, snap.progress01),
          },
          localImagePreviewObjectUrl: snap.previewUrl,
        });

        pendingFileRef.current = null;
        setPendingFile(null);
        const prevFormats = clearEditorAfterSend(el, setPlainText, setHasComposerMedia);
        restoreEditorAfterSend(el, prevFormats, refreshFormats, syncHeight);

        void runFileSendPipeline(localEventId, snap, cap, fileSendBridge).finally(() => {
          onMessageSent();
        });

        setSending(false);
        return;
      }

      if (trimmed) {
        if (editingMessage) {
          await editMessage({
            roomId,
            eventId: editingMessage.eventId,
            body: trimmed,
          });
          onCancelEdit?.();
        } else {
          await sendMessage({
            roomId,
            body: trimmed,
            replyToEventId: replyDraft?.eventId ?? null,
          });
          onCancelReply?.();
        }
      }

      const prevFormats = clearEditorAfterSend(el, setPlainText, setHasComposerMedia);
      onMessageSent();
      restoreEditorAfterSend(el, prevFormats, refreshFormats, syncHeight);
    } catch (e) {
      console.error(editingMessage ? "Failed to edit:" : "Failed to send:", e);
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
    pendingFile,
    pendingFileRef,
    refreshFormats,
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
  ]);

  return { handleSend };
}

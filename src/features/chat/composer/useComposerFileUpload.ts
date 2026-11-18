import { useState, useRef, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getMatrixMaxUploadBytes,
  roomFileStagingRemove,
  uploadRoomFile,
} from "../api";
import {
  formatBinaryBytes,
  extractImagePreviewMeta,
  streamFileToStaging,
  type AttachmentPreparation,
  type PendingAttachment,
  UPLOAD_HTTP_END,
  UPLOAD_STAGING_END,
} from "./fileUpload";
import type { MessageFileSendBridge } from "./useComposerSubmit";
import { formatInvokeErr } from "../formatInvokeErr";

type UseComposerFileUploadArgs = {
  roomId: string;
  interactionLocked: boolean;
  fileSendBridge: MessageFileSendBridge | null;
};

export function useComposerFileUpload({
  roomId,
  interactionLocked,
  fileSendBridge,
}: UseComposerFileUploadArgs) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<PendingAttachment | null>(null);
  const pendingFileRef = useRef<PendingAttachment | null>(null);
  const preparationRef = useRef<AttachmentPreparation | null>(null);
  const selectingFileRef = useRef<string | null>(null);

  useEffect(() => {
    pendingFileRef.current = pendingFile;
  }, [pendingFile]);

  const releasePendingFile = useCallback(() => {
    selectingFileRef.current = null;
    const pending = pendingFileRef.current;
    pendingFileRef.current = null;
    if (pending && preparationRef.current?.uploadId === pending.uploadId) {
      preparationRef.current.controller.abort();
      preparationRef.current = null;
    }
    if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl);
  }, []);
  useEffect(() => releasePendingFile, [releasePendingFile]);

  useEffect(() => {
    if (!roomId) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ uploadId: string; roomId: string; sent: number; total: number }>(
      "room-file-upload-progress",
      (ev) => {
        const { uploadId, roomId: rid, sent, total } = ev.payload;
        if (rid !== roomId) return;
        const denom = total > 0 ? total : 1;
        const prog = Math.min(
          UPLOAD_HTTP_END,
          UPLOAD_STAGING_END + (sent / denom) * (UPLOAD_HTTP_END - UPLOAD_STAGING_END),
        );
        setPendingFile((p) =>
          p?.uploadId === uploadId ? { ...p, phase: "uploading", progress01: prog } : p,
        );
        fileSendBridge?.patchMessageByUploadId(uploadId, {
          localFileUpload: { phase: "uploading", progress: prog },
        });
      },
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [roomId, fileSendBridge]);

  const prepareAttachment = useCallback(
    async (attachment: PendingAttachment, signal: AbortSignal) => {
      const { uploadId, sourceFile, name, mimeType } = attachment;
      try {
        await streamFileToStaging(sourceFile, uploadId, (f) => {
          const prog = f * UPLOAD_STAGING_END;
          setPendingFile((p) =>
            p?.uploadId === uploadId ? { ...p, phase: "reading", progress01: prog } : p,
          );
          fileSendBridge?.patchMessageByUploadId(uploadId, {
            localFileUpload: { phase: "encoding", progress: prog },
          });
        }, signal);
        signal.throwIfAborted();
        setPendingFile((p) => p?.uploadId === uploadId
          ? { ...p, phase: "uploading", progress01: UPLOAD_STAGING_END }
          : p);

        const uploaded = await uploadRoomFile({
          roomId,
          uploadId,
          fileName: name,
          mimeType,
        });
        if (signal.aborted) return null;
        const [contentUri, byteSize] = uploaded;
        setPendingFile((p) => p?.uploadId === uploadId
          ? { ...p, contentUri, byteSize, phase: "ready", progress01: 1 }
          : p);
        return uploaded;
      } catch (e) {
        await roomFileStagingRemove(uploadId).catch(() => {});
        if (signal.aborted) return null;
        const msg = formatInvokeErr(e);
        console.error("Attachment prepare failed:", e);
        setPendingFile((p) =>
          p?.uploadId === uploadId
            ? { ...p, phase: "error", errorMessage: msg, progress01: 0 }
            : p,
        );
        return null;
      }
    },
    [fileSendBridge, roomId],
  );

  const attachFile = useCallback(
    async (file: File) => {
      if (interactionLocked || !roomId || pendingFileRef.current || selectingFileRef.current) return;

      // Reserve the single attachment slot before the async size-limit check.
      const uploadId = crypto.randomUUID();
      selectingFileRef.current = uploadId;

      try {
        const mimeType = file.type || "application/octet-stream";

        let maxBytes: number | null = null;
        try {
          maxBytes = await getMatrixMaxUploadBytes();
        } catch {
          // e.g. not logged in — still allow picking; server will reject if needed
        }
        if (selectingFileRef.current !== uploadId) return;

        const previewUrl = mimeType.startsWith("image/") ? URL.createObjectURL(file) : null;

        if (maxBytes != null && file.size > maxBytes) {
          const next: PendingAttachment = {
            uploadId,
            name: file.name,
            mimeType,
            sourceFile: file,
            contentUri: null,
            byteSize: null,
            previewUrl,
            blurhash: null,
            imageWidth: null,
            imageHeight: null,
            phase: "error",
            progress01: 0,
            errorMessage: `This file is ${formatBinaryBytes(file.size)} but your homeserver only allows ${formatBinaryBytes(maxBytes)} per upload (Matrix media limit).`,
          };
          pendingFileRef.current = next;
          setPendingFile(next);
          return;
        }

        const next: PendingAttachment = {
          uploadId,
          name: file.name,
          mimeType,
          sourceFile: file,
          contentUri: null,
          byteSize: null,
          previewUrl,
          blurhash: null,
          imageWidth: null,
          imageHeight: null,
          phase: "reading",
          progress01: 0,
        };
        pendingFileRef.current = next;
        setPendingFile(next);
        const controller = new AbortController();
        preparationRef.current = { uploadId, controller, result: prepareAttachment(next, controller.signal) };

        if (previewUrl) {
          void extractImagePreviewMeta(previewUrl).then((meta) => {
            if (!meta) return;
            const patch: Partial<PendingAttachment> = {
              blurhash: meta.blurhash,
              imageWidth: meta.width,
              imageHeight: meta.height,
            };
            setPendingFile((p) =>
              p?.uploadId === uploadId ? { ...p, ...patch } : p,
            );
            if (pendingFileRef.current?.uploadId === uploadId) {
              pendingFileRef.current = { ...pendingFileRef.current, ...patch };
            }
          });
        }
      } catch (err) {
        console.error("Failed to read file:", err);
      } finally {
        if (selectingFileRef.current === uploadId) selectingFileRef.current = null;
      }
    },
    [interactionLocked, prepareAttachment, roomId],
  );

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) void attachFile(file);
    },
    [attachFile],
  );

  const clearPendingFile = useCallback(() => {
    releasePendingFile();
    setPendingFile(null);
  }, [releasePendingFile]);

  return {
    fileInputRef,
    pendingFile,
    pendingFileRef,
    preparationRef,
    setPendingFile,
    attachFile,
    handleFileSelected,
    clearPendingFile,
  };
}

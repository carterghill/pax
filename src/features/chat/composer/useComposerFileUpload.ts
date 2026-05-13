import { useState, useRef, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getMatrixMaxUploadBytes,
  roomFileStagingRemove,
  uploadRoomFile,
} from "../api";
import {
  formatBinaryBytes,
  streamFileToStaging,
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

  useEffect(() => {
    pendingFileRef.current = pendingFile;
  }, [pendingFile]);

  useEffect(() => {
    return () => {
      const p = pendingFileRef.current;
      if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  useEffect(() => {
    if (!roomId) return;
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
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [roomId, fileSendBridge]);

  const prepareAttachment = useCallback(
    async (uploadId: string) => {
      try {
        let cur = pendingFileRef.current;
        if (!cur || cur.uploadId !== uploadId) return;

        if (cur.contentUri) {
          const ready: PendingAttachment = { ...cur, phase: "ready", progress01: 1 };
          pendingFileRef.current = ready;
          setPendingFile(ready);
          return;
        }

        await streamFileToStaging(cur.sourceFile, uploadId, (f) => {
          if (pendingFileRef.current?.uploadId !== uploadId) return;
          const prog = f * UPLOAD_STAGING_END;
          setPendingFile((p) =>
            p?.uploadId === uploadId ? { ...p, phase: "reading", progress01: prog } : p,
          );
        });

        cur = pendingFileRef.current;
        if (!cur || cur.uploadId !== uploadId) return;

        const uploading: PendingAttachment = {
          ...cur,
          phase: "uploading",
          progress01: UPLOAD_STAGING_END,
        };
        pendingFileRef.current = uploading;
        setPendingFile(uploading);

        const [contentUri, byteSize] = await uploadRoomFile({
          roomId,
          uploadId: cur.uploadId,
          fileName: cur.name,
          mimeType: cur.mimeType,
        });

        cur = pendingFileRef.current;
        if (!cur || cur.uploadId !== uploadId) return;

        const done: PendingAttachment = {
          ...cur,
          contentUri,
          byteSize,
          phase: "ready",
          progress01: 1,
        };
        pendingFileRef.current = done;
        setPendingFile(done);
      } catch (e) {
        const msg = formatInvokeErr(e);
        console.error("Attachment prepare failed:", e);
        void roomFileStagingRemove(uploadId).catch(() => {});
        setPendingFile((p) =>
          p?.uploadId === uploadId
            ? { ...p, phase: "error", errorMessage: msg, progress01: 0 }
            : p,
        );
      }
    },
    [roomId],
  );

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (interactionLocked) return;
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      try {
        const uploadId = crypto.randomUUID();
        const mimeType = file.type || "application/octet-stream";
        const previewUrl = mimeType.startsWith("image/") ? URL.createObjectURL(file) : null;

        let maxBytes: number | null = null;
        try {
          maxBytes = await getMatrixMaxUploadBytes();
        } catch {
          // e.g. not logged in — still allow picking; server will reject if needed
        }

        if (maxBytes != null && file.size > maxBytes) {
          const next: PendingAttachment = {
            uploadId,
            name: file.name,
            mimeType,
            sourceFile: file,
            contentUri: null,
            byteSize: null,
            previewUrl,
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
          phase: "reading",
          progress01: 0,
        };
        pendingFileRef.current = next;
        setPendingFile(next);
        void prepareAttachment(uploadId);
      } catch (err) {
        console.error("Failed to read file:", err);
      }
    },
    [interactionLocked, prepareAttachment],
  );

  const clearPendingFile = useCallback(() => {
    const p = pendingFileRef.current;
    if (p?.uploadId) {
      void roomFileStagingRemove(p.uploadId).catch(() => {});
    }
    if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    pendingFileRef.current = null;
    setPendingFile(null);
  }, []);

  return {
    fileInputRef,
    pendingFile,
    pendingFileRef,
    setPendingFile,
    handleFileSelected,
    clearPendingFile,
  };
}

import { encode } from "blurhash";
import {
  roomFileStagingAppendBase64,
  roomFileStagingByteLen,
  roomFileStagingReset,
} from "../api";

export const UPLOAD_STAGING_END = 0.15;
export const UPLOAD_HTTP_END = 0.9;

export type PendingAttachment = {
  uploadId: string;
  name: string;
  mimeType: string;
  sourceFile: File;
  contentUri: string | null;
  byteSize: number | null;
  previewUrl: string | null;
  blurhash: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  phase: "reading" | "uploading" | "ready" | "error";
  progress01: number;
  errorMessage?: string;
};

/** Human-readable size (binary units) for upload limit messaging. */
export function formatBinaryBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0
    ? `${Math.round(v)} ${units[i]}`
    : `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

const BLURHASH_SAMPLE_SIZE = 64;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

export interface ImagePreviewMeta {
  blurhash: string | null;
  width: number;
  height: number;
}

export function extractImagePreviewMeta(blobUrl: string): Promise<ImagePreviewMeta | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      let blurhash: string | null = null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = BLURHASH_SAMPLE_SIZE;
        canvas.height = BLURHASH_SAMPLE_SIZE;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, BLURHASH_SAMPLE_SIZE, BLURHASH_SAMPLE_SIZE);
          const imageData = ctx.getImageData(0, 0, BLURHASH_SAMPLE_SIZE, BLURHASH_SAMPLE_SIZE);
          blurhash = encode(
            imageData.data,
            BLURHASH_SAMPLE_SIZE,
            BLURHASH_SAMPLE_SIZE,
            BLURHASH_COMPONENTS_X,
            BLURHASH_COMPONENTS_Y,
          );
        }
      } catch {
        // blurhash stays null
      }
      resolve({ blurhash, width, height });
    };
    img.onerror = () => resolve(null);
    img.src = blobUrl;
  });
}

const STAGING_CHUNK = 512 * 1024;

function uint8ToBase64Chunk(u8: Uint8Array): string {
  const CH = 8192;
  const parts: string[] = [];
  for (let i = 0; i < u8.length; i += CH) {
    parts.push(String.fromCharCode(...u8.subarray(i, i + CH)));
  }
  return btoa(parts.join(""));
}

/** Writes the file to a Rust-side staging file in small base64 IPC chunks (bounded memory). */
export async function streamFileToStaging(
  file: File,
  uploadId: string,
  onFraction: (f: number) => void,
): Promise<void> {
  const size = file.size;
  if (size === 0) {
    await roomFileStagingReset(uploadId);
    onFraction(1);
    return;
  }
  await roomFileStagingReset(uploadId);
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + STAGING_CHUNK, size);
    const buf = await file.slice(offset, end).arrayBuffer();
    const u8 = new Uint8Array(buf);
    await roomFileStagingAppendBase64(uploadId, uint8ToBase64Chunk(u8));
    offset = end;
    onFraction(offset / size);
  }
}

export async function stagingByteLenMatchesFile(
  uploadId: string,
  fileSize: number,
): Promise<boolean> {
  let len = 0;
  try {
    len = await roomFileStagingByteLen(uploadId);
  } catch {
    len = 0;
  }
  return len === fileSize;
}

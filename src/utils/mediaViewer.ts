import type { ComponentType, CSSProperties } from "react";
import { isTextPreviewableFile } from "./textPreview";
import {
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as FileIcon,
  Image as ImageIcon,
} from "lucide-react";

type FileIconComp = ComponentType<{
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  "aria-hidden"?: boolean;
}>;

export type MediaViewerKind = "image" | "pdf" | "text" | "generic";

export function inferMediaViewerKind(
  mimeType: string | null | undefined,
  fileName: string,
): MediaViewerKind {
  const lower = fileName.toLowerCase();
  if (mimeType?.includes("pdf") || lower.endsWith(".pdf")) return "pdf";
  if (
    mimeType?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(lower)
  ) {
    return "image";
  }
  if (isTextPreviewableFile(mimeType, fileName)) return "text";
  return "generic";
}

export function fileTypeIconMeta(
  mimeType: string | null | undefined,
  fileName: string,
): { Icon: FileIconComp; label: string } {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";

  if (mimeType?.startsWith("image/") || /^(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(ext)) {
    return { Icon: ImageIcon, label: "Image" };
  }
  if (mimeType?.includes("pdf") || ext === "pdf") {
    return { Icon: FileText, label: "PDF" };
  }
  if (mimeType?.includes("zip") || /^(zip|rar|7z|tar|gz)$/i.test(ext)) {
    return { Icon: FileArchive, label: "Archive" };
  }
  if (mimeType?.startsWith("audio/") || /^(mp3|wav|ogg|flac|m4a|aac)$/i.test(ext)) {
    return { Icon: FileAudio, label: "Audio" };
  }
  if (mimeType?.startsWith("video/") || /^(mp4|webm|mov|mkv|avi)$/i.test(ext)) {
    return { Icon: FileVideo, label: "Video" };
  }
  if (/^(xlsx?|csv|ods)$/i.test(ext) || mimeType?.includes("spreadsheet")) {
    return { Icon: FileSpreadsheet, label: "Spreadsheet" };
  }
  if (/^(tsx?|jsx?|json|py|rs|go|css|html?|md)$/i.test(ext) || mimeType?.includes("text/")) {
    return { Icon: FileCode, label: "Code" };
  }
  return { Icon: FileIcon, label: "File" };
}

export async function downloadFromUrl(url: string, fileName: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const a = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  a.href = objectUrl;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(objectUrl);
}

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import {
  downloadFromUrl,
  inferMediaViewerKind,
  type MediaViewerKind,
} from "../utils/mediaViewer";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

function formatInvokeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export interface MediaViewerOpenPayload {
  kind: MediaViewerKind;
  /** Matrix `MediaRequestParameters` JSON — omit when `directUrl` is set. */
  request?: unknown;
  /** Raw https URL for message links / GIFs (skips Matrix download). */
  directUrl?: string;
  fileName: string;
  mimeType: string | null;
}

interface MediaViewerModalProps {
  open: boolean;
  onClose: () => void;
  payload: MediaViewerOpenPayload | null;
}

export default function MediaViewerModal({
  open,
  onClose,
  payload,
}: MediaViewerModalProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [pdfLoading, setPdfLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);

  const effectiveKind =
    payload != null
      ? payload.kind === "generic" && inferMediaViewerKind(payload.mimeType, payload.fileName) !== "generic"
        ? inferMediaViewerKind(payload.mimeType, payload.fileName)
        : payload.kind
      : "generic";

  const resetState = useCallback(() => {
    setFileUrl(null);
    setLoadError(null);
    setLoadingPath(false);
    setZoom(1);
    setPdfPage(1);
    setPdfNumPages(0);
    setPdfLoading(false);
    pdfDocRef.current = null;
  }, []);

  useEffect(() => {
    if (!open || !payload) {
      resetState();
      return;
    }

    let cancelled = false;
    resetState();

    if (payload.directUrl) {
      setFileUrl(payload.directUrl);
      setLoadingPath(false);
      setLoadError(null);
      return () => {
        cancelled = true;
      };
    }

    setLoadingPath(true);

    let parsed: unknown;
    try {
      parsed = JSON.parse(JSON.stringify(payload.request));
    } catch {
      if (!cancelled) {
        setLoadError("Invalid media request.");
        setLoadingPath(false);
      }
      return () => {
        cancelled = true;
      };
    }

    invoke<string>("get_matrix_image_path", { request: parsed })
      .then((path) => {
        if (!cancelled) {
          setFileUrl(convertFileSrc(path));
          setLoadingPath(false);
        }
      })
      .catch((err) => {
        const msg = formatInvokeError(err);
        if (!cancelled) {
          setLoadError(msg.length > 220 ? `${msg.slice(0, 220)}…` : msg);
          setLoadingPath(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, payload, resetState]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // PDF: load document
  useEffect(() => {
    if (!open || !fileUrl || effectiveKind !== "pdf") return;

    let cancelled = false;
    setPdfLoading(true);
    setPdfPage(1);

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({ url: fileUrl, withCredentials: false });
        const pdf = await task.promise;
        if (cancelled) {
          await pdf.destroy().catch(() => {});
          return;
        }
        pdfDocRef.current = pdf;
        setPdfNumPages(pdf.numPages);
      } catch (e) {
        if (!cancelled) {
          setLoadError(formatInvokeError(e));
        }
      } finally {
        if (!cancelled) setPdfLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      const doc = pdfDocRef.current;
      pdfDocRef.current = null;
      if (doc) {
        doc.destroy().catch(() => {});
      }
    };
  }, [open, fileUrl, effectiveKind]);

  // PDF: render page
  useEffect(() => {
    if (!open || effectiveKind !== "pdf" || !fileUrl) return;
    const doc = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || pdfPage < 1 || pdfPage > pdfNumPages) return;

    let cancelled = false;
    (async () => {
      try {
        const page = await doc.getPage(pdfPage);
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx || cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const fitScale = base.width > 1200 ? 1200 / base.width : 1;
        const viewport = page.getViewport({ scale: fitScale * zoom * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch (e) {
        if (!cancelled) setLoadError(formatInvokeError(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, effectiveKind, fileUrl, pdfPage, pdfNumPages, zoom]);

  const handleDownload = useCallback(async () => {
    if (!fileUrl || !payload) return;
    try {
      await downloadFromUrl(fileUrl, payload.fileName);
    } catch (e) {
      console.error(e);
    }
  }, [fileUrl, payload]);

  if (!open || !payload) return null;

  const overlayBg =
    resolvedColorScheme === "light"
      ? "rgba(15, 15, 20, 0.72)"
      : "rgba(0, 0, 0, 0.82)";

  const toolbar = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: spacing.unit * 2,
        padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
        backgroundColor: palette.bgSecondary,
        borderBottom: `1px solid ${palette.border}`,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          minWidth: 0,
          flex: 1,
          fontSize: typography.fontSizeBase,
          fontWeight: typography.fontWeightMedium,
          color: palette.textHeading,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={payload.fileName}
      >
        {payload.fileName}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: spacing.unit }}>
        {effectiveKind === "pdf" && pdfNumPages > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 0.5 }}>
            <button
              type="button"
              aria-label="Previous page"
              disabled={pdfPage <= 1 || pdfLoading}
              onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
              style={iconBtnStyle(palette, spacing)}
            >
              <ChevronLeft size={18} />
            </button>
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                minWidth: spacing.unit * 14,
                textAlign: "center",
              }}
            >
              {pdfPage} / {pdfNumPages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={pdfPage >= pdfNumPages || pdfLoading}
              onClick={() => setPdfPage((p) => Math.min(pdfNumPages, p + 1))}
              style={iconBtnStyle(palette, spacing)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        ) : null}

        {(effectiveKind === "pdf" || effectiveKind === "image") && (
          <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 0.5 }}>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.15) * 100) / 100))}
              style={iconBtnStyle(palette, spacing)}
            >
              <Minus size={18} />
            </button>
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                minWidth: spacing.unit * 10,
                textAlign: "center",
              }}
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.15) * 100) / 100))}
              style={iconBtnStyle(palette, spacing)}
            >
              <Plus size={18} />
            </button>
          </div>
        )}

        <button
          type="button"
          aria-label="Download"
          onClick={handleDownload}
          disabled={!fileUrl}
          style={iconBtnStyle(palette, spacing)}
        >
          <Download size={18} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={iconBtnStyle(palette, spacing)}
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );

  const body = (() => {
    if (loadingPath || (effectiveKind === "pdf" && pdfLoading && pdfNumPages === 0)) {
      return (
        <div style={{ padding: spacing.unit * 6, color: palette.textSecondary }}>
          Loading…
        </div>
      );
    }
    if (loadError) {
      return (
        <div style={{ padding: spacing.unit * 4, color: palette.textSecondary, maxWidth: 480 }}>
          {loadError}
        </div>
      );
    }
    if (!fileUrl) return null;

    if (effectiveKind === "image") {
      return (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: spacing.unit * 3,
          }}
        >
          <div
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "center center",
              transition: "transform 0.08s ease-out",
            }}
          >
            <img
              src={fileUrl}
              alt=""
              style={{
                maxWidth: "min(100%, 92vw)",
                maxHeight: "85vh",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                borderRadius: spacing.unit,
                boxShadow: "0 8px 40px rgba(0,0,0,0.35)",
                display: "block",
              }}
            />
          </div>
        </div>
      );
    }

    if (effectiveKind === "pdf") {
      return (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            justifyContent: "center",
            padding: spacing.unit * 3,
            backgroundColor:
              resolvedColorScheme === "light" ? "rgba(0,0,0,0.04)" : "rgba(0,0,0,0.25)",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              display: "block",
              maxWidth: "100%",
              height: "auto",
              boxShadow: "0 4px 24px rgba(0,0,0,0.35)",
            }}
          />
        </div>
      );
    }

    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.unit * 2,
          padding: spacing.unit * 6,
          color: palette.textSecondary,
          textAlign: "center",
        }}
      >
        <p style={{ margin: 0, fontSize: typography.fontSizeBase }}>No preview for this file type.</p>
        <button
          type="button"
          onClick={handleDownload}
          style={{
            padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
            borderRadius: spacing.unit * 1.5,
            border: `1px solid ${palette.border}`,
            backgroundColor: palette.bgTertiary,
            color: palette.textPrimary,
            cursor: "pointer",
            fontSize: typography.fontSizeBase,
            fontFamily: typography.fontFamily,
          }}
        >
          Download
        </button>
      </div>
    );
  })();

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="File viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50_000,
        backgroundColor: overlayBg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.unit * 3,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 100%)",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: spacing.unit * 2,
          overflow: "hidden",
          boxShadow:
            resolvedColorScheme === "light"
              ? "0 12px 48px rgba(0,0,0,0.2)"
              : "0 16px 56px rgba(0,0,0,0.55)",
          backgroundColor: palette.bgPrimary,
        }}
      >
        {toolbar}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{body}</div>
      </div>
    </div>,
    document.body,
  );
}

function iconBtnStyle(
  palette: { border: string; bgTertiary: string; textSecondary: string },
  spacing: { unit: number },
): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    border: `1px solid ${palette.border}`,
    borderRadius: spacing.unit,
    backgroundColor: palette.bgTertiary,
    color: palette.textSecondary,
    cursor: "pointer",
  };
}

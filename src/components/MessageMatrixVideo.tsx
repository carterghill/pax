import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { formatInvokeErr } from "../features/chat/formatInvokeErr";
import { acquireMatrixMedia } from "../features/chat/media";
import { useTheme } from "../theme/ThemeContext";
import { inlineMediaAspectBoxStyle } from "../utils/inlineMediaLayout";

const INLINE_VIDEO_MAX_HEIGHT = 480;
const IS_MACOS = navigator.userAgent.includes("Macintosh");
const HAS_COMPAT_ROUTE =
  navigator.userAgent.includes("Linux") && !navigator.userAgent.includes("Android");
const MATRIX_MEDIA_URL_PREFIX = navigator.userAgent.includes("Windows")
  ? "http://paxmatrixmedia.localhost"
  : "paxmatrixmedia://localhost";

interface MessageMatrixVideoProps {
  request: unknown;
  metaWidth?: number;
  metaHeight?: number;
  mimeType?: string | null;
}

export default function MessageMatrixVideo({ request, ...props }: MessageMatrixVideoProps) {
  const requestKey = JSON.stringify(request) ?? "";
  return <MatrixVideoPlayer key={requestKey} requestKey={requestKey} {...props} />;
}

function MatrixVideoPlayer({
  requestKey,
  metaWidth,
  metaHeight,
  mimeType,
}: Omit<MessageMatrixVideoProps, "request"> & { requestKey: string }) {
  const { palette, typography, spacing } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(!IS_MACOS);
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [useCompat, setUseCompat] = useState(false);
  const [ready, setReady] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  // Timeline rows also mount outside the scroll viewport. Start macOS video
  // downloads as their rows come into view.
  useEffect(() => {
    if (visible) return;
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        setVisible(true);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!IS_MACOS || !visible || errorDetail) return;

    let request: unknown;
    try {
      request = JSON.parse(requestKey);
    } catch {
      setErrorDetail("Invalid video request data.");
      return;
    }

    // AVFoundation reads many small byte ranges, including from the end of
    // the file. Serve those reads from one cached download.
    const media = acquireMatrixMedia(request);
    let cancelled = false;
    media.path
      .then((path) => {
        if (!cancelled) setLocalSrc(convertFileSrc(path));
      })
      .catch((error) => {
        if (!cancelled) setErrorDetail(formatInvokeErr(error));
      });
    return () => {
      cancelled = true;
      media.dispose();
    };
  }, [requestKey, visible, errorDetail]);

  const ext =
    mimeType === "video/webm" ? "webm" : mimeType === "video/quicktime" ? "mov" : "mp4";
  const compatSuffix = useCompat ? "&compat=1" : "";
  const src = IS_MACOS
    ? localSrc
    : requestKey && `${MATRIX_MEDIA_URL_PREFIX}/download.${ext}?request=${encodeURIComponent(requestKey)}${compatSuffix}`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || errorDetail) return;
    video.src = src;
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, errorDetail]);

  if (errorDetail || !requestKey) {
    return (
      <div style={{ marginTop: spacing.unit, color: palette.textSecondary }}>
        <p style={{ margin: 0, fontSize: typography.fontSizeSmall }}>Could not load video.</p>
        <p
          style={{
            margin: `${spacing.unit}px 0 0`,
            fontSize: typography.fontSizeSmall * 0.92,
            opacity: 0.85,
            wordBreak: "break-word",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {errorDetail || "Invalid video request data."}
        </p>
      </div>
    );
  }

  const frameStyle = inlineMediaAspectBoxStyle(
    dimensions?.width ?? metaWidth ?? 0,
    dimensions?.height ?? metaHeight ?? 0,
    INLINE_VIDEO_MAX_HEIGHT,
  ) ?? inlineMediaAspectBoxStyle(640, 360, INLINE_VIDEO_MAX_HEIGHT);
  const loading = !src || ((IS_MACOS || useCompat) && !ready);

  return (
    <div
      ref={containerRef}
      style={{
        ...frameStyle,
        position: "relative",
        borderRadius: spacing.unit,
        marginBlock: spacing.unit,
        backgroundColor: palette.bgTertiary,
      }}
    >
      {src && (
        <video
          ref={videoRef}
          controls={!loading}
          playsInline
          preload={IS_MACOS ? "auto" : "metadata"}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            borderRadius: spacing.unit,
            objectFit: "contain",
            backgroundColor: "#000",
          }}
          onLoadedMetadata={({ currentTarget: video }) => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setDimensions({ width: video.videoWidth, height: video.videoHeight });
            }
            if (!IS_MACOS) setReady(true);
          }}
          onLoadedData={() => setReady(true)}
          onCanPlay={() => setReady(true)}
          onError={({ currentTarget: video }) => {
            console.warn("[matrix video] playback failed", video.error?.code, video.error?.message);
            if (HAS_COMPAT_ROUTE && !useCompat) {
              setReady(false);
              setUseCompat(true);
            } else {
              setErrorDetail("Video could not be played (unsupported format or file missing).");
            }
          }}
        />
      )}
      {loading && (
        <div
          aria-busy={visible}
          aria-label={useCompat ? "Preparing video" : "Loading video"}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: spacing.unit,
            backgroundColor: palette.bgTertiary,
            display: "grid",
            placeContent: "center",
            justifyItems: "center",
            gap: spacing.unit,
            color: palette.textSecondary,
          }}
        >
          {visible && (
            <Loader2
              size={22}
              strokeWidth={2}
              style={{ animation: "spin 0.9s linear infinite" }}
              aria-hidden
            />
          )}
          {useCompat && <span style={{ fontSize: typography.fontSizeSmall }}>Preparing video…</span>}
        </div>
      )}
    </div>
  );
}

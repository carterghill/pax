import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { inlineMediaAspectBoxStyle } from "../utils/inlineMediaLayout";

const INLINE_VIDEO_MAX_HEIGHT = 480;
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const MATRIX_MEDIA_URL_PREFIX = IS_WINDOWS
  ? "http://paxmatrixmedia.localhost"
  : "paxmatrixmedia://localhost";

interface MessageMatrixVideoProps {
  request: unknown;
  /** Matrix `m.video` `info` dimensions when known (loading placeholder only). */
  metaWidth?: number;
  metaHeight?: number;
  mimeType?: string | null;
}

export default function MessageMatrixVideo({
  request,
  metaWidth,
  metaHeight,
  mimeType,
}: MessageMatrixVideoProps) {
  const { palette, typography, spacing } = useTheme();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // WebKitGTK rejects some codec/container combos (e.g. VP9-in-MP4) that
  // play fine elsewhere; on playback error we retry once through the
  // backend's compat route, which rewraps/transcodes into a playable file.
  const [useCompat, setUseCompat] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const requestKey = JSON.stringify(request);
  const logVideoState = (eventName: string) => {
    const video = videoRef.current;
    if (!video) return;
    const mediaError = video.error;
    console.info("[matrix video]", eventName, {
      currentSrc: video.currentSrc,
      networkState: video.networkState,
      readyState: video.readyState,
      buffered:
        video.buffered.length > 0
          ? Array.from({ length: video.buffered.length }, (_, i) => [
              video.buffered.start(i),
              video.buffered.end(i),
            ])
          : [],
      error: mediaError
        ? {
            code: mediaError.code,
            message: mediaError.message,
          }
        : null,
    });
  };

  const loadingReserve =
    metaWidth != null &&
    metaHeight != null &&
    metaWidth > 0 &&
    metaHeight > 0
      ? inlineMediaAspectBoxStyle(metaWidth, metaHeight, INLINE_VIDEO_MAX_HEIGHT)
      : null;

  useEffect(() => {
    setUseCompat(false);
  }, [requestKey]);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    setErrorDetail(null);
    setPreparing(useCompat);

    try {
      JSON.parse(requestKey);
    } catch {
      setFailed(true);
      setErrorDetail("Invalid video request data.");
      return;
    }

    const ext =
      mimeType === "video/webm"
        ? "webm"
        : mimeType === "video/quicktime"
          ? "mov"
          : "mp4";
    const compatSuffix = useCompat ? "&compat=1" : "";
    setSrc(
      `${MATRIX_MEDIA_URL_PREFIX}/download.${ext}?request=${encodeURIComponent(requestKey)}${compatSuffix}`,
    );
  }, [mimeType, requestKey, useCompat]);

  // Release video resources when src changes or component unmounts
  useEffect(() => {
    const vid = videoRef.current;
    return () => {
      if (vid) {
        vid.pause();
        vid.removeAttribute("src");
        vid.load();
      }
    };
  }, [src]);

  const videoStyle = {
    maxWidth: "100%" as const,
    maxHeight: INLINE_VIDEO_MAX_HEIGHT,
    borderRadius: spacing.unit,
    display: "block" as const,
    marginTop: spacing.unit,
    marginBottom: spacing.unit,
    backgroundColor: "#000",
  };

  if (failed) {
    return (
      <div style={{ marginTop: spacing.unit }}>
        <p
          style={{
            margin: 0,
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
          }}
        >
          Could not load video.
        </p>
        {errorDetail ? (
          <p
            style={{
              margin: `${spacing.unit}px 0 0`,
              color: palette.textSecondary,
              fontSize: typography.fontSizeSmall * 0.92,
              opacity: 0.85,
              wordBreak: "break-word",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {errorDetail}
          </p>
        ) : null}
      </div>
    );
  }

  const loaderBox = (label?: string) => (
    <div
      style={{
        marginTop: spacing.unit,
        marginBottom: spacing.unit,
      }}
    >
      <div
        style={{
          ...loadingReserve,
          minHeight: loadingReserve ? undefined : spacing.unit * 10,
          borderRadius: spacing.unit,
          backgroundColor: "#000",
          display: "flex",
          flexDirection: "column",
          gap: spacing.unit,
          alignItems: "center",
          justifyContent: "center",
          color: palette.textSecondary,
        }}
        aria-busy
        aria-label={label ?? "Loading video"}
      >
        <Loader2
          size={22}
          strokeWidth={2}
          style={{ animation: "spin 0.9s linear infinite" }}
          aria-hidden
        />
        {label ? (
          <span style={{ fontSize: typography.fontSizeSmall }}>{label}</span>
        ) : null}
      </div>
    </div>
  );

  if (!src) {
    return loaderBox();
  }

  return (
    <>
      {preparing ? loaderBox("Preparing video…") : null}
      <video
        key={src}
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        style={preparing ? { ...videoStyle, display: "none" } : videoStyle}
        onLoadStart={() => logVideoState("loadstart")}
        onLoadedMetadata={() => {
          logVideoState("loadedmetadata");
          setPreparing(false);
        }}
        onCanPlay={() => {
          logVideoState("canplay");
          setPreparing(false);
        }}
        onWaiting={() => logVideoState("waiting")}
        onStalled={() => logVideoState("stalled")}
        onSuspend={() => logVideoState("suspend")}
        onError={() => {
          logVideoState("error");
          if (!useCompat && !IS_WINDOWS) {
            console.info("[matrix video] retrying via compat conversion route");
            setUseCompat(true);
            return;
          }
          setFailed(true);
          setErrorDetail("Video could not be played (unsupported format or file missing).");
          setSrc(null);
          setPreparing(false);
        }}
        src={src}
      />
    </>
  );
}

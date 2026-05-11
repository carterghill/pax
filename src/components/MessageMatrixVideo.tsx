import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { inlineMediaAspectBoxStyle } from "../utils/inlineMediaLayout";

const INLINE_VIDEO_MAX_HEIGHT = 480;
const MATRIX_MEDIA_URL_PREFIX = navigator.userAgent.includes("Windows")
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
  const videoRef = useRef<HTMLVideoElement>(null);

  const requestKey = JSON.stringify(request);

  const loadingReserve =
    metaWidth != null &&
    metaHeight != null &&
    metaWidth > 0 &&
    metaHeight > 0
      ? inlineMediaAspectBoxStyle(metaWidth, metaHeight, INLINE_VIDEO_MAX_HEIGHT)
      : null;

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    setErrorDetail(null);

    try {
      JSON.parse(requestKey);
    } catch {
      setFailed(true);
      setErrorDetail("Invalid video request data.");
      return;
    }

    setSrc(`${MATRIX_MEDIA_URL_PREFIX}/download?request=${encodeURIComponent(requestKey)}`);
  }, [requestKey]);

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

  if (!src) {
    return (
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
            alignItems: "center",
            justifyContent: "center",
            color: palette.textSecondary,
          }}
          aria-busy
          aria-label="Loading video"
        >
          <Loader2
            size={22}
            strokeWidth={2}
            style={{ animation: "spin 0.9s linear infinite" }}
            aria-hidden
          />
        </div>
      </div>
    );
  }

  return (
    <video
      key={src}
      ref={videoRef}
      controls
      playsInline
      preload="metadata"
      style={videoStyle}
      onError={() => {
        setFailed(true);
        setErrorDetail("Video could not be played (unsupported format or file missing).");
        setSrc(null);
      }}
    >
      <source src={src} type={mimeType ?? "video/mp4"} />
    </video>
  );
}

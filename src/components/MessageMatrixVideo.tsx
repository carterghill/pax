import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import { inlineMediaAspectBoxStyle } from "../utils/inlineMediaLayout";

const INLINE_VIDEO_MAX_HEIGHT = 480;

function formatInvokeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

interface MessageMatrixVideoProps {
  request: unknown;
  /** Matrix `m.video` `info` dimensions when known (loading placeholder only). */
  metaWidth?: number;
  metaHeight?: number;
}

export default function MessageMatrixVideo({
  request,
  metaWidth,
  metaHeight,
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
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    setErrorDetail(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(requestKey);
    } catch {
      if (!cancelled) {
        setFailed(true);
        setErrorDetail("Invalid video request data.");
      }
      return () => {
        cancelled = true;
      };
    }

    invoke<string>("get_matrix_image_path", { request: parsed })
      .then((path) => {
        if (!cancelled) setSrc(convertFileSrc(path));
      })
      .catch((err) => {
        const msg = formatInvokeError(err);
        console.error("get_matrix_image_path (video):", msg);
        if (!cancelled) {
          setFailed(true);
          setErrorDetail(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
        }
      });

    return () => {
      cancelled = true;
    };
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
      ref={videoRef}
      src={src}
      controls
      playsInline
      preload="metadata"
      style={videoStyle}
      onError={() => {
        setFailed(true);
        setErrorDetail("Video could not be played (unsupported format or file missing).");
        setSrc(null);
      }}
    />
  );
}

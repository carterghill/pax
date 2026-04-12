import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";

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
}

export default function MessageMatrixVideo({ request }: MessageMatrixVideoProps) {
  const { palette, typography, spacing } = useTheme();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const requestKey = JSON.stringify(request);

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

  const videoStyle = {
    maxWidth: "100%" as const,
    maxHeight: 480,
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
      <p
        style={{
          margin: 0,
          marginTop: spacing.unit,
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
        }}
      >
        Loading video…
      </p>
    );
  }

  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      style={videoStyle}
      onError={(e) => {
        const vid = e.currentTarget;
        console.error("Matrix video failed:", {
          src: vid.src?.slice(0, 80),
          code: vid.error?.code,
          message: vid.error?.message,
        });
        setFailed(true);
        setErrorDetail("Video could not be played (unsupported format or file missing).");
        setSrc(null);
      }}
    />
  );
}

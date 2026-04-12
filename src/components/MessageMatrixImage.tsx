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

interface MessageMatrixImageProps {
  request: unknown;
  /** Opens the full-screen media viewer (Discord-style lightbox). */
  onExpand?: () => void;
}

export default function MessageMatrixImage({ request, onExpand }: MessageMatrixImageProps) {
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
        setErrorDetail("Invalid image request data.");
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
        console.error("get_matrix_image_path:", msg);
        if (!cancelled) {
          setFailed(true);
          setErrorDetail(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  const imgStyle = {
    maxWidth: "100%",
    height: "auto" as const,
    borderRadius: spacing.unit,
    display: "block" as const,
    marginTop: spacing.unit,
    marginBottom: spacing.unit,
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
          Could not load image.
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
        Loading image…
      </p>
    );
  }

  const imgEl = (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      style={imgStyle}
      onError={() => {
        console.error("Matrix image <img> failed to decode or load:", src?.slice(0, 80));
        setFailed(true);
        setErrorDetail("Image could not be displayed (file missing or invalid).");
        setSrc(null);
      }}
    />
  );

  if (!onExpand) return imgEl;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand();
        }
      }}
      style={{
        display: "inline-block",
        cursor: "pointer",
        marginTop: spacing.unit,
        marginBottom: spacing.unit,
        borderRadius: spacing.unit,
        outline: "none",
      }}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{
          maxWidth: "100%",
          height: "auto",
          borderRadius: spacing.unit,
          display: "block",
        }}
        onError={() => {
          console.error("Matrix image <img> failed to decode or load:", src?.slice(0, 80));
          setFailed(true);
          setErrorDetail("Image could not be displayed (file missing or invalid).");
          setSrc(null);
        }}
      />
    </span>
  );
}

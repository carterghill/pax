import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import { inlineMediaAspectBoxStyle } from "../utils/inlineMediaLayout";

const INLINE_IMAGE_MAX_HEIGHT = 400;

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
  /** Matrix `m.image` `info` dimensions when known (layout / placeholder). */
  metaWidth?: number;
  metaHeight?: number;
  /** Opens the full-screen media viewer (Discord-style lightbox). */
  onExpand?: () => void;
}

export default function MessageMatrixImage({
  request,
  metaWidth,
  metaHeight,
  onExpand,
}: MessageMatrixImageProps) {
  const { palette, typography, spacing } = useTheme();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const requestKey = JSON.stringify(request);

  const reserve =
    metaWidth != null && metaHeight != null
      ? inlineMediaAspectBoxStyle(metaWidth, metaHeight, INLINE_IMAGE_MAX_HEIGHT)
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

  // Release decoded image data when src changes or component unmounts
  useEffect(() => {
    const img = imgRef.current;
    return () => {
      if (img) img.src = "";
    };
  }, [src]);

  const imgStyle: React.CSSProperties = {
    maxWidth: "100%",
    maxHeight: INLINE_IMAGE_MAX_HEIGHT,
    height: "auto" as const,
    objectFit: "contain" as const,
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
      <div
        style={{
          marginTop: spacing.unit,
          marginBottom: spacing.unit,
        }}
      >
        <div
          style={{
            ...reserve,
            minHeight: reserve ? undefined : spacing.unit * 10,
            borderRadius: spacing.unit,
            backgroundColor: palette.bgTertiary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: palette.textSecondary,
          }}
          aria-busy
          aria-label="Loading image"
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

  const handleError = () => {
    setFailed(true);
    setErrorDetail("Image could not be displayed (file missing or invalid).");
    setSrc(null);
  };

  const hasMeta =
    metaWidth != null &&
    metaHeight != null &&
    metaWidth > 0 &&
    metaHeight > 0;

  if (!onExpand) {
    return (
      <img
        ref={imgRef}
        src={src}
        alt=""
        width={hasMeta ? metaWidth : undefined}
        height={hasMeta ? metaHeight : undefined}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={imgStyle}
        onError={handleError}
      />
    );
  }

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
        ref={imgRef}
        src={src}
        alt=""
        width={hasMeta ? metaWidth : undefined}
        height={hasMeta ? metaHeight : undefined}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{
          maxWidth: "100%",
          maxHeight: INLINE_IMAGE_MAX_HEIGHT,
          height: "auto",
          objectFit: "contain",
          borderRadius: spacing.unit,
          display: "block",
        }}
        onError={handleError}
      />
    </span>
  );
}

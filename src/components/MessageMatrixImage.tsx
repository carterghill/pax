import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { decode } from "blurhash";
import { useTheme } from "../theme/ThemeContext";

const INLINE_IMAGE_MAX_HEIGHT = 400;
const BLURHASH_W = 32;
const BLURHASH_H = 32;

function formatInvokeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function decodeBlurhashToDataUrl(
  hash: string,
  width: number,
  height: number,
): string | null {
  try {
    const pixels = decode(hash, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

interface MessageMatrixImageProps {
  request: unknown;
  metaWidth?: number;
  metaHeight?: number;
  blurhash?: string;
  onExpand?: () => void;
}

export default function MessageMatrixImage({
  request,
  metaWidth,
  metaHeight,
  blurhash,
  onExpand,
}: MessageMatrixImageProps) {
  const { palette, typography, spacing } = useTheme();
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const requestKey = JSON.stringify(request);

  const blurhashDataUrl = useMemo(
    () => (blurhash ? decodeBlurhashToDataUrl(blurhash, BLURHASH_W, BLURHASH_H) : null),
    [blurhash],
  );

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setLoaded(false);
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

  useEffect(() => {
    const img = imgRef.current;
    return () => {
      if (img) img.src = "";
    };
  }, [src]);

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

  const hasMeta =
    metaWidth != null &&
    metaHeight != null &&
    metaWidth > 0 &&
    metaHeight > 0;

  const handleError = () => {
    setFailed(true);
    setErrorDetail("Image could not be displayed (file missing or invalid).");
    setSrc(null);
  };

  let placeholderW: number;
  let placeholderH: number;
  if (hasMeta) {
    if (metaHeight > INLINE_IMAGE_MAX_HEIGHT) {
      placeholderH = INLINE_IMAGE_MAX_HEIGHT;
      placeholderW = (metaWidth / metaHeight) * INLINE_IMAGE_MAX_HEIGHT;
    } else {
      placeholderW = metaWidth;
      placeholderH = metaHeight;
    }
  } else {
    placeholderW = INLINE_IMAGE_MAX_HEIGHT;
    placeholderH = INLINE_IMAGE_MAX_HEIGHT;
  }

  const imgProps = {
    ref: imgRef,
    src: src ?? undefined,
    alt: "",
    width: hasMeta ? metaWidth : undefined,
    height: hasMeta ? metaHeight : undefined,
    decoding: "async" as const,
    draggable: false,
    onLoad: () => setLoaded(true),
    onError: handleError,
  };

  const imgStyle: React.CSSProperties = {
    width: "auto",
    maxWidth: "100%",
    maxHeight: INLINE_IMAGE_MAX_HEIGHT,
    height: "auto",
    borderRadius: spacing.unit,
    display: "block",
  };

  const Wrapper = onExpand ? "span" : "div";
  const wrapperProps = onExpand
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: onExpand,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onExpand();
          }
        },
      }
    : {};

  return (
    <Wrapper
      {...wrapperProps}
      style={{
        display: "inline-block",
        marginTop: spacing.unit,
        marginBottom: spacing.unit,
        borderRadius: spacing.unit,
        outline: "none",
        position: "relative",
        cursor: onExpand ? "pointer" : undefined,
      }}
    >
      {!loaded && (
        <div
          style={{
            width: placeholderW,
            height: placeholderH,
            maxWidth: "100%",
            maxHeight: INLINE_IMAGE_MAX_HEIGHT,
            borderRadius: spacing.unit,
            overflow: "hidden",
            backgroundColor: palette.bgTertiary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: palette.textSecondary,
            position: "relative",
          }}
          aria-busy
          aria-label="Loading image"
        >
          {blurhashDataUrl && (
            <img
              src={blurhashDataUrl}
              alt=""
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                borderRadius: spacing.unit,
              }}
            />
          )}
          <Loader2
            size={22}
            strokeWidth={2}
            style={{
              animation: "spin 0.9s linear infinite",
              position: "relative",
            }}
            aria-hidden
          />
        </div>
      )}
      {src && (
        <img
          {...imgProps}
          style={{
            ...imgStyle,
            ...(loaded
              ? {}
              : { position: "absolute", opacity: 0, pointerEvents: "none" }),
          }}
        />
      )}
    </Wrapper>
  );
}

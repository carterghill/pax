import { useEffect, useRef, useCallback, useState } from "react";
import { Monitor, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

/**
 * ScreenShareViewer — Renders incoming screen share video frames.
 *
 * Pipeline:
 *   Rust: LiveKit NativeVideoStream → I420 scale (libyuv) → RGBA → raw buffer
 *   Tauri: paxvideo:// serves raw RGBA pixels
 *   Frontend: ResizeObserver → /resize?w=&h= → fetch /frame → putImageData
 *
 * The frontend reports its actual display size (CSS pixels × devicePixelRatio)
 * so Rust only produces pixels at the resolution being displayed.
 * A 1920×1080 stream in a 800×450 viewer transfers ~1.4MB instead of ~8MB.
 */

interface ScreenShareViewerProps {
  active: boolean;
  /** Participant identity whose stream to display */
  identity: string;
}

function getPaxVideoUrl(path: string): string {
  const isWindows = navigator.userAgent.includes("Windows");
  if (isWindows) {
    return `http://paxvideo.localhost${path}`;
  }
  return `paxvideo://localhost${path}`;
}

export default function ScreenShareViewer({ active, identity }: ScreenShareViewerProps) {
  const { palette, spacing, typography } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  // ── Report container size to Rust so it can downscale ─────────────
  useEffect(() => {
    if (!active || !containerRef.current) return;

    const reportSize = (entry?: ResizeObserverEntry) => {
      const el = entry?.target ?? containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Use physical pixels so we get crisp rendering on HiDPI displays
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w > 0 && h > 0) {
        // Fire-and-forget — don't await, don't block rendering
        fetch(getPaxVideoUrl(`/resize?id=${encodeURIComponent(identity)}&w=${w}&h=${h}`)).catch(() => {});
      }
    };

    // Report initial size
    reportSize();

    // Track size changes (window resize, sidebar toggle, etc.)
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        reportSize(entry);
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      // Reset to native resolution when viewer unmounts
      fetch(getPaxVideoUrl(`/resize?id=${encodeURIComponent(identity)}&w=0&h=0`)).catch(() => {});
    };
  }, [active, identity]);

  // ── Frame fetch loop ──────────────────────────────────────────────
  const fetchAndDrawFrame = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const resp = await fetch(getPaxVideoUrl(`/frame?id=${encodeURIComponent(identity)}`));
      if (resp.status === 204 || !resp.ok) return;

      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 8) return;

      const header = new DataView(buf, 0, 8);
      const width = header.getUint32(0, true);
      const height = header.getUint32(4, true);

      const expectedSize = 8 + width * height * 4;
      if (buf.byteLength < expectedSize || width === 0 || height === 0) return;

      if (loading) setLoading(false);

      if (!dimensions || dimensions.width !== width || dimensions.height !== height) {
        setDimensions({ width, height });
      }

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const pixels = new Uint8ClampedArray(buf, 8, width * height * 4);
      const imageData = new ImageData(pixels, width, height);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // Silently retry
    }
  }, [loading, dimensions, identity]);

  useEffect(() => {
    if (!active) {
      setLoading(true);
      setDimensions(null);
      return;
    }

    let running = true;

    const poll = async () => {
      while (running) {
        await fetchAndDrawFrame();
        await new Promise((r) => setTimeout(r, 16));
      }
    };

    poll();

    return () => {
      running = false;
    };
  }, [active, fetchAndDrawFrame]);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: palette.bgPrimary,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {loading && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: spacing.unit * 2,
            color: palette.textSecondary,
          }}
        >
          <style>{`@keyframes ssv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          <Loader2
            size={32}
            color={palette.textSecondary}
            style={{ animation: "ssv-spin 1s linear infinite" }}
          />
          <span style={{ fontSize: typography.fontSizeSmall }}>
            Waiting for screen share frames...
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          display: loading ? "none" : "block",
        }}
      />
      {dimensions && !loading && (
        <div
          style={{
            position: "absolute",
            bottom: spacing.unit,
            right: spacing.unit * 2,
            fontSize: typography.fontSizeSmall - 1,
            color: palette.textSecondary,
            opacity: 0.6,
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
          }}
        >
          <Monitor size={10} />
          {dimensions.width}×{dimensions.height}
        </div>
      )}
    </div>
  );
}
import { useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Monitor, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

/**
 * ScreenShareViewer — Renders incoming screen share video frames.
 *
 * Pipeline:
 *   Rust: LiveKit NativeVideoStream → I420 scale (libyuv) → RGBA → store + emit event
 *   Tauri: "screen-share-frame-ready" event notifies frontend immediately
 *   Frontend: event → fetch /frame?id= → putImageData (zero polling delay)
 *
 * Frames are rendered on the next requestAnimationFrame for vsync alignment.
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
  // Reuse ImageData across frames of the same dimensions to reduce GC pressure
  const imageDataRef = useRef<ImageData | null>(null);
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
    };
  }, [active, identity]);

  // ── Event-driven frame delivery ─────────────────────────────────────
  // Rust emits "screen-share-frame-ready" when a new frame is stored.
  // We fetch immediately on event, then draw on the next vsync.
  useEffect(() => {
    if (!active || !identity) {
      setLoading(true);
      setDimensions(null);
      imageDataRef.current = null;
      return;
    }

    let mounted = true;
    let busy = false; // prevents overlapping fetches (backpressure)
    let unlisten: UnlistenFn | null = null;

    const fetchAndDraw = async () => {
      if (busy || !mounted) return;
      busy = true;

      try {
        const resp = await fetch(getPaxVideoUrl(`/frame?id=${encodeURIComponent(identity)}`));
        if (!mounted) return;
        if (resp.status === 204 || !resp.ok) return;

        const buf = await resp.arrayBuffer();
        if (!mounted) return;
        if (buf.byteLength < 8) return;

        const header = new DataView(buf, 0, 8);
        const width = header.getUint32(0, true);
        const height = header.getUint32(4, true);

        const expectedSize = 8 + width * height * 4;
        if (buf.byteLength < expectedSize || width === 0 || height === 0) return;

        // Draw on next vsync for smooth timing
        requestAnimationFrame(() => {
          if (!mounted) return;
          const canvas = canvasRef.current;
          if (!canvas) return;

          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            // Dimensions changed — need a fresh ImageData
            imageDataRef.current = null;
          }

          const ctx = canvas.getContext("2d");
          if (!ctx) return;

          // Reuse ImageData when dimensions are stable (avoids GC pressure)
          let imgData = imageDataRef.current;
          if (!imgData || imgData.width !== width || imgData.height !== height) {
            imgData = ctx.createImageData(width, height);
            imageDataRef.current = imgData;
          }

          // Copy pixel data into the persistent ImageData buffer
          const src = new Uint8Array(buf, 8, width * height * 4);
          imgData.data.set(src);
          ctx.putImageData(imgData, 0, 0);

          setLoading(false);
          setDimensions((prev) =>
            prev?.width === width && prev?.height === height
              ? prev
              : { width, height }
          );
        });
      } catch {
        // Expected during start/stop transitions
      } finally {
        busy = false;
      }
    };

    // Listen for frame-ready events from Rust
    listen<{ id: string }>("screen-share-frame-ready", (event) => {
      if (event.payload.id === identity) {
        fetchAndDraw();
      }
    }).then((fn) => {
      unlisten = fn;
    });

    // Also do one initial fetch in case frames arrived before the listener registered
    fetchAndDraw();

    return () => {
      mounted = false;
      if (unlisten) unlisten();
      // Reset target resolution
      fetch(getPaxVideoUrl(`/resize?id=${encodeURIComponent(identity)}&w=0&h=0`)).catch(() => {});
    };
  }, [active, identity]);

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
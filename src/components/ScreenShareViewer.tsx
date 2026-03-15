import { useEffect, useRef, useCallback, useState } from "react";
import { Monitor, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

/**
 * ScreenShareViewer — Renders incoming screen share video frames from the
 * Rust backend via the `paxvideo://` custom URI scheme protocol.
 *
 * Architecture:
 *   Rust: LiveKit NativeVideoStream → I420→RGBA (libyuv SIMD) → raw pixel buffer
 *   Tauri: paxvideo:// URI scheme serves raw RGBA bytes (8-byte header + pixels)
 *   Frontend: polls → fetch ArrayBuffer → putImageData on canvas (zero decode)
 *
 * No JPEG encode/decode in the pipeline — raw pixel transfer only.
 */

interface ScreenShareViewerProps {
  /** Whether a remote screen share is active (not our own) */
  active: boolean;
}

/**
 * Build the correct URL for the paxvideo custom URI scheme.
 * Tauri custom schemes use different URL formats per platform:
 *   Linux/macOS: paxvideo://localhost/<path>
 *   Windows:     http://paxvideo.localhost/<path>
 */
function getPaxVideoUrl(path: string): string {
  const isWindows = navigator.userAgent.includes("Windows");
  if (isWindows) {
    return `http://paxvideo.localhost${path}`;
  }
  return `paxvideo://localhost${path}`;
}

export default function ScreenShareViewer({ active }: ScreenShareViewerProps) {
  const { palette, spacing, typography } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  const fetchAndDrawFrame = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const resp = await fetch(getPaxVideoUrl("/frame"));

      if (resp.status === 204 || !resp.ok) return;

      const buf = await resp.arrayBuffer();
      // Binary format: 4 bytes width (u32 LE) + 4 bytes height (u32 LE) + RGBA pixels
      if (buf.byteLength < 8) return;

      const header = new DataView(buf, 0, 8);
      const width = header.getUint32(0, true);   // little-endian
      const height = header.getUint32(4, true);

      const expectedSize = 8 + width * height * 4;
      if (buf.byteLength < expectedSize || width === 0 || height === 0) return;

      // Clear loading on first good frame
      if (loading) setLoading(false);

      if (!dimensions || dimensions.width !== width || dimensions.height !== height) {
        setDimensions({ width, height });
      }

      // Size the canvas to match the frame
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Create ImageData directly from the raw RGBA bytes — zero decoding
      const pixels = new Uint8ClampedArray(buf, 8, width * height * 4);
      const imageData = new ImageData(pixels, width, height);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // Silently retry — expected during start/stop transitions
    }
  }, [loading, dimensions]);

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
        // Minimal delay — Rust side stores latest-only so we can poll fast.
        // The fetch round-trip (~3-5ms for 8MB in-process) is the natural throttle.
        await new Promise((r) => setTimeout(r, 16)); // ~60fps cap
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
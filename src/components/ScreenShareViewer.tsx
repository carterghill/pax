import { useEffect, useRef, useCallback, useState } from "react";
import { Monitor, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

/**
 * ScreenShareViewer — Renders incoming screen share video frames from the
 * Rust backend via the `paxvideo://` custom URI scheme protocol.
 *
 * Architecture:
 *   Rust: LiveKit NativeVideoStream → I420→RGBA→JPEG → frame buffer
 *   Tauri: paxvideo:// URI scheme serves latest JPEG frame
 *   Frontend: polls at ~15fps → fetch → createImageBitmap → canvas drawImage
 *
 * The polling approach provides natural backpressure — if the frontend is
 * slow to render, it simply skips frames.  The Rust side only ever stores
 * the latest frame, so there's no buffering or memory growth.
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
  const animFrameRef = useRef<number>(0);
  const [loading, setLoading] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  const fetchAndDrawFrame = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const url = getPaxVideoUrl("/frame");
      const resp = await fetch(url);

      if (resp.status === 204) {
        // No frame available yet
        return;
      }
      if (!resp.ok) return;

      const blob = await resp.blob();
      if (blob.size === 0) return;

      // We got a real frame — clear loading state
      if (loading) setLoading(false);

      // createImageBitmap decodes the JPEG off the main thread
      const bitmap = await createImageBitmap(blob);

      if (
        !dimensions ||
        dimensions.width !== bitmap.width ||
        dimensions.height !== bitmap.height
      ) {
        setDimensions({ width: bitmap.width, height: bitmap.height });
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return;
      }

      // Scale canvas to match the frame dimensions (for crisp rendering)
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }

      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } catch (e) {
      // Fetch errors are expected when screen share just started/stopped
      // or the protocol isn't ready yet. Silently retry.
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
        // Target ~15fps polling interval.
        await new Promise((r) => setTimeout(r, 66));
      }
    };

    poll();

    return () => {
      running = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
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
          // Crisp pixel rendering for screen content (text, code, etc.)
          imageRendering: "auto",
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
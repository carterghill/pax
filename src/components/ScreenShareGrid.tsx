import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Grid2x2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import ScreenShareViewer from "./ScreenShareViewer";
import { useOverlayHover } from "../hooks/useOverlayObstruction";

/**
 * ScreenShareGrid — Multi-stream screen share layout.
 *
 * Two modes:
 *   Grid:  All streams displayed as equal tiles (auto-arranges 1, 2×1, 2×2, etc.)
 *   Focus: One stream large, others as small previews in a strip below.
 *
 * Click a tile in grid mode to focus it. Click "Grid" button to return.
 * Resolution adapts per-tile via ScreenShareViewer's ResizeObserver.
 */

interface ScreenShareGridProps {
  /** Identities of remote participants sharing their screens */
  remoteSharers: string[];
  /** Whether the local user is sharing */
  isLocalScreenSharing: boolean;
}

/** Extract a short display name from a Matrix-style identity */
function displayName(identity: string): string {
  if (identity.startsWith("@")) {
    return identity.slice(1).split(":")[0];
  }
  return identity;
}

export default function ScreenShareGrid({
  remoteSharers,
  isLocalScreenSharing,
}: ScreenShareGridProps) {
  const { palette, spacing, typography } = useTheme();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 });

  // Track container size for smart grid layout
  useEffect(() => {
    if (!gridRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.contentRect;
        if (rect.width > 0 && rect.height > 0) {
          setContainerSize({ w: rect.width, h: rect.height });
        }
      }
    });
    observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, []);

  // If the focused stream disappears, fall back to grid
  const effectiveFocusId = focusedId && remoteSharers.includes(focusedId) ? focusedId : null;

  // All streams to display (remote streams only — local shows a placeholder)
  const allStreams = useMemo(() => {
    const streams: Array<{ identity: string; isLocal: boolean }> = [];
    for (const id of remoteSharers) {
      streams.push({ identity: id, isLocal: false });
    }
    if (isLocalScreenSharing) {
      streams.push({ identity: "__local__", isLocal: true });
    }
    return streams;
  }, [remoteSharers, isLocalScreenSharing]);

  const isGridMode = effectiveFocusId === null;
  const streamCount = allStreams.length;

  // Compute CSS grid dimensions for grid mode.
  // Picks the arrangement where tiles are closest to 16:9 aspect ratio.
  const { cols, rows } = useMemo(() => {
    if (streamCount <= 1) return { cols: 1, rows: 1 };

    const targetTileAR = 16 / 9; // ideal tile aspect ratio for screen content

    // For each candidate (cols, rows), compute how close each tile's
    // aspect ratio is to 16:9 and pick the best one.
    const candidates: Array<{ cols: number; rows: number }> = [];
    for (let c = 1; c <= Math.min(streamCount, 4); c++) {
      const r = Math.ceil(streamCount / c);
      candidates.push({ cols: c, rows: r });
    }

    let best = candidates[0];
    let bestScore = Infinity;
    for (const cand of candidates) {
      const tileW = containerSize.w / cand.cols;
      const tileH = containerSize.h / cand.rows;
      const tileAR = tileW / tileH;
      // Score: how far from 16:9 (log ratio so over/under are weighted equally)
      const score = Math.abs(Math.log(tileAR / targetTileAR));
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best;
  }, [streamCount, containerSize]);

  const handleTileClick = useCallback((identity: string) => {
    if (identity === "__local__") return; // Can't focus local placeholder
    setFocusedId((prev) => (prev === identity ? null : identity));
  }, []);

  if (streamCount === 0) return null;

  // ── Focus mode ──────────────────────────────────────────────────────
  if (!isGridMode && effectiveFocusId) {
    const focusedStream = allStreams.find((s) => s.identity === effectiveFocusId);
    const otherStreams = allStreams.filter((s) => s.identity !== effectiveFocusId);

    return (
      <div ref={gridRef} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Controls bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: `${spacing.unit}px ${spacing.unit * 2}px`,
          gap: spacing.unit * 2,
          borderBottom: `1px solid ${palette.border}`,
          flexShrink: 0,
        }}>
          <button
            onClick={() => setFocusedId(null)}
            title="Back to grid"
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit}px ${spacing.unit * 2}px`,
              border: `1px solid ${palette.border}`,
              borderRadius: spacing.unit,
              backgroundColor: palette.bgTertiary,
              color: palette.textPrimary,
              cursor: "pointer",
              fontSize: typography.fontSizeSmall,
            }}
          >
            <Grid2x2 size={14} />
            Grid
          </button>
          <span style={{ fontSize: typography.fontSizeSmall, color: palette.textSecondary }}>
            {displayName(effectiveFocusId)}'s screen
          </span>
        </div>

        {/* Focused stream — takes most of the space */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {focusedStream && !focusedStream.isLocal && (
            <ScreenShareViewer
              active={true}
              identity={focusedStream.identity}
            />
          )}
          {focusedStream && focusedStream.isLocal && (
            <LocalSharePlaceholder palette={palette} />
          )}
        </div>

        {/* Preview strip — small tiles for other streams */}
        {otherStreams.length > 0 && (
          <div style={{
            display: "flex",
            gap: spacing.unit,
            padding: spacing.unit,
            borderTop: `1px solid ${palette.border}`,
            overflowX: "auto",
            flexShrink: 0,
            height: 120,
            minHeight: 120,
            backgroundColor: palette.bgSecondary,
          }}>
            {otherStreams.map((stream) => (
              <div
                key={stream.identity}
                style={{
                  width: 180,
                  minWidth: 180,
                  height: "100%",
                }}
              >
                <StreamTile
                  stream={stream}
                  onClick={() => handleTileClick(stream.identity)}
                  palette={palette}
                  spacing={spacing}
                  typography={typography}
                  small
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Grid mode ───────────────────────────────────────────────────────
  return (
    <div ref={gridRef} style={{
      flex: 1,
      display: "grid",
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gap: spacing.unit,
      padding: spacing.unit,
      overflow: "hidden",
    }}>
      {allStreams.map((stream) => (
        <StreamTile
          key={stream.identity}
          stream={stream}
          onClick={() => handleTileClick(stream.identity)}
          palette={palette}
          spacing={spacing}
          typography={typography}
        />
      ))}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/** A single stream tile that uses native HWND hover tracking for border highlight. */
function StreamTile({
  stream,
  onClick,
  palette,
  spacing,
  typography,
  small,
}: {
  stream: { identity: string; isLocal: boolean };
  onClick: () => void;
  palette: any;
  spacing: any;
  typography: any;
  small?: boolean;
}) {
  // Use native hover tracking — the HWND sets this via WM_MOUSEMOVE/WM_MOUSELEAVE
  const nativeHover = useOverlayHover(stream.identity);
  const showHover = !stream.isLocal && nativeHover;

  return (
    <div
      onClick={onClick}
      style={{
        borderRadius: spacing.unit,
        overflow: "hidden",
        cursor: stream.isLocal ? "default" : "pointer",
        border: `2px solid ${showHover ? palette.accent : "transparent"}`,
        position: "relative",
        backgroundColor: palette.bgPrimary,
        transition: "border-color 0.15s",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
      // Keep DOM hover as fallback for tiles without native overlay (local share)
      onMouseEnter={(e) => {
        if (!stream.isLocal) e.currentTarget.style.borderColor = palette.accent;
      }}
      onMouseLeave={(e) => {
        if (!showHover) e.currentTarget.style.borderColor = "transparent";
      }}
    >
      {!stream.isLocal ? (
        <ScreenShareViewer
          active={true}
          identity={stream.identity}
        />
      ) : (
        <LocalSharePlaceholder palette={palette} small={small} />
      )}
      <TileLabel name={displayName(stream.identity)} palette={palette} typography={typography} spacing={spacing} />
    </div>
  );
}

function LocalSharePlaceholder({ palette, small }: { palette: any; small?: boolean }) {
  return (
    <div style={{
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.bgPrimary,
      color: palette.textSecondary,
      fontSize: small ? 11 : 14,
    }}>
      <span>Your screen</span>
    </div>
  );
}

function TileLabel({ name, palette, typography, spacing }: {
  name: string;
  palette: any;
  typography: any;
  spacing: any;
}) {
  return (
    <div style={{
      position: "absolute",
      bottom: spacing.unit,
      left: spacing.unit,
      padding: `${spacing.unit * 0.5}px ${spacing.unit * 1.5}px`,
      backgroundColor: "rgba(0,0,0,0.6)",
      borderRadius: spacing.unit,
      fontSize: typography.fontSizeSmall - 1,
      color: "#fff",
      pointerEvents: "none",
      maxWidth: "80%",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    }}>
      {name}
    </div>
  );
}
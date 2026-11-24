import { useState, useMemo, useCallback, useRef, useEffect, type MouseEvent } from "react";
import { Grid2x2, PanelsTopLeft } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import CallVideo from "./CallVideo";
import type { CallStream } from "../utils/callVideoLayout";
import { useOverlayHover, useOverlayObstruction } from "../hooks/useOverlayObstruction";
import { localpartFromUserId } from "../utils/matrix";
import StreamVolumeControl from "./StreamVolumeControl";

/**
 * ScreenShareGrid — Multi-stream screen share layout.
 *
 * Two modes:
 *   Grid:  All streams displayed as equal tiles (auto-arranges 1, 2×1, 2×2, etc.)
 *   Focus: One stream large, others as small previews in a strip below.
 *
 * Switch layouts in the toolbar or select a tile to focus it.
 * Resolution adapts per-tile via ScreenShareViewer's ResizeObserver.
 */

interface ScreenShareGridProps {
  streams: CallStream[];
  /** Right-click a remote stream tile (e.g. volume menu over native overlay) */
  onStreamContextMenu?: (e: MouseEvent, identity: string, displayName: string) => void;
  /** Get the current volume for a participant (0–2) */
  getVolume: (identity: string) => number;
  /** Set volume for a participant (persists + applies to audio) */
  onVolumeChange?: (identity: string, volume: number) => void;
}

export default function ScreenShareGrid({
  streams,
  onStreamContextMenu,
  getVolume,
  onVolumeChange,
}: ScreenShareGridProps) {
  const { palette, spacing, typography } = useTheme();
  const [view, setView] = useState<"grid" | "focus">("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // Prefer a live feed over our own screen-share placeholder when choosing an initial focus.
  const selectedStream = streams.find((s) => s.identity === selectedId)
    ?? streams.find((s) => !s.local || s.source === "camera")
    ?? streams[0];
  const focusedStream = view === "focus" ? selectedStream : undefined;
  const streamCount = streams.length;

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

  function focusTile(identity: string) {
    setSelectedId(identity);
    setView("focus");
  }

  if (streamCount === 0) return null;

  const otherStreams = focusedStream ? streams.filter((s) => s.identity !== focusedStream.identity) : [];
  return (
    <div ref={gridRef} style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div role="group" aria-label="Video layout" style={{
        display: "flex", alignItems: "center", flexShrink: 0, gap: spacing.unit,
        padding: `${spacing.unit}px ${spacing.unit * 2}px`, borderBottom: `1px solid ${palette.border}`,
      }}>
        {(["grid", "focus"] as const).map((mode) => {
          const label = mode === "grid" ? "Grid view" : "Focused view";
          const Icon = mode === "grid" ? Grid2x2 : PanelsTopLeft;
          return <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={view === mode}
            title={label}
            onClick={() => mode === "focus" ? focusTile(selectedStream.identity) : setView("grid")}
            style={{
              display: "flex", alignItems: "center", gap: spacing.unit, flexShrink: 0,
              padding: `${spacing.unit}px ${spacing.unit * 2}px`,
              border: `1px solid ${view === mode ? palette.accent : palette.border}`, borderRadius: spacing.unit,
              backgroundColor: view === mode ? palette.bgActive : palette.bgTertiary,
              color: palette.textPrimary, cursor: "pointer", fontSize: typography.fontSizeSmall,
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {mode === "grid" ? "Grid" : "Focus"}
          </button>;
        })}
        {focusedStream && <span style={{
          fontSize: typography.fontSizeSmall, color: palette.textSecondary,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {focusedStream.local ? "Your" : `${localpartFromUserId(focusedStream.identity)}'s`} {focusedStream.source}
        </span>}
      </div>
      {focusedStream ? <>
        {/* Focused stream — takes most of the space */}
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <StreamTile stream={focusedStream} onStreamContextMenu={onStreamContextMenu}
            getVolume={getVolume} onVolumeChange={onVolumeChange}
            palette={palette} spacing={spacing} typography={typography} />
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
            height: "min(30%, 120px)",
            minHeight: 0,
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
                  onClick={() => focusTile(stream.identity)}
                  onStreamContextMenu={onStreamContextMenu}
                  getVolume={getVolume}
                  onVolumeChange={onVolumeChange}
                  palette={palette}
                  spacing={spacing}
                  typography={typography}
                  small
                />
              </div>
            ))}
          </div>
        )}
      </> : (
        <div style={{
          flex: 1, minHeight: 0, display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: spacing.unit, padding: spacing.unit, overflow: "hidden",
        }}>
          {streams.map((stream) => (
            <StreamTile
              key={stream.identity}
              stream={stream}
              onClick={() => focusTile(stream.identity)}
              onStreamContextMenu={onStreamContextMenu}
              getVolume={getVolume}
              onVolumeChange={onVolumeChange}
              palette={palette}
              spacing={spacing}
              typography={typography}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/** A single stream tile that uses native HWND hover tracking for border highlight. */
function StreamTile({
  stream,
  onClick,
  onStreamContextMenu,
  getVolume,
  onVolumeChange,
  palette,
  spacing,
  typography,
  small,
}: {
  stream: CallStream;
  onClick?: () => void;
  onStreamContextMenu?: (e: MouseEvent, identity: string, displayName: string) => void;
  getVolume: (identity: string) => number;
  onVolumeChange?: (identity: string, volume: number) => void;
  palette: any;
  spacing: any;
  typography: any;
  small?: boolean;
}) {
  // Native hover: polled from the HWND (Windows only — always false on Linux)
  const nativeHover = useOverlayHover(stream.local ? "" : stream.streamId);
  // DOM hover: fallback for Linux where video is a WebGL canvas in the DOM
  const [domHover, setDomHover] = useState(false);
  const placeholder = stream.local && stream.source === "screen";
  const interactive = !!onClick;
  const showHover = nativeHover || domHover;

  const handleVolumeChange = useCallback(
    (vol: number) => onVolumeChange?.(stream.identity, vol),
    [stream.identity, onVolumeChange],
  );

  return (
    <div
      onContextMenu={(e) => {
        if (stream.local || !onStreamContextMenu) return;
        onStreamContextMenu(e, stream.identity, localpartFromUserId(stream.identity));
      }}
      style={{
        borderRadius: spacing.unit,
        overflow: "visible",
        cursor: interactive ? "pointer" : "default",
        border: `2px solid ${interactive && showHover ? palette.accent : "transparent"}`,
        position: "relative",
        backgroundColor: palette.bgPrimary,
        transition: "border-color 0.15s",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
      onMouseEnter={() => {
        setDomHover(true);
      }}
      onMouseLeave={() => {
        setDomHover(false);
      }}
    >
      {placeholder ? <LocalSharePlaceholder palette={palette} small={small} /> : <CallVideo stream={stream} />}
      {interactive && <button
        type="button"
        aria-label={`Focus ${stream.local ? "your" : localpartFromUserId(stream.identity) + "'s"} ${stream.source}`}
        onClick={onClick}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "transparent", cursor: "pointer" }}
      />}
      <TileBottomBar
        name={stream.local ? "You" : localpartFromUserId(stream.identity)}
        typography={typography}
        spacing={spacing}
        volumeControl={
          !stream.local && stream.source === "screen" && onVolumeChange ? (
            <StreamVolumeControl
              visible={showHover}
              volume={getVolume(stream.identity)}
              onVolumeChange={handleVolumeChange}
            />
          ) : undefined
        }
      />
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

/**
 * TileBottomBar — label + optional volume control in a flex row at bottom-left.
 * The label portion always punches through the native overlay.
 * The volume control manages its own obstruction with fade logic.
 */
function TileBottomBar({ name, typography, spacing, volumeControl }: {
  name: string;
  typography: any;
  spacing: any;
  volumeControl?: React.ReactNode;
}) {
  const labelRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(labelRef, true);

  return (
    <div
      style={{
        position: "absolute",
        bottom: spacing.unit,
        left: spacing.unit,
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 0.75,
        zIndex: 2,
        maxWidth: "80%",
      }}
    >
      {/* Label — always visible, punches through */}
      <div
        ref={labelRef}
        style={{
          padding: `${spacing.unit * 0.5}px ${spacing.unit * 1.5}px`,
          backgroundColor: "rgba(0,0,0,0.6)",
          borderRadius: spacing.unit,
          fontSize: typography.fontSizeSmall - 1,
          color: "#fff",
          pointerEvents: "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {name}
      </div>

      {/* Volume control — fades in on hover, manages its own obstruction */}
      {volumeControl}
    </div>
  );
}

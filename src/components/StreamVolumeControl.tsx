import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Volume2, Volume1, VolumeX } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import {
  registerObstruction,
  unregisterObstruction,
} from "../hooks/useOverlayObstruction";

/**
 * StreamVolumeControl — Inline volume icon + vertical slider for a video stream tile.
 *
 * Rendering strategy (native overlay punch-through):
 *   The entire control is always present in the DOM, sitting behind the native
 *   video HWND.  When `visible` becomes true we:
 *     1. Register the element as an obstruction → Rust clips those pixels from
 *        the HWND, revealing the DOM underneath.
 *     2. CSS-transition opacity 0 → 1 over ~150ms.
 *   Because opacity-0 shows `bgPrimary` (which matches the HWND letterbox
 *   clear color), the net visual effect is a smooth fade-in.
 *
 *   On hide the reverse happens: opacity transitions back to 0, then on
 *   `transitionend` we unregister the obstruction so the HWND fills back in.
 *
 * Interaction:
 *   - Clicking the icon toggles mute/unmute (stores previous volume for restore).
 *   - Hovering the icon reveals a vertical volume slider.
 *   - Slider range is 0–200% (matching the per-user volume system).
 */

interface StreamVolumeControlProps {
  /** Whether this control should be visible (typically tied to stream hover) */
  visible: boolean;
  /** Current volume 0–2 (0%–200%) */
  volume: number;
  /** Called when the volume changes (from slider or mute toggle) */
  onVolumeChange: (volume: number) => void;
}

/** Duration of the fade animation in ms — keep in sync with the CSS transition. */
const FADE_MS = 150;

export default function StreamVolumeControl({
  visible,
  volume,
  onVolumeChange,
}: StreamVolumeControlProps) {
  const { palette, spacing } = useTheme();

  // ── Slider popup state ──────────────────────────────────────────────
  const [sliderOpen, setSliderOpen] = useState(false);
  const sliderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep slider open while hovering icon OR slider
  const openSlider = useCallback(() => {
    if (sliderTimeoutRef.current) {
      clearTimeout(sliderTimeoutRef.current);
      sliderTimeoutRef.current = null;
    }
    setSliderOpen(true);
  }, []);

  const closeSliderDelayed = useCallback(() => {
    if (sliderTimeoutRef.current) clearTimeout(sliderTimeoutRef.current);
    sliderTimeoutRef.current = setTimeout(() => setSliderOpen(false), 200);
  }, []);

  // Close slider when the whole control hides
  useEffect(() => {
    if (!visible) setSliderOpen(false);
  }, [visible]);

  // ── Mute toggle ─────────────────────────────────────────────────────
  const prevVolumeRef = useRef(1);
  const handleIconClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // don't trigger tile click (focus mode)
      if (volume > 0) {
        prevVolumeRef.current = volume;
        onVolumeChange(0);
      } else {
        onVolumeChange(prevVolumeRef.current || 1);
      }
    },
    [volume, onVolumeChange],
  );

  // ── Punch-through fade management ──────────────────────────────────
  //
  // We manage the obstruction lifecycle manually rather than using the
  // `useOverlayObstruction` hook because we need to *delay* unregistration
  // until the CSS opacity transition finishes (so the fade-out is visible
  // before the HWND fills back in).

  const containerRef = useRef<HTMLDivElement>(null);
  const obstructionIdRef = useRef<number | null>(null);
  /** Whether the obstruction is currently registered. */
  const registeredRef = useRef(false);
  /** Track the target visibility so the transitionend handler knows intent. */
  const targetVisibleRef = useRef(false);

  // Also need a separate obstruction for the slider popup since it may
  // extend outside the icon container's bounds.
  const sliderRef = useRef<HTMLDivElement>(null);
  const sliderObsIdRef = useRef<number | null>(null);

  // Register/unregister slider obstruction
  useLayoutEffect(() => {
    if (sliderOpen && visible && sliderRef.current) {
      sliderObsIdRef.current = registerObstruction(sliderRef.current);
    }
    return () => {
      if (sliderObsIdRef.current !== null) {
        unregisterObstruction(sliderObsIdRef.current);
        sliderObsIdRef.current = null;
      }
    };
  }, [sliderOpen, visible]);

  // When `visible` becomes true → register obstruction immediately.
  // When `visible` becomes false → defer unregistration until fade-out completes.
  useLayoutEffect(() => {
    targetVisibleRef.current = visible;

    if (visible) {
      // Register obstruction to punch a hole in the HWND
      if (!registeredRef.current && containerRef.current) {
        obstructionIdRef.current = registerObstruction(containerRef.current);
        registeredRef.current = true;
      }
    } else {
      // Schedule unregistration after fade-out transition
      const timer = setTimeout(() => {
        if (!targetVisibleRef.current && registeredRef.current) {
          if (obstructionIdRef.current !== null) {
            unregisterObstruction(obstructionIdRef.current);
            obstructionIdRef.current = null;
          }
          registeredRef.current = false;
        }
      }, FADE_MS + 30); // small buffer beyond CSS transition
      return () => clearTimeout(timer);
    }
  }, [visible]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (obstructionIdRef.current !== null) {
        unregisterObstruction(obstructionIdRef.current);
      }
      if (sliderObsIdRef.current !== null) {
        unregisterObstruction(sliderObsIdRef.current);
      }
    };
  }, []);

  // ── Volume icon picker ──────────────────────────────────────────────
  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.6 ? Volume1 : Volume2;
  const pct = Math.round(volume * 100);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        bottom: spacing.unit * 0.5,
        right: spacing.unit * 0.5,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // ── Fade transition ──
        opacity: visible ? 1 : 0,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: visible ? "auto" : "none",
      }}
      // Prevent tile click-through while interacting
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* ── Vertical slider popup (above icon) ── */}
      {sliderOpen && (
        <div
          ref={sliderRef}
          onMouseEnter={openSlider}
          onMouseLeave={closeSliderDelayed}
          style={{
            position: "absolute",
            bottom: 32,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: "8px 6px",
            backgroundColor: "rgba(0,0,0,0.80)",
            borderRadius: 8,
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          {/* Percentage label */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "#fff",
              lineHeight: 1,
              userSelect: "none",
            }}
          >
            {pct}%
          </span>

          {/* Vertical slider track */}
          <div
            style={{
              position: "relative",
              width: 6,
              height: 80,
              borderRadius: 3,
              backgroundColor: "rgba(255,255,255,0.2)",
              cursor: "pointer",
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              const track = e.currentTarget;
              const setFromEvent = (ev: globalThis.MouseEvent) => {
                const rect = track.getBoundingClientRect();
                const ratio = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
                onVolumeChange(ratio * 2); // 0–2 range
              };
              setFromEvent(e.nativeEvent);
              const onMove = (ev: globalThis.MouseEvent) => {
                ev.preventDefault();
                setFromEvent(ev);
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          >
            {/* Filled portion */}
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                width: "100%",
                height: `${Math.min(100, pct / 2)}%`,
                borderRadius: 3,
                backgroundColor: palette.accent,
                transition: "height 0.05s ease",
              }}
            />

            {/* 100% tick mark */}
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: -2,
                width: 10,
                height: 2,
                backgroundColor: "rgba(255,255,255,0.4)",
                borderRadius: 1,
                transform: "translateY(-50%)",
                pointerEvents: "none",
              }}
            />

            {/* Thumb */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: `${Math.min(100, pct / 2)}%`,
                transform: "translate(-50%, 50%)",
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: "#fff",
                border: `2px solid ${palette.accent}`,
                boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
                pointerEvents: "none",
                transition: "bottom 0.05s ease",
              }}
            />
          </div>
        </div>
      )}

      {/* ── Volume icon button ── */}
      <button
        title={volume === 0 ? "Unmute" : "Mute"}
        onClick={handleIconClick}
        onMouseEnter={openSlider}
        onMouseLeave={closeSliderDelayed}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: 6,
          border: "none",
          backgroundColor: "rgba(0,0,0,0.55)",
          color: volume === 0 ? "#ef4444" : "#fff",
          cursor: "pointer",
          padding: 0,
          transition: "background-color 0.12s ease",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.8)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.55)";
        }}
      >
        <VolumeIcon size={16} />
      </button>
    </div>
  );
}
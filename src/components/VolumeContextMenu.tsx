import { useEffect, useRef } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

interface VolumeContextMenuProps {
  /** Screen X where the menu should appear */
  x: number;
  /** Screen Y where the menu should appear */
  y: number;
  /** Display name shown in the header */
  displayName: string;
  /** Current volume 0–2 (0%–200%) */
  volume: number;
  /** Called when the slider changes */
  onVolumeChange: (volume: number) => void;
  /** Called when the menu should close */
  onClose: () => void;
}

export default function VolumeContextMenu({
  x,
  y,
  displayName,
  volume,
  onVolumeChange,
  onClose,
}: VolumeContextMenuProps) {
  const { palette, spacing, typography } = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(menuRef);

  // Close on click-outside or Escape
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Use a timeout so the opening right-click doesn't immediately close it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Clamp position so menu stays on screen
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el = menuRef.current;
    if (rect.right > window.innerWidth) {
      el.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }, [x, y]);

  const pct = Math.round(volume * 100);

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 9999,
        backgroundColor: palette.bgTertiary,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: spacing.unit * 3,
        minWidth: 200,
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        display: "flex",
        flexDirection: "column",
        gap: spacing.unit * 2,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header */}
      <div
        style={{
          fontSize: typography.fontSizeSmall,
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          paddingBottom: spacing.unit,
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        {displayName}
      </div>

      {/* Volume label + icon */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
        }}
      >
        {volume === 0 ? (
          <VolumeX size={14} color={palette.textSecondary} />
        ) : (
          <Volume2 size={14} color={palette.textSecondary} />
        )}
        <span>User Volume</span>
        <span
          style={{
            marginLeft: "auto",
            fontWeight: typography.fontWeightMedium,
            color: palette.textHeading,
            minWidth: 36,
            textAlign: "right",
          }}
        >
          {pct}%
        </span>
      </div>

      {/* Slider */}
      <div style={{ position: "relative", height: 20, display: "flex", alignItems: "center" }}>
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={pct}
          onChange={(e) => onVolumeChange(parseInt(e.target.value, 10) / 100)}
          style={{
            width: "100%",
            height: 6,
            appearance: "none",
            WebkitAppearance: "none",
            background: `linear-gradient(to right, ${palette.accent} 0%, ${palette.accent} ${pct / 2}%, ${palette.bgActive} ${pct / 2}%, ${palette.bgActive} 100%)`,
            borderRadius: 3,
            outline: "none",
            cursor: "pointer",
          }}
        />
        {/* Tick mark at 100% (center) */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: -2,
            transform: "translateX(-50%)",
            width: 2,
            height: 10,
            backgroundColor: palette.textSecondary,
            borderRadius: 1,
            pointerEvents: "none",
            opacity: 0.5,
          }}
        />
      </div>

      {/* Scale labels */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: palette.textSecondary,
          marginTop: -spacing.unit,
        }}
      >
        <span>0%</span>
        <span>100%</span>
        <span>200%</span>
      </div>

      {/* Custom slider thumb style */}
      <style>{`
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: ${palette.textHeading};
          cursor: pointer;
          border: 2px solid ${palette.accent};
          margin-top: 0px;
        }
        input[type="range"]::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: ${palette.textHeading};
          cursor: pointer;
          border: 2px solid ${palette.accent};
        }
      `}</style>
    </div>
  );
}
import { useEffect, useRef, useState } from "react";
import { CheckCheck, Settings, UserPlus, LogOut, Layers, Rss } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

interface RoomContextMenuProps {
  x: number;
  y: number;
  roomName: string;
  onInvite: () => void;
  onOpenSettings: () => void;
  onOpenRssFeeds?: () => void;
  onViewParentSpaces: () => void;
  onLeave: () => void;
  onClose: () => void;
  onClearNotification: () => Promise<void>;
}

export default function RoomContextMenu({
  x,
  y,
  roomName,
  onInvite,
  onOpenSettings,
  onOpenRssFeeds,
  onViewParentSpaces,
  onLeave,
  onClose,
  onClearNotification,
}: RoomContextMenuProps) {
  const { palette, spacing, typography } = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  useOverlayObstruction(menuRef);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
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
  }, [x, y, clearError]);

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
        borderRadius: 6,
        padding: spacing.unit,
        minWidth: 160,
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header: room name */}
      <div
        style={{
          fontSize: typography.fontSizeSmall,
          fontWeight: typography.fontWeightBold,
          color: palette.textSecondary,
          padding: `${spacing.unit}px ${spacing.unit * 2}px`,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {roomName}
      </div>

      {/* Divider */}
      <div
        style={{
          height: 1,
          backgroundColor: palette.border,
          margin: `${spacing.unit}px 0`,
        }}
      />

      <button type="button" disabled={clearing} onClick={() => {
        setClearing(true); setClearError(null);
        void onClearNotification().then(onClose).catch((error) => setClearError(String(error))).finally(() => setClearing(false));
      }} style={{ display: "flex", alignItems: "center", gap: spacing.unit * 2, width: "100%",
        padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`, border: "none", borderRadius: 4,
        backgroundColor: "transparent", color: palette.textPrimary, fontSize: typography.fontSizeSmall,
        cursor: clearing ? "wait" : "pointer", textAlign: "left", opacity: clearing ? 0.6 : 1 }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = palette.bgActive; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}>
        <CheckCheck size={14} color={palette.textSecondary} />
        {clearing ? "Clearing…" : "Clear notification"}
      </button>
      {clearError && <p role="alert" style={{ margin: 0, padding: spacing.unit * 2, maxWidth: 240,
        fontSize: typography.fontSizeSmall, color: palette.textPrimary, overflowWrap: "anywhere" }}>{clearError}</p>}

      <button
        onClick={() => {
          onClose();
          onOpenSettings();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          width: "100%",
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
          border: "none",
          borderRadius: 4,
          backgroundColor: "transparent",
          color: palette.textPrimary,
          fontSize: typography.fontSizeSmall,
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
      >
        <Settings size={14} color={palette.textSecondary} />
        Room Settings
      </button>

      {onOpenRssFeeds && (
        <button type="button" onClick={() => { onOpenRssFeeds(); onClose(); }} style={{
          display: "flex", alignItems: "center", gap: spacing.unit * 2, width: "100%",
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`, border: "none", borderRadius: 4,
          backgroundColor: "transparent", color: palette.textPrimary, fontSize: typography.fontSizeSmall,
          cursor: "pointer", textAlign: "left",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = palette.bgActive; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          <Rss size={14} color={palette.textSecondary} aria-hidden="true" />
          RSS feeds
        </button>
      )}

      <button
        onClick={() => {
          onInvite();
          onClose();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          width: "100%",
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
          border: "none",
          borderRadius: 4,
          backgroundColor: "transparent",
          color: palette.textPrimary,
          fontSize: typography.fontSizeSmall,
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
      >
        <UserPlus size={14} color={palette.textSecondary} />
        Invite people
      </button>

      <button
        onClick={() => {
          onViewParentSpaces();
          onClose();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          width: "100%",
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
          border: "none",
          borderRadius: 4,
          backgroundColor: "transparent",
          color: palette.textPrimary,
          fontSize: typography.fontSizeSmall,
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
      >
        <Layers size={14} color={palette.textSecondary} />
        Parent spaces
      </button>

      <div
        style={{
          height: 1,
          backgroundColor: palette.border,
          margin: `${spacing.unit}px 0`,
        }}
      />

      <button
        type="button"
        onClick={() => {
          onLeave();
          onClose();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          width: "100%",
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
          border: "none",
          borderRadius: 4,
          backgroundColor: "transparent",
          color: "#ed4245",
          fontSize: typography.fontSizeSmall,
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(237, 66, 69, 0.12)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
      >
        <LogOut size={14} color="#ed4245" />
        Leave room
      </button>
    </div>
  );
}

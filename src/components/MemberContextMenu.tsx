import { useEffect, useRef } from "react";
import { Ban, Copy, MessageSquare, User, UserMinus } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

interface MemberContextMenuProps {
  x: number;
  y: number;
  displayName: string;
  userId: string;
  onClose: () => void;
  onProfile: () => void;
  onSendMessage?: () => void;
  /** When set, show kick/ban once loaded (omit while fetching). */
  moderation?: { canKick: boolean; canBan: boolean };
  onKick?: () => void;
  onBan?: () => void;
}

export default function MemberContextMenu({
  x,
  y,
  displayName,
  userId,
  onClose,
  onProfile,
  onSendMessage,
  moderation,
  onKick,
  onBan,
}: MemberContextMenuProps) {
  const { palette, spacing, typography } = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);
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
        {displayName}
      </div>

      <div
        style={{
          height: 1,
          backgroundColor: palette.border,
          margin: `${spacing.unit}px 0`,
        }}
      />

      <button
        type="button"
        onClick={() => onProfile()}
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
        <User size={14} color={palette.textSecondary} />
        Profile
      </button>

      {onSendMessage && (
        <button
          type="button"
          onClick={() => onSendMessage()}
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
          <MessageSquare size={14} color={palette.textSecondary} />
          Send message
        </button>
      )}

      {moderation && (moderation.canKick || moderation.canBan) && (
        <>
          <div
            style={{
              height: 1,
              backgroundColor: palette.border,
              margin: `${spacing.unit}px 0`,
            }}
          />
          {moderation.canKick && onKick && (
            <button
              type="button"
              onClick={() => onKick()}
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
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
              }}
            >
              <UserMinus size={14} color="#ed4245" />
              Kick user
            </button>
          )}
          {moderation.canBan && onBan && (
            <button
              type="button"
              onClick={() => onBan()}
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
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
              }}
            >
              <Ban size={14} color="#ed4245" />
              Ban user
            </button>
          )}
        </>
      )}

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
          void navigator.clipboard.writeText(userId);
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
        <Copy size={14} color={palette.textSecondary} />
        Copy user ID
      </button>
    </div>
  );
}

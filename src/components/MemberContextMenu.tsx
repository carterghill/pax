import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Copy, MessageSquare, User, UserMinus, VolumeX } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";

interface MemberContextMenuProps {
  x: number;
  y: number;
  displayName: string;
  userId: string;
  currentUserId: string;
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
  currentUserId,
  onClose,
  onProfile,
  onSendMessage,
  moderation,
  onKick,
  onBan,
}: MemberContextMenuProps) {
  const { palette, spacing, typography } = useTheme();
  const { userIds, setIgnored } = useIgnoredUsers();
  const isIgnored = userIds.has(userId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(menuRef);

  async function toggleIgnored() {
    setSaving(true);
    setError(null);
    try {
      await setIgnored(userId, !isIgnored);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }

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

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  }, [x, y, error, moderation, isIgnored]);

  return createPortal(
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
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
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

      {userId !== currentUserId && (
        <>
          <button
            type="button"
            disabled={saving}
            onClick={() => void toggleIgnored()}
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
              cursor: saving ? "wait" : "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = palette.bgActive; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <VolumeX size={14} color={palette.textSecondary} />
            {isIgnored ? "Unignore user" : "Ignore user"}
          </button>
          {error && (
            <div role="alert" style={{
              maxWidth: 240,
              padding: spacing.unit * 2,
              color: palette.textSecondary,
              fontSize: typography.fontSizeSmall,
            }}>
              {isIgnored ? "Couldn’t unignore user." : "Couldn’t ignore user."} {error}
            </div>
          )}
        </>
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
    </div>,
    document.body,
  );
}

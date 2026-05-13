import { createPortal } from "react-dom";
import { Pencil, Pin, Trash2 } from "lucide-react";
import type { useTheme } from "../../../theme/ThemeContext";
import type { PopoverFixedPos } from "./useActionBarPopover";

interface MessageActionMenuProps {
  menuPortalRef: React.RefObject<HTMLDivElement | null>;
  menuFixedPos: PopoverFixedPos;
  zIndex: number;
  canEdit: boolean;
  canPin: boolean;
  isPinned: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onDelete: () => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
  resolvedColorScheme: string;
}

export default function MessageActionMenu({
  menuPortalRef,
  menuFixedPos,
  zIndex,
  canEdit,
  canPin,
  isPinned,
  canDelete,
  onEdit,
  onPin,
  onUnpin,
  onDelete,
  palette,
  typography,
  spacing,
  resolvedColorScheme,
}: MessageActionMenuProps) {
  const itemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: spacing.unit * 2.5,
    width: "100%",
    padding: `${spacing.unit * 2.25}px ${spacing.unit * 3}px`,
    border: "none",
    borderRadius: spacing.unit * 1.25,
    backgroundColor: "transparent",
    color: palette.textPrimary,
    fontSize: typography.fontSizeBase,
    fontFamily: typography.fontFamily,
    fontWeight: typography.fontWeightNormal,
    cursor: "pointer",
    textAlign: "left",
  };

  const onEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.backgroundColor = palette.bgHover;
    e.currentTarget.style.color = palette.textHeading;
  };
  const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.backgroundColor = "transparent";
    e.currentTarget.style.color = palette.textPrimary;
  };

  return createPortal(
    <div
      ref={menuPortalRef}
      data-message-actions-root
      role="menu"
      aria-label="Message actions"
      style={{
        position: "fixed",
        top: menuFixedPos.top ?? undefined,
        bottom: menuFixedPos.bottom ?? undefined,
        right: menuFixedPos.right,
        zIndex,
        minWidth: spacing.unit * 40,
        maxHeight: `calc(100vh - ${Math.max(8, spacing.unit * 2) * 2}px)`,
        overflowX: "hidden",
        overflowY: "auto",
        padding: spacing.unit * 1.5,
        display: "flex",
        flexDirection: "column",
        gap: spacing.unit * 0.5,
        backgroundColor: palette.bgTertiary,
        border: `1px solid ${palette.border}`,
        borderRadius: spacing.unit * 2,
        boxShadow:
          resolvedColorScheme === "light"
            ? "0 8px 24px rgba(0,0,0,0.12)"
            : "0 10px 36px rgba(0,0,0,0.45)",
      }}
    >
      {canEdit && (
        <button
          type="button"
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onEdit}
          style={itemStyle}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <Pencil size={20} strokeWidth={2} color="currentColor" />
          Edit
        </button>
      )}
      {canPin && !isPinned && (
        <button
          type="button"
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onPin}
          style={itemStyle}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <Pin size={20} strokeWidth={2} color="currentColor" />
          Pin message
        </button>
      )}
      {canPin && isPinned && (
        <button
          type="button"
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onUnpin}
          style={itemStyle}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <Pin size={20} strokeWidth={2} color="currentColor" />
          Unpin message
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDelete}
          style={itemStyle}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <Trash2 size={20} strokeWidth={2} color="currentColor" />
          Delete
        </button>
      )}
    </div>,
    document.body,
  );
}

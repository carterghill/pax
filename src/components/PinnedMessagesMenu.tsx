import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Pin } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { PinnedMessagePreview } from "../types/matrix";

const MENU_Z = 10_000;

interface PinnedMessagesMenuProps {
  roomId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectEventId: (eventId: string) => void;
}

export default function PinnedMessagesMenu({
  roomId,
  open,
  onOpenChange,
  onSelectEventId,
}: PinnedMessagesMenuProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<PinnedMessagePreview[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await invoke<PinnedMessagePreview[]>("get_pinned_message_previews", {
        roomId,
      });
      setItems(rows);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const btn = anchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({
        top: r.bottom + spacing.unit,
        right: window.innerWidth - r.right,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, spacing.unit]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-pinned-menu-root]")) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-pinned-menu-root
        title="Pinned messages"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange(!open)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: spacing.unit,
          borderRadius: spacing.unit,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: open ? palette.textHeading : palette.textSecondary,
        }}
      >
        <Pin size={20} strokeWidth={open ? 2.5 : 2} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            data-pinned-menu-root
            role="menu"
            aria-label="Pinned messages"
            style={{
              position: "fixed",
              top: pos.top,
              right: pos.right,
              zIndex: MENU_Z,
              minWidth: spacing.unit * 44,
              maxWidth: spacing.unit * 70,
              maxHeight: "min(50vh, 360px)",
              overflowY: "auto",
              padding: spacing.unit * 1.5,
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit * 0.5,
              backgroundColor: palette.bgSecondary,
              border: `1px solid ${palette.border}`,
              borderRadius: spacing.unit * 2,
              boxShadow:
                resolvedColorScheme === "light"
                  ? "0 8px 24px rgba(0,0,0,0.12)"
                  : "0 10px 36px rgba(0,0,0,0.45)",
            }}
          >
            {loading ? (
              <div
                style={{
                  padding: spacing.unit * 2,
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                }}
              >
                Loading…
              </div>
            ) : items.length === 0 ? (
              <div
                style={{
                  padding: spacing.unit * 2,
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                }}
              >
                No pinned messages
              </div>
            ) : (
              items.map((row) => (
                <button
                  key={row.eventId}
                  type="button"
                  role="menuitem"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onOpenChange(false);
                    onSelectEventId(row.eventId);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                    border: "none",
                    borderRadius: spacing.unit * 1.25,
                    backgroundColor: "transparent",
                    color: palette.textPrimary,
                    fontSize: typography.fontSizeSmall,
                    fontFamily: typography.fontFamily,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = palette.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <div
                    style={{
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textHeading,
                      marginBottom: spacing.unit * 0.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.sender || "Unknown"}
                  </div>
                  <div
                    style={{
                      color: palette.textSecondary,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      lineHeight: 1.35,
                    }}
                  >
                    {row.preview}
                  </div>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

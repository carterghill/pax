import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Message, RoomRedactionPolicy } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import MessageMarkdown from "./MessageMarkdown";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  initialLoading: boolean;
  refreshing?: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  roomId: string;
  userId: string;
  redactionPolicy: RoomRedactionPolicy;
  onRequestEdit: (msg: Message) => void;
  onMessagesMutated: () => void;
  onMessageRemoved: (eventId: string) => void;
}

const NON_EDITABLE_BODIES = new Set([
  "[Image]",
  "[File]",
  "[Video]",
  "[Audio]",
  "[Unsupported message]",
]);

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today at ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;

  return `${date.toLocaleDateString()} ${time}`;
}

function shouldShowHeader(msg: Message, prevMsg: Message | null): boolean {
  if (!prevMsg) return true;
  if (prevMsg.sender !== msg.sender) return true;
  if (msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000) return true;
  return false;
}

function messageAllowsEdit(msg: Message, userId: string): boolean {
  if (msg.sender !== userId) return false;
  return !NON_EDITABLE_BODIES.has(msg.body.trim());
}

function messageAllowsDelete(msg: Message, userId: string, policy: RoomRedactionPolicy): boolean {
  if (msg.sender === userId) return policy.canRedactOwn;
  return policy.canRedactOther;
}

/** Portaled to document.body — high z-index keeps the menu above everything. */
const MESSAGE_ACTIONS_MENU_Z = 10_000;

/** Matrix event IDs contain `$`, `:`, etc.; `querySelector`/`CSS.escape` attribute selectors break on those. */
function findMessageRow(container: HTMLElement, eventId: string): HTMLElement | null {
  for (const el of container.querySelectorAll("[data-message-event-id]")) {
    if (el.getAttribute("data-message-event-id") === eventId) return el as HTMLElement;
  }
  return null;
}

export default function MessageList({
  messages,
  loading,
  initialLoading,
  refreshing = false,
  hasMore,
  onLoadMore,
  roomId,
  userId,
  redactionPolicy,
  onRequestEdit,
  onMessagesMutated,
  onMessageRemoved,
}: MessageListProps) {
  const { palette, typography, spacing, name: themeName } = useTheme();
  const AUTO_SCROLL_THRESHOLD_PX = 120;
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  /**
   * Prepend scroll restore: capture scroll metrics only after `loading` is true so the snapshot
   * includes the "Loading..." row; otherwise the banner swap when fetch finishes skews the delta.
   */
  const prependScrollAnchorRef = useRef<
    | { phase: "pending"; firstEventId: string | undefined }
    | {
        phase: "captured";
        scrollHeight: number;
        scrollTop: number;
        firstEventId: string | undefined;
        /** Distance from scroll container top edge to anchor row top (visual, matches what the user sees). */
        anchorViewportTop: number | null;
      }
    | null
  >(null);
  const prevLoadingRef = useRef(loading);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [openMenuEventId, setOpenMenuEventId] = useState<string | null>(null);
  const [menuFixedPos, setMenuFixedPos] = useState<{ top: number; right: number } | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  function isNearBottom(): boolean {
    const container = containerRef.current;
    if (!container) return true;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
  }

  useLayoutEffect(() => {
    prependScrollAnchorRef.current = null;
  }, [roomId]);

  useLayoutEffect(() => {
    if (prevLoadingRef.current && !loading && prependScrollAnchorRef.current) {
      const s = prependScrollAnchorRef.current;
      if (messages[0]?.eventId === s.firstEventId) {
        prependScrollAnchorRef.current = null;
      }
    }
    prevLoadingRef.current = loading;
  }, [loading, messages[0]?.eventId, roomId]);

  // Record scrollHeight/scrollTop once the loading banner is in the DOM (not before).
  useLayoutEffect(() => {
    const container = containerRef.current;
    const ref = prependScrollAnchorRef.current;
    if (!container || !ref || ref.phase !== "pending" || !loading) return;
    if (messages[0]?.eventId !== ref.firstEventId) return;

    let anchorViewportTop: number | null = null;
    if (ref.firstEventId) {
      const anchorEl = findMessageRow(container, ref.firstEventId);
      if (anchorEl) {
        const cr = container.getBoundingClientRect();
        const ar = anchorEl.getBoundingClientRect();
        anchorViewportTop = ar.top - cr.top;
      }
    }

    prependScrollAnchorRef.current = {
      phase: "captured",
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      firstEventId: ref.firstEventId,
      anchorViewportTop,
    };
  }, [loading, messages.length, messages[0]?.eventId]);

  // Prepend: keep the same messages in view (adjust scrollTop by height added above).
  // Otherwise scrollTop stays fixed and the list appears to jump.
  // Scroll to bottom before paint so the user never sees the top-first flash.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const snap = prependScrollAnchorRef.current;
    const prepended =
      snap !== null &&
      snap.phase === "captured" &&
      messages[0]?.eventId !== undefined &&
      messages[0].eventId !== snap.firstEventId;
    if (prepended && snap) {
      const {
        scrollHeight: prevScrollHeight,
        scrollTop: prevScrollTop,
        firstEventId: anchorEventId,
        anchorViewportTop,
      } = snap;
      prependScrollAnchorRef.current = null;

      const alignAnchorToSavedViewport = (el: HTMLElement) => {
        if (anchorEventId && anchorViewportTop != null) {
          const anchorEl = findMessageRow(el, anchorEventId);
          if (anchorEl) {
            const cr = el.getBoundingClientRect();
            const ar = anchorEl.getBoundingClientRect();
            const cur = ar.top - cr.top;
            // Increasing scrollTop moves content up → (ar.top - cr.top) decreases by ~the same amount.
            // We want cur → anchorViewportTop, so ΔscrollTop = cur - anchorViewportTop (not the reverse).
            el.scrollTop += cur - anchorViewportTop;
            return;
          }
        }
        const delta = el.scrollHeight - prevScrollHeight;
        el.scrollTop = prevScrollTop + delta;
      };

      alignAnchorToSavedViewport(container);
    }

    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView();
    }
  }, [messages.length, messages[0]?.eventId]);

  // When the container shrinks (input grew, format menu opened), keep bottom anchored.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let prevHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h < prevHeight && shouldAutoScrollRef.current) {
        bottomRef.current?.scrollIntoView();
      }
      prevHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!openMenuEventId) return;
    const onDocDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-message-actions-root]")) return;
      setOpenMenuEventId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuEventId(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuEventId]);

  useLayoutEffect(() => {
    if (!openMenuEventId) {
      setMenuFixedPos(null);
      return;
    }

    const update = () => {
      const btn = menuAnchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setMenuFixedPos({
        top: r.bottom + spacing.unit,
        right: window.innerWidth - r.right,
      });
    };

    update();
    const ro = new ResizeObserver(update);
    if (menuAnchorRef.current) ro.observe(menuAnchorRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const cont = containerRef.current;
    cont?.addEventListener("scroll", update, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      cont?.removeEventListener("scroll", update);
    };
  }, [openMenuEventId, spacing.unit]);

  const openMenuMsg =
    openMenuEventId === null ? undefined : messages.find((m) => m.eventId === openMenuEventId);

  function handleScroll() {
    if (!containerRef.current) return;

    shouldAutoScrollRef.current = isNearBottom();

    if (loading || !hasMore) return;
    if (containerRef.current.scrollTop < 100) {
      prependScrollAnchorRef.current = {
        phase: "pending",
        firstEventId: messages[0]?.eventId,
      };
      onLoadMore();
    }
  }

  if (initialLoading) {
    return (
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: palette.textSecondary,
      }}>
        Loading messages...
      </div>
    );
  }

  const rowHighlight =
    themeName === "light" ? "rgba(0, 0, 0, 0.055)" : "rgba(255, 255, 255, 0.06)";

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        paddingTop: spacing.unit * 6,
        paddingBottom: spacing.unit * 4,
        paddingLeft: 0,
        paddingRight: 0,
      }}
    >
      {hasMore && (
        <div
          style={{
            boxSizing: "border-box",
            minHeight: spacing.unit * 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: spacing.unit * 2,
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
            lineHeight: typography.lineHeight,
          }}
        >
          {loading ? "Loading..." : "Scroll up for more"}
        </div>
      )}

      {messages.map((msg, i) => {
        const showHeader = shouldShowHeader(msg, messages[i - 1] ?? null);
        const canEdit = messageAllowsEdit(msg, userId);
        const canDelete = messageAllowsDelete(msg, userId, redactionPolicy);
        const showMessageActions = canEdit || canDelete;
        const rowActive =
          hoveredEventId === msg.eventId || openMenuEventId === msg.eventId;
        const menuOpen = openMenuEventId === msg.eventId;

        const menuBtn = spacing.unit * 7;

        return (
          <div
            key={msg.eventId}
            data-message-event-id={msg.eventId}
            onMouseEnter={() => setHoveredEventId(msg.eventId)}
            onMouseLeave={() => {
              if (openMenuEventId !== msg.eventId) {
                setHoveredEventId((h) => (h === msg.eventId ? null : h));
              }
            }}
            style={{
              position: "relative",
              ...(showHeader
                ? {
                    paddingTop: spacing.unit * 3,
                    paddingRight: spacing.unit * 2,
                    paddingBottom: spacing.unit,
                    paddingLeft: spacing.unit * 4,
                  }
                : {
                    paddingTop: spacing.unit / 2,
                    paddingRight: spacing.unit * 2,
                    paddingBottom: spacing.unit / 2,
                    paddingLeft: spacing.unit * 4,
                  }),
              display: "flex",
              gap: spacing.unit * 3,
              marginTop: showHeader ? spacing.unit : 0,
              borderRadius: spacing.unit * 1.5,
              backgroundColor: rowActive ? rowHighlight : "transparent",
              transition: "background-color 0.12s ease",
            }}
          >
            <div style={{ width: 40, flexShrink: 0 }}>
              {showHeader && (
                msg.avatarUrl ? (
                  <img
                    src={msg.avatarUrl}
                    alt={msg.senderName ?? msg.sender}
                    style={{
                      display: "block",
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    backgroundColor: palette.accent,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: typography.fontSizeBase,
                    fontWeight: typography.fontWeightBold,
                  }}>
                    {(msg.senderName ?? msg.sender).charAt(0).toUpperCase()}
                  </div>
                )
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              {showHeader && (
                <div style={{ display: "flex", alignItems: "baseline", gap: spacing.unit * 2 }}>
                  <span style={{
                    fontWeight: typography.fontWeightMedium,
                    color: palette.textHeading,
                    fontSize: typography.fontSizeBase,
                  }}>
                    {msg.senderName ?? msg.sender}
                  </span>
                  <span style={{
                    fontSize: typography.fontSizeSmall,
                    color: palette.textSecondary,
                  }}>
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
              )}
              <MessageMarkdown edited={Boolean(msg.edited)}>{msg.body}</MessageMarkdown>
            </div>

            {showMessageActions && rowActive && (
              <div
                data-message-actions-root
                style={{
                  position: "absolute",
                  top: 0,
                  right: spacing.unit * 2,
                  transform: "translateY(-50%)",
                  zIndex: 2,
                }}
              >
                <button
                  ref={menuOpen ? menuAnchorRef : undefined}
                  type="button"
                  title="Message actions"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setOpenMenuEventId((id) => (id === msg.eventId ? null : msg.eventId))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: menuBtn,
                    height: menuBtn,
                    padding: 0,
                    border: `1px solid ${rowActive ? palette.border : "transparent"}`,
                    borderRadius: spacing.unit * 1.25,
                    backgroundColor: menuOpen ? palette.bgHover : palette.bgTertiary,
                    color: palette.textSecondary,
                    cursor: "pointer",
                    boxShadow:
                      themeName === "light"
                        ? "0 1px 3px rgba(0,0,0,0.08)"
                        : "0 2px 8px rgba(0,0,0,0.35)",
                  }}
                >
                  <MoreVertical size={18} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {openMenuMsg &&
        menuFixedPos &&
        createPortal(
          <div
            data-message-actions-root
            role="menu"
            aria-label="Message actions"
            style={{
              position: "fixed",
              top: menuFixedPos.top,
              right: menuFixedPos.right,
              zIndex: MESSAGE_ACTIONS_MENU_Z,
              minWidth: spacing.unit * 40,
              padding: spacing.unit * 1.5,
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit * 0.5,
              backgroundColor: palette.bgSecondary,
              border: `1px solid ${palette.border}`,
              borderRadius: spacing.unit * 2,
              boxShadow:
                themeName === "light"
                  ? "0 8px 24px rgba(0,0,0,0.12)"
                  : "0 10px 36px rgba(0,0,0,0.45)",
            }}
          >
            {messageAllowsEdit(openMenuMsg, userId) && (
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpenMenuEventId(null);
                  onRequestEdit(openMenuMsg);
                }}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = palette.bgHover;
                  e.currentTarget.style.color = palette.textHeading;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = palette.textPrimary;
                }}
              >
                <Pencil size={20} strokeWidth={2} color="currentColor" />
                Edit
              </button>
            )}
            {messageAllowsDelete(openMenuMsg, userId, redactionPolicy) && (
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={async () => {
                  setOpenMenuEventId(null);
                  if (!window.confirm("Delete this message?")) return;
                  try {
                    await invoke("redact_message", {
                      roomId,
                      eventId: openMenuMsg.eventId,
                    });
                    onMessageRemoved(openMenuMsg.eventId);
                    onMessagesMutated();
                  } catch (e) {
                    console.error("Failed to delete message:", e);
                  }
                }}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = palette.bgHover;
                  e.currentTarget.style.color = palette.textHeading;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = palette.textPrimary;
                }}
              >
                <Trash2 size={20} strokeWidth={2} color="currentColor" />
                Delete
              </button>
            )}
          </div>,
          document.body,
        )}

      {refreshing && (
        <div style={{
          display: "flex",
          justifyContent: "center",
          padding: spacing.unit * 3,
        }}>
          <div style={{
            width: 20,
            height: 20,
            border: `2px solid ${palette.border}`,
            borderTopColor: palette.accent,
            borderRadius: "50%",
            animation: "messageListSpinner 0.8s linear infinite",
          }} />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
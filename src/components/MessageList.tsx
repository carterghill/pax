import { useEffect, useRef, useState } from "react";
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
}: MessageListProps) {
  const { palette, typography, spacing, name: themeName } = useTheme();
  const AUTO_SCROLL_THRESHOLD_PX = 120;
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [openMenuEventId, setOpenMenuEventId] = useState<string | null>(null);

  function isNearBottom(): boolean {
    const container = containerRef.current;
    if (!container) return true;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
  }

  useEffect(() => {
    if (!containerRef.current) return;
    if (initialLoading || shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView();
    }
  }, [messages.length, initialLoading]);

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

  function handleScroll() {
    if (!containerRef.current) return;

    shouldAutoScrollRef.current = isNearBottom();

    if (loading || !hasMore) return;
    if (containerRef.current.scrollTop < 100) {
      onLoadMore();
    }
  }

  if (initialLoading) {
    return (
      <div style={{
        flex: 1,
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
        overflowY: "auto",
        padding: `${spacing.unit * 4}px 0`,
      }}
    >
      {hasMore && (
        <div style={{
          textAlign: "center",
          padding: spacing.unit * 2,
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
        }}>
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

        return (
          <div
            key={msg.eventId}
            onMouseEnter={() => setHoveredEventId(msg.eventId)}
            onMouseLeave={() => {
              if (openMenuEventId !== msg.eventId) {
                setHoveredEventId((h) => (h === msg.eventId ? null : h));
              }
            }}
            style={{
              padding: showHeader
                ? `${spacing.unit * 3}px ${spacing.unit * 4}px ${spacing.unit}px`
                : `${spacing.unit / 2}px ${spacing.unit * 4}px`,
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

            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
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
              <div style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "flex-start",
                gap: spacing.unit,
                minWidth: 0,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <MessageMarkdown>{msg.body}</MessageMarkdown>
                </div>
                {showMessageActions && rowActive && (
                  <div
                    data-message-actions-root
                    style={{ flexShrink: 0, position: "relative", marginTop: showHeader ? 0 : 1 }}
                  >
                    <button
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
                        width: spacing.unit * 7,
                        height: spacing.unit * 7,
                        padding: 0,
                        border: "none",
                        borderRadius: spacing.unit,
                        backgroundColor: menuOpen ? palette.bgHover : "transparent",
                        color: palette.textSecondary,
                        cursor: "pointer",
                      }}
                    >
                      <MoreVertical size={18} strokeWidth={2} />
                    </button>
                    {menuOpen && (
                      <div
                        role="menu"
                        aria-label="Message actions"
                        style={{
                          position: "absolute",
                          top: "100%",
                          right: 0,
                          marginTop: spacing.unit,
                          minWidth: spacing.unit * 32,
                          padding: spacing.unit,
                          backgroundColor: palette.bgTertiary,
                          border: `1px solid ${palette.border}`,
                          borderRadius: spacing.unit * 1.5,
                          boxShadow:
                            themeName === "light"
                              ? "0 8px 24px rgba(0,0,0,0.12)"
                              : "0 10px 36px rgba(0,0,0,0.45)",
                          zIndex: 5,
                        }}
                      >
                        {canEdit && (
                          <button
                            type="button"
                            role="menuitem"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setOpenMenuEventId(null);
                              onRequestEdit(msg);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: spacing.unit * 2,
                              width: "100%",
                              padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                              border: "none",
                              borderRadius: spacing.unit,
                              background: "none",
                              color: palette.textPrimary,
                              fontSize: typography.fontSizeSmall,
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <Pencil size={16} strokeWidth={2} />
                            Edit
                          </button>
                        )}
                        {canDelete && (
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
                                  eventId: msg.eventId,
                                });
                                onMessagesMutated();
                              } catch (e) {
                                console.error("Failed to delete message:", e);
                              }
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: spacing.unit * 2,
                              width: "100%",
                              padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                              border: "none",
                              borderRadius: spacing.unit,
                              background: "none",
                              color: palette.textPrimary,
                              fontSize: typography.fontSizeSmall,
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <Trash2 size={16} strokeWidth={2} />
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

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

      <style>{`
        @keyframes messageListSpinner {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div ref={bottomRef} />
    </div>
  );
}

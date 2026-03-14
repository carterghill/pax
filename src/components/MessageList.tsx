import { useRef, useEffect } from "react";
import { Message } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  initialLoading: boolean;
  refreshing?: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

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

// Should we show a full header for this message or just the body?
function shouldShowHeader(msg: Message, prevMsg: Message | null): boolean {
  if (!prevMsg) return true;
  if (prevMsg.sender !== msg.sender) return true;
  // Group messages within 5 minutes from the same sender
  if (msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000) return true;
  return false;
}

export default function MessageList({
  messages,
  loading,
  initialLoading,
  refreshing = false,
  hasMore,
  onLoadMore,
}: MessageListProps) {
  const { palette, typography, spacing } = useTheme();
  const AUTO_SCROLL_THRESHOLD_PX = 120;
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  function isNearBottom(): boolean {
    const container = containerRef.current;
    if (!container) return true;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
  }

  // Scroll to bottom on initial load or if the user was already near bottom.
  useEffect(() => {
    if (!containerRef.current) return;
    if (initialLoading || shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView();
    }
  }, [messages.length, initialLoading]);

  // Handle scroll to top for loading more
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
        return (
          <div
            key={msg.eventId}
            style={{
              padding: showHeader
                ? `${spacing.unit * 3}px ${spacing.unit * 4}px ${spacing.unit}px`
                : `${spacing.unit / 2}px ${spacing.unit * 4}px`,
              display: "flex",
              gap: spacing.unit * 3,
              marginTop: showHeader ? spacing.unit : 0,
            }}
          >
            {/* Avatar column */}
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

            {/* Message content */}
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
              <div style={{
                color: palette.textPrimary,
                fontSize: typography.fontSizeBase,
                lineHeight: typography.lineHeight,
                wordBreak: "break-word",
              }}>
                {msg.body}
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
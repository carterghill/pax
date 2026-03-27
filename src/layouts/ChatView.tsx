import { useState, useEffect, useRef, useCallback } from "react";
import { useRoomRedactionPolicy } from "../hooks/useRoomRedactionPolicy";
import { listen } from "@tauri-apps/api/event";
import { Hash, Users } from "lucide-react";
import MessageList from "../components/MessageList";
import MessageInput, { type EditingMessageRef } from "../components/MessageInput";
import UserMenu from "../components/UserMenu";
import { useMessages } from "../hooks/useMessages";
import { useTheme } from "../theme/ThemeContext";
import { Message, Room } from "../types/matrix";
import { useResizeHandle } from "../hooks/useResizeHandle";

const USER_MENU_DEFAULT_WIDTH = 240;
const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;

interface ChatViewProps {
  room: Room;
  userId: string;
  userMenuWidth: number;
  onUserMenuWidthChange: (width: number) => void;
}

interface TypingPayload {
  roomId: string;
  userIds: string[];
  displayNames: string[];
}

function TypingIndicator({
  names,
  localTyping,
}: {
  names: string[];
  /** True while this client is sending typing=true to the homeserver. */
  localTyping?: boolean;
}) {
  const { palette, typography, spacing } = useTheme();
  if (!localTyping && names.length === 0) return null;

  const ordered = localTyping ? ["You", ...names] : [...names];
  let text: string;
  if (ordered.length === 1) {
    text = ordered[0] === "You" ? "You are typing" : `${ordered[0]} is typing`;
  } else if (ordered.length === 2) {
    text = `${ordered[0]} and ${ordered[1]} are typing`;
  } else {
    text = `${ordered[0]} and ${ordered.length - 1} others are typing`;
  }

  const bg = palette.bgPrimary;
  const fadePadTop = spacing.unit * 6;
  const fadePadBottom = spacing.unit * 2;
  const fadePadX = spacing.unit * 3;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "100%",
        zIndex: 2,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          paddingTop: fadePadTop,
          paddingBottom: fadePadBottom,
          paddingLeft: fadePadX,
          paddingRight: fadePadX,
          backgroundImage: `linear-gradient(to bottom, transparent 0%, ${bg} 72%, ${bg} 100%)`,
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
          display: "flex",
          alignItems: "center",
          gap: spacing.unit,
          minHeight: spacing.unit * 5,
        }}
      >
        <span style={{ display: "inline-flex", gap: 2 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                backgroundColor: palette.textSecondary,
                animation: `typingDot 1.4s infinite`,
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </span>
        <span>{text}</span>
        <style>{`
          @keyframes typingDot {
            0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
            30% { opacity: 1; transform: translateY(-2px); }
          }
        `}</style>
      </div>
    </div>
  );
}

export default function ChatView({
  room,
  userId,
  userMenuWidth,
  onUserMenuWidthChange,
}: ChatViewProps) {
  const {
    messages,
    loadMore,
    hasMore,
    loading,
    initialLoading,
    refreshing,
    refresh,
    removeMessageById,
  } = useMessages(room.id);
  const redactionPolicy = useRoomRedactionPolicy(room.id);
  const { palette, typography, spacing } = useTheme();
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [localTyping, setLocalTyping] = useState(false);
  const [showUsers, setShowUsers] = useState(true);
  const [editingMessage, setEditingMessage] = useState<EditingMessageRef | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const userMenuResize = useResizeHandle({
    width: userMenuWidth,
    onWidthChange: onUserMenuWidthChange,
    min: MIN_USER_MENU_WIDTH,
    max: () => Math.min(MAX_USER_MENU_WIDTH, (containerRef.current?.offsetWidth ?? 600) - 200 - 6),
    direction: -1,
  });

  // Listen for typing events in this room
  useEffect(() => {
    const unlisten = listen<TypingPayload>("typing", (event) => {
      const { roomId, displayNames, userIds } = event.payload;
      if (roomId !== room.id) return;
      const filtered = displayNames.filter((_, i) => userIds[i] !== userId);
      setTypingNames(filtered);
    });

    // Clear typing when switching rooms
    setTypingNames([]);
    setLocalTyping(false);

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room.id, userId]);

  useEffect(() => {
    setEditingMessage(null);
  }, [room.id]);

  const handleRequestEdit = useCallback((msg: Message) => {
    setEditingMessage({ eventId: msg.eventId, body: msg.body });
  }, []);

  return (
    <div ref={containerRef} style={{
      flex: 1,
      minHeight: 0,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      minWidth: 0,
      overflow: "hidden",
    }}>
      {/* Channel header */}
      <div style={{
        padding: `0 ${spacing.unit * 4}px`,
        height: spacing.headerHeight,
        borderBottom: `1px solid ${palette.border}`,
        display: "flex",
        position: "relative",
        alignItems: "center",
        gap: spacing.unit * 3,
        boxSizing: "border-box",
        minWidth: 0,
      }}>
        <Hash size={20} color={palette.textSecondary} style={{ flexShrink: 0 }} />
        <span style={{
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          fontSize: typography.fontSizeBase,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          paddingRight: spacing.unit * 8,
        }}>
          {room.name}
        </span>
        <button
          onClick={() => setShowUsers((prev) => !prev)}
          title="Toggle member list"
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
            position: "absolute",
            right: spacing.unit * 2,
          }}
        >
          <Users
            size={20}
            color={showUsers ? palette.textHeading : palette.textSecondary}
            fontWeight={showUsers ? typography.fontWeightBold : typography.fontWeightNormal}
          />
        </button>
      </div>

      {/* Content area: messages + optional user menu */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        overflow: "hidden",
      }}>
        {/* Messages column */}
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          backgroundColor: palette.bgPrimary,
        }}>
          <MessageList
            messages={messages}
            loading={loading}
            initialLoading={initialLoading}
            refreshing={refreshing}
            hasMore={hasMore}
            onLoadMore={loadMore}
            roomId={room.id}
            userId={userId}
            redactionPolicy={redactionPolicy}
            onRequestEdit={handleRequestEdit}
            onMessagesMutated={refresh}
            onMessageRemoved={removeMessageById}
          />

          <div style={{ position: "relative", flexShrink: 0, zIndex: 1 }}>
            <TypingIndicator
              names={typingNames}
              localTyping={localTyping}
            />
            <MessageInput
              key={room.id}
              roomId={room.id}
              roomName={room.name}
              onMessageSent={refresh}
              editingMessage={editingMessage}
              onCancelEdit={() => setEditingMessage(null)}
              onLocalTypingActive={setLocalTyping}
            />
          </div>
        </div>

        {/* User menu panel with resizable inside border */}
        {showUsers && (
          <>
            <div
              onMouseDown={userMenuResize.onMouseDown}
              onDoubleClick={() => onUserMenuWidthChange(USER_MENU_DEFAULT_WIDTH)}
              onMouseEnter={() => userMenuResize.setIsHovered(true)}
              onMouseLeave={() => userMenuResize.setIsHovered(false)}
              style={{
                width: 6,
                flexShrink: 0,
                cursor: "col-resize",
                backgroundColor: userMenuResize.isHovered ? palette.border : "transparent",
                transition: "background-color 0.15s",
              }}
              title="Drag to resize, double-click to reset"
            />
            <UserMenu width={userMenuWidth} roomId={room.id} userId={userId} />
          </>
        )}
      </div>
    </div>
  );
}
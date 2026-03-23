import { useState, useEffect, useCallback, useRef } from "react";
import { useRoomRedactionPolicy } from "../hooks/useRoomRedactionPolicy";
import { listen } from "@tauri-apps/api/event";
import { Hash, Users } from "lucide-react";
import MessageList from "../components/MessageList";
import MessageInput, { type EditingMessageRef } from "../components/MessageInput";
import UserMenu from "../components/UserMenu";
import { useMessages } from "../hooks/useMessages";
import { useTheme } from "../theme/ThemeContext";
import { Message, Room } from "../types/matrix";

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

function TypingIndicator({ names }: { names: string[] }) {
  const { palette, typography, spacing } = useTheme();
  if (names.length === 0) return null;

  let text: string;
  if (names.length === 1) {
    text = `${names[0]} is typing`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing`;
  } else {
    text = `${names[0]} and ${names.length - 1} others are typing`;
  }

  return (
    <div style={{
      padding: `${spacing.unit}px ${spacing.unit * 3}px`,
      fontSize: typography.fontSizeSmall,
      color: palette.textSecondary,
      display: "flex",
      alignItems: "center",
      gap: spacing.unit,
      minHeight: spacing.unit * 5,
    }}>
      {/* Animated dots */}
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
  const [showUsers, setShowUsers] = useState(true);
  const [editingMessage, setEditingMessage] = useState<EditingMessageRef | null>(null);

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isUserMenuResizeHovered, setIsUserMenuResizeHovered] = useState(false);

  const handleUserMenuResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = userMenuWidth;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startXRef.current;
      // Clamp so the chat column never goes below ~200px
      const containerW = containerRef.current?.offsetWidth ?? 600;
      const maxW = Math.min(MAX_USER_MENU_WIDTH, containerW - 200 - 6); // 6 = handle
      const next = Math.max(MIN_USER_MENU_WIDTH, Math.min(maxW, startWidthRef.current - dx));
      onUserMenuWidthChange(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [userMenuWidth, onUserMenuWidthChange]);

  // Listen for typing events in this room
  useEffect(() => {
    const unlisten = listen<TypingPayload>("typing", (event) => {
      const { roomId, displayNames } = event.payload;
      if (roomId !== room.id) return;
      setTypingNames(displayNames);
    });

    // Clear typing when switching rooms
    setTypingNames([]);

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room.id]);

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

          <TypingIndicator
            names={typingNames}
          />
          <MessageInput
            key={room.id}
            roomId={room.id}
            roomName={room.name}
            onMessageSent={refresh}
            editingMessage={editingMessage}
            onCancelEdit={() => setEditingMessage(null)}
          />
        </div>

        {/* User menu panel with resizable inside border */}
        {showUsers && (
          <>
            <div
              onMouseDown={handleUserMenuResizeStart}
              onDoubleClick={() => onUserMenuWidthChange(USER_MENU_DEFAULT_WIDTH)}
              onMouseEnter={() => setIsUserMenuResizeHovered(true)}
              onMouseLeave={() => setIsUserMenuResizeHovered(false)}
              style={{
                width: 6,
                flexShrink: 0,
                cursor: "col-resize",
                backgroundColor: isUserMenuResizeHovered ? palette.border : "transparent",
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
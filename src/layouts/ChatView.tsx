import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Hash, Users } from "lucide-react";
import MessageList from "../components/MessageList";
import MessageInput from "../components/MessageInput";
import UserMenu from "../components/UserMenu";
import { useMessages } from "../hooks/useMessages";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";

interface ChatViewProps {
  room: Room;
}

interface TypingPayload {
  roomId: string;
  userIds: string[];
  displayNames: string[];
}

function TypingIndicator({ names, palette, typography, spacing }: {
  names: string[];
  palette: any;
  typography: any;
  spacing: any;
}) {
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

export default function ChatView({ room }: ChatViewProps) {
  const { messages, loadMore, hasMore, loading, initialLoading, refresh } = useMessages(room.id);
  const { palette, typography, spacing } = useTheme();
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [showUsers, setShowUsers] = useState(true);

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

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      {/* Channel header */}
      <div style={{
        padding: `${spacing.unit * 4}px ${spacing.unit * 4}px`,
        borderBottom: `1px solid ${palette.border}`,
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
      }}>
        <Hash size={20} color={palette.textSecondary} />
        <span style={{
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          fontSize: typography.fontSizeBase,
          flex: 1,
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
          }}
        >
          <Users
            size={20}
            color={showUsers ? palette.textHeading : palette.textSecondary}
          />
        </button>
      </div>

      {/* Content area: messages + optional user menu */}
      <div style={{
        flex: 1,
        display: "flex",
        overflow: "hidden",
      }}>
        {/* Messages column */}
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}>
          <MessageList
            messages={messages}
            loading={loading}
            initialLoading={initialLoading}
            hasMore={hasMore}
            onLoadMore={loadMore}
          />

          {/* Typing indicator */}
          <TypingIndicator
            names={typingNames}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />

          {/* Message input */}
          <MessageInput
            roomId={room.id}
            roomName={room.name}
            onMessageSent={refresh}
          />
        </div>

        {/* User menu panel */}
        {showUsers && <UserMenu roomId={room.id} />}
      </div>
    </div>
  );
}
import MessageList from "../components/MessageList";
import MessageInput from "../components/MessageInput";
import { useMessages } from "../hooks/useMessages";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";

interface ChatViewProps {
  room: Room;
}

export default function ChatView({ room }: ChatViewProps) {
  const { messages, loadMore, hasMore, loading, initialLoading, refresh } = useMessages(room.id);
  const { palette, typography, spacing } = useTheme();

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
        <span style={{ color: palette.textSecondary, fontSize: typography.fontSizeLarge }}>#</span>
        <span style={{
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          fontSize: typography.fontSizeBase,
        }}>
          {room.name}
        </span>
      </div>

      {/* Messages */}
      <MessageList
        messages={messages}
        loading={loading}
        initialLoading={initialLoading}
        hasMore={hasMore}
        onLoadMore={loadMore}
      />

      {/* Message input */}
      <MessageInput
        roomId={room.id}
        roomName={room.name}
        onMessageSent={refresh}
      />
    </div>
  );
}
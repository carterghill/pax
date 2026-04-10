import { useState, useEffect, useRef, useCallback } from "react";
import { useRoomRedactionPolicy } from "../hooks/useRoomRedactionPolicy";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Hash, MessageCircle, Users } from "lucide-react";
import MessageList from "../components/MessageList";
import MessageInput, { type EditingMessageRef } from "../components/MessageInput";
import UserMenu from "../components/UserMenu";
import { useMessages } from "../hooks/useMessages";
import { useTheme } from "../theme/ThemeContext";
import { Message, Room } from "../types/matrix";
import { useResizeHandle } from "../hooks/useResizeHandle";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";

const USER_MENU_DEFAULT_WIDTH = 240;
const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const USER_MENU_RESIZE_HANDLE = 6;

interface ChatViewProps {
  userId: string;
  userMenuWidth: number;
  onUserMenuWidthChange: (width: number) => void;
  onStartDirectMessage: (peerUserId: string, displayNameHint: string) => void;
  room?: Room;
  draftDm?: { peerUserId: string; displayNameHint: string } | null;
  onDraftDmResolved?: (roomId: string) => void | Promise<void>;
  onCancelDraftDm?: () => void;
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
  const fadeHeight = spacing.unit * 4;
  const rowPadY = spacing.unit * 1;
  const rowPadX = spacing.unit * 3;
  const fadeMask = "linear-gradient(to bottom, transparent, black)";

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
          height: fadeHeight,
          backgroundColor: bg,
          maskImage: fadeMask,
          WebkitMaskImage: fadeMask,
        }}
      />
      <div
        style={{
          padding: `${0}px ${rowPadX}px ${rowPadY}px`,
          backgroundColor: bg,
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
  draftDm,
  userId,
  userMenuWidth,
  onUserMenuWidthChange,
  onStartDirectMessage,
  onDraftDmResolved,
  onCancelDraftDm,
}: ChatViewProps) {
  const isDraft = draftDm != null;
  const activeRoom = room ?? null;

  const {
    messages,
    loadMore,
    hasMore,
    loading,
    initialLoading,
    refreshing,
    refresh,
    removeMessageById,
  } = useMessages(isDraft ? null : activeRoom!.id);
  const redactionPolicy = useRoomRedactionPolicy(isDraft ? null : activeRoom!.id);
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [localTyping, setLocalTyping] = useState(false);
  const [showUsers, setShowUsers] = useState(true);
  const [editingMessage, setEditingMessage] = useState<EditingMessageRef | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const userMenuResize = useResizeHandle({
    width: userMenuWidth,
    onWidthChange: onUserMenuWidthChange,
    min: MIN_USER_MENU_WIDTH,
    max: () => Math.min(MAX_USER_MENU_WIDTH, (containerRef.current?.offsetWidth ?? 600) - 200),
    direction: -1,
  });

  useEffect(() => {
    if (isDraft || !activeRoom) return;
    const unlisten = listen<TypingPayload>("typing", (event) => {
      const { roomId, displayNames, userIds } = event.payload;
      if (roomId !== activeRoom.id) return;
      const filtered = displayNames.filter((_, i) => userIds[i] !== userId);
      setTypingNames(filtered);
    });

    setTypingNames([]);
    setLocalTyping(false);

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isDraft, activeRoom, userId]);

  useEffect(() => {
    setEditingMessage(null);
  }, [activeRoom?.id, isDraft]);

  const handleRequestEdit = useCallback((msg: Message) => {
    setEditingMessage({ eventId: msg.eventId, body: msg.body });
  }, []);

  const handleDraftDmFirstMessage = useCallback(
    async (newRoomId: string) => {
      await onDraftDmResolved?.(newRoomId);
    },
    [onDraftDmResolved],
  );

  if (isDraft && draftDm) {
    const hint = draftDm.displayNameHint.trim() || draftDm.peerUserId;
    const initials = hint
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";

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
        <div style={{
          padding: `0 ${spacing.unit * 4}px`,
          height: spacing.headerHeight,
          borderBottom: `1px solid ${palette.border}`,
          display: "flex",
          position: "relative",
          alignItems: "center",
          gap: spacing.unit * 2,
          boxSizing: "border-box",
          minWidth: 0,
        }}>
          <button
            type="button"
            onClick={() => onCancelDraftDm?.()}
            title="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: spacing.unit,
              borderRadius: spacing.unit,
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              color: palette.textSecondary,
            }}
          >
            <ArrowLeft size={20} />
          </button>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            backgroundColor: userInitialAvatarBackground(draftDm.peerUserId, resolvedColorScheme),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightBold,
            color: palette.textPrimary,
          }}>
            {initials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {hint}
            </div>
            <div style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}>
              Direct message · no room until you send
            </div>
          </div>
          <MessageCircle size={20} color={palette.textSecondary} style={{ flexShrink: 0 }} />
        </div>

        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          backgroundColor: palette.bgPrimary,
        }}>
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
            padding: spacing.unit * 4,
            textAlign: "center",
          }}>
            No messages yet. Your first message will create this conversation.
          </div>

          <div style={{ position: "relative", flexShrink: 0, zIndex: 1 }}>
            <MessageInput
              key={`draft-${draftDm.peerUserId}`}
              roomId=""
              roomName={hint}
              draftDmPeerUserId={draftDm.peerUserId}
              onDraftDmFirstMessage={handleDraftDmFirstMessage}
              onMessageSent={() => {}}
              editingMessage={null}
              onCancelEdit={undefined}
              onLocalTypingActive={setLocalTyping}
            />
          </div>
        </div>
      </div>
    );
  }

  if (!activeRoom) return null;

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
        {activeRoom.isDirect ? (
          <div style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            backgroundColor: activeRoom.dmPeerUserId
              ? userInitialAvatarBackground(activeRoom.dmPeerUserId, resolvedColorScheme)
              : palette.bgActive,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 11,
            fontWeight: typography.fontWeightBold,
            color: palette.textPrimary,
            overflow: "hidden",
          }}>
            {activeRoom.avatarUrl ? (
              <img
                src={activeRoom.avatarUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              (activeRoom.name || "?").slice(0, 2).toUpperCase()
            )}
          </div>
        ) : (
          <Hash size={20} color={palette.textSecondary} style={{ flexShrink: 0 }} />
        )}
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
          {activeRoom.name}
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
            roomId={activeRoom.id}
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
              key={activeRoom.id}
              roomId={activeRoom.id}
              roomName={activeRoom.name}
              onMessageSent={refresh}
              editingMessage={editingMessage}
              onCancelEdit={() => setEditingMessage(null)}
              onLocalTypingActive={setLocalTyping}
            />
          </div>
        </div>

        {/* User menu panel with resizable inside border */}
        {showUsers && (
          <div style={{
            position: "relative",
            flexShrink: 0,
            zIndex: 1,
            alignSelf: "stretch",
            minHeight: 0,
            height: "100%",
          }}>
            <UserMenu
              width={userMenuWidth}
              roomId={activeRoom.id}
              userId={userId}
              onStartDirectMessage={onStartDirectMessage}
            />
            <div
              onMouseDown={userMenuResize.onMouseDown}
              onDoubleClick={() => onUserMenuWidthChange(USER_MENU_DEFAULT_WIDTH)}
              onMouseEnter={() => userMenuResize.setIsHovered(true)}
              onMouseLeave={() => userMenuResize.setIsHovered(false)}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: -(USER_MENU_RESIZE_HANDLE / 2),
                width: USER_MENU_RESIZE_HANDLE,
                cursor: "col-resize",
                backgroundColor: userMenuResize.isHovered ? palette.border : "transparent",
                transition: "background-color 0.15s",
                zIndex: 2,
              }}
              title="Drag to resize, double-click to reset"
            />
          </div>
        )}
      </div>
    </div>
  );
}

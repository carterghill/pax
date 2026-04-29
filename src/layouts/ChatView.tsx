import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from "react";
import { useRoomRedactionPolicy } from "../hooks/useRoomRedactionPolicy";
import { useRoomCanSendMessages } from "../hooks/useRoomCanSendMessages";
import { useRoomCanPinMessages } from "../hooks/useRoomCanPinMessages";
import { useRoomPinnedEventIds } from "../hooks/useRoomPinnedEventIds";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Hash, MessageCircle, Users } from "lucide-react";
import UserAvatar from "../components/UserAvatar";
import MessageList, { type MessageListHandle } from "../components/MessageList";
import PinnedMessagesMenu from "../components/PinnedMessagesMenu";
import MessageInput, { type EditingMessageRef, type MessageFileSendBridge } from "../components/MessageInput";
import UserMenu from "../components/UserMenu";
import UserProfileDialog from "../components/UserProfileDialog";
import RoomDownloadsButton from "../components/RoomDownloadsButton";
import SideDrawer from "../components/SideDrawer";
import { useMessages } from "../hooks/useMessages";
import { useMatrixUserProfile } from "../hooks/useMatrixUserProfile";
import { useTheme } from "../theme/ThemeContext";
import { Message, Room } from "../types/matrix";
import { useResizeHandle } from "../hooks/useResizeHandle";
import { effectiveDmTitle, isDmChatUi } from "../utils/dmDisplay";

const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const USER_MENU_RESIZE_HANDLE = 6;
/** Typing strip inset: paint doesn’t cover the vertical scrollbar (no z-index for the thumb alone). */
const TYPING_STRIP_SCROLLBAR_RESERVE_PX = 16;

/** `#rrggbb` → RGB. Used so fade uses same-color alpha (plain `transparent` gradients tint gray). */
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface ChatViewProps {
  userId: string;
  userMenuWidth: number;
  onUserMenuWidthChange: (width: number) => void;
  onStartDirectMessage: (peerUserId: string, displayNameHint: string) => void;
  /** Space tree room ids when the active room is under a space (for kick/ban scope). */
  moderationSpaceTreeRoomIds?: string[] | null;
  moderationSpaceName?: string | null;
  room?: Room;
  draftDm?: { peerUserId: string; displayNameHint: string } | null;
  onDraftDmResolved?: (roomId: string) => void | Promise<void>;
  onCancelDraftDm?: () => void;
  isMobile?: boolean;
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
  const rowPadY = spacing.unit * 0.5;
  const rowPadX = spacing.unit * 3;
  /** Pull the strip up so the top can composite over the thread. */
  const overThreadPx = spacing.unit * 3;
  const rgb = hexRgb(bg);
  /**
   * Balance: a clear top over the thread, then a visible scrim (not ghosted), and the text row
   * sits in the lower third where alpha is already near-opaque. Stops are % of total strip height.
   */
  const fadeBackground =
    rgb != null
      ? `linear-gradient(to bottom, rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0) 0%, rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0) 8%, rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.38) 32%, rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.78) 55%, rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.95) 72%, rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1) 100%)`
      : `linear-gradient(to bottom, transparent 0%, transparent 8%, ${bg} 100%)`;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: TYPING_STRIP_SCROLLBAR_RESERVE_PX,
        bottom: "100%",
        zIndex: 2,
        pointerEvents: "none",
        paddingTop: overThreadPx,
        paddingLeft: rowPadX,
        paddingRight: rowPadX,
        paddingBottom: rowPadY,
        boxSizing: "border-box",
        backgroundColor: "transparent",
        backgroundImage: fadeBackground,
        backgroundRepeat: "no-repeat",
        backgroundSize: "100% 100%",
        fontSize: typography.fontSizeSmall,
        color: palette.textSecondary,
        lineHeight: 1.25,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: spacing.unit }}>
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
      </div>
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
  draftDm,
  userId,
  userMenuWidth,
  onUserMenuWidthChange,
  onStartDirectMessage,
  moderationSpaceTreeRoomIds = null,
  moderationSpaceName = null,
  onDraftDmResolved,
  onCancelDraftDm,
  isMobile = false,
}: ChatViewProps) {
  const isDraft = draftDm != null;
  const activeRoom = room ?? null;
  const draftPeerProfile = useMatrixUserProfile(isDraft && draftDm ? draftDm.peerUserId : null);

  const {
    messages,
    loadOlder,
    loadNewer,
    hasOlder,
    isAtLatest,
    loadingOlder,
    initialLoading,
    pendingRecentCount,
    showJumpToRecent,
    jumpToRecent,
    refresh,
    removeMessageById,
    addOptimisticMessage,
    patchMessage,
    patchMessageByUploadId,
    replaceMessageEventId,
    loadMessagesAroundEvent,
    applyLocalReactionFromChip,
  } = useMessages(isDraft ? null : activeRoom!.id, isDraft ? null : userId);

  const selfProfile = useMatrixUserProfile(isDraft ? null : userId);

  const fileSendBridge: MessageFileSendBridge | null = useMemo(
    () =>
      isDraft
        ? null
        : {
            addOptimistic: addOptimisticMessage,
            patchMessage,
            patchMessageByUploadId,
            replaceMessageEventId,
            removeMessage: removeMessageById,
          },
    [
      isDraft,
      addOptimisticMessage,
      patchMessage,
      patchMessageByUploadId,
      replaceMessageEventId,
      removeMessageById,
    ],
  );
  const redactionPolicy = useRoomRedactionPolicy(isDraft ? null : activeRoom!.id);
  const canSendMessages = useRoomCanSendMessages(isDraft ? null : activeRoom!.id);
  const canPinMessages = useRoomCanPinMessages(isDraft ? null : activeRoom!.id);
  const { pinnedEventIds, refreshPinned } = useRoomPinnedEventIds(
    isDraft ? null : activeRoom!.id,
  );
  const { palette, typography, spacing } = useTheme();
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [localTyping, setLocalTyping] = useState(false);
  const [showUsers, setShowUsers] = useState(!isMobile);
  const [editingMessage, setEditingMessage] = useState<EditingMessageRef | null>(null);
  const [replyDraft, setReplyDraft] = useState<Message | null>(null);
  const [pinnedMenuOpen, setPinnedMenuOpen] = useState(false);
  const [messageSenderProfileUserId, setMessageSenderProfileUserId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const userMenuResize = useResizeHandle({
    width: userMenuWidth,
    onWidthChange: onUserMenuWidthChange,
    min: MIN_USER_MENU_WIDTH,
    max: () => Math.min(MAX_USER_MENU_WIDTH, (containerRef.current?.offsetWidth ?? 600) - 200),
    direction: -1,
  });

  useEffect(() => {
    if (isMobile) setShowUsers(false);
    else setShowUsers(true);
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) setShowUsers(false);
  }, [activeRoom?.id, isMobile]);

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
  }, [isDraft, activeRoom?.id, userId]);

  useEffect(() => {
    setEditingMessage(null);
    setReplyDraft(null);
  }, [activeRoom?.id, isDraft]);

  useEffect(() => {
    setMessageSenderProfileUserId(null);
  }, [activeRoom?.id, isDraft]);

  const handleRequestEdit = useCallback((msg: Message) => {
    setReplyDraft(null);
    setEditingMessage({ eventId: msg.eventId, body: msg.body });
  }, []);

  const handleRequestReply = useCallback((msg: Message) => {
    setEditingMessage(null);
    setReplyDraft(msg);
  }, []);

  const handleReplyPreviewClick = useCallback(
    (eventId: string) => {
      if (isDraft || !activeRoom) return;
      const inWindow = messages.some((m) => m.eventId === eventId);
      if (inWindow) {
        messageListRef.current?.scrollToEventId(eventId);
        return;
      }
      void (async () => {
        try {
          await loadMessagesAroundEvent(eventId);
        } finally {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              messageListRef.current?.scrollToEventId(eventId);
            });
          });
        }
      })();
    },
    [isDraft, activeRoom, messages, loadMessagesAroundEvent],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
  }, []);

  const clearReplyDraft = useCallback(() => setReplyDraft(null), []);

  const handleSelectPinnedMessage = useCallback(
    async (eventId: string) => {
      if (isDraft || !activeRoom) return;
      const inWindow = messages.some((m) => m.eventId === eventId);
      if (inWindow) {
        messageListRef.current?.scrollToEventId(eventId);
        return;
      }
      await loadMessagesAroundEvent(eventId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          messageListRef.current?.scrollToEventId(eventId);
        });
      });
    },
    [isDraft, activeRoom, messages, loadMessagesAroundEvent],
  );

  const handlePinnedStateChanged = useCallback(() => {
    void refreshPinned();
    void refresh();
  }, [refreshPinned, refresh]);

  const handleDraftDmFirstMessage = useCallback(
    async (newRoomId: string) => {
      await onDraftDmResolved?.(newRoomId);
    },
    [onDraftDmResolved],
  );

  const dmBannerStyle: CSSProperties = {
    padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
    minHeight: spacing.headerHeight,
    borderBottom: `1px solid ${palette.border}`,
    display: "flex",
    alignItems: "center",
    gap: spacing.unit * 2,
    boxSizing: "border-box",
    minWidth: 0,
  };

  if (isDraft && draftDm) {
    const hint = draftDm.displayNameHint.trim() || draftDm.peerUserId;
    const title = draftPeerProfile.displayName?.trim() || hint;

    return (
      <div ref={containerRef} style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        overflow: "hidden",
        height: isMobile ? "100%" : "100vh",
      }}>
        <div style={dmBannerStyle}>
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
          <UserAvatar
            userId={draftDm.peerUserId}
            displayName={title}
            avatarUrlHint={draftPeerProfile.avatarUrl}
            size={32}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {title}
            </div>
            <div style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}>
              Direct message
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 0.5, flexShrink: 0 }}>
            <RoomDownloadsButton roomId={`draft:${draftDm.peerUserId}`} />
            <MessageCircle size={20} color={palette.textSecondary} style={{ marginLeft: spacing.unit }} />
          </div>
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
              roomName={title}
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

  const userMenuPanelWidth = Math.min(
    userMenuWidth,
    Math.max(MIN_USER_MENU_WIDTH, Math.floor(window.innerWidth * 0.92))
  );

  return (
    <div ref={containerRef} style={{
      flex: 1,
      minHeight: 0,
      display: "flex",
      flexDirection: "column",
      height: isMobile ? "100%" : "100vh",
      minWidth: 0,
      overflow: "hidden",
    }}>
      {/* Channel header — 1:1 DM matches draft banner (no member list toggle) */}
      {isDmChatUi(activeRoom) ? (
        <div style={dmBannerStyle}>
          <UserAvatar
            userId={activeRoom.dmPeerUserId ?? activeRoom.id}
            displayName={effectiveDmTitle(activeRoom)}
            avatarUrlHint={activeRoom.isDirect ? activeRoom.avatarUrl : undefined}
            size={32}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {effectiveDmTitle(activeRoom)}
            </div>
            <div style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}>
              Direct message
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 0.5, flexShrink: 0 }}>
            <PinnedMessagesMenu
              roomId={activeRoom.id}
              open={pinnedMenuOpen}
              onOpenChange={setPinnedMenuOpen}
              onSelectEventId={handleSelectPinnedMessage}
            />
            <RoomDownloadsButton roomId={activeRoom.id} />
            <MessageCircle size={20} color={palette.textSecondary} style={{ marginLeft: spacing.unit }} />
          </div>
        </div>
      ) : (
        <div style={{
          padding: `0 ${spacing.unit * 4}px`,
          height: spacing.headerHeight,
          borderBottom: `1px solid ${palette.border}`,
          display: "flex",
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
          }}>
            {activeRoom.name}
          </span>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 0.5,
            flexShrink: 0,
          }}>
            <PinnedMessagesMenu
              roomId={activeRoom.id}
              open={pinnedMenuOpen}
              onOpenChange={setPinnedMenuOpen}
              onSelectEventId={handleSelectPinnedMessage}
            />
            <RoomDownloadsButton roomId={activeRoom.id} />
            <button
              type="button"
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
              }}
            >
              <Users
                size={20}
                color={showUsers ? palette.textHeading : palette.textSecondary}
                strokeWidth={showUsers ? 2.5 : 2}
              />
            </button>
          </div>
        </div>
      )}

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
            ref={messageListRef}
            messages={messages}
            loadingOlder={loadingOlder}
            initialLoading={initialLoading}
            hasOlder={hasOlder}
            isAtLatest={isAtLatest}
            onLoadOlder={loadOlder}
            onLoadNewer={loadNewer}
            pendingRecentCount={pendingRecentCount}
            showJumpToRecent={showJumpToRecent}
            onJumpToRecent={jumpToRecent}
            roomId={activeRoom.id}
            userId={userId}
            redactionPolicy={redactionPolicy}
            onRequestEdit={handleRequestEdit}
            onRequestReply={handleRequestReply}
            onReplyPreviewClick={handleReplyPreviewClick}
            allowReply={canSendMessages === true}
            onMessagesMutated={refresh}
            onMessageRemoved={removeMessageById}
            onLocalReactionFromChip={applyLocalReactionFromChip}
            canPinMessages={canPinMessages === true}
            pinnedEventIds={pinnedEventIds}
            onPinnedStateChanged={handlePinnedStateChanged}
            onOpenSenderProfile={setMessageSenderProfileUserId}
          />

          <div
            style={{
              position: "relative",
              flexShrink: 0,
              zIndex: 1,
              minWidth: 0,
            }}
          >
            <TypingIndicator
              names={typingNames}
              localTyping={localTyping}
            />
            <MessageInput
              key={activeRoom.id}
              roomId={activeRoom.id}
              roomName={activeRoom.name}
              composerPermission={
                canSendMessages === null
                  ? "loading"
                  : canSendMessages
                    ? "allowed"
                    : "forbidden"
              }
              onMessageSent={refresh}
              replyDraft={replyDraft}
              onCancelReply={clearReplyDraft}
              editingMessage={editingMessage}
              onCancelEdit={handleCancelEdit}
              onLocalTypingActive={setLocalTyping}
              selfUserId={userId}
              selfDisplayName={selfProfile.displayName}
              selfAvatarUrl={selfProfile.avatarUrl}
              fileSendBridge={fileSendBridge}
            />
          </div>
        </div>

        {/* User menu: inline on desktop, right drawer on mobile */}
        {!isMobile && showUsers && !isDmChatUi(activeRoom) && (
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
              roomName={activeRoom.name}
              userId={userId}
              moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
              moderationSpaceName={moderationSpaceName}
              onStartDirectMessage={onStartDirectMessage}
            />
            <div
              onMouseDown={userMenuResize.onMouseDown}
              onDoubleClick={() => onUserMenuWidthChange(spacing.userMenuWidth)}
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

      {isMobile && showUsers && !isDmChatUi(activeRoom) && (
        <SideDrawer
          open={showUsers}
          onClose={() => setShowUsers(false)}
          side="right"
          widthPx={userMenuPanelWidth}
        >
          <UserMenu
            width={userMenuPanelWidth}
            roomId={activeRoom.id}
            roomName={activeRoom.name}
            userId={userId}
            moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
            moderationSpaceName={moderationSpaceName}
            onStartDirectMessage={onStartDirectMessage}
          />
        </SideDrawer>
      )}

      {messageSenderProfileUserId && (
        <UserProfileDialog
          roomId={activeRoom.id}
          userId={messageSenderProfileUserId}
          currentUserId={userId}
          onClose={() => setMessageSenderProfileUserId(null)}
          onStartDirectMessage={onStartDirectMessage}
        />
      )}
    </div>
  );
}
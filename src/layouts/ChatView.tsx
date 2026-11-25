import { useState, useEffect, useRef, useCallback, useMemo, useId, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useRoomRedactionPolicy } from "../hooks/useRoomRedactionPolicy";
import { useRoomCanSendMessages } from "../hooks/useRoomCanSendMessages";
import { useRoomCanPinMessages } from "../hooks/useRoomCanPinMessages";
import { useRoomPinnedEventIds } from "../hooks/useRoomPinnedEventIds";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Hash, MessageCircle, Rss, Users } from "lucide-react";
import DmCallButtons from "../components/DmCallButtons";
import { RssFeedStatusPanel, RssFeedStatusToggle, useRssFeedStatus } from "../components/RssFeedStatus";
import NavBackButton from "../components/NavBackButton";
import UserAvatar from "../components/UserAvatar";
import MessageList, { type MessageListHandle } from "../components/MessageList";
import PinnedMessagesMenu from "../components/PinnedMessagesMenu";
import MessageInput, { type EditingMessageRef, type MessageFileSendBridge } from "../components/MessageInput";
import UserMenu from "../components/UserMenu";
import RoomMemberContextMenu, { type MemberMenuTarget } from "../components/RoomMemberContextMenu";
import UserProfileDialog from "../components/UserProfileDialog";
import RoomDownloadsButton from "../components/RoomDownloadsButton";
import RoomHeaderTitle, { RoomHeaderIcon } from "../components/RoomHeaderTitle";
import SideDrawer from "../components/SideDrawer";
import { useMessages } from "../hooks/useMessages";
import { useRoomUpgradeHistory } from "../hooks/useRoomUpgradeHistory";
import { useMatrixUserProfile } from "../hooks/useMatrixUserProfile";
import { useTheme } from "../theme/ThemeContext";
import { Message, Room } from "../types/matrix";
import { useResizeHandle } from "../hooks/useResizeHandle";
import { effectiveDmTitle, isDmChatUi, isOneToOneChatUi } from "../utils/dmDisplay";
import { useUnavailableMessages } from "../hooks/useUnavailableMessages";
import UnavailableMessagesNotice from "../components/UnavailableMessagesNotice";
import EncryptionSettingsPanel from "../components/EncryptionSettingsPanel";
import Dialog from "../components/Dialog";
import { useEncryption } from "../context/EncryptionContext";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";
import RssThreadDrawer from "../features/chat/messages/RssThreadDrawer";
import type { RssArticleCandidate } from "../features/chat/messages/rssArticle";
import { rssThreadReplyCount, type RssThread } from "../features/chat/messages/rssThreads";
import { useRssThreads } from "../features/chat/messages/useRssThreads";
import { recentRssList, subscribeToRssLists } from "../features/rss/api";

const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const USER_MENU_RESIZE_HANDLE = 6;
/** Typing strip inset: paint doesn’t cover the vertical scrollbar (no z-index for the thumb alone). */
const TYPING_STRIP_SCROLLBAR_RESERVE_PX = 16;
const NO_THREAD_REPLIES: Message[] = [];

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
  onComposerAutoFocus?: () => void;
  onStartCall?: (video: boolean) => void;
  onCallMember?: (userId: string) => void;
  callUnavailable?: string;
  callContent?: ReactNode;
  /** Opened from a system notification: scroll this timeline event after the room is active. */
  notificationJump?: { roomId: string; eventId: string } | null;
  onNotificationJumpConsumed?: () => void;
  /** Space tree room ids when the active room is under a space (for kick/ban scope). */
  moderationSpaceTreeRoomIds?: string[] | null;
  moderationSpaceName?: string | null;
  room?: Room;
  draftDm?: { peerUserId: string; displayNameHint: string } | null;
  onDraftDmResolved?: (roomId: string) => void | Promise<void>;
  onCancelDraftDm?: () => void;
  isMobile?: boolean;
  /** Mobile: open the navigation drawer. */
  onOpenNavigation?: () => void;
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
  onComposerAutoFocus,
  onStartCall,
  onCallMember,
  callUnavailable,
  callContent,
  notificationJump = null,
  onNotificationJumpConsumed,
  moderationSpaceTreeRoomIds = null,
  moderationSpaceName = null,
  onDraftDmResolved,
  onCancelDraftDm,
  isMobile = false,
  onOpenNavigation,
}: ChatViewProps) {
  const isDraft = draftDm != null;
  const activeRoom = room ?? null;
  const { userIds: ignoredUsers } = useIgnoredUsers();
  const draftPeerProfile = useMatrixUserProfile(isDraft && draftDm ? draftDm.peerUserId : null);

  const {
    messages,
    latestEventId,
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
  const history = useRoomUpgradeHistory(activeRoom?.id ?? null, activeRoom?.historyRoomIds);
  const loadHistoryAround = history.loadAround;
  const [retryingUpgrade, setRetryingUpgrade] = useState(false);
  const [upgradeResult, setUpgradeResult] = useState<{ roomId: string; message: string } | null>(null);
  const retryUpgrade = async () => {
    if (!activeRoom) return;
    const id = activeRoom.id;
    setRetryingUpgrade(true);
    setUpgradeResult(null);
    try {
      const latest = await invoke<string>("join_room", { roomId: id });
      if (latest === id) {
        setUpgradeResult({ roomId: id, message: "The replacement may require an invitation." });
      }
    } catch (error) {
      setUpgradeResult({ roomId: id, message: String(error) });
    } finally {
      setRetryingUpgrade(false);
    }
  };

  const rssRoomId = !isDraft && activeRoom?.isRss ? activeRoom.id : null;
  const rssFeed = useRssFeedStatus(rssRoomId);
  // The synced room state is available before the provider's live status check.
  const rssSettings = rssFeed?.status ?? activeRoom?.rssProvider;
  const rssBot = rssRoomId ? rssSettings?.botUserId : undefined;
  const rssProvider = useMemo(
    () => rssBot ? { botUserId: rssBot } : undefined,
    [rssBot],
  );
  const getRssSubscriptions = useCallback(() => recentRssList(rssRoomId, rssBot), [rssRoomId, rssBot]);
  const rssSubscriptions = useSyncExternalStore(subscribeToRssLists, getRssSubscriptions);
  const rssThreads = useRssThreads(rssRoomId, rssProvider, messages, rssSubscriptions);
  const timeline = useMemo(
    () => history.messages.length ? history.messages.concat(rssThreads.visibleMessages) : rssThreads.visibleMessages,
    [history.messages, rssThreads.visibleMessages],
  );
  const rssPanelId = useId();
  const rssButtonRef = useRef<HTMLButtonElement>(null);
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
  const [typing, setTyping] = useState<TypingPayload | null>(null);
  const typingNames = typing?.roomId === activeRoom?.id
    ? typing?.displayNames.filter((_, i) => typing.userIds[i] !== userId && !ignoredUsers.has(typing.userIds[i])) ?? []
    : [];
  const [localTyping, setLocalTyping] = useState(false);
  const [showUsers, setShowUsers] = useState(!isMobile);
  const [editingMessage, setEditingMessage] = useState<EditingMessageRef | null>(null);
  const [replyDraft, setReplyDraft] = useState<Message | null>(null);
  const [memberMenu, setMemberMenu] = useState<(MemberMenuTarget & { roomId: string }) | null>(null);
  const openMemberMenu = useCallback((event: React.MouseEvent, targetId: string, displayName: string) => {
    if (!activeRoom) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMemberMenu({
      roomId: activeRoom.id,
      x: event.clientX || rect.left,
      y: event.clientY || rect.bottom,
      userId: targetId,
      displayName,
    });
  }, [activeRoom?.id]);
  const openSenderMenu = useCallback((event: React.MouseEvent, message: Message) => {
    openMemberMenu(event, message.sender, message.senderName ?? message.sender);
  }, [openMemberMenu]);
  const closeMemberMenu = useCallback(() => {
    setMemberMenu((current) => current === memberMenu ? null : current);
  }, [memberMenu]);
  const [selectedThread, setSelectedThread] = useState<{
    roomId: string;
    thread: RssThread;
    jumpEventId?: string;
  } | null>(null);
  const [threadCounts, setThreadCounts] = useState<{
    roomId: string;
    ignoredUsers: ReadonlySet<string>;
    counts: Map<string, number>;
  } | null>(null);
  const activeThread = selectedThread && selectedThread.roomId === rssRoomId
    && selectedThread.thread.root.sender === rssProvider?.botUserId
    && !ignoredUsers.has(selectedThread.thread.root.sender)
    ? {
      ...selectedThread.thread,
      root: rssThreads.articles.get(selectedThread.thread.root.eventId)?.root ?? selectedThread.thread.root,
    }
    : null;
  const closeThread = useCallback(() => setSelectedThread(null), []);
  const openThread = useCallback((root: Message, article: RssArticleCandidate, jumpEventId?: string) => {
    if (rssRoomId) setSelectedThread({ roomId: rssRoomId, thread: { root, article }, jumpEventId });
  }, [rssRoomId]);
  const updateThreadCount = useCallback((eventId: string, count: number) => {
    if (!rssRoomId) return;
    setThreadCounts((previous) => {
      const counts = previous?.roomId === rssRoomId && previous.ignoredUsers === ignoredUsers
        ? previous.counts : undefined;
      if (counts?.get(eventId) === count) return previous;
      return { roomId: rssRoomId, ignoredUsers, counts: new Map(counts).set(eventId, count) };
    });
  }, [rssRoomId, ignoredUsers]);
  const replyCounts = useMemo(() => {
    if (threadCounts?.roomId !== rssRoomId || threadCounts.ignoredUsers !== ignoredUsers) return undefined;
    const counts = new Map<string, number>();
    for (const [id, count] of threadCounts.counts) {
      const thread = rssThreads.articles.get(id);
      const loadedCount = thread ? rssThreadReplyCount(thread.root, rssThreads.replies.get(id) ?? []) : 0;
      counts.set(id, activeThread?.root.eventId === id ? count : Math.max(count, loadedCount));
    }
    return counts;
  }, [activeThread?.root.eventId, rssRoomId, rssThreads, threadCounts, ignoredUsers]);
  const [pinnedMenuOpen, setPinnedMenuOpen] = useState(false);
  const [messageSenderProfileUserId, setMessageSenderProfileUserId] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const encryption = useEncryption();
  const unavailable = useUnavailableMessages(isDraft ? null : activeRoom?.id ?? null, userId, messages, isAtLatest, latestEventId);

  const containerRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const threadSnapshotRef = useRef(rssThreads);
  threadSnapshotRef.current = rssThreads;
  const messagesSnapshotRef = useRef<Message[]>([]);
  messagesSnapshotRef.current = useMemo(
    () => history.messages.length ? history.messages.concat(messages) : messages,
    [history.messages, messages],
  );
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
      if (event.payload.roomId === activeRoom.id) setTyping(event.payload);
    });

    setTyping(null);
    setLocalTyping(false);

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isDraft, activeRoom?.id, userId]);

  useEffect(() => {
    setEditingMessage(null);
    setReplyDraft(null);
    setRecoveryOpen(false);
    closeThread();
    setThreadCounts(null);
  }, [activeRoom?.id, closeThread, isDraft]);

  useEffect(() => {
    setMessageSenderProfileUserId(null);
    setMemberMenu(null);
  }, [activeRoom?.id, isDraft]);

  useEffect(() => {
    setReplyDraft((current) => current && ignoredUsers.has(current.sender) ? null : current);
  }, [ignoredUsers]);

  const handleRequestEdit = useCallback((msg: Message) => {
    setReplyDraft(null);
    setEditingMessage(msg);
  }, []);

  const handleRequestReply = useCallback((msg: Message) => {
    setEditingMessage(null);
    setReplyDraft(msg);
  }, []);

  const scrollToMessage = useCallback((eventId: string, highlight = false) => {
    const { articles, rootByReply } = threadSnapshotRef.current;
    const rootId = rootByReply.get(eventId);
    const thread = rootId ? articles.get(rootId) : undefined;
    if (thread) {
      messageListRef.current?.scrollToEventId(thread.root.eventId);
      openThread(thread.root, thread.article, eventId);
    } else {
      messageListRef.current?.scrollToEventId(eventId, highlight);
    }
  }, [openThread]);

  const handleReplyPreviewClick = useCallback(
    (eventId: string, sourceRoomId?: string) => {
      if (isDraft || !activeRoom?.id) return;
      const inWindow = messagesSnapshotRef.current.some((m) => m.eventId === eventId);
      if (inWindow) {
        scrollToMessage(eventId, true);
        return;
      }
      void (async () => {
        try {
          if (sourceRoomId) await loadHistoryAround(sourceRoomId, eventId);
          else await loadMessagesAroundEvent(eventId);
        } finally {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              scrollToMessage(eventId, true);
            });
          });
        }
      })();
    },
    [isDraft, activeRoom?.id, loadMessagesAroundEvent, loadHistoryAround, scrollToMessage],
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
        scrollToMessage(eventId);
        return;
      }
      await loadMessagesAroundEvent(eventId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToMessage(eventId);
        });
      });
    },
    [isDraft, activeRoom, messages, loadMessagesAroundEvent, scrollToMessage],
  );

  // Android / desktop notification tap: jump to the exact Matrix event when provided.
  useEffect(() => {
    if (isDraft || !activeRoom || !notificationJump) return;
    if (notificationJump.roomId !== activeRoom.id && !activeRoom.historyRoomIds?.includes(notificationJump.roomId)) return;
    const eventId = notificationJump.eventId;
    if (!eventId) return;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) onNotificationJumpConsumed?.();
    };
    const msgs = messagesSnapshotRef.current;
    const inWindow = msgs.some((m) => m.eventId === eventId);
    if (inWindow) {
      requestAnimationFrame(() => {
        scrollToMessage(eventId);
        finish();
      });
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        if (notificationJump.roomId === activeRoom.id) {
          await loadMessagesAroundEvent(eventId);
        } else {
          await loadHistoryAround(notificationJump.roomId, eventId);
        }
      } finally {
        if (cancelled) return;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!cancelled) {
              scrollToMessage(eventId);
              finish();
            }
          });
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDraft, activeRoom?.id, activeRoom?.historyRoomIds, notificationJump, loadMessagesAroundEvent, loadHistoryAround, onNotificationJumpConsumed, scrollToMessage]);

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
            <DmCallButtons unavailable="Open a joined direct message to call" />
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
              onAutoFocus={onComposerAutoFocus}
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

  const isOneToOne = isOneToOneChatUi(activeRoom);
  const isGroupChat = isDmChatUi(activeRoom) && !isOneToOne;
  const topic = activeRoom.topic?.trim();
  const encryptionLabel = activeRoom.isEncrypted === true
    ? (isOneToOne ? "Encrypted chat" : isGroupChat ? "Encrypted group chat" : "Encrypted room")
    : undefined;
  const caption = topic || encryptionLabel || (isOneToOne ? "Direct message" : isGroupChat ? "Group chat" : undefined);
  const RoomIcon = activeRoom.isRss ? Rss : isGroupChat ? MessageCircle : Hash;
  const roomHeading = (
    <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: spacing.unit * 2 }}>
      <RoomHeaderTitle
        name={isOneToOne ? effectiveDmTitle(activeRoom) : activeRoom.name}
        caption={caption}
        style={rssFeed ? { flex: "0 1 auto", maxWidth: "55%" } : undefined}
      />
      {rssFeed && (
        <>
          <span aria-hidden="true" style={{
            width: 4, height: 4, flexShrink: 0, borderRadius: "50%", background: palette.textSecondary,
          }} />
          <RssFeedStatusToggle feed={rssFeed} botUserId={rssBot} panelId={rssPanelId} buttonRef={rssButtonRef} />
        </>
      )}
    </div>
  );
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
      {isOneToOne ? (
        <div style={dmBannerStyle}>
          {isMobile && onOpenNavigation && (
            <NavBackButton onClick={onOpenNavigation} palette={palette} />
          )}
          <RoomHeaderIcon encryptionLabel={encryptionLabel} announceEncryption={Boolean(topic)} avatar>
            <UserAvatar
              userId={activeRoom.dmPeerUserId ?? activeRoom.id}
              displayName={effectiveDmTitle(activeRoom)}
              avatarUrlHint={activeRoom.isDirect ? activeRoom.avatarUrl : undefined}
              size={32}
            />
          </RoomHeaderIcon>
          {roomHeading}
          <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 0.5, flexShrink: 0 }}>
            <PinnedMessagesMenu
              roomId={activeRoom.id}
              open={pinnedMenuOpen}
              onOpenChange={setPinnedMenuOpen}
              onSelectEventId={handleSelectPinnedMessage}
            />
            <RoomDownloadsButton roomId={activeRoom.id} />
            {!callContent && <DmCallButtons onStartCall={onStartCall} unavailable={callUnavailable} />}
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
          {isMobile && onOpenNavigation && (
            <NavBackButton onClick={onOpenNavigation} palette={palette} />
          )}
          <RoomHeaderIcon encryptionLabel={encryptionLabel} announceEncryption={Boolean(topic)}>
            <RoomIcon size={20} color={palette.textSecondary} style={{ flexShrink: 0 }} />
          </RoomHeaderIcon>
          {roomHeading}
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
            {isGroupChat && !callContent && <DmCallButtons group onStartCall={onStartCall} unavailable={callUnavailable} />}
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

      {callContent}

      {/* Content area: messages + optional user menu */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        overflow: "hidden",
      }}>
        {/* Messages column */}
        <div style={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          backgroundColor: palette.bgPrimary,
        }}>
          {unavailable.hasUnavailable && !unavailable.warningIgnored && !initialLoading && <UnavailableMessagesNotice
            acknowledged={unavailable.acknowledged} busy={unavailable.busy} error={unavailable.error} isAtLatest={isAtLatest}
            canClear={unavailable.canClear}
            onClear={() => { void unavailable.clearNotification(); }}
            onRecover={() => { setRecoveryOpen(true); void encryption.refresh(); }}
            onIgnore={unavailable.ignoreWarning}
            onJumpToRecent={() => { void jumpToRecent(); }}
          />}
          {rssFeed && <RssFeedStatusPanel feed={rssFeed} id={rssPanelId} onHide={() => {
            rssFeed.setExpanded(false);
            rssButtonRef.current?.focus();
          }} />}
          {activeRoom.upgradePending && (
            <div style={{ padding: spacing.unit * 2, borderBottom: `1px solid ${palette.border}` }}>
              This room was upgraded.{" "}
              <button type="button" disabled={retryingUpgrade} onClick={() => void retryUpgrade()}>
                {retryingUpgrade ? "Joining…" : "Open replacement"}
              </button>
              {upgradeResult?.roomId === activeRoom.id && <div role="status">{upgradeResult.message}</div>}
            </div>
          )}
          <MessageList
            ref={messageListRef}
            messages={timeline}
            rssArticles={rssRoomId ? rssThreads.articles : undefined}
            rssReplies={rssThreads.replies}
            rssReplyCounts={replyCounts}
            activeRssThreadId={activeThread?.root.eventId}
            onOpenRssThread={rssRoomId ? openThread : undefined}
            loadingOlder={loadingOlder || history.loading}
            initialLoading={initialLoading}
            hasOlder={hasOlder || history.hasOlder}
            historyError={history.error}
            hasUpgradeHistory={!!activeRoom.historyRoomIds?.length}
            isAtLatest={isAtLatest}
            latestEventId={latestEventId}
            automaticReadBlocked={unavailable.blocked}
            privateReadOnly={unavailable.privateOnly}
            acknowledgedThrough={unavailable.acknowledgedThrough}
            onLoadOlder={hasOlder ? loadOlder : history.loadOlder}
            onLoadNewer={loadNewer}
            pendingRecentCount={pendingRecentCount}
            showJumpToRecent={showJumpToRecent}
            onJumpToRecent={jumpToRecent}
            roomId={activeRoom.id}
            userId={userId}
            callPeerUserId={activeRoom.dmPeerUserId}
            redactionPolicy={redactionPolicy}
            onRequestEdit={handleRequestEdit}
            onRequestReply={handleRequestReply}
            onReplyPreviewClick={handleReplyPreviewClick}
            allowReply={!activeRoom.upgradePending && canSendMessages === true}
            onMessagesMutated={refresh}
            onMessageRemoved={removeMessageById}
            onLocalReactionFromChip={applyLocalReactionFromChip}
            canPinMessages={canPinMessages === true}
            pinnedEventIds={pinnedEventIds}
            onPinnedStateChanged={handlePinnedStateChanged}
            onOpenSenderProfile={setMessageSenderProfileUserId}
            onSenderContextMenu={openSenderMenu}
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
              onAutoFocus={onComposerAutoFocus}
              roomId={activeRoom.id}
              roomName={activeRoom.name}
              allowWindowFileDrop={!activeThread}
              composerPermission={
                activeRoom.upgradePending
                  ? "forbidden"
                  : canSendMessages === null
                  ? "loading"
                  : canSendMessages
                    ? "allowed"
                    : "forbidden"
              }
              onMessageSent={refresh}
              replyDraft={replyDraft && !ignoredUsers.has(replyDraft.sender) ? replyDraft : null}
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
          {activeThread && (
            <RssThreadDrawer
              key={activeThread.root.eventId}
              thread={activeThread}
              roomId={activeRoom.id}
              roomName={activeRoom.name}
              userId={userId}
              userName={selfProfile.displayName}
              userAvatar={selfProfile.avatarUrl}
              windowReplies={rssThreads.replies.get(activeThread.root.eventId) ?? NO_THREAD_REPLIES}
              composerPermission={
                canSendMessages === null
                  ? "loading"
                  : canSendMessages ? "allowed" : "forbidden"
              }
              fileSendBridge={fileSendBridge}
              redactionPolicy={redactionPolicy}
              onClose={closeThread}
              onCountChange={updateThreadCount}
              onOpenSenderProfile={setMessageSenderProfileUserId}
              onSenderContextMenu={openSenderMenu}
              onRoomMessagesMutated={refresh}
              jumpEventId={selectedThread?.jumpEventId}
            />
          )}
        </div>

        {/* User menu: inline on desktop, right drawer on mobile */}
        {!isMobile && showUsers && !isOneToOne && (
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
              onMemberContextMenu={openMemberMenu}
              onOpenProfile={setMessageSenderProfileUserId}
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

      {isMobile && !isOneToOne && (
        <SideDrawer
          open={showUsers}
          onClose={() => setShowUsers(false)}
          side="right"
          widthPx={userMenuPanelWidth}
        >
          <UserMenu
            width={userMenuPanelWidth}
            roomId={activeRoom.id}
            userId={userId}
            onMemberContextMenu={openMemberMenu}
            onOpenProfile={setMessageSenderProfileUserId}
          />
        </SideDrawer>
      )}

      {recoveryOpen && <Dialog aria-labelledby="chat-recovery-title"
        onClose={() => { if (!encryption.busy) { setRecoveryOpen(false); void refresh(); } }} style={{ width: 480, padding: 24 }}>
        <h2 id="chat-recovery-title" style={{ margin: "0 0 16px", fontSize: typography.fontSizeLarge }}>Recover encrypted messages</h2>
        <EncryptionSettingsPanel compact />
        <button type="button" disabled={!!encryption.busy} onClick={() => { setRecoveryOpen(false); void refresh(); }}
          style={{ marginTop: 16, padding: "8px 12px", borderRadius: 8, border: `1px solid ${palette.border}`,
            background: palette.bgTertiary, color: palette.textPrimary, font: "inherit", cursor: "pointer" }}>Close</button>
      </Dialog>}

      {messageSenderProfileUserId && (
        <UserProfileDialog
          roomId={activeRoom.id}
          userId={messageSenderProfileUserId}
          currentUserId={userId}
          onClose={() => setMessageSenderProfileUserId(null)}
          onStartDirectMessage={onStartDirectMessage}
          onOpenActions={isMobile ? openMemberMenu : undefined}
        />
      )}
      <RoomMemberContextMenu
        key={activeRoom.id}
        onCallMember={onCallMember}
        target={memberMenu?.roomId === activeRoom.id ? memberMenu : null}
        roomId={activeRoom.id}
        roomName={activeRoom.name}
        currentUserId={userId}
        moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
        moderationSpaceName={moderationSpaceName}
        onClose={closeMemberMenu}
        onOpenProfile={setMessageSenderProfileUserId}
        onStartDirectMessage={onStartDirectMessage}
      />
    </div>
  );
}

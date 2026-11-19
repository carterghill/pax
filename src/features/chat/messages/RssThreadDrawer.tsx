import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, MessageSquare, X } from "lucide-react";
import MessageInput, { type ComposerPermission, type EditingMessageRef, type MessageFileSendBridge } from "../../../components/MessageInput";
import MessageList, { type MessageListHandle } from "../../../components/MessageList";
import {
  applyMessageEdit,
  applyReactionDelta,
  type MessageEditPayload,
  type MessageRedactedPayload,
  type RoomMessagePayload,
  type RoomMessageReactionPayload,
} from "../../../hooks/useMessages";
import { useTheme } from "../../../theme/ThemeContext";
import type { Message, RoomRedactionPolicy } from "../../../types/matrix";
import { getRssThreadReplies } from "../api";
import type { SentThreadReply } from "../composer/useComposerSubmit";
import { mergeThreadReplies, rssThreadReplyCount, type RssThread } from "./rssThreads";
import "./rssThreadDrawer.css";

interface RssThreadDrawerProps {
  thread: RssThread;
  roomId: string;
  roomName: string;
  userId: string;
  userName: string | null;
  userAvatar: string | null;
  windowReplies: Message[];
  composerPermission: ComposerPermission;
  fileSendBridge: MessageFileSendBridge | null;
  redactionPolicy: RoomRedactionPolicy;
  onClose: () => void;
  onCountChange: (eventId: string, count: number) => void;
  onOpenSenderProfile: (userId: string) => void;
  onRoomMessagesMutated: () => void;
  jumpEventId?: string;
}

export default function RssThreadDrawer({
  thread,
  roomId,
  roomName,
  userId,
  userName,
  userAvatar,
  windowReplies,
  composerPermission,
  fileSendBridge,
  redactionPolicy,
  onClose,
  onCountChange,
  onOpenSenderProfile,
  onRoomMessagesMutated,
  jumpEventId,
}: RssThreadDrawerProps) {
  const { palette, spacing, typography } = useTheme();
  const titleId = useId();
  const listRef = useRef<MessageListHandle>(null);
  const highlightedReply = useRef<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootId = thread.root.eventId;
  const [fetched, setFetched] = useState<Message[]>([]);
  const [live, setLive] = useState<Message[]>([]);
  const [edits, setEdits] = useState(new Map<string, MessageEditPayload>());
  const [removed, setRemoved] = useState(new Set<string>());
  const [reactions, setReactions] = useState<RoomMessageReactionPayload[]>([]);
  const [nextPage, setNextPage] = useState<string | null | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editingMessage, setEditingMessage] = useState<EditingMessageRef | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const loadLock = useRef<symbol | null>(null);

  const load = useCallback(async (from: string | null) => {
    if (loadLock.current) return;
    const request = Symbol();
    loadLock.current = request;
    setLoading(true);
    setLoadError(false);
    try {
      const batch = await getRssThreadReplies({ roomId, eventId: rootId, from });
      if (loadLock.current !== request) return;
      setFetched((previous) => mergeThreadReplies(batch.messages, previous));
      setNextPage(batch.prevBatch);
    } catch {
      if (loadLock.current === request) setLoadError(true);
    } finally {
      if (loadLock.current === request) {
        loadLock.current = null;
        setLoading(false);
      }
    }
  }, [roomId, rootId]);

  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    void load(null);
    return () => {
      loadLock.current = null;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [load]);

  const removeReply = useCallback((eventId: string) => {
    setRemoved((previous) => new Set([...previous, eventId]));
  }, []);

  useEffect(() => {
    const subscriptions = [
      listen<RoomMessagePayload>("room-message", ({ payload }) => {
        if (payload.roomId !== roomId) return;
        const msg = payload.message;
        if (msg.threadRootId === rootId || (!msg.threadRootId && msg.replyTo?.eventId === rootId)) {
          setLive((previous) => mergeThreadReplies(previous, [msg]));
        }
      }),
      listen<MessageRedactedPayload>("room-message-redacted", ({ payload }) => {
        if (payload.roomId !== roomId) return;
        if (payload.redactedEventId === rootId) onClose();
        else removeReply(payload.redactedEventId);
      }),
      listen<MessageEditPayload>("room-message-edit", ({ payload }) => {
        if (payload.roomId === roomId) setEdits((previous) => new Map(previous).set(payload.targetEventId, payload));
      }),
      listen<RoomMessageReactionPayload>("room-message-reaction", ({ payload }) => {
        if (payload.roomId === roomId) setReactions((previous) => [...previous, payload]);
      }),
    ];
    return () => {
      for (const sub of subscriptions) void sub.then((stop) => stop(), () => {});
    };
  }, [onClose, removeReply, roomId, rootId]);

  const replies = useMemo(() => {
    // A synced attachment can arrive before the upload row has been reconciled.
    const confirmedIds = new Set([...fetched, ...live].map((message) => message.eventId));
    const window = windowReplies.filter((message) => !message.localFileUpload || !confirmedIds.has(message.eventId));
    let next = mergeThreadReplies(fetched, live, window)
      .filter((message) => !removed.has(message.eventId));
    for (const message of next) {
      const edit = edits.get(message.eventId);
      if (edit) next = applyMessageEdit(next, edit);
    }
    // The room timeline has already applied reaction sync for replies in its window.
    const windowIds = new Set(windowReplies.map((message) => message.eventId));
    for (const reaction of reactions) {
      if (!windowIds.has(reaction.targetEventId)) next = applyReactionDelta(next, reaction, userId, null);
    }
    return next;
  }, [edits, fetched, live, reactions, removed, userId, windowReplies]);

  const sentReplies = replies.filter((reply) => !reply.eventId.startsWith("local:"));
  const replyCount = nextPage === null ? sentReplies.length : rssThreadReplyCount(thread.root, sentReplies);
  useEffect(() => {
    onCountChange(rootId, replyCount);
  }, [onCountChange, replyCount, rootId]);

  useEffect(() => {
    if (!jumpEventId || highlightedReply.current === jumpEventId
      || !replies.some((reply) => reply.eventId === jumpEventId)) return;
    const frame = requestAnimationFrame(() => {
      highlightedReply.current = jumpEventId;
      listRef.current?.scrollToEventId(jumpEventId, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpEventId, replies]);

  const title = thread.article.headline ?? thread.article.hostname;
  const latest = sentReplies.slice().reverse().find((message) => message.threadRootId === rootId);
  const summary = thread.root.threadSummary;
  const latestEventId = latest && latest.timestamp >= (summary?.latestTimestamp ?? 0)
    ? latest.eventId
    : summary?.latestEventId;
  const threadTarget = useMemo(() => ({ rootEventId: rootId, latestEventId }), [rootId, latestEventId]);

  const handleMessageSent = (reply?: SentThreadReply) => {
    if (reply) {
      setLive((previous) => mergeThreadReplies([{
        ...reply,
        sender: userId,
        senderName: userName,
        avatarUrl: userAvatar,
        timestamp: Date.now(),
        threadRootId: rootId,
      }], previous));
    } else {
      onRoomMessagesMutated();
    }
  };

  return (
    <div className="pax-rss-thread-layer">
      <div className="pax-rss-thread-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        className="pax-rss-thread-drawer"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            onClose();
          }
        }}
        style={{
          background: palette.bgPrimary,
          borderLeft: `1px solid ${palette.border}`,
          boxShadow: "-8px 0 24px rgba(0, 0, 0, 0.18)",
        }}
      >
        <header style={{
          display: "flex",
          flexShrink: 0,
          alignItems: "flex-start",
          gap: spacing.unit * 3,
          padding: spacing.unit * 4,
          borderBottom: `1px solid ${palette.border}`,
          background: palette.bgSecondary,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={titleId} style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit * 2,
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
              margin: 0,
            }}>
              <MessageSquare size={16} aria-hidden="true" /> Thread
            </h2>
            <a
              href={thread.article.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                overflowWrap: "anywhere",
                marginTop: spacing.unit,
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
              }}
              title={title}
            >
              {title} <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
          <button ref={closeRef} type="button" className="pax-rss-thread-button" aria-label="Close thread" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        {loadError && (
          <div role="status" style={{ padding: spacing.unit * 3, color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>
            Couldn’t load replies.{" "}
            <button type="button" className="pax-rss-thread-button" onClick={() => void load(nextPage ?? null)}>Retry</button>
          </div>
        )}
        <MessageList
          ref={listRef}
          replyDrawer
          messages={replies}
          loadingOlder={loading && nextPage !== undefined}
          initialLoading={nextPage === undefined && !loadError && replies.length === 0}
          hasOlder={typeof nextPage === "string"}
          isAtLatest
          automaticReadBlocked
          onLoadOlder={() => { if (nextPage) void load(nextPage); }}
          onLoadNewer={() => {}}
          pendingRecentCount={0}
          showJumpToRecent={false}
          onJumpToRecent={() => {}}
          roomId={roomId}
          userId={userId}
          redactionPolicy={redactionPolicy}
          onRequestEdit={(message) => {
            setSendError(null);
            setEditingMessage(message);
          }}
          onRequestReply={() => {}}
          onReplyPreviewClick={() => {}}
          allowReply={false}
          onMessagesMutated={onRoomMessagesMutated}
          onMessageRemoved={removeReply}
          onLocalReactionFromChip={() => {}}
          onOpenSenderProfile={onOpenSenderProfile}
        />

        <div style={{
          flexShrink: 0,
          paddingTop: spacing.unit * 3,
          borderTop: `1px solid ${palette.border}`,
        }}>
          {sendError && (
            <div role="alert" style={{
              padding: `0 ${spacing.unit * 3}px ${spacing.unit * 2}px`,
              color: palette.textPrimary,
              fontSize: typography.fontSizeSmall,
            }}>
              {sendError}
            </div>
          )}
          <MessageInput
            roomId={roomId}
            roomName={roomName}
            thread={threadTarget}
            onMessageSent={handleMessageSent}
            onSendError={setSendError}
            editingMessage={editingMessage}
            onCancelEdit={() => setEditingMessage(null)}
            composerPermission={composerPermission}
            selfUserId={userId}
            selfDisplayName={userName}
            selfAvatarUrl={userAvatar}
            fileSendBridge={fileSendBridge}
          />
        </div>
      </aside>
    </div>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Picker } from "emoji-mart";
import data from "@emoji-mart/data";
import { ArrowDown } from "lucide-react";
import { Message, MessageReaction, RoomRedactionPolicy } from "../types/matrix";
import { useResolveMemberLabel } from "../hooks/useResolveMemberLabel";
import { useTheme } from "../theme/ThemeContext";
import MediaViewerModal, {
  type MediaViewerOpenPayload,
} from "./MediaViewerModal";
import { fileNameFromImageUrl } from "../utils/directImageUrl";
import { useReadReceiptSender } from "../hooks/useReadReceiptSender";
import MessageRow from "../features/chat/messages/MessageRow";
import {
  shouldShowHeader,
  getReplyThreadPreview,
  reactionHoverLines,
  messageAllowsEdit,
  messageAllowsDelete,
} from "../features/chat/messages/messageListUtils";
import LoadingSkeletons from "../features/chat/messages/LoadingSkeletons";
import MessageActionMenu from "../features/chat/messages/MessageActionMenu";
import { useActionBarPopover } from "../features/chat/messages/useActionBarPopover";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export type MessageListHandle = {
  scrollToEventId: (eventId: string) => void;
};

interface MessageListProps {
  messages: Message[];
  loadingOlder: boolean;
  initialLoading: boolean;
  hasOlder: boolean;
  isAtLatest: boolean;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  pendingRecentCount: number;
  showJumpToRecent: boolean;
  onJumpToRecent: () => void | Promise<void>;
  roomId: string;
  userId: string;
  redactionPolicy: RoomRedactionPolicy;
  onRequestEdit: (msg: Message) => void;
  /** Reply composer target (cleared on send or Escape in composer). */
  onRequestReply: (msg: Message) => void;
  onReplyPreviewClick: (eventId: string) => void;
  /** When false, the reply action is hidden (e.g. read-only room). */
  allowReply: boolean;
  onMessagesMutated: () => void;
  onMessageRemoved: (eventId: string) => void;
  /** After successful send/remove; keeps UI in sync and dedupes sync echo. */
  onLocalReactionFromChip: (
    targetEventId: string,
    key: string,
    wasReactedByMe: boolean,
  ) => void;
  /** When set, show Pin / Unpin in the message menu for users with pin power. */
  canPinMessages?: boolean;
  pinnedEventIds?: string[];
  onPinnedStateChanged?: () => void;
  /** Opens the room member profile for the message sender (avatar + name). */
  onOpenSenderProfile?: (senderUserId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const AUTO_SCROLL_THRESHOLD_PX = 200;
const SKELETON_COUNT = 4;
const MESSAGE_ACTIONS_MENU_Z = 10_000;
const REACTION_POPOVER_IGNORE = ["[data-message-reaction-popover]"];


/* ------------------------------------------------------------------ */
/*  MessageList                                                        */
/* ------------------------------------------------------------------ */

const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages,
    loadingOlder,
    initialLoading,
    hasOlder,
    isAtLatest,
    onLoadOlder,
    onLoadNewer,
    pendingRecentCount,
    showJumpToRecent,
    onJumpToRecent,
    roomId,
    userId,
    redactionPolicy,
    onRequestEdit,
    onRequestReply,
    onReplyPreviewClick,
    allowReply,
    onMessagesMutated,
    onMessageRemoved,
    onLocalReactionFromChip,
    canPinMessages = false,
    pinnedEventIds = [],
    onPinnedStateChanged,
    onOpenSenderProfile,
  },
  ref,
) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const pinnedSet = useMemo(
    () => new Set(pinnedEventIds),
    [pinnedEventIds],
  );

  const { resolveMemberLabel } = useResolveMemberLabel(roomId);

  /* ---- Refs ---- */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /** Grows with message rows / media; observed so we can pin scroll when content height changes. */
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    scrollToEventId: (eventId: string) => {
      const root = scrollContainerRef.current;
      if (!root) return;
      const el = root.querySelector(
        `[data-message-event-id="${CSS.escape(eventId)}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    },
  }));
  const shouldAutoScrollRef = useRef(true);
  const reactionPickerMountRef = useRef<HTMLDivElement>(null);
  const reactionPickerMountKeyRef = useRef<string | null>(null);

  /**
   * React-visible mirror of `shouldAutoScrollRef` so `useReadReceiptSender`'s
   * effect re-evaluates when the user scrolls to or away from the bottom.  We
   * keep the ref as the source of truth for the hot scroll path (avoids extra
   * renders) and only commit to state when the boolean value actually flips.
   */
  const [atBottom, setAtBottom] = useState(true);

  /* ---- Popover hooks ---- */
  const menu = useActionBarPopover({
    scrollContainerRef,
    spacingUnit: spacing.unit,
  });
  const reactionPicker = useActionBarPopover({
    scrollContainerRef,
    spacingUnit: spacing.unit,
    ignoreSelectors: REACTION_POPOVER_IGNORE,
  });

  /* ---- UI state ---- */
  const [mediaViewer, setMediaViewer] = useState<MediaViewerOpenPayload | null>(
    null,
  );
  const reactionTooltipAnchorRef = useRef<HTMLElement | null>(null);
  const [reactionTooltip, setReactionTooltip] = useState<{
    left: number;
    top: number;
    lines: string[];
  } | null>(null);

  const syncReactionTooltipPosition = useCallback(() => {
    const el = reactionTooltipAnchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = r.right + 8;
    const top = r.top + r.height / 2;
    setReactionTooltip((prev) => {
      if (!prev) return null;
      const eps = 0.5;
      if (
        Math.abs(prev.left - left) < eps &&
        Math.abs(prev.top - top) < eps
      ) {
        return prev;
      }
      return { ...prev, left, top };
    });
  }, []);

  const reactionTooltipActive = reactionTooltip != null;

  useEffect(() => {
    if (!reactionTooltipActive) return;
    syncReactionTooltipPosition();
    const cont = scrollContainerRef.current;
    cont?.addEventListener("scroll", syncReactionTooltipPosition, {
      passive: true,
    });
    window.addEventListener("resize", syncReactionTooltipPosition);
    return () => {
      cont?.removeEventListener("scroll", syncReactionTooltipPosition);
      window.removeEventListener("resize", syncReactionTooltipPosition);
    };
  }, [reactionTooltipActive, syncReactionTooltipPosition]);

  /* ---- Stable callbacks ---- */
  const openDirectImage = useCallback(
    (url: string, title: string) => {
      setMediaViewer({
        kind: "image",
        directUrl: url,
        fileName: title || fileNameFromImageUrl(url),
        mimeType: /\.gif([?#]|$)/i.test(url) ? "image/gif" : null,
        roomId,
      });
    },
    [roomId],
  );

  const openMediaViewer = useCallback(
    (p: MediaViewerOpenPayload) => setMediaViewer({ ...p, roomId }),
    [roomId],
  );

  const handleOpenMenu = useCallback((eventId: string) => {
    reactionPicker.setOpenId(null);
    menu.setOpenId((id) => (id === eventId ? null : eventId));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpenId is stable (useState setter)
  }, []);

  const handleToggleReactionPicker = useCallback((eventId: string) => {
    menu.setOpenId(null);
    reactionPicker.setOpenId((id) => (id === eventId ? null : eventId));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpenId is stable (useState setter)
  }, []);

  const handlePickReaction = useCallback(
    async (eventId: string, nativeEmoji: string) => {
      reactionPicker.setOpenId(null);
      try {
        await invoke("send_room_reaction", {
          roomId,
          targetEventId: eventId,
          emoji: nativeEmoji,
        });
        onLocalReactionFromChip(eventId, nativeEmoji, false);
      } catch (e) {
        console.error("Failed to send reaction:", e);
      }
    },
    [roomId, onLocalReactionFromChip],
  );

  const handleReactionChipClick = useCallback(
    async (targetEventId: string, key: string, reactedByMe: boolean) => {
      try {
        if (reactedByMe) {
          await invoke("remove_room_reaction", {
            roomId,
            targetEventId,
            key,
          });
        } else {
          await invoke("send_room_reaction", {
            roomId,
            targetEventId,
            emoji: key,
          });
        }
        onLocalReactionFromChip(targetEventId, key, reactedByMe);
      } catch (e) {
        console.error("Failed to toggle reaction:", e);
      }
    },
    [roomId, onLocalReactionFromChip],
  );

  const handleReactionChipHover = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, r: MessageReaction) => {
      reactionTooltipAnchorRef.current = e.currentTarget;
      const rect = e.currentTarget.getBoundingClientRect();
      const lines = reactionHoverLines(r, resolveMemberLabel, userId);
      setReactionTooltip({
        left: rect.right + 8,
        top: rect.top + rect.height / 2,
        lines,
      });
    },
    [resolveMemberLabel, userId],
  );

  const handleReactionChipHoverEnd = useCallback(() => {
    reactionTooltipAnchorRef.current = null;
    setReactionTooltip(null);
  }, []);

  /* ================================================================ */
  /*  Room change: reset                                               */
  /* ================================================================ */

  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true;
    setAtBottom(true);
    menu.setOpenId(null);
    reactionPicker.setOpenId(null);
    setMediaViewer(null);
    reactionTooltipAnchorRef.current = null;
    setReactionTooltip(null);
  // menu.setOpenId / reactionPicker.setOpenId are stable useState setters
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  /* ================================================================ */
  /*  Auto-scroll to bottom on new messages                            */
  /* ================================================================ */

  const lastId = messages[messages.length - 1]?.eventId ?? null;

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    if (initialLoading) return;

    const run = () => {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      bottomRef.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
      // Programmatic scroll does not always emit `scroll`; keep read-receipt + pin state in sync.
      shouldAutoScrollRef.current = true;
      setAtBottom(true);
    };

    run();
    // Second frame: flex + async image/layout can leave scrollHeight short on first paint.
    const raf = requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    return () => cancelAnimationFrame(raf);
  }, [lastId, messages.length, initialLoading, roomId]);

  /* ================================================================ */
  /*  Preserve scroll position on prepend                              */
  /*                                                                   */
  /*  The browser's native `overflow-anchor` adjustment is suppressed  */
  /*  when the scroll container is at (or very near) scrollTop = 0,    */
  /*  which is exactly where users land when they scroll up to trigger */
  /*  a load of older history. To keep their reading position stable,  */
  /*  we track the first message's viewport offset across renders and  */
  /*  compensate for any shift by adjusting scrollTop ourselves.       */
  /*                                                                   */
  /*  Measuring *viewport* offset (offsetTop − scrollTop) rather than  */
  /*  raw offsetTop makes this correct whether or not the browser's    */
  /*  anchoring already kicked in: if it did, delta === 0 and we no-op.*/
  /* ================================================================ */

  const anchorRef = useRef<{ id: string; viewportTop: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    if (
      anchorRef.current &&
      !shouldAutoScrollRef.current &&
      !initialLoading
    ) {
      const { id, viewportTop: prevViewportTop } = anchorRef.current;
      const anchorEl = el.querySelector(
        `[data-message-event-id="${CSS.escape(id)}"]`,
      ) as HTMLElement | null;
      if (anchorEl) {
        const currentViewportTop = anchorEl.offsetTop - el.scrollTop;
        const delta = currentViewportTop - prevViewportTop;
        if (delta !== 0) {
          el.scrollTop += delta;
        }
      }
    }

    const firstMsg = messages[0];
    if (firstMsg) {
      const firstEl = el.querySelector(
        `[data-message-event-id="${CSS.escape(firstMsg.eventId)}"]`,
      ) as HTMLElement | null;
      anchorRef.current = firstEl
        ? {
            id: firstMsg.eventId,
            viewportTop: firstEl.offsetTop - el.scrollTop,
          }
        : null;
    } else {
      anchorRef.current = null;
    }
  }, [messages, initialLoading]);

  // Clear the anchor when switching rooms so the new room's first render
  // doesn't try to compensate against an id from the previous room.
  useLayoutEffect(() => {
    anchorRef.current = null;
  }, [roomId]);

  /* ================================================================ */
  /*  Scroll handler: track auto-scroll + trigger loads                */
  /* ================================================================ */

  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const onLoadNewerRef = useRef(onLoadNewer);
  onLoadNewerRef.current = onLoadNewer;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const isAtLatestRef = useRef(isAtLatest);
  isAtLatestRef.current = isAtLatest;
  const loadingOlderRef = useRef(loadingOlder);
  loadingOlderRef.current = loadingOlder;

  const loadCooldownRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  /** Tracks the previous value of loadingOlder to detect completion. */
  const wasLoadingOlderRef = useRef(false);

  /* ================================================================ */
  /*  Read receipts                                                    */
  /* ================================================================ */

  // Acknowledge the latest rendered event once the user appears to have seen
  // it — i.e. we're on the tail page of history AND they're pinned near the
  // bottom.  The hook also gates internally on window focus/visibility so that
  // a backgrounded tab doesn't silently mark rooms as read.  Whether the
  // receipt is public (`m.read`) or private (`m.read.private`) is decided
  // inside the hook from the user's setting (see `readReceiptPrefs`).
  useReadReceiptSender(
    roomId,
    {
      latestVisibleEventId: lastId,
      atBottom: isAtLatest && atBottom,
    },
    userId,
  );

  const TRIGGER_THRESHOLD = 400;
  const COOLDOWN_MS = 500;

  const tryTriggerLoadOlder = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (loadCooldownRef.current) return;
    if (loadingOlderRef.current) return;
    if (!hasOlderRef.current) return;
    if (el.scrollTop >= TRIGGER_THRESHOLD) return;

    console.log("[MessageList] → triggering loadOlder", {
      scrollTop: Math.round(el.scrollTop),
    });
    loadCooldownRef.current = true;
    setTimeout(() => {
      loadCooldownRef.current = false;
    }, COOLDOWN_MS);
    onLoadOlderRef.current();
  }, []);

  const tryTriggerLoadNewer = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (loadCooldownRef.current) return;
    if (loadingOlderRef.current) return;
    if (isAtLatestRef.current) return;
    const distFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom >= TRIGGER_THRESHOLD) return;

    console.log("[MessageList] → triggering loadNewer", {
      distFromBottom: Math.round(distFromBottom),
    });
    loadCooldownRef.current = true;
    setTimeout(() => {
      loadCooldownRef.current = false;
    }, COOLDOWN_MS);
    onLoadNewerRef.current();
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;

      const scrollTop = el.scrollTop;
      const distFromBottom =
        el.scrollHeight - scrollTop - el.clientHeight;
      const nextAtBottom =
        distFromBottom < AUTO_SCROLL_THRESHOLD_PX ||
        // Short timelines: no overflow, or sub-pixel noise at the tail.
        (el.scrollHeight <= el.clientHeight + 2 && el.scrollTop <= 2);
      if (shouldAutoScrollRef.current !== nextAtBottom) {
        shouldAutoScrollRef.current = nextAtBottom;
        // Only commit the state mirror on flips — this runs inside the scroll
        // rAF and must not cause a render per frame.
        setAtBottom(nextAtBottom);
      }

      // Keep the prepend-preservation anchor fresh. Without this, the stored
      // viewportTop reflects whatever scroll position we were at the last
      // time `messages` changed (often the bottom, right after initial load)
      // which would cause the prepend compensation to mis-calculate delta
      // and whip the user to a wildly wrong scroll position.
      const firstAnchorEl = el.querySelector(
        "[data-message-event-id]",
      ) as HTMLElement | null;
      if (firstAnchorEl) {
        const id = firstAnchorEl.getAttribute("data-message-event-id");
        if (id) {
          anchorRef.current = {
            id,
            viewportTop: firstAnchorEl.offsetTop - scrollTop,
          };
        }
      }

      console.log("[MessageList] scroll", {
        scrollTop: Math.round(scrollTop),
        distFromBottom: Math.round(distFromBottom),
        cooldown: loadCooldownRef.current,
        loadingOlder: loadingOlderRef.current,
      });

      tryTriggerLoadOlder();
      tryTriggerLoadNewer();
    });
  }, [tryTriggerLoadOlder, tryTriggerLoadNewer]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null)
        cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  /* ================================================================ */
  /*  Re-check triggers on load completion                             */
  /*                                                                   */
  /*  If user is still at scrollTop=0 after the load (either because   */
  /*  overflow-anchor didn't push them away, or because they're        */
  /*  actively pinned at the top), this re-fires the trigger so they   */
  /*  keep loading instead of being stuck.                             */
  /* ================================================================ */

  useEffect(() => {
    const wasLoading = wasLoadingOlderRef.current;
    wasLoadingOlderRef.current = loadingOlder;
    if (wasLoading && !loadingOlder) {
      console.log("[MessageList] load completed, re-checking triggers");
      // Defer one frame so overflow-anchor / measurement adjustments
      // land before we read scrollTop.
      requestAnimationFrame(() => {
        tryTriggerLoadOlder();
        tryTriggerLoadNewer();
      });
    }
  }, [loadingOlder, tryTriggerLoadOlder, tryTriggerLoadNewer]);

  /* ================================================================ */
  /*  Container resize: keep at bottom when shrinking                  */
  /* ================================================================ */

  useEffect(() => {
    const outer = scrollContainerRef.current;
    const inner = scrollContentRef.current;
    if (!outer || !inner) return;

    let prevOuterH = outer.clientHeight;
    const pinIfFollowing = () => {
      if (!shouldAutoScrollRef.current) return;
      outer.scrollTop = outer.scrollHeight;
      bottomRef.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
      setAtBottom(true);
    };

    const roInner = new ResizeObserver(() => {
      pinIfFollowing();
    });
    roInner.observe(inner);

    const roOuter = new ResizeObserver(() => {
      const h = outer.clientHeight;
      if (h !== prevOuterH) {
        pinIfFollowing();
      }
      prevOuterH = h;
    });
    roOuter.observe(outer);

    return () => {
      roInner.disconnect();
      roOuter.disconnect();
    };
  }, [initialLoading, roomId]);

  /* ================================================================ */
  /*  Reaction emoji picker mount                                      */
  /* ================================================================ */

  useLayoutEffect(() => {
    if (!reactionPicker.openId) {
      reactionPickerMountKeyRef.current = null;
      if (reactionPickerMountRef.current) {
        reactionPickerMountRef.current.innerHTML = "";
      }
      return;
    }
    if (!reactionPicker.fixedPos) return;
    const mount = reactionPickerMountRef.current;
    if (!mount) return;
    const mountKey = `${reactionPicker.openId}\0${resolvedColorScheme}`;
    if (reactionPickerMountKeyRef.current === mountKey) {
      return;
    }
    reactionPickerMountKeyRef.current = mountKey;
    mount.innerHTML = "";
    const targetId = reactionPicker.openId;
    const theme = resolvedColorScheme === "light" ? "light" : "dark";
    new Picker({
      parent: mount,
      data,
      theme,
      set: "native",
      maxFrequentRows: 3,
      previewPosition: "none",
      searchPosition: "sticky",
      onEmojiSelect: (emoji: { native: string }) => {
        void handlePickReaction(targetId, emoji.native);
      },
    });
  }, [reactionPicker.openId, reactionPicker.fixedPos, resolvedColorScheme, handlePickReaction]);

  const openMenuMsg =
    menu.openId === null
      ? undefined
      : messages.find((m) => m.eventId === menu.openId);

  const messageByEventId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.eventId, m);
    return map;
  }, [messages]);

  /* ================================================================ */
  /*  Derived values                                                   */
  /* ================================================================ */

  const rowHighlight =
    resolvedColorScheme === "light"
      ? "rgba(0, 0, 0, 0.055)"
      : "rgba(255, 255, 255, 0.06)";

  const jumpToRecentLabel =
    pendingRecentCount > 0
      ? `Jump to recent (${pendingRecentCount} new)`
      : "Jump to recent";

  /* ================================================================ */
  /*  Render: initial loading                                          */
  /* ================================================================ */

  if (initialLoading) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: palette.textSecondary,
        }}
      >
        Loading messages...
      </div>
    );
  }

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        overflowAnchor: "auto",
        paddingTop: spacing.unit * 2,
        paddingBottom: spacing.unit * 6,
      }}
    >
      {/* CSS hover — no React state on mousemove */}
      <style>{`
        .pax-message-row:hover {
          background-color: ${rowHighlight} !important;
        }
        .pax-message-row .pax-message-actions {
          opacity: 0;
          pointer-events: none;
        }
        .pax-message-row:hover .pax-message-actions {
          opacity: 1;
          pointer-events: auto;
        }
      `}</style>

      <div
        ref={scrollContentRef}
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "min-content",
        }}
      >
      {/* Top: "Beginning" / "Loading" indicator */}
      <div
        style={{
          minHeight: spacing.unit * 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: spacing.unit * 2,
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          lineHeight: typography.lineHeight,
          overflowAnchor: "none",
        }}
      >
        {hasOlder
          ? loadingOlder
            ? "Loading older messages..."
            : "Scroll up for more"
          : messages.length > 0
            ? "Beginning of conversation"
            : "No messages yet"}
      </div>

      {/* Skeleton rows when loading older */}
      {loadingOlder && (
        <div style={{ overflowAnchor: "none" }}>
          <LoadingSkeletons
            count={SKELETON_COUNT}
            palette={palette}
            spacingUnit={spacing.unit}
          />
        </div>
      )}

      {/* Messages */}
      {messages.map((msg, i) => {
        const prevMsg = i > 0 ? messages[i - 1] : null;
        const showHeader = shouldShowHeader(msg, prevMsg);
        const canEdit = messageAllowsEdit(msg, userId);
        const canDelete = messageAllowsDelete(msg, userId, redactionPolicy);
        const showReplyButton =
          allowReply && !msg.eventId.startsWith("local:");
        const showOverflowMenu = canEdit || canDelete || canPinMessages;
        const canReact = !msg.eventId.startsWith("local:");
        const showHoverActions =
          showReplyButton || canReact || showOverflowMenu;

        return (
          <MessageRow
            key={msg.eventId}
            msg={msg}
            showHeader={showHeader}
            showReplyButton={showReplyButton}
            showOverflowMenu={showOverflowMenu}
            showHoverActions={showHoverActions}
            canReact={canReact}
            isMenuOpen={menu.openId === msg.eventId}
            isReactionPickerOpen={reactionPicker.openId === msg.eventId}
            onRequestReply={() => onRequestReply(msg)}
            onOpenMenu={handleOpenMenu}
            onToggleReactionPicker={handleToggleReactionPicker}
            onOpenMediaViewer={openMediaViewer}
            onOpenDirectImage={openDirectImage}
            menuAnchorRef={menu.anchorRef}
            reactionPickerAnchorRef={reactionPicker.anchorRef}
            onReactionChipClick={(key, reactedByMe) => {
              void handleReactionChipClick(msg.eventId, key, reactedByMe);
            }}
            onReactionChipHover={handleReactionChipHover}
            onReactionChipHoverEnd={handleReactionChipHoverEnd}
            rowHighlight={rowHighlight}
            spacingUnit={spacing.unit}
            palette={palette}
            typography={typography}
            resolvedColorScheme={resolvedColorScheme}
            replyThread={getReplyThreadPreview(msg, messageByEventId)}
            onReplyThreadClick={onReplyPreviewClick}
            onOpenSenderProfile={onOpenSenderProfile}
            resolveMemberLabel={resolveMemberLabel}
          />
        );
      })}

      {/* Skeleton rows at bottom when not at latest */}
      {!isAtLatest && (
        <div style={{ overflowAnchor: "none" }}>
          <LoadingSkeletons
            count={SKELETON_COUNT}
            palette={palette}
            spacingUnit={spacing.unit}
          />
        </div>
      )}

      {/* Scroll anchor target */}
      <div ref={bottomRef} style={{ overflowAnchor: "none" }} />

      {/* Jump to Recent button */}
      {showJumpToRecent && (
        <div
          style={{
            position: "sticky",
            bottom: spacing.unit * 3,
            display: "flex",
            justifyContent: "center",
            marginTop: spacing.unit * 2,
            pointerEvents: "none",
            zIndex: 3,
            overflowAnchor: "none",
          }}
        >
          <button
            type="button"
            onClick={() => {
              shouldAutoScrollRef.current = true;
              setAtBottom(true);
              void Promise.resolve(onJumpToRecent()).finally(() => {
                requestAnimationFrame(() => {
                  const el = scrollContainerRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                  bottomRef.current?.scrollIntoView({
                    block: "nearest",
                    inline: "nearest",
                  });
                });
              });
            }}
            title={jumpToRecentLabel}
            style={{
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: spacing.unit * 1.5,
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              borderRadius: 9999,
              border: `1px solid ${palette.border}`,
              backgroundColor: palette.bgSecondary,
              color: palette.textPrimary,
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              fontFamily: typography.fontFamily,
              cursor: "pointer",
              boxShadow:
                resolvedColorScheme === "light"
                  ? "0 6px 20px rgba(0,0,0,0.10)"
                  : "0 10px 28px rgba(0,0,0,0.38)",
            }}
          >
            <ArrowDown size={14} strokeWidth={2.5} />
            {jumpToRecentLabel}
          </button>
        </div>
      )}
      </div>

      {/* Context menu portal */}
      {openMenuMsg && menu.fixedPos && (
        <MessageActionMenu
          menuPortalRef={menu.portalRef}
          menuFixedPos={menu.fixedPos}
          zIndex={MESSAGE_ACTIONS_MENU_Z}
          canEdit={messageAllowsEdit(openMenuMsg, userId)}
          canPin={canPinMessages}
          isPinned={pinnedSet.has(openMenuMsg.eventId)}
          canDelete={messageAllowsDelete(openMenuMsg, userId, redactionPolicy)}
          onEdit={() => {
            menu.setOpenId(null);
            onRequestEdit(openMenuMsg);
          }}
          onPin={async () => {
            menu.setOpenId(null);
            try {
              await invoke("pin_room_message", {
                roomId,
                eventId: openMenuMsg.eventId,
              });
              onPinnedStateChanged?.();
            } catch (e) {
              console.error("Failed to pin message:", e);
            }
          }}
          onUnpin={async () => {
            menu.setOpenId(null);
            try {
              await invoke("unpin_room_message", {
                roomId,
                eventId: openMenuMsg.eventId,
              });
              onPinnedStateChanged?.();
            } catch (e) {
              console.error("Failed to unpin message:", e);
            }
          }}
          onDelete={async () => {
            menu.setOpenId(null);
            if (!window.confirm("Delete this message?")) return;
            try {
              await invoke("redact_message", {
                roomId,
                eventId: openMenuMsg.eventId,
              });
              onMessageRemoved(openMenuMsg.eventId);
              onMessagesMutated();
            } catch (e) {
              console.error("Failed to delete message:", e);
            }
          }}
          palette={palette}
          typography={typography}
          spacing={spacing}
          resolvedColorScheme={resolvedColorScheme}
        />
      )}

      {/* Reaction emoji picker (portal) */}
      {reactionPicker.openId != null &&
        reactionPicker.fixedPos != null &&
        createPortal(
          <div
            ref={reactionPicker.portalRef}
            data-message-reaction-popover
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: reactionPicker.fixedPos.top ?? undefined,
              bottom: reactionPicker.fixedPos.bottom ?? undefined,
              right: reactionPicker.fixedPos.right,
              zIndex: MESSAGE_ACTIONS_MENU_Z,
              maxHeight: `calc(100vh - ${Math.max(8, spacing.unit * 2) * 2}px)`,
              overflowX: "hidden",
              overflowY: "auto",
            }}
          >
            <div ref={reactionPickerMountRef} />
          </div>,
          document.body,
        )}

      {reactionTooltip &&
        reactionTooltip.lines.length > 0 &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: "fixed",
              left: reactionTooltip.left,
              top: reactionTooltip.top,
              transform: "translateY(-50%)",
              zIndex: 10_000,
              pointerEvents: "none",
              padding: "8px 12px",
              borderRadius: 8,
              backgroundColor: palette.bgPrimary,
              color: palette.textPrimary,
              border: `1px solid ${palette.border}`,
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.28)",
              fontSize: 13,
              fontWeight: 500,
              lineHeight: 1.35,
              maxWidth: 280,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {reactionTooltip.lines.map((line, i) => (
              <div
                key={`${i}:${line}`}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {line}
              </div>
            ))}
          </div>,
          document.body,
        )}

      {/* Media viewer */}
      <MediaViewerModal
        open={mediaViewer != null}
        onClose={() => setMediaViewer(null)}
        payload={mediaViewer}
      />
    </div>
  );
});

export default MessageList;

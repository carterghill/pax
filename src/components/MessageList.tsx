import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
  Fragment,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Picker } from "emoji-mart";
import data from "@emoji-mart/data";
import { ArrowDown, Phone } from "lucide-react";
import { Message, MessageReaction, RoomRedactionPolicy, type RssProvider } from "../types/matrix";
import { useResolveMemberLabel } from "../hooks/useResolveMemberLabel";
import { useTheme } from "../theme/ThemeContext";
import MediaViewerModal, {
  type MediaViewerOpenPayload,
} from "./MediaViewerModal";
import { fileNameFromImageUrl } from "../utils/directImageUrl";
import { useReadReceiptSender } from "../hooks/useReadReceiptSender";
import { useAcknowledgeVisibleCalls } from "../hooks/useAcknowledgeVisibleCalls";
import { describeCall, formatCallDuration, projectCallHistory } from "../features/chat/messages/callHistory";
import { timelinePaginationEdge } from "../features/chat/messages/timelinePagination";
import MembershipNoticeRow from "../features/chat/messages/MembershipNoticeRow";
import MessageRow from "../features/chat/messages/MessageRow";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";
import TimelineNoticeRow from "../features/chat/messages/TimelineNoticeRow";
import { rssArticleCandidate, type RssArticleCandidate } from "../features/chat/messages/rssArticle";
import { rssThreadReplyCount } from "../features/chat/messages/rssThreads";
import type { RoomFeedSubscription } from "../features/rss/api";
import {
  shouldShowHeader,
  getReplyThreadPreview,
  isTimelineNotice,
  reactionHoverLines,
  messageAllowsEdit,
  messageAllowsDelete,
} from "../features/chat/messages/messageListUtils";
import LoadingSkeletons from "../features/chat/messages/LoadingSkeletons";
import MessageActionMenu from "../features/chat/messages/MessageActionMenu";
import { useActionBarPopover } from "../features/chat/messages/useActionBarPopover";
import { useMessageScrollAnimation } from "../features/chat/messages/useMessageScrollAnimation";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export type MessageListHandle = {
  scrollToEventId: (eventId: string, highlight?: boolean) => void;
};

interface MessageListProps {
  messages: Message[];
  rssProvider?: RssProvider;
  rssSubscriptions?: readonly RoomFeedSubscription[];
  rssReplies?: ReadonlyMap<string, Message[]>;
  activeRssThreadId?: string;
  onOpenRssThread?: (root: Message, article: RssArticleCandidate) => void;
  replyDrawer?: boolean;
  rssReplyCounts?: ReadonlyMap<string, number>;
  loadingOlder: boolean;
  initialLoading: boolean;
  hasOlder: boolean;
  hasUpgradeHistory?: boolean;
  historyError?: string | null;
  isAtLatest: boolean;
  latestEventId?: string | null;
  automaticReadBlocked?: boolean;
  privateReadOnly?: boolean;
  acknowledgedThrough?: string | null;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  pendingRecentCount: number;
  showJumpToRecent: boolean;
  onJumpToRecent: () => void | Promise<void>;
  roomId: string;
  userId: string;
  callPeerUserId?: string | null;
  redactionPolicy: RoomRedactionPolicy;
  onRequestEdit: (msg: Message) => void;
  /** Reply composer target (cleared on send or Escape in composer). */
  onRequestReply: (msg: Message) => void;
  onReplyPreviewClick: (eventId: string, sourceRoomId?: string) => void;
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
  onSenderContextMenu?: (event: React.MouseEvent, message: Message) => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

// scrollTop can be fractional while scrollHeight/clientHeight are rounded.
const SCROLL_BOTTOM_EPSILON_PX = 1;
const SKELETON_COUNT = 4;
const MESSAGE_ACTIONS_MENU_Z = 10_000;
const REACTION_POPOVER_IGNORE = ["[data-message-reaction-popover]"];


/* ------------------------------------------------------------------ */
/*  MessageList                                                        */
/* ------------------------------------------------------------------ */

const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages: timeline,
    rssProvider,
    rssSubscriptions,
    rssReplies,
    activeRssThreadId,
    onOpenRssThread,
    replyDrawer = false,
    rssReplyCounts,
    loadingOlder,
    initialLoading,
    hasOlder,
    hasUpgradeHistory,
    historyError,
    isAtLatest,
    latestEventId,
    automaticReadBlocked = false,
    privateReadOnly = false,
    acknowledgedThrough = null,
    onLoadOlder,
    onLoadNewer,
    pendingRecentCount,
    showJumpToRecent,
    onJumpToRecent,
    roomId,
    userId,
    callPeerUserId,
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
    onSenderContextMenu,
  },
  ref,
) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const { userIds: ignoredUsers } = useIgnoredUsers();
  const [callHistoryTime, setCallHistoryTime] = useState(Date.now);
  const { messages, anchors, callSummaries, nextCallExpiry, readThroughEventId } = useMemo(
    () => projectCallHistory(timeline, latestEventId, Math.max(callHistoryTime, Date.now())),
    [timeline, latestEventId, callHistoryTime],
  );
  useEffect(() => {
    if (nextCallExpiry === undefined) return;
    const delay = Math.min(2_147_483_647, Math.max(1, nextCallExpiry - Date.now()));
    const timer = setTimeout(() => setCallHistoryTime(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [nextCallExpiry]);
  const pinnedSet = useMemo(
    () => new Set(pinnedEventIds),
    [pinnedEventIds],
  );
  const rssArticles = useMemo(() => {
    if (!rssProvider) return [];
    return messages.map((message) => rssArticleCandidate(message, rssProvider, rssSubscriptions));
  }, [rssProvider, rssSubscriptions, messages]);

  const { resolveMemberLabel } = useResolveMemberLabel(roomId);

  /* ---- Refs ---- */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /** Grows with message rows / media; observed so we can pin scroll when content height changes. */
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom, cancelScrollAnimation, scrollAnimationRef } =
    useMessageScrollAnimation(scrollContainerRef);

  useImperativeHandle(ref, () => ({
    scrollToEventId: (eventId: string, highlight = false) => {
      const root = scrollContainerRef.current;
      if (!root) return;
      const el = root.querySelector(
        `[data-message-event-id="${CSS.escape(anchors.get(eventId) ?? eventId)}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
      setAtBottom(false);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      if (highlight) {
        root.querySelectorAll(".pax-message-jump-highlight").forEach((row) => {
          row.classList.remove("pax-message-jump-highlight");
        });
        // Restart the animation when the same reply is clicked again.
        void el.offsetWidth;
        el.classList.add("pax-message-jump-highlight");
      }
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
  const [hasNewMessages, setHasNewMessages] = useState(false);

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
  const [mediaViewer, setMediaViewer] = useState<(MediaViewerOpenPayload & { senderId: string }) | null>(
    null,
  );
  const visibleMedia = mediaViewer && !ignoredUsers.has(mediaViewer.senderId) ? mediaViewer : null;
  const reactionTooltipAnchorRef = useRef<HTMLElement | null>(null);
  const [reactionTooltip, setReactionTooltip] = useState<{
    left: number;
    top: number;
    lines: string[];
  } | null>(null);

  useEffect(() => {
    setMediaViewer((current) => current && ignoredUsers.has(current.senderId) ? null : current);
    setReactionTooltip(null);
  }, [ignoredUsers]);

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
    (url: string, title: string, senderId: string) => {
      setMediaViewer({
        kind: "image",
        directUrl: url,
        fileName: title || fileNameFromImageUrl(url),
        mimeType: /\.gif([?#]|$)/i.test(url) ? "image/gif" : null,
        roomId,
        senderId,
      });
    },
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
    cancelScrollAnimation();
    shouldAutoScrollRef.current = true;
    setAtBottom(true);
    setHasNewMessages(false);
    menu.setOpenId(null);
    reactionPicker.setOpenId(null);
    setMediaViewer(null);
    reactionTooltipAnchorRef.current = null;
    setReactionTooltip(null);
  // menu.setOpenId / reactionPicker.setOpenId are stable useState setters
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, cancelScrollAnimation]);

  /* ================================================================ */
  /*  Auto-scroll to bottom on new messages                            */
  /* ================================================================ */

  const lastId = messages[messages.length - 1]?.eventId ?? null;
  let lastChatIndex = messages.length - 1;
  while (isTimelineNotice(messages[lastChatIndex])) lastChatIndex -= 1;
  const lastChatId = messages[lastChatIndex]?.eventId ?? null;
  const scrollContextRef = useRef<{
    roomId: string;
    initialLoading: boolean;
    isAtLatest: boolean;
    lastId: string | null;
    lastChatId: string | null;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = scrollContextRef.current;
    scrollContextRef.current = { roomId, initialLoading, isAtLatest, lastId, lastChatId };
    if (initialLoading) return;

    const continuingTimeline = previous?.roomId === roomId && !previous.initialLoading;
    if (!shouldAutoScrollRef.current) {
      // A new tail on the same timeline means messages arrived below the reader.
      // Prepending history, edits, and replacing local echoes don't count.
      if (
        continuingTimeline && previous.isAtLatest && isAtLatest &&
        previous.lastChatId !== lastChatId &&
        messages.some((message) => message.eventId === (previous.lastChatId ?? previous.lastId))
      ) {
        setHasNewMessages(true);
      }
      return;
    }

    // Open rooms at the latest message immediately; ease subsequent movement.
    scrollToBottom(continuingTimeline);
    setAtBottom(true);
    if (isAtLatest) setHasNewMessages(false);
  }, [lastId, lastChatId, messages, initialLoading, isAtLatest, roomId, scrollToBottom]);

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
  const previousScrollTopRef = useRef(0);

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
    // Layout adjustments after a prepend are not a scroll toward newer history.
    previousScrollTopRef.current = el.scrollTop;
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
  hasOlderRef.current = hasOlder && !historyError;
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

  // Acknowledge the timeline through the events covered by the visible entries
  // when the user is at the latest page, near the bottom, and the window is focused.
  useReadReceiptSender(
    roomId,
    {
      readThroughEventId,
      atBottom: isAtLatest && atBottom,
      blocked: automaticReadBlocked,
      privateOnly: privateReadOnly,
      alreadyAcknowledgedEventId: acknowledgedThrough,
    },
    userId,
  );
  useAcknowledgeVisibleCalls(scrollContainerRef, messages, roomId, userId, initialLoading);

  const COOLDOWN_MS = 500;

  const loadOlderPreservingPosition = useCallback(() => {
    cancelScrollAnimation();
    shouldAutoScrollRef.current = false;
    setAtBottom(false);
    onLoadOlderRef.current();
  }, [cancelScrollAnimation]);

  const tryTriggerLoadOlder = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (loadCooldownRef.current) return;
    if (loadingOlderRef.current) return;
    if (!hasOlderRef.current) return;
    if (timelinePaginationEdge(el) !== "older") return;

    console.log("[MessageList] → triggering loadOlder", {
      scrollTop: Math.round(el.scrollTop),
    });
    loadCooldownRef.current = true;
    setTimeout(() => {
      loadCooldownRef.current = false;
    }, COOLDOWN_MS);
    loadOlderPreservingPosition();
  }, [loadOlderPreservingPosition]);

  const tryTriggerLoadNewer = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (loadCooldownRef.current) return;
    if (loadingOlderRef.current) return;
    if (isAtLatestRef.current) return;
    if (timelinePaginationEdge(el) !== "newer") return;

    console.log("[MessageList] → triggering loadNewer", {
      distFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
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
      const scrollingDown = scrollTop > previousScrollTopRef.current;
      previousScrollTopRef.current = scrollTop;
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

      // Intermediate animation frames are still approaching the bottom.
      // Refresh the anchor, but don't disable following or load history.
      if (scrollAnimationRef.current) return;

      const distFromBottom =
        el.scrollHeight - scrollTop - el.clientHeight;
      const nextAtBottom = distFromBottom < SCROLL_BOTTOM_EPSILON_PX;
      if (shouldAutoScrollRef.current !== nextAtBottom) {
        shouldAutoScrollRef.current = nextAtBottom;
        // Only commit the state mirror on flips — this runs inside the scroll
        // rAF and must not cause a render per frame.
        setAtBottom(nextAtBottom);
      }
      if (nextAtBottom && isAtLatestRef.current) setHasNewMessages(false);

      console.log("[MessageList] scroll", {
        scrollTop: Math.round(scrollTop),
        distFromBottom: Math.round(distFromBottom),
        cooldown: loadCooldownRef.current,
        loadingOlder: loadingOlderRef.current,
      });

      tryTriggerLoadOlder();
      if (scrollingDown) tryTriggerLoadNewer();
    });
  }, [tryTriggerLoadOlder, tryTriggerLoadNewer, scrollAnimationRef]);

  const handleScrollIntent = useCallback(() => {
    if (!scrollAnimationRef.current) return;
    cancelScrollAnimation();
    shouldAutoScrollRef.current = false;
    setAtBottom(false);
  }, [cancelScrollAnimation, scrollAnimationRef]);

  const handleScrollKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      handleScrollIntent();
    }
  }, [handleScrollIntent]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null)
        cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  /* ================================================================ */
  /*  Continue older pagination on load completion                     */
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
      console.log("[MessageList] load completed, re-checking older history");
      // Defer one frame so overflow-anchor / measurement adjustments
      // land before we read scrollTop.
      const frame = requestAnimationFrame(() => {
        tryTriggerLoadOlder();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [loadingOlder, tryTriggerLoadOlder]);

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
      scrollToBottom(true);
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
  }, [initialLoading, roomId, scrollToBottom]);

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

  const upgradeDivider = (
    <div role="separator" aria-label="Room upgraded" style={{
      margin: `${spacing.unit * 3}px ${spacing.unit * 4}px`,
      borderTop: `1px solid ${palette.border}`,
      paddingTop: spacing.unit,
      textAlign: "center",
      color: palette.textSecondary,
      fontSize: typography.fontSizeSmall,
    }}>
      Room upgraded
    </div>
  );

  const hasUnreadMessages = hasNewMessages || pendingRecentCount > 0;
  const showRecentNotice = showJumpToRecent || (!atBottom && hasUnreadMessages);
  const jumpToRecentLabel = hasUnreadMessages ? "New messages" : "Jump to recent";

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
    <div style={{
      position: "relative",
      display: "flex",
      flexDirection: "column",
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    }}>
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      onWheelCapture={handleScrollIntent}
      onTouchStartCapture={handleScrollIntent}
      onPointerDownCapture={handleScrollIntent}
      onKeyDownCapture={handleScrollKeyDown}
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
        .pax-message-jump-highlight::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background-color: ${rowHighlight};
          pointer-events: none;
          opacity: 0;
          animation: pax-message-jump-flash 1.5s ease 0.25s;
        }
        @keyframes pax-message-jump-flash {
          0%, 50%, 100% { opacity: 0; }
          20%, 70% { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pax-message-jump-highlight::after {
            animation: pax-message-jump-flash-reduced 1.5s ease;
          }
          @keyframes pax-message-jump-flash-reduced {
            0%, 80% { opacity: 1; }
            100% { opacity: 0; }
          }
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
            : replyDrawer || rssProvider || hasUpgradeHistory || messages.some(isTimelineNotice) ? (
              <button type="button" onClick={loadOlderPreservingPosition} style={{
                color: palette.textSecondary,
                background: "none",
                border: 0,
                padding: spacing.unit,
                font: "inherit",
                textDecoration: "underline",
                cursor: "pointer",
              }}>
                {replyDrawer ? "Load older replies" : "Load older messages"}
              </button>
            ) : "Scroll up for more"
          : messages.length > 0
            ? replyDrawer ? null : "Beginning of conversation"
            : replyDrawer ? "No replies yet" : "No messages yet"}
      </div>
      {historyError && <div role="status" style={{ padding: spacing.unit, textAlign: "center", color: palette.textSecondary }}>{historyError}</div>}

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
        const crossedUpgrade = prevMsg?.historyRoomId && prevMsg.historyRoomId !== msg.historyRoomId;
        const notice = msg.membershipNotice;
        if (notice) {
          return (
            <Fragment key={msg.eventId}>
              {crossedUpgrade && upgradeDivider}
              <MembershipNoticeRow
                eventId={msg.eventId}
                timestamp={msg.timestamp}
                notice={notice}
                actorLabel={msg.senderName?.trim() || resolveMemberLabel(msg.sender)}
                targetLabel={notice.targetName?.trim() || resolveMemberLabel(notice.targetUserId)}
              />
            </Fragment>
          );
        }
        const call = callSummaries.get(msg.eventId);
        if (msg.directCallNotice && call) {
          const outgoing = call.caller?.sender === userId;
          const peer = outgoing ? call.callee : call.caller;
          const peerId = outgoing ? call.invitee ?? peer?.sender ?? callPeerUserId : peer?.sender;
          const peerName = peer?.senderName?.trim() || (peerId ? resolveMemberLabel(peerId) : undefined);
          return (
            <Fragment key={msg.eventId}>
              {crossedUpgrade && upgradeDivider}
              <TimelineNoticeRow
                eventId={msg.eventId}
                incomingCallId={msg.sender !== userId && !msg.historyRoomId ? msg.directCallNotice.callId : undefined}
                timestamp={call.endedAt ?? msg.timestamp}
                timeLabel={call.endedAt === undefined ? undefined : "Ended"}
                icon={<Phone size={14} aria-hidden="true" />}
              >
                {describeCall(call, userId, peerName)}
                {call.durationMs !== undefined && (
                  <> · {call.estimatedDuration && "about "}{formatCallDuration(call.durationMs)}</>
                )}
              </TimelineNoticeRow>
            </Fragment>
          );
        }
        const isHistorical = !!msg.historyRoomId;
        const article = isHistorical ? null : rssArticles[i] ?? null;
        const showHeader = Boolean(crossedUpgrade || article || rssArticles[i - 1]) || shouldShowHeader(msg, prevMsg);
        const canEdit = !isHistorical && messageAllowsEdit(msg, userId);
        const canDelete = !isHistorical && messageAllowsDelete(msg, userId, redactionPolicy);
        const showReplyButton =
          !isHistorical && allowReply && !msg.decryptionFailed && !msg.eventId.startsWith("local:");
        const showOverflowMenu = !isHistorical && !msg.decryptionFailed && (canEdit || canDelete || canPinMessages);
        const canReact = !isHistorical && !msg.decryptionFailed && !msg.eventId.startsWith("local:");
        const showHoverActions =
          showReplyButton || canReact || showOverflowMenu;

        return (
          <Fragment key={msg.eventId}>
            {crossedUpgrade && upgradeDivider}
            <MessageRow
              msg={msg}
              selfUserId={userId}
              rssArticle={article}
              rssReplyCount={article ? rssReplyCounts?.get(msg.eventId) ?? rssThreadReplyCount(msg, rssReplies?.get(msg.eventId) ?? []) : 0}
              rssThreadOpen={msg.eventId === activeRssThreadId}
              onOpenRssThread={onOpenRssThread}
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
              onOpenMediaViewer={(payload) => setMediaViewer({
                ...payload, roomId: msg.historyRoomId ?? roomId, senderId: msg.sender,
              })}
              onOpenDirectImage={(url, title) => openDirectImage(url, title, msg.sender)}
              menuAnchorRef={menu.anchorRef}
              reactionPickerAnchorRef={reactionPicker.anchorRef}
              onReactionChipClick={(key, reactedByMe) => {
                if (isHistorical) return;
                void handleReactionChipClick(msg.eventId, key, reactedByMe);
              }}
              onReactionChipHover={handleReactionChipHover}
              onReactionChipHoverEnd={handleReactionChipHoverEnd}
              rowHighlight={rowHighlight}
              spacingUnit={spacing.unit}
              palette={palette}
              typography={typography}
              resolvedColorScheme={resolvedColorScheme}
              replyThread={replyDrawer ? null : getReplyThreadPreview(msg, messageByEventId)}
              onReplyThreadClick={(id) => onReplyPreviewClick(id, msg.historyRoomId)}
              onOpenSenderProfile={onOpenSenderProfile}
              onSenderContextMenu={onSenderContextMenu}
              resolveMemberLabel={resolveMemberLabel}
            />
          </Fragment>
        );
      })}

      {messages[messages.length - 1]?.historyRoomId && upgradeDivider}

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

      </div>
    </div>

      {/* Keep the notice above the composer without changing the timeline height. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          left: spacing.unit * 3,
          right: spacing.unit * 3,
          bottom: spacing.unit * 3,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 3,
        }}
      >
        {showRecentNotice && (
          <button
            type="button"
            onClick={() => {
              shouldAutoScrollRef.current = true;
              setAtBottom(true);
              setHasNewMessages(false);
              // The latest page is already loaded when the reader is only scrolled up.
              void Promise.resolve(isAtLatest ? undefined : onJumpToRecent()).finally(() => {
                requestAnimationFrame(() => {
                  if (scrollContextRef.current?.roomId !== roomId) return;
                  scrollToBottom(true);
                });
              });
            }}
            title="Jump to latest messages"
            aria-label={`${jumpToRecentLabel}. Jump to latest messages`}
            style={{
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: spacing.unit * 1.5,
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              borderRadius: 9999,
              border: `1px solid ${hasUnreadMessages ? palette.accent : palette.border}`,
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
            <ArrowDown size={14} strokeWidth={2.5} color={hasUnreadMessages ? palette.accent : undefined} />
            {jumpToRecentLabel}
          </button>
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
        open={visibleMedia != null}
        onClose={() => setMediaViewer(null)}
        payload={visibleMedia}
      />
    </div>
  );
});

export default MessageList;

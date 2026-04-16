import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  memo,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { MoreVertical, Pencil, Trash2, ArrowDown } from "lucide-react";
import { Message, RoomRedactionPolicy } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import type { ResolvedColorScheme } from "../theme/types";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import { avatarSrc } from "../utils/avatarSrc";
import MessageMarkdown from "./MessageMarkdown";
import MessageMatrixImage from "./MessageMatrixImage";
import MessageMatrixVideo from "./MessageMatrixVideo";
import MessageFileAttachment from "./MessageFileAttachment";
import MediaViewerModal, {
  type MediaViewerOpenPayload,
} from "./MediaViewerModal";
import { inferMediaViewerKind } from "../utils/mediaViewer";
import { fileNameFromImageUrl } from "../utils/directImageUrl";
import { useReadReceiptSender } from "../hooks/useReadReceiptSender";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

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
  onMessagesMutated: () => void;
  onMessageRemoved: (eventId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const AUTO_SCROLL_THRESHOLD_PX = 150;
const SKELETON_COUNT = 4;
const MESSAGE_ACTIONS_MENU_Z = 10_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const NON_EDITABLE_BODIES = new Set([
  "[File]",
  "[Video]",
  "[Audio]",
  "[Unsupported message]",
]);

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (isToday) return `Today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `Yesterday at ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}

function shouldShowHeader(msg: Message, prevMsg: Message | null): boolean {
  if (!prevMsg) return true;
  if (prevMsg.sender !== msg.sender) return true;
  if (msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000) return true;
  return false;
}

function messageAllowsEdit(msg: Message, userId: string): boolean {
  if (msg.sender !== userId) return false;
  if (msg.imageMediaRequest != null) return false;
  if (msg.videoMediaRequest != null) return false;
  if (msg.fileMediaRequest != null) return false;
  return !NON_EDITABLE_BODIES.has(msg.body.trim());
}

function messageAllowsDelete(
  msg: Message,
  userId: string,
  policy: RoomRedactionPolicy,
): boolean {
  if (msg.sender === userId) return policy.canRedactOwn;
  return policy.canRedactOther;
}

/* ------------------------------------------------------------------ */
/*  Skeleton loading indicator                                         */
/* ------------------------------------------------------------------ */

function LoadingSkeletons({
  count,
  palette,
  spacingUnit,
}: {
  count: number;
  palette: ReturnType<typeof useTheme>["palette"];
  spacingUnit: number;
}) {
  return (
    <div
      aria-hidden
      style={{
        padding: `${spacingUnit}px ${spacingUnit * 3}px ${spacingUnit * 2}px`,
        display: "flex",
        flexDirection: "column",
        gap: spacingUnit * 2,
      }}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: spacingUnit * 3,
            paddingLeft: spacingUnit,
            paddingRight: spacingUnit,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              flexShrink: 0,
              backgroundColor: palette.bgActive,
              opacity: 0.8,
            }}
          />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: spacingUnit * 1.5,
            }}
          >
            <div
              style={{
                width: `${48 + idx * 10}%`,
                maxWidth: 220,
                height: 10,
                borderRadius: 999,
                backgroundColor: palette.bgActive,
                opacity: 0.9,
              }}
            />
            <div
              style={{
                width: `${72 + ((idx + 1) % 3) * 8}%`,
                height: 12,
                borderRadius: 999,
                backgroundColor: palette.bgHover,
                opacity: 0.9,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Memoized message row                                              */
/* ------------------------------------------------------------------ */

interface MessageRowProps {
  msg: Message;
  showHeader: boolean;
  showMessageActions: boolean;
  isMenuOpen: boolean;
  onOpenMenu: (eventId: string) => void;
  onOpenMediaViewer: (payload: MediaViewerOpenPayload) => void;
  onOpenDirectImage: (url: string, title: string) => void;
  menuAnchorRef: React.RefObject<HTMLButtonElement | null>;
  rowHighlight: string;
  spacingUnit: number;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  resolvedColorScheme: ResolvedColorScheme;
}

const MessageRow = memo(function MessageRow({
  msg,
  showHeader,
  showMessageActions,
  isMenuOpen,
  onOpenMenu,
  onOpenMediaViewer,
  onOpenDirectImage,
  menuAnchorRef,
  rowHighlight,
  spacingUnit,
  palette,
  typography,
  resolvedColorScheme,
}: MessageRowProps) {
  const menuBtn = spacingUnit * 7;

  return (
    <div
      data-message-event-id={msg.eventId}
      className="pax-message-row"
      style={{
        position: "relative",
        ...(showHeader
          ? {
              paddingTop: spacingUnit,
              paddingRight: spacingUnit * 2,
              paddingBottom: spacingUnit,
              paddingLeft: spacingUnit * 4,
            }
          : {
              paddingTop: spacingUnit / 2,
              paddingRight: spacingUnit * 2,
              paddingBottom: spacingUnit / 2,
              paddingLeft: spacingUnit * 4,
            }),
        display: "flex",
        gap: spacingUnit * 3,
        marginTop: showHeader ? spacingUnit * 3 : 0,
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        borderTopRightRadius: spacingUnit * 1.5,
        borderBottomRightRadius: spacingUnit * 1.5,
        backgroundColor: isMenuOpen ? rowHighlight : "transparent",
        transition: "background-color 0.12s ease",
      }}
    >
      {/* Avatar column */}
      <div style={{ width: 40, flexShrink: 0 }}>
        {showHeader &&
          (msg.avatarUrl ? (
            <img
              src={avatarSrc(msg.avatarUrl)}
              alt={msg.senderName ?? msg.sender}
              loading="lazy"
              decoding="async"
              style={{
                display: "block",
                width: 40,
                height: 40,
                borderRadius: "50%",
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                backgroundColor: userInitialAvatarBackground(
                  msg.sender,
                  resolvedColorScheme,
                ),
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: typography.fontSizeBase,
                fontWeight: typography.fontWeightBold,
              }}
            >
              {(msg.senderName ?? msg.sender).charAt(0).toUpperCase()}
            </div>
          ))}
      </div>

      {/* Content column */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {showHeader && (
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: spacingUnit * 2,
            }}
          >
            <span
              style={{
                fontWeight: typography.fontWeightMedium,
                color: palette.textHeading,
                fontSize: typography.fontSizeBase,
              }}
            >
              {msg.senderName ?? msg.sender}
            </span>
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
              }}
            >
              {formatTime(msg.timestamp)}
            </span>
          </div>
        )}

        {msg.imageMediaRequest != null ? (
          <>
            <MessageMatrixImage
              request={msg.imageMediaRequest}
              onExpand={() =>
                onOpenMediaViewer({
                  kind: "image",
                  request: msg.imageMediaRequest,
                  fileName: msg.body.trim() || "Image",
                  mimeType: null,
                })
              }
            />
            {msg.body.trim().length > 0 ? (
              <MessageMarkdown
                edited={Boolean(msg.edited)}
                onOpenDirectImage={onOpenDirectImage}
              >
                {msg.body}
              </MessageMarkdown>
            ) : null}
          </>
        ) : msg.videoMediaRequest != null ? (
          <>
            <MessageMatrixVideo request={msg.videoMediaRequest} />
            {msg.body.trim().length > 0 ? (
              <MessageMarkdown
                edited={Boolean(msg.edited)}
                onOpenDirectImage={onOpenDirectImage}
              >
                {msg.body}
              </MessageMarkdown>
            ) : null}
          </>
        ) : msg.fileMediaRequest != null ? (
          <>
            <MessageFileAttachment
              fileName={msg.fileDisplayName ?? "Attachment"}
              mimeType={msg.fileMime}
              onOpen={() =>
                onOpenMediaViewer({
                  kind: inferMediaViewerKind(
                    msg.fileMime,
                    msg.fileDisplayName ?? "",
                  ),
                  request: msg.fileMediaRequest,
                  fileName: msg.fileDisplayName ?? "Attachment",
                  mimeType: msg.fileMime ?? null,
                })
              }
            />
            {msg.body.trim().length > 0 ? (
              <MessageMarkdown
                edited={Boolean(msg.edited)}
                onOpenDirectImage={onOpenDirectImage}
              >
                {msg.body}
              </MessageMarkdown>
            ) : null}
          </>
        ) : (
          <MessageMarkdown
            edited={Boolean(msg.edited)}
            onOpenDirectImage={onOpenDirectImage}
          >
            {msg.body}
          </MessageMarkdown>
        )}
      </div>

      {/* Actions button */}
      {showMessageActions && (
        <div
          data-message-actions-root
          className="pax-message-actions"
          style={{
            position: "absolute",
            top: 0,
            right: spacingUnit * 2,
            transform: "translateY(-50%)",
            zIndex: 2,
            ...(isMenuOpen
              ? { opacity: 1, pointerEvents: "auto" as const }
              : {}),
          }}
        >
          <button
            ref={isMenuOpen ? menuAnchorRef : undefined}
            type="button"
            title="Message actions"
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onOpenMenu(msg.eventId)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: menuBtn,
              height: menuBtn,
              padding: 0,
              border: `1px solid ${palette.border}`,
              borderRadius: spacingUnit * 1.25,
              backgroundColor: isMenuOpen
                ? palette.bgHover
                : palette.bgTertiary,
              color: palette.textSecondary,
              cursor: "pointer",
              boxShadow:
                resolvedColorScheme === "light"
                  ? "0 1px 3px rgba(0,0,0,0.08)"
                  : "0 2px 8px rgba(0,0,0,0.35)",
            }}
          >
            <MoreVertical size={18} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  MessageList                                                        */
/* ------------------------------------------------------------------ */

export default function MessageList({
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
  onMessagesMutated,
  onMessageRemoved,
}: MessageListProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();

  /* ---- Refs ---- */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  /**
   * React-visible mirror of `shouldAutoScrollRef` so `useReadReceiptSender`'s
   * effect re-evaluates when the user scrolls to or away from the bottom.  We
   * keep the ref as the source of truth for the hot scroll path (avoids extra
   * renders) and only commit to state when the boolean value actually flips.
   */
  const [atBottom, setAtBottom] = useState(true);

  /* ---- UI state ---- */
  const [openMenuEventId, setOpenMenuEventId] = useState<string | null>(null);
  const [menuFixedPos, setMenuFixedPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [mediaViewer, setMediaViewer] = useState<MediaViewerOpenPayload | null>(
    null,
  );

  /* ---- Stable callbacks ---- */
  const openDirectImage = useCallback((url: string, title: string) => {
    setMediaViewer({
      kind: "image",
      directUrl: url,
      fileName: title || fileNameFromImageUrl(url),
      mimeType: /\.gif([?#]|$)/i.test(url) ? "image/gif" : null,
    });
  }, []);

  const handleOpenMenu = useCallback((eventId: string) => {
    setOpenMenuEventId((id) => (id === eventId ? null : eventId));
  }, []);

  /* ================================================================ */
  /*  Room change: reset                                               */
  /* ================================================================ */

  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true;
    setAtBottom(true);
    setOpenMenuEventId(null);
    setMediaViewer(null);
  }, [roomId]);

  /* ================================================================ */
  /*  Auto-scroll to bottom on new messages                            */
  /* ================================================================ */

  const lastId = messages[messages.length - 1]?.eventId ?? null;

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    bottomRef.current?.scrollIntoView();
  }, [lastId, messages.length]);

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
      const nextAtBottom = distFromBottom < AUTO_SCROLL_THRESHOLD_PX;
      if (shouldAutoScrollRef.current !== nextAtBottom) {
        shouldAutoScrollRef.current = nextAtBottom;
        // Only commit the state mirror on flips — this runs inside the scroll
        // rAF and must not cause a render per frame.
        setAtBottom(nextAtBottom);
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
    const el = scrollContainerRef.current;
    if (!el) return;
    let prevHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h < prevHeight && shouldAutoScrollRef.current) {
        bottomRef.current?.scrollIntoView();
      }
      prevHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ================================================================ */
  /*  Context menu: outside-click / escape                             */
  /* ================================================================ */

  useEffect(() => {
    if (!openMenuEventId) return;
    const onDocDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-message-actions-root]")) return;
      setOpenMenuEventId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuEventId(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuEventId]);

  /* ================================================================ */
  /*  Context menu: fixed positioning                                  */
  /* ================================================================ */

  useLayoutEffect(() => {
    if (!openMenuEventId) {
      setMenuFixedPos(null);
      return;
    }
    const update = () => {
      const btn = menuAnchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setMenuFixedPos({
        top: r.bottom + spacing.unit,
        right: window.innerWidth - r.right,
      });
    };
    update();

    const ro = new ResizeObserver(update);
    if (menuAnchorRef.current) ro.observe(menuAnchorRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const cont = scrollContainerRef.current;
    cont?.addEventListener("scroll", update, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      cont?.removeEventListener("scroll", update);
    };
  }, [openMenuEventId, spacing.unit]);

  const openMenuMsg =
    openMenuEventId === null
      ? undefined
      : messages.find((m) => m.eventId === openMenuEventId);

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
        paddingBottom: spacing.unit * 4,
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
            : null}
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
        const showMessageActions = canEdit || canDelete;

        return (
          <MessageRow
            key={msg.eventId}
            msg={msg}
            showHeader={showHeader}
            showMessageActions={showMessageActions}
            isMenuOpen={openMenuEventId === msg.eventId}
            onOpenMenu={handleOpenMenu}
            onOpenMediaViewer={setMediaViewer}
            onOpenDirectImage={openDirectImage}
            menuAnchorRef={menuAnchorRef}
            rowHighlight={rowHighlight}
            spacingUnit={spacing.unit}
            palette={palette}
            typography={typography}
            resolvedColorScheme={resolvedColorScheme}
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
                  bottomRef.current?.scrollIntoView();
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

      {/* Context menu portal */}
      {openMenuMsg &&
        menuFixedPos &&
        createPortal(
          <div
            data-message-actions-root
            role="menu"
            aria-label="Message actions"
            style={{
              position: "fixed",
              top: menuFixedPos.top,
              right: menuFixedPos.right,
              zIndex: MESSAGE_ACTIONS_MENU_Z,
              minWidth: spacing.unit * 40,
              padding: spacing.unit * 1.5,
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit * 0.5,
              backgroundColor: palette.bgSecondary,
              border: `1px solid ${palette.border}`,
              borderRadius: spacing.unit * 2,
              boxShadow:
                resolvedColorScheme === "light"
                  ? "0 8px 24px rgba(0,0,0,0.12)"
                  : "0 10px 36px rgba(0,0,0,0.45)",
            }}
          >
            {messageAllowsEdit(openMenuMsg, userId) && (
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpenMenuEventId(null);
                  onRequestEdit(openMenuMsg);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 2.5,
                  width: "100%",
                  padding: `${spacing.unit * 2.25}px ${spacing.unit * 3}px`,
                  border: "none",
                  borderRadius: spacing.unit * 1.25,
                  backgroundColor: "transparent",
                  color: palette.textPrimary,
                  fontSize: typography.fontSizeBase,
                  fontFamily: typography.fontFamily,
                  fontWeight: typography.fontWeightNormal,
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = palette.bgHover;
                  e.currentTarget.style.color = palette.textHeading;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = palette.textPrimary;
                }}
              >
                <Pencil size={20} strokeWidth={2} color="currentColor" />
                Edit
              </button>
            )}
            {messageAllowsDelete(openMenuMsg, userId, redactionPolicy) && (
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={async () => {
                  setOpenMenuEventId(null);
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
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 2.5,
                  width: "100%",
                  padding: `${spacing.unit * 2.25}px ${spacing.unit * 3}px`,
                  border: "none",
                  borderRadius: spacing.unit * 1.25,
                  backgroundColor: "transparent",
                  color: palette.textPrimary,
                  fontSize: typography.fontSizeBase,
                  fontFamily: typography.fontFamily,
                  fontWeight: typography.fontWeightNormal,
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = palette.bgHover;
                  e.currentTarget.style.color = palette.textHeading;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = palette.textPrimary;
                }}
              >
                <Trash2 size={20} strokeWidth={2} color="currentColor" />
                Delete
              </button>
            )}
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
}
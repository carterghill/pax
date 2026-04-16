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
import { useVirtualizer } from "@tanstack/react-virtual";
import { MoreVertical, Pencil, Trash2, ArrowDown } from "lucide-react";
import { Message, RoomRedactionPolicy } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import type { ResolvedColorScheme } from "../theme/types";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import MessageMarkdown from "./MessageMarkdown";
import MessageMatrixImage from "./MessageMatrixImage";
import MessageMatrixVideo from "./MessageMatrixVideo";
import MessageFileAttachment from "./MessageFileAttachment";
import MediaViewerModal, {
  type MediaViewerOpenPayload,
} from "./MediaViewerModal";
import { inferMediaViewerKind } from "../utils/mediaViewer";
import { fileNameFromImageUrl } from "../utils/directImageUrl";
import { avatarSrc } from "../utils/avatarSrc";

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

const ESTIMATED_ROW_HEIGHT = 64;
const OVERSCAN_COUNT = 8;
const LOAD_MORE_THRESHOLD = 5;
const AUTO_SCROLL_THRESHOLD_PX = 120;
const SKELETON_COUNT = 3;
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
/*  MessageList (virtualized)                                          */
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
  const shouldAutoScrollRef = useRef(true);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  /* ---- Scroll anchor state for prepend ---- */
  const prevFirstEventIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const prependAnchorRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);

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

  /* ---- Virtualizer ---- */
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_COUNT,
  });

  /* ================================================================ */
  /*  Room change: reset scroll position                               */
  /* ================================================================ */

  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true;
    prevFirstEventIdRef.current = null;
    prevMessageCountRef.current = 0;
    prependAnchorRef.current = null;
    setOpenMenuEventId(null);
    setMediaViewer(null);
  }, [roomId]);

  /* ================================================================ */
  /*  Detect prepend & capture scroll anchor BEFORE render             */
  /* ================================================================ */

  // We detect prepends by comparing the first eventId before and after
  // a messages change. When a prepend is detected, we save the scroll
  // position so the layout effect can adjust it before paint.

  const firstEventId = messages[0]?.eventId ?? null;
  const lastEventId = messages[messages.length - 1]?.eventId ?? null;
  const messageCount = messages.length;

  // This runs during render (not in an effect) to capture scroll state
  // BEFORE React commits DOM changes. It's safe because we only read
  // from refs and the scroll container.
  if (
    prevFirstEventIdRef.current !== null &&
    firstEventId !== null &&
    firstEventId !== prevFirstEventIdRef.current &&
    messageCount > prevMessageCountRef.current
  ) {
    // Items were prepended.
    const el = scrollContainerRef.current;
    if (el) {
      prependAnchorRef.current = {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
      };
    }
  }

  /* ================================================================ */
  /*  Scroll anchoring after prepend (before paint)                    */
  /* ================================================================ */

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    prependAnchorRef.current = null;

    if (anchor) {
      const el = scrollContainerRef.current;
      if (el) {
        // After the DOM update, scrollHeight has grown by the height of
        // the prepended items. Offset scrollTop by the same delta so the
        // viewport stays on the same messages.
        const delta = el.scrollHeight - anchor.scrollHeight;
        el.scrollTop = anchor.scrollTop + delta;
        // Don't auto-scroll to bottom — user is reading history.
        shouldAutoScrollRef.current = false;
      }
    }

    prevFirstEventIdRef.current = firstEventId;
    prevMessageCountRef.current = messageCount;
  });

  /* ================================================================ */
  /*  Auto-scroll to bottom on new messages                            */
  /* ================================================================ */

  useLayoutEffect(() => {
    if (prependAnchorRef.current) return; // handled above
    if (!shouldAutoScrollRef.current) return;

    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastEventId, messageCount]);

  /* ================================================================ */
  /*  Scroll to bottom on initial load                                 */
  /* ================================================================ */

  useEffect(() => {
    if (messages.length > 0 && prevMessageCountRef.current === 0) {
      // First batch arrived.
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages.length]);

  /* ================================================================ */
  /*  Scroll handler: auto-scroll tracking + load triggers             */
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

  const scrollRafRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;

      const distFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldAutoScrollRef.current =
        distFromBottom < AUTO_SCROLL_THRESHOLD_PX;

      if (loadingOlderRef.current) return;

      // Near top → load older
      if (hasOlderRef.current && el.scrollTop < el.clientHeight * 0.5) {
        const range = virtualizer.range;
        if (range && range.startIndex < LOAD_MORE_THRESHOLD) {
          onLoadOlderRef.current();
        }
      }

      // Near bottom + not at latest → load newer
      if (
        !isAtLatestRef.current &&
        distFromBottom < el.clientHeight * 0.5
      ) {
        const range = virtualizer.range;
        if (
          range &&
          messages.length > 0 &&
          range.endIndex >= messages.length - LOAD_MORE_THRESHOLD
        ) {
          onLoadNewerRef.current();
        }
      }
    });
  }, [virtualizer, messages.length]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null)
        cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

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
        el.scrollTop = el.scrollHeight;
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
  /*  Render: virtualized message list                                 */
  /* ================================================================ */

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        contain: "strict",
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
        @keyframes messageListSpinner {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Top padding + "Beginning" / "Loading" indicator */}
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
        <LoadingSkeletons
          count={SKELETON_COUNT}
          palette={palette}
          spacingUnit={spacing.unit}
        />
      )}

      {/* Virtualized rows */}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualRow) => {
          const idx = virtualRow.index;
          const msg = messages[idx];
          if (!msg) return null;

          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const showHeader = shouldShowHeader(msg, prevMsg);
          const canEdit = messageAllowsEdit(msg, userId);
          const canDelete = messageAllowsDelete(msg, userId, redactionPolicy);
          const showMessageActions = canEdit || canDelete;

          return (
            <div
              key={msg.eventId}
              data-index={idx}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <MessageRow
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
            </div>
          );
        })}
      </div>

      {/* Skeleton rows at bottom when not at latest */}
      {!isAtLatest && (
        <LoadingSkeletons
          count={SKELETON_COUNT}
          palette={palette}
          spacingUnit={spacing.unit}
        />
      )}

      {/* Bottom padding */}
      <div style={{ height: spacing.unit * 4 }} />

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
          }}
        >
          <button
            type="button"
            onClick={() => {
              shouldAutoScrollRef.current = true;
              void Promise.resolve(onJumpToRecent()).finally(() => {
                requestAnimationFrame(() => {
                  const el = scrollContainerRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
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
import { useEffect, useLayoutEffect, useRef, useState, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Message, RoomRedactionPolicy } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import type { ResolvedColorScheme } from "../theme/types";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import MessageMarkdown from "./MessageMarkdown";
import MessageMatrixImage from "./MessageMatrixImage";
import MessageMatrixVideo from "./MessageMatrixVideo";
import MessageFileAttachment from "./MessageFileAttachment";
import MediaViewerModal, { type MediaViewerOpenPayload } from "./MediaViewerModal";
import { inferMediaViewerKind } from "../utils/mediaViewer";
import { fileNameFromImageUrl } from "../utils/directImageUrl";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  initialLoading: boolean;
  refreshing?: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  canRestoreNewer: boolean;
  onLoadNewer: () => void;
  pageDistanceFromRecent: number;
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

  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today at ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;

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

function messageAllowsDelete(msg: Message, userId: string, policy: RoomRedactionPolicy): boolean {
  if (msg.sender === userId) return policy.canRedactOwn;
  return policy.canRedactOther;
}

const MESSAGE_ACTIONS_MENU_Z = 10_000;

function findMessageRow(container: HTMLElement, eventId: string): HTMLElement | null {
  for (const el of container.querySelectorAll("[data-message-event-id]")) {
    if (el.getAttribute("data-message-event-id") === eventId) return el as HTMLElement;
  }
  return null;
}

interface WindowShiftAnchor {
  direction: "older" | "newer";
  anchorEventId: string | undefined;
  anchorViewportTop: number | null;
  baselineFirstEventId: string | undefined;
  baselineLastEventId: string | undefined;
  baselineLength: number;
  scrollHeight: number;
  scrollTop: number;
}

function LoadingMessageSkeletons({
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
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: spacingUnit * 1.5 }}>
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
        /* Extra gap between groups lives in margin so row padding stays symmetric for hover */
        marginTop: showHeader ? spacingUnit * 3 : 0,
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        borderTopRightRadius: spacingUnit * 1.5,
        borderBottomRightRadius: spacingUnit * 1.5,
        backgroundColor: isMenuOpen ? rowHighlight : "transparent",
        transition: "background-color 0.12s ease",
      }}
    >
      <div style={{ width: 40, flexShrink: 0 }}>
        {showHeader && (
          msg.avatarUrl ? (
            <img
              src={msg.avatarUrl}
              alt={msg.senderName ?? msg.sender}
              style={{
                display: "block",
                width: 40,
                height: 40,
                borderRadius: "50%",
                objectFit: "cover",
              }}
            />
          ) : (
            <div style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              backgroundColor: userInitialAvatarBackground(msg.sender, resolvedColorScheme),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: typography.fontSizeBase,
              fontWeight: typography.fontWeightBold,
            }}>
              {(msg.senderName ?? msg.sender).charAt(0).toUpperCase()}
            </div>
          )
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {showHeader && (
          <div style={{ display: "flex", alignItems: "baseline", gap: spacingUnit * 2 }}>
            <span style={{
              fontWeight: typography.fontWeightMedium,
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
            }}>
              {msg.senderName ?? msg.sender}
            </span>
            <span style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}>
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
              <MessageMarkdown edited={Boolean(msg.edited)} onOpenDirectImage={onOpenDirectImage}>
                {msg.body}
              </MessageMarkdown>
            ) : null}
          </>
        ) : msg.videoMediaRequest != null ? (
          <>
            <MessageMatrixVideo request={msg.videoMediaRequest} />
            {msg.body.trim().length > 0 ? (
              <MessageMarkdown edited={Boolean(msg.edited)} onOpenDirectImage={onOpenDirectImage}>
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
                  kind: inferMediaViewerKind(msg.fileMime, msg.fileDisplayName ?? ""),
                  request: msg.fileMediaRequest,
                  fileName: msg.fileDisplayName ?? "Attachment",
                  mimeType: msg.fileMime ?? null,
                })
              }
            />
            {msg.body.trim().length > 0 ? (
              <MessageMarkdown edited={Boolean(msg.edited)} onOpenDirectImage={onOpenDirectImage}>
                {msg.body}
              </MessageMarkdown>
            ) : null}
          </>
        ) : (
          <MessageMarkdown edited={Boolean(msg.edited)} onOpenDirectImage={onOpenDirectImage}>
            {msg.body}
          </MessageMarkdown>
        )}
      </div>

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
            ...(isMenuOpen ? { opacity: 1, pointerEvents: "auto" as const } : {}),
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
              backgroundColor: isMenuOpen ? palette.bgHover : palette.bgTertiary,
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

export default function MessageList({
  messages,
  loading,
  initialLoading,
  refreshing = false,
  hasMore,
  onLoadMore,
  canRestoreNewer,
  onLoadNewer,
  pageDistanceFromRecent,
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
  const AUTO_SCROLL_THRESHOLD_PX = 120;
  const LOADING_SKELETON_ROWS = 3;
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const skipAutoScrollOnceRef = useRef(false);
  const windowShiftAnchorRef = useRef<WindowShiftAnchor | null>(null);
  const [openMenuEventId, setOpenMenuEventId] = useState<string | null>(null);
  const [menuFixedPos, setMenuFixedPos] = useState<{ top: number; right: number } | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [mediaViewer, setMediaViewer] = useState<MediaViewerOpenPayload | null>(null);

  // ---- Logging ----
  const mlRenderCount = useRef(0);
  mlRenderCount.current++;
  console.log(
    `[MessageList] render #${mlRenderCount.current} room=${roomId.slice(-6)} msgs=${messages.length} loading=${loading} hasMore=${hasMore} canRestoreNewer=${canRestoreNewer} pagesFromRecent=${pageDistanceFromRecent} pendingRecent=${pendingRecentCount} initialLoading=${initialLoading} refreshing=${refreshing}`
  );

  const openDirectImage = useCallback((url: string, title: string) => {
    setMediaViewer({
      kind: "image",
      directUrl: url,
      fileName: title || fileNameFromImageUrl(url),
      mimeType: /\.gif([?#]|$)/i.test(url) ? "image/gif" : null,
    });
  }, []);

  const scrollRafRef = useRef<number | null>(null);

  function isNearBottom(): boolean {
    const container = containerRef.current;
    if (!container) return true;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
  }

  useLayoutEffect(() => {
    windowShiftAnchorRef.current = null;
  }, [roomId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = windowShiftAnchorRef.current;
    if (!container || !anchor) return;

    const firstEventId = messages[0]?.eventId;
    const lastEventId = messages[messages.length - 1]?.eventId;
    const boundaryChanged =
      anchor.direction === "older"
        ? firstEventId !== anchor.baselineFirstEventId || messages.length !== anchor.baselineLength
        : firstEventId !== anchor.baselineFirstEventId ||
          lastEventId !== anchor.baselineLastEventId ||
          messages.length !== anchor.baselineLength;

    if (!boundaryChanged) return;

    const alignAnchorToSavedViewport = (el: HTMLElement) => {
      if (anchor.anchorEventId && anchor.anchorViewportTop != null) {
        const anchorEl = findMessageRow(el, anchor.anchorEventId);
        if (anchorEl) {
          const cr = el.getBoundingClientRect();
          const ar = anchorEl.getBoundingClientRect();
          const cur = ar.top - cr.top;
          el.scrollTop += cur - anchor.anchorViewportTop;
          return;
        }
      }
      const delta = el.scrollHeight - anchor.scrollHeight;
      el.scrollTop = anchor.scrollTop + delta;
    };

    alignAnchorToSavedViewport(container);
    skipAutoScrollOnceRef.current = true;
    windowShiftAnchorRef.current = null;
  }, [messages.length, messages[0]?.eventId, messages[messages.length - 1]?.eventId]);

  useLayoutEffect(() => {
    const anchor = windowShiftAnchorRef.current;
    if (!anchor || anchor.direction !== "older" || loading) return;
    const firstEventId = messages[0]?.eventId;
    const lastEventId = messages[messages.length - 1]?.eventId;
    const unchanged =
      firstEventId === anchor.baselineFirstEventId &&
      lastEventId === anchor.baselineLastEventId &&
      messages.length === anchor.baselineLength;
    if (unchanged) {
      windowShiftAnchorRef.current = null;
    }
  }, [loading, messages.length, messages[0]?.eventId, messages[messages.length - 1]?.eventId]);

  useLayoutEffect(() => {
    if (skipAutoScrollOnceRef.current) {
      skipAutoScrollOnceRef.current = false;
      return;
    }
    if (windowShiftAnchorRef.current) return;
    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView();
    }
  }, [messages.length, messages[messages.length - 1]?.eventId]);

  const captureWindowShiftAnchor = useCallback((direction: "older" | "newer") => {
    const container = containerRef.current;
    if (!container) return;
    const firstEventId = messagesRef.current[0]?.eventId;
    const lastEventId = messagesRef.current[messagesRef.current.length - 1]?.eventId;
    const anchorEventId = direction === "older" ? firstEventId : lastEventId;
    let anchorViewportTop: number | null = null;
    if (anchorEventId) {
      const anchorEl = findMessageRow(container, anchorEventId);
      if (anchorEl) {
        const cr = container.getBoundingClientRect();
        const ar = anchorEl.getBoundingClientRect();
        anchorViewportTop = ar.top - cr.top;
      }
    }

    windowShiftAnchorRef.current = {
      direction,
      anchorEventId,
      anchorViewportTop,
      baselineFirstEventId: firstEventId,
      baselineLastEventId: lastEventId,
      baselineLength: messagesRef.current.length,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
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
    const cont = containerRef.current;
    cont?.addEventListener("scroll", update, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      cont?.removeEventListener("scroll", update);
    };
  }, [openMenuEventId, spacing.unit]);

  const openMenuMsg =
    openMenuEventId === null ? undefined : messages.find((m) => m.eventId === openMenuEventId);

  // Use refs for values that change often but are only read inside the rAF callback
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const canRestoreNewerRef = useRef(canRestoreNewer);
  canRestoreNewerRef.current = canRestoreNewer;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const onLoadNewerRef = useRef(onLoadNewer);
  onLoadNewerRef.current = onLoadNewer;

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = containerRef.current;
      if (!container) return;

      shouldAutoScrollRef.current = isNearBottom();

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const topPrefetchThreshold = Math.max(
        180,
        Math.min(600, container.clientHeight * 0.75),
      );
      const bottomRestoreThreshold = Math.max(
        140,
        Math.min(420, container.clientHeight * 0.45),
      );

      if (windowShiftAnchorRef.current || loadingRef.current) return;

      if (hasMoreRef.current && container.scrollTop < topPrefetchThreshold) {
        console.log(
          `[MessageList] scroll→loadMore: scrollTop=${container.scrollTop.toFixed(0)} topThreshold=${topPrefetchThreshold.toFixed(0)} loadingRef=${loadingRef.current} hasMoreRef=${hasMoreRef.current}`
        );
        captureWindowShiftAnchor("older");
        onLoadMoreRef.current();
        return;
      }

      if (canRestoreNewerRef.current && distanceFromBottom < bottomRestoreThreshold) {
        console.log(
          `[MessageList] scroll→loadNewer: distanceFromBottom=${distanceFromBottom.toFixed(0)} bottomThreshold=${bottomRestoreThreshold.toFixed(0)} canRestoreNewer=${canRestoreNewerRef.current}`
        );
        captureWindowShiftAnchor("newer");
        onLoadNewerRef.current();
      }
    });
  }, [captureWindowShiftAnchor]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const handleOpenMenu = useCallback((eventId: string) => {
    setOpenMenuEventId((id) => (id === eventId ? null : eventId));
  }, []);

  if (initialLoading) {
    return (
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: palette.textSecondary,
      }}>
        Loading messages...
      </div>
    );
  }

  const rowHighlight =
    resolvedColorScheme === "light" ? "rgba(0, 0, 0, 0.055)" : "rgba(255, 255, 255, 0.06)";

  const jumpToRecentLabel =
    pendingRecentCount > 0
      ? `Jump to recent (${pendingRecentCount} new${pendingRecentCount === 1 ? "" : "s"})`
      : "Jump to recent";

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        paddingTop: spacing.unit * 6,
        paddingBottom: spacing.unit * 4,
        paddingLeft: 0,
        paddingRight: 0,
      }}
    >
      {/* CSS-driven hover — no React state changes on mouse move */}
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

      {(hasMore || messages.length > 0) && (
        <div
          style={{
            boxSizing: "border-box",
            minHeight: spacing.unit * 10,
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
          {hasMore
            ? loading
              ? "Loading older messages..."
              : "Scroll up for more"
            : "Beginning of conversation"}
        </div>
      )}

      {loading && (
        <LoadingMessageSkeletons
          count={LOADING_SKELETON_ROWS}
          palette={palette}
          spacingUnit={spacing.unit}
        />
      )}

      {messages.map((msg, i) => {
        const showHeader = shouldShowHeader(msg, messages[i - 1] ?? null);
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
                  bottomRef.current?.scrollIntoView({ block: "end" });
                });
              });
            }}
            title={
              pageDistanceFromRecent > 0
                ? `${pageDistanceFromRecent} page${pageDistanceFromRecent === 1 ? "" : "s"} from recent`
                : "Jump to recent"
            }
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
            {jumpToRecentLabel}
          </button>
        </div>
      )}

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

      {refreshing && (
        <div style={{
          display: "flex",
          justifyContent: "center",
          padding: spacing.unit * 3,
        }}>
          <div style={{
            width: 20,
            height: 20,
            border: `2px solid ${palette.border}`,
            borderTopColor: palette.accent,
            borderRadius: "50%",
            animation: "messageListSpinner 0.8s linear infinite",
          }} />
        </div>
      )}

      <div ref={bottomRef} />

      <MediaViewerModal
        open={mediaViewer != null}
        onClose={() => setMediaViewer(null)}
        payload={mediaViewer}
      />
    </div>
  );
}
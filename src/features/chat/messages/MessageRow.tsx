import { memo } from "react";
import {
  MoreVertical,
  Smile,
  Reply,
} from "lucide-react";
import type { Message, MessageReaction } from "../../../types/matrix";
import type { ResolvedColorScheme } from "../../../theme/types";
import type { useTheme } from "../../../theme/ThemeContext";
import type { MediaViewerOpenPayload } from "../../../components/MediaViewerModal";
import UserAvatar from "../../../components/UserAvatar";
import MessageContent from "./MessageContent";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  MessageRow                                                         */
/* ------------------------------------------------------------------ */

export interface MessageRowProps {
  msg: Message;
  showHeader: boolean;
  /** Reply control in the hover bar (not the ⋮ menu). */
  showReplyButton: boolean;
  /** Edit / delete / pin in the ⋮ menu. */
  showOverflowMenu: boolean;
  showHoverActions: boolean;
  canReact: boolean;
  isMenuOpen: boolean;
  isReactionPickerOpen: boolean;
  onRequestReply: () => void;
  onOpenMenu: (eventId: string) => void;
  onToggleReactionPicker: (eventId: string) => void;
  onOpenMediaViewer: (payload: MediaViewerOpenPayload) => void;
  onOpenDirectImage: (url: string, title: string) => void;
  menuAnchorRef: React.RefObject<HTMLButtonElement | null>;
  reactionPickerAnchorRef: React.RefObject<HTMLButtonElement | null>;
  onReactionChipClick: (key: string, reactedByMe: boolean) => void;
  onReactionChipHover: (
    e: React.MouseEvent<HTMLButtonElement>,
    r: MessageReaction,
  ) => void;
  onReactionChipHoverEnd: () => void;
  rowHighlight: string;
  spacingUnit: number;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  resolvedColorScheme: ResolvedColorScheme;
  replyThread: {
    targetEventId: string;
    senderLabel: string;
    text: string;
  } | null;
  onReplyThreadClick: (eventId: string) => void;
  onOpenSenderProfile?: (senderUserId: string) => void;
  /** Resolve a user MXID to a display name (for mention pills). */
  resolveMemberLabel?: (userId: string) => string;
}

const MessageRow = memo(function MessageRow({
  msg,
  showHeader,
  showReplyButton,
  showOverflowMenu,
  showHoverActions,
  canReact,
  isMenuOpen,
  isReactionPickerOpen,
  onRequestReply,
  onOpenMenu,
  onToggleReactionPicker,
  onOpenMediaViewer,
  onOpenDirectImage,
  menuAnchorRef,
  reactionPickerAnchorRef,
  onReactionChipClick,
  onReactionChipHover,
  onReactionChipHoverEnd,
  rowHighlight,
  spacingUnit,
  palette,
  typography,
  resolvedColorScheme,
  replyThread,
  onReplyThreadClick,
  onOpenSenderProfile,
  resolveMemberLabel,
}: MessageRowProps) {
  const menuBtn = spacingUnit * 7;
  const rowActive = isMenuOpen || isReactionPickerOpen;
  const groupShadow =
    resolvedColorScheme === "light"
      ? "0 1px 3px rgba(0,0,0,0.08)"
      : "0 2px 8px rgba(0,0,0,0.35)";
  type HoverActionKind = "reply" | "react" | "menu";
  const hoverActionKinds: HoverActionKind[] = [];
  if (showReplyButton) hoverActionKinds.push("reply");
  if (canReact) hoverActionKinds.push("react");
  if (showOverflowMenu) hoverActionKinds.push("menu");

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
        backgroundColor: rowActive ? rowHighlight : "transparent",
        transition: "background-color 0.12s ease",
      }}
    >
      {/* Avatar column */}
      <div style={{ width: 40, flexShrink: 0 }}>
        {showHeader &&
          (onOpenSenderProfile ? (
            <button
              type="button"
              title="View profile"
              onClick={() => onOpenSenderProfile(msg.sender)}
              style={{
                display: "block",
                margin: 0,
                padding: 0,
                border: "none",
                background: "none",
                cursor: "pointer",
                borderRadius: "50%",
                lineHeight: 0,
              }}
            >
              <UserAvatar
                userId={msg.sender}
                displayName={msg.senderName ?? msg.sender}
                avatarUrlHint={msg.avatarUrl}
                size={40}
              />
            </button>
          ) : (
            <UserAvatar
              userId={msg.sender}
              displayName={msg.senderName ?? msg.sender}
              avatarUrlHint={msg.avatarUrl}
              size={40}
            />
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
            {onOpenSenderProfile ? (
              <button
                type="button"
                title="View profile"
                onClick={() => onOpenSenderProfile(msg.sender)}
                style={{
                  margin: 0,
                  padding: 0,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  font: "inherit",
                  fontWeight: typography.fontWeightMedium,
                  color: palette.textHeading,
                  fontSize: typography.fontSizeBase,
                  textAlign: "left",
                }}
              >
                {msg.senderName ?? msg.sender}
              </button>
            ) : (
              <span
                style={{
                  fontWeight: typography.fontWeightMedium,
                  color: palette.textHeading,
                  fontSize: typography.fontSizeBase,
                }}
              >
                {msg.senderName ?? msg.sender}
              </span>
            )}
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

        {replyThread ? (
          <button
            type="button"
            onClick={() => onReplyThreadClick(replyThread.targetEventId)}
            title="Jump to original message"
            style={{
              display: "block",
              width: "100%",
              marginTop: showHeader ? spacingUnit : spacingUnit * 0.5,
              marginBottom: spacingUnit * 0.5,
              padding: `${spacingUnit * 0.9}px ${spacingUnit * 1.25}px`,
              textAlign: "left",
              border: "none",
              borderLeft: `3px solid ${palette.textSecondary}`,
              borderRadius: spacingUnit * 0.75,
              backgroundColor: palette.bgTertiary,
              cursor: "pointer",
              fontFamily: typography.fontFamily,
            }}
          >
            <div
              style={{
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                color: palette.textHeading,
                marginBottom: 2,
              }}
            >
              {replyThread.senderLabel}
            </div>
            <div
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {replyThread.text}
            </div>
          </button>
        ) : null}

        <MessageContent
          msg={msg}
          spacingUnit={spacingUnit}
          palette={palette}
          typography={typography}
          onOpenMediaViewer={onOpenMediaViewer}
          onOpenDirectImage={onOpenDirectImage}
          onOpenSenderProfile={onOpenSenderProfile}
          resolveMemberLabel={resolveMemberLabel}
        />
        {msg.reactions && msg.reactions.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: spacingUnit * 1.4,
              marginTop: spacingUnit * 1.5,
            }}
            role="group"
            aria-label="Reactions"
          >
            {msg.reactions.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-label={
                  r.reactedByMe
                    ? `Remove your ${r.key} reaction`
                    : `React with ${r.key}`
                }
                onClick={() => onReactionChipClick(r.key, r.reactedByMe)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: spacingUnit * 0.85,
                  minHeight: spacingUnit * 6.5,
                  padding: `${spacingUnit * 1.1}px ${spacingUnit * 2.1}px`,
                  borderRadius: 9999,
                  border: `1px solid ${r.reactedByMe ? palette.border : palette.border}`,
                  backgroundColor: r.reactedByMe
                    ? `${palette.bgActive}`
                    : palette.bgTertiary,
                  color: palette.textPrimary,
                  fontSize: Math.round(typography.fontSizeBase * 1.2),
                  lineHeight: 1.1,
                  fontFamily: `${typography.fontFamily}, var(--pax-twemoji-font-stack)`,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.filter = "brightness(1.06)";
                  onReactionChipHover(e, r);
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = "none";
                  onReactionChipHoverEnd();
                }}
              >
                <span aria-hidden>{r.key}</span>
                <span
                  style={{
                    color: palette.textSecondary,
                    fontSize: Math.round(typography.fontSizeBase * 1.05),
                    fontWeight: typography.fontWeightMedium,
                    minWidth: "1.1em",
                    textAlign: "center",
                    fontFeatureSettings: '"tnum"',
                    fontFamily: typography.fontFamily,
                  }}
                >
                  {r.count}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Reply + react + overflow (hover), single control group */}
      {showHoverActions && (
        <div
          data-message-actions-root
          className="pax-message-actions"
          style={{
            position: "absolute",
            top: 0,
            right: spacingUnit * 2,
            transform: "translateY(-50%)",
            zIndex: 2,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            ...(rowActive
              ? { opacity: 1, pointerEvents: "auto" as const }
              : {}),
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "stretch",
              border: `1px solid ${palette.border}`,
              borderRadius: spacingUnit * 1.25,
              overflow: "hidden",
              backgroundColor: palette.bgTertiary,
              boxShadow: groupShadow,
            }}
          >
            {hoverActionKinds.map((kind, i) => {
              const isFirst = i === 0;
              const segBtn = {
                display: "flex" as const,
                alignItems: "center" as const,
                justifyContent: "center" as const,
                width: menuBtn,
                minHeight: menuBtn,
                padding: 0,
                border: "none" as const,
                borderLeft: isFirst
                  ? "none"
                  : (`1px solid ${palette.border}` as const),
                borderRadius: 0,
                color: palette.textSecondary,
                cursor: "pointer" as const,
              };
              if (kind === "reply") {
                return (
                  <button
                    key="reply"
                    type="button"
                    title="Reply"
                    aria-label="Reply"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onRequestReply}
                    style={{
                      ...segBtn,
                      backgroundColor: palette.bgTertiary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = palette.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = palette.bgTertiary;
                    }}
                  >
                    <Reply size={18} strokeWidth={2} />
                  </button>
                );
              }
              if (kind === "react") {
                return (
                  <button
                    key="react"
                    ref={
                      isReactionPickerOpen ? reactionPickerAnchorRef : undefined
                    }
                    type="button"
                    aria-label="Add reaction"
                    aria-expanded={isReactionPickerOpen}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onToggleReactionPicker(msg.eventId)}
                    style={{
                      ...segBtn,
                      backgroundColor: isReactionPickerOpen
                        ? palette.bgHover
                        : palette.bgTertiary,
                    }}
                    onMouseEnter={(e) => {
                      if (!isReactionPickerOpen) {
                        e.currentTarget.style.backgroundColor = palette.bgHover;
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = isReactionPickerOpen
                        ? palette.bgHover
                        : palette.bgTertiary;
                    }}
                  >
                    <Smile size={18} strokeWidth={2} />
                  </button>
                );
              }
              return (
                <button
                  key="menu"
                  ref={isMenuOpen ? menuAnchorRef : undefined}
                  type="button"
                  title="Message actions"
                  aria-expanded={isMenuOpen}
                  aria-haspopup="menu"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onOpenMenu(msg.eventId)}
                  style={{
                    ...segBtn,
                    backgroundColor: isMenuOpen
                      ? palette.bgHover
                      : palette.bgTertiary,
                  }}
                  onMouseEnter={(e) => {
                    if (!isMenuOpen) {
                      e.currentTarget.style.backgroundColor = palette.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = isMenuOpen
                      ? palette.bgHover
                      : palette.bgTertiary;
                  }}
                >
                  <MoreVertical size={18} strokeWidth={2} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageRow;

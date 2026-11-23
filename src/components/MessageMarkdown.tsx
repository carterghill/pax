import React, { useMemo, useCallback, useState, isValidElement, memo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Element, ElementContent, Root } from "hast";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  emojifyMarkdownChildren,
  EMOJI_ONLY_DISPLAY_SCALE,
  isOnlyEmojisAndWhitespace,
} from "../utils/emojifyTwemoji";
import { resolveEmbed } from "../utils/urlEmbed";
import LinkEmbed from "./LinkEmbed";
import MessageMatrixImage from "./MessageMatrixImage";
import RoomLinkPreview from "./RoomLinkPreview";
import {
  Braces,
  ExternalLink,
  Heading1,
  Heading2,
  Heading3,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Table2,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import {
  fileNameFromImageUrl,
  hrefLooksLikeDirectImageUrl,
  normalizeImageSrcHref,
} from "../utils/directImageUrl";
import { MATRIX_BODY_MXID_RE_GLOBAL, mentionDisplayName, mentionPillLabel } from "../utils/matrixBodyMxid";
import { appendRoomLinkPreviews, roomLinkTarget } from "../utils/roomLinks";
import {
  isMatrixMediaUri,
  isMatrixMessageLink,
  matrixHtmlToHast,
  matrixUserHref,
  matrixUserIdFromHref,
  parseMatrixMessageHtml,
} from "../utils/matrixMessageHtml";

/** Word joiners distinguish the edit label from message content. */
const EDITED_LABEL = "\u2060(edited)\u2060";

interface MessageMarkdownProps {
  children: string;
  /** When true, append an inline “(edited)” label at the end of the rendered text (same line as the last line). */
  edited?: boolean;
  /** When set, https image/GIF links (inline previews) open in the app media viewer instead of the browser. */
  onOpenDirectImage?: (url: string, title: string) => void;
  formattedBody?: string;
  mentionedUserIds?: string[];
  mentionsRoom?: boolean;
  selfUserId?: string;
  /** Resolve a user MXID to a display name for the pill label. */
  resolveMemberLabel?: (userId: string) => string;
  /** Called when a mention pill is clicked (opens the user's profile). */
  onMentionClick?: (userId: string) => void;
}

function flattenTextNode(value: ReactNode): string {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(flattenTextNode).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return flattenTextNode(value.props.children);
  return "";
}

function isEditedEmphasisContent(value: ReactNode): boolean {
  const s = flattenTextNode(value).replace(/\s/g, "");
  return /^\u2060?\(edited\)\u2060?$/.test(s);
}

function codeBlockLabel(children: ReactNode): string {
  const first = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(first)) return "Code";
  const props = first.props as { className?: string };
  const cn = props.className ?? "";
  const m = cn.match(/language-([\w-]+)/);
  if (!m) return "Code";
  return m[1].replace(/-/g, " ");
}

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^https?:\/\//i.test(href) || href.startsWith("//");
}

function MentionPillSpan({
  label,
  userId,
  onClick,
  style,
  hoverBg,
}: {
  label: string;
  userId: string | null;
  onClick: ((userId: string) => void) | undefined;
  style: React.CSSProperties;
  hoverBg: string;
}) {
  return (
    <span
      role={userId && onClick ? "button" : undefined}
      tabIndex={userId && onClick ? 0 : undefined}
      onClick={
        userId && onClick
          ? (e: MouseEvent) => {
              e.stopPropagation();
              onClick(userId);
            }
          : undefined
      }
      onKeyDown={
        userId && onClick
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick(userId);
              }
            }
          : undefined
      }
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLSpanElement).style.backgroundColor = hoverBg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLSpanElement).style.backgroundColor =
          style.backgroundColor as string;
      }}
      style={style}
    >
      {label}
    </span>
  );
}

function MatrixSpoiler({ reason, children }: { reason: string; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  const { palette, spacing } = useTheme();
  return (
    <span>
      <button
        type="button"
        aria-expanded={revealed}
        onClick={() => setRevealed((previous) => !previous)}
        style={{
          padding: `0 ${spacing.unit}px`, borderRadius: spacing.unit / 2,
          border: `1px solid ${palette.border}`, background: palette.bgActive,
          color: palette.textPrimary, font: "inherit", cursor: "pointer",
        }}
      >
        {revealed ? "Hide spoiler" : "Show spoiler"}{reason && ` (${reason})`}
      </button>
      {revealed && <> {children}</>}
    </span>
  );
}

export default memo(function MessageMarkdown({
  children,
  edited = false,
  onOpenDirectImage,
  formattedBody,
  mentionedUserIds,
  mentionsRoom,
  selfUserId,
  resolveMemberLabel,
  onMentionClick,
}: MessageMarkdownProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();

  const mentionSet = useMemo(() => new Set(mentionedUserIds), [mentionedUserIds]);
  const legacyMentions = mentionedUserIds == null;
  const formatted = useMemo(() => {
    if (!formattedBody) return null;
    const fragment = parseMatrixMessageHtml(formattedBody);
    return fragment.firstElementChild || fragment.textContent?.trim() ? fragment : null;
  }, [formattedBody]);
  const renderMention = useCallback((userId: string | null, label: string) => {
    const isSelf = userId != null && userId === selfUserId && mentionSet.has(userId);
    return (
      <MentionPillSpan
        userId={userId}
        label={label}
        onClick={onMentionClick}
        hoverBg={`${palette.accent}38`}
        style={{
          display: "inline",
          padding: "1px 6px",
          borderRadius: 4,
          backgroundColor: `${palette.accent}22`,
          boxShadow: isSelf ? `inset 0 0 0 1px ${palette.accent}80` : undefined,
          color: palette.accent,
          fontWeight: 500,
          cursor: userId && onMentionClick ? "pointer" : "default",
          userSelect: "text",
          transition: "background-color 120ms ease",
        }}
      />
    );
  }, [palette.accent, selfUserId, mentionSet, onMentionClick]);

  const messagePlugins = useMemo(() => [() => (tree: Root) => {
    if (formatted) {
      tree.children = matrixHtmlToHast(formatted);
      if (edited) {
        const label: Element = {
          type: "element",
          tagName: "em",
          properties: {},
          children: [{ type: "text", value: EDITED_LABEL }],
        };
        const last = tree.children[tree.children.length - 1];
        if (last?.type === "element" && last.tagName === "p") {
          last.children.push({ type: "text", value: " " }, label);
        } else {
          tree.children.push({ type: "text", value: " " }, label);
        }
      }
    }
    function markMentions(parent: Root | Element) {
      let index = 0;
      while (index < parent.children.length) {
        const child = parent.children[index];
        if (child.type === "element" && !["a", "code", "pre"].includes(child.tagName)) {
          markMentions(child);
        }
        if (child.type !== "text") {
          index++;
          continue;
        }

        const parts: ElementContent[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(MATRIX_BODY_MXID_RE_GLOBAL)) {
          const id = match[0];
          if (id === "@room" ? !mentionsRoom : !legacyMentions && !mentionSet.has(id)) continue;
          if (match.index > offset) parts.push({ type: "text", value: child.value.slice(offset, match.index) });
          parts.push({
            type: "element",
            tagName: "span",
            properties: { dataMentionId: id },
            children: [],
          });
          offset = match.index + id.length;
        }
        if (parts.length === 0) {
          index++;
          continue;
        }
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        parent.children.splice(index, 1, ...parts);
        index += parts.length;
      }
    }
    if (mentionsRoom || legacyMentions || mentionSet.size > 0) markMentions(tree);
    appendRoomLinkPreviews(tree);
  }], [edited, formatted, legacyMentions, mentionSet, mentionsRoom]);

  const markdownSource = useMemo(() => {
    if (formatted) return "";
    if (!edited) return children;
    return `${children.trimEnd()} *${EDITED_LABEL}*`;
  }, [children, edited, formatted]);

  const emojiOnlyBody = useMemo(() => !formatted && isOnlyEmojisAndWhitespace(children), [children, formatted]);

  const components = useMemo<Components>(
    () => {
      const E = ({ children: c }: { children: ReactNode }) => (
        <>{emojifyMarkdownChildren(c)}</>
      );

      return {
      div: ({ node, children: c }) => {
        const url = node?.properties.dataRoomLinkPreview;
        return typeof url === "string" ? <RoomLinkPreview url={url} /> : <div>{c}</div>;
      },
      span: ({ node, children: c }) => {
        const id = node?.properties.dataMentionId;
        if (id === "@room") return renderMention(null, id);
        if (typeof id === "string" && (legacyMentions || mentionSet.has(id))) {
          return renderMention(id, mentionPillLabel(id, mentionDisplayName(id, resolveMemberLabel?.(id))));
        }
        const { dataMxSpoiler, dataMxColor, dataMxBgColor } = node?.properties ?? {};
        const content = (
          <span style={{
            color: typeof dataMxColor === "string" ? dataMxColor : undefined,
            backgroundColor: typeof dataMxBgColor === "string" ? dataMxBgColor : undefined,
          }}><E>{c}</E></span>
        );
        return typeof dataMxSpoiler === "string" ? <MatrixSpoiler reason={dataMxSpoiler}>{content}</MatrixSpoiler> : content;
      },
      p: ({ children: c }) => (
        <p
          style={{
            margin: 0,
            color: palette.textPrimary,
            fontSize: typography.fontSizeBase,
            lineHeight: typography.lineHeight,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          <E>{c}</E>
        </p>
      ),
      strong: ({ children: c }) => (
        <strong style={{ fontWeight: typography.fontWeightBold }}>
          <E>{c}</E>
        </strong>
      ),
      em: ({ children: c }) => {
        if (edited && isEditedEmphasisContent(c)) {
          return (
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                fontStyle: "italic",
                fontWeight: typography.fontWeightNormal,
              }}
            >
              (edited)
            </span>
          );
        }
        return (
          <em style={{ fontStyle: "italic" }}>
            <E>{c}</E>
          </em>
        );
      },
      del: ({ children: c }) => (
        <del style={{ textDecoration: "line-through" }}>
          <E>{c}</E>
        </del>
      ),
      a: ({ href, children: c }) => {
        if (!href) return <E>{c}</E>;
        const userId = matrixUserIdFromHref(href);
        if (userId && mentionSet.has(userId)) {
          const displayName = mentionDisplayName(userId, resolveMemberLabel?.(userId), flattenTextNode(c));
          const label = mentionPillLabel(userId, displayName);
          return onMentionClick
            ? renderMention(userId, label)
            : <a href={matrixUserHref(userId)} rel="noopener noreferrer">{renderMention(userId, label)}</a>;
        }
        const src = normalizeImageSrcHref(href);
        const canPreviewImage = !formattedBody || (formatted && flattenTextNode(c).trim() === href);
        if (src && canPreviewImage && hrefLooksLikeDirectImageUrl(href)) {
          const alt = flattenTextNode(c).trim() || "Image";
          const imgStyle = {
            maxWidth: "100%",
            height: "auto" as const,
            borderRadius: spacing.unit,
            display: "block" as const,
            marginTop: spacing.unit,
            marginBottom: spacing.unit,
          };
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...(onOpenDirectImage
                ? {
                    "data-pax-open-image-viewer": "",
                    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenDirectImage(src, alt);
                    },
                  }
                : {})}
              style={{
                display: "block",
                maxWidth: "100%",
                lineHeight: 0,
                textDecoration: "none",
                ...(onOpenDirectImage ? { cursor: "pointer" } : {}),
              }}
            >
              <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} style={imgStyle} />
            </a>
          );
        }

        const external = isExternalHref(href);
        const LinkIcon = external ? ExternalLink : Link2;

        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: spacing.unit * 0.75,
              color: palette.accent,
              textDecoration: "underline",
              textUnderlineOffset: 2,
              wordBreak: "break-all",
            }}
          >
            {emojifyMarkdownChildren(c)}
            <LinkIcon
              size={Math.round(typography.fontSizeSmall)}
              strokeWidth={2}
              style={{
                flexShrink: 0,
                opacity: 0.85,
                verticalAlign: "middle",
              }}
              aria-hidden
            />
          </a>
        );
      },
      code: ({ className, children: c }) => {
        const isBlock = Boolean(className?.includes("language-"));
        if (isBlock) {
          return (
            <code
              className={className}
              style={{
                display: "block",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: typography.fontSizeSmall,
                lineHeight: typography.lineHeight,
              }}
            >
              {c}
            </code>
          );
        }
        return (
          <code
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: typography.fontSizeSmall,
              padding: `0 ${Math.max(2, spacing.unit / 2)}px`,
              borderRadius: spacing.unit / 2,
              backgroundColor: palette.bgActive,
              color: palette.textPrimary,
              wordBreak: "break-word",
            }}
          >
            {c}
          </code>
        );
      },
      pre: ({ children: c }) => {
        const label = codeBlockLabel(c);
        return (
          <div
            style={{
              margin: `${spacing.unit * 1.5}px 0`,
              borderRadius: spacing.unit * 1.25,
              border: `1px solid ${palette.border}`,
              overflow: "hidden",
              backgroundColor: palette.bgSecondary,
              boxShadow:
                resolvedColorScheme === "light"
                  ? "0 1px 2px rgba(0,0,0,0.04)"
                  : "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.unit * 1.5,
                padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
                backgroundColor: palette.bgTertiary,
                borderBottom: `1px solid ${palette.border}`,
              }}
            >
              <Braces
                size={Math.round(typography.fontSizeSmall + 2)}
                strokeWidth={2}
                color={palette.textSecondary}
                aria-hidden
              />
              <span
                style={{
                  fontSize: typography.fontSizeSmall,
                  fontWeight: typography.fontWeightMedium,
                  color: palette.textSecondary,
                  textTransform: "capitalize",
                  letterSpacing: "0.02em",
                }}
              >
                {label}
              </span>
            </div>
            <pre
              style={{
                margin: 0,
                padding: spacing.unit * 2,
                overflow: "auto",
                maxWidth: "100%",
                backgroundColor: palette.bgSecondary,
                border: "none",
              }}
            >
              {c}
            </pre>
          </div>
        );
      },
      ul: ({ children: c }) => (
        <div
          style={{
            display: "flex",
            gap: spacing.unit * 1.5,
            margin: `${spacing.unit}px 0`,
            alignItems: "flex-start",
          }}
        >
          <List
            size={Math.round(typography.fontSizeBase)}
            strokeWidth={2}
            color={palette.textSecondary}
            style={{ flexShrink: 0, marginTop: spacing.unit * 0.5, opacity: 0.9 }}
            aria-hidden
          />
          <ul
            style={{
              margin: 0,
              paddingLeft: spacing.unit * 3,
              flex: 1,
              minWidth: 0,
              color: palette.textPrimary,
              fontSize: typography.fontSizeBase,
              lineHeight: typography.lineHeight,
            }}
          >
            <E>{c}</E>
          </ul>
        </div>
      ),
      ol: ({ children: c, start }) => (
        <div
          style={{
            display: "flex",
            gap: spacing.unit * 1.5,
            margin: `${spacing.unit}px 0`,
            alignItems: "flex-start",
          }}
        >
          <ListOrdered
            size={Math.round(typography.fontSizeBase)}
            strokeWidth={2}
            color={palette.textSecondary}
            style={{ flexShrink: 0, marginTop: spacing.unit * 0.5, opacity: 0.9 }}
            aria-hidden
          />
          <ol
            start={start}
            style={{
              margin: 0,
              paddingLeft: spacing.unit * 3,
              flex: 1,
              minWidth: 0,
              color: palette.textPrimary,
              fontSize: typography.fontSizeBase,
              lineHeight: typography.lineHeight,
            }}
          >
            <E>{c}</E>
          </ol>
        </div>
      ),
      li: ({ children: c }) => (
        <li style={{ margin: `${spacing.unit / 2}px 0` }}>
          <E>{c}</E>
        </li>
      ),
      blockquote: ({ children: c }) => (
        <blockquote
          style={{
            display: "flex",
            gap: spacing.unit * 2,
            margin: `${spacing.unit * 1.5}px 0`,
            padding: spacing.unit * 2,
            borderRadius: spacing.unit,
            borderLeft: `3px solid ${palette.accent}`,
            backgroundColor: palette.bgActive,
            color: palette.textSecondary,
          }}
        >
          <Quote
            size={Math.round(typography.fontSizeBase + 2)}
            strokeWidth={2}
            color={palette.accent}
            style={{ flexShrink: 0, marginTop: 2, opacity: 0.9 }}
            aria-hidden
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <E>{c}</E>
          </div>
        </blockquote>
      ),
      h1: ({ children: c }) => (
        <h1
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 1.5,
            margin: `${spacing.unit * 2}px 0 ${spacing.unit}px`,
            fontSize: typography.fontSizeLarge + 4,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            lineHeight: typography.lineHeight,
          }}
        >
          <Heading1
            size={Math.round(typography.fontSizeLarge + 2)}
            strokeWidth={2}
            color={palette.accent}
            style={{ flexShrink: 0, opacity: 0.95 }}
            aria-hidden
          />
          <E>{c}</E>
        </h1>
      ),
      h2: ({ children: c }) => (
        <h2
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 1.5,
            margin: `${spacing.unit * 2}px 0 ${spacing.unit}px`,
            fontSize: typography.fontSizeLarge + 2,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            lineHeight: typography.lineHeight,
          }}
        >
          <Heading2
            size={Math.round(typography.fontSizeLarge)}
            strokeWidth={2}
            color={palette.accent}
            style={{ flexShrink: 0, opacity: 0.95 }}
            aria-hidden
          />
          <E>{c}</E>
        </h2>
      ),
      h3: ({ children: c }) => (
        <h3
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 1.5,
            margin: `${spacing.unit * 1.5}px 0 ${spacing.unit}px`,
            fontSize: typography.fontSizeLarge,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            lineHeight: typography.lineHeight,
          }}
        >
          <Heading3
            size={Math.round(typography.fontSizeLarge - 2)}
            strokeWidth={2}
            color={palette.accent}
            style={{ flexShrink: 0, opacity: 0.95 }}
            aria-hidden
          />
          <E>{c}</E>
        </h3>
      ),
      hr: () => (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 2,
            margin: `${spacing.unit * 2}px 0`,
            color: palette.textSecondary,
          }}
          role="separator"
        >
          <div style={{ flex: 1, height: 1, backgroundColor: palette.border }} />
          <Minus size={16} strokeWidth={2} aria-hidden />
          <div style={{ flex: 1, height: 1, backgroundColor: palette.border }} />
        </div>
      ),
      table: ({ children: c }) => (
        <div
          style={{
            position: "relative",
            margin: `${spacing.unit * 1.5}px 0`,
            borderRadius: spacing.unit,
            border: `1px solid ${palette.border}`,
            overflow: "hidden",
            backgroundColor: palette.bgSecondary,
            boxShadow:
              resolvedColorScheme === "light"
                ? "0 1px 2px rgba(0,0,0,0.04)"
                : "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit * 1.5,
              padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
              backgroundColor: palette.bgTertiary,
              borderBottom: `1px solid ${palette.border}`,
            }}
          >
            <Table2
              size={Math.round(typography.fontSizeSmall + 2)}
              strokeWidth={2}
              color={palette.textSecondary}
              aria-hidden
            />
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                color: palette.textSecondary,
              }}
            >
              Table
            </span>
          </div>
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: typography.fontSizeSmall,
                color: palette.textPrimary,
                width: "100%",
              }}
            >
              {c}
            </table>
          </div>
        </div>
      ),
      th: ({ children: c }) => (
        <th
          style={{
            borderBottom: `1px solid ${palette.border}`,
            borderRight: `1px solid ${palette.border}`,
            padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
            textAlign: "left",
            backgroundColor: palette.bgActive,
            fontWeight: typography.fontWeightMedium,
          }}
        >
          <E>{c}</E>
        </th>
      ),
      td: ({ children: c }) => (
        <td
          style={{
            borderBottom: `1px solid ${palette.border}`,
            borderRight: `1px solid ${palette.border}`,
            padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
            verticalAlign: "top",
          }}
        >
          <E>{c}</E>
        </td>
      ),
      img: ({ src, alt, title, width, height }) => {
        const s = src?.trim() ?? "";
        if (isMatrixMediaUri(s)) {
          return (
            <MessageMatrixImage
              key={s}
              request={{ source: { url: s }, format: "File" }}
              metaWidth={typeof width === "number" ? width : undefined}
              metaHeight={typeof height === "number" ? height : undefined}
              inline={{ alt: alt ?? "", title }}
            />
          );
        }
        if (formattedBody || !s) return alt ?? null;
        const abs = s ? normalizeImageSrcHref(s) : null;
        const canViewer =
          Boolean(onOpenDirectImage && abs && /^https?:\/\//i.test(s));
        const imgStyle = {
          maxWidth: "100%",
          height: "auto" as const,
          borderRadius: spacing.unit,
          display: "block" as const,
          marginTop: spacing.unit,
          marginBottom: spacing.unit,
        };
        if (canViewer && abs) {
          const title = (alt ?? "").trim() || fileNameFromImageUrl(abs);
          return (
            <span
              role="button"
              tabIndex={0}
              data-pax-open-image-viewer=""
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenDirectImage!(abs, title);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenDirectImage!(abs, title);
                }
              }}
              style={{
                display: "block",
                maxWidth: "100%",
                cursor: "pointer",
                marginTop: spacing.unit,
                marginBottom: spacing.unit,
                borderRadius: spacing.unit,
                outline: "none",
              }}
            >
              <img
                src={src}
                alt={alt ?? ""}
                loading="lazy"
                decoding="async"
                draggable={false}
                style={{ ...imgStyle, marginTop: 0, marginBottom: 0 }}
              />
            </span>
          );
        }
        return (
          <img
            src={src}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            style={imgStyle}
          />
        );
      },
    };
    },
    [palette, typography, spacing, resolvedColorScheme, edited, formatted, formattedBody, onOpenDirectImage, onMentionClick, legacyMentions, mentionSet, renderMention, resolveMemberLabel],
  );

  // Keep embeds outside the message paragraphs and leave concealed links inside their disclosure.
  const embeds = useMemo(() => {
    const urlRe = /\bhttps?:\/\/[^\s)\]>"'`]+/gi;
    const urls = formatted
      ? Array.from(formatted.querySelectorAll("a[href]"))
          .filter((link) => !link.closest("[data-mx-spoiler], details, code, pre, blockquote"))
          .map((link) => link.getAttribute("href")!)
      : formattedBody ? [] : Array.from(children.matchAll(urlRe), ([url]) => url);
    return [...new Set(urls)].flatMap((href) => {
      const embed = resolveEmbed(href);
      return embed ? [{ href, embed }] : [];
    });
  }, [children, formatted, formattedBody]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing.unit,
        color: palette.textPrimary,
        fontSize: typography.fontSizeBase,
        lineHeight: typography.lineHeight,
        wordBreak: "break-word",
        ...(emojiOnlyBody ? { zoom: EMOJI_ONLY_DISPLAY_SCALE } : {}),
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={messagePlugins}
        urlTransform={(url, key) => {
          if (key === "src" && isMatrixMediaUri(url)) return url;
          if (formatted) return key === "href" && isMatrixMessageLink(url) ? url : "";
          return key === "href" && (matrixUserIdFromHref(url) || roomLinkTarget(url)) ? url : defaultUrlTransform(url);
        }}
        components={components}
      >
        {markdownSource}
      </ReactMarkdown>
      {embeds.map(({ href, embed }) => (
        <LinkEmbed key={href} embed={embed} href={href} />
      ))}
    </div>
  );
});

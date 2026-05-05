import React, { useMemo, useCallback, isValidElement, cloneElement, memo, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  emojifyMarkdownChildren,
  EMOJI_ONLY_DISPLAY_SCALE,
  isOnlyEmojisAndWhitespace,
} from "../utils/emojifyTwemoji";
import { resolveEmbed } from "../utils/urlEmbed";
import LinkEmbed from "./LinkEmbed";
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
import { MATRIX_BODY_MXID_RE_GLOBAL } from "../utils/matrixBodyMxid";

/** Word joiner–wrapped `(edited)` inside markdown emphasis so we can style it without matching user italics. */
const EDITED_EMPHASIS = ` *\u2060(edited)\u2060*`;

interface MessageMarkdownProps {
  children: string;
  /** When true, append an inline “(edited)” label at the end of the rendered text (same line as the last line). */
  edited?: boolean;
  /** When set, https image/GIF links (inline previews) open in the app media viewer instead of the browser. */
  onOpenDirectImage?: (url: string, title: string) => void;
  /** MXIDs from `m.mentions.user_ids`.  Only MXIDs in this list are pill-ified
   *  when found in the body text — avoids false positives from substring matching. */
  mentionedUserIds?: string[];
  /** Resolve a user MXID to a display name for the pill label. */
  resolveMemberLabel?: (userId: string) => string;
  /** Called when a mention pill is clicked (opens the user's profile). */
  onMentionClick?: (userId: string) => void;
}

function flattenTextNode(value: ReactNode): string {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(flattenTextNode).join("");
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

/* ------------------------------------------------------------------ */
/*  Mention pill processing                                            */
/* ------------------------------------------------------------------ */

const MXID_RE = MATRIX_BODY_MXID_RE_GLOBAL;

/**
 * Split a plain string at Matrix user ID boundaries, returning a mix of
 * text and pill React elements.
 *
 * Full MXIDs (`@localpart:server.tld`) in body text are always intentional
 * mentions — nobody types them by accident.  The regex is specific enough
 * to avoid false positives on plain words.
 *
 * When `mentionSet` is populated (from `m.mentions.user_ids`), only MXIDs
 * in that set are pill-ified — the tightest possible filter.  When it's
 * empty (older clients, ruma round-trip limitation), all regex-matched
 * MXIDs are pill-ified.  `@room` is always pill-ified.
 */
function mentionifyString(
  text: string,
  mentionSet: Set<string>,
  resolveLabel: (userId: string) => string,
  onMentionClick: ((userId: string) => void) | undefined,
  pillStyle: React.CSSProperties,
  pillHoverBg: string,
): ReactNode {
  MXID_RE.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  const hasStructuredMentions = mentionSet.size > 0;

  while ((m = MXID_RE.exec(text)) !== null) {
    const mxid = m[0];
    const isRoom = mxid === "@room";

    // When structured m.mentions is available, only pill-ify listed MXIDs.
    if (!isRoom && hasStructuredMentions && !mentionSet.has(mxid)) continue;

    if (m.index > cursor) nodes.push(text.slice(cursor, m.index));

    let label: string;
    if (isRoom) {
      label = "@room";
    } else {
      const resolved = resolveLabel(mxid);
      // resolveLabel returns the raw MXID when the user isn't in the member
      // map.  In that case, use the localpart as a clean fallback label
      // (e.g. "@carter" from "@carter:matrix.example.com") rather than
      // doubling the @ or showing the full server name.
      label = resolved.startsWith("@")
        ? resolved.split(":")[0]  // "@carter"
        : `@${resolved}`;        // "@Carter" from display name "Carter"
    }

    nodes.push(
      <MentionPillSpan
        key={`mp-${m.index}`}
        label={label}
        userId={isRoom ? null : mxid}
        onClick={onMentionClick}
        style={pillStyle}
        hoverBg={pillHoverBg}
      />,
    );
    cursor = m.index + mxid.length;
  }

  if (nodes.length === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** Minimal pill span — avoids a full component to keep the render tree light. */
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

/**
 * Walk a React node tree and replace text nodes that contain Matrix user IDs
 * with a mix of text and `MentionPillSpan` elements.  Mirrors the structure
 * of `emojifyReactNode` in emojifyTwemoji — recurse into children of valid
 * elements, leave code blocks untouched, process raw strings.
 */
function mentionifyReactNode(
  node: ReactNode,
  inCode: boolean,
  mentionSet: Set<string>,
  resolveLabel: (userId: string) => string,
  onMentionClick: ((userId: string) => void) | undefined,
  pillStyle: React.CSSProperties,
  pillHoverBg: string,
): ReactNode {
  if (inCode) return node;
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string") {
    return mentionifyString(node, mentionSet, resolveLabel, onMentionClick, pillStyle, pillHoverBg);
  }
  if (typeof node === "number") return node;
  if (Array.isArray(node)) {
    return node.map((child) =>
      mentionifyReactNode(child, inCode, mentionSet, resolveLabel, onMentionClick, pillStyle, pillHoverBg),
    );
  }
  if (isValidElement(node)) {
    const el = node as ReactElement;
    const tag = typeof el.type === "string" ? el.type : "";
    const nowInCode = inCode || tag === "code" || tag === "pre";
    const props = el.props as { children?: ReactNode };
    if (props.children != null) {
      const processed = mentionifyReactNode(
        props.children, nowInCode, mentionSet, resolveLabel, onMentionClick, pillStyle, pillHoverBg,
      );
      if (processed !== props.children) {
        return cloneElement(el, {}, processed);
      }
    }
  }
  return node;
}

export default memo(function MessageMarkdown({
  children,
  edited = false,
  onOpenDirectImage,
  mentionedUserIds,
  resolveMemberLabel,
  onMentionClick,
}: MessageMarkdownProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();

  // Pill styles — computed once and stable across renders.
  const pillStyle = useMemo<React.CSSProperties>(
    () => ({
      display: "inline",
      padding: "1px 6px",
      borderRadius: 4,
      backgroundColor: `${palette.accent}22`,
      color: palette.accent,
      fontWeight: 500,
      cursor: onMentionClick ? "pointer" : "default",
      userSelect: "text" as const,
      transition: "background-color 120ms ease",
    }),
    [palette.accent, onMentionClick],
  );
  const pillHoverBg = useMemo(() => `${palette.accent}38`, [palette.accent]);

  // Unified child-processing function: emoji first, then mention pills.
  const mentionSet = useMemo(
    () => new Set(mentionedUserIds ?? []),
    [mentionedUserIds],
  );

  const processNode = useCallback(
    (node: ReactNode): ReactNode => {
      const emojified = emojifyMarkdownChildren(node);
      if (!resolveMemberLabel) return emojified;
      return mentionifyReactNode(
        emojified, false, mentionSet, resolveMemberLabel, onMentionClick, pillStyle, pillHoverBg,
      );
    },
    [mentionSet, resolveMemberLabel, onMentionClick, pillStyle, pillHoverBg],
  );

  const markdownSource = useMemo(() => {
    if (!edited) return children;
    return `${children.trimEnd()}${EDITED_EMPHASIS}`;
  }, [children, edited]);

  const emojiOnlyBody = useMemo(() => isOnlyEmojisAndWhitespace(children), [children]);

  const components = useMemo<Components>(
    () => {
      // Local E wrapper: runs emoji + mention pill processing on children.
      // Defined here so it closes over `processNode` without needing a
      // separate component identity that would invalidate React's reconciler.
      const E = ({ children: c }: { children: ReactNode }) => (
        <>{processNode(c)}</>
      );

      return {
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
        const src = href ? normalizeImageSrcHref(href) : null;
        if (src && href && hrefLooksLikeDirectImageUrl(href)) {
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
            <E>{c}</E>
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
      ol: ({ children: c }) => (
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
      img: ({ src, alt }) => {
        const s = src?.trim() ?? "";
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
    [palette, typography, spacing, resolvedColorScheme, edited, onOpenDirectImage, processNode],
  );

  // Extract embeddable URLs from the raw text and render them below the markdown.
  // This keeps block-level embed elements (divs, video) outside the <p> tree.
  const embeds = useMemo(() => {
    const urlRe = /\bhttps?:\/\/[^\s)\]>"'`]+/gi;
    const seen = new Set<string>();
    const result: { href: string; embed: ReturnType<typeof resolveEmbed> }[] = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(children)) !== null) {
      const href = m[0];
      if (seen.has(href)) continue;
      seen.add(href);
      const embed = resolveEmbed(href);
      if (embed) result.push({ href, embed });
    }
    return result;
  }, [children]);

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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdownSource}
      </ReactMarkdown>
      {embeds.map(({ href, embed }) => (
        <LinkEmbed key={href} embed={embed!} href={href} />
      ))}
    </div>
  );
});
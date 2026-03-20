import { useMemo, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
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

/** Word joiner–wrapped `(edited)` inside markdown emphasis so we can style it without matching user italics. */
const EDITED_EMPHASIS = ` *\u2060(edited)\u2060*`;

interface MessageMarkdownProps {
  children: string;
  /** When true, append an inline “(edited)” label at the end of the rendered text (same line as the last line). */
  edited?: boolean;
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

export default function MessageMarkdown({ children, edited = false }: MessageMarkdownProps) {
  const { palette, typography, spacing, name: themeName } = useTheme();

  const markdownSource = useMemo(() => {
    if (!edited) return children;
    return `${children.trimEnd()}${EDITED_EMPHASIS}`;
  }, [children, edited]);

  const components = useMemo<Components>(
    () => ({
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
          {c}
        </p>
      ),
      strong: ({ children: c }) => (
        <strong style={{ fontWeight: typography.fontWeightBold }}>{c}</strong>
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
        return <em style={{ fontStyle: "italic" }}>{c}</em>;
      },
      a: ({ href, children: c }) => {
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
            {c}
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
                themeName === "light"
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
            {c}
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
            {c}
          </ol>
        </div>
      ),
      li: ({ children: c }) => (
        <li style={{ margin: `${spacing.unit / 2}px 0` }}>{c}</li>
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
          <div style={{ flex: 1, minWidth: 0 }}>{c}</div>
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
          {c}
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
          {c}
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
          {c}
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
              themeName === "light"
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
          {c}
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
          {c}
        </td>
      ),
      img: ({ src, alt }) => (
        <img
          src={src}
          alt={alt ?? ""}
          style={{
            maxWidth: "100%",
            height: "auto",
            borderRadius: spacing.unit,
            display: "block",
            marginTop: spacing.unit,
            marginBottom: spacing.unit,
          }}
        />
      ),
    }),
    [palette, typography, spacing, themeName, edited],
  );

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
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdownSource}
      </ReactMarkdown>
    </div>
  );
}

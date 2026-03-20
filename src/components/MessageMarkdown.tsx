import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { useTheme } from "../theme/ThemeContext";

interface MessageMarkdownProps {
  children: string;
}

export default function MessageMarkdown({ children }: MessageMarkdownProps) {
  const { palette, typography, spacing } = useTheme();

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
      em: ({ children: c }) => (
        <em style={{ fontStyle: "italic" }}>{c}</em>
      ),
      a: ({ href, children: c }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: palette.accent,
            textDecoration: "underline",
            textUnderlineOffset: 2,
            wordBreak: "break-all",
          }}
        >
          {c}
        </a>
      ),
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
      pre: ({ children: c }) => (
        <pre
          style={{
            margin: 0,
            padding: spacing.unit * 2,
            borderRadius: spacing.unit,
            backgroundColor: palette.bgSecondary,
            border: `1px solid ${palette.border}`,
            overflow: "auto",
            maxWidth: "100%",
          }}
        >
          {c}
        </pre>
      ),
      ul: ({ children: c }) => (
        <ul
          style={{
            margin: 0,
            paddingLeft: spacing.unit * 5,
            color: palette.textPrimary,
            fontSize: typography.fontSizeBase,
            lineHeight: typography.lineHeight,
          }}
        >
          {c}
        </ul>
      ),
      ol: ({ children: c }) => (
        <ol
          style={{
            margin: 0,
            paddingLeft: spacing.unit * 5,
            color: palette.textPrimary,
            fontSize: typography.fontSizeBase,
            lineHeight: typography.lineHeight,
          }}
        >
          {c}
        </ol>
      ),
      li: ({ children: c }) => (
        <li style={{ margin: `${spacing.unit / 2}px 0` }}>{c}</li>
      ),
      blockquote: ({ children: c }) => (
        <blockquote
          style={{
            margin: 0,
            paddingLeft: spacing.unit * 2,
            borderLeft: `3px solid ${palette.accent}`,
            color: palette.textSecondary,
          }}
        >
          {c}
        </blockquote>
      ),
      h1: ({ children: c }) => (
        <h1
          style={{
            margin: 0,
            fontSize: typography.fontSizeLarge + 4,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            lineHeight: typography.lineHeight,
          }}
        >
          {c}
        </h1>
      ),
      h2: ({ children: c }) => (
        <h2
          style={{
            margin: 0,
            fontSize: typography.fontSizeLarge + 2,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            lineHeight: typography.lineHeight,
          }}
        >
          {c}
        </h2>
      ),
      h3: ({ children: c }) => (
        <h3
          style={{
            margin: 0,
            fontSize: typography.fontSizeLarge,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            lineHeight: typography.lineHeight,
          }}
        >
          {c}
        </h3>
      ),
      hr: () => (
        <hr
          style={{
            margin: `${spacing.unit}px 0`,
            border: "none",
            borderTop: `1px solid ${palette.border}`,
          }}
        />
      ),
      table: ({ children: c }) => (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: typography.fontSizeSmall,
              color: palette.textPrimary,
            }}
          >
            {c}
          </table>
        </div>
      ),
      th: ({ children: c }) => (
        <th
          style={{
            border: `1px solid ${palette.border}`,
            padding: `${spacing.unit}px ${spacing.unit * 2}px`,
            textAlign: "left",
            backgroundColor: palette.bgSecondary,
            fontWeight: typography.fontWeightMedium,
          }}
        >
          {c}
        </th>
      ),
      td: ({ children: c }) => (
        <td
          style={{
            border: `1px solid ${palette.border}`,
            padding: `${spacing.unit}px ${spacing.unit * 2}px`,
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
          }}
        />
      ),
    }),
    [palette, typography, spacing],
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
        {children}
      </ReactMarkdown>
    </div>
  );
}

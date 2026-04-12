import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "../theme/ThemeContext";
import type { ResolvedColorScheme } from "../theme/types";

interface MediaViewerTextBodyProps {
  text: string;
  language: string;
  resolvedColorScheme: ResolvedColorScheme;
  zoom: number;
  fontSizePx: number;
  truncated: boolean;
}

export default function MediaViewerTextBody({
  text,
  language,
  resolvedColorScheme,
  zoom,
  fontSizePx,
  truncated,
}: MediaViewerTextBodyProps) {
  const { palette, typography } = useTheme();
  const prismStyle = resolvedColorScheme === "light" ? oneLight : oneDark;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {truncated ? (
        <div
          style={{
            flexShrink: 0,
            padding: "8px 12px",
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            backgroundColor: palette.bgTertiary,
            borderBottom: `1px solid ${palette.border}`,
          }}
        >
          Preview truncated — only the first portion of this file is shown. Download for the full
          file.
        </div>
      ) : null}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: 12,
        }}
      >
        <div
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            width: `${100 / zoom}%`,
          }}
        >
          <SyntaxHighlighter
            language={language}
            style={prismStyle}
            showLineNumbers
            wrapLongLines
            customStyle={{
              margin: 0,
              padding: "12px 8px",
              fontSize: fontSizePx,
              lineHeight: 1.5,
              borderRadius: 8,
              maxWidth: "100%",
            }}
            lineNumberStyle={{ minWidth: "2.75em", paddingRight: "1em", opacity: 0.55 }}
            codeTagProps={{
              style: {
                fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
              },
            }}
          >
            {text}
          </SyntaxHighlighter>
        </div>
      </div>
    </div>
  );
}

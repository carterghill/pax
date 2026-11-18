import type { CSSProperties } from "react";
import { useTheme } from "../theme/ThemeContext";

const singleLine: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export default function RoomHeaderTitle({ name, caption, style }: {
  name: string;
  caption?: string | null;
  style?: CSSProperties;
}) {
  const { palette, typography } = useTheme();
  const text = caption?.trim();

  return (
    <div style={{ flex: 1, minWidth: 0, lineHeight: 1.3, ...style }}>
      <div style={{
        ...singleLine,
        fontWeight: typography.fontWeightBold,
        color: palette.textHeading,
        fontSize: typography.fontSizeBase,
      }}>
        {name}
      </div>
      {text && (
        <div title={text} style={{
          ...singleLine,
          marginTop: 2,
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

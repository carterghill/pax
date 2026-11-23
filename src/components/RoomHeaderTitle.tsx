import type { CSSProperties, ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

const singleLine: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function RoomHeaderIcon({ children, encryptionLabel, announceEncryption, avatar = false }: {
  children: ReactNode;
  encryptionLabel?: string;
  announceEncryption: boolean;
  avatar?: boolean;
}) {
  const { palette } = useTheme();
  if (!encryptionLabel) return children;

  const badgeSize = avatar ? 16 : 14;
  return (
    <div style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      {children}
      <span
        role="img"
        aria-label={encryptionLabel}
        aria-hidden={!announceEncryption}
        title={encryptionLabel}
        style={{
          position: "absolute",
          right: avatar ? -1 : -4,
          bottom: avatar ? -1 : -3,
          width: badgeSize,
          height: badgeSize,
          boxSizing: "border-box",
          display: "grid",
          placeItems: "center",
          border: `1px solid ${palette.bgPrimary}`,
          borderRadius: "50%",
          background: palette.bgTertiary,
          color: palette.textPrimary,
        }}
      >
        <LockKeyhole size={badgeSize - 6} strokeWidth={2.5} aria-hidden="true" />
      </span>
    </div>
  );
}

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

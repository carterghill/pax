import { useTheme } from "../theme/ThemeContext";
import { ThemeToggle } from "../theme/ThemeToggle";

interface SettingsMenuProps {
  onSignOut: () => void;
}

export default function SettingsMenu({ onSignOut }: SettingsMenuProps) {
  const { palette, typography, spacing } = useTheme();

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: spacing.unit * 6,
        maxWidth: 480,
      }}
    >
      <h2
        style={{
          margin: 0,
          marginBottom: spacing.unit * 4,
          fontSize: typography.fontSizeLarge,
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
        }}
      >
        Settings
      </h2>

      <section
        style={{
          marginBottom: spacing.unit * 6,
          padding: spacing.unit * 4,
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          border: `1px solid ${palette.border}`,
        }}
      >
        <h3
          style={{
            margin: 0,
            marginBottom: spacing.unit * 3,
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textSecondary,
          }}
        >
          Appearance
        </h3>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 3,
          }}
        >
          <span
            style={{
              fontSize: typography.fontSizeBase,
              color: palette.textPrimary,
            }}
          >
            Theme
          </span>
          <ThemeToggle />
        </div>
      </section>

      <section
        style={{
          marginTop: "auto",
          padding: spacing.unit * 4,
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          border: `1px solid ${palette.border}`,
        }}
      >
        <h3
          style={{
            margin: 0,
            marginBottom: spacing.unit * 3,
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textSecondary,
          }}
        >
          Account
        </h3>
        <button
          onClick={onSignOut}
          style={{
            padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textPrimary,
            backgroundColor: palette.bgTertiary,
            border: `1px solid ${palette.border}`,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}

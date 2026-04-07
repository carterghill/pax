import { useTheme, useThemeControls } from "./ThemeContext";
import type { ThemeModePreference } from "./types";

const OPTIONS: { value: ThemeModePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
];

export function ColorModeControl() {
  const { palette, typography, spacing, mode } = useTheme();
  const { setMode } = useThemeControls();

  return (
    <div
      role="radiogroup"
      aria-label="Color mode"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: spacing.unit,
        justifyContent: "flex-end",
      }}
    >
      {OPTIONS.map(({ value, label }) => {
        const selected = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setMode(value)}
            style={{
              padding: `${spacing.unit * 1.25}px ${spacing.unit * 2.5}px`,
              borderRadius: 8,
              border: `1px solid ${selected ? palette.accent : palette.border}`,
              backgroundColor: selected ? palette.bgActive : palette.bgSecondary,
              color: selected ? palette.textHeading : palette.textSecondary,
              fontSize: typography.fontSizeSmall,
              fontWeight: selected ? typography.fontWeightMedium : typography.fontWeightNormal,
              fontFamily: typography.fontFamily,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

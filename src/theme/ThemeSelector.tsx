import { useTheme, useThemeControls } from "./ThemeContext";
import type { ThemeDefinition } from "./types";

function themeDisplayLabel(def: ThemeDefinition): string {
  if (def.id === "default") return "Default";
  return def.id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const CARD_PX = 104;
const PREVIEW_CIRCLE_PX = 48;

export function ThemeSelector() {
  const { palette, typography, spacing, themeId } = useTheme();
  const { setThemeId, availableThemeDefinitions } = useThemeControls();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: spacing.unit * 2,
      }}
    >
      {availableThemeDefinitions.map((def) => {
        const selected = themeId === def.id;
        const label = themeDisplayLabel(def);
        const splitPreview = `linear-gradient(90deg, ${def.dark.bgPrimary} 50%, ${def.light.bgPrimary} 50%)`;

        return (
          <button
            key={def.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`Theme: ${label}`}
            title={label}
            onClick={() => setThemeId(def.id)}
            style={{
              width: CARD_PX,
              height: CARD_PX,
              flexShrink: 0,
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: spacing.unit * 1.5,
              padding: spacing.unit * 2,
              borderRadius: 12,
              border: `2px solid ${selected ? palette.accent : palette.border}`,
              backgroundColor: selected ? palette.bgActive : palette.bgSecondary,
              cursor: "pointer",
              fontFamily: typography.fontFamily,
            }}
          >
            <div
              aria-hidden
              style={{
                width: PREVIEW_CIRCLE_PX,
                height: PREVIEW_CIRCLE_PX,
                borderRadius: "50%",
                background: splitPreview,
                border: `1px solid ${palette.border}`,
                boxSizing: "border-box",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                fontWeight: selected ? typography.fontWeightMedium : typography.fontWeightNormal,
                color: selected ? palette.textHeading : palette.textSecondary,
                textAlign: "center",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                lineHeight: 1.2,
              }}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

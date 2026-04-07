import { ThemeDefinition, ThemePalette, ThemeTypography, ThemeSpacing } from "./types";

const typography: ThemeTypography = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSizeBase: 14,
  fontSizeSmall: 12,
  fontSizeLarge: 16,
  fontWeightNormal: 400,
  fontWeightMedium: 500,
  fontWeightBold: 700,
  lineHeight: 1.5,
};

const spacing: ThemeSpacing = {
  unit: 4,
  sidebarWidth: 240,
  spaceSidebarWidth: 72,
  headerHeight: 54,
};

/** Push RGB toward black by a small step (dark mode surfaces). */
function darkenHex(hex: string, rgbDelta: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, ((n >> 16) & 255) - rgbDelta);
  const g = Math.max(0, ((n >> 8) & 255) - rgbDelta);
  const b = Math.max(0, (n & 255) - rgbDelta);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function withDarkerBackgrounds(palette: ThemePalette, rgbDelta: number): ThemePalette {
  return {
    ...palette,
    bgPrimary: darkenHex(palette.bgPrimary, rgbDelta),
    bgSecondary: darkenHex(palette.bgSecondary, rgbDelta),
    bgTertiary: darkenHex(palette.bgTertiary, rgbDelta),
    bgHover: darkenHex(palette.bgHover, rgbDelta),
    bgActive: darkenHex(palette.bgActive, rgbDelta),
  };
}

/** Discord-style surfaces (also used as the base before darkening for Default). */
const discordDarkPalette: ThemePalette = {
  bgPrimary: "#313338",
  bgSecondary: "#2b2d31",
  bgTertiary: "#1e1f22",
  bgHover: "#35373c",
  bgActive: "#404249",
  textPrimary: "#dbdee1",
  textSecondary: "#949ba4",
  textHeading: "#f2f3f5",
  accent: "#5865f2",
  accentHover: "#4752c4",
  border: "#1f2023",
};

const discordLightPalette: ThemePalette = {
  bgPrimary: "#ffffff",
  bgSecondary: "#f2f3f5",
  bgTertiary: "#e3e5e8",
  bgHover: "#eaebed",
  bgActive: "#d5d7db",
  textPrimary: "#313338",
  textSecondary: "#5c5e66",
  textHeading: "#060607",
  accent: "#5865f2",
  accentHover: "#4752c4",
  border: "#d9dce1",
};

/** Default: light unchanged from prior tuning; dark surfaces darker than Discord. */
const DEFAULT_DARK_BG_DELTA = 14;
/** Darken border vs Discord so 1px rules stay visible on darkened backgrounds (e.g. room sidebar). */
const DEFAULT_DARK_BORDER_DELTA = 14;

export const defaultThemeDefinition: ThemeDefinition = {
  id: "default",
  dark: {
    ...withDarkerBackgrounds(discordDarkPalette, DEFAULT_DARK_BG_DELTA),
    border: darkenHex(discordDarkPalette.border, DEFAULT_DARK_BORDER_DELTA),
  },
  light: withDarkerBackgrounds(discordLightPalette, 5),
  typography,
  spacing,
};

export const discordThemeDefinition: ThemeDefinition = {
  id: "discord",
  dark: { ...discordDarkPalette },
  light: { ...discordLightPalette },
  typography,
  spacing,
};

export const BUILTIN_THEME_DEFINITIONS: Record<string, ThemeDefinition> = {
  default: defaultThemeDefinition,
  discord: discordThemeDefinition,
};

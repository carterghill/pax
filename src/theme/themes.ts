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

/* ─── Element (Matrix green) ─────────────────────────────────────────────── */

const elementDarkPalette: ThemePalette = {
  bgPrimary: "#1a1f27",
  bgSecondary: "#15191e",
  bgTertiary: "#111519",
  bgHover: "#1e2530",
  bgActive: "#253040",
  textPrimary: "#e3e8f0",
  textSecondary: "#8d99a8",
  textHeading: "#f4f7fa",
  accent: "#0dbd8b",
  accentHover: "#0a9a72",
  border: "#212832",
};

const elementLightPalette: ThemePalette = {
  bgPrimary: "#ffffff",
  bgSecondary: "#f3f8f6",
  bgTertiary: "#e8f0ec",
  bgHover: "#eaf5f0",
  bgActive: "#d0e8de",
  textPrimary: "#17191c",
  textSecondary: "#5e6775",
  textHeading: "#0b0d0f",
  accent: "#0dbd8b",
  accentHover: "#0a9a72",
  border: "#c8d5ce",
};

export const elementThemeDefinition: ThemeDefinition = {
  id: "element",
  dark: { ...elementDarkPalette },
  light: { ...elementLightPalette },
  typography,
  spacing,
};

/* ─── Notepad (legal pad yellow) ─────────────────────────────────────────── */

const notepadDarkPalette: ThemePalette = {
  bgPrimary: "#2a2520",
  bgSecondary: "#24201b",
  bgTertiary: "#1c1915",
  bgHover: "#332e27",
  bgActive: "#3d3730",
  textPrimary: "#e8dfc8",
  textSecondary: "#a69a80",
  textHeading: "#f5ecd4",
  accent: "#d4a843",
  accentHover: "#b8922e",
  border: "#3a342b",
};

const notepadLightPalette: ThemePalette = {
  bgPrimary: "#fff9e0",
  bgSecondary: "#fff4c8",
  bgTertiary: "#ffeeb0",
  bgHover: "#fff1c0",
  bgActive: "#ffe89c",
  textPrimary: "#3b3326",
  textSecondary: "#7a6b50",
  textHeading: "#2a2318",
  accent: "#c4922a",
  accentHover: "#a87b1e",
  border: "#e0d09a",
};

export const notepadThemeDefinition: ThemeDefinition = {
  id: "notepad",
  dark: { ...notepadDarkPalette },
  light: { ...notepadLightPalette },
  typography,
  spacing,
};

/* ─── Solarized (Ethan Schoonover's palette) ─────────────────────────────── */

const solarizedDarkPalette: ThemePalette = {
  bgPrimary: "#073642",   // base02 — main area
  bgSecondary: "#002b36", // base03 — room sidebar / user menu (darker than primary)
  bgTertiary: "#002028",  // slightly darker than base03
  bgHover: "#0a3f4e",
  bgActive: "#0e4d5e",
  textPrimary: "#839496", // base0
  textSecondary: "#586e75", // base01
  textHeading: "#93a1a1", // base1
  accent: "#268bd2",      // blue
  accentHover: "#1e75b3",
  border: "#094452",
};

const solarizedLightPalette: ThemePalette = {
  bgPrimary: "#fdf6e3",   // base3
  bgSecondary: "#eee8d5", // base2
  bgTertiary: "#e6dfcc",
  bgHover: "#f0e9d4",
  bgActive: "#ddd6c1",
  textPrimary: "#657b83", // base00
  textSecondary: "#93a1a1", // base1
  textHeading: "#586e75", // base01
  accent: "#268bd2",      // blue
  accentHover: "#1e75b3",
  border: "#d3cab7",
};

export const solarizedThemeDefinition: ThemeDefinition = {
  id: "solarized",
  dark: { ...solarizedDarkPalette },
  light: { ...solarizedLightPalette },
  typography,
  spacing,
};

/* ─── Byzantine (muted Tyrian / imperial purple accent) ───────────────────── */

/** Restrained accent: historical Byzantine purple range, desaturated so it stays UI-appropriate. */
const BYZANTINE_ACCENT = "#6e4a6e";
const BYZANTINE_ACCENT_HOVER = "#5c3d5c";

const byzantineDarkPalette: ThemePalette = {
  bgPrimary: "#2a262e",
  bgSecondary: "#221f26",
  bgTertiary: "#1a171d",
  bgHover: "#322e38",
  bgActive: "#3d3845",
  textPrimary: "#e8e4ec",
  textSecondary: "#9d96a6",
  textHeading: "#f4f1f7",
  accent: BYZANTINE_ACCENT,
  accentHover: BYZANTINE_ACCENT_HOVER,
  border: "#2e2933",
};

const byzantineLightPalette: ThemePalette = {
  bgPrimary: "#faf9fb",
  bgSecondary: "#f2eef5",
  bgTertiary: "#eae4f0",
  bgHover: "#f0ecf6",
  bgActive: "#ddd2e6",
  textPrimary: "#2a242c",
  textSecondary: "#5f5668",
  textHeading: "#1a151c",
  accent: BYZANTINE_ACCENT,
  accentHover: BYZANTINE_ACCENT_HOVER,
  border: "#d8cfe0",
};

export const byzantineThemeDefinition: ThemeDefinition = {
  id: "byzantine",
  dark: { ...byzantineDarkPalette },
  light: { ...byzantineLightPalette },
  typography,
  spacing,
};

/* ─── Roman (muted imperial / terracotta red accent) ──────────────────────── */

/** Restrained accent: old Roman imperial red range (cinnabar / vermillion), desaturated for UI. */
const ROMAN_ACCENT = "#c03d3d";
const ROMAN_ACCENT_HOVER = "#9e3030";

const romanDarkPalette: ThemePalette = {
  bgPrimary: "#2a2422",
  bgSecondary: "#221e1c",
  bgTertiary: "#1a1715",
  bgHover: "#322c29",
  bgActive: "#3d3632",
  textPrimary: "#ebe6e3",
  textSecondary: "#a89892",
  textHeading: "#f5f0ed",
  accent: ROMAN_ACCENT,
  accentHover: ROMAN_ACCENT_HOVER,
  border: "#332e2b",
};

const romanLightPalette: ThemePalette = {
  bgPrimary: "#faf8f7",
  bgSecondary: "#f3eeeb",
  bgTertiary: "#eae3df",
  bgHover: "#f0e9e5",
  bgActive: "#e2d2cc",
  textPrimary: "#2c2420",
  textSecondary: "#665550",
  textHeading: "#1a1412",
  accent: ROMAN_ACCENT,
  accentHover: ROMAN_ACCENT_HOVER,
  border: "#ddd2cc",
};

export const romanThemeDefinition: ThemeDefinition = {
  id: "roman",
  dark: { ...romanDarkPalette },
  light: { ...romanLightPalette },
  typography,
  spacing,
};

/* ─── Registry ───────────────────────────────────────────────────────────── */

export const BUILTIN_THEME_DEFINITIONS: Record<string, ThemeDefinition> = {
  default: defaultThemeDefinition,
  discord: discordThemeDefinition,
  element: elementThemeDefinition,
  notepad: notepadThemeDefinition,
  solarized: solarizedThemeDefinition,
  byzantine: byzantineThemeDefinition,
  roman: romanThemeDefinition,
};
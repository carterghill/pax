import { Theme, ThemeTypography, ThemeSpacing } from "./types";

// Shared across all themes
const typography: ThemeTypography = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSizeBase: 14,
  fontSizeSmall: 12,
  fontSizeLarge: 16,
  fontWeightNormal: 400,
  fontWeightMedium: 500,
  fontWeightBold: 600,
  lineHeight: 1.5,
};

const spacing: ThemeSpacing = {
  unit: 4,
  sidebarWidth: 240,
  spaceSidebarWidth: 72,
};

export const darkTheme: Theme = {
  name: "dark",
  palette: {
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
  },
  typography,
  spacing,
};

export const lightTheme: Theme = {
  name: "light",
  palette: {
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
  },
  typography,
  spacing,
};
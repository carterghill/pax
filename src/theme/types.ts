export interface ThemePalette {
  // Backgrounds
  bgPrimary: string;      // main content area
  bgSecondary: string;    // room sidebar
  bgTertiary: string;     // space sidebar
  bgHover: string;        // hovered items
  bgActive: string;       // selected items

  // Text
  textPrimary: string;    // main text
  textSecondary: string;  // muted text
  textHeading: string;    // headings

  // Accent
  accent: string;         // brand color, buttons
  accentHover: string;

  // Borders
  border: string;
  /** Optional outer frame for the message composer and modal shells (e.g. subtle trim). */
  borderSecondary?: string;
}

export interface ThemeTypography {
  fontFamily: string;
  fontSizeBase: number;     // in px, everything scales from this
  fontSizeSmall: number;
  fontSizeLarge: number;
  fontWeightNormal: number;
  fontWeightMedium: number;
  fontWeightBold: number;
  lineHeight: number;
}

export interface ThemeSpacing {
  unit: number;  // base unit in px, e.g. 4
  sidebarWidth: number;
  spaceSidebarWidth: number;
  /** Default width for the channel member list / user menu column. */
  userMenuWidth: number;
  headerHeight: number;
}

/** User preference: which color scheme to use (system follows OS). */
export type ThemeModePreference = "light" | "dark" | "system";

/** Resolved appearance after applying mode (system → light or dark). */
export type ResolvedColorScheme = "light" | "dark";

/**
 * One theme: shared typography/spacing plus separate palettes for light and dark.
 * The active palette is chosen by {@link ThemeModePreference} / system setting.
 */
export interface ThemeDefinition {
  id: string;
  light: ThemePalette;
  dark: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
}

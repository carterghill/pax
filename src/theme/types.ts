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
}

export interface Theme {
  name: string;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
}
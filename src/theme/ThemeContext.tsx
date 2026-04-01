import { createContext, useContext, useState, useMemo, useCallback, ReactNode } from "react";
import { Theme, ThemePalette, ThemeTypography, ThemeSpacing } from "./types";
import { darkTheme, lightTheme } from "./themes";

/* ------------------------------------------------------------------ */
/*  Context split: theme values vs. control actions                    */
/*                                                                     */
/*  Separating these into two contexts means components that only      */
/*  *read* theme colors (the vast majority) never re-render when       */
/*  control-related state changes, and vice versa.                     */
/* ------------------------------------------------------------------ */

interface ThemeValueContext {
  name: string;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
}

interface ThemeControlContext {
  setThemeName: (name: string) => void;
  addCustomTheme: (theme: Theme) => void;
  availableThemes: string[];
}

const ThemeValCtx = createContext<ThemeValueContext | null>(null);
const ThemeCtrlCtx = createContext<ThemeControlContext | null>(null);

const BUILTIN: Record<string, Theme> = { dark: darkTheme, light: lightTheme };

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [activeThemeName, setActiveThemeName] = useState("dark");

  const theme = useMemo(() => {
    const custom = customThemes.find((t) => t.name === activeThemeName);
    return custom ?? BUILTIN[activeThemeName] ?? darkTheme;
  }, [activeThemeName, customThemes]);

  // Referentially stable value — only changes when the resolved theme changes.
  const themeValue = useMemo<ThemeValueContext>(
    () => ({
      name: theme.name,
      palette: theme.palette,
      typography: theme.typography,
      spacing: theme.spacing,
    }),
    [theme],
  );

  const addCustomTheme = useCallback((newTheme: Theme) => {
    setCustomThemes((prev) => [...prev.filter((t) => t.name !== newTheme.name), newTheme]);
  }, []);

  const availableThemes = useMemo(
    () => [...Object.keys(BUILTIN), ...customThemes.map((t) => t.name)],
    [customThemes],
  );

  const controlValue = useMemo<ThemeControlContext>(
    () => ({ setThemeName: setActiveThemeName, addCustomTheme, availableThemes }),
    [addCustomTheme, availableThemes],
  );

  return (
    <ThemeCtrlCtx.Provider value={controlValue}>
      <ThemeValCtx.Provider value={themeValue}>
        {children}
      </ThemeValCtx.Provider>
    </ThemeCtrlCtx.Provider>
  );
}

/**
 * Read theme values (palette, typography, spacing, name).
 * Referentially stable — only triggers a re-render when the active theme changes.
 */
export function useTheme(): ThemeValueContext {
  const ctx = useContext(ThemeValCtx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/**
 * Access theme controls (switch theme, add custom themes).
 * Separated so that the vast majority of components that only read
 * colors/spacing never re-render when control-related state changes.
 */
export function useThemeControls(): ThemeControlContext {
  const ctx = useContext(ThemeCtrlCtx);
  if (!ctx) throw new Error("useThemeControls must be used within ThemeProvider");
  return ctx;
}
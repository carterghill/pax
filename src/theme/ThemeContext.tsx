import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useSyncExternalStore,
  ReactNode,
} from "react";
import {
  ThemePalette,
  ThemeTypography,
  ThemeSpacing,
  ThemeModePreference,
  ResolvedColorScheme,
  ThemeDefinition,
} from "./types";
import { BUILTIN_THEME_DEFINITIONS, defaultThemeDefinition } from "./themes";

const STORAGE_MODE = "pax.appearance.mode";
const STORAGE_THEME_ID = "pax.appearance.themeId";

function readStoredMode(): ThemeModePreference {
  try {
    const v = localStorage.getItem(STORAGE_MODE);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

function readStoredThemeId(): string {
  try {
    const v = localStorage.getItem(STORAGE_THEME_ID)?.trim();
    if (v) return v;
  } catch {
    /* ignore */
  }
  return defaultThemeDefinition.id;
}

function subscribeSystemDark(callback: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getSystemDarkSnapshot(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getSystemDarkServerSnapshot(): boolean {
  return false;
}

/* ------------------------------------------------------------------ */
/*  Context split: theme values vs. control actions                    */
/* ------------------------------------------------------------------ */

interface ThemeValueContext {
  /** Selected visual theme (color sets); today only "default". */
  themeId: string;
  /** User preference: light, dark, or follow system. */
  mode: ThemeModePreference;
  /** Effective light/dark after resolving system preference. */
  resolvedColorScheme: ResolvedColorScheme;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
}

interface ThemeControlContext {
  setMode: (mode: ThemeModePreference) => void;
  setThemeId: (id: string) => void;
  addCustomTheme: (theme: ThemeDefinition) => void;
  availableThemeIds: string[];
}

const ThemeValCtx = createContext<ThemeValueContext | null>(null);
const ThemeCtrlCtx = createContext<ThemeControlContext | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>([]);
  const [mode, setModeState] = useState<ThemeModePreference>(readStoredMode);
  const [themeId, setThemeIdState] = useState<string>(readStoredThemeId);

  const systemPrefersDark = useSyncExternalStore(
    subscribeSystemDark,
    getSystemDarkSnapshot,
    getSystemDarkServerSnapshot,
  );

  const resolvedColorScheme: ResolvedColorScheme = useMemo(() => {
    if (mode === "light") return "light";
    if (mode === "dark") return "dark";
    return systemPrefersDark ? "dark" : "light";
  }, [mode, systemPrefersDark]);

  const definition = useMemo(() => {
    const custom = customThemes.find((t) => t.id === themeId);
    return custom ?? BUILTIN_THEME_DEFINITIONS[themeId] ?? defaultThemeDefinition;
  }, [themeId, customThemes]);

  const palette =
    resolvedColorScheme === "light" ? definition.light : definition.dark;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_MODE, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_THEME_ID, themeId);
    } catch {
      /* ignore */
    }
  }, [themeId]);

  const setMode = useCallback((next: ThemeModePreference) => {
    setModeState(next);
  }, []);

  const setThemeId = useCallback((id: string) => {
    setThemeIdState(id);
  }, []);

  const addCustomTheme = useCallback((newTheme: ThemeDefinition) => {
    setCustomThemes((prev) => [...prev.filter((t) => t.id !== newTheme.id), newTheme]);
  }, []);

  const availableThemeIds = useMemo(() => {
    const fromBuiltin = Object.keys(BUILTIN_THEME_DEFINITIONS);
    const fromCustom = customThemes.map((t) => t.id);
    const merged = [...fromBuiltin, ...fromCustom];
    return merged.filter((id, i) => merged.indexOf(id) === i);
  }, [customThemes]);

  const themeValue = useMemo<ThemeValueContext>(
    () => ({
      themeId,
      mode,
      resolvedColorScheme,
      palette,
      typography: definition.typography,
      spacing: definition.spacing,
    }),
    [themeId, mode, resolvedColorScheme, palette, definition.typography, definition.spacing],
  );

  const controlValue = useMemo<ThemeControlContext>(
    () => ({ setMode, setThemeId, addCustomTheme, availableThemeIds }),
    [setMode, setThemeId, addCustomTheme, availableThemeIds],
  );

  return (
    <ThemeCtrlCtx.Provider value={controlValue}>
      <ThemeValCtx.Provider value={themeValue}>{children}</ThemeValCtx.Provider>
    </ThemeCtrlCtx.Provider>
  );
}

export function useTheme(): ThemeValueContext {
  const ctx = useContext(ThemeValCtx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function useThemeControls(): ThemeControlContext {
  const ctx = useContext(ThemeCtrlCtx);
  if (!ctx) throw new Error("useThemeControls must be used within ThemeProvider");
  return ctx;
}

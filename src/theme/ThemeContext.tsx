import { createContext, useContext, useState, ReactNode } from "react";
import { Theme } from "./types";
import { darkTheme, lightTheme } from "./themes";

interface ThemeContextValue {
  theme: Theme;
  setThemeName: (name: string) => void;
  addCustomTheme: (theme: Theme) => void;
  availableThemes: string[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [activeThemeName, setActiveThemeName] = useState("dark");

  const allThemes: Record<string, Theme> = {
    dark: darkTheme,
    light: lightTheme,
    ...Object.fromEntries(customThemes.map((t) => [t.name, t])),
  };

  const theme = allThemes[activeThemeName] ?? darkTheme;

  function addCustomTheme(newTheme: Theme) {
    setCustomThemes((prev) => [...prev.filter((t) => t.name !== newTheme.name), newTheme]);
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setThemeName: setActiveThemeName,
        addCustomTheme,
        availableThemes: Object.keys(allThemes),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx.theme;
}

export function useThemeControls() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemeControls must be used within ThemeProvider");
  return {
    setThemeName: ctx.setThemeName,
    addCustomTheme: ctx.addCustomTheme,
    availableThemes: ctx.availableThemes,
  };
}
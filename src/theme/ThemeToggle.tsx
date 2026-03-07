import { useThemeControls, useTheme } from "../theme/ThemeContext";

export function ThemeToggle() {
  const { name, palette, typography, spacing } = useTheme();
  const { setThemeName } = useThemeControls();

  return (
    <button 
      style={{
        backgroundColor: palette.bgPrimary,
        borderColor: palette.bgSecondary,
        fontSize: typography.fontSizeLarge*2,
        padding: spacing.unit * 0.5,
      }} 
      onClick={() => setThemeName(name === "dark" ? "light" : "dark")}
    >
      {name === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
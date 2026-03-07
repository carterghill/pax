import { useTheme } from "../theme/ThemeContext";
import { ThemeToggle } from "../theme/ThemeToggle";

export default function SettingsMenu() {
const { typography } = useTheme();

  return (
    <div 
      style={{ 
        display: "flex",
        fontSize: typography.fontSizeLarge,
        fontWeight: typography.fontWeightMedium,
      }}
    >
      Settings
      <ThemeToggle />
    </div>
  );
}
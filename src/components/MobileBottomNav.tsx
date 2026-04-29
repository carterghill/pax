import { LayoutGrid, MessageSquare } from "lucide-react";
import type { ThemePalette, ThemeSpacing } from "../theme/types";

/** Row height excluding safe-area; main content uses `calc(row + env(safe-area))`. */
const NAV_ROW_PX = 56;

export function mobileBottomNavContentInsetCss(): string {
  return `calc(${NAV_ROW_PX}px + env(safe-area-inset-bottom, 0px))`;
}

interface MobileBottomNavProps {
  palette: ThemePalette;
  spacing: ThemeSpacing;
  onOpenSpaces: () => void;
  onOpenRooms: () => void;
}

export default function MobileBottomNav({
  palette,
  spacing,
  onOpenSpaces,
  onOpenRooms,
}: MobileBottomNavProps) {
  const btn = {
    flex: 1,
    display: "flex" as const,
    flexDirection: "column" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 4,
    padding: `${spacing.unit}px ${spacing.unit * 2}px`,
    border: "none",
    background: "none",
    cursor: "pointer",
    color: palette.textSecondary,
    fontSize: 11,
    fontWeight: 500,
  };

  return (
    <nav
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        minHeight: NAV_ROW_PX,
        display: "flex",
        alignItems: "stretch",
        borderTop: `1px solid ${palette.border}`,
        backgroundColor: palette.bgSecondary,
        zIndex: 9000,
        boxSizing: "border-box",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <button type="button" onClick={onOpenSpaces} style={btn} title="Spaces">
        <LayoutGrid size={22} strokeWidth={2} />
        <span>Spaces</span>
      </button>
      <button type="button" onClick={onOpenRooms} style={btn} title="Rooms">
        <MessageSquare size={22} strokeWidth={2} />
        <span>Rooms</span>
      </button>
    </nav>
  );
}

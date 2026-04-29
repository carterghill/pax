import { useEffect, useState } from "react";
import { useTheme } from "../theme/ThemeContext";

/** Width breakpoint: default space rail + room sidebar + user menu (narrow window = mobile chrome). */
export function mobileLayoutBreakpointPx(spacing: {
  spaceSidebarWidth: number;
  sidebarWidth: number;
  userMenuWidth: number;
}): number {
  return spacing.spaceSidebarWidth + spacing.sidebarWidth + spacing.userMenuWidth;
}

/**
 * True when the viewport is narrower than the sum of default sidebar widths
 * (space rail, room list, member list), so multi-column chrome is replaced
 * by drawers + bottom navigation.
 */
export function useIsMobile(): boolean {
  const { spacing } = useTheme();
  const breakpoint = mobileLayoutBreakpointPx(spacing);
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : breakpoint + 1
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return width < breakpoint;
}

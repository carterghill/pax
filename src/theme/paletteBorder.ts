import type { CSSProperties } from "react";
import type { ThemePalette } from "./types";

/** Modal / dialog panel outline: uses `borderSecondary` when the theme defines it. */
export function paletteDialogOuterBorderStyle(palette: ThemePalette): string {
  return `1px solid ${palette.borderSecondary ?? palette.border}`;
}

/** Message composer shell: border only when the theme defines `borderSecondary`. */
export function paletteComposerOuterBorderStyle(palette: ThemePalette): string | undefined {
  return palette.borderSecondary ? `1px solid ${palette.borderSecondary}` : undefined;
}

/** Modal shell: add an outer border only when `borderSecondary` is set (for panels that default to borderless). */
export function paletteDialogShellBorderStyle(palette: ThemePalette): CSSProperties {
  return palette.borderSecondary ? { border: `1px solid ${palette.borderSecondary}` } : {};
}

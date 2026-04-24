import type { CSSProperties } from "react";

/**
 * Matrix `info.w` / `info.h` describe the full media; the bubble uses max-width 100%
 * and max-height. Mirror that so loading placeholders match the final layout (CLS).
 */
export function inlineMediaAspectBoxStyle(
  naturalWidth: number,
  naturalHeight: number,
  maxHeightPx: number,
): Pick<CSSProperties, "width" | "maxWidth" | "aspectRatio" | "maxHeight"> | null {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return null;
  }
  const maxWidthPx = (naturalWidth / naturalHeight) * maxHeightPx;
  return {
    width: "100%",
    maxWidth: maxWidthPx,
    aspectRatio: `${naturalWidth} / ${naturalHeight}`,
    maxHeight: maxHeightPx,
  };
}

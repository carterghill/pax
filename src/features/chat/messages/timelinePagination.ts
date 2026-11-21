interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Pagination zones must stay separate even when compact notices fill the room. */
export function timelinePaginationEdge(
  { scrollTop, scrollHeight, clientHeight }: ScrollGeometry,
): "older" | "newer" | null {
  const range = Math.max(0, scrollHeight - clientHeight);
  // A short timeline has no scroll direction. Its history button remains usable.
  if (range <= 1) return null;
  const threshold = Math.min(400, range / 2);
  const top = Math.max(0, Math.min(scrollTop, range));
  if (top < threshold) return "older";
  if (range - top < threshold) return "newer";
  return null;
}

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  getMessageActionBarLeftEdge,
  getMessageActionGroupRect,
  clampFixedPopoverToViewport,
} from "./messageListUtils";

export type PopoverFixedPos = {
  right: number;
  top: number | null;
  bottom: number | null;
};

const VIEWPORT_EPS_PX = 1;

export function useActionBarPopover({
  scrollContainerRef,
  spacingUnit,
  ignoreSelectors = [],
}: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  spacingUnit: number;
  ignoreSelectors?: string[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [fixedPos, setFixedPos] = useState<PopoverFixedPos | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  const ignoreSelectorsRef = useRef(ignoreSelectors);
  ignoreSelectorsRef.current = ignoreSelectors;

  useLayoutEffect(() => {
    if (!openId) {
      setFixedPos(null);
      return;
    }
    const placeFromAnchor = () => {
      const btn = anchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const gap = spacingUnit;
      const edgeGap = spacingUnit;
      const g = getMessageActionGroupRect(btn);
      const vh = window.innerHeight;
      const openAbove = g
        ? g.top + g.height / 2 > vh / 2
        : r.top + r.height / 2 > vh / 2;
      const alignLeft = getMessageActionBarLeftEdge(btn);
      const right =
        alignLeft != null
          ? window.innerWidth - alignLeft + edgeGap
          : window.innerWidth - r.right + edgeGap;
      const topWhenBelow = g ? g.top : r.bottom + gap;
      const bottomWhenAbove = g ? vh - g.bottom : vh - r.top + gap;
      setFixedPos({
        right,
        top: openAbove ? null : topWhenBelow,
        bottom: openAbove ? bottomWhenAbove : null,
      });
    };
    placeFromAnchor();

    const ro = new ResizeObserver(placeFromAnchor);
    const bar = anchorRef.current?.closest(".pax-message-actions") ?? null;
    if (bar) ro.observe(bar);
    else if (anchorRef.current) ro.observe(anchorRef.current);
    window.addEventListener("resize", placeFromAnchor);
    window.addEventListener("scroll", placeFromAnchor, true);
    const cont = scrollContainerRef.current;
    cont?.addEventListener("scroll", placeFromAnchor, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", placeFromAnchor);
      window.removeEventListener("scroll", placeFromAnchor, true);
      cont?.removeEventListener("scroll", placeFromAnchor);
    };
  }, [openId, spacingUnit, scrollContainerRef]);

  useLayoutEffect(() => {
    if (!openId || !fixedPos) return;
    const el = portalRef.current;
    if (!el) return;
    const margin = Math.max(8, spacingUnit * 2);

    const applyClamp = () => {
      const { top, right } = clampFixedPopoverToViewport(
        el.getBoundingClientRect(),
        margin,
      );
      setFixedPos((prev) => {
        if (!prev) return prev;
        if (
          prev.bottom == null &&
          prev.top != null &&
          Math.abs(prev.top - top) < VIEWPORT_EPS_PX &&
          Math.abs(prev.right - right) < VIEWPORT_EPS_PX
        ) {
          return prev;
        }
        return { top, right, bottom: null };
      });
    };

    applyClamp();
    const ro = new ResizeObserver(applyClamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [openId, fixedPos, spacingUnit]);

  useEffect(() => {
    if (!openId) return;
    const onDocDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-message-actions-root]")) return;
      for (const sel of ignoreSelectorsRef.current) {
        if (el.closest?.(sel)) return;
      }
      setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  return { openId, setOpenId, fixedPos, anchorRef, portalRef };
}

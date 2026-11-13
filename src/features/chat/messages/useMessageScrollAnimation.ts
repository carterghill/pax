import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

const SCROLL_DURATION_MS = 220;

/** Share one animation between message arrivals and media/layout resizes. */
export function useMessageScrollAnimation(
  containerRef: RefObject<HTMLDivElement | null>,
) {
  const animationRef = useRef<{
    frame: number;
    target: number;
  } | null>(null);

  const cancelScrollAnimation = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current.frame);
      animationRef.current = null;
    }
  }, []);

  const scrollToBottom = useCallback((animate: boolean) => {
    const container = containerRef.current;
    if (!container) return;

    const target = Math.max(0, container.scrollHeight - container.clientHeight);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reducedMotion) {
      cancelScrollAnimation();
      container.scrollTop = target;
      return;
    }

    // ResizeObserver often reports the same layout just after a message arrives.
    // Let the in-flight animation continue instead of restarting or snapping it.
    if (animationRef.current?.target === target) return;
    cancelScrollAnimation();

    const start = container.scrollTop;
    if (Math.abs(target - start) < 1) {
      container.scrollTop = target;
      return;
    }

    const startedAt = performance.now();
    const animation = { frame: 0, target };
    animationRef.current = animation;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / SCROLL_DURATION_MS);
      const eased = 1 - (1 - progress) ** 3;
      container.scrollTop = start + (target - start) * eased;
      if (progress < 1) {
        animation.frame = requestAnimationFrame(step);
      } else {
        animationRef.current = null;
      }
    };
    animation.frame = requestAnimationFrame(step);
  }, [containerRef, cancelScrollAnimation]);

  useLayoutEffect(() => cancelScrollAnimation, [cancelScrollAnimation]);

  return { scrollToBottom, cancelScrollAnimation, scrollAnimationRef: animationRef };
}

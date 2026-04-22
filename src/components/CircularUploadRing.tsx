import type { CSSProperties } from "react";
import { useTheme } from "../theme/ThemeContext";

export default function CircularUploadRing({
  progress,
  size = 40,
  strokeWidth = 3,
  style,
}: {
  /** 0–1 */
  progress: number;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  const { palette } = useTheme();
  const track = palette.border;
  const fill = palette.textPrimary;
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, Math.max(0, progress));
  const dashOffset = c * (1 - p);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", ...style }}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={track}
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={fill}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${c} ${c}`}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

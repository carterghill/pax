import { Phone, Video } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

interface DmCallButtonsProps {
  onStartCall?: (video: boolean) => void;
  unavailable?: string;
  group?: boolean;
}

export default function DmCallButtons({ onStartCall, unavailable, group }: DmCallButtonsProps) {
  const { palette, spacing } = useTheme();
  const disabled = !onStartCall || !!unavailable;
  const actions = [
    { Icon: Phone, label: group ? "Call group" : "Start voice call", video: false },
    { Icon: Video, label: "Start video call", video: true },
  ];
  return <>{actions.map(({ Icon, label, video }) => (
    <button key={label} type="button" disabled={disabled} aria-label={label} title={unavailable ?? label}
      onClick={() => onStartCall?.(video)} style={{
        background: "none", border: "none", color: palette.textSecondary, padding: spacing.unit,
        borderRadius: spacing.unit, display: "flex", alignItems: "center", justifyContent: "center",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1,
      }}>
      <Icon size={20} aria-hidden="true" />
    </button>
  ))}</>;
}

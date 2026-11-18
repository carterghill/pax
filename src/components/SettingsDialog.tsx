import { X } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogOuterBorderStyle } from "../theme/paletteBorder";
import Dialog from "./Dialog";
import type { VoiceCall } from "../hooks/useVoiceCall";
import SettingsMenu from "./SettingsMenu";

interface SettingsDialogProps {
  onClose: () => void;
  onSignOut: () => void;
  userId: string;
  userAvatarUrl: string | null;
  onAvatarChanged: (newUrl: string | null) => void;
  voiceCall: VoiceCall;
}

export default function SettingsDialog({
  onClose,
  onSignOut,
  userId,
  userAvatarUrl,
  onAvatarChanged,
  voiceCall,
}: SettingsDialogProps) {
  const { palette } = useTheme();

  return (
    <Dialog
      onClose={onClose}
      aria-label="Settings"
      style={{
        position: "relative",
        width: "min(980px, calc(100vw - 48px))",
        maxHeight: "min(88vh, 860px)",
        display: "flex",
        justifyContent: "center",
        overflow: "hidden",
        backgroundColor: palette.bgSecondary,
        border: paletteDialogOuterBorderStyle(palette),
        borderRadius: 16,
        boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
      }}
    >
        <button
          onClick={onClose}
          title="Close settings"
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 1,
            width: 32,
            height: 32,
            border: `1px solid ${palette.border}`,
            borderRadius: 999,
            backgroundColor: palette.bgPrimary,
            color: palette.textSecondary,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <X size={18} />
        </button>
        <SettingsMenu
          onSignOut={onSignOut}
          userId={userId}
          userAvatarUrl={userAvatarUrl}
          onAvatarChanged={onAvatarChanged}
          voiceCall={voiceCall}
        />
    </Dialog>
  );
}

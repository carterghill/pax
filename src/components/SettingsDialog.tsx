import { useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";
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
  const dialogRef = useRef<HTMLDivElement>(null);

  useOverlayObstruction(dialogRef);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <ModalLayer
      onBackdropClick={handleBackdropClick}
      backdropStyle={{
        backgroundColor: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        ref={dialogRef}
        style={{
          position: "relative",
          width: "min(980px, calc(100vw - 48px))",
          maxHeight: "min(88vh, 860px)",
          display: "flex",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: palette.bgSecondary,
          border: `1px solid ${palette.border}`,
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
      </div>
    </ModalLayer>
  );
}

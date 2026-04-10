import { useTheme } from "../theme/ThemeContext";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import { dmInitialsFromLabel } from "../utils/dmDisplay";

type DmPeerAvatarProps = {
  peerUserId: string;
  displayName: string;
  avatarUrl: string | null;
  size: number;
  fontSize?: number;
};

/**
 * Peer circle for DMs: image when available, otherwise colored initials (same idea everywhere).
 */
export default function DmPeerAvatar({
  peerUserId,
  displayName,
  avatarUrl,
  size,
  fontSize,
}: DmPeerAvatarProps) {
  const { palette, typography, resolvedColorScheme } = useTheme();
  const label = displayName.trim() || peerUserId;
  const fs = fontSize ?? typography.fontSizeSmall;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: userInitialAvatarBackground(peerUserId, resolvedColorScheme),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: fs,
        fontWeight: typography.fontWeightBold,
        color: palette.textPrimary,
        overflow: "hidden",
      }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        dmInitialsFromLabel(label)
      )}
    </div>
  );
}

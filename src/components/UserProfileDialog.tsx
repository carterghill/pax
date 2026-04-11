import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Copy, Shield, Crown, User, Calendar, Hash } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";
import { usePresenceContext } from "../hooks/PresenceContext";
import type { RoomMemberProfile } from "../types/matrix";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";

const ROLE_META: Record<
  RoomMemberProfile["role"],
  { label: string; short: string; Icon: typeof User }
> = {
  creator: { label: "Room creator", short: "Creator", Icon: Crown },
  administrator: { label: "Administrator", short: "Admin", Icon: Shield },
  moderator: { label: "Moderator", short: "Mod", Icon: Shield },
  user: { label: "Member", short: "Member", Icon: User },
};

function parseMxid(mxid: string): { localpart: string; server: string } {
  const raw = mxid.startsWith("@") ? mxid.slice(1) : mxid;
  const colon = raw.indexOf(":");
  if (colon === -1) return { localpart: raw, server: "" };
  return { localpart: raw.slice(0, colon), server: raw.slice(colon + 1) };
}

function bannerGradientFromUserId(userId: string, dark: boolean): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = userId.charCodeAt(i) + ((h << 5) - h);
  }
  const hue = Math.abs(h) % 360;
  const hue2 = (hue + 48) % 360;
  const hue3 = (hue + 200) % 360;
  if (dark) {
    return `linear-gradient(155deg, hsl(${hue}, 48%, 26%) 0%, hsl(${hue2}, 40%, 16%) 45%, hsl(${hue3}, 32%, 11%) 100%)`;
  }
  return `linear-gradient(155deg, hsl(${hue}, 42%, 52%) 0%, hsl(${hue2}, 38%, 42%) 45%, hsl(${hue3}, 28%, 36%) 100%)`;
}

function presenceDotColor(presence: string): string {
  switch (presence) {
    case "online":
      return "#23a55a";
    case "unavailable":
      return "#f0b232";
    case "dnd":
      return "#f23f43";
    default:
      return "#80848e";
  }
}

function presenceLabel(presence: string): string {
  switch (presence) {
    case "online":
      return "Online";
    case "unavailable":
      return "Away";
    case "dnd":
      return "Do not disturb";
    case "offline":
    default:
      return "Offline";
  }
}

interface UserProfileDialogProps {
  roomId: string;
  userId: string;
  /** When set and equal to `userId`, presence is taken from local status (matches the user menu). */
  currentUserId?: string;
  onClose: () => void;
}

function sameMatrixUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export default function UserProfileDialog({
  roomId,
  userId,
  currentUserId,
  onClose,
}: UserProfileDialogProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const { effectivePresence } = usePresenceContext();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [profile, setProfile] = useState<RoomMemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const bannerCss = useMemo(
    () => bannerGradientFromUserId(userId, resolvedColorScheme === "dark"),
    [userId, resolvedColorScheme],
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProfile(null);
    void invoke<RoomMemberProfile>("get_room_member_profile", { roomId, memberUserId: userId })
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, userId]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const copyId = useCallback(() => {
    if (!profile) return;
    void navigator.clipboard.writeText(profile.userId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [profile]);

  const displayName = profile?.displayName ?? null;
  const { localpart, server } = profile ? parseMxid(profile.userId) : parseMxid(userId);
  const titleId = "user-profile-display-name";

  const avatarPx = 92;
  const ringPx = 4;
  /** Half outer diameter — avatar is centered on the banner / body seam. */
  const avatarOverhang = avatarPx / 2 + ringPx;
  const roleKey = profile?.role ?? "user";
  const roleMeta = ROLE_META[roleKey] ?? ROLE_META.user;
  const RoleIcon = roleMeta.Icon;

  const isSelf =
    currentUserId != null &&
    currentUserId.length > 0 &&
    sameMatrixUser(currentUserId, userId);
  const presenceToShow =
    profile && isSelf ? effectivePresence : profile?.presence ?? "offline";

  return (
    <ModalLayer
      onBackdropClick={handleBackdropClick}
      backdropStyle={{
        backgroundColor: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        fontFamily: typography.fontFamily,
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-labelledby={titleId}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: "min(400px, calc(100vw - 32px))",
          // Nearly full webview height (backdrop padding 16px × 2); no fixed px cap so the dialog grows with the window.
          maxHeight: "calc(100vh - 32px)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 48px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06) inset",
          border: `1px solid ${palette.border}`,
        }}
      >
        {/* Banner, close, and avatar (absolute so scroll overflow does not clip the circle) */}
        <div
          style={{
            height: 100,
            position: "relative",
            flexShrink: 0,
            overflow: "visible",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: loading ? palette.bgTertiary : bannerCss,
            }}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close profile"
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.45)",
              color: "#fff",
              zIndex: 2,
              transition: "background-color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(0,0,0,0.65)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(0,0,0,0.45)";
            }}
          >
            <X size={18} strokeWidth={2.25} />
          </button>
          <div
            style={{
              position: "absolute",
              left: spacing.unit * 4,
              bottom: -avatarOverhang,
              zIndex: 1,
            }}
          >
            <div
              style={{
                width: avatarPx + ringPx * 2,
                height: avatarPx + ringPx * 2,
                borderRadius: "50%",
                padding: ringPx,
                backgroundColor: palette.bgSecondary,
                boxSizing: "border-box",
              }}
            >
              {loading ? (
                <div
                  style={{
                    width: avatarPx,
                    height: avatarPx,
                    borderRadius: "50%",
                    backgroundColor: palette.bgTertiary,
                  }}
                />
              ) : profile?.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt=""
                  style={{
                    width: avatarPx,
                    height: avatarPx,
                    borderRadius: "50%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: avatarPx,
                    height: avatarPx,
                    borderRadius: "50%",
                    backgroundColor: userInitialAvatarBackground(userId, resolvedColorScheme),
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 34,
                    fontWeight: typography.fontWeightBold,
                  }}
                >
                  {(displayName ?? userId).charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable body — height follows content; only scrolls when taller than remaining viewport */}
        <div
          style={{
            overflowY: "auto",
            flex: "0 1 auto",
            maxHeight: "calc(100vh - 32px - 100px)",
            position: "relative",
            paddingTop: avatarOverhang + spacing.unit * 2,
          }}
        >
          <div
            style={{
              padding: `0 ${spacing.unit * 4}px ${spacing.unit * 5}px`,
            }}
          >
            {loading && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 2,
                  color: palette.textSecondary,
                  paddingTop: spacing.unit * 2,
                  fontSize: typography.fontSizeSmall,
                }}
              >
                <Loader2 size={18} style={{ animation: "paxSpin 0.85s linear infinite" }} />
                Loading profile…
              </div>
            )}

            {!loading && error && (
              <div
                style={{
                  color: "#ed4245",
                  fontSize: typography.fontSizeSmall,
                  paddingTop: spacing.unit * 2,
                  lineHeight: 1.45,
                }}
              >
                {error}
              </div>
            )}

            {!loading && profile && (
              <>
                <h1
                  id={titleId}
                  style={{
                    margin: 0,
                    paddingTop: spacing.unit,
                    fontSize: 22,
                    fontWeight: typography.fontWeightBold,
                    color: palette.textHeading,
                    letterSpacing: -0.3,
                    lineHeight: 1.2,
                  }}
                >
                  {displayName ?? localpart}
                </h1>

                <div
                  style={{
                    marginTop: 4,
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textSecondary,
                    }}
                  >
                    @{localpart}
                    {server ? (
                      <span style={{ opacity: 0.85 }}>{`:${server}`}</span>
                    ) : null}
                  </span>
                </div>

                {/* Presence — Discord “status” row */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: spacing.unit * 3,
                    paddingBottom: spacing.unit * 2,
                    borderBottom: `1px solid ${palette.border}`,
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      backgroundColor: presenceDotColor(presenceToShow),
                      flexShrink: 0,
                      boxShadow: `0 0 0 2px ${palette.bgSecondary}`,
                    }}
                  />
                  <span
                    style={{
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                      fontWeight: typography.fontWeightMedium,
                    }}
                  >
                    {presenceLabel(presenceToShow)}
                  </span>
                </div>

                {/* Role badge */}
                <div style={{ marginTop: spacing.unit * 3, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "4px 10px",
                      borderRadius: 20,
                      fontSize: 11,
                      fontWeight: typography.fontWeightBold,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      backgroundColor:
                        roleKey === "creator"
                          ? "rgba(240, 178, 50, 0.2)"
                          : roleKey === "administrator"
                            ? "rgba(237, 66, 69, 0.18)"
                            : roleKey === "moderator"
                              ? "rgba(88, 101, 242, 0.2)"
                              : palette.bgTertiary,
                      color:
                        roleKey === "creator"
                          ? "#f0b232"
                          : roleKey === "administrator"
                            ? "#ed4245"
                            : roleKey === "moderator"
                              ? "#5865f2"
                              : palette.textSecondary,
                      border:
                        roleKey === "user"
                          ? `1px solid ${palette.border}`
                          : "1px solid transparent",
                    }}
                  >
                    <RoleIcon size={12} strokeWidth={2.5} />
                    {roleMeta.short}
                  </span>
                </div>

                {/* Member / room info card */}
                <div
                  style={{
                    marginTop: spacing.unit * 3,
                    backgroundColor: palette.bgTertiary,
                    borderRadius: 6,
                    padding: `${spacing.unit * 3}px ${spacing.unit * 3}px`,
                    border: `1px solid ${palette.border}`,
                  }}
                >
                  {profile.joinedAtMs != null && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: spacing.unit * 2,
                        marginBottom:
                          profile.powerLevel != null || profile.role === "creator"
                            ? spacing.unit * 2
                            : 0,
                      }}
                    >
                      <Calendar
                        size={16}
                        color={palette.textSecondary}
                        style={{ marginTop: 2, flexShrink: 0 }}
                      />
                      <div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: typography.fontWeightBold,
                            color: palette.textSecondary,
                            textTransform: "uppercase",
                            letterSpacing: 0.45,
                            marginBottom: 2,
                          }}
                        >
                          Member since
                        </div>
                        <div style={{ fontSize: typography.fontSizeSmall, color: palette.textPrimary }}>
                          {new Date(profile.joinedAtMs).toLocaleString(undefined, {
                            dateStyle: "long",
                            timeStyle: "short",
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {(profile.powerLevel != null || profile.role === "creator") && (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: spacing.unit * 2 }}>
                      <Hash
                        size={16}
                        color={palette.textSecondary}
                        style={{ marginTop: 2, flexShrink: 0 }}
                      />
                      <div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: typography.fontWeightBold,
                            color: palette.textSecondary,
                            textTransform: "uppercase",
                            letterSpacing: 0.45,
                            marginBottom: 2,
                          }}
                        >
                          Power level
                        </div>
                        <div style={{ fontSize: typography.fontSizeSmall, color: palette.textPrimary }}>
                          {profile.powerLevel != null ? profile.powerLevel : "∞ · room creator"}
                        </div>
                      </div>
                    </div>
                  )}

                  {!profile.joinedAtMs && profile.powerLevel == null && profile.role !== "creator" && (
                    <div style={{ fontSize: typography.fontSizeSmall, color: palette.textSecondary }}>
                      {roleMeta.label} · {profile.homeserver}
                    </div>
                  )}
                </div>

                {/* Permissions */}
                <div style={{ marginTop: spacing.unit * 3 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: typography.fontWeightBold,
                      color: palette.textSecondary,
                      textTransform: "uppercase",
                      letterSpacing: 0.45,
                      marginBottom: 8,
                    }}
                  >
                    Room permissions
                  </div>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall,
                      color: palette.textPrimary,
                      lineHeight: 1.65,
                    }}
                  >
                    {profile.canInvite && <div>✓ Invite members</div>}
                    {profile.canKick && <div>✓ Remove members</div>}
                    {profile.canBan && <div>✓ Ban members</div>}
                    {!profile.canInvite && !profile.canKick && !profile.canBan && (
                      <div style={{ color: palette.textSecondary }}>No moderation permissions</div>
                    )}
                  </div>
                </div>

                {profile.nameAmbiguous && (
                  <div
                    style={{
                      marginTop: spacing.unit * 3,
                      padding: spacing.unit * 3,
                      borderRadius: 6,
                      borderLeft: `3px solid ${palette.accent}`,
                      backgroundColor: palette.bgTertiary,
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                      lineHeight: 1.5,
                    }}
                  >
                    Display name matches another member in this room. Use the full Matrix ID to tell
                    accounts apart.
                  </div>
                )}

                {profile.isIgnored && (
                  <div
                    style={{
                      marginTop: spacing.unit * 2,
                      padding: spacing.unit * 2,
                      borderRadius: 6,
                      backgroundColor: "rgba(237, 66, 69, 0.12)",
                      color: "#ed4245",
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightMedium,
                    }}
                  >
                    You are ignoring this account.
                  </div>
                )}

                <button
                  type="button"
                  onClick={copyId}
                  style={{
                    marginTop: spacing.unit * 4,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: spacing.unit * 2,
                    width: "100%",
                    padding: `${11}px ${spacing.unit * 3}px`,
                    borderRadius: 4,
                    border: "none",
                    backgroundColor: resolvedColorScheme === "dark" ? "#248046" : "#2d7a4d",
                    color: "#fff",
                    fontSize: typography.fontSizeSmall,
                    fontWeight: typography.fontWeightBold,
                    cursor: "pointer",
                    transition: "filter 0.12s ease, transform 0.08s ease",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.filter = "brightness(1.08)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.filter = "none";
                  }}
                >
                  <Copy size={15} />
                  {copied ? "Copied!" : "Copy user ID"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes paxSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </ModalLayer>
  );
}

import { useEffect, useState, type CSSProperties } from "react";
import { useTheme } from "../theme/ThemeContext";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import { dmInitialsFromLabel } from "../utils/dmDisplay";
import { avatarSrc } from "../utils/avatarSrc";
import { useUserAvatar, useUserAvatarStore } from "../context/UserAvatarStore";

export type UserAvatarProps = {
  /** Matrix user id (e.g. `@alice:example.org`). Required to key the store. */
  userId: string;
  /** Display name for alt text + initials fallback. Falls back to userId. */
  displayName?: string | null;
  /** Square size in px. */
  size: number;
  /** Initials font size. Defaults to a size-proportional value. */
  fontSize?: number;
  /**
   * Override URL hint — when the caller has a freshly-fetched avatar URL
   * (e.g. from `get_matrix_user_profile`) that we want to both render and
   * prime into the store. Leave undefined for pure store-driven render.
   */
  avatarUrlHint?: string | null;
  className?: string;
  style?: CSSProperties;
};

/**
 * Single source of truth for rendering a Matrix user's avatar.
 *
 *   - Reads the latest file path for `userId` from the global
 *     `UserAvatarStore`.
 *   - On miss, kicks off a batched `get_user_avatars([userId, …])`
 *     round-trip via the store.
 *   - Falls back to a colored circle with initials while loading or
 *     when the user has no avatar set.
 *   - Defends against stale on-disk paths: if the `<img>` fails to
 *     load (e.g. the temp file was cleaned up), the entry is
 *     invalidated so the next mount re-fetches.
 *
 * Every user-avatar site in the app should use this component; room
 * avatars (which key on a room id, not a user) are a separate concern.
 */
export default function UserAvatar({
  userId,
  displayName,
  size,
  fontSize,
  avatarUrlHint,
  className,
  style,
}: UserAvatarProps) {
  const { palette, typography, resolvedColorScheme } = useTheme();
  const store = useUserAvatarStore();

  // When the caller knows a non-null URL (e.g. from a freshly-returned
  // profile response), feed the store so every other <UserAvatar> for
  // this user picks it up too. We deliberately skip `null` hints —
  // list-response callers often pass null for "backend didn't resolve
  // yet", not "user has no avatar", and tombstoning would prevent a
  // future fetch. The callsite still gets its hint reflected via
  // `avatarUrlHint` taking precedence in `effectiveUrl` below.
  useEffect(() => {
    if (!avatarUrlHint) return;
    store.prime(userId, avatarUrlHint);
  }, [userId, avatarUrlHint, store]);

  // Subscribe to this user's slot only — other users' updates do not
  // trigger a re-render here.
  const fromStore = useUserAvatar(userId);
  useEffect(() => {
    if (fromStore === undefined) {
      store.requestFetch([userId]);
    }
  }, [userId, fromStore, store]);

  // Reset the per-mount "image failed to load" flag whenever the URL
  // actually changes (avatar update, user switch, etc.). Hint wins
  // when truthy so a caller supplying a fresh URL renders it on the
  // first paint (no flash of initials). A falsy hint falls back to
  // the store so the store's authoritative null/url still applies.
  const effectiveUrl = avatarUrlHint || fromStore || null;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [effectiveUrl]);

  const label = (displayName ?? "").trim() || userId;
  const initials = dmInitialsFromLabel(label);
  const fs = fontSize ?? Math.max(10, Math.round(size * 0.4));

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    backgroundColor: userInitialAvatarBackground(userId, resolvedColorScheme),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    fontSize: fs,
    fontWeight: typography.fontWeightBold,
    color: palette.textPrimary,
    overflow: "hidden",
    ...style,
  };

  const showImage = !!effectiveUrl && !imageFailed;

  return (
    <div className={className} style={containerStyle}>
      {showImage ? (
        <img
          src={avatarSrc(effectiveUrl)}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => {
            setImageFailed(true);
            // The on-disk temp file probably got cleaned up — drop the
            // entry so the next mount re-fetches through the store.
            store.invalidate(userId);
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initials
      )}
    </div>
  );
}

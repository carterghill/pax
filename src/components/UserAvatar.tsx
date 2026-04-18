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

  // The STORE is authoritative once it has resolved. The hint is only a
  // bootstrap value for the first paint (before the store answers), so a
  // list-provided path that's been invalidated behind our back — e.g. a
  // `room.avatarUrl` that pointed into the avatar temp dir before
  // `clear_media_cache` wiped it on room switch — cannot permanently
  // override a freshly-written path that messages / member sync just
  // primed into the store. Without this, the sidebar / DM banner sit on
  // initials forever after `clear_media_cache`, even though the chat
  // timeline (which has a fresh hint from `get_messages`) renders fine.
  const effectiveUrl =
    fromStore !== undefined ? fromStore : avatarUrlHint || null;
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
          // No `loading="lazy"`: avatars are tiny and above-the-fold
          // everywhere they appear. Chromium's lazy-load intervention
          // swaps in a placeholder for a frame (see browser console
          // `[Intervention] Images loaded lazily and replaced with
          // placeholders`) and renders the alt text on top of the
          // container's color-by-id background — producing a
          // pixel-perfect facsimile of our initials fallback for one
          // or two frames before the real image paints. Eager loading
          // + empty alt eliminates that flash.
          //
          // No `alt`: the user's display name is always shown next to
          // the avatar in every callsite (sidebar rows, member lists,
          // DM banners, message authors), so the img is decorative
          // here. An empty alt keeps accessibility tools from
          // double-announcing the name, and removes the fuel for the
          // placeholder-text flash.
          alt=""
          // `decoding="sync"` pairs with the preload done in
          // `UserAvatarStore.writeEntry` / hydration: by the time
          // this `<img>` actually mounts, the bytes are already in
          // the browser's image cache, and sync decoding forces the
          // pixels to be ready in the same frame the element is
          // laid out — no blank-box interstitial.
          decoding="sync"
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
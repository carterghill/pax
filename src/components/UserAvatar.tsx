import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTheme } from "../theme/ThemeContext";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import { avatarSrc } from "../utils/avatarSrc";
import { useUserAvatar, useUserAvatarStore } from "../context/UserAvatarStore";

export type UserAvatarProps = {
  /** Matrix user id (e.g. `@alice:example.org`). Required to key the store. */
  userId: string;
  /** Display name (surrounding UI; avatar image is decorative). */
  displayName?: string | null;
  /** Square size in px. */
  size: number;
  /** Kept for call-site compatibility; ignored. */
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
 *   - Falls back to a user-id-colored circle with the app logo (white glyph)
 *     when the user has no avatar set; neutral placeholder while loading.
 *   - Defends against stale on-disk paths: if the `<img>` fails to
 *     load (e.g. the temp file was cleaned up), the entry is
 *     invalidated so the next mount re-fetches.
 *
 * Every user-avatar site in the app should use this component; room
 * avatars (which key on a room id, not a user) are a separate concern.
 */
export default function UserAvatar({
  userId,
  displayName: _displayName,
  size,
  fontSize: _fontSize,
  avatarUrlHint,
  className,
  style,
}: UserAvatarProps) {
  const { palette, resolvedColorScheme } = useTheme();
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
  const failedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!effectiveUrl) return;
    if (effectiveUrl === failedUrlRef.current) return;
    failedUrlRef.current = null;
    setImageFailed(false);
  }, [effectiveUrl]);

  // Three display states, NOT two. Collapsing "unknown" and "known
  // absent" into the same fallback branch was the real cause of
  // the sidebar flash: every time a <UserAvatar> mounted for a user
  // whose data wasn't in the store yet, we painted a full branded
  // fallback for one or more frames, then flipped to the
  // image when the store resolved. Now we only paint the logo fallback when
  // we KNOW the user has no avatar (store confirmed `null`), and
  // show a neutral empty circle while the answer is still unknown.
  //
  //   fromStore === null          → confirmed "no avatar"      → logo
  //   fromStore === undefined     → unknown (fetch in flight)  → empty
  //                                 AND no hint
  //   otherwise (path)            → render image
  //
  // `avatarUrlHint === null` deliberately does NOT count as
  // confirmed absence: list responses often pass null to mean
  // "backend did not resolve yet", not "user has no avatar".
  const hasKnownUrl = !!effectiveUrl && !imageFailed;
  const confirmedNoAvatar = fromStore === null && !avatarUrlHint;
  const showImage = hasKnownUrl;
  const showInitials = !hasKnownUrl && confirmedNoAvatar;

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    // The color-by-id background is ONLY painted when we're actually showing
    // the logo fallback — i.e. when the store has confirmed the user has no
    // avatar. If we're showing the image, the background must be neutral: if
    // it were colored, any frame of fetch+decode lag would show the colored
    // circle under the still-loading img — the same flash we're avoiding.
    backgroundColor: showInitials
      ? userInitialAvatarBackground(userId, resolvedColorScheme)
      : palette.bgSecondary,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    ...style,
  };

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
          // pixel-perfect facsimile of our logo fallback for one
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
            failedUrlRef.current = effectiveUrl;
            setImageFailed(true);
            // The on-disk temp file probably got cleaned up — drop the
            // entry so the next mount re-fetches through the store.
            store.invalidate(userId);
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : showInitials ? (
        <div
          style={{
            width: "100%",
            height: "100%",
            padding: Math.max(2, Math.round((5 / 48) * size)),
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Filter on the img only: a filtered wrapper expands paint bounds and
              with border-radius + overflow:hidden on the avatar can read as a
              horizontal shift; the img's box matches the composited pixels. */}
          <img
            src="/logoWhiteAlt.png"
            alt=""
            draggable={false}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              display: "block",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
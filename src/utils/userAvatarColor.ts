import type { ResolvedColorScheme } from "../theme/types";

/**
 * djb2-style hash → hue in [0, 360), stable per Matrix user id.
 * Same basis as the profile banner gradient in {@link UserProfileDialog}.
 */
export function userIdToHue(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = userId.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h) % 360;
}

/**
 * Solid fill for “initials” avatars when no profile image. Assumes white text.
 */
export function userInitialAvatarBackground(
  userId: string,
  scheme: ResolvedColorScheme,
): string {
  const hue = userIdToHue(userId);
  if (scheme === "dark") {
    return `hsl(${hue}, 52%, 42%)`;
  }
  return `hsl(${hue}, 50%, 40%)`;
}

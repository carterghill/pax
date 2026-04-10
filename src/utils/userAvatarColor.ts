import type { ResolvedColorScheme } from "../theme/types";

/**
 * djb2-style hash → hue in [0, 360), stable per Matrix id (user, room, or space).
 * Same basis as the profile banner gradient in {@link UserProfileDialog}.
 */
export function userIdToHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = id.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h) % 360;
}

function initialAvatarFillFromStableId(id: string, scheme: ResolvedColorScheme): string {
  const hue = userIdToHue(id);
  if (scheme === "dark") {
    return `hsl(${hue}, 52%, 42%)`;
  }
  return `hsl(${hue}, 50%, 40%)`;
}

/** Solid fill for user “initials” avatars when no profile image. Assumes white text. */
export function userInitialAvatarBackground(
  userId: string,
  scheme: ResolvedColorScheme,
): string {
  return initialAvatarFillFromStableId(userId, scheme);
}

/** Solid fill for space icons (initials) when no space avatar is set. Assumes white text. */
export function spaceInitialAvatarBackground(
  spaceId: string,
  scheme: ResolvedColorScheme,
): string {
  return initialAvatarFillFromStableId(spaceId, scheme);
}

/**
 * Matrix MXIDs (and `@room`) in plain message body text.
 * Keep in sync with mention pills in MessageMarkdown and the composer.
 */
const MATRIX_BODY_MXID_PATTERN =
  "(?<![\\w@])@(?:[a-zA-Z0-9._=\\-/]+:(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\\[[0-9a-fA-F:]+\\])(?::\\d+)?|room)(?=[^\\w.:/-]|\\.(?:$|[^\\w.-])|$)";

export const MATRIX_BODY_MXID_RE_GLOBAL = new RegExp(MATRIX_BODY_MXID_PATTERN, "g");

export function mentionDisplayName(
  userId: string,
  memberName?: string | null,
  linkedName?: string | null,
): string {
  for (const candidate of [memberName, linkedName]) {
    const name = candidate?.trim();
    if (name && name !== userId && `@${name}` !== userId) return name;
  }
  return userId;
}

export function mentionPillLabel(userId: string, displayName: string): string {
  if (displayName === userId) return userId.split(":")[0];
  return displayName.startsWith("@") ? displayName : `@${displayName}`;
}

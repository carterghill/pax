import type { Room } from "../types/matrix";

/**
 * Space room id plus every room in the space tree (channels and nested sub-spaces).
 * Used for kick/ban across an entire space from the client.
 */
export function collectRoomIdsInSpaceTree(
  rootSpaceId: string,
  roomsBySpace: (spaceId: string | null) => Room[],
): string[] {
  const ids = new Set<string>();
  const walk = (sid: string) => {
    ids.add(sid);
    for (const r of roomsBySpace(sid)) {
      ids.add(r.id);
      if (r.isSpace) walk(r.id);
    }
  };
  walk(rootSpaceId);
  return [...ids];
}

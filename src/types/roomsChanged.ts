import type { Room } from "./matrix";

/** Passed when a room/space was created or joined so the UI can update before sync catches up. */
export type RoomsChangedPayload = {
  joinedRoomId?: string;
  optimisticRoom?: Room;
  /** Topic for a newly created child room (not stored on `Room`); used by space home cache. */
  newSpaceChildTopic?: string | null;
};

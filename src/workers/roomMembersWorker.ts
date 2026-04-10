/// <reference lib="webworker" />

import type { RoomMember } from "../types/matrix";
import { processRoomMembersRaw } from "../utils/roomMembersProcess";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<{ id: number; members: RoomMember[] }>) => {
  const { id, members } = e.data;
  const result = processRoomMembersRaw(members);
  ctx.postMessage({ id, result });
};

import type { RoomMember } from "../types/matrix";
import {
  processRoomMembersRaw,
  type MemberPresenceCounts,
} from "./roomMembersProcess";

const THRESHOLD = 80;

type Processed = {
  members: RoomMember[];
  presenceCounts: MemberPresenceCounts;
  totalJoinedCount: number;
};

let worker: Worker | null = null;
let nextId = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/roomMembersWorker.ts", import.meta.url), {
      type: "module",
    });
  }
  return worker;
}

/**
 * Heavy dedupe/sort/count off the main thread when the list is large.
 * Small lists stay synchronous to avoid worker + postMessage overhead.
 */
export function processRoomMembersForFetch(members: RoomMember[]): Promise<Processed> {
  if (members.length <= THRESHOLD) {
    return Promise.resolve(processRoomMembersRaw(members));
  }

  const id = ++nextId;
  const w = getWorker();

  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<{ id: number; result: Processed }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      resolve(e.data.result);
    };
    const onErr = (err: ErrorEvent) => {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      reject(err.error ?? err);
    };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    w.postMessage({ id, members });
  });
}

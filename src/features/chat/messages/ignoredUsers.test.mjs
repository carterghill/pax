import assert from "node:assert/strict";
import test from "node:test";
import { projectMessages } from "./ignoredUsers.ts";

const bob = "@bob:example.org";
const carol = "@carol:example.org";

test("hides cached messages while preserving membership state and unignore restores the cache", () => {
  const cached = [
    { eventId: "$message", sender: bob },
    { eventId: "$encrypted", sender: bob, decryptionFailed: true },
    { eventId: "$call", sender: bob, directCallNotice: { kind: "ring" } },
    { eventId: "$joined", sender: bob, membershipNotice: { action: "joined" } },
    { eventId: "$unrelated", sender: carol },
  ];
  assert.deepEqual(projectMessages(cached, new Set([bob])), cached.slice(-2));
  assert.equal(projectMessages(cached, new Set()), cached);
});

test("de-aggregates cached reactions and derives counts from visible thread replies", () => {
  const cached = [{
    eventId: "$root",
    sender: carol,
    reactions: [
      { key: "👍", count: 2, reactedBy: [bob, carol], reactedByMe: true },
      { key: "👋", count: 1, reactedBy: [bob], reactedByMe: false },
    ],
    threadSummary: { count: 5, latestEventId: "$reply", latestTimestamp: 1 },
  }];
  const [projected] = projectMessages(cached, new Set([bob]));
  assert.deepEqual(projected.reactions, [
    { key: "👍", count: 1, reactedBy: [carol], reactedByMe: true },
  ]);
  assert.equal(projected.threadSummary, undefined);
  assert.equal(cached[0].reactions[0].count, 2);
});

test("keeps a server thread bundle fetched with the current ignore list", () => {
  const threadSummary = { count: 3, latestEventId: "$reply", latestTimestamp: 1, ignoreListRevision: 2 };
  const cached = [{ eventId: "$root", sender: carol, threadSummary }];
  const ignoredUsers = new Set([bob]);
  assert.equal(projectMessages(cached, ignoredUsers, 2)[0].threadSummary, threadSummary);
  assert.equal(projectMessages(cached, ignoredUsers, 3)[0].threadSummary, undefined);
});

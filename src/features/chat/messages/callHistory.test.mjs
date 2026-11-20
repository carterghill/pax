import assert from "node:assert/strict";
import test from "node:test";
import { projectCallHistory } from "./callHistory.ts";

function signal(kind, eventId = `$${kind}`, callId = "a-call") {
  return { eventId, directCallNotice: { callId, kind } };
}

test("a call appears once and its later hang-up is covered by the read receipt", () => {
  const chat = { eventId: "$message" };
  const ring = signal("ring");
  const history = projectCallHistory([ring, chat, signal("answer"), signal("connect"), signal("end")]);

  assert.deepEqual(history.messages, [ring, chat]);
  assert.equal(history.anchors.get("$end"), "$ring");
  assert.equal(history.readThroughEventId, "$end");
  assert.equal(history.missedCalls.size, 0);
});

test("a missed call stays at the ring while a newer message remains the read target", () => {
  const ring = signal("ring");
  const chat = { eventId: "$new-message" };
  const history = projectCallHistory([ring, signal("end"), chat]);

  assert.deepEqual(history.messages, [ring, chat]);
  assert.deepEqual([...history.missedCalls], ["$ring"]);
  assert.equal(history.readThroughEventId, "$new-message");
});

test("the server's latest event wins when a call signal has a skewed timestamp", () => {
  const ring = signal("ring");
  const end = signal("end");
  const chat = { eventId: "$message" };
  assert.equal(projectCallHistory([ring, end, chat], "$end").readThroughEventId, "$end");
  assert.equal(projectCallHistory([ring, chat, end], "$message").readThroughEventId, "$message");
});

test("a partial page still shows the call and merges into the ring when older history is loaded", () => {
  const end = signal("end");
  const ring = signal("ring");
  const local = { eventId: "local:draft" };
  const partial = projectCallHistory([end, local]);
  const complete = projectCallHistory([ring, end, local]);

  assert.deepEqual(partial.messages, [end, local]);
  assert.deepEqual(complete.messages, [ring, local]);
  assert.equal(complete.readThroughEventId, "$end");
});

test("predecessor calls stay distinct and cannot send a receipt in the current room", () => {
  const predecessorRing = { ...signal("ring", "$prior-ring"), historyRoomId: "!predecessor:example.org" };
  const currentRing = signal("ring");
  const history = projectCallHistory([predecessorRing, currentRing]);

  assert.deepEqual(history.messages, [predecessorRing, currentRing]);
  assert.equal(projectCallHistory([predecessorRing]).readThroughEventId, null);
});

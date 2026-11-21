import assert from "node:assert/strict";
import test from "node:test";
import { projectCallHistory, trimTimelineWindow } from "./callHistory.ts";

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

function calls(count) {
  return Array.from({ length: count }, (_, i) =>
    ["ring", "answer", "connect", "end"].map((kind) => signal(kind, `$${i}-${kind}`, `call-${i}`)),
  ).flat();
}

test("loading older call history does not evict the latest page at 100 raw signals", () => {
  const older = calls(20);
  const recent = calls(20).map((message) => ({
    ...message,
    eventId: `${message.eventId}-recent`,
    directCallNotice: { ...message.directCallNotice, callId: `${message.directCallNotice.callId}-recent` },
  }));
  const combined = [...older, ...recent];
  const window = trimTimelineWindow(combined, 100, "oldest");

  assert.equal(window, combined, "no eviction means the hook stays at the latest page");
  assert.equal(window.length, 160);
  assert.equal(projectCallHistory(window).messages.length, 40);
  assert.equal(projectCallHistory(window).readThroughEventId, recent.at(-1).eventId);
});

test("both window edges retain complete calls and cap visible rows", () => {
  const timeline = calls(105);
  for (const keep of ["oldest", "latest"]) {
    const window = trimTimelineWindow(timeline, 100, keep);
    const start = keep === "oldest" ? 0 : 5;
    assert.deepEqual(window, timeline.slice(start * 4, (start + 100) * 4));
    assert.equal(projectCallHistory(window).messages.length, 100);
    assert.equal(projectCallHistory(window).missedCalls.size, 0);
  }
});

test("trimming retains a kept call's outcome across intervening message rows", () => {
  const timeline = [signal("ring"), { eventId: "$chat-1" }, { eventId: "$chat-2" }, signal("end")];
  const window = trimTimelineWindow(timeline, 2, "oldest");
  const history = projectCallHistory(window);

  assert.deepEqual(window, [timeline[0], timeline[1], timeline[3]]);
  assert.deepEqual(history.messages, [timeline[0], timeline[1]]);
  assert.equal(history.missedCalls.has("$ring"), true);
});

test("text messages and predecessor calls each consume their own row", () => {
  const previous = { ...signal("ring", "$previous"), historyRoomId: "!previous:example.org" };
  const current = signal("ring");
  const chat = { eventId: "$chat" };
  const timeline = [previous, current, chat, signal("end")];

  assert.deepEqual(trimTimelineWindow(timeline, 2, "latest"), [current, chat, timeline[3]]);
  assert.deepEqual(trimTimelineWindow(timeline, 2, "oldest"), [previous, current, timeline[3]]);
  assert.deepEqual(trimTimelineWindow([previous, current, chat], 2, "latest"), [current, chat]);
  assert.deepEqual(trimTimelineWindow([previous, current, chat], 2, "oldest"), [previous, current]);
});

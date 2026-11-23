import assert from "node:assert/strict";
import test from "node:test";
import { describeCall, formatCallDuration, projectCallHistory, trimTimelineWindow } from "./callHistory.ts";

const ME = "@me:example.org";
const CARTER = "@carter:example.org";

function signal(kind, eventId = `$${kind}`, callId = "a-call", details = {}, sender = CARTER, timestamp = 1_000) {
  return { eventId, sender, timestamp, directCallNotice: { callId, kind, ...details } };
}

test("a call appears once and its later hang-up is covered by the read receipt", () => {
  const chat = { eventId: "$message" };
  const ring = signal("ring");
  const history = projectCallHistory([ring, chat, signal("answer"), signal("connect"), signal("end")]);

  assert.deepEqual(history.messages, [ring, chat]);
  assert.equal(history.anchors.get("$end"), "$ring");
  assert.equal(history.readThroughEventId, "$end");
  assert.equal(history.callSummaries.get("$ring").outcome, "completed");
});

test("a missed call stays at the ring while a newer message remains the read target", () => {
  const ring = signal("ring");
  const chat = { eventId: "$new-message" };
  const history = projectCallHistory([ring, signal("end", "$end", "a-call", { endReason: "missed" }), chat]);

  assert.deepEqual(history.messages, [ring, chat]);
  assert.equal(history.callSummaries.get("$ring").outcome, "missed");
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
    assert.ok([...projectCallHistory(window).callSummaries.values()].every((call) => call.outcome === "completed"));
  }
});

test("trimming retains a kept call's outcome across intervening message rows", () => {
  const end = signal("end", "$end", "a-call", { endReason: "missed" });
  const timeline = [signal("ring"), { eventId: "$chat-1" }, { eventId: "$chat-2" }, end];
  const window = trimTimelineWindow(timeline, 2, "oldest");
  const history = projectCallHistory(window);

  assert.deepEqual(window, [timeline[0], timeline[1], timeline[3]]);
  assert.deepEqual(history.messages, [timeline[0], timeline[1]]);
  assert.equal(history.callSummaries.get("$ring").outcome, "missed");
});

test("missed and declined calls say who called and who declined", () => {
  const offer = signal("ring", "$ring", "id", { expiresAt: 31_000, invitee: ME });
  const declined = signal("end", "$reject", "id", { endReason: "declined" }, ME, 3_000);
  const timedOut = signal("end", "$timeout", "id", { endReason: "missed" }, CARTER, 31_000);
  const incomingDecline = projectCallHistory([offer, declined]).callSummaries.get("$ring");
  const incomingMiss = projectCallHistory([offer, timedOut]).callSummaries.get("$ring");
  assert.equal(describeCall(incomingDecline, ME, "Carter"), "You declined Carter’s call");
  assert.equal(describeCall(incomingDecline, CARTER, "Alex"), "Alex declined your call");
  assert.equal(describeCall(incomingMiss, ME, "Carter"), "You missed a call from Carter");
  assert.equal(describeCall(incomingMiss, CARTER, "Alex"), "Alex missed your call");
});

test("an expired offer reads as missed while ending it early reads as canceled", () => {
  const ring = signal("ring", "$ring", "id", { expiresAt: 31_000 });
  const pending = projectCallHistory([ring], null, 30_999);
  assert.equal(pending.callSummaries.get("$ring").outcome, "placed");
  assert.equal(pending.nextCallExpiry, 31_000);
  const expired = projectCallHistory([ring], null, 31_000);
  assert.equal(expired.callSummaries.get("$ring").outcome, "missed");
  assert.equal(expired.nextCallExpiry, undefined);
  const early = signal("end", "$end", "id", {}, CARTER, 3_000);
  const canceled = projectCallHistory([ring, early]).callSummaries.get("$ring");
  assert.equal(canceled.outcome, "canceled");
  assert.equal(canceled.endedAt, 3_000);
});

test("the selected Matrix device decides between answering and declining", () => {
  const ring = signal("ring", "$ring", "id", { invitee: ME });
  const reject = signal("end", "$reject", "id", { endReason: "declined", partyId: "phone" }, ME, 2_000);
  const answer = signal("answer", "$answer", "id", { partyId: "desktop" }, ME, 2_500);
  const end = signal("end", "$end", "id", { durationMs: 62_400 }, CARTER, 68_000);
  const selectDesktop = signal("connect", "$select", "id", { selectedPartyId: "desktop" }, CARTER, 2_900);
  const completed = projectCallHistory([ring, reject, answer, selectDesktop, end]).callSummaries.get("$ring");
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.durationMs, 62_400);
  assert.equal(completed.estimatedDuration, false);
  assert.equal(completed.endedAt, 68_000);
  assert.equal(formatCallDuration(completed.durationMs), "1m 2s");

  const selectPhone = signal("connect", "$select", "id", { selectedPartyId: "phone" }, CARTER, 2_900);
  const declined = projectCallHistory([ring, answer, reject, selectPhone]).callSummaries.get("$ring");
  assert.equal(declined.outcome, "declined");
  assert.equal(declined.endedAt, 2_000);
});

test("older connected calls show an estimate and setup failures show no duration", () => {
  const ring = signal("ring", "$ring", "id");
  const answer = signal("answer", "$answer", "id", {}, ME, 2_000);
  const connected = signal("connect", "$connect", "id", {}, CARTER, 3_000);
  const end = signal("end", "$end", "id", {}, CARTER, 65_000);
  const estimated = projectCallHistory([ring, answer, connected, end]).callSummaries.get("$ring");
  assert.equal(estimated.durationMs, 62_000);
  assert.equal(estimated.estimatedDuration, true);

  const failure = signal("end", "$end", "id", { endReason: "failed" }, CARTER, 4_000);
  const failed = projectCallHistory([ring, answer, failure]).callSummaries.get("$ring");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.durationMs, undefined);
});

test("a Matrix v0 hang-up declines an unanswered call, while an unmarked old Pax hang-up stays ambiguous", () => {
  const ring = signal("ring", "$ring", "id");
  const answer = signal("answer", "$answer", "id", {}, ME, 2_000);
  const end = signal("end", "$end", "id", { endReason: "legacyHangup" }, ME, 4_000);
  assert.equal(projectCallHistory([ring, end]).callSummaries.get("$ring").outcome, "declined");
  assert.equal(projectCallHistory([ring, answer, end]).callSummaries.get("$ring").outcome, "completed");
  const oldPaxEnd = signal("end", "$end", "id", {}, ME, 4_000);
  assert.equal(projectCallHistory([ring, oldPaxEnd]).callSummaries.get("$ring").outcome, "ended");
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

test("a named invitation is shown only in the two participants' call history", () => {
  const ring = signal("ring", "$ring", "a-call", { invitee: ME });
  const end = signal("end");
  const chat = { eventId: "$chat" };
  const timeline = [ring, chat, end];
  for (const viewer of [ME, CARTER]) {
    assert.deepEqual(projectCallHistory(timeline, null, 2_000, viewer).messages, [ring, chat]);
  }
  const observer = projectCallHistory(timeline, null, 2_000, "@third:example.org");
  assert.deepEqual(observer.messages, [chat]);
  assert.equal(observer.readThroughEventId, end.eventId);
});

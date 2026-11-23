import test from "node:test";
import assert from "node:assert/strict";
import { applyGroupResponse } from "./groupCallResponses.ts";

const roomId = "!group:example.org";
const ringEventId = "$ring";
const caller = "@alice:example.org";
const bob = "@bob:example.org";
const carol = "@carol:example.org";
const ring = (outgoing) => ({
  outgoing, invitees: new Set([bob, carol]), declined: new Set(),
  call: { roomId, ringEventId, peerUserId: caller, phase: outgoing ? "dialing" : "incoming" },
});
const response = (kind, sender, fromSelf = false) => ({ kind, sender, fromSelf, roomId, ringEventId });

test("one person declining leaves the other invite open, including on the other recipient's device", () => {
  const host = ring(true);
  const invited = ring(false);
  const decline = response("decline", bob);
  assert.equal(applyGroupResponse(host, decline), undefined);
  assert.equal(applyGroupResponse(host, decline), undefined);
  assert.equal(applyGroupResponse(invited, decline), undefined);
  assert.equal(applyGroupResponse(invited, { ...decline, fromSelf: true }), "dismiss");
  assert.equal(applyGroupResponse(host, response("answer", carol)), "answered");
  host.call.phase = "active";
  assert.equal(applyGroupResponse(host, response("decline", carol)), undefined);
});

test("only independent declines from all invitees end the unanswered call", () => {
  const host = ring(true);
  assert.equal(applyGroupResponse(host, response("decline", caller)), undefined);
  assert.equal(applyGroupResponse(host, response("decline", bob)), undefined);
  assert.equal(applyGroupResponse(host, { ...response("decline", carol), ringEventId: "$other" }), undefined);
  assert.equal(applyGroupResponse(host, { ...response("decline", carol), roomId: "!else:example.org" }), undefined);
  assert.equal(applyGroupResponse(host, response("decline", carol)), "allDeclined");
});

test("a caller withdrawing the ring dismisses pending recipients and leaves the ongoing group session running", () => {
  const invited = ring(false);
  assert.equal(applyGroupResponse(invited, response("cancel", bob)), undefined);
  assert.equal(applyGroupResponse(invited, response("answer", carol)), undefined);
  assert.equal(applyGroupResponse(invited, response("answer", bob, true)), "dismiss");
  assert.equal(applyGroupResponse(invited, response("cancel", caller)), "dismiss");
  invited.call.phase = "answering";
  assert.equal(applyGroupResponse(invited, response("cancel", caller)), "dismiss");
  invited.call.phase = "active";
  assert.equal(applyGroupResponse(invited, response("cancel", caller)), undefined);
});

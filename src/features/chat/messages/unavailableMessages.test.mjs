import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgedUnavailableIds, unavailableReceiptPolicy } from "./unavailableMessages.mjs";

const missing = { eventId: "$missing", sender: "@friend:example.org", decryptionFailed: true };
const readable = { eventId: "$new", sender: "@friend:example.org", body: "hello" };

test("an unknown timeline head never treats cached missing messages as acknowledged", () => {
  assert.deepEqual(acknowledgedUnavailableIds([missing], [], null, null), []);
  assert.deepEqual(acknowledgedUnavailableIds([missing], [], "$head", null), []);
});
test("a context-menu clear covers loaded history but excludes messages arriving after its target", () => {
  const covered = acknowledgedUnavailableIds([missing, readable], [], "$new", "$new");
  assert.deepEqual(covered, ["$missing"]);
  const later = { ...missing, eventId: "$later" };
  const afterArrival = acknowledgedUnavailableIds([missing, readable, later], covered, "$new", "$later");
  assert.deepEqual(afterArrival, ["$missing"]);
  assert.equal(unavailableReceiptPolicy([missing, readable, later], "@me:example.org", afterArrival).blocked, true);
});

test("opening an unavailable reply preserves unread and never allows a public receipt", () => {
  assert.deepEqual(unavailableReceiptPolicy([missing], "@me:example.org", null), { blocked: true, privateOnly: true });
  assert.deepEqual(unavailableReceiptPolicy([missing, readable], "@me:example.org", []), { blocked: true, privateOnly: true });
});
test("acknowledgement permits later readable messages without publishing a read across the gap", () => {
  assert.deepEqual(unavailableReceiptPolicy([missing, readable], "@me:example.org", ["$missing"]), { blocked: false, privateOnly: true });
  assert.deepEqual(unavailableReceiptPolicy([missing, { ...missing, eventId: "$another" }], "@me:example.org", ["$missing"]), { blocked: true, privateOnly: true });
});
test("recovery removes the gap and own unavailable sends do not block incoming read tracking", () => {
  assert.deepEqual(unavailableReceiptPolicy([{ ...missing, decryptionFailed: false }, readable], "@me:example.org", []), { blocked: false, privateOnly: false });
  assert.deepEqual(unavailableReceiptPolicy([{ ...missing, sender: "@me:example.org" }, readable], "@me:example.org", []), { blocked: false, privateOnly: true });
});

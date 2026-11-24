import assert from "node:assert/strict";
import test from "node:test";
import { appendRoomLinkPreviews, roomLinkActionFailure, roomLinkPresentation, roomLinkTarget } from "./roomLinks.ts";

const text = (value) => ({ type: "text", value });
const element = (tagName, children, properties = {}) => ({ type: "element", tagName, properties, children });
const pax = "pax://room?id=%21room%3Aexample.org";
const permalink = "https://matrix.to/#/!room:example.org";
const aliasUri = "matrix:r/community:example.org?action=join";

test("room links recognize native and web Matrix links without consuming message or user links", () => {
  assert.equal(roomLinkTarget(pax), "!room:example.org");
  assert.equal(roomLinkTarget(permalink), "!room:example.org");
  assert.equal(roomLinkTarget(aliasUri), "#community:example.org");
  assert.equal(roomLinkTarget("matrix:roomid/domainless?action=join"), "!domainless");
  assert.equal(roomLinkTarget("https://matrix.to/#/!room:example.org/$event"), null);
  assert.equal(roomLinkTarget("https://matrix.to/#/@alice:example.org"), null);
  assert.equal(roomLinkTarget("matrix:roomid/room/e/event"), null);
});

test("previews deduplicate targets and skip code, quotes, and concealed content", () => {
  const tree = {
    type: "root", children: [
      element("p", [text(`Open ${pax}.`), element("a", [text("same room")], { href: permalink })]),
      element("code", [text("pax://room?id=%21ignored")]),
      element("blockquote", [element("a", [text("quoted")], { href: "https://matrix.to/#/!quoted" })]),
      element("span", [element("a", [text("spoiler")], { href: "https://matrix.to/#/!spoiler" })], { dataMxSpoiler: "" }),
      element("details", [element("a", [text("collapsed")], { href: "https://matrix.to/#/!collapsed" })]),
      element("a", [text("the community")], { href: aliasUri }),
    ],
  };
  appendRoomLinkPreviews(tree);
  assert.deepEqual(tree.children.slice(6).map((node) => node.properties.dataRoomLinkPreview), [pax, aliasUri]);
  assert.equal(tree.children[0].children[1].properties.href, pax);
  assert.equal(tree.children[0].children[2].value, ".");
});

test("only a confirmed invitation offers Accept invite, and membership takes precedence over the room rules", () => {
  const options = { label: "room", requested: false, loading: false, allowUnknownJoin: false };
  assert.deepEqual(roomLinkPresentation("invited", "invite", options), {
    action: "accept", buttonLabel: "Accept invite", status: "You’ve been invited",
  });
  assert.deepEqual(roomLinkPresentation("joined", "knock", options), {
    action: "open", buttonLabel: "Go to room", status: "You’re in this room",
  });
  assert.equal(roomLinkPresentation(null, "invite", options).action, null);
  assert.equal(roomLinkPresentation(null, "public", options).action, "join");
  assert.equal(roomLinkPresentation(null, "knock", options).action, "knock");
  assert.equal(roomLinkPresentation("knocked", "knock", options).action, null);
});

test("room and space previews explain access before a join, including restricted and knock-restricted rooms", () => {
  for (const label of ["room", "space"]) {
    const options = { label, requested: false, loading: false, allowUnknownJoin: true };
    const view = (rule, meetsRestriction, membership = null) =>
      roomLinkPresentation(membership, rule, { ...options, meetsRestriction });
    for (const blocked of [view("restricted", false), view("invite"), view("private")]) {
      assert.equal(blocked.action, null);
      assert.equal(blocked.buttonLabel, "Invite required");
    }
    assert.equal(view("restricted", true).action, "join");
    assert.equal(view("restricted", undefined).action, "join");
    assert.equal(view("restricted", false, "invited").action, "accept");
    assert.equal(view("knock_restricted", true).action, "join");
    assert.equal(view("knock_restricted", false).action, "knock");
    assert.equal(view("public", true, "banned").action, null);
  }
});

test("unresolved previews distinguish invalid links and missing aliases from an inconclusive lookup", () => {
  const options = { label: "room", requested: false, loading: false, allowUnknownJoin: true };
  for (const [previewFailure, label] of [["invalidLink", "Invalid link"], ["roomNotFound", "Room unavailable"]]) {
    const view = roomLinkPresentation(null, null, { ...options, previewFailure });
    assert.equal(view.action, null);
    assert.equal(view.buttonLabel, label);
  }
  assert.equal(roomLinkPresentation(null, null, options).action, "join");
  assert.equal(roomLinkPresentation(null, null, { ...options, loading: true }).action, null);
});

test("join refusals use the same explanation as preflight and distinguish expiry from retryable failures", () => {
  const error = "Failed to join room: the server returned an error: [403 / M_FORBIDDEN] You do not belong to any of the required rooms/spaces to join this room.";
  const result = roomLinkActionFailure(error, "join", "room");
  assert.deepEqual(result, roomLinkPresentation(null, "restricted", {
    label: "room", requested: false, loading: false, allowUnknownJoin: false, meetsRestriction: false,
  }));
  for (const [reason, label] of [
    ["[403 / M_FORBIDDEN] Forbidden", "Access denied"],
    ['Knock failed (403): {"errcode":"M_FORBIDDEN","error":"Invite required"}', "Invite required"],
    ["[403 / M_FORBIDDEN] Invitation has expired", "Invite expired"],
    ["[403 / M_FORBIDDEN] This invite has no uses left", "Invite used up"],
    ["[403 / M_FORBIDDEN] Invalid invite link", "Invalid link"],
    ["[404 / M_NOT_FOUND] Room not found", "Room unavailable"],
  ]) {
    assert.equal(roomLinkActionFailure(reason, "join", "room").buttonLabel, label);
  }
  for (const reason of ["[429 / M_LIMIT_EXCEEDED]", "[401 / M_UNKNOWN_TOKEN] Access token expired", "Connection timed out"]) {
    assert.equal(roomLinkActionFailure(reason, "join", "room").buttonLabel, undefined);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { appendRoomLinkPreviews, roomLinkPresentation, roomLinkTarget } from "./roomLinks.ts";

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

test("previews include bare and formatted links, deduplicate targets, and ignore code and quotes", () => {
  const tree = {
    type: "root", children: [
      element("p", [text(`Open ${pax}.`), element("a", [text("same room")], { href: permalink })]),
      element("code", [text("pax://room?id=%21ignored")]),
      element("blockquote", [element("a", [text("quoted")], { href: "https://matrix.to/#/!quoted" })]),
    ],
  };
  appendRoomLinkPreviews(tree, [element("a", [text("the community")], { href: aliasUri })]);
  assert.deepEqual(tree.children.slice(3).map((node) => node.properties.dataRoomLinkPreview), [pax, aliasUri]);
  assert.equal(tree.children[0].children[1].properties.href, pax);
  assert.equal(tree.children[0].children[2].value, ".");
});

test("only a confirmed invitation offers Accept invite, and membership takes precedence over the room rules", () => {
  const options = { label: "room", requested: false, loading: false, allowUnknownJoin: false };
  assert.deepEqual(roomLinkPresentation("invited", "invite", options), {
    action: "accept", status: "You’ve been invited",
  });
  assert.deepEqual(roomLinkPresentation("joined", "knock", options), {
    action: "open", status: "You’re in this room",
  });
  assert.equal(roomLinkPresentation(null, "invite", options).action, null);
  assert.equal(roomLinkPresentation(null, "public", options).action, "join");
  assert.equal(roomLinkPresentation(null, "knock", options).action, "knock");
  assert.equal(roomLinkPresentation("knocked", "knock", options).action, null);
});

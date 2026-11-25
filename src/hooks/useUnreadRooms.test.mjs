import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSpaceUnreadRollup } from "./useUnreadRooms.ts";

function badges(rooms) {
  const spaces = rooms.filter((room) => room.isSpace);
  const roomsBySpace = (id) => rooms.filter((room) => !room.isSpace && (room.parent ?? null) === id);
  const byId = new Map(rooms.map((room) => [room.id, room]));
  let result;
  function Sidebar() {
    result = useSpaceUnreadRollup(spaces, roomsBySpace, {
      isUnread: (id) => !!byId.get(id)?.messages,
      messageCount: (id) => byId.get(id)?.messages ?? 0,
      mentionCount: (id) => byId.get(id)?.mentions ?? 0,
    }, (id) => !!byId.get(id)?.muted);
    return null;
  }
  renderToStaticMarkup(createElement(Sidebar));
  return result;
}

test("unopened invitations add one badge to their room and its sidebar section", () => {
  const invite = { id: "dm", membership: "invited", isDirect: true, parentSpaceIds: [] };
  const inSpace = { id: "group", membership: "invited", parent: "space", parentSpaceIds: ["space"] };
  const rooms = [invite, inSpace, { id: "space", isSpace: true, parentSpaceIds: [] }];
  const fresh = badges(rooms);
  assert.equal(fresh.roomBadgeCount(invite), 1);
  assert.equal(fresh.effectiveHomeMentionCount(), 1);
  assert.equal(fresh.effectiveSpaceMentionCount("space"), 1);

  const seen = { ...invite, inviteSeen: true };
  const opened = badges([seen, ...rooms.slice(1)]);
  assert.equal(opened.roomBadgeCount(seen), 0);
  assert.equal(opened.effectiveHomeMentionCount(), 0);
  assert.equal(opened.effectiveSpaceMentionCount("space"), 1);
});

test("only joined rooms use message and mention counts, and muted rooms stay quiet", () => {
  const rooms = [
    { id: "pending", membership: "invited", messages: 4, mentions: 3 },
    { id: "muted", membership: "invited", muted: true },
    { id: "dm", membership: "joined", isDirect: true, messages: 3, mentions: 1 },
    { id: "channel", membership: "joined", messages: 8, mentions: 2 },
  ];
  const result = badges(rooms);
  assert.deepEqual(rooms.map(result.roomBadgeCount), [1, 0, 3, 2]);
  assert.equal(result.effectiveHomeMentionCount(), 6);
});

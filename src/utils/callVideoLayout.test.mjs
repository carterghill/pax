import assert from "node:assert/strict";
import { test } from "node:test";
import { callVideoLayout } from "./callVideoLayout.ts";

const alice = "@alice:pax", bob = "@bob:pax";
const camera = { identity: alice, source: "camera", streamId: "cam" };
const screen = { identity: alice, source: "screen", streamId: "share" };
const other = { identity: bob, source: "screen", streamId: "other" };

test("a camera moves between its owner's tile and avatar as that owner shares or stops", () => {
  for (const both of [[camera, screen], [screen, camera]]) {
    const { tiles, avatarCameras } = callVideoLayout([...both, other], "me", null, false);
    assert.deepEqual(tiles, [screen, other]);
    assert.deepEqual([...avatarCameras], [[alice, camera]]);
  }
  const onlyCamera = callVideoLayout([camera, other], "me", null, false);
  assert.deepEqual(onlyCamera.tiles, [camera, other]);
  assert.equal(onlyCamera.avatarCameras.size, 0);
  assert.deepEqual(callVideoLayout([screen], "me", null, false).tiles, [screen]);
});

test("self preview follows the same placement while another user's camera stays in the grid", () => {
  const preview = {};
  const layout = (local, sharing) => callVideoLayout([camera], bob, local, sharing);
  const self = { identity: bob, source: "camera", local: true, media: preview };
  const share = { identity: bob, source: "screen", local: true };
  assert.deepEqual(layout(preview, false).tiles, [camera, self]);
  const both = layout(preview, true);
  assert.deepEqual(both.tiles, [camera, share]);
  assert.deepEqual([...both.avatarCameras], [[bob, self]]);
  assert.deepEqual(layout(null, true).tiles, [camera, share]);
  assert.deepEqual(layout(null, false).tiles, [camera]);
});

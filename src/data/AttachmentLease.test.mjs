import assert from "node:assert/strict";
import { test } from "node:test";
import { AttachmentLease } from "./AttachmentLease.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a mounted consumer pins its path until disposal and releases exactly once", async () => {
  const events = [];
  const lease = new AttachmentLease("one", { source: "media" }, {
    acquire: async (request, id) => { events.push(["acquire", id, request]); return "/cache/image.png"; },
    release: async (id) => { events.push(["release", id]); },
  });
  assert.equal(await lease.path, "/cache/image.png");
  assert.equal(events.length, 1);
  lease.dispose(); lease.dispose(); await tick();
  assert.deepEqual(events[1], ["release", "one"]);
  assert.equal(events.length, 2);
});

test("navigation during a slow acquisition releases its eventual result without reordering IPC", async () => {
  const pending = deferred(); const events = [];
  const lease = new AttachmentLease("late", {}, {
    acquire: async () => { events.push("acquire"); return pending.promise; },
    release: async () => { events.push("release"); },
  });
  await tick(); lease.dispose();
  assert.deepEqual(events, ["acquire"]);
  pending.resolve("/cache/late.png"); await lease.path; await tick();
  assert.deepEqual(events, ["acquire", "release"]);
});

test("StrictMode cleanup before acquisition starts avoids unnecessary requests", async () => {
  let requests = 0, releases = 0;
  const lease = new AttachmentLease("cancelled", {}, {
    acquire: async () => { requests++; return "/cache/image.png"; },
    release: async () => { releases++; },
  });
  lease.dispose();
  await assert.rejects(lease.path, /cancelled/);
  assert.equal(requests, 0); assert.equal(releases, 0);
});

test("a failed acquisition releases its backend reservation even if the view stays mounted", async () => {
  let releases = 0;
  const lease = new AttachmentLease("failed", {}, {
    acquire: async () => { throw new Error("offline"); },
    release: async () => { releases++; },
  });
  await assert.rejects(lease.path, /offline/);
  assert.equal(releases, 1);
  lease.dispose(); assert.equal(releases, 1);
});

test("independent consumers of the same media have independent lease lifetimes", async () => {
  const released = [];
  const transport = { acquire: async () => "/cache/same.png", release: async (id) => { released.push(id); } };
  const first = new AttachmentLease("first", {}, transport);
  const viewer = new AttachmentLease("viewer", {}, transport);
  await Promise.all([first.path, viewer.path]);
  first.dispose(); await tick(); assert.deepEqual(released, ["first"]);
  viewer.dispose(); await tick(); assert.deepEqual(released, ["first", "viewer"]);
});

test("release failures cannot throw through view cleanup or change a resolved path", async (t) => {
  let warnings = 0;
  t.mock.method(console, "warn", () => { warnings++; });
  const lease = new AttachmentLease("release-error", {}, {
    acquire: async () => "/cache/image.png",
    release: () => { throw new Error("IPC closed"); },
  });
  assert.equal(await lease.path, "/cache/image.png");
  assert.doesNotThrow(() => lease.dispose());
  await tick();
  assert.equal(warnings, 1);
  assert.equal(await lease.path, "/cache/image.png");
});

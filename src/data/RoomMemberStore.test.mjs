import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomMemberStore } from "./RoomMemberStore.ts";

const roomA = "!a:server";
const roomB = "!b:server";
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Member state did not settle");
    await tick();
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const member = (userId, displayName = userId, extra = {}) => ({
  userId, displayName, avatarUrl: null, presence: "offline", statusMsg: null, ...extra,
});
function storeFor(t, load, extra = {}) {
  const store = new RoomMemberStore({ load, debounceMs: 1, ...extra });
  store.start();
  t.after(() => store.dispose());
  return store;
}
function watch(t, store, roomId, listener = () => {}) {
  const off = store.subscribe(roomId, listener);
  t.after(off);
  return off;
}

test("four consumers share one request, sorted members, and label lookup", async (t) => {
  let calls = 0, primes = 0;
  const response = deferred();
  const store = storeFor(t, async () => { calls++; return response.promise; }, { onMembers: () => { primes++; } });
  for (let i = 0; i < 4; i++) watch(t, store, roomA);
  await until(() => calls === 1);
  response.resolve([member("@bob:server", "Bob"), member("@alice:server", "Alice"), member("@bob:server", "Robert")]);
  await until(() => !store.getSnapshot(roomA).loading);
  const snapshot = store.getSnapshot(roomA);
  assert.deepEqual(snapshot.members.map((m) => m.userId), ["@alice:server", "@bob:server"]);
  assert.equal(snapshot.resolveMemberLabel("@bob:server"), "Robert");
  assert.equal(snapshot.resolveMemberLabel(" @ALICE:server "), "Alice");
  assert.equal(snapshot.resolveMemberLabel("@unknown:server"), "@unknown:server");
  assert.equal(store.getSnapshot(roomA), snapshot);
  assert.equal(calls, 1);
  assert.equal(primes, 1);
});

test("loading waits until event listeners are ready", async (t) => {
  let calls = 0;
  const store = new RoomMemberStore({ load: async () => { calls++; return []; } });
  t.after(() => store.dispose());
  watch(t, store, roomA);
  store.invalidate(roomA);
  await tick();
  assert.equal(calls, 0);
  store.start();
  await until(() => calls === 1);
});

test("room-scoped changes combine bursts and never refresh another room", async (t) => {
  const calls = new Map();
  const store = storeFor(t, async (id) => { calls.set(id, (calls.get(id) ?? 0) + 1); return []; });
  watch(t, store, roomA);
  watch(t, store, roomB);
  await until(() => !store.getSnapshot(roomA).loading && !store.getSnapshot(roomB).loading);
  const unchanged = store.getSnapshot(roomB);
  store.invalidate(roomA);
  store.invalidate(roomA);
  store.invalidate(roomA);
  store.invalidate("!unobserved:server");
  await until(() => calls.get(roomA) === 2);
  await tick();
  assert.equal(calls.get(roomB), 1);
  assert.equal(calls.size, 2);
  assert.equal(store.getSnapshot(roomB), unchanged);
});

test("changes during an in-flight fetch produce one follow-up and reject stale names", async (t) => {
  const response = deferred();
  let calls = 0;
  const accepted = [];
  const store = storeFor(t, async () => ++calls === 1 ? response.promise : [member("@alice:server", "New")], {
    onMembers: (members) => accepted.push(members[0].displayName),
  });
  watch(t, store, roomA);
  await until(() => calls === 1);
  for (let i = 0; i < 10; i++) store.invalidate(roomA);
  assert.equal(calls, 1);
  response.resolve([member("@alice:server", "Old")]);
  await until(() => store.getSnapshot(roomA).resolveMemberLabel("@alice:server") === "New");
  assert.equal(calls, 2);
  assert.deepEqual(accepted, ["New"]);
});

test("presence arriving during the initial fetch survives the response", async (t) => {
  const response = deferred();
  let started = false;
  const store = storeFor(t, async () => { started = true; return response.promise; });
  watch(t, store, roomA);
  await until(() => started);
  store.applyPresence([{ userId: "@alice:server", presence: "online", statusMsg: "Here" }]);
  response.resolve([member("@alice:server", "Alice")]);
  await until(() => !store.getSnapshot(roomA).loading);
  assert.equal(store.getSnapshot(roomA).members[0].presence, "online");
  assert.equal(store.getSnapshot(roomA).members[0].statusMsg, "Here");
});

test("presence updates share changes across rooms without fetching or rebuilding labels", async (t) => {
  let calls = 0;
  const store = storeFor(t, async () => { calls++; return [member("@bob:server", "Bob"), member("@alice:server", "Alice")]; });
  watch(t, store, roomA);
  watch(t, store, roomB);
  await until(() => !store.getSnapshot(roomA).loading && !store.getSnapshot(roomB).loading);
  const before = store.getSnapshot(roomA);
  store.applyPresence([{ userId: "@unrelated:server", presence: "online", statusMsg: null }]);
  assert.equal(store.getSnapshot(roomA), before);
  store.applyPresence([{ userId: "@alice:server", presence: "online", statusMsg: "Hello" }]);
  const after = store.getSnapshot(roomA);
  assert.equal(after.members[0].presence, "online");
  assert.equal(store.getSnapshot(roomB).members[0].presence, "online");
  assert.equal(after.resolveMemberLabel, before.resolveMemberLabel);
  assert.equal(after.members[1], before.members[1]);
  assert.equal(calls, 2);
  store.applyPresence([{ userId: "@alice:server", presence: "online", statusMsg: "Hello" }]);
  assert.equal(store.getSnapshot(roomA), after);
});

test("an older presence event cannot override a fresh member snapshot", async (t) => {
  let calls = 0;
  const store = storeFor(t, async () => { calls++; return [member("@alice:server")]; });
  watch(t, store, roomA);
  await until(() => !store.getSnapshot(roomA).loading);
  store.applyPresence([{ userId: "@alice:server", presence: "online", statusMsg: null }]);
  assert.equal(store.getSnapshot(roomA).members[0].presence, "online");
  store.invalidate(roomA);
  await until(() => calls === 2);
  await tick();
  assert.equal(store.getSnapshot(roomA).members[0].presence, "offline");
});

test("a name change updates the shared resolver and an unchanged refresh retains it", async (t) => {
  let name = "Alice", calls = 0;
  const store = storeFor(t, async () => { calls++; return [member("@alice:server", name)]; });
  watch(t, store, roomA);
  await until(() => !store.getSnapshot(roomA).loading);
  const before = store.getSnapshot(roomA);
  name = "Alicia";
  store.invalidate(roomA);
  await until(() => store.getSnapshot(roomA).resolveMemberLabel("@alice:server") === name);
  const renamed = store.getSnapshot(roomA);
  assert.notEqual(renamed.resolveMemberLabel, before.resolveMemberLabel);
  store.invalidate(roomA);
  await until(() => calls === 3);
  await tick();
  assert.equal(store.getSnapshot(roomA), renamed);
});

test("inactive rooms retain their snapshot and defer invalidations until revisited", async (t) => {
  let calls = 0;
  const store = storeFor(t, async () => { calls++; return [member("@alice:server", `Name ${calls}`)]; });
  const off = watch(t, store, roomA);
  await until(() => !store.getSnapshot(roomA).loading);
  const cached = store.getSnapshot(roomA);
  off();
  store.invalidate(roomA);
  await tick();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot(roomA), cached);
  watch(t, store, roomA);
  assert.equal(store.getSnapshot(roomA), cached);
  await until(() => calls === 2);
  await until(() => store.getSnapshot(roomA).resolveMemberLabel("@alice:server") === "Name 2");
});

test("a failed refresh preserves usable members and can be retried", async (t) => {
  let fail = false;
  const store = storeFor(t, async () => {
    if (fail) throw new Error("offline");
    return [member("@alice:server", "Alice")];
  });
  watch(t, store, roomA);
  await until(() => !store.getSnapshot(roomA).loading);
  const cached = store.getSnapshot(roomA);
  fail = true;
  store.invalidate(roomA);
  await until(() => store.getSnapshot(roomA).error !== null);
  assert.equal(store.getSnapshot(roomA).members, cached.members);
  assert.equal(store.getSnapshot(roomA).resolveMemberLabel, cached.resolveMemberLabel);
  fail = false;
  store.invalidate(roomA);
  await until(() => store.getSnapshot(roomA).error === null);
});

test("an initial error settles loading and a later subscription retries", async (t) => {
  let fail = true;
  const store = storeFor(t, async () => { if (fail) throw new Error("offline"); return []; });
  const off = watch(t, store, roomA);
  await until(() => store.getSnapshot(roomA).error !== null);
  assert.equal(store.getSnapshot(roomA).loading, false);
  off();
  fail = false;
  watch(t, store, roomA);
  await until(() => store.getSnapshot(roomA).error === null && !store.getSnapshot(roomA).loading);
});

test("cached rooms are bounded without evicting active subscriptions", async (t) => {
  const calls = new Map();
  const store = storeFor(t, async (id) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return [member("@alice:server")];
  }, { maxCachedRooms: 1 });
  const offA = watch(t, store, roomA);
  await until(() => !store.getSnapshot(roomA).loading);
  watch(t, store, roomB);
  await until(() => !store.getSnapshot(roomB).loading);
  assert.equal(store.getSnapshot(roomA).members.length, 1);
  offA();
  assert.equal(store.getSnapshot(roomA).members.length, 0);
  watch(t, store, roomA);
  await until(() => calls.get(roomA) === 2);
});

test("session disposal rejects late results and a development remount can refresh", async (t) => {
  const response = deferred();
  let calls = 0, primes = 0;
  const store = storeFor(t, async () => ++calls === 1 ? response.promise : [member("@new:server")], {
    onMembers: () => { primes++; },
  });
  watch(t, store, roomA);
  await until(() => calls === 1);
  store.dispose();
  response.resolve([member("@old:server")]);
  await tick();
  assert.equal(store.getSnapshot(roomA).members.length, 0);
  assert.equal(primes, 0);
  store.start();
  await until(() => store.getSnapshot(roomA).members[0]?.userId === "@new:server");
  assert.equal(calls, 2);
  assert.equal(primes, 1);
});

test("unsubscribing cancels queued work and draft rooms do not fetch", async (t) => {
  let calls = 0;
  const store = storeFor(t, async () => { calls++; return []; });
  const off = watch(t, store, roomA);
  off();
  watch(t, store, "draft:alice");
  await tick();
  assert.equal(calls, 0);
  assert.equal(store.getSnapshot("draft:alice").loading, false);
});

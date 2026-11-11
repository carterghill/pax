import assert from "node:assert/strict";
import { test } from "node:test";
import { VoicePresenceStore } from "./VoicePresenceStore.ts";

const a = "!a:server", b = "!b:server";
const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) { assert.ok(Date.now() < deadline, "Voice presence did not settle"); await tick(); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const member = (userId = "@alice:server", displayName = "Alice") => ({ userId, displayName, avatarUrl: null });
const live = (identity = "@alice:server", isMuted = false) => ({ identity, isMuted, isDeafened: false, isSpeaking: false });
const matrix = (participantsByRoom = { [a]: [member()], [b]: [] }, roomIds = [a, b], expiresAtByRoom = {}) => ({ roomIds, participantsByRoom, expiresAtByRoom });
const activity = (participantsByRoom = { [a]: [live()], [b]: [] }, available = true) => ({ available, participantsByRoom });
function fixture(t, options = {}) {
  const calls = { matrix: [], livekit: [] };
  const store = new VoicePresenceStore({
    pollMs: 10000, retryMs: 20, ...options,
    loadMatrix: async (ids) => { calls.matrix.push(ids); return options.loadMatrix ? options.loadMatrix(ids) : matrix(); },
    loadLivekit: async (ids) => { calls.livekit.push(ids); return options.loadLivekit ? options.loadLivekit(ids) : activity(); },
  });
  t.after(() => store.dispose());
  return { store, calls };
}

test("consumers share initial reads and overlapping visible rooms form one batch", async (t) => {
  const { store, calls } = fixture(t);
  const off = Array.from({ length: 4 }, () => store.subscribe(() => {}));
  store.watchLivekit([a, a]);
  store.watchLivekit([b, a]);
  await tick();
  assert.equal(calls.matrix.length, 0);
  assert.equal(calls.livekit.length, 0);
  store.start();
  await until(() => store.getSnapshot().livekitByRoom[a] && store.getSnapshot().participantsByRoom[a]);
  assert.equal(calls.matrix.length, 1);
  assert.equal(calls.livekit.length, 1);
  assert.deepEqual(calls.livekit[0].sort(), [a, b]);
  off.forEach((stop) => stop());
});

test("a slow LiveKit request does not block scoped Matrix refreshes", async (t) => {
  const pending = deferred();
  let name = "Before";
  const { store, calls } = fixture(t, { loadMatrix: async () => matrix({ [a]: [member(undefined, name)] }), loadLivekit: () => pending.promise });
  store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().participantsByRoom[a]);
  name = "After";
  for (let i = 0; i < 30; i++) store.invalidateMatrix([a]);
  await until(() => store.getSnapshot().participantsByRoom[a][0].displayName === "After");
  assert.equal(calls.matrix.length, 2);
  assert.deepEqual(calls.matrix[1], [a]);
  assert.equal(calls.livekit.length, 1);
  pending.resolve(activity());
});

test("polling waits for completion and never overlaps a slow remote request", async (t) => {
  const pending = deferred();
  let reads = 0, active = 0, maximum = 0;
  const { store, calls } = fixture(t, { pollMs: 25, loadLivekit: async () => {
    maximum = Math.max(maximum, ++active);
    const result = ++reads === 1 ? await pending.promise : activity();
    active--; return result;
  } });
  store.watchLivekit([a]); store.start();
  await until(() => calls.livekit.length === 1);
  await tick(60);
  assert.equal(calls.livekit.length, 1);
  pending.resolve(activity());
  await until(() => store.getSnapshot().livekitByRoom[a]);
  await tick(5);
  assert.equal(calls.livekit.length, 1);
  await until(() => calls.livekit.length === 2);
  assert.equal(maximum, 1);
});

test("a Matrix change during a read rejects stale rows and combines one followup", async (t) => {
  const pending = deferred(); let reads = 0;
  const seen = [];
  const { store, calls } = fixture(t, { loadMatrix: () => ++reads === 1 ? pending.promise : matrix({ [a]: [member(undefined, "New")] }) });
  store.subscribe(() => seen.push(store.getSnapshot().participantsByRoom[a]?.[0]?.displayName));
  store.start(); await until(() => calls.matrix.length === 1);
  for (let i = 0; i < 30; i++) store.invalidateMatrix([a]);
  pending.resolve(matrix({ [a]: [member(undefined, "Old")] }));
  await until(() => store.getSnapshot().participantsByRoom[a]?.[0]?.displayName === "New");
  assert.equal(calls.matrix.length, 2);
  assert.ok(!seen.includes("Old"));
});

test("switching visible rooms rejects the previous remote response", async (t) => {
  const pending = deferred(); let reads = 0;
  const { store, calls } = fixture(t, { loadLivekit: () => ++reads === 1 ? pending.promise : activity({ [b]: [live("@bob:server")] }) });
  const stop = store.watchLivekit([a]); store.start();
  await until(() => calls.livekit.length === 1);
  stop(); store.watchLivekit([b]);
  pending.resolve(activity());
  await until(() => store.getSnapshot().livekitByRoom[b]);
  assert.equal(store.getSnapshot().livekitByRoom[a], undefined);
  assert.deepEqual(calls.livekit[1], [b]);
});

test("partial LiveKit failures retain known rows while successful rooms update", async (t) => {
  let response = activity({ [a]: [live()], [b]: [live("@bob:server")] });
  const { store, calls } = fixture(t, { retryMs: 10000, loadLivekit: async () => response });
  store.watchLivekit([a, b]); store.start();
  await until(() => store.getSnapshot().livekitByRoom[a]);
  const previous = store.getSnapshot().livekitByRoom[a];
  response = activity({ [b]: [live("@bob:server", true)] });
  store.invalidateLivekit([a, b]);
  await until(() => store.getSnapshot().livekitByRoom[b][0].isMuted);
  assert.equal(store.getSnapshot().livekitByRoom[a], previous);
  response = activity({ [a]: [] });
  store.invalidateLivekit([a]);
  await until(() => store.getSnapshot().livekitByRoom[a].length === 0);
  assert.equal(calls.livekit.length, 3);
});

test("partial Matrix failures retain membership and a confirmed empty room clears it", async (t) => {
  let response = matrix();
  const { store } = fixture(t, { retryMs: 10000, loadMatrix: async () => response });
  store.start(); await until(() => store.getSnapshot().participantsByRoom[a]);
  const previous = store.getSnapshot().participantsByRoom[a];
  response = matrix({ [b]: [member("@bob:server", "Bob")] });
  store.invalidateMatrix();
  await until(() => store.getSnapshot().participantsByRoom[b]?.length === 1);
  assert.equal(store.getSnapshot().participantsByRoom[a], previous);
  response = matrix({ [a]: [] }); store.invalidateMatrix([a]);
  await until(() => store.getSnapshot().participantsByRoom[a].length === 0);
});

test("membership expiry refreshes only the expiring room without another sync", async (t) => {
  let reads = 0;
  const { store, calls } = fixture(t, { loadMatrix: async () => ++reads === 1 ? matrix(undefined, undefined, { [a]: Date.now() + 30 }) : matrix({ [a]: [] }) });
  store.start(); await until(() => store.getSnapshot().participantsByRoom[a]);
  await until(() => store.getSnapshot().participantsByRoom[a].length === 0);
  assert.equal(calls.matrix.length, 2);
  assert.deepEqual(calls.matrix[1], [a]);
});

test("unchanged local memberships do not cause periodic full scans", async (t) => {
  const { store, calls } = fixture(t);
  store.start(); await until(() => store.getSnapshot().participantsByRoom[a]);
  await tick(40);
  assert.equal(calls.matrix.length, 1);
});

test("missing admin credentials stop remote polling for the session", async (t) => {
  const { store, calls } = fixture(t, { pollMs: 5, loadLivekit: async () => activity({ [a]: [] }, false) });
  store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().livekitByRoom[a]);
  await tick(30);
  store.invalidateLivekit([a]); await tick(10);
  assert.equal(calls.livekit.length, 1);
  store.invalidateMatrix([a]); await until(() => calls.matrix.length === 2);
});

test("the connected call uses live events and polling resumes on disconnect", async (t) => {
  const { store, calls } = fixture(t);
  store.setConnectedRoom(a); store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().participantsByRoom[a]);
  await tick(10); assert.equal(calls.livekit.length, 0);
  store.setConnectedRoom(null);
  await until(() => store.getSnapshot().livekitByRoom[a]);
  assert.equal(calls.livekit.length, 1);
});

test("sorting and row identity are shared and unchanged snapshots do not publish", async (t) => {
  const input = [member("@bob:server", "Bob"), member(), member("@bob:server", "Bob")];
  const { store, calls } = fixture(t, { loadMatrix: async () => matrix({ [a]: structuredClone(input) }) });
  store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().participantsByRoom[a] && store.getSnapshot().livekitByRoom[a]);
  const old = store.getSnapshot();
  assert.deepEqual(old.participantsByRoom[a].map((row) => row.displayName), ["Alice", "Bob"]);
  store.invalidateMatrix([a]); store.invalidateLivekit([a]);
  await until(() => calls.matrix.length === 2 && calls.livekit.length === 2); await tick();
  assert.equal(store.getSnapshot(), old);
});

test("disposing rejects late reads and a development remount can refresh", async (t) => {
  const oldMatrix = deferred(), oldLivekit = deferred();
  let matrixReads = 0, livekitReads = 0;
  const { store, calls } = fixture(t, {
    loadMatrix: () => ++matrixReads === 1 ? oldMatrix.promise : matrix({ [a]: [member(undefined, "Current")] }),
    loadLivekit: () => ++livekitReads === 1 ? oldLivekit.promise : activity({ [a]: [live(undefined, true)] }),
  });
  store.watchLivekit([a]); store.start();
  await until(() => calls.matrix.length === 1 && calls.livekit.length === 1);
  store.dispose(); store.start();
  // Same visible scope should resume on remount, including its interrupted poll.
  const stop = store.watchLivekit([a]);
  oldMatrix.resolve(matrix({ [a]: [member(undefined, "Old")] })); oldLivekit.resolve(activity());
  await until(() => store.getSnapshot().participantsByRoom[a]?.[0]?.displayName === "Current");
  await until(() => store.getSnapshot().livekitByRoom[a]?.[0]?.isMuted);
  stop();
});

test("left rooms are pruned and late remote responses cannot restore them", async (t) => {
  let response = matrix(), pending = null;
  const { store, calls } = fixture(t, { loadMatrix: async () => response, loadLivekit: () => pending ? pending.promise : activity() });
  store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().livekitByRoom[a]);
  pending = deferred(); store.invalidateLivekit([a]);
  await until(() => calls.livekit.length === 2);
  response = matrix({ [b]: [] }, [b]); store.invalidateMatrix();
  await until(() => store.getSnapshot().participantsByRoom[a] === undefined);
  pending.resolve(activity()); await tick(5);
  assert.equal(store.getSnapshot().livekitByRoom[a], undefined);
});

test("a newly discovered voice room during a full read gets its followup", async (t) => {
  const pending = deferred(); let reads = 0;
  const { store, calls } = fixture(t, { loadMatrix: () => ++reads === 1 ? pending.promise : matrix({ [a]: [], [b]: [member("@bob:server", "Bob")] }) });
  store.start(); await until(() => calls.matrix.length === 1);
  store.invalidateMatrix([b]);
  pending.resolve(matrix({ [a]: [] }, [a]));
  await until(() => store.getSnapshot().participantsByRoom[b]?.length === 1);
  assert.deepEqual(calls.matrix[1], [b]);
});

test("an outage retains remote rows and retries before normal polling resumes", async (t) => {
  t.mock.method(console, "warn", () => {});
  let reads = 0;
  const { store, calls } = fixture(t, { loadLivekit: async () => {
    if (++reads === 2) throw new Error("offline");
    return activity({ [a]: [live(undefined, reads > 2)] });
  } });
  store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().livekitByRoom[a]);
  const previous = store.getSnapshot().livekitByRoom[a];
  store.invalidateLivekit([a]);
  await until(() => calls.livekit.length === 2); await tick();
  assert.equal(store.getSnapshot().livekitByRoom[a], previous);
  await until(() => store.getSnapshot().livekitByRoom[a]?.[0]?.isMuted);
  assert.equal(calls.livekit.length, 3);
});

test("a new membership event bypasses full-read failure backoff without losing rows", async (t) => {
  t.mock.method(console, "warn", () => {});
  let failed = false, name = "Before";
  const { store, calls } = fixture(t, { retryMs: 10000, loadMatrix: async () => {
    if (failed) throw new Error("store unavailable");
    return matrix({ [a]: [member(undefined, name)] });
  } });
  store.start(); await until(() => store.getSnapshot().participantsByRoom[a]);
  const previous = store.getSnapshot().participantsByRoom[a];
  failed = true; store.invalidateMatrix();
  await until(() => calls.matrix.length === 2); await tick();
  assert.equal(store.getSnapshot().participantsByRoom[a], previous);
  failed = false; name = "After"; store.invalidateMatrix([a]);
  await until(() => store.getSnapshot().participantsByRoom[a]?.[0]?.displayName === "After");
  assert.equal(calls.matrix.length, 3);
});

test("updating one source preserves the other source's map identity", async (t) => {
  let name = "Before", muted = false;
  const { store } = fixture(t, {
    loadMatrix: async () => matrix({ [a]: [member(undefined, name)] }),
    loadLivekit: async () => activity({ [a]: [live(undefined, muted)] }),
  });
  store.watchLivekit([a]); store.start();
  await until(() => store.getSnapshot().participantsByRoom[a] && store.getSnapshot().livekitByRoom[a]);
  const oldActivity = store.getSnapshot().livekitByRoom;
  name = "After"; store.invalidateMatrix([a]);
  await until(() => store.getSnapshot().participantsByRoom[a][0].displayName === "After");
  assert.equal(store.getSnapshot().livekitByRoom, oldActivity);
  const oldMembers = store.getSnapshot().participantsByRoom;
  muted = true; store.invalidateLivekit([a]);
  await until(() => store.getSnapshot().livekitByRoom[a][0].isMuted);
  assert.equal(store.getSnapshot().participantsByRoom, oldMembers);
});

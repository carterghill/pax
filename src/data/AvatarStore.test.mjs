import assert from "node:assert/strict";
import { test } from "node:test";
import { AvatarStore } from "./AvatarStore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Avatar state did not settle");
    await tick();
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function storeFor(t, load, extra = {}) {
  const store = new AvatarStore({ load, storageKey: "test", debounceMs: 1, retryMs: 1, ...extra });
  t.after(() => store.dispose());
  return store;
}

test("simultaneous consumers share one request and one resolved identity", async (t) => {
  const response = deferred();
  let calls = 0;
  const store = storeFor(t, async () => { calls++; return response.promise; });
  store.subscribe("@alice:server", () => {});
  store.requestFetch(["@alice:server", "@alice:server"]);
  store.requestFetch(["@alice:server"]);
  await until(() => calls === 1);
  store.requestFetch(["@alice:server"]);
  response.resolve({ "@alice:server": "/alice.png" });
  await until(() => store.lookup("@alice:server") === "/alice.png");
  await tick();
  assert.equal(calls, 1);
});

test("transient failures retry without becoming confirmed absence", async (t) => {
  let calls = 0;
  const store = storeFor(t, async () => {
    if (++calls === 1) throw new Error("offline");
    assert.equal(store.lookup("@alice:server"), undefined);
    return { "@alice:server": "/alice.png" };
  });
  store.subscribe("@alice:server", () => {});
  store.requestFetch(["@alice:server"]);
  await until(() => store.lookup("@alice:server") === "/alice.png");
  assert.equal(calls, 2);
});

test("omitted results retry while successful null results remain absent", async (t) => {
  let calls = 0;
  const store = storeFor(t, async () => ++calls === 1
    ? { "@absent:server": null }
    : { "@retry:server": "/retry.png" });
  store.subscribe("@absent:server", () => {});
  store.subscribe("@retry:server", () => {});
  store.requestFetch(["@absent:server", "@retry:server"]);
  await until(() => store.lookup("@retry:server") === "/retry.png");
  assert.equal(store.lookup("@absent:server"), null);
  assert.equal(calls, 2);
});

test("invalidation during a request rejects its stale result and refreshes again", async (t) => {
  const response = deferred();
  let calls = 0;
  const store = storeFor(t, async () => ++calls === 1 ? response.promise : { "@alice:server": "/new.png" });
  store.subscribe("@alice:server", () => {});
  store.requestFetch(["@alice:server"]);
  await until(() => calls === 1);
  store.invalidate("@alice:server");
  response.resolve({ "@alice:server": "/old.png" });
  await until(() => store.lookup("@alice:server") === "/new.png");
  assert.equal(calls, 2);
});

test("late requests cannot overwrite a more recent authoritative avatar", async (t) => {
  const response = deferred();
  let started = false;
  const store = storeFor(t, async () => { started = true; return response.promise; });
  store.requestFetch(["@alice:server"]);
  await until(() => started);
  store.prime("@alice:server", "/new.png");
  response.resolve({ "@alice:server": null });
  await tick();
  assert.equal(store.lookup("@alice:server"), "/new.png");
});

test("disposed sessions reject late results and allow development remounts", async (t) => {
  const response = deferred();
  let calls = 0;
  const store = storeFor(t, async () => ++calls === 1 ? response.promise : { "@alice:server": "/current.png" });
  store.subscribe("@alice:server", () => {});
  store.requestFetch(["@alice:server"]);
  await until(() => calls === 1);
  store.dispose();
  response.resolve({ "@alice:server": "/old-session.png" });
  await tick();
  assert.equal(store.lookup("@alice:server"), undefined);
  store.start();
  await until(() => store.lookup("@alice:server") === "/current.png");
});

test("room identities preserve case and notify only their own subscribers", (t) => {
  const store = storeFor(t, async () => ({}));
  let changed = 0;
  store.subscribe("!Room:server", () => { changed++; });
  store.prime("!room:server", "/lower.png");
  assert.equal(changed, 0);
  store.prime("!Room:server", "/upper.png");
  assert.equal(changed, 1);
  assert.equal(store.lookup("!Room:server"), "/upper.png");
  assert.equal(store.lookup("!room:server"), "/lower.png");
});

test("storage is scoped and runtime absence is not restored as permanent absence", (t) => {
  const storage = new Map([
    ["alice", JSON.stringify({ "@peer:server": "/alice-peer.png", "@absent:server": null })],
    ["bob", JSON.stringify({ "@peer:server": "/bob-peer.png" })],
  ]);
  const options = { storage: { getItem: (key) => storage.get(key) } };
  const alice = storeFor(t, async () => ({}), { ...options, storageKey: "alice" });
  const bob = storeFor(t, async () => ({}), { ...options, storageKey: "bob" });
  assert.equal(alice.lookup("@peer:server"), "/alice-peer.png");
  assert.equal(bob.lookup("@peer:server"), "/bob-peer.png");
  assert.equal(alice.lookup("@absent:server"), undefined);
});

test("refresh retains the current path while validating a restored avatar", async (t) => {
  const response = deferred();
  let started = false;
  const store = storeFor(t, async () => { started = true; return response.promise; });
  store.subscribe("@alice:server", () => {});
  store.prime("@alice:server", "/persisted.png");
  store.refreshVisible();
  await until(() => started);
  assert.equal(store.lookup("@alice:server"), "/persisted.png");
  response.resolve({ "@alice:server": "/updated.png" });
  await until(() => store.lookup("@alice:server") === "/updated.png");
});

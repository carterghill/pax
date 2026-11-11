import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationStore } from "./NotificationStore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settings = { version: 1, globalDefault: null, spaces: {}, rooms: {} };
const unread = { version: 1, global: true, spaces: {}, rooms: {} };
function fixture(overrides = {}, resolve = async () => "all") {
  const calls = { notificationSettings: 0, unreadSettings: 0, effectiveLevels: 0 };
  const values = { notificationSettings: settings, unreadSettings: unread, effectiveLevels: { "!room:server": "all" } };
  const loaders = Object.fromEntries(Object.keys(calls).map((key) => [key, async () => {
    calls[key]++;
    return overrides[key] ? overrides[key]() : values[key];
  }]));
  return { store: new NotificationStore(loaders, resolve), calls };
}

test("multiple subscribers share one initial load after listener setup", async () => {
  const { store, calls } = fixture();
  const off = Array.from({ length: 4 }, () => store.subscribe(() => {}));
  await tick();
  assert.deepEqual(Object.values(calls), [0, 0, 0]);
  store.start();
  await tick();
  assert.deepEqual(Object.values(calls), [1, 1, 1]);
  assert.equal(store.getSnapshot().loading, false);
  off.forEach((fn) => fn());
  store.dispose();
});

test("a saved setting received during initial fetch beats the old response", async () => {
  const initial = deferred();
  const { store } = fixture({ notificationSettings: () => initial.promise });
  store.start();
  await tick();
  const saved = { ...settings, rooms: { "!room:server": "none" } };
  store.replace("notificationSettings", saved);
  initial.resolve(settings);
  await tick();
  assert.deepEqual(store.getSnapshot().notificationSettings, saved);
  store.dispose();
});

test("an invalidation during a fetch produces one followup for a burst", async () => {
  const first = deferred();
  let levels = 0;
  const { store, calls } = fixture({ effectiveLevels: () => ++levels === 1 ? first.promise : { "!room:server": "none" } });
  store.start();
  await tick();
  for (let i = 0; i < 50; i++) store.invalidate("effectiveLevels");
  assert.equal(calls.effectiveLevels, 1);
  first.resolve({ "!room:server": "all" });
  await tick();
  await tick();
  assert.equal(calls.effectiveLevels, 2);
  assert.equal(store.getSnapshot().effectiveLevels["!room:server"], "none");
  assert.equal(calls.notificationSettings, 1);
  store.dispose();
});

test("resolved levels are shared and invalidation bypasses stale values", async () => {
  let resolves = 0;
  const pending = deferred();
  let loads = 0;
  const { store } = fixture({ effectiveLevels: () => ++loads === 1 ? { "!room:server": "all" } : pending.promise }, async () => { resolves++; return "none"; });
  store.start();
  await tick();
  assert.equal(await store.getLevel("!room:server"), "all");
  assert.equal(resolves, 0);
  store.invalidate("effectiveLevels");
  assert.equal(await store.getLevel("!room:server"), "none");
  assert.equal(resolves, 1);
  pending.resolve({ "!room:server": "none" });
  store.dispose();
});

test("failed refresh retains a known mute instead of replacing it with defaults", async () => {
  let fail = false;
  const { store } = fixture({ effectiveLevels: async () => {
    if (fail) throw new Error("offline");
    return { "!room:server": "none" };
  } }, async () => { throw new Error("offline"); });
  store.start();
  await tick();
  fail = true;
  store.invalidate("effectiveLevels");
  await tick();
  assert.equal(await store.getLevel("!room:server"), "none");
  assert.match(store.getSnapshot().error, /offline/);
  store.dispose();
});

test("disposing rejects late resolves and StrictMode restart starts fresh work", async () => {
  const old = deferred();
  const resolve = deferred();
  let loads = 0;
  const { store } = fixture({ effectiveLevels: () => ++loads === 1 ? old.promise : { "!room:server": "none" } }, () => resolve.promise);
  store.start();
  await tick();
  const level = store.getLevel("!room:server");
  store.dispose();
  store.start();
  old.resolve({ "!room:server": "all" });
  resolve.resolve("all");
  await assert.rejects(level, /session ended/);
  await tick();
  assert.equal(store.getSnapshot().effectiveLevels["!room:server"], "none");
  store.dispose();
});

test("a setting change while resolving a message rejects the old decision", async () => {
  const first = deferred();
  let resolves = 0;
  const { store } = fixture({}, async () => ++resolves === 1 ? first.promise : "none");
  store.start();
  await tick();
  store.invalidate("effectiveLevels");
  const decision = store.getLevel("!room:server");
  store.replace("notificationSettings", { ...settings, rooms: { "!room:server": "none" } });
  first.resolve("all");
  assert.equal(await decision, "none");
  assert.equal(resolves, 2);
  store.dispose();
});

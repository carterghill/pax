import assert from "node:assert/strict";
import test from "node:test";
import { timelinePaginationEdge } from "./timelinePagination.ts";

const edge = (scrollTop, range) => timelinePaginationEdge({
  scrollTop, scrollHeight: 800 + range, clientHeight: 800,
});

test("compact call rows never activate both pagination edges", () => {
  // The previous fixed 400px zones overlapped throughout this scroll range.
  assert.equal(edge(0, 240), "older");
  assert.equal(edge(80, 240), "older");
  assert.equal(edge(120, 240), null);
  assert.equal(edge(160, 240), "newer");
  assert.equal(edge(240, 240), "newer");
});

test("a timeline that fits the viewport waits for the history button", () => {
  assert.equal(edge(0, -80), null);
  assert.equal(edge(0, 0), null);
  assert.equal(edge(0, 1), null);
});

test("long timelines keep the 400px threshold and leave the middle alone", () => {
  assert.equal(edge(399, 2000), "older");
  assert.equal(edge(400, 2000), null);
  assert.equal(edge(1000, 2000), null);
  assert.equal(edge(1600, 2000), null);
  assert.equal(edge(1601, 2000), "newer");
});

test("fractional scrolling and overscroll still select the proper edge", () => {
  assert.equal(edge(-8, 200), "older");
  assert.equal(edge(99.5, 200), "older");
  assert.equal(edge(100.5, 200), "newer");
  assert.equal(edge(208, 200), "newer");
});

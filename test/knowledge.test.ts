// The record decides how much the intern trusts you, so the failure that
// matters is it drifting upward on its own - trust that was never earned means
// questions that never get asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { note, level, proven, taught, describe, read, toNext, type Knowledge } from "../src/knowledge.ts";

const empty: Knowledge = { topics: [] };
const solid = (k: Knowledge, topic: string) => note(k, { topic, solid: true, why: "" });

test("a fresh repo starts at new", () => {
  assert.equal(level(empty), "new");
  assert.equal(describe(empty), "");
});

test("proving topics climbs the ladder", () => {
  let k = empty;
  assert.equal(level(k), "new");
  k = solid(k, "leases");
  assert.equal(level(k), "new", "one topic is not yet trust");
  k = solid(k, "idempotency");
  assert.equal(level(k), "trusted");
  for (const t of ["backpressure", "cap theorem", "wal", "quorums"]) k = solid(k, t);
  assert.equal(level(k), "senior");
});

test("topics the intern had to teach do not count as proven", () => {
  let k = empty;
  for (const t of ["a", "b", "c", "d", "e", "f", "g"]) {
    k = note(k, { topic: t, solid: false, why: "taught" });
  }
  assert.equal(level(k), "new", "being taught seven things is not expertise");
  assert.equal(taught(k).length, 7);
  assert.equal(proven(k).length, 0);
});

test("the same topic does not count twice", () => {
  let k = solid(empty, "leases");
  k = solid(k, "Leases");
  k = solid(k, "  leases  ");
  assert.equal(proven(k).length, 1);
  assert.equal(level(k), "new");
});

test("a topic can be downgraded, and the record follows", () => {
  let k = solid(empty, "leases");
  assert.equal(proven(k).length, 1);
  k = note(k, { topic: "leases", solid: false, why: "fumbled it on the follow-up" });
  assert.equal(proven(k).length, 0, "last write wins, or trust only ever ratchets up");
  assert.equal(taught(k).length, 1);
});

test("an empty topic name is ignored", () => {
  assert.deepEqual(note(empty, { topic: "   ", solid: true, why: "" }), empty);
});

test("what the intern is told names the proven topics", () => {
  const k = solid(solid(empty, "visibility timeouts"), "idempotency keys");
  const text = describe(k);
  assert.match(text, /visibility timeouts/);
  assert.match(text, /idempotency keys/);
  assert.match(text, /do NOT ask/i);
});

test("taught and proven are described differently", () => {
  let k = solid(empty, "leases");
  k = note(k, { topic: "quorums", solid: false, why: "taught" });
  const text = describe(k);
  const solidAt = text.indexOf("leases");
  const weakAt = text.indexOf("quorums");
  assert.ok(solidAt >= 0 && weakAt >= 0);
  assert.ok(solidAt < weakAt, "proven topics come first");
  assert.match(text, /fair to check/);
});

test("progress is reportable", () => {
  assert.deepEqual(toNext(empty), { level: "new", have: 0, need: 2 });
  assert.deepEqual(toNext(solid(solid(empty, "a"), "b")), { level: "trusted", have: 2, need: 6 });
});

test("a missing or corrupt file reads as nothing known", () => {
  assert.deepEqual(read("/nope/not/a/dir"), { topics: [] });
});

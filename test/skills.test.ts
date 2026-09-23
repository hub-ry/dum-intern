// The tree decides what the intern stops asking about, so the failure that
// matters is it drifting upward on its own - a skill that was never shown means
// a question that never gets asked, now in every repo instead of one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  note,
  known,
  elsewhere,
  shaky,
  describe,
  read,
  write,
  forget,
  migrate,
  rows,
  summary,
  key,
  similar,
  stale,
  type Tree,
  type Entry,
} from "../src/skills.ts";

const empty: Tree = { skills: [] };
const A = "/code/queue";
const B = "/code/blog";

const e = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  solid: true,
  breadth: "general",
  requires: [],
  why: "",
  ...over,
});

test("an empty tree says nothing to the intern", () => {
  assert.equal(describe(empty, A), "");
  assert.deepEqual(summary(empty, A), { known: 0, shaky: 0 });
});

test("a general skill shown in one repo is known in every repo", () => {
  const t = note(empty, e("idempotency"), A);
  assert.equal(known(t, A).length, 1);
  assert.equal(known(t, B).length, 1, "general knowledge transfers");
  assert.equal(elsewhere(t, B).length, 0);
});

test("a niche skill is known where it was shown and re-checkable elsewhere", () => {
  const t = note(empty, e("stripe webhook signing", { breadth: "niche" }), A);
  assert.equal(known(t, A).length, 1);
  assert.equal(known(t, B).length, 0, "one-off knowledge does not transfer silently");
  assert.equal(elsewhere(t, B).length, 1);
  assert.match(describe(t, B), /ANOTHER PROJECT[\s\S]*stripe webhook signing[\s\S]*\(in queue\)/);
});

test("showing a niche skill again in a second repo makes it known there too", () => {
  let t = note(empty, e("sqlite wal", { breadth: "niche" }), A);
  t = note(t, e("sqlite wal", { breadth: "niche" }), B);
  assert.equal(known(t, A).length, 1);
  assert.equal(known(t, B).length, 1);
});

test("taught skills are shaky, not known", () => {
  let t = empty;
  for (const n of ["a", "b", "c"]) t = note(t, e(n, { solid: false }), A);
  assert.equal(known(t, A).length, 0, "being taught is not the same as holding it");
  assert.equal(shaky(t).length, 3);
  assert.match(describe(t, A), /SHAKY/);
});

test("the same skill does not become two nodes over casing or spacing", () => {
  let t = note(empty, e("leases"), A);
  t = note(t, e("Leases"), A);
  t = note(t, e("  leases  "), A);
  assert.equal(t.skills.length, 1);
  assert.equal(t.skills[0]!.name, "leases", "the first spelling is kept");
});

test("a downgrade sticks, and wipes where it was shown", () => {
  let t = note(empty, e("leases", { breadth: "niche" }), A);
  t = note(t, e("leases", { solid: false, breadth: "niche" }), B);
  assert.equal(known(t, A).length, 0, "last write wins, or the tree only ever ratchets up");
  t = note(t, e("leases", { breadth: "niche" }), B);
  assert.deepEqual(t.skills[0]!.repos, [B], "re-proving starts the repo list over");
});

test("edges accumulate and reuse the tree's spelling", () => {
  let t = note(empty, e("Visibility Timeout"), A);
  t = note(t, e("leases", { requires: ["visibility timeout"] }), A);
  t = note(t, e("leases", { requires: ["heartbeats"] }), A);
  const leases = t.skills.find((s) => s.name === "leases")!;
  assert.deepEqual(leases.requires, ["Visibility Timeout", "heartbeats"]);
});

test("a skill cannot require itself", () => {
  const t = note(empty, e("recursion", { requires: ["Recursion", "base cases"] }), A);
  assert.deepEqual(t.skills[0]!.requires, ["base cases"]);
});

test("an empty name is ignored", () => {
  assert.deepEqual(note(empty, e("   "), A), empty);
});

test("forget takes a skill off the tree", () => {
  const t = note(note(empty, e("leases"), A), e("quorums"), A);
  assert.deepEqual(forget(t, "LEASES").skills.map((s) => s.name), ["quorums"]);
});

test("rows draw prerequisites above what builds on them", () => {
  let t = note(empty, e("hash maps"), A);
  t = note(t, e("lru cache", { requires: ["hash maps", "linked lists"] }), A);
  const r = rows(t).map((x) => [x.depth, x.name, x.state, x.repeat]);
  assert.deepEqual(r, [
    [0, "hash maps", "solid", false],
    [1, "lru cache", "solid", false],
    [0, "linked lists", "ghost", false],
    [1, "lru cache", "solid", true],
  ]);
});

test("a skill only reachable through a cycle still gets drawn", () => {
  let t = note(empty, e("a", { requires: ["b"] }), A);
  t = note(t, e("b", { requires: ["a"] }), A);
  const names = rows(t).map((x) => x.name);
  assert.ok(names.includes("a") && names.includes("b"));
});

test("the tree round-trips through disk", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  const t = note(empty, e("leases", { requires: ["timeouts"] }), A);
  write(t, dir);
  assert.deepEqual(read(dir), t);
});

test("a missing or corrupt file reads as an empty tree", () => {
  assert.deepEqual(read("/nope/not/a/dir"), empty);
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  writeFileSync(`${dir}/skills.json`, "{not json");
  assert.deepEqual(read(dir), empty);
});

test("an old per-repo record folds in without overwriting the tree", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-repo-`);
  mkdirSync(`${root}/.dum`);
  writeFileSync(
    `${root}/.dum/knowledge.json`,
    JSON.stringify({
      topics: [
        { topic: "leases", solid: true, why: "old", at: "2026-09-16T00:00:00Z" },
        { topic: "quorums", solid: false, why: "taught", at: "2026-09-16T00:00:00Z" },
      ],
    }),
  );
  const t = note(empty, e("leases", { solid: false, why: "fumbled since" }), A);
  const m = migrate(t, root);
  assert.equal(m.skills.length, 2);
  assert.equal(m.skills.find((s) => s.name === "leases")!.solid, false, "the tree is newer");
  assert.deepEqual(migrate(m, root), m, "running it again changes nothing");
  assert.ok(readFileSync(`${root}/.dum/knowledge.json`, "utf8"), "the old file is left alone");
});

test("a skill is drawn in full under its real branch, not under a ghost", () => {
  let t = note(empty, e("message queues"), A);
  t = note(t, e("leases", { requires: ["message queues", "heartbeats"] }), A);
  const r = rows(t).map((x) => [x.depth, x.name, x.repeat]);
  assert.deepEqual(r, [
    [0, "message queues", false],
    [1, "leases", false],
    [0, "heartbeats", false],
    [1, "leases", true],
  ]);
});

test("obvious respellings of one skill are one node", () => {
  assert.equal(key("Leases"), key("lease"));
  assert.equal(key("Idempotency-Keys"), key("idempotency keys"));
  assert.equal(key("Rust macros (macro_rules!)"), key("rust macro"));
  assert.equal(key("  Retries   with backoff "), key("retry with backoff"));
  let t = note(empty, e("Leases"), A);
  t = note(t, e("lease"), A);
  assert.equal(t.skills.length, 1);
});

test("identity never merges skills that only differ in a symbol", () => {
  assert.notEqual(key("c"), key("c++"));
  assert.notEqual(key("c"), key("c#"));
  assert.notEqual(key("status"), key("statu"), "status is not a plural");
  assert.equal(key("redis"), "redis");
});

test("a near-duplicate is found, not merged", () => {
  const t = note(empty, e("visibility timeout"), A);
  assert.equal(similar(t, "SQS visibility timeout")?.name, "visibility timeout");
  assert.equal(similar(t, "visibility timeout"), undefined, "the same skill is not a near-duplicate of itself");
  assert.equal(similar(t, "heartbeats"), undefined);
});

test("a skill goes stale after a year if general, two months if niche", () => {
  const day = 86_400_000;
  const now = new Date("2027-06-01T00:00:00Z");
  const at = (days: number) => new Date(now.getTime() - days * day).toISOString();
  const s = (breadth: "general" | "niche", days: number) => ({
    name: "x", solid: true, breadth, requires: [], why: "", repos: [A], at: at(days),
  });
  assert.equal(stale(s("general", 300), now), false);
  assert.equal(stale(s("general", 400), now), true);
  assert.equal(stale(s("niche", 30), now), false);
  assert.equal(stale(s("niche", 90), now), true);
  assert.equal(stale({ ...s("general", 900), solid: false }, now), false, "shaky is its own group");
});

test("a stale skill is described as a while ago, not as known", () => {
  const t: Tree = {
    skills: [{ name: "leases", solid: true, breadth: "general", requires: [], why: "", repos: [A], at: "2020-01-01T00:00:00Z" }],
  };
  const text = describe(t, A);
  assert.match(text, /A WHILE AGO[\s\S]*leases/);
  assert.doesNotMatch(text, /^KNOWN\. /m);
});

test("an unreadable skills.json is kept aside, not overwritten", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  writeFileSync(`${dir}/skills.json`, '{"skills": [ {"name": "leases",, } ]');
  write(note(empty, e("quorums"), A), dir);
  const kept = readdirSync(dir).filter((f) => f.startsWith("skills.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.match(readFileSync(`${dir}/${kept[0]}`, "utf8"), /leases/);
  assert.equal(read(dir).skills[0]!.name, "quorums");
});

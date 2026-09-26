// The tree decides what the intern stops asking about, so the failure that
// matters is it drifting upward on its own - a skill that was never shown means
// a question that never gets asked, now in every repo instead of one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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
  claim,
  find,
  folder,
  remove,
  reset,
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
  assert.deepEqual(summary(empty, A), { known: 0, shaky: 0, claimed: 0 });
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
  // Left for a person to look at, never overwritten or renamed.
  assert.equal(readFileSync(`${dir}/skills.json`, "utf8"), "{not json");
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

test("the old skills.json seeds the notes once, then is left as .migrated", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  const t = note(note(empty, e("timeouts")), e("leases", { requires: ["timeouts"] }), A);
  writeFileSync(`${dir}/skills.json`, JSON.stringify(t));
  assert.deepEqual(read(dir).skills.map((s) => s.name).sort(), ["leases", "timeouts"]);
  assert.ok(existsSync(`${dir}/skills.json.migrated`) && !existsSync(`${dir}/skills.json`));
  assert.ok(existsSync(`${folder(dir)}/leases.md`));
});

test("a note you write by hand, with no frontmatter, is a claimed skill", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  mkdirSync(folder(dir));
  writeFileSync(`${folder(dir)}/rust ownership.md`, "moves and borrows. builds on [[memory safety]]\n");
  const s = read(dir).skills[0]!;
  assert.equal(s.name, "rust ownership");
  assert.ok(s.claimed && s.solid);
  assert.deepEqual(s.requires, ["memory safety"]);
  assert.deepEqual(known(read(dir), A), []);
});

test("recording into a hand-named note updates it rather than growing a second", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  mkdirSync(folder(dir));
  writeFileSync(`${folder(dir)}/My Leases Note.md`, "---\nname: leases\n---\n");
  write(note(read(dir), e("Leases"), A), dir);
  assert.deepEqual(readdirSync(folder(dir)), ["My Leases Note.md"]);
  assert.ok(!read(dir).skills[0]!.claimed);
});

test("a broken note is skipped, not fatal", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  mkdirSync(folder(dir));
  writeFileSync(`${folder(dir)}/bad.md`, "---\nname: [oops\n---\n");
  writeFileSync(`${folder(dir)}/good.md`, "---\nname: good\nstate: solid\n---\n");
  assert.deepEqual(read(dir).skills.map((s) => s.name), ["good"]);
});

test("a claim never overrides what dum saw for itself", () => {
  let t = note(empty, e("leases", { solid: false }), A);
  t = claim(t, { name: "leases", breadth: "general", requires: [], why: "scan" }, A);
  assert.ok(!t.skills[0]!.solid && !t.skills[0]!.claimed);
  t = claim(t, { name: "joins", breadth: "general", requires: [], why: "scan" }, A);
  assert.ok(find(t, "joins")!.claimed);
  assert.deepEqual(known(t, A), []);
  assert.match(describe(t, A), /CLAIMED[\s\S]*joins/);
  // Showing it settles the claim.
  t = note(t, e("joins"), A);
  assert.ok(!find(t, "joins")!.claimed);
  assert.deepEqual(known(t, A).map((s) => s.name), ["joins"]);
});

test("remove takes the note off disk, and reset moves the tree aside", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-skills-`);
  write(note(note(empty, e("a")), e("b"), A), dir);
  assert.ok(remove("A", dir));
  assert.deepEqual(read(dir).skills.map((s) => s.name), ["b"]);
  const aside = reset(dir)!;
  assert.ok(existsSync(`${aside}/b.md`));
  assert.deepEqual(read(dir), empty);
});

test("a skill about one language only counts in that language", async () => {
  const { holdsIn, langName, langOf } = await import("../src/skills.ts");
  let t = note(empty, e("for loops", { lang: "Python" }), A);
  t = note(t, e("recursion"), A);
  assert.equal(find(t, "for loops")!.lang, "python");
  assert.ok(holdsIn(t, "for loops", "a.py", A));
  assert.ok(!holdsIn(t, "for loops", "main.cpp", A), "python's for loops don't write c++'s");
  assert.ok(!holdsIn(t, "recursion", "main.cpp", A), "nothing shown in c++ yet: every line is theirs");
  t = note(t, e("c++ includes", { lang: "cpp" }), A);
  assert.ok(holdsIn(t, "recursion", "main.cpp", A), "once they've shown some c++, ideas carry across");
  assert.ok(holdsIn(t, "for loops", "notes.md", A), "not source: no language to disagree with");
  assert.equal(langName("cpp"), "c++");
  assert.equal(langOf("src/x.hpp"), "c++");
  assert.equal(langOf("Makefile"), "");
  assert.match(describe(t, A), /for loops  \(python only\)/);
  // A later note without a language keeps the one it had.
  t = note(t, e("for loops"), A);
  assert.equal(find(t, "for loops")!.lang, "python");
});

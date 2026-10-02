// The gate the whole thing rests on: a course opens only above what you already have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { languages, track, parseTrack, status, frontier, progress, map, mapped, prereqs, canonical, view } from "../src/curriculum.ts";
import { unlock, key, type Tree } from "../src/skills.ts";

process.env.DUM_HOME = mkdtempSync(`${tmpdir()}/dum-curriculum-`);

const empty: Tree = { skills: [] };
const has = (lang: string, ...names: string[]) => names.reduce((t, name) => unlock(t, { name, lang, how: "added", why: "" }), empty);

test("every curated track parses, starts at printing, and only builds on skills above it", () => {
  assert.ok(languages().length >= 8);
  for (const lang of languages()) {
    const t = track(lang);
    assert.ok(t, lang);
    assert.equal(t.lang, lang);
    assert.equal(t.skills[0]!.name, "printing", `${lang} starts at printing`);
    const seen = new Set<string>();
    for (const n of t.skills) {
      assert.ok(!seen.has(key(n.name)), `${lang}: ${n.name} twice`);
      for (const r of n.requires) assert.ok(seen.has(key(r)), `${lang}: ${n.name} needs ${r}, which isn't listed above it`);
      seen.add(key(n.name));
    }
  }
});

test("every curated skill is reachable from an empty tree, one course at a time", () => {
  for (const lang of languages()) {
    let t = empty;
    for (let i = 0; i < 100; i++) {
      const open = frontier(t, lang);
      if (!open.length) break;
      t = unlock(t, { name: open[0]!, lang, how: "course", why: "" });
    }
    const p = progress(t, lang)!;
    assert.equal(p.done, p.total, `${lang}: stuck at ${p.done}/${p.total}`);
  }
});

test("someone who can't print hello world can't take recursion, and is pointed at printing", () => {
  const st = status(empty, "recursion", "python");
  assert.equal(st.state, "locked");
  assert.ok(st.state === "locked" && st.next === "printing");
  assert.deepEqual(frontier(empty, "python"), ["printing"]);
});

test("the next rung is the lowest open one under what's missing", () => {
  const t = has("python", "printing", "variables", "conditionals");
  const st = status(t, "recursion", "python");
  assert.ok(st.state === "locked");
  assert.deepEqual(st.missing, ["return values"]);
  assert.equal(st.next, "functions");
  assert.equal(status(has("python", "printing", "variables", "conditionals", "functions", "return values"), "recursion", "python").state, "open");
  assert.equal(status(has("python", "printing"), "printing", "python").state, "unlocked");
});

test("a track's spelling wins, and an off-track skill keeps what the model mapped for it", () => {
  assert.equal(canonical("Range-Based For", "cpp"), "range-based for");
  assert.equal(canonical("websockets", "python"), "websockets");
  assert.deepEqual(prereqs("websockets", "python"), []);
  map("websockets", "python", ["Functions", "websockets", "async await", "classes", "files"]);
  assert.deepEqual(mapped("websockets", "python"), ["functions", "async await", "classes"]);
  map("websockets", "python", ["printing"]);
  assert.deepEqual(prereqs("websockets", "python"), ["functions", "async await", "classes"], "the first mapping sticks");
  map("recursion", "python", ["printing"]);
  assert.deepEqual(prereqs("recursion", "python"), ["return values", "conditionals"], "never over a curated skill");
  const st = status(has("python", "printing"), "websockets", "python");
  assert.ok(st.state === "locked" && st.next === "variables");
});

test("a language with no track only knows what was mapped", () => {
  assert.equal(track("cobol"), null);
  assert.equal(status(empty, "printing", "cobol").state, "open");
});

test("a broken track is no track", () => {
  assert.equal(parseTrack("lang: [nope"), null);
  assert.equal(parseTrack("skills: []"), null);
  assert.deepEqual(parseTrack("lang: Py\nskills:\n  - a\n  - b: [a]\n  - 7"), { lang: "python", skills: [{ name: "a", requires: [] }, { name: "b", requires: ["a"] }] });
});

test("the tree view marks unlocked, open and locked, and lists off-track unlocks", () => {
  const t = unlock(has("go", "printing"), { name: "cobra cli", lang: "go", how: "explained", why: "" });
  const lines = view(t, ["go"]);
  assert.match(lines[0]!, /^go  1\/\d+$/);
  assert.ok(lines.includes("  ● printing"));
  assert.ok(lines.includes("  ○ variables  course open"));
  assert.ok(lines.includes("  · goroutines  needs functions"));
  assert.ok(lines.includes("  ● cobra cli"));
});

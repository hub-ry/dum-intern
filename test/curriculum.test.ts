// The gate the whole thing rests on: a course opens only above what you already have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { languages, tracks, parseTrack, status, frontier, progress, map, mapped, prereqs, canonical, curated, locate, view, bar } from "../src/curriculum.ts";
import { unlock, key, type Tree, type Level } from "../src/skills.ts";

process.env.DUM_HOME = mkdtempSync(`${tmpdir()}/dum-curriculum-`);

const empty: Tree = { skills: [] };
const has = (lang: string, names: string[], level: Level = "build") =>
  names.reduce((t, name) => unlock(t, { name, lang, how: "added", level, why: "" }), empty);
const trackOf = (name: string, lang: string) => tracks().find((t) => t.name === name && t.lang === lang)!;

test("every track parses, and only builds on skills above it or on its language's basics", () => {
  assert.ok(languages().length >= 8);
  for (const tr of tracks()) {
    const seen = new Set(tr.name === "basics" ? [] : tracks().filter((o) => o.lang === tr.lang && o.name === "basics").flatMap((o) => o.skills.map((n) => key(n.name))));
    if (tr.name === "basics") assert.equal(tr.skills[0]!.name, "printing", `${tr.lang} basics starts at printing`);
    for (const n of tr.skills) {
      assert.ok(!seen.has(key(n.name)) || tr.name === "basics", `${tr.lang} ${tr.name}: ${n.name} twice`);
      for (const r of n.requires) {
        // A builder skill may build on any language's fundamentals, like functions.
        const ok = seen.has(key(r)) || (tr.lang === "" && tracks().some((o) => o.name === "basics" && o.skills.some((x) => key(x.name) === key(r))));
        assert.ok(ok, `${tr.lang || "builder"} ${tr.name}: ${n.name} needs ${r}, which isn't listed above it`);
      }
      seen.add(key(n.name));
    }
  }
});

test("every curated skill is reachable from an empty tree, one course at a time", () => {
  for (const lang of [...languages(), ""]) {
    let t = lang ? empty : has("python", ["functions"]);
    for (let i = 0; i < 200; i++) {
      const open = tracks().filter((tr) => tr.lang === lang).flatMap((tr) => frontier(t, tr));
      if (!open.length) break;
      t = unlock(t, { name: open[0]!, lang, how: "course", why: "" });
    }
    for (const tr of tracks().filter((x) => x.lang === lang)) {
      const p = progress(t, tr);
      assert.equal(p.done, p.total, `${lang || "builder"} ${tr.name}: stuck at ${p.done}/${p.total}`);
    }
  }
});

test("someone who can't print hello world can't take recursion, and is pointed at printing", () => {
  const st = status(empty, "recursion", "python");
  assert.ok(st.state === "locked" && st.next === "printing");
  assert.deepEqual(frontier(empty, trackOf("basics", "python")), ["printing"]);
});

test("the next rung is the lowest open one under what's missing", () => {
  const st = status(has("python", ["printing", "variables", "conditionals"]), "recursion", "python");
  assert.ok(st.state === "locked");
  assert.deepEqual(st.missing, ["return values"]);
  assert.equal(st.next, "functions");
  assert.equal(status(has("python", ["printing", "variables", "conditionals", "functions", "return values"]), "recursion", "python").state, "open");
  assert.equal(status(has("python", ["printing"]), "printing", "python").state, "unlocked");
});

test("a level is asked for: recognizing a skill isn't building it, and prerequisites follow suit", () => {
  const t = has("python", ["printing", "variables", "lists"], "recognize");
  assert.equal(status(t, "lists", "python", "recognize").state, "unlocked");
  assert.equal(status(t, "lists", "python", "build").state, "locked", "the build needs its prerequisites built too");
  assert.equal(status(t, "for loops", "python", "recognize").state, "open");
  assert.equal(status(has("python", ["printing"], "apply"), "printing", "python", "build").state, "unlocked", "apply is above build");
});

test("the interview track sits on c++ basics, and the builder track on any language", () => {
  assert.ok(curated("two pointers", "c++"));
  const st = status(has("c++", ["printing", "variables", "conditionals", "for loops"]), "two pointers", "c++");
  assert.ok(st.state === "locked" && st.next === "vectors", "two pointers starts lower, in the basics");
  assert.deepEqual(locate("HTTP", "python"), { lang: "", exercise: "python" });
  assert.deepEqual(locate("git", "python"), { lang: "", exercise: "shell" });
  assert.deepEqual(locate("recursion", "python"), { lang: "python", exercise: "python" });
  assert.equal(status(has("rust", ["functions"]), "command-line programs", "").state, "open", "rust functions count for a builder skill");
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
  const st = status(has("python", ["printing"]), "websockets", "python");
  assert.ok(st.state === "locked" && st.next === "variables");
});

test("a language with no track only knows what was mapped", () => {
  assert.ok(!languages().includes("cobol"));
  assert.equal(status(empty, "printing", "cobol").state, "open");
});

test("a broken track is no track, and the long form carries a course language", () => {
  assert.equal(parseTrack("lang: [nope"), null);
  assert.equal(parseTrack("skills: []"), null);
  assert.deepEqual(parseTrack("lang: Py\nskills:\n  - a\n  - b: [a]\n  - c: { requires: [b], in: sh }\n  - 7", "f"), {
    name: "python",
    lang: "python",
    skills: [{ name: "a", requires: [] }, { name: "b", requires: ["a"] }, { name: "c", requires: ["b"], in: "shell" }],
  });
});

test("the view draws each track as a bar, and marks built, recognized, open and locked", () => {
  let t = has("go", ["printing"]);
  t = unlock(t, { name: "variables", lang: "go", how: "explained", why: "" });
  t = unlock(t, { name: "cobra", lang: "go", how: "explained", why: "" });
  const lines = view(t, ["go"]);
  assert.match(lines.find((l) => l.startsWith("go · basics"))!, /^go · basics  █░+  1\/\d+$/);
  assert.ok(lines.includes("  ● printing"));
  assert.ok(lines.includes("  ◐ variables  recognized"));
  assert.ok(lines.some((l) => l.startsWith("  · ") && l.includes("needs")));
  assert.ok(lines.some((l) => /^  · \d+ more locked$/.test(l)), "a long track doesn't list every locked skill");
  assert.ok(lines.some((l) => l.startsWith("builder  ")), "the builder track always shows");
  assert.ok(lines.includes("go · off the tracks") && lines.includes("  ◐ cobra  recognized"));
  assert.equal(bar(1, 4, 8), "██░░░░░░");
});

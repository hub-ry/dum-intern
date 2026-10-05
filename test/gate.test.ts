// The learning gate in code: what AI may change, decided against the tree at the moment it asks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { needFor, classify, aiWrites, mayChange, nextStep, normalPath } from "../src/gate.ts";
import { unlock, id, type Tree, type Level } from "../src/skills.ts";

process.env.DUM_HOME = mkdtempSync(`${tmpdir()}/dum-gate-`);

const empty: Tree = { skills: [] };
const has = (names: string[], level: Level = "build", lang = "python", t = empty) =>
  names.reduce((tree, name) => unlock(tree, { name, lang, how: "added", level, why: "" }), t);
const basics = has(["printing", "variables", "functions", "conditionals", "return values"]);

test("a concept needs building and a tool recognizing, in both modes", () => {
  for (const mode of ["understand", "anti-vibe"] as const) {
    assert.equal(needFor("concept", mode), "build");
    assert.equal(needFor("tool", mode), "recognize");
  }
});

test("pieces are spelled the tracks' way, a curated skill is always a concept, and only one core counts", () => {
  const pieces = classify(basics, [
    { skill: "Recursion", lang: "py", what: "walk  the tree", kind: "tool", core: true, paths: ["./src/walk.py", "../etc/passwd", "/abs/x.py"] },
    { skill: "recursion", lang: "python", what: "duplicate" },
    { skill: "argparse", lang: "python", what: "flags", kind: "tool", core: true },
  ]);
  assert.equal(pieces.length, 2, "the same skill twice is one piece");
  const [walk, flags] = pieces;
  assert.equal(walk!.skill, "recursion");
  assert.equal(walk!.kind, "concept", "the intern can't call a track skill a tool to lower its bar");
  assert.equal(walk!.what, "walk the tree");
  assert.deepEqual(walk!.paths, ["src/walk.py"], "paths outside the project are dropped");
  assert.deepEqual(walk!.requires, ["return values", "conditionals"]);
  assert.equal(walk!.core, true);
  assert.equal(flags!.core, false, "only the first core counts");
  assert.equal(flags!.kind, "tool");
  assert.equal(flags!.need, "recognize");
});

test("classifying an off-track skill uses the named prerequisites without writing them down", () => {
  const [ws] = classify(has(["printing"]), [{ skill: "websockets", lang: "python", what: "live updates", requires: ["functions", "websockets"] }]);
  assert.deepEqual(ws!.requires, ["functions"]);
  assert.equal(ws!.status.state, "locked");
  assert.ok(!existsSync(`${process.env.DUM_HOME}/prereqs.json`), "the gate never writes");
});

test("the core is never AI's, even when every skill is built, in either mode", () => {
  const t = has(["recursion"], "build", "python", basics);
  const [core, other] = classify(t, [
    { skill: "recursion", lang: "python", what: "the walk", core: true },
    { skill: "functions", lang: "python", what: "helpers" },
  ]);
  for (const mode of ["understand", "anti-vibe"] as const) {
    assert.equal(aiWrites(core!, mode), false);
    assert.equal(aiWrites(other!, mode), true);
  }
});

test("anti-vibe coaching doesn't let recognition stand in for implementation", () => {
  const t = has(["lists"], "recognize", "python", has(["printing", "variables"]));
  const [lists] = classify(t, [{ skill: "lists", lang: "python", what: "keep items" }], "anti-vibe");
  assert.equal(lists!.need, "build");
  assert.equal(aiWrites(lists!, "anti-vibe"), false);
});


test("mayChange: only listed paths, for approved non-core pieces held today", () => {
  const t = has(["recursion"], "build", "python", basics);
  const pieces = classify(t, [
    { skill: "recursion", lang: "python", what: "walk", paths: ["src/walk.py"] },
    { skill: "functions", lang: "python", what: "the heart", core: true, paths: ["src/core.py"] },
  ]);
  assert.deepEqual(mayChange(t, "understand", pieces, "./src/walk.py", ["Recursion"]).ok, true);
  assert.match(mayChange(t, "understand", pieces, "src/core.py", ["recursion"]).why, /core/);
  assert.match(mayChange(t, "understand", pieces, "src/walk.py", ["functions"]).why, /core/);
  assert.match(mayChange(t, "understand", pieces, "src/other.py", ["recursion"]).why, /isn't a file the approved plan lists/);
  assert.match(mayChange(t, "understand", pieces, "src/walk.py", ["sorting with keys"]).why, /isn't a piece of the approved plan/);
  assert.equal(mayChange(t, "understand", pieces, "src/walk.py", []).ok, false);
  assert.match(mayChange(t, "understand", pieces, "../outside.py", ["recursion"]).why, /outside the project/);
  assert.equal(mayChange(t, "understand", [], "src/walk.py", ["recursion"]).ok, false);
});

test("mayChange rechecks today's tree: a lost prerequisite or a 'not yet' locks what was approved", () => {
  const t = has(["recursion"], "build", "python", basics);
  const pieces = classify(t, [{ skill: "recursion", lang: "python", what: "walk", paths: ["walk.py"] }]);
  assert.equal(mayChange(t, "understand", pieces, "walk.py", ["recursion"]).ok, true);
  const lost: Tree = { skills: t.skills.filter((s) => s.name !== "return values") };
  const r = mayChange(lost, "understand", pieces, "walk.py", ["recursion"]);
  assert.equal(r.ok, false, "a built child doesn't outlive its prerequisite");
  assert.match(r.why, /builds on return values/);
  assert.equal(mayChange(t, "understand", pieces, "walk.py", ["recursion"], new Set([id("recursion", "python")])).ok, false);
});

test("mayChange judges a file in its own language", () => {
  const t = has(["recursion"], "build", "python", basics);
  const pieces = classify(t, [{ skill: "recursion", lang: "python", what: "walk", paths: ["walk.rs", "walk.py"] }]);
  assert.equal(mayChange(t, "understand", pieces, "walk.py", ["recursion"]).ok, true);
  assert.equal(mayChange(t, "understand", pieces, "walk.rs", ["recursion"]).ok, false, "python recursion doesn't write rust");
});

test("mayChange keeps a shared file shut while any piece the plan puts there is locked, named or not", () => {
  const raw = [
    { skill: "printing", lang: "python", what: "output", paths: ["support.py"] },
    { skill: "recursion", lang: "python", what: "walk", paths: ["support.py"] },
    { skill: "functions", lang: "python", what: "the heart", core: true, paths: ["main.py"] },
  ];
  const r = mayChange(basics, "understand", classify(basics, raw), "support.py", ["printing"]);
  assert.equal(r.ok, false, "leaving the locked piece out of the change doesn't open its file");
  assert.match(r.why, /recursion/);
  const t = has(["recursion"], "build", "python", basics);
  assert.equal(mayChange(t, "understand", classify(t, raw), "support.py", ["printing"]).ok, true);
  assert.equal(mayChange(t, "understand", classify(t, raw), "support.py", ["printing"], new Set([id("recursion", "python")])).ok, false);
});

test("next steps skip the core and start at the lowest open rung", () => {
  assert.equal(nextStep(has(["printing"]), { skill: "recursion", lang: "python" }), "variables");
  assert.equal(nextStep(basics, { skill: "recursion", path: "a.py" }), "recursion");
  assert.equal(nextStep(basics, { skill: "recursion", lang: "python", core: true }), "");
});

test("paths are repo-relative or nothing", () => {
  assert.equal(normalPath("./a//b/../c.py"), "a/c.py");
  assert.equal(normalPath("~/x"), "");
  assert.equal(normalPath("C:\\x"), "");
  assert.equal(normalPath(".."), "");
});

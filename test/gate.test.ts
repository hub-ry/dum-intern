// The learning gate in code: what AI may change, decided against the tree at the moment it asks,
// for an exact shared resource in that file's own language.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { needFor, classify, aiWrites, mayChange, nextStep, normalPath } from "../src/gate.ts";
import { unlock, id, type Tree, type Level } from "../src/skills.ts";

process.env.DUM_HOME = mkdtempSync(`${tmpdir()}/dum-gate-`);
process.env.DUM_CONTEXT = "off";

const empty: Tree = { skills: [] };
const has = (names: string[], level: Level = "build", lang = "python", t = empty) =>
  names.reduce((tree, name) => unlock(tree, { name, lang, how: "added", level, why: "" }), t);
const basics = has(["printing", "variables", "functions", "conditionals", "return values"]);
const share = randomUUID();
const other = randomUUID();
const R = (rel: string, grant = share) => `${grant}/${rel}`;

test("a concept needs building and a tool recognizing, in both modes", () => {
  for (const mode of ["understand", "anti-vibe"] as const) {
    assert.equal(needFor("concept", mode), "build");
    assert.equal(needFor("tool", mode), "recognize");
  }
});

test("pieces are spelled the tracks' way, a curated skill is always a concept, and paths must be shared resources", () => {
  const pieces = classify(basics, [
    { skill: "Recursion", lang: "py", what: "walk  the tree", kind: "tool", core: true, paths: [R("src/walk.py"), "src/walk.py", "../etc/passwd", "/abs/x.py", R("../x.py")] },
    { skill: "recursion", lang: "python", what: "duplicate" },
    { skill: "argparse", lang: "python", what: "flags", kind: "tool", core: true },
  ]);
  assert.equal(pieces.length, 2, "the same skill twice is one piece");
  const [walk, flags] = pieces;
  assert.equal(walk!.skill, "recursion");
  assert.equal(walk!.kind, "concept", "the intern can't call a track skill a tool to lower its bar");
  assert.equal(walk!.what, "walk the tree");
  assert.deepEqual(walk!.paths, [R("src/walk.py")], "anything but a shared resource name is dropped");
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

test("anti-vibe coaching doesn't let recognition stand in for implementation", () => {
  const t = has(["lists"], "recognize", "python", has(["printing", "variables"]));
  const [lists] = classify(t, [{ skill: "lists", lang: "python", what: "keep items" }], "anti-vibe");
  assert.equal(lists!.need, "build");
  assert.equal(aiWrites(lists!, "anti-vibe"), false);
});

test("a recognized tool may be used; the same tool unrecognized may not", () => {
  const known = has(["fastapi"], "recognize", "python", basics);
  const pieces = (t: Tree) => classify(t, [{ skill: "fastapi", lang: "python", what: "the api", kind: "tool", paths: [R("api.py")] }]);
  assert.equal(mayChange(known, "understand", pieces(known), R("api.py"), ["fastapi"]).ok, true);
  assert.match(mayChange(basics, "understand", pieces(basics), R("api.py"), ["fastapi"]).why, /say what it's for/);
});

test("mayChange matches the exact resource: another grant or a respelled path is another file", () => {
  const t = has(["recursion"], "build", "python", basics);
  const pieces = classify(t, [{ skill: "recursion", lang: "python", what: "walk", paths: [R("src/walk.py")] }]);
  assert.equal(mayChange(t, "understand", pieces, R("src/walk.py"), ["Recursion"]).ok, true);
  assert.match(mayChange(t, "understand", pieces, R("src/walk.py", other), ["recursion"]).why, /isn't a file listed/);
  assert.match(mayChange(t, "understand", pieces, R("src/other.py"), ["recursion"]).why, /isn't a file listed/);
  assert.match(mayChange(t, "understand", pieces, R("./src/walk.py"), ["recursion"]).why, /isn't a shared file/);
  assert.match(mayChange(t, "understand", pieces, "src/walk.py", ["recursion"]).why, /isn't a shared file/);
  assert.match(mayChange(t, "understand", pieces, R("src/walk.py"), ["sorting with keys"]).why, /isn't one of the skills/);
  assert.match(mayChange(t, "understand", pieces, R("src/walk.py"), []).why, /name the skills/);
  assert.match(mayChange(t, "understand", [], R("src/walk.py"), ["recursion"]).why, /name the skills/);
});

test("mayChange rechecks today's tree and holds: a lost prerequisite or a 'not yet' locks it", () => {
  const t = has(["recursion"], "build", "python", basics);
  const pieces = classify(t, [{ skill: "recursion", lang: "python", what: "walk", paths: [R("walk.py")] }]);
  for (const mode of ["understand", "anti-vibe"] as const) assert.equal(mayChange(t, mode, pieces, R("walk.py"), ["recursion"]).ok, true);
  const lost: Tree = { skills: t.skills.filter((s) => s.name !== "return values") };
  const r = mayChange(lost, "understand", pieces, R("walk.py"), ["recursion"]);
  assert.equal(r.ok, false, "a built child doesn't outlive its prerequisite");
  assert.match(r.why, /builds on return values/);
  assert.equal(mayChange(t, "understand", pieces, R("walk.py"), ["recursion"], new Set([id("recursion", "python")])).ok, false);
  assert.equal(mayChange(t, "understand", pieces, R("walk.py"), ["recursion"], new Set([id("return values", "python")])).ok, false);
});

test("mayChange judges a shared file in its own language", () => {
  const t = has(["recursion"], "build", "python", basics);
  const pieces = classify(t, [{ skill: "recursion", lang: "python", what: "walk", paths: [R("walk.rs"), R("walk.py")] }]);
  assert.equal(mayChange(t, "understand", pieces, R("walk.py"), ["recursion"]).ok, true);
  assert.equal(mayChange(t, "understand", pieces, R("walk.rs"), ["recursion"]).ok, false, "python recursion doesn't write rust");
});

test("mayChange keeps a file shut while any piece placed there is locked, named or not", () => {
  const raw = [
    { skill: "printing", lang: "python", what: "output", paths: [R("support.py")] },
    { skill: "recursion", lang: "python", what: "walk", paths: [R("support.py")] },
    { skill: "functions", lang: "python", what: "helpers", paths: [R("main.py")] },
  ];
  const r = mayChange(basics, "understand", classify(basics, raw), R("support.py"), ["printing"]);
  assert.equal(r.ok, false, "leaving the locked piece out of the change doesn't open its file");
  assert.match(r.why, /recursion/);
  const t = has(["recursion"], "build", "python", basics);
  assert.equal(mayChange(t, "understand", classify(t, raw), R("support.py"), ["printing"]).ok, true);
  assert.equal(mayChange(t, "understand", classify(t, raw), R("support.py"), ["printing"], new Set([id("recursion", "python")])).ok, false);
});

test("next steps start at the lowest open rung, judged in a shared file's language", () => {
  assert.equal(nextStep(has(["printing"]), { skill: "recursion", lang: "python" }), "variables");
  assert.equal(nextStep(basics, { skill: "recursion", path: R("a.py") }), "recursion");
});

test("paths are shared resource names, exactly, or nothing", () => {
  assert.equal(normalPath(`  ${R("a/c.py")} `), R("a/c.py"));
  for (const bad of ["a/c.py", "./a.py", "~/x", "C:\\x", "..", R("a/../c.py"), R("a//c.py"), `${share}/`, "/etc/passwd"]) {
    assert.equal(normalPath(bad), "", bad);
  }
});

// The boundary is the tree as it stands today plus what's shared now: no manifests, no scanning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { boundary, lines, type Boundary } from "../src/boundary.ts";
import { unlock, id, type Tree } from "../src/skills.ts";
import type { ShareGrant } from "../src/share-types.ts";

process.env.DUM_HOME = mkdtempSync(`${tmpdir()}/dum-boundary-`);
process.env.DUM_CONTEXT = "off";

function tree(): Tree {
  let t: Tree = { skills: [] };
  for (const name of ["printing", "variables", "functions"]) t = unlock(t, { name, lang: "python", how: "typed", why: "" });
  return unlock(t, { name: "fastapi", lang: "python", how: "explained", why: "web framework for the api" });
}

const level = (b: Boundary, name: string) => b.skills.find((s) => s.skill.name === name)!;

test("each skill's standing today: built is written, recognized is used as a tool", () => {
  const b = boundary(tree(), [], new Set());
  assert.deepEqual(level(b, "functions"), { skill: { name: "functions", lang: "python" }, level: "build", recognize: true, build: true, held: false });
  assert.deepEqual(level(b, "fastapi"), { skill: { name: "fastapi", lang: "python" }, level: "recognize", recognize: true, build: false, held: false });
  const out = lines(b);
  const tools = out.indexOf("Dum may use as a tool (you recognize it; as a concept you still build it)");
  assert.ok(out.indexOf("Dum may write (you built it)") < out.indexOf("  functions (python)"));
  assert.equal(out[tools + 1], "  fastapi (python)");
  assert.ok(out.some((l) => /^nothing shared/.test(l)));
});

test("a 'not yet' or a lost prerequisite closes skills without touching their notes", () => {
  let t: Tree = { skills: [] };
  for (const name of ["printing", "variables", "for loops", "list comprehensions"]) t = unlock(t, { name, lang: "python", how: "typed", why: "historical build" });
  const before = structuredClone(t);
  const locked = boundary(t, [], new Set());
  assert.equal(level(locked, "for loops").build, false, "for loops builds on lists, which isn't held");
  assert.equal(level(locked, "list comprehensions").build, false);
  assert.equal(level(locked, "variables").build, true);
  assert.deepEqual(t, before);
  const held = boundary(t, [], new Set([id("variables", "python")]));
  assert.deepEqual([level(held, "variables").build, level(held, "variables").held], [false, true]);
  assert.ok(lines(held).includes("  variables (python) - you said not yet"));
  t = unlock(t, { name: "lists", lang: "python", how: "typed", why: "prerequisite restored" });
  const restored = boundary(t, [], new Set());
  assert.equal(level(restored, "for loops").build, true);
  assert.equal(level(restored, "list comprehensions").build, true);
});

test("current grants are listed with their scope and size; an empty tree writes nothing", () => {
  const shares: ShareGrant[] = [
    { id: randomUUID(), kind: "file", scope: "request", label: "notes.md", files: ["x/notes.md"] },
    { id: randomUUID(), kind: "folder", scope: "zone", label: "project", files: ["y/a.py", "y/b.py"] },
  ];
  const b = boundary({ skills: [] }, shares, new Set());
  assert.deepEqual(b.shares, shares);
  const out = lines(b);
  assert.match(out[0]!, /tree is empty - Dum writes nothing/);
  assert.ok(out.includes("  notes.md  shared with this request · 1 file"));
  assert.ok(out.includes("  project/  followed in this zone · 2 files"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { built, context, defaultTarget, load, nextUp, prepare, save, type Rebuild } from "../src/rebuild.ts";

const r: Rebuild = {
  source: "/code/hysa",
  goal: "rebuild hysa",
  milestones: [
    { request: "a CLI that prints its flags", done: false },
    { request: "compound one month", done: false },
  ],
};

test("milestones tick off in order, only for the request that was one", () => {
  assert.deepEqual(nextUp(r), { index: 0, request: "a CLI that prints its flags" });
  assert.equal(built(r, "something else"), r);
  const one = built(r, "a CLI that prints its flags");
  assert.deepEqual(nextUp(one), { index: 1, request: "compound one month" });
  assert.equal(nextUp(built(one, "compound one month")), null);
});

test("the intern hears it's a rebuild, and that the original is out of reach", () => {
  const text = context(built(r, "a CLI that prints its flags"));
  assert.match(text, /rebuilding hysa from scratch/);
  assert.match(text, /can't read it/);
  assert.match(text, /1\. a CLI that prints its flags \(built\)/);
  assert.match(text, /Next up: 2\./);
  assert.equal(context(null), "");
});

test("round-trips through .dum/rebuild.json", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-rb-`);
  assert.equal(load(root), null);
  save(root, r);
  assert.deepEqual(load(root), r);
});

test("the target is a fresh git repo beside the original, never one with files", () => {
  assert.equal(defaultTarget("/code/hysa"), "/code/hysa-rebuild");
  const base = mkdtempSync(`${tmpdir()}/dum-rb-`);
  assert.equal(prepare(`${base}/new`), null);
  assert.ok(existsSync(`${base}/new/.git`));
  mkdirSync(`${base}/full`);
  writeFileSync(`${base}/full/main.py`, "x");
  assert.match(prepare(`${base}/full`)!, /already has files/);
});

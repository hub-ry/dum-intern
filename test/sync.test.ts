import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as skills from "../src/skills.ts";
import { apply, local, merge, same, type Snapshot } from "../src/sync.ts";

const skill = (at: string): skills.Skill => ({ name: "printing", lang: "python", how: "typed", level: "build", requires: [], why: "wrote it", at });

test("pulling a removal preserves its time, so a later re-add survives another sync", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-sync-`);
  skills.write({ skills: [skill("2026-01-01T00:00:00.000Z")] }, dir);
  const gone: Snapshot = { skills: [], removed: { [skills.id("printing", "python")]: "2026-01-02T00:00:00.000Z" } };
  apply(gone, dir);
  assert.deepEqual(local(dir), gone);
  const readded: Snapshot = { skills: [skill("2026-01-03T00:00:00.000Z")], removed: {} };
  apply(merge(local(dir), readded), dir);
  assert.deepEqual(local(dir), readded);
  assert.ok(same(merge(local(dir), gone), readded));
});

test("sync compares and applies evidence and prerequisites, not just time and level", () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-sync-`);
  const a: Snapshot = { skills: [skill("2026-01-01T00:00:00.000Z")], removed: {} };
  const b: Snapshot = { skills: [{ ...a.skills[0]!, requires: ["variables"], why: "updated evidence" }], removed: {} };
  assert.ok(!same(a, b));
  apply(a, dir);
  apply(b, dir);
  assert.deepEqual(local(dir), b);
});


test("merge is order-independent for duplicates and conflicting evidence at the same time", () => {
  const old = skill("2026-01-01T00:00:00.000Z");
  const newer = { ...old, at: "2026-01-02T00:00:00.000Z", why: "newer" };
  const a: Snapshot = { skills: [old, newer], removed: {} };
  const b: Snapshot = { skills: [{ ...newer, why: "other evidence" }], removed: {} };
  assert.ok(same(merge(a, b), merge(b, a)));
  assert.equal(merge(a, b).skills.length, 1);
  assert.equal(merge(a, b).skills[0]!.at, newer.at);
});

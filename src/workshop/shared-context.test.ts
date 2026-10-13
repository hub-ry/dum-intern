// Shared context: one block of text linked to several goals, rendered into each one's context.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { WorkshopError, WorkshopStore } from "./runtime.ts";
import { parseState } from "./validate.ts";

const homes: string[] = [];
const open: WorkshopStore[] = [];
function store(home = mkdtempSync(join(tmpdir(), "dum-shared-test-"))): WorkshopStore {
  homes.push(home);
  const s = new WorkshopStore(home);
  open.push(s);
  return s;
}
after(() => {
  for (const s of open) s.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

test("a shared context shows up in every linked goal's context, labelled with the others, and nowhere else", () => {
  const s = store();
  const software = s.createGoal({ title: "software", ambition: "ship" });
  const gpa = s.createGoal({ title: "gpa", ambition: "a's" });
  const internship = s.createGoal({ title: "internship", ambition: "offer" });
  const spanish = s.createGoal({ title: "spanish", ambition: "fluent" });
  s.updateGoal(gpa.id, { context: "CS 251 exam Oct 29." });
  s.setSharedContext({ name: "career", text: "Aiming for ML internships, summer 2027.", goalIds: [software.id, gpa.id, internship.id] });
  const g = s.getGoal(gpa.id).context;
  assert.match(g, /^CS 251 exam Oct 29\.\n\nShared context "career" \(also in: software, internship\):\nAiming for ML internships/);
  assert.match(s.getGoal(software.id).context, /Shared context "career" \(also in: gpa, internship\)/);
  assert.doesNotMatch(s.getGoal(spanish.id).context, /career/);
});

test("updates keep what they don't mention; names are case-insensitive; bad input is refused", () => {
  const s = store();
  const a = s.createGoal({ title: "a", ambition: "x" });
  const b = s.createGoal({ title: "b", ambition: "x" });
  s.setSharedContext({ name: "Career", text: "one", goalIds: [a.id] });
  s.setSharedContext({ name: "career", goalIds: [a.id, b.id] });
  assert.equal(s.listSharedContexts()[0]!.text, "one");
  s.setSharedContext({ name: "CAREER", text: "two" });
  assert.deepEqual(s.listSharedContexts().map((c) => [c.name, c.text, c.goalIds.length]), [["Career", "two", 2]]);
  assert.throws(() => s.setSharedContext({ name: "new", goalIds: [a.id] }), (e) => e instanceof WorkshopError && /give it text/.test(e.message));
  assert.throws(() => s.setSharedContext({ name: "x", text: "t", goalIds: ["00000000-0000-4000-8000-000000000000"] }), WorkshopError);
  assert.throws(() => s.setSharedContext({ name: "x", text: "y".repeat(16_001) }), WorkshopError);
  s.setSharedContext({ name: "big", text: "y".repeat(10_000), goalIds: [b.id] });
  assert.throws(() => s.setSharedContext({ name: "other", text: "z".repeat(7_000), goalIds: [b.id] }), (e) => e instanceof WorkshopError && /"b" would carry 17,003/.test(e.message));
  s.setSharedContext({ name: "other", text: "z".repeat(7_000), goalIds: [a.id] });
  s.deleteSharedContext("big");
  s.deleteSharedContext("other");
  s.deleteSharedContext("career");
  assert.deepEqual(s.listSharedContexts(), []);
  assert.doesNotMatch(s.getGoal(a.id).context, /Shared context/);
});

test("shared contexts survive a restart, and build snapshots carry them", () => {
  const home = mkdtempSync(join(tmpdir(), "dum-shared-test-"));
  const s1 = new WorkshopStore(home);
  const g = s1.createGoal({ title: "software", ambition: "ship" });
  s1.setSharedContext({ name: "career", text: "ML internships.", goalIds: [g.id] });
  s1.close();
  const s2 = store(home);
  assert.equal(s2.listSharedContexts()[0]!.name, "career");
  assert.match(s2.getGoal(g.id).context, /ML internships\./);
});

test("old state files without shared contexts load, and links to goals that are gone are dropped", () => {
  const goal = { id: "11111111-1111-4111-8111-111111111111", title: "g", ambition: "a", baseContext: "", materials: [], createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", schedule: null };
  const base = { schemaVersion: 1, goals: [goal], teachings: [], attempts: [], evidence: [], jobs: [], global: { baseContext: "", events: [], updatedAt: "2026-10-13T00:00:00.000Z" } };
  assert.deepEqual(parseState(JSON.stringify(base), "state.json").shared, []);
  const shared = [{ id: "22222222-2222-4222-8222-222222222222", name: "career", text: "t", goalIds: [goal.id, "33333333-3333-4333-8333-333333333333"], createdAt: base.global.updatedAt, updatedAt: base.global.updatedAt }];
  assert.deepEqual(parseState(JSON.stringify({ ...base, shared }), "state.json").shared[0]!.goalIds, [goal.id]);
});

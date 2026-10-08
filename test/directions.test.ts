// A zone's agreed direction (docs/circle-design.md §4): revisioned, fingerprinted against the
// committed goal, durable across restarts, and never a write of source, skills or evidence.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Directions, contextRevision, goalHash } from "../src/directions.ts";
import { sha } from "../src/shared-files.ts";
import { DirectionViewSchema, type AlignmentAttempt, type ContextRef, type DirectionInput, type DirectionOption } from "../src/delegation-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-directions-home-"));
process.env.DUM_CONTEXT = "off";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const home = () => mkdtempSync(join(tmpdir(), "dum-directions-"));
const zone = (goal = "Ship a small CLI todo app", id = randomUUID(), revision = 3): ZoneContext => ({
  id, revision, breadcrumb: [{ id, name: "Python" }], goal, ancestorGoals: [], language: "python", focusSkills: [], notes: [],
});
const ref = (excerpt: string): ContextRef => ({ id: randomUUID(), kind: "zone-note", label: "Zone note", revision: sha(excerpt), at: null, excerpt });
const option = (contextIds: string[], title = "Build the add command"): DirectionOption => ({
  id: randomUUID(), kind: "project", title, builds: [{ name: "functions", lang: "python" }],
  advancesGoal: "The add command is the core of a todo app.", contextIds, tradeoff: "Small, but skips persistence.",
});
const choose = (a: AlignmentAttempt, choice: DirectionOption): DirectionInput => ({
  contextRevision: a.contextRevision, ability: "Write and test a small Python command", choice,
  reviewCriterion: "I can explain each function", assumptions: ["Standard library only"], context: a.context,
});

/** Every file under H, relative, for "what did this write" assertions. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function failing<T>(name: "writeSync" | "renameSync", when: (...args: unknown[]) => boolean, run: () => T): T {
  const original = fs[name] as (...args: unknown[]) => unknown;
  const m = mock.method(fs, name, (...args: unknown[]) => {
    if (when(...args)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    m.mock.restore();
    syncBuiltinESMExports();
  }
}

/** Begin, then draft the Wizard's options the way the host would. */
function aligning(d: Directions, z: ZoneContext) {
  const refs = [ref("Wants a CLI, not a web app")];
  const begun = d.begin(z, refs);
  const attempt: AlignmentAttempt = { ...begun.attempt!, phase: "choose", reflection: "You want to become able to build small tools.", options: [option([refs[0]!.id])] };
  const head = d.draft(z.id, begun.revision, attempt);
  return { head, attempt };
}

test("the binding a window shows before alignment starts names the attempt begin issues", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const ctx = sha("context");
  const before = DirectionViewSchema.parse(d.read(z, ctx));
  assert.equal(before.status, "needed");
  assert.equal(before.current, null);
  assert.equal(d.read(z, ctx).binding.attemptId, before.binding.attemptId, "stable across reads");
  const head = d.begin(z, []);
  assert.equal(head.attempt!.id, before.binding.attemptId);
  assert.equal(head.goalHash, goalHash(z.goal));
  assert.equal(head.attempt!.contextRevision, contextRevision(goalHash(z.goal), 0, []));
  const after = DirectionViewSchema.parse(d.read(z, ctx));
  assert.equal(after.status, "aligning");
  assert.equal(after.binding.directionRevision, head.revision);
  assert.notEqual(after.binding.attemptId, undefined);
});

test("accepting writes one immutable revision and its head, survives restart, and touches no source or skills", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const { head, attempt } = aligning(d, z);
  const before = files(H);
  const accepted = d.accept(z, head.revision, choose(attempt, attempt.options[0]!));
  const written = files(H).filter((f) => !before.includes(f));
  assert.deepEqual(written, [`zones/${z.id}/direction/revisions/${accepted.id}.json`]);
  assert.ok(files(H).every((f) => f.startsWith(`zones/${z.id}/direction/`)), "nothing outside the zone's direction records");
  assert.equal(accepted.goal, z.goal);
  assert.equal(accepted.supersedes, null);
  assert.equal(fs.statSync(join(H, written[0]!)).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(H, written[0]!), "utf8").endsWith("}\n"));

  const restarted = new Directions(H, () => NOW + 1000);
  const view = DirectionViewSchema.parse(restarted.read(z, attempt.contextRevision));
  assert.equal(view.status, "aligned");
  assert.deepEqual(view.current, accepted);
  assert.equal(view.attempt, null);
  assert.equal(view.contextChanged, false);
  assert.equal(restarted.read(z, sha("newer context")).contextChanged, true);
  assert.deepEqual(restarted.revision(z.id, accepted.id), accepted);
});

test("revising the same goal keeps the agreement current until a new revision is accepted", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const first = aligning(d, z);
  const one = d.accept(z, first.head.revision, choose(first.attempt, first.attempt.options[0]!));
  const second = aligning(d, z);
  const revising = d.read(z, second.attempt.contextRevision);
  assert.equal(revising.status, "aligning");
  assert.equal(revising.current?.id, one.id, "the last agreement is the labeled starting point");
  const two = d.accept(z, second.head.revision, choose(second.attempt, second.attempt.options[0]!));
  assert.equal(two.supersedes, one.id);
  assert.deepEqual(d.revision(z.id, one.id), one, "old revisions stay readable");
  assert.equal(d.read(z, second.attempt.contextRevision).current?.id, two.id);
});

test("a goal the registry changed makes the old direction non-current, even before alignment restarts", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const { head, attempt } = aligning(d, z);
  const old = d.accept(z, head.revision, choose(attempt, attempt.options[0]!));
  // The registry committed a new goal; the host crashed before begin().
  const edited = { ...z, goal: "Ship a web todo app", revision: z.revision + 1 };
  const stale = DirectionViewSchema.parse(d.read(edited, sha("ctx")));
  assert.equal(stale.status, "needed");
  assert.equal(stale.current, null);
  assert.equal(stale.goalHash, goalHash(edited.goal));
  // Same-goal edits (a rename) don't change anything.
  assert.equal(d.read({ ...z, breadcrumb: [{ id: z.id, name: "Renamed" }] }, sha("ctx")).current?.id, old.id);

  const restarted = aligning(d, edited);
  assert.equal(restarted.head.currentId, null, "old direction is non-current on disk too");
  const next = d.accept(edited, restarted.head.revision, choose(restarted.attempt, restarted.attempt.options[0]!));
  assert.equal(next.supersedes, null);
  assert.equal(next.goalHash, goalHash(edited.goal));
  // An old-goal accept on the new head is refused.
  const again = aligning(d, edited);
  assert.throws(() => d.accept(z, again.head.revision, choose(again.attempt, again.attempt.options[0]!)), /goal changed/);
});

test("accept and draft refuse stale revisions, attempts, context and uncited refs", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const { head, attempt } = aligning(d, z);
  assert.throws(() => d.draft(z.id, head.revision - 1, attempt), /changed meanwhile/);
  assert.throws(() => d.draft(z.id, head.revision, { ...attempt, id: randomUUID() }), /no longer the pending one/);
  assert.throws(() => d.accept(z, head.revision + 1, choose(attempt, attempt.options[0]!)), /changed meanwhile/);
  assert.throws(() => d.accept(z, head.revision, { ...choose(attempt, attempt.options[0]!), contextRevision: sha("other") }), /context changed/);
  const injected = ref("not offered");
  assert.throws(() => d.accept(z, head.revision, { ...choose(attempt, option([injected.id])), context: [...attempt.context, injected] }), /wasn't given/);
  assert.throws(() => d.accept(z, head.revision, { ...choose(attempt, option([randomUUID()])) }), /cites context/);
  assert.throws(() => d.accept(z, head.revision, { ...choose(attempt, attempt.options[0]!), assumptions: Array(9).fill("x") }));
  assert.equal(d.read(z, attempt.contextRevision).status, "aligning", "nothing accepted");
});

test("deferral and a missing backend persist as pending attempts, never as an agreement", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const begun = d.begin(z, []);
  const deferred = d.draft(z.id, begun.revision, { ...begun.attempt!, phase: "deferred" });
  assert.equal(new Directions(H, () => NOW).read(z, sha("c")).status, "deferred");
  d.draft(z.id, deferred.revision, { ...begun.attempt!, phase: "needs-backend" });
  const view = new Directions(H, () => NOW).read(z, sha("c"));
  assert.equal(view.status, "needs-backend");
  assert.equal(view.current, null);
});

test("ignoring an observation is a revisioned correction", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  assert.deepEqual(d.corrections(z.id), { version: 1, revision: 0, ignoredObservationSourceId: null });
  const source = randomUUID();
  const next = d.ignoreObservation(z.id, 0, source);
  assert.deepEqual(next, { version: 1, revision: 1, ignoredObservationSourceId: source });
  assert.throws(() => d.ignoreObservation(z.id, 0, randomUUID()), /changed meanwhile/);
  assert.deepEqual(new Directions(H, () => NOW).corrections(z.id), next);
  assert.equal(d.begin(z, []).attempt!.contextRevision, contextRevision(goalHash(z.goal), 1, []));
});

test("symlinked direction records are refused, never followed", () => {
  const H = home();
  const outside = mkdtempSync(join(tmpdir(), "dum-directions-outside-"));
  const d = new Directions(H, () => NOW);
  const z = zone();
  mkdirSync(join(H, "zones", z.id), { recursive: true });
  symlinkSync(outside, join(H, "zones", z.id, "direction"));
  assert.throws(() => d.begin(z, []), /symlink/);
  assert.throws(() => d.read(z, sha("c")), /symlink/);
  assert.deepEqual(readdirSync(outside), [], "nothing written through the link");

  const y = zone();
  d.begin(y, []);
  const headFile = join(H, "zones", y.id, "direction", "head.json");
  const elsewhere = join(outside, "head.json");
  fs.renameSync(headFile, elsewhere);
  symlinkSync(elsewhere, headFile);
  assert.throws(() => d.read(y, sha("c")), /symlink/);
  assert.throws(() => d.begin(y, []), /symlink/);
});

test("a damaged head is reported and left as it is, never reset", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  d.begin(z, []);
  const headFile = join(H, "zones", z.id, "direction", "head.json");
  writeFileSync(headFile, "{\"version\":1,");
  assert.throws(() => d.read(z, sha("c")), /unreadable/);
  assert.throws(() => d.begin(z, []), /unreadable/);
  assert.equal(readFileSync(headFile, "utf8"), "{\"version\":1,");
});

test("a full disk fails the accept visibly and leaves the alignment as it was", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const { head, attempt } = aligning(d, z);
  const before = files(H);
  assert.throws(() => failing("writeSync", () => true, () => d.accept(z, head.revision, choose(attempt, attempt.options[0]!))), /couldn't save the direction: ENOSPC/);
  assert.deepEqual(files(H), before, "no partial or temporary files");
  assert.equal(d.read(z, attempt.contextRevision).status, "aligning");
  assert.equal(d.accept(z, head.revision, choose(attempt, attempt.options[0]!)).goal, z.goal, "works once space returns");
});

test("a crash between the revision and the head exposes nothing, and the accept can be repeated", () => {
  const H = home();
  const d = new Directions(H, () => NOW);
  const z = zone();
  const { head, attempt } = aligning(d, z);
  assert.throws(() => failing("renameSync", (_from, to) => String(to).endsWith("head.json"), () => d.accept(z, head.revision, choose(attempt, attempt.options[0]!))), /couldn't save the alignment/);
  const revisions = readdirSync(join(H, "zones", z.id, "direction", "revisions"));
  assert.equal(revisions.length, 1, "the orphan revision stays");
  const view = new Directions(H, () => NOW).read(z, attempt.contextRevision);
  assert.equal(view.status, "aligning");
  assert.equal(view.current, null, "an orphan revision grants nothing");
  const accepted = new Directions(H, () => NOW).accept(z, head.revision, choose(attempt, attempt.options[0]!));
  assert.equal(new Directions(H, () => NOW).read(z, attempt.contextRevision).current?.id, accepted.id);
});

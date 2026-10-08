// Handoffs (docs/circle-design.md §4): immutable versions, one ready or running per zone, a
// command that consumes its version once, and restarts that keep facts but not grants.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Delegations } from "../src/delegations.ts";
import { sha } from "../src/shared-files.ts";
import { HandoffViewSchema, type HandoffInput } from "../src/delegation-types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-delegations-home-"));
process.env.DUM_CONTEXT = "off";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const home = () => mkdtempSync(join(tmpdir(), "dum-delegations-"));
const input = (zoneId: string, over: Partial<HandoffInput> = {}): HandoffInput => ({
  zoneId,
  sessionId: randomUUID(),
  directionId: randomUUID(),
  goalHash: sha("goal"),
  contextRevision: sha("context"),
  outcome: "A working add command",
  task: "Write add_todo(title) that appends to todos.json",
  expectedResult: "add_todo stores the title; a test shows it",
  review: "Read the diff and run the test",
  skills: [{ name: "functions", lang: "python" }],
  targets: [`${randomUUID()}/todo.py`],
  context: [],
  ...over,
});

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
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

test("a handoff moves ready → edited → running → done → reviewed, each version immutable", () => {
  const H = home();
  const d = new Delegations(H, () => NOW);
  const zoneId = randomUUID();
  const one = d.ready(input(zoneId));
  assert.equal(one.revision, 1);
  const view = HandoffViewSchema.parse(d.current(zoneId));
  assert.equal(view.head.state, "ready");
  assert.equal(view.needsRefresh, false);

  const two = d.edit(one.id, 1, { expectedResult: "add_todo stores it and a test proves it" });
  assert.equal(two.revision, 2);
  assert.equal(two.task, one.task);
  assert.throws(() => d.edit(one.id, 1, { task: "stale" }), /changed meanwhile/);
  assert.throws(() => d.edit(one.id, 2, {}), /changes nothing/);
  assert.deepEqual(readdirSync(join(H, "zones", zoneId, "delegations", one.id, "versions")).sort(), ["1.json", "2.json"]);

  assert.throws(() => d.start(one.id, 1, "req-1"), /changed since you saw it/);
  assert.deepEqual(d.start(one.id, 2, "req-1"), two);
  assert.throws(() => d.start(one.id, 2, "req-1"), /running - Do this runs a ready handoff once/);
  assert.throws(() => d.review(one.id, 2, "good"), /once it has finished/);
  assert.throws(() => d.finish(one.id, "req-other", { state: "done", changeIds: [], result: "" }), /another request/);

  const change = randomUUID();
  d.finish(one.id, "req-1", { state: "done", changeIds: [change], result: "Wrote todo.py" });
  assert.throws(() => d.finish(one.id, "req-1", { state: "failed", changeIds: [], result: "" }), /already ended/);
  assert.throws(() => d.start(one.id, 2, "req-2"), /done - Do this runs a ready handoff once/, "a consumed version can't run twice");
  d.review(one.id, 2, "Did not advance the goal");
  assert.throws(() => d.review(one.id, 2, "again"), /already reviewed/);
  const done = HandoffViewSchema.parse(new Delegations(H, () => NOW).read(zoneId, one.id));
  assert.equal(done.head.state, "done");
  assert.deepEqual(done.head.changeIds, [change]);
  assert.deepEqual(done.head.reviewed, { at: new Date(NOW).toISOString(), verdict: "Did not advance the goal" });
  assert.deepEqual(done.handoff, two);
  assert.deepEqual(new Delegations(H, () => NOW).current(zoneId)?.head, done.head, "finished handoffs stay current for review");
});

test("one ready handoff per zone and no queue while one runs", () => {
  const H = home();
  const d = new Delegations(H, () => NOW);
  const zoneId = randomUUID();
  const first = d.ready(input(zoneId));
  const second = d.ready(input(zoneId, { task: "Write list_todos()" }));
  assert.equal(d.read(zoneId, first.id).head.state, "dismissed");
  assert.equal(d.current(zoneId)?.handoff.id, second.id);
  assert.throws(() => d.start(first.id, 1, "req-1"), /dismissed/);
  d.start(second.id, 1, "req-2");
  assert.throws(() => d.ready(input(zoneId)), /already running/);
  d.finish(second.id, "req-2", { state: "cancelled", changeIds: [], result: "Stopped" });
  const third = d.ready(input(zoneId));
  d.dismiss(third.id, 1);
  assert.equal(d.current(zoneId), null);
  assert.equal(d.read(zoneId, second.id).head.state, "cancelled", "history stays");
  // Another zone is independent.
  assert.equal(d.current(randomUUID()), null);
});

test("restart keeps facts, not grants: ready needs refresh, running becomes interrupted and is never replayed", () => {
  const H = home();
  const zoneId = randomUUID();
  const before = new Delegations(H, () => NOW);
  const ready = before.ready(input(zoneId));

  const after = new Delegations(H, () => NOW + 5000);
  const stale = after.current(zoneId)!;
  assert.equal(stale.needsRefresh, true);
  assert.equal(stale.handoff.task, ready.task, "the text survives");
  assert.throws(() => after.start(ready.id, 1, "req-1"), /refresh it first/);
  assert.deepEqual(after.recover(zoneId), [], "nothing was running");
  const refreshed = after.ready(input(zoneId, { sessionId: randomUUID() }));
  assert.equal(after.read(zoneId, ready.id).head.state, "dismissed");
  after.start(refreshed.id, 1, "req-2");

  const restarted = new Delegations(H, () => NOW + 9000);
  assert.deepEqual(restarted.recover(zoneId), [{ id: refreshed.id, revision: 1 }]);
  assert.deepEqual(restarted.recover(zoneId), [], "recovered once");
  const interrupted = restarted.read(zoneId, refreshed.id);
  assert.equal(interrupted.head.state, "interrupted");
  assert.equal(interrupted.needsRefresh, false);
  assert.throws(() => restarted.start(refreshed.id, 1, "req-3"), /interrupted/);
  // Receipts a crashed request left are reconciled by its request id, never by running it again.
  const change = randomUUID();
  restarted.finish(refreshed.id, "req-2", { state: "interrupted", changeIds: [change], result: "" });
  assert.deepEqual(restarted.read(zoneId, refreshed.id).head.changeIds, [change]);
  assert.throws(() => restarted.finish(refreshed.id, "req-2", { state: "done", changeIds: [], result: "" }), /already ended/);
  restarted.review(refreshed.id, 1, "Partly done");
});

test("storage only: selecting, editing and reviewing write nothing outside the zone's delegations", () => {
  const H = home();
  const d = new Delegations(H, () => NOW);
  const zoneId = randomUUID();
  const h = d.ready(input(zoneId));
  d.edit(h.id, 1, { review: "Run pytest" });
  d.start(h.id, 2, "req-1");
  d.finish(h.id, "req-1", { state: "done", changeIds: [], result: "" });
  d.review(h.id, 2, "ok");
  assert.ok(files(H).every((f) => f.startsWith(`zones/${zoneId}/delegations/`)), files(H).join(", "));
  for (const f of files(H)) assert.equal(fs.statSync(join(H, f)).mode & 0o777, 0o600);
});

test("bounds are enforced, never truncated", () => {
  const d = new Delegations(home(), () => NOW);
  const zoneId = randomUUID();
  assert.throws(() => d.ready(input(zoneId, { targets: Array.from({ length: 17 }, () => `${randomUUID()}/a.py`) })));
  assert.throws(() => d.ready(input(zoneId, { targets: ["/etc/passwd"] })), /not a shared resource name/);
  assert.throws(() => d.ready(input(zoneId, { task: "x".repeat(2049) })));
  assert.throws(() => d.ready(input(zoneId, { skills: Array.from({ length: 33 }, (_, i) => ({ name: `s${i}`, lang: "python" })) })));
  const h = d.ready(input(zoneId));
  d.start(h.id, 1, "req-1");
  assert.throws(() => d.finish(h.id, "req-1", { state: "done", changeIds: Array.from({ length: 33 }, () => randomUUID()), result: "" }));
  assert.throws(() => d.finish(h.id, "req-1", { state: "done", changeIds: [], result: "x".repeat(2049) }));
  assert.equal(d.read(zoneId, h.id).head.state, "running");
});

test("a handoff this host never touched is found by id after restart", () => {
  const H = home();
  const zoneId = randomUUID();
  const h = new Delegations(H, () => NOW).ready(input(zoneId));
  const fresh = new Delegations(H, () => NOW);
  assert.equal(fresh.edit(h.id, 1, { task: "Write add_todo with a docstring" }).revision, 2);
  assert.throws(() => fresh.edit(randomUUID(), 1, { task: "x" }), /no such handoff/);
  assert.throws(() => fresh.edit("../../etc", 1, { task: "x" }), /no such handoff/);
});

test("symlinked handoff records are refused, never followed", () => {
  const H = home();
  const outside = mkdtempSync(join(tmpdir(), "dum-delegations-outside-"));
  const d = new Delegations(H, () => NOW);
  const zoneId = randomUUID();
  mkdirSync(join(H, "zones", zoneId), { recursive: true });
  symlinkSync(outside, join(H, "zones", zoneId, "delegations"));
  assert.throws(() => d.ready(input(zoneId)), /symlink/);
  assert.deepEqual(readdirSync(outside), []);

  const other = randomUUID();
  const h = d.ready(input(other));
  const headFile = join(H, "zones", other, "delegations", h.id, "head.json");
  fs.renameSync(headFile, join(outside, "head.json"));
  symlinkSync(join(outside, "head.json"), headFile);
  assert.throws(() => d.start(h.id, 1, "req-1"), /symlink/);
  assert.throws(() => d.read(other, h.id), /symlink/);
});

test("a full disk on Do this fails visibly and leaves the handoff ready to command once", () => {
  const H = home();
  const d = new Delegations(H, () => NOW);
  const zoneId = randomUUID();
  const h = d.ready(input(zoneId));
  assert.throws(() => failing("writeSync", () => true, () => d.start(h.id, 1, "req-1")), /couldn't save the handoff: ENOSPC/);
  assert.equal(d.read(zoneId, h.id).head.state, "ready");
  assert.ok(!files(H).some((f) => f.includes(".tmp")), "no temporary files left");
  d.start(h.id, 1, "req-1");
  assert.throws(() => d.start(h.id, 1, "req-1"), /running/);
});

test("a crash between a version and its head leaves an orphan that grants nothing", () => {
  const H = home();
  const d = new Delegations(H, () => NOW);
  const zoneId = randomUUID();
  const kept = d.ready(input(zoneId));
  assert.throws(() => failing("renameSync", (_from, to) => String(to).endsWith("head.json") && !String(to).includes(kept.id), () => d.ready(input(zoneId))), /couldn't save the handoff/);
  const restarted = new Delegations(H, () => NOW);
  // The earlier ready one was dismissed; the new one never got a head, so nothing is current.
  assert.equal(restarted.current(zoneId), null);
  assert.equal(restarted.read(zoneId, kept.id).head.state, "dismissed");
  const orphan = readdirSync(join(H, "zones", zoneId, "delegations")).find((n) => n !== kept.id && n !== "current.json")!;
  assert.ok(orphan, "the orphan version stays");
  assert.throws(() => restarted.start(orphan, 1, "req-1"), /no such handoff/);
});

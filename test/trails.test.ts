// Sessions, trails and the story (docs/circle-design.md §4): ordered skill visits with decision
// markers, crash-prefix recovery with idempotent markers, bounded paging that never misses or
// repeats, and a rebuildable story cache. Trails are observations, never evidence or authority.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Trails, decisionKey } from "../src/trails.ts";
import {
  SessionMetaSchema, StoryPageSchema, TrailPageSchema, TrailViewSchema,
  type DecisionEventInput, type StoryQuery, type StoryRow, type TopicHint, type TrailEvent, type TrailSourceInput,
} from "../src/trail-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-trails-home-"));
process.env.DUM_CONTEXT = "off";

const START = Date.parse("2026-10-08T12:00:00.000Z");
const home = () => mkdtempSync(join(tmpdir(), "dum-trails-"));
const clock = (start = START) => {
  const c = { t: start, now: () => c.t, tick: (ms: number) => { c.t += ms; } };
  return c;
};
const zone = (id = randomUUID(), goal = "Ship a small CLI todo app"): ZoneContext => ({
  id, revision: 1, breadcrumb: [{ id, name: "Python" }], goal, ancestorGoals: [], language: "python", focusSkills: [], notes: [],
});
const look = (excerpt = "Editing todo.py in an editor"): TrailSourceInput => ({
  kind: "look", excerpt, entryId: null, requestId: null, evidenceId: null, changeId: null, handoffId: null, proof: null,
});
const said = (excerpt = "We talked about functions"): TrailSourceInput => ({ ...look(excerpt), kind: "conversation", entryId: 4 });
const hint = (name: string | null, confidence = 0.9, topic = name ?? "something"): TopicHint => ({
  topic, skill: name === null ? null : { name, lang: "python" }, confidence, reason: "named on screen",
});
const handoff = (handoffId: string, phase: "commanded" | "done" | "reviewed", sourceIds: string[] = []): DecisionEventInput => ({
  kind: "handoff", handoffId, revision: 1, phase, directionId: null, sourceIds,
});

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

function allEvents(t: Trails, zoneId: string, sessionId: string): TrailEvent[] {
  const out: TrailEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = TrailPageSchema.parse(t.read(zoneId, sessionId, cursor));
    assert.ok(page.events.length <= 50);
    out.push(...page.events);
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

function allStory(t: Trails, query: Omit<StoryQuery, "cursor">): StoryRow[] {
  const out: StoryRow[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = StoryPageSchema.parse(t.story({ ...query, cursor }));
    out.push(...page.rows);
    if (page.next === null) return out;
    cursor = page.next;
  }
  throw new Error("story paging didn't end");
}

test("visits, touches, revisits, gaps and markers form one ordered trail", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  const direction = randomUUID();
  const s = t.begin(z, direction);
  assert.equal(SessionMetaSchema.parse(s).endedAt, null);

  t.observe(s.id, [hint("functions")], look());
  c.tick(10_000);
  t.observe(s.id, [hint("functions")], look("Still on add_todo")); // coalesced: under a minute
  c.tick(70_000);
  t.observe(s.id, [hint("functions")], look("Still on add_todo, later")); // a durable touch
  c.tick(1000);
  t.observe(s.id, [hint("lists", 0.5), hint(null, 0, "argparse subcommands")], said()); // low confidence → gaps
  t.observe(s.id, [hint("lists", 1)], said("Appending to a list"));
  t.observe(s.id, [hint("functions"), hint("functions")], look("Back to add_todo")); // revisit, coalesced in one report
  const accepted = randomUUID();
  t.decision(s.id, { kind: "direction", directionId: accepted, previousId: direction }, `direction:${accepted}`);
  t.observe(s.id, [hint("dictionaries", 0.95)], look("Looking at dicts"));

  const view = TrailViewSchema.parse(t.current(s.id));
  assert.deepEqual(view.visits.map((v) => v.skill.name), ["functions", "lists", "functions", "dictionaries"]);
  const [first, lists, back, dicts] = view.visits;
  assert.equal(first!.mapping, "inferred");
  assert.equal(first!.lastSeenAt, new Date(START + 80_000).toISOString(), "repeating the skill updates lastSeenAt");
  assert.equal(lists!.mapping, "exact");
  assert.equal(lists!.origin, "conversation");
  assert.equal(back!.revisitOf, first!.id, "leaving and returning is a revisit");
  assert.equal(back!.directionId, direction);
  assert.equal(dicts!.directionId, accepted, "visits carry the direction in force");
  assert.deepEqual(view.gaps.map((g) => g.topic), ["lists", "argparse subcommands"]);
  assert.deepEqual(view.markers.map((m) => m.kind), ["direction"]);
  assert.equal(view.directionId, accepted);

  const events = allEvents(t, z.id, s.id);
  assert.deepEqual(events.map((e) => e.kind), ["visit", "touch", "gap", "gap", "visit", "visit", "direction", "visit"]);
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
  const meta = t.meta(s.id)!;
  assert.equal(meta.latestObservation?.text, "Looking at dicts");
  assert.equal(t.source(z.id, s.id, meta.latestObservation!.sourceId).excerpt, "Looking at dicts");

  t.mapGap(s.id, view.gaps[1]!.id, { name: "argparse", lang: "python" });
  assert.throws(() => t.mapGap(s.id, view.gaps[1]!.id, { name: "argparse", lang: "python" }), /already mapped/);
  const mapped = t.current(s.id)!;
  assert.deepEqual(mapped.gaps.map((g) => g.topic), ["lists"]);
  assert.equal(mapped.visits.at(-1)!.mapping, "user");
  assert.equal(mapped.visits.at(-1)!.origin, "user-map");
  assert.deepEqual(mapped.visits.at(-1)!.sourceIds, [view.gaps[1]!.sourceId]);

  assert.throws(() => t.observe(s.id, [], look("two\nlines")), /one short line/);
  assert.throws(() => t.mapGap(s.id, randomUUID(), { name: "x", lang: "" }), /no such unmapped topic/);
});

test("an evidence source keeps its proof, readable after the ledger forgot it, and links nothing it doesn't name", () => {
  const H = home();
  const t = new Trails(H, clock().now);
  const z = zone();
  const s = t.begin(z, null);
  const evidenceId = randomUUID();
  const proof = { id: evidenceId, zoneId: z.id, zoneName: "Python", at: new Date(START).toISOString(), kind: "build" as const, skill: "functions", lang: "python", ok: true, why: "wrote it unaided" };
  t.observe(s.id, [hint("functions", 0.1)], { ...look("Proof: functions"), kind: "evidence", evidenceId, proof });
  const visit = t.current(s.id)!.visits[0]!;
  assert.equal(visit.origin, "artifact");
  assert.equal(visit.mapping, "exact", "artifacts name their skills exactly");
  t.end(s.id, "leave");
  const kept = new Trails(H, clock().now).source(z.id, s.id, visit.sourceIds[0]!);
  assert.deepEqual(kept.proof, proof);
  assert.throws(() => t.observe(s.id, [], { ...look(), kind: "evidence", evidenceId: null }), /link/);
});

test("decision markers are idempotent by key, including on ended sessions", () => {
  const H = home();
  const t = new Trails(H, clock().now);
  const z = zone();
  const s = t.begin(z, null);
  const h = randomUUID();
  const commanded = handoff(h, "commanded");
  assert.throws(() => t.decision(s.id, commanded, "whatever"), /idempotency key/);
  t.decision(s.id, commanded, decisionKey(commanded));
  t.decision(s.id, commanded, decisionKey(commanded));
  t.end(s.id, "new-session");
  t.end(s.id, "quit"); // a repeat is a no-op
  const done = handoff(h, "done");
  t.decision(s.id, done, decisionKey(done)); // a late result
  t.decision(s.id, done, decisionKey(done));
  assert.throws(() => t.decision(s.id, handoff(h, "reviewed", [randomUUID()]), decisionKey(handoff(h, "reviewed"))), /no such source/);
  const events = allEvents(new Trails(H, clock().now), z.id, s.id);
  assert.deepEqual(events.map((e) => e.kind === "handoff" && e.phase), ["commanded", "done"]);
  assert.equal(t.meta(s.id)!.endReason, "new-session");
  assert.throws(() => t.observe(s.id, [], look()), /has ended/);
});

test("a crash after the event page but before the meta: restart adopts the event once and closes the session", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  const s = t.begin(z, null);
  t.observe(s.id, [hint("functions")], look());
  c.tick(5000);
  t.activity(s.id, c.t); // under a minute: not yet durable
  const accepted = randomUUID();
  const marker: DecisionEventInput = { kind: "direction", directionId: accepted, previousId: null };
  assert.throws(
    () => failing("renameSync", (_from, to) => String(to).endsWith("meta.json"), () => t.decision(s.id, marker, decisionKey(marker))),
    /couldn't record the trail: ENOSPC/,
  );
  const onDisk = SessionMetaSchema.parse(JSON.parse(readFileSync(join(H, "zones", z.id, "sessions", s.id, "meta.json"), "utf8")));
  assert.equal(onDisk.eventCount, 1, "the meta still counts only the committed event");
  assert.equal(new Trails(H, c.now).read(z.id, s.id, null).events.length, 1, "uncommitted events aren't published");

  c.tick(3_600_000);
  const restarted = new Trails(H, c.now);
  restarted.recover();
  const meta = restarted.meta(s.id)!;
  assert.equal(meta.endReason, "interrupted");
  assert.equal(meta.endedAt, new Date(START).toISOString(), "ended at the last durable activity, no invented downtime");
  assert.equal(meta.eventCount, 2);
  restarted.decision(s.id, marker, decisionKey(marker)); // recovery links the committed head once
  assert.deepEqual(allEvents(restarted, z.id, s.id).map((e) => e.kind), ["visit", "direction"]);
  const index = JSON.parse(readFileSync(join(H, "zones", z.id, "sessions", "index.json"), "utf8"));
  assert.equal(index.activeSessionId, null);
  restarted.recover();
  assert.equal(restarted.meta(s.id)!.revision, meta.revision, "recover is idempotent");
  const next = restarted.begin(z, accepted);
  assert.notEqual(next.id, s.id);
});

test("a crash between a session's meta and its catalog entry leaves an orphan; one ahead of the header is adopted", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  assert.throws(() => failing("renameSync", (_from, to) => String(to).endsWith("index.json"), () => t.begin(z, null)), /couldn't record/);
  // The catalog page took the ID but the header didn't: the restart adopts it and closes the session.
  const restarted = new Trails(H, c.now);
  restarted.recover();
  const rows = restarted.story({ zoneId: z.id, skill: null, from: null, to: null, cursor: null }).rows;
  assert.equal(rows.length, 1);
  assert.equal(restarted.meta(rows[0]!.sessionId)!.endReason, "interrupted");
  // A meta that never reached the catalog stays invisible and grants nothing.
  const orphan = randomUUID();
  mkdirSync(join(H, "zones", z.id, "sessions", orphan), { recursive: true });
  writeFileSync(join(H, "zones", z.id, "sessions", orphan, "meta.json"), readFileSync(join(H, "zones", z.id, "sessions", rows[0]!.sessionId, "meta.json")));
  assert.equal(new Trails(H, c.now).story({ zoneId: z.id, skill: null, from: null, to: null, cursor: null }).rows.length, 1);
  restarted.begin(z, null);
});

test("trail pages rotate at 128 events and page 50 at a time without gaps or repeats, even while it grows", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  const s = t.begin(z, null);
  for (let i = 0; i < 300; i++) {
    c.tick(1000);
    t.observe(s.id, [hint(i % 2 === 0 ? "functions" : "lists")], look(`step ${i}`));
  }
  assert.deepEqual(readdirSync(join(H, "zones", z.id, "sessions", s.id, "events")).sort(), ["0.json", "1.json", "2.json"]);
  const seen: number[] = [];
  let cursor: string | null = null;
  let grew = false;
  do {
    const page = t.read(z.id, s.id, cursor);
    seen.push(...page.events.map((e) => e.seq));
    cursor = page.next;
    if (!grew) {
      t.observe(s.id, [hint("dictionaries")], look("appended while paging"));
      grew = true;
    }
  } while (cursor !== null);
  assert.deepEqual(seen, Array.from({ length: 301 }, (_, i) => i));
  assert.throws(() => t.read(randomUUID(), s.id, null), /no such session/);
  const other = t.begin(zone(), null);
  const link = t.read(z.id, s.id, null).next!;
  assert.throws(() => t.read(other.zoneId, other.id, link), /out of date/, "a cursor is bound to its zone and session");
  assert.throws(() => t.read(z.id, s.id, Buffer.from("{}").toString("base64url")), /out of date/);
  assert.throws(() => t.read(z.id, s.id, "../meta.json"), /out of date/);
});

test("story pages every session across zones exactly once, newest first, while new sessions start", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const a = zone();
  const b = zone();
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    c.tick(i % 7 === 0 ? 0 : 60_000); // equal start times across zones happen too
    const z = i % 3 === 0 ? b : a;
    const s = t.begin(z, null);
    if (i % 10 === 0) t.observe(s.id, [hint("recursion")], look());
    t.end(s.id, "leave");
    ids.add(s.id);
  }
  assert.ok(readdirSync(join(H, "zones", a.id, "sessions", "index")).length >= 2, "catalog pages rotate");

  const out: StoryRow[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = StoryPageSchema.parse(t.story({ zoneId: null, skill: null, from: null, to: null, cursor }));
    assert.ok(page.rows.length <= 50);
    out.push(...page.rows);
    cursor = page.next;
    pages++;
    c.tick(1000);
    const late = t.begin(a, null); // newer than everything already listed: never shifts what's left
    t.end(late.id, "leave");
  } while (cursor !== null);
  assert.ok(pages >= 4);
  assert.equal(out.length, ids.size);
  assert.deepEqual(new Set(out.map((r) => r.sessionId)), ids);
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1]!.startedAt >= out[i]!.startedAt, "newest first");

  const onlyB = allStory(t, { zoneId: b.id, skill: null, from: null, to: null });
  assert.ok(onlyB.every((r) => r.zoneId === b.id));
  assert.equal(onlyB.length, [...ids].filter((id) => t.meta(id)!.zoneId === b.id).length);

  const recursion = allStory(t, { zoneId: null, skill: { name: "Recursion", lang: "Python" }, from: null, to: null });
  assert.equal(recursion.length, 20);
  assert.ok(recursion.every((r) => r.visits === 1 && r.preview[0]!.name === "recursion"));

  const from = new Date(START + 50 * 60_000).toISOString();
  const to = new Date(START + 120 * 60_000).toISOString();
  const ranged = allStory(t, { zoneId: null, skill: null, from, to });
  const expected = [...ids].filter((id) => { const m = t.meta(id)!; return m.startedAt >= from && m.startedAt <= to; });
  assert.deepEqual(new Set(ranged.map((r) => r.sessionId)), new Set(expected));
  assert.equal(ranged.length, expected.length);
  assert.throws(() => t.story({ zoneId: null, skill: null, from: null, to: null, cursor: StoryPageSchema.parse(t.story({ zoneId: a.id, skill: null, from: null, to: null, cursor: null })).next }), /out of date/);
});

test("the story cache detects stale rows by source revision and rebuilds from a damaged head", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  const s = t.begin(z, null);
  t.observe(s.id, [hint("functions")], look());
  t.end(s.id, "leave");
  const query = { zoneId: z.id, skill: null, from: null, to: null, cursor: null };
  assert.equal(t.story(query).rows[0]!.handoffsDone, 0);
  const h = randomUUID();
  t.decision(s.id, handoff(h, "done"), decisionKey(handoff(h, "done"))); // a late result on an ended session
  const row = t.story(query).rows[0]!;
  assert.equal(row.handoffsDone, 1);
  assert.equal(row.sourceRevision, t.meta(s.id)!.revision);

  const headFile = join(H, "zones", z.id, "story", "head.json");
  const generation = JSON.parse(readFileSync(headFile, "utf8")).generation;
  writeFileSync(headFile, "not json");
  assert.deepEqual(new Trails(H, c.now).story(query).rows, [row]);
  assert.notEqual(JSON.parse(readFileSync(headFile, "utf8")).generation, generation, "a fresh generation");
  writeFileSync(join(H, "zones", z.id, "story", "pages", "0.json"), "{}");
  assert.deepEqual(new Trails(H, c.now).story(query).rows, [row], "a damaged cache page is recomputed");
});

test("symlinks anywhere in the archive are refused, never followed", () => {
  const H = home();
  const outside = mkdtempSync(join(tmpdir(), "dum-trails-outside-"));
  const t = new Trails(H, clock().now);
  const z = zone();
  mkdirSync(join(H, "zones", z.id), { recursive: true });
  symlinkSync(outside, join(H, "zones", z.id, "sessions"));
  assert.throws(() => t.begin(z, null), /symlink/);
  assert.deepEqual(readdirSync(outside), []);

  const y = zone();
  const s = t.begin(y, null);
  t.observe(s.id, [], look());
  const sourceId = t.meta(s.id)!.latestObservation!.sourceId;
  const sourceFile = join(H, "zones", y.id, "sessions", s.id, "sources", `${sourceId}.json`);
  fs.renameSync(sourceFile, join(outside, "source.json"));
  symlinkSync(join(outside, "source.json"), sourceFile);
  assert.throws(() => t.source(y.id, s.id, sourceId), /symlink/);
  const pageFile = join(H, "zones", y.id, "sessions", s.id, "events", "0.json");
  t.observe(s.id, [hint("functions")], look());
  fs.renameSync(pageFile, join(outside, "0.json"));
  symlinkSync(join(outside, "0.json"), pageFile);
  assert.throws(() => t.observe(s.id, [hint("lists")], look()), /symlink/);
  assert.throws(() => new Trails(H, clock().now).current(s.id), /symlink/);
  assert.throws(() => new Trails(H, clock().now).recover(), /symlink/, "recover names the zone it couldn't close");
});

test("a full disk is a visible recording failure; nothing is evicted, duplicated or lost after space returns", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  const s = t.begin(z, null);
  t.observe(s.id, [hint("functions")], look());
  const before = files(H);
  c.tick(1000);
  assert.throws(() => failing("writeSync", () => true, () => t.observe(s.id, [hint("lists")], look("full"))), /couldn't record the trail: ENOSPC/);
  assert.deepEqual(files(H), before, "no partial or temporary files");
  // The page reached the disk but the meta didn't: the next write adopts it rather than repeating it.
  c.tick(1000);
  assert.throws(() => failing("renameSync", (_from, to) => String(to).endsWith("meta.json"), () => t.observe(s.id, [hint("dictionaries")], look("half"))), /ENOSPC/);
  c.tick(1000);
  t.observe(s.id, [hint("recursion")], look("space again"));
  const events = allEvents(t, z.id, s.id);
  assert.deepEqual(events.map((e) => e.kind === "visit" && e.step.skill.name), ["functions", "dictionaries", "recursion"]);
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2]);
  assert.equal(t.meta(s.id)!.eventCount, 3);
  assert.equal(t.current(s.id)!.visits.length, 3);
});

test("activity is coalesced to one write a minute and an orderly end flushes it", () => {
  const H = home();
  const c = clock();
  const t = new Trails(H, c.now);
  const z = zone();
  const s = t.begin(z, null);
  const revision = () => SessionMetaSchema.parse(JSON.parse(readFileSync(join(H, "zones", z.id, "sessions", s.id, "meta.json"), "utf8"))).revision;
  for (let i = 0; i < 20; i++) {
    c.tick(2000);
    t.activity(s.id, c.t);
  }
  assert.equal(revision(), 0, "40 seconds of activity: no write yet");
  c.tick(30_000);
  t.activity(s.id, c.t);
  assert.equal(revision(), 1);
  c.tick(5000);
  t.activity(s.id, c.t);
  t.end(s.id, "idle");
  const meta = new Trails(H, c.now).meta(s.id)!;
  assert.equal(meta.lastActivityAt, new Date(c.t).toISOString());
  assert.equal(meta.endReason, "idle");
  assert.throws(() => t.activity(s.id, c.t), /has ended/);
  t.begin(z, null);
  assert.throws(() => t.begin(z, null), /open session/);
});

test("trails write only under the zone's sessions and story, as private files", () => {
  const H = home();
  const t = new Trails(H, clock().now);
  const z = zone();
  const s = t.begin(z, null);
  t.observe(s.id, [hint("functions"), hint(null, 0, "tkinter")], said());
  t.end(s.id, "quit");
  t.story({ zoneId: z.id, skill: null, from: null, to: null, cursor: null });
  for (const f of files(H)) {
    assert.ok(f.startsWith(`zones/${z.id}/sessions/`) || f.startsWith(`zones/${z.id}/story/`), f);
    assert.equal(fs.statSync(join(H, f)).mode & 0o777, 0o600, f);
    assert.ok(readFileSync(join(H, f), "utf8").endsWith("\n"));
  }
  assert.equal(fs.statSync(join(H, "zones", z.id, "sessions")).mode & 0o777, 0o700);
});

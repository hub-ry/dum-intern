// Sessions, trails and the goal-relative story (docs/circle-design.md §4). The host, under H's
// writer lock, is the only writer; the caller serializes. Everything lives under
// H/zones/<id>/sessions and H/zones/<id>/story as private, bounded, no-follow records.
//
// Commit order is source → event page → meta; only events the meta counts are published. A crash
// can leave a complete page ahead of its meta: the next mutation or recover() adopts it, so a
// decision marker recorded that way is never recorded twice (its idempotency key is in the page).
// A session's meta exists before its catalog ID; the catalog only grows, one ID per session, and
// a session's start time never precedes the one before it, so catalog order is start order and
// story paging never misses or repeats a session. The story is a cache: every row carries its
// session's meta revision, is checked against it when read, and is recomputed from the events
// when stale. Trails are supporting observations, never evidence, grants or a reason to write.

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CursorSchema } from "./delegation-types.ts";
import { createState, readState, writeState } from "./state-files.ts";
import { sha } from "./shared-files.ts";
import { IdSchema } from "./share-types.ts";
import {
  DecisionEventInputSchema,
  EndReasonSchema,
  EventPageSchema,
  SessionIndexPageSchema,
  SessionIndexSchema,
  SessionMetaSchema,
  StoryCachePageSchema,
  StoryHeadSchema,
  StoryQuerySchema,
  TopicHintsSchema,
  TRAIL_LIMITS,
  TrailEventSchema,
  TrailSourceInputSchema,
  TrailSourceSchema,
} from "./trail-types.ts";
import type {
  DecisionEventInput,
  EndReason,
  EventPage,
  SessionIndex,
  SessionIndexPage,
  SessionMeta,
  StoryHead,
  StoryPage,
  StoryQuery,
  StoryRow,
  TopicHint,
  TrailEvent,
  TrailPage,
  TrailSource,
  TrailSourceInput,
  TrailStep,
  TrailView,
} from "./trail-types.ts";
import { IsoSchema, SkillRefSchema, ZoneContextSchema, type SkillRef, type ZoneContext } from "./zone-types.ts";

const T = TRAIL_LIMITS;
const MINUTE = 60_000;
/** Live sessions stay loaded; at most this many ended ones are kept for late markers and views. */
const KEEP_LOADED = 16;
const encoder = new TextEncoder();
const jsonBytes = (v: unknown) => encoder.encode(JSON.stringify(v)).length;
/** Compact JSON, so the schemas' byte bounds are the file's, plus its trailing newline. */
const body = (v: unknown) => `${JSON.stringify(v)}\n`;
const iso = (ms: number) => new Date(ms).toISOString();
const skillKey = (s: SkillRef) => `${s.name.toLowerCase()}\u0000${s.lang.toLowerCase()}`;
const OBSERVATION_CONTROL = /[\u0000-\u001f\u007f]/;

const P = {
  index: (zoneId: string) => `zones/${zoneId}/sessions/index.json`,
  indexPage: (zoneId: string, page: number) => `zones/${zoneId}/sessions/index/${page}.json`,
  meta: (zoneId: string, id: string) => `zones/${zoneId}/sessions/${id}/meta.json`,
  events: (zoneId: string, id: string, page: number) => `zones/${zoneId}/sessions/${id}/events/${page}.json`,
  source: (zoneId: string, id: string, sourceId: string) => `zones/${zoneId}/sessions/${id}/sources/${sourceId}.json`,
  storyHead: (zoneId: string) => `zones/${zoneId}/story/head.json`,
  storyPage: (zoneId: string, page: number) => `zones/${zoneId}/story/pages/${page}.json`,
};

type Draft = TrailEvent extends infer E ? (E extends TrailEvent ? Omit<E, "seq"> : never) : never;
type Marker = Extract<TrailEvent, { kind: "direction" | "handoff" }>;
type Gap = Extract<TrailEvent, { kind: "gap" }>;
/** Story order, newest first: start time, then zone, then catalog position. */
type Key = [string, string, number];

/** What appending to one session needs, rebuilt from its pages when not in memory. */
type Live = {
  zoneId: string;
  meta: SessionMeta;
  /** Committed events of the last page, and that page's compact size. */
  page: TrailEvent[];
  pageBytes: number;
  /** The direction in force: the session's initial one, then each direction marker. */
  direction: string | null;
  /** The current step, and when it was last durably seen. */
  step: { id: string; key: string; seenAt: number } | null;
  /** Latest step per skill, for revisit links. */
  bySkill: Map<string, string>;
  keys: Set<string>;
  gaps: Map<string, Gap>;
  mapped: Set<string>;
  visits: TrailStep[];
  markers: Marker[];
  /** A repeat of the current skill not yet written: at most one durable touch a minute. */
  touch: { stepId: string; sourceId: string | null; at: number } | null;
  /** Activity not yet written, and the durable lastActivityAt. */
  activity: number | null;
  activityAt: number;
};

const TrailCursorSchema = z.object({ k: z.literal("trail"), z: IdSchema, s: IdSchema, p: z.number().int().nonnegative(), q: z.number().int().nonnegative() }).strict();
const StoryCursorSchema = z.object({
  k: z.literal("story"),
  f: z.string().regex(/^[0-9a-f]{16}$/),
  b: z.tuple([IsoSchema, IdSchema, z.number().int().nonnegative()]),
}).strict();

/** The idempotency key of a decision marker: a direction once, a handoff phase once per version. */
export function decisionKey(event: DecisionEventInput): string {
  return event.kind === "direction" ? `direction:${event.directionId}` : `handoff:${event.handoffId}:${event.revision}:${event.phase}`;
}

function compare(a: Key, b: Key): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] - b[2];
}

function encode(cursor: z.infer<typeof TrailCursorSchema> | z.infer<typeof StoryCursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(CursorSchema.parse(cursor), "base64url").toString("utf8")));
  } catch {
    throw new Error("that page link is out of date - open the list again");
  }
}

function checkedId(id: string, what: string): string {
  if (!IdSchema.safeParse(id).success) throw new Error(`there's no such ${what}`);
  return id;
}

/** A record, schema-checked; null when absent. Unreadable records stay exactly as they are. */
function load<T>(home: string, rel: string, max: number, schema: z.ZodType<T>): T | null {
  let raw: string | null;
  try {
    raw = readState(home, rel, max + 1);
  } catch (err) {
    throw new Error(`${rel} can't be read (${(err as Error).message})`);
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${rel} is unreadable - Dum left it as it is`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${rel} is unreadable (${parsed.error.issues[0]?.message ?? "invalid"}) - Dum left it as it is`);
  return parsed.data;
}

function recording<T>(write: () => T): T {
  try {
    return write();
  } catch (err) {
    throw new Error(`couldn't record the trail: ${(err as Error).message}`);
  }
}

function blank(zoneId: string, meta: SessionMeta): Live {
  return {
    zoneId,
    meta,
    page: [],
    pageBytes: 0,
    direction: meta.directionId,
    step: null,
    bySkill: new Map(),
    keys: new Set(),
    gaps: new Map(),
    mapped: new Set(),
    visits: [],
    markers: [],
    touch: null,
    activity: null,
    activityAt: Date.parse(meta.lastActivityAt),
  };
}

function apply(live: Live, e: TrailEvent): void {
  switch (e.kind) {
    case "visit":
    case "map-gap": {
      const key = skillKey(e.step.skill);
      live.bySkill.set(key, e.step.id);
      live.step = { id: e.step.id, key, seenAt: Date.parse(e.at) };
      live.visits = [...live.visits, e.step].slice(-T.recentVisits);
      if (e.kind === "map-gap") live.mapped.add(e.gapId);
      break;
    }
    case "touch":
      if (live.step?.id === e.stepId) live.step.seenAt = Date.parse(e.at);
      live.visits = live.visits.map((s) => (s.id === e.stepId && s.lastSeenAt < e.at ? { ...s, lastSeenAt: e.at } : s));
      break;
    case "gap":
      live.gaps.set(e.id, e);
      break;
    case "direction":
    case "handoff":
      if (e.kind === "direction") live.direction = e.directionId;
      live.keys.add(decisionKey(e));
      live.markers = [...live.markers, e].slice(-T.recentMarkers);
      break;
  }
}

export class Trails {
  private readonly live = new Map<string, Live>();
  /** Session id → zone id, for every session this host touched. */
  private readonly where = new Map<string, string>();

  constructor(private readonly home: string, private readonly now: () => number) {}

  /** Start a session in a zone. Its meta exists before the catalog lists it. */
  begin(zone: ZoneContext, directionId: string | null): SessionMeta {
    const z = ZoneContextSchema.parse(zone);
    if (directionId !== null && !IdSchema.safeParse(directionId).success) throw new Error("that direction isn't one Dum issued");
    const { index, last } = this.catalog(z.id);
    if (index.activeSessionId !== null && this.readMeta(z.id, index.activeSessionId)?.endedAt === null) {
      throw new Error("this zone already has an open session - end it first");
    }
    const lastId = last?.ids.at(-1);
    const previous = lastId === undefined ? null : this.readMeta(z.id, lastId);
    // A clock that stepped back can't reorder the catalog.
    const startedAt = previous !== null && previous.startedAt > iso(this.now()) ? previous.startedAt : iso(this.now());
    const meta = SessionMetaSchema.parse({
      version: 1,
      id: randomUUID(),
      zoneId: z.id,
      zoneName: z.breadcrumb.at(-1)!.name,
      goal: z.goal,
      directionId,
      startedAt,
      endedAt: null,
      endReason: null,
      lastActivityAt: startedAt,
      revision: 0,
      eventPages: 0,
      eventCount: 0,
      latestObservation: null,
    });
    recording(() => {
      if (!createState(this.home, P.meta(z.id, meta.id), body(meta))) throw new Error(`${P.meta(z.id, meta.id)} already exists`);
      let pages = index.pages;
      if (last !== null && last.ids.length < T.indexIds) {
        writeState(this.home, P.indexPage(z.id, last.page), body(SessionIndexPageSchema.parse({ ...last, ids: [...last.ids, meta.id] })));
      } else {
        const page: SessionIndexPage = { version: 1, page: pages, ids: [meta.id] };
        if (!createState(this.home, P.indexPage(z.id, pages), body(page))) throw new Error(`${P.indexPage(z.id, pages)} already exists`);
        pages++;
      }
      const header: SessionIndex = { version: 1, pages, sessions: index.sessions + 1, activeSessionId: meta.id };
      writeState(this.home, P.index(z.id), body(header));
    });
    this.where.set(meta.id, z.id);
    this.remember(meta.id, blank(z.id, meta));
    return meta;
  }

  /** End a session once; a repeat is a no-op. A crashed session ends at its last durable activity. */
  end(id: string, reason: EndReason): void {
    const why = EndReasonSchema.parse(reason);
    const live = this.open(id, true);
    if (live.meta.endedAt === null) {
      const last = Math.max(live.activityAt, live.activity ?? 0);
      const endedAt = why === "interrupted" ? iso(last) : iso(Math.max(this.now(), Date.parse(live.meta.startedAt)));
      this.commit(id, live, [], { endedAt, endReason: why }, true);
    }
    const { stored } = this.catalog(live.zoneId);
    if (stored.activeSessionId === id) {
      recording(() => writeState(this.home, P.index(live.zoneId), body({ ...stored, activeSessionId: null })));
    }
  }

  /** Eligible activity. Written at most once a minute; an orderly end writes the rest. */
  activity(id: string, at: number): void {
    if (!Number.isFinite(at)) throw new Error("that activity has no time");
    const live = this.open(id, false);
    const when = Math.min(at, this.now());
    if (when <= Math.max(live.activityAt, live.activity ?? 0)) return;
    live.activity = when;
    if (when - live.activityAt >= MINUTE) this.commit(id, live, [], {}, false);
  }

  /**
   * One look or conversation report, or an artifact naming its skills. The source is kept first;
   * a skill becomes a visit (or a touch of the current one), anything unmapped becomes a gap.
   */
  observe(id: string, hints: readonly TopicHint[], source: TrailSourceInput): void {
    const topics = TopicHintsSchema.parse(hints);
    const input = TrailSourceInputSchema.parse(source);
    const live = this.open(id, false);
    const now = this.now();
    const at = iso(now);
    if (input.kind === "look" && (input.excerpt.trim() === "" || input.excerpt.length > T.observationChars || OBSERVATION_CONTROL.test(input.excerpt))) {
      throw new Error("a look observation is one short line");
    }
    const record: TrailSource = TrailSourceSchema.parse({ version: 1, id: randomUUID(), sessionId: id, at, ...input });
    recording(() => {
      if (!createState(this.home, P.source(live.zoneId, id, record.id), body(record))) throw new Error(`${P.source(live.zoneId, id, record.id)} already exists`);
    });
    const origin = input.kind === "look" ? "look" : input.kind === "conversation" ? "conversation" : "artifact";
    const drafts: Draft[] = [];
    const steps = new Map<string, string>();
    let current = live.step === null ? null : { id: live.step.id, key: live.step.key, seenAt: live.step.seenAt, made: false };
    let pending: Live["touch"] = null;
    for (const hint of topics) {
      const mapping = origin === "artifact" || hint.confidence === 1 ? "exact" : "inferred";
      if (hint.skill === null || (mapping === "inferred" && (hint.confidence < T.inferredConfidence || hint.reason.trim() === ""))) {
        drafts.push({ at, kind: "gap", id: randomUUID(), topic: hint.topic, sourceId: record.id });
        continue;
      }
      const key = skillKey(hint.skill);
      if (current?.key === key) {
        if (current.made) continue;
        if (now - current.seenAt >= MINUTE) {
          drafts.push({ at, kind: "touch", stepId: current.id, sourceId: record.id });
          current.seenAt = now;
          live.touch = null;
          pending = null;
        } else {
          pending = { stepId: current.id, sourceId: record.id, at: now };
        }
        continue;
      }
      const step: TrailStep = {
        id: randomUUID(),
        skill: hint.skill,
        firstSeenAt: at,
        lastSeenAt: at,
        directionId: live.direction,
        origin,
        mapping,
        topic: hint.topic,
        reason: hint.reason,
        sourceIds: [record.id],
        revisitOf: steps.get(key) ?? live.bySkill.get(key) ?? null,
      };
      drafts.push({ at, kind: "visit", step });
      steps.set(key, step.id);
      current = { id: step.id, key, seenAt: now, made: true };
      pending = null;
    }
    const observed = input.kind === "look" ? { sourceId: record.id, text: input.excerpt, at } : null;
    if (drafts.length > 0 || observed !== null) this.commit(id, live, drafts, observed === null ? {} : { latestObservation: observed }, false);
    if (pending !== null) live.touch = pending;
  }

  /** A direction or handoff marker, once per idempotency key in this session. Ended sessions accept late results. */
  decision(id: string, event: DecisionEventInput, idempotencyKey: string): void {
    const input = DecisionEventInputSchema.parse(event);
    if (idempotencyKey !== decisionKey(input)) throw new Error("that decision's idempotency key doesn't match it");
    const live = this.open(id, true);
    if (live.keys.has(idempotencyKey)) return;
    if (input.kind === "handoff") for (const sourceId of input.sourceIds) this.source(live.zoneId, id, sourceId);
    this.commit(id, live, [{ at: iso(this.now()), ...input }], {}, false);
  }

  /** The user's explicit mapping of an unmapped topic: a user-mapped visit linked to the gap. No tree change. */
  mapGap(id: string, gapId: string, skill: SkillRef): void {
    const ref = SkillRefSchema.parse(skill);
    const live = this.open(id, true);
    const gap = live.gaps.get(gapId);
    if (gap === undefined) throw new Error("there's no such unmapped topic in this session");
    if (live.mapped.has(gapId)) throw new Error("that topic is already mapped");
    const at = iso(this.now());
    const step: TrailStep = {
      id: randomUUID(),
      skill: ref,
      firstSeenAt: at,
      lastSeenAt: at,
      directionId: live.direction,
      origin: "user-map",
      mapping: "user",
      topic: gap.topic,
      reason: "",
      sourceIds: [gap.sourceId],
      revisitOf: live.bySkill.get(skillKey(ref)) ?? null,
    };
    this.commit(id, live, [{ at, kind: "map-gap", gapId, step }], {}, false);
  }

  /** The inline trail: latest six visits, bounded markers and unmapped gaps, committed only. */
  current(id: string | null): TrailView | null {
    if (id === null) return null;
    const live = this.open(id, true);
    return {
      sessionId: id,
      zoneId: live.zoneId,
      directionId: live.direction,
      visits: live.visits,
      markers: live.markers,
      gaps: [...live.gaps.values()].filter((g) => !live.mapped.has(g.id)).slice(-T.recentGaps),
      eventCount: live.meta.eventCount,
    };
  }

  meta(id: string | null): SessionMeta | null {
    return id === null ? null : this.open(id, true).meta;
  }

  /** One session's committed events in order, up to 50 from one disk page per call. */
  read(zoneId: string, sessionId: string, cursor: string | null): TrailPage {
    const zid = checkedId(zoneId, "zone");
    const sid = checkedId(sessionId, "session");
    const meta = this.readMeta(zid, sid);
    if (meta === null) throw new Error("there's no such session in this zone");
    let page = 0;
    let seq = 0;
    if (cursor !== null) {
      const c = decode(cursor, TrailCursorSchema);
      if (c.z !== zid || c.s !== sid) throw new Error("that page link is out of date - open the list again");
      page = c.p;
      seq = c.q;
    }
    const events: TrailEvent[] = [];
    let next: string | null = null;
    if (page < meta.eventPages) {
      const stored = this.eventPage(zid, sid, page);
      if (stored === null) throw new Error(`${P.events(zid, sid, page)} is missing - Dum left this session as it is`);
      const committed = stored.events.filter((e) => e.seq >= seq && e.seq < meta.eventCount);
      let size = jsonBytes({ session: meta, events: [], next: "x".repeat(512) });
      for (const e of committed) {
        const n = jsonBytes(e) + 1;
        if (events.length >= T.queryRows || size + n > T.queryBytes) break;
        events.push(e);
        size += n;
      }
      const after = events.length > 0 ? events.at(-1)!.seq + 1 : seq;
      if (after < meta.eventCount) next = encode({ k: "trail", z: zid, s: sid, p: events.length < committed.length ? page : page + 1, q: after });
    }
    return { session: meta, events, next };
  }

  source(zoneId: string, sessionId: string, sourceId: string): TrailSource {
    const zid = checkedId(zoneId, "zone");
    const sid = checkedId(sessionId, "session");
    const rel = P.source(zid, sid, checkedId(sourceId, "source"));
    const record = load(this.home, rel, T.sourceBytes, TrailSourceSchema);
    if (record === null || record.id !== sourceId || record.sessionId !== sid) throw new Error("there's no such source in this session");
    return record;
  }

  /**
   * Sessions newest first, for one zone or all, filtered by start date and skill. Each zone reads at
   * most one story page per call past its starting point; the cursor is the last key covered, so
   * sessions added meanwhile (always newer) never shift what's left.
   */
  story(query: StoryQuery): StoryPage {
    const q = StoryQuerySchema.parse(query);
    const wanted = q.skill === null ? null : skillKey(q.skill);
    const filter = sha(JSON.stringify([q.zoneId, wanted, q.from, q.to])).slice(0, 16);
    let bound: Key | null = null;
    if (q.cursor !== null) {
      const c = decode(q.cursor, StoryCursorSchema);
      if (c.f !== filter) throw new Error("that page link is out of date - open the list again");
      bound = c.b;
    }
    const candidates: { key: Key; row: StoryRow }[] = [];
    let floor: Key | null = null;
    for (const zid of q.zoneId === null ? this.zoneIds() : [q.zoneId]) {
      const { index } = this.catalog(zid);
      if (index.sessions === 0) continue;
      const head = this.storyHead(zid);
      const pages = new Map<number, StoryRow[]>();
      const rowAt = (i: number): StoryRow => {
        const p = Math.floor(i / T.indexIds);
        let rows = pages.get(p);
        if (rows === undefined) {
          rows = this.storyRows(zid, p, head);
          pages.set(p, rows);
        }
        return rows[i % T.indexIds]!;
      };
      // Start order is catalog order, so the rows below the bound and up to `to` are a prefix.
      let lo = 0;
      let hi = index.sessions;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const row = rowAt(mid);
        if ((bound === null || compare([row.startedAt, zid, mid], bound) < 0) && (q.to === null || row.startedAt <= q.to)) lo = mid + 1;
        else hi = mid;
      }
      if (lo === 0) continue;
      const first = Math.floor((lo - 1) / T.indexIds) * T.indexIds;
      let edge: Key | null = null;
      let done = first === 0;
      for (let i = lo - 1; i >= first; i--) {
        const row = rowAt(i);
        if (q.from !== null && row.startedAt < q.from) {
          done = true;
          break;
        }
        const key: Key = [row.startedAt, zid, i];
        if (wanted === null || row.preview.some((s) => skillKey(s) === wanted) || (row.previewMore > 0 && this.hasSkill(zid, row.sessionId, wanted))) {
          candidates.push({ key, row });
        }
        edge = key;
      }
      if (!done && edge !== null && (floor === null || compare(edge, floor) > 0)) floor = edge;
    }
    // Only keys every zone has covered are final; the rest come on the next page.
    const ready = candidates.filter((c) => floor === null || compare(c.key, floor) >= 0).sort((a, b) => compare(b.key, a.key));
    const rows: StoryRow[] = [];
    let size = jsonBytes({ rows: [], next: "x".repeat(512) });
    let last: Key | null = null;
    let cut = false;
    for (const c of ready) {
      const n = jsonBytes(c.row) + 1;
      if (rows.length >= T.queryRows || size + n > T.queryBytes) {
        cut = true;
        break;
      }
      rows.push(c.row);
      size += n;
      last = c.key;
    }
    const nextBound = cut ? last : floor;
    return { rows, next: nextBound === null ? null : encode({ k: "story", f: filter, b: nextBound }) };
  }

  /** Restart: reconcile each zone's catalog and close unended sessions at their last durable activity. */
  recover(): void {
    const problems: string[] = [];
    for (const zid of this.zoneIds()) {
      try {
        const { index, last } = this.catalog(zid);
        const ids = new Set([index.activeSessionId, last?.ids.at(-1) ?? null].filter((s): s is string => s !== null));
        for (const sid of ids) {
          if (this.readMeta(zid, sid)?.endedAt !== null) continue;
          this.where.set(sid, zid);
          this.end(sid, "interrupted");
        }
        const after = this.catalog(zid);
        const settled: SessionIndex = { ...after.index, activeSessionId: null };
        if (after.index.pages > 0 && JSON.stringify(after.stored) !== JSON.stringify(settled)) {
          recording(() => writeState(this.home, P.index(zid), body(settled)));
        }
      } catch (err) {
        problems.push(`zone ${zid}: ${(err as Error).message}`);
      }
    }
    if (problems.length > 0) throw new Error(`couldn't close every earlier session - ${problems.join("; ")}`);
  }

  // -- appending -----------------------------------------------------------

  /**
   * Append events (after any pending touch) and write the meta. Pages first: a failure drops the
   * loaded state, and the next load adopts whatever complete pages reached the disk.
   */
  private commit(id: string, live: Live, drafts: Draft[], patch: Partial<SessionMeta>, flush: boolean): void {
    const all: Draft[] = (drafts.length > 0 || flush) && live.touch !== null
      ? [{ at: iso(live.touch.at), kind: "touch", stepId: live.touch.stepId, sourceId: live.touch.sourceId }, ...drafts]
      : drafts;
    type Write = { page: number; events: TrailEvent[]; create: boolean; dirty: boolean };
    let cur: Write | null = live.meta.eventPages === 0 ? null : { page: live.meta.eventPages - 1, events: [...live.page], create: false, dirty: false };
    let size = live.pageBytes;
    let count = live.meta.eventCount;
    const writes: Write[] = [];
    const added: TrailEvent[] = [];
    for (const draft of all) {
      const e = TrailEventSchema.parse({ seq: count, ...draft });
      const n = jsonBytes(e) + 1;
      if (cur === null || cur.events.length >= T.pageEvents || size + n > T.pageBytes) {
        if (cur?.dirty) writes.push(cur);
        cur = { page: cur === null ? 0 : cur.page + 1, events: [], create: true, dirty: true };
        size = jsonBytes({ version: 1, sessionId: id, page: cur.page, events: [] });
      }
      cur.events.push(e);
      cur.dirty = true;
      size += n;
      count++;
      added.push(e);
    }
    if (cur?.dirty) writes.push(cur);
    const activity = Math.max(live.activityAt, live.activity ?? 0);
    const meta = SessionMetaSchema.parse({
      ...live.meta,
      lastActivityAt: iso(activity),
      ...patch,
      revision: live.meta.revision + 1,
      eventPages: cur === null ? 0 : cur.page + 1,
      eventCount: count,
    });
    try {
      for (const w of writes) {
        const rel = P.events(live.zoneId, id, w.page);
        const text = body(EventPageSchema.parse({ version: 1, sessionId: id, page: w.page, events: w.events }));
        if (!w.create) writeState(this.home, rel, text);
        else if (!createState(this.home, rel, text)) throw new Error(`${rel} already exists`);
      }
      writeState(this.home, P.meta(live.zoneId, id), body(meta));
    } catch (err) {
      this.live.delete(id);
      throw new Error(`couldn't record the trail: ${(err as Error).message}`);
    }
    if (all !== drafts) live.touch = null;
    for (const e of added) apply(live, e);
    live.meta = meta;
    live.page = cur?.events ?? [];
    live.pageBytes = size;
    live.activityAt = Date.parse(meta.lastActivityAt);
    live.activity = null;
  }

  /** A session ready for appending, loaded from disk when this host hasn't got it. */
  private open(id: string, ended: boolean): Live {
    checkedId(id, "session");
    const live = this.live.get(id) ?? this.restore(this.zoneOf(id), id);
    if (!ended && live.meta.endedAt !== null) throw new Error("that session has ended");
    return live;
  }

  /** Replay a session's pages; complete pages a crash left ahead of the meta are adopted. */
  private restore(zoneId: string, id: string): Live {
    const meta = this.readMeta(zoneId, id);
    if (meta === null) throw new Error("there's no such session");
    const live = blank(zoneId, meta);
    let count = 0;
    let pages = 0;
    for (let p = 0; ; p++) {
      const page = this.eventPage(zoneId, id, p);
      if (page === null) {
        if (p < meta.eventPages) throw new Error(`${P.events(zoneId, id, p)} is missing - Dum left this session as it is`);
        break;
      }
      for (const e of page.events) {
        if (e.seq !== count) throw new Error(`${P.events(zoneId, id, p)} is out of sequence - Dum left this session as it is`);
        apply(live, e);
        count++;
      }
      pages = p + 1;
      live.page = page.events;
      live.pageBytes = jsonBytes(page);
    }
    if (count < meta.eventCount) throw new Error(`${P.meta(zoneId, id)} counts events its pages don't have - Dum left this session as it is`);
    if (count !== meta.eventCount || pages !== meta.eventPages) {
      const adopted = SessionMetaSchema.parse({ ...meta, revision: meta.revision + 1, eventPages: pages, eventCount: count });
      recording(() => writeState(this.home, P.meta(zoneId, id), body(adopted)));
      live.meta = adopted;
    }
    this.remember(id, live);
    return live;
  }

  private remember(id: string, live: Live): void {
    this.live.delete(id);
    this.live.set(id, live);
    if (this.live.size <= KEEP_LOADED) return;
    for (const [other, l] of this.live) {
      if (other !== id && l.meta.endedAt !== null) {
        this.live.delete(other);
        return;
      }
    }
  }

  // -- reading records ---------------------------------------------------------

  /** The catalog header as stored and as its pages say it is (a crash can leave a page ahead of it). */
  private catalog(zoneId: string): { stored: SessionIndex; index: SessionIndex; last: SessionIndexPage | null } {
    const stored = load(this.home, P.index(zoneId), T.metaBytes, SessionIndexSchema) ?? { version: 1, pages: 0, sessions: 0, activeSessionId: null };
    let pages = stored.pages;
    while (this.indexPage(zoneId, pages) !== null) pages++;
    const last = pages > 0 ? this.indexPage(zoneId, pages - 1) : null;
    if (pages > 0 && last === null) throw new Error(`${P.indexPage(zoneId, pages - 1)} is missing - Dum left the catalog as it is`);
    const sessions = last === null ? 0 : (pages - 1) * T.indexIds + last.ids.length;
    return { stored, index: { ...stored, pages, sessions }, last };
  }

  private indexPage(zoneId: string, page: number): SessionIndexPage | null {
    const stored = load(this.home, P.indexPage(zoneId, page), T.indexBytes, SessionIndexPageSchema);
    if (stored !== null && stored.page !== page) throw new Error(`${P.indexPage(zoneId, page)} is unreadable - Dum left it as it is`);
    return stored;
  }

  private readMeta(zoneId: string, id: string): SessionMeta | null {
    const meta = load(this.home, P.meta(zoneId, id), T.metaBytes, SessionMetaSchema);
    if (meta !== null && (meta.id !== id || meta.zoneId !== zoneId)) throw new Error(`${P.meta(zoneId, id)} is unreadable - Dum left it as it is`);
    return meta;
  }

  private eventPage(zoneId: string, id: string, page: number): EventPage | null {
    const stored = load(this.home, P.events(zoneId, id, page), T.pageBytes, EventPageSchema);
    if (stored !== null && (stored.sessionId !== id || stored.page !== page)) throw new Error(`${P.events(zoneId, id, page)} is unreadable - Dum left it as it is`);
    return stored;
  }

  /** Every committed event of a session, in order. */
  private *events(zoneId: string, meta: SessionMeta): Generator<TrailEvent> {
    for (let p = 0; p < meta.eventPages; p++) {
      const page = this.eventPage(zoneId, meta.id, p);
      if (page === null) throw new Error(`${P.events(zoneId, meta.id, p)} is missing - Dum left this session as it is`);
      for (const e of page.events) if (e.seq < meta.eventCount) yield e;
    }
  }

  private hasSkill(zoneId: string, sessionId: string, key: string): boolean {
    const meta = this.readMeta(zoneId, sessionId);
    if (meta === null) return false;
    for (const e of this.events(zoneId, meta)) if ((e.kind === "visit" || e.kind === "map-gap") && skillKey(e.step.skill) === key) return true;
    return false;
  }

  private zoneOf(id: string): string {
    const known = this.where.get(id);
    if (known !== undefined) return known;
    for (const zid of this.zoneIds()) {
      if (readState(this.home, P.meta(zid, id), T.metaBytes + 1) === null) continue;
      this.where.set(id, zid);
      return zid;
    }
    throw new Error("there's no such session");
  }

  private zoneIds(): string[] {
    const root = join(this.home, "zones");
    try {
      if (lstatSync(root).isSymbolicLink()) throw new Error(`${root} is a symlink - Dum won't follow it`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return readdirSync(root).filter((name) => IdSchema.safeParse(name).success).sort();
  }

  // -- story cache -------------------------------------------------------------

  private storyHead(zoneId: string): StoryHead {
    const raw = readState(this.home, P.storyHead(zoneId), T.metaBytes + 1);
    if (raw === null) return { version: 1, generation: randomUUID(), pages: 0, revision: 0 };
    try {
      return StoryHeadSchema.parse(JSON.parse(raw));
    } catch {
      return this.rebuild(zoneId);
    }
  }

  /** A fresh generation from the authoritative records, then the head swaps to it. */
  private rebuild(zoneId: string): StoryHead {
    const { index } = this.catalog(zoneId);
    const head: StoryHead = { version: 1, generation: randomUUID(), pages: index.pages, revision: 0 };
    for (let p = 0; p < index.pages; p++) {
      const ids = this.indexPage(zoneId, p)?.ids ?? [];
      const rows = ids.map((sid) => this.row(zoneId, sid));
      this.cache(zoneId, p, { version: 1, generation: head.generation, page: p, rows });
    }
    this.cacheHead(zoneId, head);
    return head;
  }

  /** One catalog page's story rows; a row whose session moved on since is recomputed and cached. */
  private storyRows(zoneId: string, page: number, head: StoryHead): StoryRow[] {
    const ids = this.indexPage(zoneId, page)?.ids;
    if (ids === undefined) throw new Error(`${P.indexPage(zoneId, page)} is missing - Dum left the catalog as it is`);
    let cached: StoryRow[] | null = null;
    try {
      const stored = load(this.home, P.storyPage(zoneId, page), T.storyBytes, StoryCachePageSchema);
      if (stored !== null && stored.generation === head.generation && stored.page === page
        && stored.rows.length === ids.length && stored.rows.every((r, i) => r.sessionId === ids[i] && r.zoneId === zoneId)) {
        cached = stored.rows;
      }
    } catch {
      // A damaged cache page is recomputed from the sessions, never trusted.
    }
    let changed = cached === null;
    const rows = ids.map((sid, i) => {
      const meta = this.readMeta(zoneId, sid);
      if (meta === null) throw new Error(`${P.meta(zoneId, sid)} is missing - Dum left this session as it is`);
      const row = cached?.[i];
      if (row !== undefined && row.sourceRevision === meta.revision) return row;
      changed = true;
      return this.row(zoneId, sid, meta);
    });
    if (changed) {
      this.cache(zoneId, page, { version: 1, generation: head.generation, page, rows });
      head.pages = Math.max(head.pages, page + 1);
      head.revision++;
      this.cacheHead(zoneId, head);
    }
    return rows;
  }

  private row(zoneId: string, sessionId: string, known?: SessionMeta): StoryRow {
    const meta = known ?? this.readMeta(zoneId, sessionId);
    if (meta === null) throw new Error(`${P.meta(zoneId, sessionId)} is missing - Dum left this session as it is`);
    let visits = 0;
    const gaps = new Set<string>();
    const done = new Set<string>();
    const reviewed = new Set<string>();
    const skills = new Map<string, SkillRef>();
    for (const e of this.events(zoneId, meta)) {
      if (e.kind === "visit" || e.kind === "map-gap") {
        visits++;
        if (!skills.has(skillKey(e.step.skill))) skills.set(skillKey(e.step.skill), e.step.skill);
        if (e.kind === "map-gap") gaps.delete(e.gapId);
      } else if (e.kind === "gap") gaps.add(e.id);
      else if (e.kind === "handoff" && e.phase === "done") done.add(e.handoffId);
      else if (e.kind === "handoff" && e.phase === "reviewed") reviewed.add(e.handoffId);
    }
    const preview = [...skills.values()].slice(0, T.preview);
    return {
      sessionId: meta.id,
      zoneId,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      directionId: meta.directionId,
      sourceRevision: meta.revision,
      visits,
      gaps: gaps.size,
      handoffsDone: done.size,
      handoffsReviewed: reviewed.size,
      preview,
      previewMore: skills.size - preview.length,
    };
  }

  /**
   * Cache writes are best effort: a failed one (a full disk, a symlink) leaves the cache stale,
   * and the next read recomputes from the sessions, which stay authoritative.
   */
  private cache(zoneId: string, page: number, stored: z.infer<typeof StoryCachePageSchema>): void {
    try {
      writeState(this.home, P.storyPage(zoneId, page), body(StoryCachePageSchema.parse(stored)));
    } catch {
      // stale cache, detected by generation and sourceRevision
    }
  }

  private cacheHead(zoneId: string, head: StoryHead): void {
    try {
      writeState(this.home, P.storyHead(zoneId), body(head));
    } catch {
      // stale cache, detected by generation and sourceRevision
    }
  }
}

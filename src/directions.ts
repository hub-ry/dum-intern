// A zone's goal alignment and its agreed direction (docs/circle-design.md §4). The host, under H's
// writer lock, is the only writer; the caller serializes. The registry keeps the goal text: a
// direction stores a snapshot and its SHA-256 for provenance, and every read compares that
// fingerprint with the committed goal, so a direction for an older goal is never current, even
// after a crash between the registry write and ours. Accepting a direction is intent only: these
// records live under H/zones/<id>/direction and context-corrections.json, and nothing here writes a
// source file, a skill or evidence.

import { createState, readState, writeState } from "./state-files.ts";
import { sha } from "./shared-files.ts";
import { IdSchema } from "./share-types.ts";
import {
  AlignmentAttemptSchema,
  ContextCorrectionsSchema,
  ContextListSchema,
  DELEGATION_LIMITS,
  DirectionHeadSchema,
  DirectionInputSchema,
  DirectionSchema,
} from "./delegation-types.ts";
import type {
  AlignmentAttempt,
  ContextCorrections,
  ContextRef,
  Direction,
  DirectionHead,
  DirectionInput,
  DirectionView,
} from "./delegation-types.ts";
import { ShaSchema, ZoneContextSchema, type ZoneContext } from "./zone-types.ts";
import { randomUUID } from "node:crypto";
import type { z } from "zod";

/** Schemas bound the compact JSON; the file adds its trailing newline. */
const MAX = DELEGATION_LIMITS.recordBytes + 1;
const revisionFile = (zoneId: string, id: string) => `zones/${zoneId}/direction/revisions/${id}.json`;
const body = (v: unknown) => `${JSON.stringify(v)}\n`;

/** Lowercase SHA-256 hex of the goal's UTF-8 bytes. */
export function goalHash(goal: string): string {
  return sha(Buffer.from(goal, "utf8"));
}

/**
 * The id the zone's next attempt gets: stable across reads, so the binding a window shows for
 * "start" is the one `begin` issues, and different after every head write. Formatted as a v4 UUID.
 */
function nextAttemptId(zoneId: string, revision: number, hash: string): string {
  const h = sha(`attempt\u0000${zoneId}\u0000${revision}\u0000${hash}`);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The context revision an attempt starts from: the goal, the correction revision and the refs it
 * was given. The host computes the zone's current one with the same formula.
 */
export function contextRevision(goalHash: string, correctionRevision: number, refs: readonly ContextRef[]): string {
  return sha(JSON.stringify([goalHash, correctionRevision, refs.map((r) => `${r.id}:${r.revision}`).sort()]));
}

function zoneIdOf(id: string): string {
  if (!IdSchema.safeParse(id).success) throw new Error("that isn't one of Dum's zones");
  return id;
}

/** A record, schema-checked; null when absent. Unreadable records stay exactly as they are. */
function load<T>(home: string, rel: string, schema: z.ZodType<T>): T | null {
  let raw: string | null;
  try {
    raw = readState(home, rel, MAX);
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

function recording<T>(what: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    throw new Error(`couldn't save ${what}: ${(err as Error).message}`);
  }
}

export class Directions {
  constructor(private readonly home: string, private readonly now: () => number) {}

  /**
   * Start a new alignment attempt for the zone's committed goal, replacing any pending one. A new
   * goal makes the old direction non-current on disk too; the same goal keeps it (Revise).
   */
  begin(zone: ZoneContext, context: readonly ContextRef[]): DirectionHead {
    const z = ZoneContextSchema.parse(zone);
    const refs = ContextListSchema.parse(context);
    const hash = goalHash(z.goal);
    const was = this.head(z.id);
    const base = was?.revision ?? 0;
    const attempt: AlignmentAttempt = {
      id: nextAttemptId(z.id, base, hash),
      goalHash: hash,
      contextRevision: contextRevision(hash, this.corrections(z.id).revision, refs),
      phase: "reflect",
      reflection: "",
      questions: [],
      options: [],
      context: refs,
    };
    const next: DirectionHead = {
      version: 1,
      revision: base + 1,
      goalHash: hash,
      currentId: was !== null && was.goalHash === hash ? was.currentId : null,
      attempt,
    };
    this.save(z.id, next);
    return next;
  }

  /** Replace the zone's pending attempt (reflection, answers, options, deferral) under its head revision. */
  draft(zoneId: string, expectedRevision: number, attempt: AlignmentAttempt): DirectionHead {
    const id = zoneIdOf(zoneId);
    const next = AlignmentAttemptSchema.parse(attempt);
    const was = this.head(id);
    if (was === null || was.attempt === null) throw new Error("there's no alignment in progress for this zone - start it again");
    if (was.revision !== expectedRevision) throw new Error("this zone's alignment changed meanwhile - Dum didn't save that step");
    if (was.attempt.id !== next.id) throw new Error("that alignment attempt is no longer the pending one");
    if (next.goalHash !== was.goalHash) throw new Error("that alignment is for an older goal - Dum didn't save it");
    const head: DirectionHead = { ...was, revision: was.revision + 1, attempt: next };
    this.save(id, head);
    return head;
  }

  /**
   * Record an explicitly accepted direction as a new immutable revision, then point the head at
   * it. Only for the committed goal, the pending attempt and that attempt's context revision.
   */
  accept(zone: ZoneContext, expectedRevision: number, direction: DirectionInput): Direction {
    const z = ZoneContextSchema.parse(zone);
    const input = DirectionInputSchema.parse(direction);
    const hash = goalHash(z.goal);
    const was = this.head(z.id);
    if (was === null || was.attempt === null) throw new Error("there's no alignment to accept for this zone - start it again");
    if (was.revision !== expectedRevision) throw new Error("this zone's alignment changed meanwhile - nothing accepted");
    if (was.goalHash !== hash || was.attempt.goalHash !== hash) throw new Error("the zone's goal changed since this alignment started - nothing accepted");
    if (input.contextRevision !== was.attempt.contextRevision) throw new Error("the context changed since these options were made - review them again");
    const offered = new Map(was.attempt.context.map((r) => [r.id, JSON.stringify(r)]));
    if (input.context.some((r) => offered.get(r.id) !== JSON.stringify(r))) {
      throw new Error("that direction cites context this alignment wasn't given - nothing accepted");
    }
    const record: Direction = DirectionSchema.parse({
      version: 1,
      id: randomUUID(),
      zoneId: z.id,
      at: new Date(this.now()).toISOString(),
      goal: z.goal,
      goalHash: hash,
      contextRevision: input.contextRevision,
      supersedes: was.currentId,
      ability: input.ability,
      choice: input.choice,
      reviewCriterion: input.reviewCriterion,
      assumptions: input.assumptions,
      context: input.context,
    });
    // The immutable revision first; only the head makes it current.
    recording("the direction", () => {
      if (!createState(this.home, revisionFile(z.id, record.id), body(record))) throw new Error(`${revisionFile(z.id, record.id)} already exists`);
    });
    this.save(z.id, { version: 1, revision: was.revision + 1, goalHash: hash, currentId: record.id, attempt: null });
    return record;
  }

  /** The zone's alignment against its committed goal; `contextRevision` is the host's current one. */
  read(zone: ZoneContext, contextRevision: string): DirectionView {
    const z = ZoneContextSchema.parse(zone);
    if (!ShaSchema.safeParse(contextRevision).success) throw new Error("that context revision isn't one Dum issued");
    const hash = goalHash(z.goal);
    const was = this.head(z.id);
    const fresh = was !== null && was.goalHash === hash;
    let current = fresh && was.currentId !== null ? this.revision(z.id, was.currentId) : null;
    if (current !== null && current.goalHash !== hash) current = null;
    const attempt = fresh && was.attempt !== null && was.attempt.goalHash === hash ? was.attempt : null;
    const working = attempt !== null && (attempt.phase === "reflect" || attempt.phase === "clarify" || attempt.phase === "choose");
    let status: DirectionView["status"];
    if (current !== null) status = working ? "aligning" : "aligned";
    else if (attempt === null) status = "needed";
    else status = working ? "aligning" : attempt.phase === "deferred" ? "deferred" : "needs-backend";
    return {
      zoneId: z.id,
      goalHash: hash,
      status,
      current,
      attempt,
      binding: {
        zoneId: z.id,
        zoneRevision: z.revision,
        goalHash: hash,
        attemptId: attempt?.id ?? nextAttemptId(z.id, was?.revision ?? 0, hash),
        directionRevision: was?.revision ?? 0,
        contextRevision,
      },
      contextChanged: current !== null && current.contextRevision !== contextRevision,
    };
  }

  /** One historical revision, whatever goal it was agreed for. */
  revision(zoneId: string, id: string): Direction {
    const zid = zoneIdOf(zoneId);
    if (!IdSchema.safeParse(id).success) throw new Error("there's no such direction in this zone");
    const record = load(this.home, revisionFile(zid, id), DirectionSchema);
    if (record === null || record.id !== id || record.zoneId !== zid) throw new Error("there's no such direction in this zone");
    return record;
  }

  corrections(zoneId: string): ContextCorrections {
    const id = zoneIdOf(zoneId);
    return load(this.home, `zones/${id}/context-corrections.json`, ContextCorrectionsSchema) ?? { version: 1, revision: 0, ignoredObservationSourceId: null };
  }

  /** Ignore this observation: excluded from decision and mapping inputs until a fresh one replaces it. */
  ignoreObservation(zoneId: string, expectedRevision: number, sourceId: string): ContextCorrections {
    const id = zoneIdOf(zoneId);
    if (!IdSchema.safeParse(sourceId).success) throw new Error("that observation isn't one Dum made");
    const was = this.corrections(id);
    if (was.revision !== expectedRevision) throw new Error("this zone's context changed meanwhile - nothing ignored");
    const next = ContextCorrectionsSchema.parse({ version: 1, revision: was.revision + 1, ignoredObservationSourceId: sourceId });
    recording("the correction", () => writeState(this.home, `zones/${id}/context-corrections.json`, body(next)));
    return next;
  }

  private head(zoneId: string): DirectionHead | null {
    return load(this.home, `zones/${zoneId}/direction/head.json`, DirectionHeadSchema);
  }

  private save(zoneId: string, next: DirectionHead): void {
    const checked = DirectionHeadSchema.parse(next);
    recording("the alignment", () => writeState(this.home, `zones/${zoneId}/direction/head.json`, body(checked)));
  }
}

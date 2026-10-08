// Handoffs (docs/circle-design.md §4): what the user chose to delegate, as immutable versions of
// task / expected result / review, with one head for its lifecycle. The host, under H's writer
// lock, is the only writer; the caller serializes. Storage only: no grants, images, code or
// credentials are kept, a stored target never authorizes a read or write, and nothing here runs
// work. A zone has one current handoff (delegations/current.json), so there's never a queue.
// Restart keeps the facts, not the grants: a ready handoff from an earlier host lifetime needs a
// refresh before Do this, and a running one is closed as interrupted, never replayed.

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createState, readState, writeState } from "./state-files.ts";
import { IdSchema, TokenSchema } from "./share-types.ts";
import {
  DELEGATION_LIMITS,
  HandoffEditSchema,
  HandoffHeadSchema,
  HandoffInputSchema,
  HandoffResultSchema,
  HandoffSchema,
} from "./delegation-types.ts";
import type { Handoff, HandoffEdit, HandoffHead, HandoffInput, HandoffResult, HandoffView } from "./delegation-types.ts";

const L = DELEGATION_LIMITS;
const CurrentSchema = z.object({ version: z.literal(1), id: IdSchema.nullable() }).strict();
/** Compact JSON, so the schemas' byte bounds are the file's, plus its trailing newline. */
const body = (v: unknown) => `${JSON.stringify(v)}\n`;
const FINISHED: readonly HandoffHead["state"][] = ["done", "blocked", "failed", "cancelled", "interrupted"];

function load<T>(home: string, rel: string, max: number, schema: z.ZodType<T>): T | null {
  let raw: string | null;
  try {
    raw = readState(home, rel, max);
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

function recording(write: () => void): void {
  try {
    write();
  } catch (err) {
    throw new Error(`couldn't save the handoff: ${(err as Error).message}`);
  }
}

function checkedId(id: string, what: string): string {
  if (!IdSchema.safeParse(id).success) throw new Error(`there's no such ${what}`);
  return id;
}

export class Delegations {
  /** Handoff id → zone id, learned from every handoff this host touched. */
  private readonly zones = new Map<string, string>();
  /** Handoffs made ready in this host lifetime: only these can be commanded without a refresh. */
  private readonly fresh = new Set<string>();

  constructor(private readonly home: string, private readonly now: () => number) {}

  /**
   * The zone's one ready handoff, from a selected option. An earlier ready one is dismissed; while
   * one is running, nothing new is made ready.
   */
  ready(input: HandoffInput): Handoff {
    const fields = HandoffInputSchema.parse(input);
    const zoneId = fields.zoneId;
    const currentId = this.pointer(zoneId);
    if (currentId !== null) {
      const head = this.head(zoneId, currentId);
      if (head.state === "running") throw new Error("a handoff is already running in this zone - wait for it or stop it first");
      if (head.state === "ready") this.writeHead(zoneId, { ...head, state: "dismissed" });
    }
    const handoff = HandoffSchema.parse({ version: 1, id: randomUUID(), revision: 1, ...fields });
    this.writeVersion(handoff);
    this.writeHead(zoneId, { version: 1, id: handoff.id, revision: 1, requestId: null, state: "ready", changeIds: [], result: "", reviewed: null });
    recording(() => writeState(this.home, `zones/${zoneId}/delegations/current.json`, body({ version: 1, id: handoff.id })));
    this.zones.set(handoff.id, zoneId);
    this.fresh.add(handoff.id);
    return handoff;
  }

  /** A new immutable version with the edited task, expected result or review. Only while ready. */
  edit(id: string, expectedRevision: number, patch: HandoffEdit): Handoff {
    const changes = HandoffEditSchema.parse(patch);
    const { zoneId, head, handoff } = this.find(id);
    if (head.state !== "ready") throw new Error(`that handoff is ${head.state} - only a ready handoff can be edited`);
    if (head.revision !== expectedRevision) throw new Error("that handoff changed meanwhile - nothing edited");
    const next = HandoffSchema.parse({ ...handoff, ...changes, revision: head.revision + 1 });
    this.writeVersion(next);
    this.writeHead(zoneId, { ...head, revision: next.revision });
    return next;
  }

  dismiss(id: string, expectedRevision: number): void {
    const { zoneId, head } = this.find(id);
    if (head.state !== "ready") throw new Error(`that handoff is ${head.state} - only a ready handoff can be dismissed`);
    if (head.revision !== expectedRevision) throw new Error("that handoff changed meanwhile - nothing dismissed");
    this.writeHead(zoneId, { ...head, state: "dismissed" });
    if (this.pointer(zoneId) === id) recording(() => writeState(this.home, `zones/${zoneId}/delegations/current.json`, body({ version: 1, id: null })));
  }

  /**
   * Do this consumes the ready version once: the head records the request before any work runs,
   * so a repeated command for the same version is refused instead of writing twice.
   */
  start(id: string, expectedRevision: number, requestId: string): Handoff {
    if (!TokenSchema.safeParse(requestId).success) throw new Error("that request isn't one Dum issued");
    const { zoneId, head, handoff } = this.find(id);
    if (head.state !== "ready") throw new Error(`that handoff is ${head.state} - Do this runs a ready handoff once`);
    if (head.revision !== expectedRevision) throw new Error("that handoff changed since you saw it - review it again");
    if (this.pointer(zoneId) !== id) throw new Error("that isn't this zone's current handoff");
    if (!this.fresh.has(id)) throw new Error("that handoff is from before Dum restarted - refresh it first");
    this.writeHead(zoneId, { ...head, state: "running", requestId });
    return handoff;
  }

  /**
   * How the commanded request ended, from orchestration and its change receipts. After a restart
   * marked it interrupted, the same request may still attach the receipts it left.
   */
  finish(id: string, requestId: string, result: HandoffResult): void {
    const r = HandoffResultSchema.parse(result);
    const { zoneId, head } = this.find(id);
    if (head.requestId === null || head.requestId !== requestId) throw new Error("that result belongs to another request");
    if (head.state !== "running" && !(head.state === "interrupted" && r.state === "interrupted")) {
      throw new Error(`that handoff already ended (${head.state})`);
    }
    const changeIds = [...new Set([...head.changeIds, ...r.changeIds])];
    this.writeHead(zoneId, { ...head, state: r.state, changeIds, result: r.result || head.result });
  }

  /** The user's verdict on a finished handoff, once. It can say the work didn't advance the goal. */
  review(id: string, expectedRevision: number, verdict: string): void {
    const { zoneId, head } = this.find(id);
    if (!FINISHED.includes(head.state)) throw new Error(`that handoff is ${head.state} - review it once it has finished`);
    if (head.revision !== expectedRevision) throw new Error("that handoff changed since you saw it - nothing reviewed");
    if (head.reviewed !== null) throw new Error("that handoff was already reviewed");
    this.writeHead(zoneId, { ...head, reviewed: { at: new Date(this.now()).toISOString(), verdict } });
  }

  read(zoneId: string, id: string): HandoffView {
    const zid = checkedId(zoneId, "zone");
    const head = this.head(zid, checkedId(id, "handoff"));
    this.zones.set(id, zid);
    return { handoff: this.version(zid, id, head.revision), head, needsRefresh: head.state === "ready" && !this.fresh.has(id), blockers: [] };
  }

  /** The zone's latest undismissed handoff: ready, running, or finished and awaiting or after review. */
  current(zoneId: string): HandoffView | null {
    const zid = checkedId(zoneId, "zone");
    const id = this.pointer(zid);
    if (id === null) return null;
    const view = this.read(zid, id);
    return view.head.state === "dismissed" ? null : view;
  }

  /** After a restart: a running handoff becomes interrupted, never replayed. Returns those, for trail markers. */
  recover(zoneId: string): { id: string; revision: number }[] {
    const zid = checkedId(zoneId, "zone");
    const id = this.pointer(zid);
    if (id === null) return [];
    const head = this.head(zid, id);
    this.zones.set(id, zid);
    if (head.state !== "running") return [];
    this.writeHead(zid, { ...head, state: "interrupted", result: head.result || "Dum stopped before this finished" });
    return [{ id, revision: head.revision }];
  }

  private pointer(zoneId: string): string | null {
    return load(this.home, `zones/${zoneId}/delegations/current.json`, 1024, CurrentSchema)?.id ?? null;
  }

  private head(zoneId: string, id: string): HandoffHead {
    const head = load(this.home, `zones/${zoneId}/delegations/${id}/head.json`, L.handoffHeadBytes + 1, HandoffHeadSchema);
    if (head === null || head.id !== id) throw new Error("there's no such handoff in this zone");
    return head;
  }

  private version(zoneId: string, id: string, revision: number): Handoff {
    const handoff = load(this.home, `zones/${zoneId}/delegations/${id}/versions/${revision}.json`, L.recordBytes + 1, HandoffSchema);
    if (handoff === null || handoff.id !== id || handoff.zoneId !== zoneId || handoff.revision !== revision) {
      throw new Error(`zones/${zoneId}/delegations/${id}/versions/${revision}.json is missing or unreadable - Dum left it as it is`);
    }
    return handoff;
  }

  private find(id: string): { zoneId: string; head: HandoffHead; handoff: Handoff } {
    checkedId(id, "handoff");
    const zoneId = this.zones.get(id) ?? this.locate(id);
    const head = this.head(zoneId, id);
    return { zoneId, head, handoff: this.version(zoneId, id, head.revision) };
  }

  /** The zone holding a handoff this host hasn't touched yet. */
  private locate(id: string): string {
    const root = join(this.home, "zones");
    try {
      if (lstatSync(root).isSymbolicLink()) throw new Error(`${root} is a symlink - Dum won't follow it`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("there's no such handoff");
      throw err;
    }
    for (const zoneId of readdirSync(root)) {
      if (!IdSchema.safeParse(zoneId).success) continue;
      if (readState(this.home, `zones/${zoneId}/delegations/${id}/head.json`, L.handoffHeadBytes + 1) === null) continue;
      this.zones.set(id, zoneId);
      return zoneId;
    }
    throw new Error("there's no such handoff");
  }

  private writeVersion(handoff: Handoff): void {
    const rel = `zones/${handoff.zoneId}/delegations/${handoff.id}/versions/${handoff.revision}.json`;
    recording(() => {
      if (!createState(this.home, rel, body(handoff))) throw new Error(`${rel} already exists`);
    });
  }

  private writeHead(zoneId: string, head: HandoffHead): void {
    const checked = HandoffHeadSchema.parse(head);
    recording(() => writeState(this.home, `zones/${zoneId}/delegations/${checked.id}/head.json`, body(checked)));
  }
}

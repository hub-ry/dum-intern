// Folders the user follows in one zone: a persistent, read-only grant they add through main's
// native folder picker and can remove. The look scans them every tick without a model: it stats
// each enumerated file, hashes only when the stat changed, and re-lists every LOOK.relistEvery
// ticks to find new files. A change is a file whose bytes differ from the last bytes Dum read.

import { lstatSync, type BigIntStats } from "node:fs";
import { z } from "zod";
import { readState, writeState } from "./state-files.ts";
import { Grant, GRANT_LIMITS, Moved, bound, enumerate, parsePath, slice, statKey, unifiedDiff, type Bytes } from "./shared-files.ts";
import { LOOK, type FileSignal } from "./observe-types.ts";
import { IdSchema, type ResourcePath, type Resources, type SourceSnapshot } from "./share-types.ts";
import { IsoSchema, type FollowGrant, type ZoneId } from "./zone-types.ts";

/** Folders per zone, last-read text kept for diffs across them, and the size of follows.json. */
export const FOLLOW_LIMITS = { follows: GRANT_LIMITS.roots, textBytes: 16 * 1024 * 1024, recordBytes: 64 * 1024 } as const;

const StoredSchema = z.object({
  version: z.literal(1),
  follows: z.array(z.object({
    id: IdSchema,
    label: z.string().min(1).max(300),
    root: z.string().min(2).max(4096).startsWith("/"),
    addedAt: IsoSchema,
  }).strict()).max(FOLLOW_LIMITS.follows),
}).strict();
type Stored = z.infer<typeof StoredSchema>["follows"][number];

/**
 * What Dum knows about one followed file: the stat it last saw, the digest of the bytes on disk at
 * that stat, and the digest and text of the bytes it last read. `read` is null for a file found
 * since Dum last read the folder; `text` is null when the memory budget had no room for it.
 */
type Known = { stat: string; sha: string; read: string | null; text: string | null };

type Follow = {
  stored: Stored;
  /** Its files are exactly the keys of `known`, plus pending names once they exist. */
  grant: Grant;
  /** False while the folder is missing or over the limits: no files, no signals. */
  live: boolean;
  known: Map<string, Known>;
  /** Removed files' last-read text, until diff() reports them. */
  removed: Map<string, string | null>;
  /** New names change() is about to create, readable once they exist. */
  pending: Set<string>;
};

export class Follows {
  private readonly follows: Follow[] = [];
  private readonly file: string;
  private ticks = 0;
  private textBytes = 0;

  constructor(
    private readonly home: string,
    private readonly zoneId: ZoneId,
  ) {
    IdSchema.parse(zoneId);
    this.file = `zones/${zoneId}/follows.json`;
    const body = readState(home, this.file, FOLLOW_LIMITS.recordBytes);
    if (body === null) return;
    let stored: Stored[];
    try {
      stored = StoredSchema.parse(JSON.parse(body)).follows;
    } catch (err) {
      throw new Error(`${this.file} is damaged and was left as it is: ${(err as Error).message}`);
    }
    let dropped = false;
    for (const s of stored) {
      const f: Follow = { stored: s, grant: new Grant(s.id, "folder", s.root, []), live: false, known: new Map(), removed: new Map(), pending: new Set() };
      const where = f.grant.where();
      if (where === "moved") {
        dropped = true;
        continue;
      }
      this.follows.push(f);
      if (where === "here") this.baseline(f, null);
    }
    if (dropped) this.save();
  }

  list(): FollowGrant[] {
    return this.follows.map((f) => ({ id: f.stored.id, zoneId: this.zoneId, label: f.stored.label, addedAt: f.stored.addedAt, files: f.known.size }));
  }

  /** Follow a folder the user chose with main's native picker. Trusted main input only. */
  async add(authorizedPath: string): Promise<FollowGrant> {
    const grant = Grant.open(authorizedPath, "folder");
    for (const f of this.follows) {
      if (f.stored.root === grant.root) return this.list().find((g) => g.id === f.stored.id)!;
      if (grant.root.startsWith(`${f.stored.root}/`) || f.stored.root.startsWith(`${grant.root}/`)) {
        throw new Error(`${grant.label} overlaps ${f.stored.label}, which this zone already follows`);
      }
    }
    if (this.follows.length >= FOLLOW_LIMITS.follows) throw new Error(`a zone can follow at most ${FOLLOW_LIMITS.follows} folders`);
    const stored: Stored = { id: grant.id, label: grant.label, root: grant.root, addedAt: new Date().toISOString() };
    const f: Follow = { stored, grant, live: false, known: new Map(), removed: new Map(), pending: new Set() };
    this.baseline(f, [...grant.files]);
    this.follows.push(f);
    try {
      this.save();
    } catch (err) {
      this.drop(f);
      throw err;
    }
    return this.list().find((g) => g.id === grant.id)!;
  }

  remove(id: string): void {
    const f = this.follows.find((x) => x.stored.id === id);
    if (!f) throw new Error("that folder isn't followed in this zone");
    this.drop(f);
    this.save();
  }

  /** One tick of the look over every followed folder. */
  async scan(): Promise<FileSignal[]> {
    this.ticks++;
    const relist = this.ticks % LOOK.relistEvery === 0;
    const out: FileSignal[] = [];
    let dropped = false;
    for (const f of [...this.follows]) {
      const where = f.grant.where();
      if (where === "moved") {
        // Its location changed since the user chose it: the grant ends and must be made again.
        this.drop(f);
        dropped = true;
        continue;
      }
      if (where === "missing") {
        this.suspend(f);
        continue;
      }
      if (!f.live) {
        // Back after being missing or over the limits: start again from what is there now.
        this.baseline(f, null);
        continue;
      }
      for (const [rel, k] of f.known) {
        const path = `${f.stored.id}/${rel}`;
        let st: BigIntStats | null = null;
        try {
          st = lstatSync(`${f.stored.root}/${rel}`, { bigint: true });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        }
        if (!st?.isFile()) {
          this.forget(f, rel);
          f.removed.set(rel, k.text);
          out.push({ path, kind: "removed", sha: null });
          continue;
        }
        if (statKey(st) === k.stat) continue;
        let bytes: Bytes;
        try {
          bytes = f.grant.snapshot(rel);
        } catch {
          // Now behind a symlink, binary, oversized or gone mid-read: it leaves the followed set.
          this.forget(f, rel);
          continue;
        }
        k.stat = bytes.stat;
        // The same bytes saved again, or back to what Dum read, is not a change.
        const same = bytes.sha === k.read || bytes.sha === k.sha;
        k.sha = bytes.sha;
        if (!same) out.push({ path, kind: "saved", sha: bytes.sha });
      }
      if (!relist) continue;
      let names: string[];
      try {
        names = enumerate(f.stored.root);
      } catch {
        // Over the limits now: the follow rests until the folder fits again, rather than silently
        // following part of it.
        this.suspend(f);
        continue;
      }
      for (const rel of names) {
        if (f.known.has(rel)) continue;
        f.grant.files.add(rel);
        let bytes: Bytes;
        try {
          bytes = f.grant.snapshot(rel);
        } catch {
          f.grant.files.delete(rel); // not text Dum can read
          continue;
        }
        f.pending.delete(rel);
        f.removed.delete(rel);
        f.known.set(rel, { stat: bytes.stat, sha: bytes.sha, read: null, text: null });
        out.push({ path: `${f.stored.id}/${rel}`, kind: "new", sha: bytes.sha });
      }
    }
    if (dropped) this.save();
    return out;
  }

  /**
   * Bounded unified diffs against the last bytes Dum read, for the signals scan() gave. Reading a
   * file here makes its current bytes the new last read. Files that vanished or stopped being
   * readable since the scan are left out.
   */
  async diff(files: readonly FileSignal[]): Promise<{ path: ResourcePath; diff: string }[]> {
    const out: { path: ResourcePath; diff: string }[] = [];
    for (const signal of files) {
      const parsed = parsePath(signal.path);
      const f = parsed && this.follows.find((x) => x.stored.id === parsed.id);
      if (!parsed || !f?.live) continue;
      if (signal.kind === "removed") {
        if (!f.removed.has(parsed.rel)) continue;
        const before = f.removed.get(parsed.rel)!;
        f.removed.delete(parsed.rel);
        out.push({ path: signal.path, diff: before === null ? `${signal.path} was removed` : bound(unifiedDiff(signal.path, before, null)) });
        continue;
      }
      const k = f.known.get(parsed.rel);
      if (!k) continue;
      const evicted = k.read !== null && k.text === null;
      const before = k.text;
      let bytes: Bytes;
      try {
        bytes = this.guard(f, () => this.take(f, parsed.rel));
      } catch {
        continue;
      }
      const diff = unifiedDiff(signal.path, before, bytes.text);
      if (!diff) continue;
      const note = evicted ? `${signal.path}: Dum kept no earlier copy, so this shows the whole file\n` : "";
      out.push({ path: signal.path, diff: `${note}${bound(diff)}` });
    }
    return out;
  }

  /** The followed folders as resources: every enumerated text file, by `<follow-id>/<relative>`. */
  resources(): Resources {
    return {
      list: () => this.follows.flatMap((f) => [...f.known.keys()].map((rel) => `${f.stored.id}/${rel}`)),
      file: async (path) => this.snapshot(path),
      read: async (path, from, to) => {
        const snap = this.snapshot(path);
        return slice(path, snap.text, snap.sha, from, to);
      },
      target: async (path) => {
        const { f, rel } = this.find(path);
        const known = f.grant.files.has(rel);
        const target = this.guard(f, () => f.grant.target(rel));
        // target() let a new name join the grant; it stays pending until it exists and is read.
        if (!known) {
          f.grant.files.delete(rel);
          f.pending.add(rel);
        }
        return target;
      },
    };
  }

  private snapshot(path: ResourcePath): SourceSnapshot {
    const { f, rel } = this.find(path);
    const bytes = this.guard(f, () => this.take(f, rel));
    return { path, sourcePath: `${f.stored.root}/${rel}`, text: bytes.text, sha: bytes.sha, complete: true };
  }

  /** Read a followed (or just created) file and remember its bytes as the last Dum read. */
  private take(f: Follow, rel: string): Bytes {
    const fresh = !f.known.has(rel);
    if (fresh && !f.pending.has(rel)) throw new Error(`${f.stored.id}/${rel} isn't a file in ${f.stored.label} yet`);
    if (fresh) f.grant.files.add(rel);
    let bytes: Bytes;
    try {
      bytes = f.grant.snapshot(rel);
    } catch (err) {
      if (fresh) f.grant.files.delete(rel);
      throw err;
    }
    f.pending.delete(rel);
    const k = f.known.get(rel) ?? { stat: bytes.stat, sha: bytes.sha, read: null, text: null };
    f.known.set(rel, k);
    if (k.text !== null) this.textBytes -= Buffer.byteLength(k.text);
    const size = Buffer.byteLength(bytes.text);
    const keep = this.textBytes + size <= FOLLOW_LIMITS.textBytes;
    if (keep) this.textBytes += size;
    Object.assign(k, { stat: bytes.stat, sha: bytes.sha, read: bytes.sha, text: keep ? bytes.text : null });
    return bytes;
  }

  private find(path: ResourcePath): { f: Follow; rel: string } {
    const parsed = parsePath(path);
    const f = parsed && this.follows.find((x) => x.stored.id === parsed.id);
    if (!parsed || !f) throw new Error(`${path} isn't in a folder this zone follows`);
    if (!f.live) throw new Error(`${f.stored.label} isn't available right now`);
    return { f, rel: parsed.rel };
  }

  /** A folder that moved since the user chose it stops being followed, and must be added again. */
  private guard<T>(f: Follow, run: () => T): T {
    try {
      return run();
    } catch (err) {
      if (err instanceof Moved && this.follows.includes(f)) {
        this.drop(f);
        this.save();
      }
      throw err;
    }
  }

  /**
   * Enumerate (unless given the names) and read every file once: those bytes are what later
   * changes are measured against.
   */
  private baseline(f: Follow, names: string[] | null): void {
    this.suspend(f);
    let list = names;
    if (!list) {
      try {
        list = enumerate(f.stored.root);
      } catch {
        return; // over the limits: resting until it fits
      }
    }
    f.live = true;
    for (const rel of list) {
      f.pending.add(rel);
      try {
        this.take(f, rel);
      } catch {
        f.pending.delete(rel); // binary, oversized or unreadable: not followed
      }
    }
  }

  private forget(f: Follow, rel: string): void {
    const k = f.known.get(rel);
    if (k?.text) this.textBytes -= Buffer.byteLength(k.text);
    f.known.delete(rel);
    f.grant.files.delete(rel);
  }

  private suspend(f: Follow): void {
    for (const rel of [...f.known.keys()]) this.forget(f, rel);
    f.grant.files.clear();
    f.removed.clear();
    f.pending.clear();
    f.live = false;
  }

  private drop(f: Follow): void {
    this.suspend(f);
    this.follows.splice(this.follows.indexOf(f), 1);
  }

  private save(): void {
    writeState(this.home, this.file, `${JSON.stringify({ version: 1, follows: this.follows.map((f) => f.stored) }, null, 2)}\n`);
  }
}

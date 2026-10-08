// The host side of the look (docs/llm-setup-design.md §6.2): turns 3-second ticks and followed-file scans
// into code, app and typing triggers, and makes at most one bounded helper call for them.

import { createHash } from "node:crypto";
import { LOOK } from "./observe-types.ts";
import type { Picture } from "./agent/types.ts";
import type { AmbientInput, AmbientResult, AppSignal, FileSignal, Tick, Trigger } from "./observe-types.ts";
import type { RequestBinding, ResourcePath } from "./share-types.ts";
import type { ZoneContext } from "./zone-types.ts";

/** Diff budget for one ambient call. */
export const AMBIENT_FILES = { count: 4, bytes: 96 * 1024 } as const;

export type AmbientStatus = "watching" | "checking" | "blocked" | "failed";

/** The live zone an ambient call is bound to; `practicing` is true while a suggested project is active. */
export type AmbientContext = { zone: ZoneContext; binding: RequestBinding; practicing: boolean };

export type AmbientOptions = {
  now: () => number;
  /** No active zone, first-run goal, no backend, a turn in flight, a decision waiting, or a stale epoch. */
  blocked: (tick: Tick) => boolean;
  /** `Follows.scan()` for the tick's zone. */
  scan: () => Promise<readonly FileSignal[]>;
  /** Bounded diffs against the last bytes Dum read. */
  diff: (paths: readonly ResourcePath[]) => Promise<readonly { path: ResourcePath; diff: string }[]>;
  /** One frame from main, or null when none is available. */
  frame: () => Promise<Picture | null>;
  /** Null when there is no live zone to bind a call to. */
  context: () => AmbientContext | null;
  /** Screen look is on and the helper can see images. */
  imagesAllowed: () => boolean;
  check: (input: AmbientInput, signal: AbortSignal) => Promise<AmbientResult>;
  /** The aside is already null while a suggested project is active. */
  record: (result: AmbientResult, input: AmbientInput) => Promise<void>;
  status: (status: AmbientStatus) => void;
};

const TRIGGERS: readonly Trigger[] = ["code", "app", "typing"];
const HOUR = 3_600_000;

function appKey(app: AppSignal | null): string | null {
  return app ? `${app.bundleId}#${app.windowId ?? ""}` : null;
}

function cap(files: readonly { path: ResourcePath; diff: string }[]): { path: ResourcePath; diff: string }[] {
  const out: { path: ResourcePath; diff: string }[] = [];
  let left = AMBIENT_FILES.bytes;
  for (const file of files.slice(0, AMBIENT_FILES.count)) {
    if (left <= 0) break;
    const bytes = Buffer.from(file.diff, "utf8");
    const diff = bytes.length <= left ? file.diff : bytes.subarray(0, left).toString("utf8").replace(/\uFFFD$/, "");
    left -= Buffer.byteLength(diff, "utf8");
    out.push({ path: file.path, diff });
  }
  return out;
}

export class Ambient {
  private readonly o: AmbientOptions;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private scope: string | null = null;
  private shown: AmbientStatus | null = null;

  // Code: file signals since the last call, and quiet ticks since the last change.
  private files = new Map<ResourcePath, FileSignal>();
  private quiet = 0;
  // App: the last settled app and a candidate that has to hold for `settleTicks`.
  private settled: string | null = null;
  private candidate: string | null = null;
  private held = 0;
  // Typing: activity of recent ticks on the same app, and the idle run.
  private activity: boolean[] = [];
  private idle = 0;
  private lastApp: string | null = null;

  private readonly ready = new Set<Trigger>();
  private app: AppSignal | null = null;
  private readonly lastBy = new Map<Trigger, number>();
  private readonly sentApps = new Map<string, number>();
  private starts: number[] = [];
  private lastSignature: string | null = null;
  private inFlight: AbortController | null = null;

  constructor(o: AmbientOptions) {
    this.o = o;
  }

  /** Handles one tick; resolves once the tick is processed, not when a call it started finishes. */
  tick(t: Tick): Promise<void> {
    const next = this.queue.then(() => this.step(t));
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.closed = true;
    this.inFlight?.abort();
    this.inFlight = null;
    this.drop();
  }

  private async step(t: Tick): Promise<void> {
    if (this.closed) return;
    const scope = `${t.zoneId}\0${t.epoch}`;
    if (scope !== this.scope) {
      this.scope = scope;
      this.drop();
      this.settled = null;
      this.lastApp = null;
    }
    const signals = await this.o.scan();
    if (this.closed) return;
    if (this.o.blocked(t)) {
      this.drop();
      this.settled = appKey(t.app) ?? this.settled;
      this.lastApp = appKey(t.app);
      this.show("blocked");
      return;
    }
    if (this.shown === "blocked") this.show(this.inFlight ? "checking" : "watching");
    this.observeCode(signals);
    this.observeApp(t);
    this.observeTyping(t);
    this.app = t.app;
    if (!this.inFlight && this.ready.size > 0) await this.maybeCall();
  }

  private drop(): void {
    this.files.clear();
    this.quiet = 0;
    this.candidate = null;
    this.held = 0;
    this.activity = [];
    this.idle = 0;
    this.ready.clear();
  }

  private observeCode(signals: readonly FileSignal[]): void {
    if (signals.length > 0) {
      for (const s of signals) this.files.set(s.path, s);
      this.quiet = 0;
      this.ready.delete("code");
      return;
    }
    if (this.files.size === 0) return;
    this.quiet += 1;
    if (this.quiet >= LOOK.quietTicks) this.ready.add("code");
  }

  private observeApp(t: Tick): void {
    const key = appKey(t.app);
    if (key === null) return;
    if (this.settled === null) {
      this.settled = key;
      return;
    }
    if (key === this.settled) {
      this.candidate = null;
      this.held = 0;
      return;
    }
    if (key === this.candidate) this.held += 1;
    else {
      this.candidate = key;
      this.held = 1;
    }
    if (this.held < LOOK.settleTicks) return;
    this.settled = key;
    this.candidate = null;
    this.held = 0;
    const now = this.o.now();
    const sent = this.sentApps.get(key);
    if (sent !== undefined && now - sent < LOOK.appRepeatMs) return;
    if (this.within("app", now)) return;
    this.ready.add("app");
  }

  private observeTyping(t: Tick): void {
    const key = appKey(t.app);
    if (t.screen === null || key !== this.lastApp) {
      this.activity = [];
      this.idle = 0;
    }
    this.lastApp = key;
    if (t.screen === null) return;
    if (t.screen.changedCells >= LOOK.activeCells) {
      this.activity.push(true);
      this.idle = 0;
    } else {
      this.activity.push(false);
      this.idle += 1;
    }
    const [need, of] = LOOK.activeOf;
    this.activity = this.activity.slice(-(of + LOOK.settleTicks));
    if (this.idle !== LOOK.settleTicks) return;
    const before = this.activity.slice(0, -LOOK.settleTicks).slice(-of);
    if (before.filter(Boolean).length < need) return;
    this.activity = [];
    if (this.within("typing", this.o.now())) return;
    this.ready.add("typing");
  }

  private within(trigger: Trigger, now: number): boolean {
    const last = this.lastBy.get(trigger);
    return last !== undefined && now - last < LOOK.minMs[trigger];
  }

  private async maybeCall(): Promise<void> {
    const now = this.o.now();
    this.starts = this.starts.filter((at) => now - at < HOUR);
    const last = this.starts.at(-1);
    if (last !== undefined && now - last < LOOK.minMs.any) return;
    if (this.starts.length >= LOOK.hourlyCap) return;
    // Code waits out its own interval with its signals kept; the other triggers were dropped inside theirs.
    const triggers = TRIGGERS.filter((tr) => this.ready.has(tr) && !(tr === "code" && this.within("code", now)));
    if (triggers.length === 0) return;
    const context = this.o.context();
    if (!context) {
      this.drop();
      return;
    }

    const signals = triggers.includes("code") ? [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path)) : [];
    const app = this.app;
    const wantsFrame = (triggers.includes("app") || triggers.includes("typing")) && this.o.imagesAllowed();
    for (const tr of triggers) this.ready.delete(tr);
    if (triggers.includes("code")) {
      this.files.clear();
      this.quiet = 0;
    }

    const controller = new AbortController();
    this.inFlight = controller;
    let started = false;
    try {
      const image = wantsFrame ? await this.o.frame() : null;
      if (this.closed || controller.signal.aborted) return;
      const signature = JSON.stringify([
        signals.map((s) => [s.path, s.kind, s.sha]),
        appKey(app),
        image ? createHash("sha256").update(image.data).digest("hex") : null,
      ]);
      if (signature === this.lastSignature) return;
      const files = signals.length > 0 ? cap(await this.o.diff(signals.map((s) => s.path))) : [];
      if (this.closed || controller.signal.aborted) return;

      const input: AmbientInput = { zone: context.zone, binding: context.binding, triggers, files, app, image };
      const at = this.o.now();
      this.lastSignature = signature;
      this.starts.push(at);
      for (const tr of triggers) this.lastBy.set(tr, at);
      const sent = appKey(app);
      if (sent !== null) this.sentApps.set(sent, at);
      started = true;
      this.show("checking");
      void this.run(input, controller, context.practicing);
    } finally {
      if (!started && this.inFlight === controller) this.inFlight = null;
    }
  }

  private async run(input: AmbientInput, controller: AbortController, practicing: boolean): Promise<void> {
    const timer = setTimeout(() => controller.abort(new Error("ambient check timed out")), LOOK.checkMs);
    let failed = false;
    try {
      const result = await Promise.race([
        this.o.check(input, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
      ]);
      if (this.closed || controller.signal.aborted) return;
      await this.o.record({ note: result.note, aside: practicing ? null : result.aside }, input);
    } catch {
      failed = true;
    } finally {
      clearTimeout(timer);
      if (this.inFlight === controller) {
        this.inFlight = null;
        if (!this.closed) this.show(failed ? "failed" : "watching");
      }
    }
  }

  private show(status: AmbientStatus): void {
    if (status === this.shown) return;
    this.shown = status;
    this.o.status(status);
  }
}

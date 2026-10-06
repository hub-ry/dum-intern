// Opt-in saved-file advice. No screens, keystrokes, outside-project reads or intern turns.
import { createHash } from "node:crypto";
import { Workspace, SAVED_CHANGE_LIMITS, unifiedDiff, type SavedChange } from "../workspace.ts";
import { decision, type Decision } from "../wizard.ts";

export const ADVICE_TIMING = { pollMs: 2_000, debounceMs: 1_200, rateMs: 60_000, checkMs: 45_000 } as const;
export type AdviceOptions = {
  /** A reason to pause, or null when normal project work is idle. */
  blocked(): string | null;
  publish(text: string): void;
  changed?(): void;
  read?(signal: AbortSignal, previous: readonly string[]): Promise<SavedChange[]>;
  check?(moment: Decision, signal: AbortSignal): Promise<string | null>;
  now?(): number;
  automatic?: boolean;
  pollMs?: number;
  debounceMs?: number;
  rateMs?: number;
};

type Pending = { fingerprint: string; since: number };

/** One project, one read/check flight. A fresh baseline never replays earlier dirty work. */
export class SavedChangeAdvice {
  private enabled = false;
  private closed = false;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private active: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private baseline: SavedChange[] | null = null;
  private pending: Pending | null = null;
  private lastCheck = -Infinity;
  private lastQuip = "";
  private readonly checked = new Set<string>();
  private pauseReason = "";
  private message = "wizard advice is off";
  private workspace: Workspace | null = null;

  constructor(readonly root: string, private readonly options: AdviceOptions) {}

  get status(): string { return this.message; }

  setEnabled(enabled: boolean): void {
    if (this.closed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.clear();
    this.refresh();
    if (enabled && this.options.automatic !== false) void this.tick();
  }

  /** Called on store activity, so a course or intern turn aborts advice immediately. */
  refresh(): void {
    if (this.closed) return;
    const reason = this.enabled ? this.options.blocked() : "wizard advice is off";
    if (reason) {
      if (this.pauseReason !== reason) this.clear();
      this.pauseReason = reason;
      this.setStatus(reason);
    } else if (this.pauseReason) {
      this.pauseReason = "";
      this.setStatus("wizard is watching bounded saved project changes");
    }
    this.schedule();
  }

  /** Stop drops pending work; watching resumes with a fresh, quiet baseline. */
  interrupt(): void {
    this.clear();
    this.setStatus(this.enabled ? "wizard stopped - the next poll starts a fresh baseline" : "wizard advice is off");
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.clear();
    this.setStatus("wizard advice stopped");
  }

  /** Public clock/read seam for deterministic lifecycle tests and the desktop smoke. */
  tick(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.closed || !this.enabled) return Promise.resolve();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flight = this.observe().finally(() => {
      this.flight = null;
      this.schedule();
    });
    return this.flight;
  }

  private schedule(): void {
    if (this.closed || !this.enabled || this.timer || this.flight || this.options.automatic === false) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, this.options.pollMs ?? ADVICE_TIMING.pollMs);
    this.timer.unref();
  }

  private clear(): void {
    this.generation++;
    this.active?.abort();
    this.active = null;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.baseline = null;
    this.pending = null;
  }

  private setStatus(message: string): void {
    if (this.message === message) return;
    this.message = message;
    this.options.changed?.();
  }

  private async read(signal: AbortSignal): Promise<SavedChange[]> {
    const previous = this.baseline?.map((file) => file.path) ?? [];
    if (this.options.read) return this.options.read(signal, previous);
    // Constructing a workspace itself calls Git, so even this waits for explicit opt-in.
    this.workspace ??= new Workspace(this.root);
    return this.workspace.savedChanges(previous, signal);
  }

  private fingerprint(files: readonly SavedChange[]): string {
    return createHash("sha256").update(JSON.stringify(files.map((file) => [file.path, file.sha, file.diff]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest("hex");
  }

  private async observe(): Promise<void> {
    this.refresh();
    if (this.pauseReason || this.closed || !this.enabled) return;
    const generation = this.generation;
    const active = new AbortController();
    this.active = active;
    const valid = () => !active.signal.aborted && generation === this.generation && this.enabled && !this.closed;
    try {
      const files = await this.read(active.signal);
      if (!valid()) return;
      this.refresh();
      if (!valid() || this.pauseReason) return;
      const fingerprint = this.fingerprint(files);
      if (!this.baseline) {
        this.baseline = files;
        this.setStatus("wizard is watching bounded saved project changes");
        return;
      }
      if (fingerprint === this.fingerprint(this.baseline)) {
        this.pending = null;
        this.setStatus("wizard is watching bounded saved project changes");
        return;
      }
      const now = (this.options.now ?? Date.now)();
      const pending = this.pending && this.pending.fingerprint === fingerprint ? this.pending : { fingerprint, since: now };
      this.pending = pending;
      if (now - pending.since < (this.options.debounceMs ?? ADVICE_TIMING.debounceMs)) {
        this.setStatus("wizard is waiting for saved changes to settle");
        return;
      }
      if (now - this.lastCheck < (this.options.rateMs ?? ADVICE_TIMING.rateMs)) {
        this.setStatus("wizard is waiting between saved-change checks");
        return;
      }
      const before = new Map(this.baseline.map((file) => [file.path, file]));
      const changed = files.filter((file) => before.get(file.path)?.sha !== file.sha);
      const context = changed.map((file) => before.has(file.path)
        ? unifiedDiff(file.path, before.get(file.path)!.text, file.text)
        : file.diff).join("\n");
      this.baseline = files;
      this.pending = null;
      if (!context.trim() || this.checked.has(fingerprint)) return;
      this.checked.add(fingerprint);
      if (this.checked.size > 32) this.checked.delete(this.checked.values().next().value!);
      this.lastCheck = now;
      this.setStatus("wizard is checking saved project changes");
      const signal = AbortSignal.any([active.signal, AbortSignal.timeout(ADVICE_TIMING.checkMs)]);
      const moment: Decision = {
        request: "The user saved these project changes in their editor. Offer one useful concrete observation only if the code establishes a consequential mistake or a sourced improvement or tradeoff. Don't ask them to explain their work or assume unseen requirements.",
        paths: changed.map((file) => file.path),
        changes: Buffer.from(context).subarray(0, SAVED_CHANGE_LIMITS.contextBytes).toString("utf8"),
      };
      const quip = await (this.options.check ?? decision)(moment, signal);
      if (!valid() || signal.aborted) return;
      this.refresh();
      if (!valid() || this.pauseReason) return;
      // External saves can happen while the model is running. Never publish an old answer.
      const current = await this.read(active.signal);
      if (!valid()) return;
      this.refresh();
      if (!valid() || this.pauseReason) return;
      if (this.fingerprint(current) !== fingerprint) {
        this.setStatus("wizard dropped advice for an older save");
        return;
      }
      if (quip && quip !== this.lastQuip) {
        this.lastQuip = quip;
        this.options.publish(quip);
      }
      this.setStatus("wizard is watching bounded saved project changes");
    } catch {
      if (valid()) this.setStatus("wizard couldn't check saved changes - no advice was shown");
    } finally {
      if (this.active === active) this.active = null;
    }
  }
}

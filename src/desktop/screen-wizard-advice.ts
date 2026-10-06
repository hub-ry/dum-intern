// Periodic screen-capture observer for the wizard. No code reads, no file watching, no keystroke logging.
import { createHash } from "node:crypto";
import type { Decision } from "../wizard.ts";
import { screenDecision } from "../wizard.ts";

export const SCREEN_TIMING = { pollMs: 30_000, rateMs: 90_000, checkMs: 45_000 } as const;

export type ScreenAdviceOptions = {
  /** A reason to pause, or null when normal project work is idle. */
  blocked(): string | null;
  /** One bounded PNG frame; null when unavailable; throws on permission error. */
  capture(): Promise<Buffer | null>;
  publish(text: string): void;
  changed?(): void;
  check?(moment: Decision, signal: AbortSignal): Promise<string | null>;
  now?(): number;
  automatic?: boolean;
  pollMs?: number;
  rateMs?: number;
  checkMs?: number;
};

/** One project, one capture/check flight. Frame deduplication prevents redundant model calls. */
export class ScreenWizardAdvice {
  private enabled = false;
  private closed = false;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private active: AbortController | null = null;
  private flight: Promise<void> | null = null;
  /** SHA-256 of the last PNG that was actually sent for a model check. */
  private lastFrameHash: string | null = null;
  /** When the last model check completed; -Infinity until first check. */
  private lastCheck = -Infinity;
  private lastQuip = "";
  private pauseReason = "";
  private message = "screen wizard is off";
  /** Set when the last model check threw (propagated failure from wizard.ts). Cleared on success or clear(). */
  private lastCheckFailed = false;
  private lastCheckFailedMessage = "";

  constructor(private readonly options: ScreenAdviceOptions) {}

  get status(): string { return this.message; }

  setEnabled(enabled: boolean): void {
    if (this.closed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.clear();
    this.refresh();
    if (enabled && this.options.automatic !== false) void this.tick();
  }

  /** Called on store activity so a course or busy turn aborts the observation immediately. */
  refresh(): void {
    if (this.closed) return;
    const reason = this.enabled ? this.options.blocked() : "screen wizard is off";
    if (reason) {
      if (this.pauseReason !== reason) this.clear();
      this.pauseReason = reason;
      this.setStatus(reason);
    } else if (this.pauseReason) {
      this.pauseReason = "";
      this.setStatus("wizard is watching your screen");
    }
    this.schedule();
  }

  /** Stop drops in-flight work; watching resumes on the next scheduled poll. */
  interrupt(): void {
    this.clear();
    this.setStatus(this.enabled ? "wizard stopped - the next poll starts fresh" : "screen wizard is off");
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.clear();
    this.setStatus("screen wizard stopped");
  }

  /** Public clock/capture seam for deterministic lifecycle tests and the desktop smoke. */
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
    }, this.options.pollMs ?? SCREEN_TIMING.pollMs);
    this.timer.unref();
  }

  private clear(): void {
    this.generation++;
    this.active?.abort();
    this.active = null;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.lastFrameHash = null;
    this.lastCheckFailed = false;
    this.lastCheckFailedMessage = "";
    // lastCheck preserved: interrupt/pause don't bypass the rate limit
  }

  private setStatus(message: string): void {
    if (this.message === message) return;
    this.message = message;
    this.options.changed?.();
  }

  private async observe(): Promise<void> {
    this.refresh();
    if (this.pauseReason || this.closed || !this.enabled) return;
    const generation = this.generation;
    const active = new AbortController();
    this.active = active;
    const valid = () => !active.signal.aborted && generation === this.generation && this.enabled && !this.closed;
    try {
      this.setStatus("wizard is taking a screen frame");
      let png: Buffer | null;
      try {
        png = await this.options.capture();
      } catch (err) {
        if (valid()) this.setStatus(`screen capture unavailable: ${(err as Error).message.slice(0, 120)}`);
        return;
      }
      if (!valid()) return;
      if (!png) {
        this.setStatus("screen capture returned nothing - check screen recording permission");
        return;
      }
      // Reject non-PNG data from the injectable capture seam before hashing or sending.
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) {
        if (valid()) this.setStatus("screen capture returned invalid image data");
        return;
      }
      const hash = createHash("sha256").update(png).digest("hex");
      if (hash === this.lastFrameHash) {
        this.setStatus("wizard is watching your screen");
        return;
      }
      this.refresh();
      if (!valid() || this.pauseReason) return;
      const now = (this.options.now ?? Date.now)();
      if (now - this.lastCheck < (this.options.rateMs ?? SCREEN_TIMING.rateMs)) {
        // Preserve honest failure status through the cooldown; don't overwrite with "watching".
        this.setStatus(this.lastCheckFailed ? this.lastCheckFailedMessage : "wizard is watching your screen");
        return;
      }
      this.lastCheck = now;
      this.setStatus("wizard is checking the screen");
      const signal = AbortSignal.any([active.signal, AbortSignal.timeout(this.options.checkMs ?? SCREEN_TIMING.checkMs)]);
      const moment: Decision = {
        request: "The user's screen is shown in the attached image. Spot one concrete visible mistake, error message, failed test output, or clearly wrong state on screen. Stay quiet for routine development flow.",
        images: [{ mimeType: "image/png", data: png.toString("base64") }],
      };
      const quip = await (this.options.check ?? screenDecision)(moment, signal);
      if (!valid() || signal.aborted) return;
      this.refresh();
      if (!valid() || this.pauseReason) return;
      this.lastCheckFailed = false;
      this.lastCheckFailedMessage = "";
      this.lastFrameHash = hash;
      if (quip && quip !== this.lastQuip) {
        this.lastQuip = quip;
        this.options.publish(quip);
      }
      this.setStatus("wizard is watching your screen");
    } catch {
      if (valid()) {
        this.lastCheckFailed = true;
        this.lastCheckFailedMessage = "wizard couldn't check the screen - no advice was shown";
        this.setStatus(this.lastCheckFailedMessage);
      }
    } finally {
      if (this.active === active) this.active = null;
    }
  }
}

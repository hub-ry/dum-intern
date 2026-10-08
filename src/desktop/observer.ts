// The look's main-process half (docs/llm-setup-design.md §6.1): every 3 s, read the frontmost app and a
// screen-activity grid, and send a Tick to the host. No model code lives here; the host decides.
import { LOOK } from "../observe-types.ts";
import type { AppSignal, LookPrefs, Tick } from "../observe-types.ts";
import type { Picture } from "../agent/types.ts";
import type { ZoneId } from "../zone-types.ts";

const [GRID_W, GRID_H] = LOOK.grid;

/** Raw BGRA pixels, as Electron's `NativeImage.toBitmap()` returns them. */
export type Bitmap = { width: number; height: number; data: Uint8Array };

export type ObserverOptions = {
  /** Active zone and its epoch, or null when there is none. */
  zone(): { zoneId: ZoneId; epoch: string } | null;
  /** A reason ticks stop (sleep, lock, recording), or null. Pause is set with `pause()`. */
  blocked(): string | null;
  frontmost(): Promise<AppSignal | null>;
  /** Thumbnail of the display nearest the cursor, at most `LOOK.thumbWidth` wide; null when unavailable. */
  thumbnail(): Promise<Bitmap | null>;
  /** One PNG of the display nearest the cursor, at most `LOOK.thumbWidth` wide; null when unavailable. */
  capture(): Promise<Buffer | null>;
  send(tick: Tick): void;
  look: LookPrefs;
  now?(): number;
  /** Starts a repeating timer and returns its stop function. */
  every?(ms: number, run: () => void): () => void;
};

/** Reduce a BGRA bitmap to the 64×40 grid of mean gray levels (0–255). */
export function grid(bitmap: Bitmap): Uint8Array {
  const { width, height, data } = bitmap;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new Error("invalid bitmap");
  }
  const sums = new Float64Array(GRID_W * GRID_H);
  const counts = new Uint32Array(GRID_W * GRID_H);
  for (let y = 0; y < height; y++) {
    const row = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / height)) * GRID_W;
    for (let x = 0; x < width; x++) {
      const cell = row + Math.min(GRID_W - 1, Math.floor((x * GRID_W) / width));
      const i = (y * width + x) * 4;
      sums[cell] += 0.114 * data[i] + 0.587 * data[i + 1] + 0.299 * data[i + 2];
      counts[cell]++;
    }
  }
  const out = new Uint8Array(GRID_W * GRID_H);
  for (let c = 0; c < out.length; c++) out[c] = counts[c] ? Math.round(sums[c] / counts[c]) : 0;
  return out;
}

/** Cells whose mean moved more than `delta` levels. */
export function changedCells(prev: Uint8Array, next: Uint8Array, delta: number = LOOK.levelDelta): number {
  if (prev.length !== next.length) throw new Error("grid size mismatch");
  let n = 0;
  for (let c = 0; c < next.length; c++) if (Math.abs(next[c] - prev[c]) > delta) n++;
  return n;
}

export class Observer {
  private look: LookPrefs;
  private paused = false;
  private closed = false;
  private running = false;
  /** Previous tick's grid only; dropped whenever a tick doesn't produce a fresh one. */
  private last: Uint8Array | null = null;
  private message = "starting";
  private readonly stop: () => void;
  private readonly now: () => number;

  constructor(private readonly o: ObserverOptions) {
    this.look = { ...o.look };
    this.now = o.now ?? Date.now;
    const every = o.every ?? ((ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); });
    this.stop = every(LOOK.tickMs, () => void this.tick());
  }

  get status(): string { return this.message; }

  setLook(p: LookPrefs): void {
    this.look = { ...p };
    if (!p.screen) this.last = null;
  }

  pause(paused: boolean): void {
    this.paused = paused;
    if (paused) this.last = null;
  }

  /** One PNG for the host's ambient call; nothing is kept after it returns. */
  async frame(checkId: string): Promise<Picture | null> {
    const why = this.reason();
    if (why || !this.look.screen) {
      this.message = `frame ${checkId} refused: ${why ?? "screen look is off"}`;
      return null;
    }
    const png = await this.o.capture();
    if (!png || this.closed || this.reason() || !this.look.screen) return null;
    return { mimeType: "image/png", data: png.toString("base64") };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.last = null;
    this.stop();
    this.message = "closed";
  }

  private reason(): string | null {
    if (this.closed) return "closed";
    if (this.paused) return "paused";
    const blocked = this.o.blocked();
    if (blocked) return blocked;
    return this.o.zone() ? null : "no zone";
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const why = this.reason();
    if (why) {
      this.last = null;
      this.message = `paused: ${why}`;
      return;
    }
    this.running = true;
    try {
      const zone = this.o.zone()!;
      const app = this.look.apps ? await this.o.frontmost().catch(() => null) : null;
      let screen: Tick["screen"] = null;
      if (this.look.screen) {
        const bitmap = await this.o.thumbnail().catch(() => null);
        const next = bitmap ? grid(bitmap) : null;
        if (next && this.last) screen = { changedCells: changedCells(this.last, next) };
        this.last = next;
      } else {
        this.last = null;
      }
      const now = this.reason() ? null : this.o.zone();
      if (!now || now.zoneId !== zone.zoneId || now.epoch !== zone.epoch) {
        this.last = null;
        return;
      }
      this.o.send({ zoneId: zone.zoneId, epoch: zone.epoch, at: Math.max(0, Math.floor(this.now())), app, screen });
      this.message = "looking";
    } finally {
      this.running = false;
    }
  }
}

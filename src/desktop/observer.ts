// The look's main-process half (docs/llm-setup-design.md §6.1, docs/circle-design.md §7): every 3 s,
// read the frontmost app and a screen-activity grid, and send a Tick to the host. No model code lives
// here; the host decides. Dum's own visible windows (the always-on circle, the working window, the
// bubble) never count as screen activity and are painted out of any frame the host is sent.
import { LOOK } from "../observe-types.ts";
import type { AppSignal, LookPrefs, Tick } from "../observe-types.ts";
import type { Picture } from "../agent/types.ts";
import type { ZoneId } from "../zone-types.ts";
import type { Rect, Size } from "./surfaces.ts";

const [GRID_W, GRID_H] = LOOK.grid;
/** What Dum's own windows are painted as in a frame: mid gray, opaque. */
const NEUTRAL = 128;

/** Raw BGRA pixels, as Electron's `NativeImage.toBitmap()` returns them. */
export type Bitmap = { width: number; height: number; data: Uint8Array };
/** One capture of a whole display: which display, its global DIP bounds, and the pixels. */
export type Shot = { displayId: string; display: Rect; bitmap: Bitmap };

export type ObserverOptions = {
  /** Active zone and its epoch, or null when there is none. */
  zone(): { zoneId: ZoneId; epoch: string } | null;
  /** A reason ticks stop (sleep, lock, recording), or null. Pause is set with `pause()`. */
  blocked(): string | null;
  frontmost(): Promise<AppSignal | null>;
  /** Thumbnail of the display nearest the cursor, at most `LOOK.thumbWidth` wide; null when unavailable. */
  thumbnail(): Promise<Shot | null>;
  /** One raw frame of the display nearest the cursor, at most `LOOK.frameWidth` wide; null when unavailable. */
  capture(): Promise<Shot | null>;
  /** The frame as PNG bytes. */
  encode(frame: Bitmap): Buffer;
  /** Dum's visible windows right now, in global DIP. */
  own(): readonly Rect[];
  send(tick: Tick): void;
  look: LookPrefs;
  now?(): number;
  /** Starts a repeating timer and returns its stop function. */
  every?(ms: number, run: () => void): () => void;
};

function valid(bitmap: Bitmap): boolean {
  const { width, height, data } = bitmap;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && data.length >= width * height * 4;
}

/** Reduce a BGRA bitmap to the 64×40 grid of mean gray levels (0–255). */
export function grid(bitmap: Bitmap): Uint8Array {
  if (!valid(bitmap)) throw new Error("invalid bitmap");
  const { width, height, data } = bitmap;
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

/** Cells whose mean moved more than `delta` levels, skipping every cell `ignoredCells` marks nonzero. */
export function changedCells(prev: Uint8Array, next: Uint8Array, delta: number = LOOK.levelDelta, ignoredCells?: Uint8Array): number {
  if (prev.length !== next.length || (ignoredCells && ignoredCells.length !== next.length)) throw new Error("grid size mismatch");
  let n = 0;
  for (let c = 0; c < next.length; c++) if (!ignoredCells?.[c] && Math.abs(next[c] - prev[c]) > delta) n++;
  return n;
}

/**
 * The pixel span `rect` covers in a `capture`-sized image of `display`, clamped to the image, or null
 * when it misses it. Global DIP map through the display's bounds and the capture's own dimensions,
 * never a work area or a raw scale factor.
 */
function pixels(display: Rect, capture: Size, rect: Rect): { x0: number; y0: number; x1: number; y1: number } | null {
  const sx = capture.width / display.width;
  const sy = capture.height / display.height;
  const x0 = Math.max(0, Math.floor((rect.x - display.x) * sx));
  const y0 = Math.max(0, Math.floor((rect.y - display.y) * sy));
  const x1 = Math.min(capture.width - 1, Math.ceil((rect.x + rect.width - display.x) * sx) - 1);
  const y1 = Math.min(capture.height - 1, Math.ceil((rect.y + rect.height - display.y) * sy) - 1);
  return x0 <= x1 && y0 <= y1 ? { x0, y0, x1, y1 } : null;
}

/** Grid cells covered by Dum's own rects (global DIP), in capture-pixel space of that display: 1 covered, 0 not. */
export function maskCells(display: Rect, capture: Size, rects: readonly Rect[]): Uint8Array {
  const out = new Uint8Array(GRID_W * GRID_H);
  if (display.width <= 0 || display.height <= 0 || capture.width <= 0 || capture.height <= 0) return out;
  for (const rect of rects) {
    const span = pixels(display, capture, rect);
    if (!span) continue;
    // The same pixel → cell rule as grid().
    const c0 = Math.min(GRID_W - 1, Math.floor((span.x0 * GRID_W) / capture.width));
    const c1 = Math.min(GRID_W - 1, Math.floor((span.x1 * GRID_W) / capture.width));
    const r0 = Math.min(GRID_H - 1, Math.floor((span.y0 * GRID_H) / capture.height));
    const r1 = Math.min(GRID_H - 1, Math.floor((span.y1 * GRID_H) / capture.height));
    for (let r = r0; r <= r1; r++) out.fill(1, r * GRID_W + c0, r * GRID_W + c1 + 1);
  }
  return out;
}

/** The frame with Dum's rects painted neutral before encoding. The input is left as it was. */
export function maskFrame(frame: Bitmap, display: Rect, rects: readonly Rect[]): Bitmap {
  if (!valid(frame)) throw new Error("invalid bitmap");
  const data = Uint8Array.from(frame.data);
  if (display.width > 0 && display.height > 0) {
    for (const rect of rects) {
      const span = pixels(display, frame, rect);
      if (!span) continue;
      for (let y = span.y0; y <= span.y1; y++) {
        const from = (y * frame.width + span.x0) * 4;
        const to = (y * frame.width + span.x1 + 1) * 4;
        for (let i = from; i < to; i += 4) {
          data[i] = data[i + 1] = data[i + 2] = NEUTRAL;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { width: frame.width, height: frame.height, data };
}

export class Observer {
  private look: LookPrefs;
  private paused = false;
  private closed = false;
  private running = false;
  /**
   * Previous tick's raw grid, the cells Dum's windows covered then, and the display it came from;
   * dropped whenever a tick doesn't produce a fresh one.
   */
  private last: { grid: Uint8Array; mask: Uint8Array; displayId: string } | null = null;
  private readonly stop: () => void;
  private readonly now: () => number;

  constructor(private readonly o: ObserverOptions) {
    this.look = { ...o.look };
    this.now = o.now ?? Date.now;
    const every = o.every ?? ((ms, run) => { const t = setInterval(run, ms); return () => clearInterval(t); });
    this.stop = every(LOOK.tickMs, () => void this.tick());
  }

  setLook(p: LookPrefs): void {
    this.look = { ...p };
    if (!p.screen) this.last = null;
  }

  pause(paused: boolean): void {
    this.paused = paused;
    if (paused) this.last = null;
  }

  /** One PNG for the host's look call, Dum's windows painted out; nothing is kept after it returns. */
  async frame(): Promise<Picture | null> {
    const why = this.reason();
    if (why || !this.look.screen) return null;
    const shot = await this.o.capture();
    if (!shot || this.closed || this.reason() || !this.look.screen) return null;
    const png = this.o.encode(maskFrame(shot.bitmap, shot.display, this.o.own()));
    if (png.length > LOOK.frameBytes) return null;
    return { mimeType: "image/png", data: png.toString("base64") };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.last = null;
    this.stop();
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
      return;
    }
    this.running = true;
    try {
      const zone = this.o.zone()!;
      const app = this.look.apps ? await this.o.frontmost().catch(() => null) : null;
      let screen: Tick["screen"] = null;
      if (this.look.screen) {
        const shot = await this.o.thumbnail().catch(() => null);
        // Closed while capturing (Quit): Dum's windows may already be gone, so nothing more is read.
        if (this.closed) return;
        const next = shot ? { grid: grid(shot.bitmap), mask: maskCells(shot.display, shot.bitmap, this.o.own()), displayId: shot.displayId } : null;
        // Raw grids compared, skipping cells Dum covered on either tick: a moved circle uncovers
        // nothing artificial. Another display starts over.
        const last = this.last;
        if (next && last && last.displayId === next.displayId) {
          const ignored = Uint8Array.from(next.mask, (m, c) => m | last.mask[c]!);
          screen = { changedCells: changedCells(last.grid, next.grid, LOOK.levelDelta, ignored) };
        }
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
    } finally {
      this.running = false;
    }
  }
}

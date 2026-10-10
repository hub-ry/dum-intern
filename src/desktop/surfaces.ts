// Where Dum's surfaces go, how the circle tells a click from a drag, and how long the cursor bubble
// stays (docs/circle-design.md §2, §3, §7). Pure logic with injected clocks and focus, so placement,
// gestures, display changes, TTLs and focus return are tested without Electron. Coordinates are DIP
// in Electron's global screen space: origins can be negative, and nothing here multiplies by a scale
// factor.

import type { FocusBridge } from "./native-protocol.ts";
import type { BubbleView } from "./protocol.ts";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;
/** One Electron display: its id as a string (a matching hint, not a hardware identity), work area and full bounds. */
export type DisplayArea = { id: string; workArea: Rect; bounds: Rect; primary: boolean };

export const MARGIN = 8;
export const BUBBLE_MAX: Size = { width: 360, height: 220 };
/** Offset of the bubble from the cursor, before flipping. */
const CURSOR_GAP = { x: 16, y: 20 };

/** The persistent circle: its window, visible disk, face and gesture thresholds. */
export const CIRCLE = {
  /** The BrowserWindow is this square; the disk is centered with 4 DIP of transparent padding. */
  window: 64,
  disk: 56,
  /** Only this radius from the window's center takes the pointer. */
  radius: 28,
  /** Whole device pixels per art pixel: the 7×8 face draws at 28×32. */
  faceScale: 4,
  /** The whole window stays this far inside a display's work area. */
  inset: 8,
  /** Movement this far from the press, at any point, makes the whole gesture a drag. */
  dragDip: 6,
  /** A release below the drag threshold within this long toggles the working window. */
  toggleMs: 500,
  /** A second click this soon after a toggle does nothing. */
  debounceMs: 250,
  /** Main samples the pointer and moves the window at most once per frame. */
  frameMs: 16,
  /** A press with no release after this long is cancelled. */
  releaseMs: 10_000,
  /** The default placement: 35% down the usable vertical range. */
  defaultV: 0.35,
  /** Saved placements, one per display, at most. */
  placements: 16,
} as const;

/** The working window: fixed size, shrunk to the work area; its narrow layout works down to WINDOW_MIN. */
export const WINDOW_SIZE: Size = { width: 640, height: 720 };
export const WINDOW_MIN: Size = { width: 360, height: 480 };
/** Gap between the circle and the working window beside it. */
export const WINDOW_GAP = 12;

/** A ready voice draft stays 20 s. A reply is read, not heard, so it stays 15 s. */
export const BUBBLE_TTL = { ready: 20_000, reply: 15_000, error: 8_000 } as const;
/** Recording has a two-minute ceiling; nothing in the bubble outlives it. */
const RECORDING_MS = 2 * 60_000;
export const BUBBLE_LINES = 8;
export const BUBBLE_CHARS = 600;
/** The last line of a cut reply; the bubble is click-through, so it only points at the Open shortcut. */
export const BUBBLE_OPEN = "Open Dum for the full reply";

/** `size` shrunk to fit inside `area` with the margin on every side. */
function fit(size: Size, area: Rect): Size {
  return {
    width: Math.max(1, Math.min(size.width, area.width - 2 * MARGIN)),
    height: Math.max(1, Math.min(size.height, area.height - 2 * MARGIN)),
  };
}

/** The rect moved (not resized, unless it is bigger than the area) to lie inside `area` with the margin. */
export function clampInto(rect: Rect, area: Rect): Rect {
  const { width, height } = fit(rect, area);
  const x = Math.min(Math.max(rect.x, area.x + MARGIN), area.x + area.width - MARGIN - width);
  const y = Math.min(Math.max(rect.y, area.y + MARGIN), area.y + area.height - MARGIN - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function within(rect: Rect, area: Rect): boolean {
  return rect.x >= area.x + MARGIN && rect.y >= area.y + MARGIN
    && rect.x + rect.width <= area.x + area.width - MARGIN && rect.y + rect.height <= area.y + area.height - MARGIN;
}

/**
 * Below-right of the cursor, flipped left or up when it would overflow, then clamped; at most 360×220.
 * When that would cover `avoid` (the circle), the other cursor quadrants are tried before clamping.
 */
export function placeBubble(cursor: Point, area: Rect, wanted: Size = BUBBLE_MAX, avoid: Rect | null = null): Rect {
  const size = fit({ width: Math.min(wanted.width, BUBBLE_MAX.width), height: Math.min(wanted.height, BUBBLE_MAX.height) }, area);
  const right = cursor.x + CURSOR_GAP.x;
  const left = cursor.x - CURSOR_GAP.x - size.width;
  const below = cursor.y + CURSOR_GAP.y;
  const above = cursor.y - CURSOR_GAP.y - size.height;
  const x = right + size.width > area.x + area.width - MARGIN ? left : right;
  const y = below + size.height > area.y + area.height - MARGIN ? above : below;
  const first = clampInto({ x, y, ...size }, area);
  if (!avoid || !overlaps(first, avoid)) return first;
  const other = (v: number, a: number, b: number) => (v === a ? b : a);
  for (const [cx, cy] of [[other(x, right, left), y], [x, other(y, below, above)], [other(x, right, left), other(y, below, above)]] as const) {
    const rect = { x: cx, y: cy, ...size };
    if (within(rect, area) && !overlaps(rect, avoid)) return rect;
  }
  return first;
}

function distance(rect: Rect, area: Rect): number {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width));
  const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height));
  return dx * dx + dy * dy;
}

/** After a display is removed or changes: the rect clamped into the nearest remaining work area. */
export function reclamp(rect: Rect, areas: readonly Rect[]): Rect {
  if (!areas.length) return rect;
  let best = areas[0]!;
  for (const area of areas) if (distance(rect, area) < distance(rect, best)) best = area;
  return clampInto(rect, best);
}

// -- the circle ---------------------------------------------------------------------------------

/** How far the circle's top-left can travel inside `area`, after the inset and its own size. */
function travel(area: Rect): { x0: number; y0: number; dx: number; dy: number } {
  return {
    x0: area.x + CIRCLE.inset,
    y0: area.y + CIRCLE.inset,
    dx: Math.max(0, area.width - 2 * CIRCLE.inset - CIRCLE.window),
    dy: Math.max(0, area.height - 2 * CIRCLE.inset - CIRCLE.window),
  };
}

/** The whole 64×64 rect inside `area`, 8 DIP inset. A work area too small for it keeps the top-left inset. */
export function clampCircle(rect: Rect, area: Rect): Rect {
  const t = travel(area);
  return {
    x: Math.round(Math.max(t.x0, Math.min(rect.x, t.x0 + t.dx))),
    y: Math.round(Math.max(t.y0, Math.min(rect.y, t.y0 + t.dy))),
    width: CIRCLE.window,
    height: CIRCLE.window,
  };
}

/** Normalized top-left fractions over the travel range, so a placement survives resolution changes. */
export function toPlacement(rect: Rect, area: Rect): { u: number; v: number } {
  const t = travel(area);
  const unit = (at: number, from: number, range: number) => (range > 0 ? Math.min(1, Math.max(0, (at - from) / range)) : 0);
  return { u: unit(rect.x, t.x0, t.dx), v: unit(rect.y, t.y0, t.dy) };
}

export function fromPlacement(p: { u: number; v: number }, area: Rect): Rect {
  const t = travel(area);
  const unit = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  return clampCircle({ x: t.x0 + unit(p.u) * t.dx, y: t.y0 + unit(p.v) * t.dy, width: CIRCLE.window, height: CIRCLE.window }, area);
}

/** 8 DIP from the right work-area edge, 35% down the usable vertical range. */
export function defaultCircle(area: Rect): Rect {
  return fromPlacement({ u: 1, v: CIRCLE.defaultV }, area);
}

/** The display containing `point`, else the one whose bounds are nearest it. Null with no displays. */
export function nearestDisplay(point: Point, displays: readonly DisplayArea[]): DisplayArea | null {
  let best: DisplayArea | null = null;
  let bestDistance = Infinity;
  for (const d of displays) {
    const b = d.bounds;
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1));
    const far = dx * dx + dy * dy;
    if (far < bestDistance) {
      best = d;
      bestDistance = far;
    }
  }
  return best;
}

/** The pointer is on the visible disk, not the transparent padding around it. */
export function insideDisk(point: Point, circle: Rect): boolean {
  const dx = point.x - (circle.x + circle.width / 2);
  const dy = point.y - (circle.y + circle.height / 2);
  return dx * dx + dy * dy <= CIRCLE.radius * CIRCLE.radius;
}

/**
 * The working window beside the circle: right of it with a 12 DIP gap, vertically centered on it;
 * left when the right doesn't fit; otherwise the side with more room, clamped (it may then overlap
 * the circle). Shrunk to the work area with 8 DIP margins.
 */
export function placeWindow(circle: Rect, area: Rect, wanted: Size): Rect {
  const size = fit(wanted, area);
  const y = circle.y + circle.height / 2 - size.height / 2;
  const right = circle.x + circle.width + WINDOW_GAP;
  const left = circle.x - WINDOW_GAP - size.width;
  const roomRight = area.x + area.width - MARGIN - right;
  const roomLeft = circle.x - WINDOW_GAP - (area.x + MARGIN);
  const x = roomRight >= size.width ? right : roomLeft >= size.width ? left : roomRight >= roomLeft ? right : left;
  return clampInto({ x, y, ...size }, area);
}

type Live = { id: string; start: Point; bounds: Rect; at: number; dragging: boolean; onDisk: boolean };

/**
 * Main-issued pointer gestures on the circle. Positions are main's global DIP samples, never
 * renderer coordinates. One gesture at a time: a new press replaces an unfinished one.
 */
export class CircleGesture {
  private live: Live | null = null;
  private lastToggle = -Infinity;

  constructor(private readonly now: () => number) {}

  /** The live gesture's id, or null. */
  get active(): string | null {
    return this.live?.id ?? null;
  }

  /** A primary press. One on the transparent padding never toggles or drags. */
  begin(pointer: Point, bounds: Rect): string {
    const id = crypto.randomUUID();
    this.live = { id, start: { ...pointer }, bounds: { ...bounds }, at: this.now(), dragging: false, onDisk: insideDisk(pointer, bounds) };
    return id;
  }

  /** Where the circle goes for this pointer sample, unclamped; null until movement proves a drag. */
  move(gestureId: string, pointer: Point): Rect | null {
    const g = this.current(gestureId);
    if (!g || !g.onDisk) return null;
    const dx = pointer.x - g.start.x;
    const dy = pointer.y - g.start.y;
    if (!g.dragging && dx * dx + dy * dy >= CIRCLE.dragDip * CIRCLE.dragDip) g.dragging = true;
    return g.dragging ? { x: g.bounds.x + dx, y: g.bounds.y + dy, width: g.bounds.width, height: g.bounds.height } : null;
  }

  /** The release. A drag ends as one; a short, still press toggles unless one just did; anything else does nothing. */
  end(gestureId: string, pointer: Point): "toggle" | "drag" | "none" {
    const g = this.current(gestureId);
    if (!g) return "none";
    this.move(gestureId, pointer);
    this.live = null;
    if (!g.onDisk) return "none";
    if (g.dragging) return "drag";
    const at = this.now();
    if (at - g.at > CIRCLE.toggleMs || at - this.lastToggle < CIRCLE.debounceMs) return "none";
    this.lastToggle = at;
    return "toggle";
  }

  /** Lost capture, pointer cancel or the release ceiling: the starting bounds to restore, or null when not live. */
  cancel(gestureId: string): Rect | null {
    const g = this.current(gestureId);
    if (!g) return null;
    this.live = null;
    return { ...g.bounds };
  }

  /** Live past the 10-second missing-release ceiling. */
  overdue(gestureId: string): boolean {
    const g = this.current(gestureId);
    return g !== null && this.now() - g.at >= CIRCLE.releaseMs;
  }

  private current(gestureId: string): Live | null {
    return this.live && this.live.id === gestureId ? this.live : null;
  }
}

// -- the bubble ---------------------------------------------------------------------------------

/** At most eight lines and 600 characters of what Dum and the Wizard actually said; never a summary. */
export function bubbleLines(dum: readonly string[], wizard: string | null): string[] {
  const out: string[] = [];
  let budget = BUBBLE_CHARS;
  let cut = false;
  for (const text of [...dum, ...(wizard ? [`Wizard: ${wizard.replace(/\s+/g, " ").trim()}`] : [])]) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (out.length >= BUBBLE_LINES - 1 || budget <= 0) {
        cut = true;
        break;
      }
      const piece = trimmed.length > budget ? `${trimmed.slice(0, Math.max(0, budget - 1))}…` : trimmed;
      if (piece !== trimmed) cut = true;
      out.push(piece);
      budget -= piece.length;
    }
  }
  if (cut) out.push(BUBBLE_OPEN);
  return out;
}

export type BubblePorts = {
  /** Show `view`, or hide with null. `fresh` marks a new interaction, which anchors at the cursor once. */
  publish(view: BubbleView | null, fresh: boolean): void;
  now?(): number;
  /** One-shot timer; returns its cancel. */
  after?(ms: number, run: () => void): () => void;
};

/**
 * The cursor bubble's content and lifetime. It shows only while recording, transcribing or
 * answering, and goes away on its own after its TTL (BUBBLE_TTL).
 */
export class Bubble {
  private view: BubbleView | null = null;
  private cancel: (() => void) | null = null;
  private readonly now: () => number;
  private readonly after: (ms: number, run: () => void) => () => void;

  constructor(private readonly ports: BubblePorts) {
    this.now = ports.now ?? Date.now;
    this.after = ports.after ?? ((ms, run) => {
      const t = setTimeout(run, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
  }

  get current(): BubbleView | null {
    return this.view ? { ...this.view, lines: [...this.view.lines] } : null;
  }

  /** Recording or transcribing: no timer but the recording ceiling. */
  voice(lines: string[]): void {
    this.show({ kind: "voice", lines, expiresAt: this.now() + RECORDING_MS });
  }

  /** A voice draft is ready, or Dum is answering: shown until replaced or `ttl` passes. */
  timed(kind: BubbleView["kind"], lines: string[], ttl: number): void {
    this.show({ kind, lines, expiresAt: this.now() + ttl });
  }

  /** Explicit dismissal, zone switch, a decision, sleep or close. */
  dismiss(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.view) return;
    this.view = null;
    this.ports.publish(null, false);
  }

  private show(view: BubbleView): void {
    const fresh = this.view === null;
    this.cancel?.();
    this.view = view;
    this.cancel = this.after(Math.max(0, view.expiresAt - this.now()), () => {
      if (this.view !== view) return;
      this.cancel = null;
      this.view = null;
      this.ports.publish(null, false);
    });
    this.ports.publish({ ...view, lines: [...view.lines] }, fresh);
  }
}

// -- focus --------------------------------------------------------------------------------------

/**
 * The external application to give focus back to when the working window is dismissed: the app that
 * was frontmost when Dum was summoned. Handles are opaque and live for one summon. Never Dum itself:
 * main summons only while no Dum window has focus.
 */
export class FocusReturn {
  private handle: string | null = null;

  constructor(private readonly focus: Pick<FocusBridge, "capture" | "restore">) {}

  /** Remember the frontmost app before Dum activates. A failed capture leaves nothing to restore. */
  async summon(): Promise<void> {
    this.handle = null;
    try {
      this.handle = await this.focus.capture();
    } catch {
      this.handle = null;
    }
  }

  /** Give focus back once; whether the app came back. No capture means nothing is activated. */
  async dismiss(): Promise<boolean> {
    const handle = this.handle;
    this.handle = null;
    if (!handle) return false;
    try {
      return await this.focus.restore(handle);
    } catch {
      return false;
    }
  }

  /** The user moved to another app themselves: nothing goes back. */
  forget(): void {
    this.handle = null;
  }
}

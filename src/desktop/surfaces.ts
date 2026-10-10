// Where Dum's surfaces go, how the circle tells a click from a drag, how the column of circles and
// its panels are laid out, and how long the bubble stays (docs/circle-design.md, "Superseded parts
// (goals column)"). Pure logic with injected clocks and focus, so placement, gestures, display
// changes, TTLs and focus return are tested without Electron. Coordinates are DIP in Electron's
// global screen space: origins can be negative, and nothing here multiplies by a scale factor.

import { STEP_LIMITS, type StepView } from "../step-types.ts";
import type { FocusBridge } from "./native-protocol.ts";
import type { WizardChime } from "../observe-types.ts";
import type { BubbleView, PanelRef } from "./protocol.ts";

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

/**
 * The expanded column: the circle's window grown down into one slot per circle, `pitch` apart, each
 * a 56 DIP disk, on one shared capsule background `pad` inside the window.
 */
export const COLUMN = {
  pitch: 64,
  /** Dum, up to three goals, the skill tree, the monitor, settings. */
  slots: 7,
  pad: 2,
  /** With no pointer over it this long, the column folds back into one circle. */
  idleMs: 8_000,
  /** The page's fold animation; main shrinks the window back to the circle after it. */
  foldMs: 280,
} as const;

/** Each panel's size before it is shrunk to the work area. */
export const PANEL_SIZE: Record<PanelRef["kind"], Size> = {
  dum: { width: 400, height: 560 },
  goal: { width: 440, height: 640 },
  tree: { width: 760, height: 560 },
  monitor: { width: 400, height: 560 },
  settings: { width: 400, height: 560 },
};
/** The circle floats over the panel's corner: every panel keeps this square clear at both top corners. */
export const PANEL_CLEAR = 36;
/**
 * The thought cloud beside the circle (step and wizard bubbles): the cloud itself, plus a strip on
 * the circle's side where its puffs trail off toward the circle.
 */
export const THOUGHT = { cloud: { width: 340, height: 150 }, puffs: 40, gap: 4 } as const;

/**
 * A ready voice draft stays 20 s. A reply is read, not heard, so it stays 15 s. The Wizard jumping in
 * stays 20 s. A step stays until it changes.
 */
export const BUBBLE_TTL = { ready: 20_000, reply: 15_000, error: 8_000, wizard: 20_000 } as const;
/** Recording has a two-minute ceiling; nothing in the bubble outlives it. */
const RECORDING_MS = 2 * 60_000;

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

/** The center of the circle's disk. */
export function diskCenter(circle: Rect): Point {
  return { x: circle.x + circle.width / 2, y: circle.y + circle.height / 2 };
}

/**
 * A panel opened from the circle: its top-left corner at the disk's center, so the circle sits on
 * the corner. Flipped to put its top-right corner there when there's no room on the right, and its
 * bottom corner when there's no room below; shrunk to the work area and clamped.
 */
export function placePanel(disk: Point, area: Rect, size: Size): Rect {
  const s = fit(size, area);
  const x = disk.x + s.width <= area.x + area.width - MARGIN ? disk.x : disk.x - s.width;
  const y = disk.y + s.height <= area.y + area.height - MARGIN ? disk.y : disk.y - s.height;
  return clampInto({ x, y, ...s }, area);
}

/**
 * The expanded column for `slots` circles: the circle's window grown down from where the circle is,
 * shifted up when that would leave the work area. The first slot is the circle's own place unless shifted.
 */
export function columnRect(circle: Rect, area: Rect, slots: number): Rect {
  const height = Math.max(1, Math.min(slots, COLUMN.slots)) * COLUMN.pitch;
  const bottom = area.y + area.height - CIRCLE.inset;
  const y = Math.max(area.y + CIRCLE.inset, Math.min(circle.y, bottom - height));
  return { x: circle.x, y: Math.round(y), width: CIRCLE.window, height };
}

/** The center of slot `index` in a column. */
export function slotCenter(column: Rect, index: number): Point {
  return { x: column.x + column.width / 2, y: column.y + COLUMN.pitch / 2 + index * COLUMN.pitch };
}

/** Which of the column's `slots` disks the pointer is on; null between disks or outside. */
export function slotAt(point: Point, column: Rect, slots: number): number | null {
  for (let i = 0; i < Math.min(slots, COLUMN.slots); i++) {
    const c = slotCenter(column, i);
    const dx = point.x - c.x;
    const dy = point.y - c.y;
    if (dx * dx + dy * dy <= CIRCLE.radius * CIRCLE.radius) return i;
  }
  return null;
}

/** The pointer is on the column's shared background (a capsule around every disk), not its transparent corners. */
export function insideColumn(point: Point, column: Rect): boolean {
  const r = column.width / 2 - COLUMN.pad;
  const top = column.y + COLUMN.pad + r;
  const bottom = Math.max(top, column.y + column.height - COLUMN.pad - r);
  const cx = column.x + column.width / 2;
  const cy = Math.min(Math.max(point.y, top), bottom);
  const dx = point.x - cx;
  const dy = point.y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * The thought cloud beside the circle, top-aligned with it: right of it, or left of it when the
 * circle is near the right edge; then clamped. `toward` is the window's side facing the circle.
 */
export function placeThought(circle: Rect, area: Rect): { rect: Rect; toward: "left" | "right" } {
  const size = fit({ width: THOUGHT.cloud.width + THOUGHT.puffs, height: THOUGHT.cloud.height }, area);
  const right = circle.x + circle.width + THOUGHT.gap;
  const fits = right + size.width <= area.x + area.width - MARGIN;
  const x = fits ? right : circle.x - THOUGHT.gap - size.width;
  return { rect: clampInto({ x, y: circle.y, ...size }, area), toward: fits ? "left" : "right" };
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

  /**
   * A primary press. One on the transparent padding never toggles or drags; `onDisk` is the hit test
   * for what the window shows (the circle's disk by default, the column's background when expanded).
   */
  begin(pointer: Point, bounds: Rect, onDisk = insideDisk(pointer, bounds)): string {
    const id = crypto.randomUUID();
    this.live = { id, start: { ...pointer }, bounds: { ...bounds }, at: this.now(), dragging: false, onDisk };
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

/**
 * The first sentence of `text`: up to the first sentence end or paragraph break, whitespace
 * collapsed, at most `max` characters (ellipsized). "" when there's nothing.
 */
export function firstSentence(text: string, max: number = STEP_LIMITS.text): string {
  const paragraph = text.trim().split(/\n\s*\n/)[0] ?? "";
  const flat = paragraph.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = /^.*?[.!?…](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** A reply in the bubble: one sentence of what Dum said, plus one "Wizard: …" sentence when the Wizard spoke. Never a summary. */
export function bubbleLines(dum: readonly string[], wizard: string | null): string[] {
  const said = firstSentence(dum.map((t) => t.trim()).filter(Boolean).join("\n\n"));
  const aside = wizard ? firstSentence(wizard, STEP_LIMITS.text - "Wizard: ".length) : "";
  return [...(said ? [said] : []), ...(aside ? [`Wizard: ${aside}`] : [])];
}

export type BubblePorts = {
  /**
   * Show `view`, or hide with null. `fresh` marks a new interaction: a voice or reply anchors at the
   * cursor once; a step is always placed beside the circle.
   */
  publish(view: BubbleView | null, fresh: boolean): void;
  now?(): number;
  /** One-shot timer; returns its cancel. */
  after?(ms: number, run: () => void): () => void;
};

type Passing = Extract<BubbleView, { kind: "voice" | "reply" }>;
type Chime = Extract<BubbleView, { kind: "wizard" }>;

function copy(view: BubbleView): BubbleView {
  return view.kind === "step" ? { ...view, step: structuredClone(view.step) } : view.kind === "wizard" ? { ...view } : { ...view, lines: [...view.lines] };
}

/**
 * The bubble's content and lifetime. A voice status or a reply passes: it goes away on its own after
 * its TTL (BUBBLE_TTL). The Wizard jumping in passes too, once per chime. The active goal's step
 * stays: it shows whenever nothing passing is live and the working window isn't in front, until its
 * id changes or it goes away. Voice wins over everything; between a reply and the Wizard, the newer.
 */
export class Bubble {
  private passing: Passing | null = null;
  private chime: Chime | null = null;
  /** Which of `passing` and `chime` came last. */
  private chimeNewer = false;
  /** The last chime id handed in, shown or not: a chime shows at most once. */
  private chimeId: string | null = null;
  private held: StepView | null = null;
  private front = false;
  private suspended = false;
  private shown: BubbleView | null = null;
  private cancel: (() => void) | null = null;
  private cancelChime: (() => void) | null = null;
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

  /** What is showing now, or null. */
  get current(): BubbleView | null {
    return this.shown ? copy(this.shown) : null;
  }

  /** Recording or transcribing: no timer but the recording ceiling. */
  voice(lines: string[]): void {
    this.pass({ kind: "voice", lines, expiresAt: this.now() + RECORDING_MS });
  }

  /** A voice draft is ready, or Dum is answering: shown until replaced or `ttl` passes. */
  timed(kind: Passing["kind"], lines: string[], ttl: number): void {
    this.pass({ kind, lines, expiresAt: this.now() + ttl });
  }

  /** Explicit dismissal of what's passing: goal switch, a decision, voice cancel. A held step comes back. */
  dismiss(): void {
    this.cancel?.();
    this.cancel = null;
    this.passing = null;
    this.render();
  }

  /** The active goal's step, or null when there's none; the same id keeps the bubble as it is. */
  step(step: StepView | null): void {
    this.held = step ? structuredClone(step) : null;
    this.render();
  }

  /**
   * The Wizard's latest chime. A new id shows for BUBBLE_TTL.wizard, unless the working window is in
   * front (its panel shows it) or Dum is asleep; either way that chime is spent.
   */
  wizard(chime: WizardChime | null): void {
    if (!chime || chime.id === this.chimeId) return;
    this.chimeId = chime.id;
    if (this.front || this.suspended) return;
    this.cancelChime?.();
    const view: Chime = { kind: "wizard", text: chime.text, expiresAt: this.now() + BUBBLE_TTL.wizard };
    this.chime = view;
    this.chimeNewer = true;
    this.cancelChime = this.after(BUBBLE_TTL.wizard, () => {
      if (this.chime !== view) return;
      this.cancelChime = null;
      this.chime = null;
      this.render();
    });
    this.render(true);
  }

  /** The working window is visible and focused: the step and the Wizard are already in front of them, so they hide meanwhile. */
  windowFront(front: boolean): void {
    if (front === this.front) return;
    this.front = front;
    this.render();
  }

  /** Sleep, lock or quit: nothing shows until resumed. Anything passing is dropped, and nothing new passes meanwhile. */
  suspend(on: boolean): void {
    if (on) {
      this.cancel?.();
      this.cancelChime?.();
      this.cancel = this.cancelChime = null;
      this.passing = this.chime = null;
    }
    this.suspended = on;
    this.render();
  }

  private pass(view: Passing): void {
    if (this.suspended) return;
    this.cancel?.();
    this.passing = view;
    this.chimeNewer = false;
    this.cancel = this.after(Math.max(0, view.expiresAt - this.now()), () => {
      if (this.passing !== view) return;
      this.cancel = null;
      this.passing = null;
      this.render();
    });
    this.render(true);
  }

  private render(replaced = false): void {
    const before = this.shown;
    const chime = this.front ? null : this.chime;
    const next: BubbleView | null = this.suspended ? null
      : this.passing?.kind === "voice" ? this.passing
      : this.passing && chime ? (this.chimeNewer ? chime : this.passing)
      : this.passing ?? chime ?? (this.held && !this.front ? { kind: "step", step: this.held, expiresAt: 0 } : null);
    if (!next) {
      this.shown = null;
      if (before) this.ports.publish(null, false);
      return;
    }
    if (next.kind === "step") {
      if (before?.kind === "step" && JSON.stringify(before.step) === JSON.stringify(next.step)) return;
      this.shown = next;
      this.ports.publish(copy(next), before?.kind !== "step" || before.step.id !== next.step.id);
      return;
    }
    if (!replaced && before === next) return;
    this.shown = next;
    // A voice or reply after a cloud beside the circle starts a new cursor anchor; voice to reply keeps it.
    const fresh = next.kind === "wizard" ? before !== next : before === null || before.kind === "step" || before.kind === "wizard";
    this.ports.publish(copy(next), fresh);
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

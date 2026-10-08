// Where Dum's windows go and how long the cursor bubble stays (docs/revamp-design.md §4). Pure logic
// with injected clocks and focus, so placement, display removal, TTLs and focus return are tested
// without Electron. Coordinates are DIP in Electron's global screen space: origins can be negative,
// and nothing here multiplies by a scale factor.

import type { FocusBridge } from "./native-protocol.ts";
import type { BubbleView } from "./protocol.ts";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;

export const MARGIN = 8;
export const BUBBLE_MAX: Size = { width: 360, height: 220 };
export const COMMAND_SIZE: Size = { width: 640, height: 360 };
export const PANEL_SIZE: Size = { width: 420, height: 640 };
/** Offset of the bubble from the cursor, before flipping. */
const CURSOR_GAP = { x: 16, y: 20 };

/** A ready voice draft stays this long; a finished reply this long. */
export const BUBBLE_TTL = { ready: 20_000, reply: 8_000, error: 8_000 } as const;
/** Recording has a two-minute ceiling; nothing in the bubble outlives it. */
const RECORDING_MS = 2 * 60_000;
export const BUBBLE_LINES = 8;
export const BUBBLE_CHARS = 600;

/** `size` shrunk to fit inside `area` with the margin on every side. */
function fit(size: Size, area: Rect): Size {
  return {
    width: Math.max(1, Math.min(size.width, area.width - 2 * MARGIN)),
    height: Math.max(1, Math.min(size.height, area.height - 2 * MARGIN)),
  };
}

/** The rect moved (not resized) to lie inside `area` with the margin. */
export function clampInto(rect: Rect, area: Rect): Rect {
  const { width, height } = fit(rect, area);
  const x = Math.min(Math.max(rect.x, area.x + MARGIN), area.x + area.width - MARGIN - width);
  const y = Math.min(Math.max(rect.y, area.y + MARGIN), area.y + area.height - MARGIN - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Below-right of the cursor, flipped left or up when it would overflow, then clamped; at most 360×220. */
export function placeBubble(cursor: Point, area: Rect, wanted: Size = BUBBLE_MAX): Rect {
  const size = fit({ width: Math.min(wanted.width, BUBBLE_MAX.width), height: Math.min(wanted.height, BUBBLE_MAX.height) }, area);
  let x = cursor.x + CURSOR_GAP.x;
  let y = cursor.y + CURSOR_GAP.y;
  if (x + size.width > area.x + area.width - MARGIN) x = cursor.x - CURSOR_GAP.x - size.width;
  if (y + size.height > area.y + area.height - MARGIN) y = cursor.y - CURSOR_GAP.y - size.height;
  return clampInto({ x, y, ...size }, area);
}

/** Centered in the work area of the display nearest the cursor; clamped on small displays. */
export function placeCentered(area: Rect, wanted: Size): Rect {
  const size = fit(wanted, area);
  return clampInto({ x: area.x + (area.width - size.width) / 2, y: area.y + (area.height - size.height) / 2, ...size }, area);
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

/** At most eight lines and 600 characters of what Dum and the Wizard actually said; never a summary. */
export function bubbleLines(dum: readonly string[], wizard: string | null): string[] {
  const out: string[] = [];
  let budget = BUBBLE_CHARS;
  let cut = false;
  for (const text of dum) {
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
  if (wizard && out.length < BUBBLE_LINES - 1 && budget > 0) {
    const line = `Wizard: ${wizard.replace(/\s+/g, " ").trim()}`;
    out.push(line.length > budget ? `${line.slice(0, Math.max(0, budget - 1))}…` : line);
  }
  if (cut) out.push("Open the command bar for the full reply");
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
 * answering, and goes away on its own: a ready draft after 20 s, a reply after 8 s.
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

/**
 * Where focus goes back to when the command bar is dismissed: the app that was frontmost when it was
 * summoned, or, when Dum's panel had focus, the panel. Handles are opaque and live for one summon.
 */
export class FocusReturn {
  private target: { kind: "app"; handle: string } | { kind: "panel" } | null = null;

  constructor(private readonly focus: Pick<FocusBridge, "capture" | "restore">) {}

  /** Remember what had focus before the command bar takes it. A failed capture leaves nothing to restore. */
  async summon(panelFocused: boolean): Promise<void> {
    if (panelFocused) {
      this.target = { kind: "panel" };
      return;
    }
    this.target = null;
    try {
      this.target = { kind: "app", handle: await this.focus.capture() };
    } catch {
      this.target = null;
    }
  }

  /** Give focus back once. Returns "panel" when Dum's panel should take it, else whether the app came back. */
  async dismiss(): Promise<"panel" | boolean> {
    const target = this.target;
    this.target = null;
    if (!target) return false;
    if (target.kind === "panel") return "panel";
    try {
      return await this.focus.restore(target.handle);
    } catch {
      return false;
    }
  }
}

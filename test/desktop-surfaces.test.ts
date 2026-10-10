import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUBBLE_CHARS, BUBBLE_LINES, BUBBLE_TTL, Bubble, CIRCLE, CircleGesture, FocusReturn, MARGIN, WINDOW_GAP, WINDOW_SIZE, bubbleLines,
  clampCircle, defaultCircle, fromPlacement, insideDisk, nearestDisplay, placeBubble, placeWindow, reclamp, toPlacement,
  type DisplayArea, type Rect,
} from "../src/desktop/surfaces.ts";
import type { BubbleView } from "../src/desktop/protocol.ts";

const main: Rect = { x: 0, y: 25, width: 1440, height: 875 };
/** A display left of and above the main one: negative global coordinates. */
const left: Rect = { x: -1920, y: -300, width: 1920, height: 1080 };
const inside = (r: Rect, a: Rect) =>
  r.x >= a.x + MARGIN && r.y >= a.y + MARGIN && r.x + r.width <= a.x + a.width - MARGIN && r.y + r.height <= a.y + a.height - MARGIN;

test("the bubble sits below-right of the cursor, at most 360×220", () => {
  assert.deepEqual(placeBubble({ x: 400, y: 300 }, main), { x: 416, y: 320, width: 360, height: 220 });
});

test("near the right or bottom edge the bubble flips left or up, then clamps", () => {
  const right = placeBubble({ x: 1430, y: 300 }, main);
  assert.equal(right.x, 1430 - 16 - 360);
  const bottom = placeBubble({ x: 400, y: 890 }, main);
  assert.equal(bottom.y, 890 - 20 - 220);
  const corner = placeBubble({ x: 1439, y: 899 }, main);
  assert.ok(inside(corner, main));
  const topLeft = placeBubble({ x: 0, y: 25 }, main);
  assert.ok(inside(topLeft, main));
});

test("negative coordinates are used as they are, never scaled", () => {
  const at = placeBubble({ x: -1000, y: -200 }, left);
  assert.deepEqual(at, { x: -984, y: -180, width: 360, height: 220 });
  const edge = placeBubble({ x: -5, y: 770 }, left);
  assert.ok(inside(edge, left));
});

test("a small display shrinks the bubble to fit", () => {
  const tiny: Rect = { x: 100, y: 100, width: 300, height: 150 };
  const bubble = placeBubble({ x: 150, y: 150 }, tiny);
  assert.ok(inside(bubble, tiny));
  assert.equal(bubble.width, 300 - 2 * MARGIN);
});

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("a bubble that would cover the circle takes another cursor quadrant, then clamps", () => {
  const circle: Rect = { x: 430, y: 330, width: 64, height: 64 };
  const plain = placeBubble({ x: 400, y: 300 }, main);
  assert.ok(overlap(plain, circle), "the usual spot covers the circle");
  const moved = placeBubble({ x: 400, y: 300 }, main, undefined, circle);
  assert.ok(!overlap(moved, circle));
  assert.ok(inside(moved, main));
  assert.deepEqual(moved, { x: 400 - 16 - 360, y: 320, width: 360, height: 220 }, "left of the cursor first");
  assert.deepEqual(placeBubble({ x: 400, y: 300 }, main, undefined, { x: 0, y: 0, width: 10, height: 10 }), plain, "a circle elsewhere changes nothing");
  // Nowhere fits without covering it: the usual clamped spot.
  const tiny: Rect = { x: 0, y: 0, width: 400, height: 260 };
  assert.deepEqual(placeBubble({ x: 200, y: 130 }, tiny, undefined, { x: 0, y: 0, width: 400, height: 260 }), placeBubble({ x: 200, y: 130 }, tiny));
});

test("after a display is removed, a window moves into the nearest remaining one", () => {
  const onLeft: Rect = { x: -800, y: 0, width: 640, height: 360 };
  const moved = reclamp(onLeft, [main]);
  assert.ok(inside(moved, main));
  const kept = reclamp({ x: 400, y: 300, width: 640, height: 360 }, [main, left]);
  assert.deepEqual(kept, { x: 400, y: 300, width: 640, height: 360 }, "a window already on a display stays put");
  const nearer = reclamp({ x: -300, y: 100, width: 200, height: 100 }, [main, left]);
  assert.ok(inside(nearer, left), "the nearest display wins");
});

function clock() {
  let now = 1_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    after(ms: number, run: () => void) {
      const t = { at: now + ms, run, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.run(); }
    },
  };
}

test("the bubble shows only while listening or answering, and times out on its own", () => {
  const c = clock();
  const shown: { view: BubbleView | null; fresh: boolean }[] = [];
  const bubble = new Bubble({ publish: (view, fresh) => shown.push({ view, fresh }), now: c.now, after: c.after });
  bubble.voice(["Listening…"]);
  assert.equal(shown.at(-1)!.fresh, true, "a new interaction anchors at the cursor");
  bubble.voice(["Transcribing…"]);
  assert.equal(shown.at(-1)!.fresh, false, "the same interaction keeps its anchor");
  bubble.timed("voice", ["draft"], BUBBLE_TTL.ready);
  c.advance(BUBBLE_TTL.ready - 1);
  assert.notEqual(bubble.current, null);
  c.advance(1);
  assert.equal(bubble.current, null, "a ready draft hides after 20 s");
  assert.equal(shown.at(-1)!.view, null);

  bubble.timed("reply", ["answer"], BUBBLE_TTL.reply);
  assert.equal(shown.at(-1)!.view!.expiresAt, c.now() + BUBBLE_TTL.reply);
  bubble.timed("reply", ["longer answer"], BUBBLE_TTL.reply);
  c.advance(BUBBLE_TTL.reply - 1);
  assert.notEqual(bubble.current, null, "a replaced view's old timer doesn't hide the new one early");
  c.advance(1);
  assert.equal(bubble.current, null);

  bubble.voice(["Listening…"]);
  bubble.dismiss();
  assert.equal(bubble.current, null);
  const count = shown.length;
  bubble.dismiss();
  assert.equal(shown.length, count, "dismissing a hidden bubble publishes nothing");
});

test("bubble text is what Dum and the Wizard said, at most eight lines and 600 characters", () => {
  assert.deepEqual(bubbleLines(["Short answer."], "One aside."), ["Short answer.", "Wizard: One aside."]);
  const many = bubbleLines([Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")], "aside");
  assert.ok(many.length <= BUBBLE_LINES);
  assert.equal(many.at(-1), "Open Dum for the full reply");
  const long = bubbleLines(["x".repeat(2000)], null);
  assert.ok(long.slice(0, -1).join("").length <= BUBBLE_CHARS);
  assert.equal(long.at(-1), "Open Dum for the full reply");
});

test("shortened or omitted Wizard asides always show the full-reply notice", () => {
  for (const dum of [["x".repeat(590)], ["x".repeat(600)], Array.from({ length: 7 }, (_, i) => `line ${i}`)]) {
    const lines = bubbleLines(dum, "The Wizard has more to say.");
    assert.equal(lines.at(-1), "Open Dum for the full reply");
    assert.ok(lines.length <= BUBBLE_LINES);
    assert.ok(lines.slice(0, -1).join("").length <= BUBBLE_CHARS);
  }
  assert.deepEqual(bubbleLines(["x".repeat(580)], "small"), ["x".repeat(580), "Wizard: small"]);
});

test("dismissal gives focus back to the external app captured at summon, once", async () => {
  const calls: string[] = [];
  const focus = {
    capture: async () => { calls.push("capture"); return "h1"; },
    restore: async (handle: string) => { calls.push(`restore ${handle}`); return true; },
  };
  const back = new FocusReturn(focus);
  await back.summon();
  assert.equal(await back.dismiss(), true);
  assert.equal(await back.dismiss(), false, "a handle is used once");
  assert.deepEqual(calls, ["capture", "restore h1"]);

  // Blur to another app: the person chose where focus goes, so nothing is restored later.
  await back.summon();
  back.forget();
  assert.equal(await back.dismiss(), false);
  assert.deepEqual(calls, ["capture", "restore h1", "capture"]);

  // A failed or expired capture activates nothing.
  const broken = new FocusReturn({ capture: async () => { throw new Error("no helper"); }, restore: async () => { throw new Error("unreachable"); } });
  await broken.summon();
  assert.equal(await broken.dismiss(), false);
  const refused = new FocusReturn({ capture: async () => "h2", restore: async () => { throw new Error("helper stopped"); } });
  await refused.summon();
  assert.equal(await refused.dismiss(), false);
});

// -- the circle ------------------------------------------------------------------------------

const C = CIRCLE.window;
const within = (r: Rect, a: Rect) =>
  r.x >= a.x + CIRCLE.inset && r.y >= a.y + CIRCLE.inset && r.x + r.width <= a.x + a.width - CIRCLE.inset && r.y + r.height <= a.y + a.height - CIRCLE.inset;

test("the circle's default is 8 DIP from the primary's right edge, 35% down its usable range", () => {
  const rect = defaultCircle(main);
  assert.deepEqual(rect, { x: 1440 - 8 - C, y: Math.round(25 + 8 + 0.35 * (875 - 16 - C)), width: C, height: C });
  assert.ok(within(rect, main));
  assert.deepEqual(toPlacement(rect, main), { u: 1, v: (rect.y - 33) / (875 - 16 - C) });
});

test("the whole 64×64 rect clamps inside the work area with an 8 DIP inset, negative origins included", () => {
  assert.deepEqual(clampCircle({ x: -50, y: -50, width: C, height: C }, main), { x: 8, y: 33, width: C, height: C });
  assert.deepEqual(clampCircle({ x: 5000, y: 5000, width: C, height: C }, main), { x: 1440 - 8 - C, y: 900 - 8 - C, width: C, height: C });
  assert.deepEqual(clampCircle({ x: -1000, y: 0, width: C, height: C }, left), { x: -1000, y: 0, width: C, height: C }, "already inside stays put");
  assert.deepEqual(clampCircle({ x: 0, y: 0, width: 200, height: 10 }, main).width, C, "always the circle's size");
  const tiny: Rect = { x: 10, y: 10, width: 40, height: 40 };
  assert.deepEqual(clampCircle({ x: 100, y: 100, width: C, height: C }, tiny), { x: 18, y: 18, width: C, height: C }, "too small: top-left inset");
});

test("a normalized placement survives resolution and work-area changes without going offscreen", () => {
  const rect = clampCircle({ x: 300, y: 400, width: C, height: C }, main);
  const p = toPlacement(rect, main);
  assert.ok(p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1);
  assert.deepEqual(fromPlacement(p, main), rect, "round trip on the same area");
  const smaller: Rect = { x: 0, y: 25, width: 1024, height: 700 };
  const moved = fromPlacement(p, smaller);
  assert.ok(within(moved, smaller));
  assert.ok(Math.abs(toPlacement(moved, smaller).u - p.u) < 0.01, "same relative place");
  assert.deepEqual(fromPlacement({ u: 1, v: 1 }, left), { x: -8 - C, y: -300 + 1080 - 8 - C, width: C, height: C });
  assert.deepEqual(fromPlacement({ u: Number.NaN, v: 7 }, main), { x: 8, y: 900 - 8 - C, width: C, height: C }, "bad numbers are clamped");
});

const displays: DisplayArea[] = [
  { id: "1", workArea: main, bounds: { x: 0, y: 0, width: 1440, height: 900 }, primary: true },
  { id: "2", workArea: left, bounds: left, primary: false },
];

test("the nearest display to the pointer wins, including negative origins and gaps between displays", () => {
  assert.equal(nearestDisplay({ x: 100, y: 100 }, displays)?.id, "1");
  assert.equal(nearestDisplay({ x: -100, y: -200 }, displays)?.id, "2");
  assert.equal(nearestDisplay({ x: -5, y: 900 }, displays)?.id, "1", "below both: nearer to the main display's bounds");
  assert.equal(nearestDisplay({ x: -30, y: -290 }, displays)?.id, "2");
  const gap: DisplayArea[] = [displays[0]!, { id: "3", workArea: { x: 1600, y: 0, width: 800, height: 600 }, bounds: { x: 1600, y: 0, width: 800, height: 600 }, primary: false }];
  assert.equal(nearestDisplay({ x: 1500, y: 100 }, gap)?.id, "1");
  assert.equal(nearestDisplay({ x: 1560, y: 100 }, gap)?.id, "3");
  assert.equal(nearestDisplay({ x: 0, y: 0 }, []), null);
});

test("when the circle's display goes, it lands in the remaining work area nearest its old center", () => {
  const onLeft = clampCircle({ x: -200, y: 400, width: C, height: C }, left);
  const center = { x: onLeft.x + C / 2, y: onLeft.y + C / 2 };
  const remaining = nearestDisplay(center, [displays[0]!])!;
  const moved = clampCircle(onLeft, remaining.workArea);
  assert.deepEqual(moved, { x: 8, y: onLeft.y, width: C, height: C }, "the near edge of the main display, same height");
  assert.ok(within(moved, main));
});

test("only the round disk takes the pointer, not the transparent corners or padding", () => {
  const circle: Rect = { x: 100, y: 100, width: C, height: C };
  assert.ok(insideDisk({ x: 132, y: 132 }, circle), "center");
  assert.ok(insideDisk({ x: 132 + 28, y: 132 }, circle), "the rim");
  assert.ok(!insideDisk({ x: 132 + 29, y: 132 }, circle), "the padding");
  assert.ok(!insideDisk({ x: 102, y: 102 }, circle), "a corner");
  assert.ok(!insideDisk({ x: 132 + 21, y: 132 + 21 }, circle), "a corner of the inscribed square");
});

test("the working window sits right of the circle, centered on it; else left; else the roomier side, clamped", () => {
  const right = placeWindow({ x: 100, y: 500, width: C, height: C }, main, WINDOW_SIZE);
  assert.deepEqual(right, { x: 100 + C + WINDOW_GAP, y: 532 - 720 / 2, width: 640, height: 720 });
  const leftSide = placeWindow(defaultCircle(main), main, WINDOW_SIZE);
  assert.equal(leftSide.x, defaultCircle(main).x - WINDOW_GAP - 640);
  assert.ok(inside(leftSide, main));
  const middle: Rect = { x: 0, y: 0, width: 1000, height: 900 };
  const squeezed = placeWindow({ x: 300, y: 400, width: C, height: C }, middle, WINDOW_SIZE);
  assert.ok(inside(squeezed, middle), "clamped onscreen");
  assert.equal(squeezed.width, 640);
  assert.ok(squeezed.x > 300, "the right had more room");
  const small: Rect = { x: 0, y: 0, width: 500, height: 400 };
  const shrunk = placeWindow({ x: 400, y: 200, width: C, height: C }, small, WINDOW_SIZE);
  assert.deepEqual(shrunk, { x: 8, y: 8, width: 500 - 16, height: 400 - 16 }, "shrunk to the work area and clamped; it may cover the circle");
  const topEdge = placeWindow({ x: 100, y: 33, width: C, height: C }, main, WINDOW_SIZE);
  assert.equal(topEdge.y, 33, "vertical centering clamps at the top");
});

function gestureClock() {
  let now = 10_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}
const start: Rect = { x: 1000, y: 300, width: C, height: C };
const center = { x: 1032, y: 332 };

test("a short still press toggles; a long one does nothing; double clicks toggle once", () => {
  const c = gestureClock();
  const g = new CircleGesture(c.now);
  let id = g.begin(center, start);
  assert.equal(g.active, id);
  c.advance(120);
  assert.equal(g.move(id, { x: center.x + 3, y: center.y + 3 }), null, "below 6 DIP is not a drag");
  assert.equal(g.end(id, { x: center.x + 3, y: center.y + 3 }), "toggle");
  assert.equal(g.active, null);
  assert.equal(g.end(id, center), "none", "a gesture ends once");

  c.advance(100);
  id = g.begin(center, start);
  assert.equal(g.end(id, center), "none", "a second click inside 250 ms does nothing");
  c.advance(300);
  id = g.begin(center, start);
  c.advance(CIRCLE.toggleMs);
  assert.equal(g.end(id, center), "toggle", "500 ms is still a click");
  c.advance(1000);
  id = g.begin(center, start);
  c.advance(CIRCLE.toggleMs + 1);
  assert.equal(g.end(id, center), "none", "a stationary longer hold does nothing");
});

test("6 DIP of movement at any point makes the whole gesture a drag that follows global deltas", () => {
  const c = gestureClock();
  const g = new CircleGesture(c.now);
  const id = g.begin(center, start);
  assert.equal(g.move(id, { x: center.x + 5, y: center.y }), null);
  assert.deepEqual(g.move(id, { x: center.x + 6, y: center.y }), { ...start, x: start.x + 6 }, "no delay before movement");
  // Back where it started: still a drag, never a click.
  assert.deepEqual(g.move(id, center), start);
  assert.equal(g.end(id, center), "drag");
  const fast = g.begin(center, start);
  assert.equal(g.end(fast, { x: center.x - 400, y: center.y + 900 }), "drag", "a release far away is a drag even with no sample between");
  const diagonal = g.begin(center, start);
  assert.deepEqual(g.move(diagonal, { x: center.x - 5, y: center.y - 5 }), { ...start, x: start.x - 5, y: start.y - 5 }, "distance, not one axis");
  assert.equal(g.move("someone-else", { x: 0, y: 0 }), null);
});

test("cancel restores the starting place and never toggles; a missing release times out after 10 s", () => {
  const c = gestureClock();
  const g = new CircleGesture(c.now);
  const id = g.begin(center, start);
  g.move(id, { x: center.x + 50, y: center.y + 50 });
  assert.deepEqual(g.cancel(id), start);
  assert.equal(g.cancel(id), null);
  assert.equal(g.end(id, center), "none");

  const stuck = g.begin(center, start);
  c.advance(CIRCLE.releaseMs - 1);
  assert.equal(g.overdue(stuck), false);
  c.advance(1);
  assert.equal(g.overdue(stuck), true);
  assert.deepEqual(g.cancel(stuck), start);
  assert.equal(g.overdue(stuck), false);
});

test("a press on the transparent padding neither opens Dum nor drags; a new press replaces an unfinished one", () => {
  const c = gestureClock();
  const g = new CircleGesture(c.now);
  const corner = g.begin({ x: start.x + 1, y: start.y + 1 }, start);
  assert.equal(g.move(corner, { x: start.x + 40, y: start.y + 40 }), null);
  assert.equal(g.end(corner, { x: start.x + 1, y: start.y + 1 }), "none");
  const first = g.begin(center, start);
  const second = g.begin(center, start);
  assert.notEqual(first, second);
  assert.equal(g.end(first, center), "none");
  assert.equal(g.end(second, center), "toggle");
});

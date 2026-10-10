import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUBBLE_TTL, Bubble, CIRCLE, COLUMN, CircleGesture, FocusReturn, MARGIN, PANEL_CLEAR, PANEL_SIZE, bubbleLines,
  clampCircle, columnRect, defaultCircle, diskCenter, firstSentence, fromPlacement, insideColumn, insideDisk, nearestDisplay, placeBubble,
  THOUGHT, placePanel, placeThought, reclamp, slotAt, slotCenter, toPlacement,
  type DisplayArea, type Rect,
} from "../src/desktop/surfaces.ts";
import { circleSlots, goalMark } from "../src/desktop/ipc.ts";
import type { BubbleView, Snapshot } from "../src/desktop/protocol.ts";
import type { GoalView, StepView } from "../src/step-types.ts";
import type { Zone } from "../src/zone-types.ts";

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

test("a reply is one sentence of what Dum said, plus one Wizard sentence when the Wizard spoke", () => {
  assert.deepEqual(bubbleLines(["Short answer. And more detail after it."], "One aside. Another."), ["Short answer.", "Wizard: One aside."]);
  assert.deepEqual(bubbleLines(["Continuing.", "Finished."], null), ["Continuing."], "the first thing Dum said");
  assert.deepEqual(bubbleLines([], "Only the Wizard."), ["Wizard: Only the Wizard."]);
  assert.deepEqual(bubbleLines(["  ", ""], null), []);
  const long = bubbleLines(["x".repeat(2000)], "y".repeat(500));
  assert.equal(long.length, 2);
  assert.ok(long[0]!.length <= 140 && long[0]!.endsWith("…"), "a long sentence is cut to 140 characters and ellipsized");
  assert.ok(long[1]!.length <= 140 && long[1]!.startsWith("Wizard: ") && long[1]!.endsWith("…"));
  assert.deepEqual(bubbleLines([Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")], null).length, 1, "never more than one line of Dum's");
});

test("the first sentence ends at a sentence end or a paragraph break, with whitespace collapsed", () => {
  assert.equal(firstSentence("Pick a project.   Then build it."), "Pick a project.");
  assert.equal(firstSentence("Is it done? Yes."), "Is it done?");
  assert.equal(firstSentence("Open src/app.ts first.\nThen run it."), "Open src/app.ts first.", "a dot inside a word isn't an end");
  assert.equal(firstSentence("A heading\n\nThe body."), "A heading");
  assert.equal(firstSentence("no end at all"), "no end at all");
  assert.equal(firstSentence(" \n "), "");
  assert.equal(firstSentence("abcdef", 4), "abc…");
});

const STEP: StepView = {
  id: "project-1a2b", zoneId: "z1", goal: "SQL", kind: "project", text: "Pick a project theme or idea.",
  skill: null, pick: { label: "Pick the project idea for me", prompt: "Pick a SQL project idea for me." }, confirmSkip: false,
};

test("the step stays until it changes or goes away, and comes back after anything passing", () => {
  const c = clock();
  const shown: { view: BubbleView | null; fresh: boolean }[] = [];
  const bubble = new Bubble({ publish: (view, fresh) => shown.push({ view, fresh }), now: c.now, after: c.after });
  bubble.step(STEP);
  assert.deepEqual(shown.at(-1), { view: { kind: "step", step: STEP, expiresAt: 0 }, fresh: true });
  c.advance(10 * 60_000);
  assert.equal(bubble.current?.kind, "step", "a step never times out");
  const count = shown.length;
  bubble.step({ ...STEP });
  assert.equal(shown.length, count, "the same step publishes nothing again");

  bubble.timed("reply", ["Here's one idea."], BUBBLE_TTL.reply);
  assert.equal(shown.at(-1)!.view!.kind, "reply", "a reply takes the bubble meanwhile");
  assert.equal(shown.at(-1)!.fresh, true, "and anchors at the cursor");
  c.advance(BUBBLE_TTL.reply);
  assert.equal(bubble.current?.kind, "step", "the step comes back when the reply goes");
  bubble.voice(["Listening…"]);
  bubble.dismiss();
  assert.equal(bubble.current?.kind, "step", "dismissing what passed leaves the step");

  const next: StepView = { ...STEP, id: "milestone-3c4d", kind: "milestone", text: "Write the first query." };
  bubble.step(next);
  assert.deepEqual(shown.at(-1), { view: { kind: "step", step: next, expiresAt: 0 }, fresh: true }, "a new step replaces the old");
  bubble.step({ ...next, text: "Write the first SELECT query." });
  assert.equal(shown.at(-1)!.fresh, false, "the same step with new words updates in place");
  bubble.step(null);
  assert.equal(bubble.current, null);
  assert.equal(shown.at(-1)!.view, null, "a done or skipped step goes away");
});

test("the step hides while the working window is in front, and while asleep", () => {
  const shown: (BubbleView | null)[] = [];
  const bubble = new Bubble({ publish: (view) => shown.push(view), now: () => 0, after: () => () => {} });
  bubble.windowFront(true);
  bubble.step(STEP);
  assert.equal(bubble.current, null, "they're already looking at it");
  assert.equal(shown.length, 0);
  bubble.windowFront(false);
  assert.equal(bubble.current?.kind, "step");
  bubble.suspend(true);
  assert.equal(bubble.current, null);
  bubble.timed("reply", ["x"], BUBBLE_TTL.reply);
  assert.equal(bubble.current, null, "nothing shows while suspended");
  bubble.suspend(false);
  assert.equal(bubble.current?.kind, "step");
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

test("the Wizard jumps in once per chime for 20 s, over the step, and gives the step back", () => {
  const c = clock();
  const shown: { view: BubbleView | null; fresh: boolean }[] = [];
  const bubble = new Bubble({ publish: (view, fresh) => shown.push({ view, fresh }), now: c.now, after: c.after });
  bubble.step(STEP);
  const chime = { id: "w1", at: "2026-10-10T00:00:00.000Z", text: "Try printing the rows before the join." };
  bubble.wizard(chime);
  assert.deepEqual(shown.at(-1), { view: { kind: "wizard", text: chime.text, expiresAt: c.now() + BUBBLE_TTL.wizard }, fresh: true });
  assert.equal(BUBBLE_TTL.wizard, 20_000);
  const count = shown.length;
  bubble.wizard({ ...chime });
  bubble.step({ ...STEP });
  assert.equal(shown.length, count, "the same chime and the same step change nothing");
  c.advance(BUBBLE_TTL.wizard - 1);
  assert.equal(bubble.current?.kind, "wizard");
  c.advance(1);
  assert.deepEqual(bubble.current, { kind: "step", step: STEP, expiresAt: 0 }, "the step comes back");
  bubble.wizard(chime);
  assert.equal(bubble.current?.kind, "step", "a chime shows once");
  bubble.wizard(null);
  assert.equal(bubble.current?.kind, "step");

  // Between a reply and the Wizard the newer one shows; voice wins over both.
  bubble.timed("reply", ["Here's one."], BUBBLE_TTL.reply);
  bubble.wizard({ ...chime, id: "w2" });
  assert.equal(bubble.current?.kind, "wizard");
  bubble.timed("reply", ["And another."], BUBBLE_TTL.reply);
  assert.equal(bubble.current?.kind, "reply");
  assert.equal(shown.at(-1)!.fresh, true, "a reply after the cloud anchors at the cursor again");
  bubble.dismiss();
  assert.equal(bubble.current?.kind, "wizard", "the Wizard is still live under it");
  bubble.voice(["Listening…"]);
  assert.equal(bubble.current?.kind, "voice");
});

test("the Wizard is skipped while the working window is in front, and while asleep", () => {
  const shown: (BubbleView | null)[] = [];
  const bubble = new Bubble({ publish: (view) => shown.push(view), now: () => 0, after: () => () => {} });
  const chime = { id: "w1", at: "2026-10-10T00:00:00.000Z", text: "Stuck? Read the error's last line." };
  bubble.windowFront(true);
  bubble.wizard(chime);
  bubble.windowFront(false);
  assert.equal(bubble.current, null, "the panel showed it; it doesn't come back later");
  bubble.suspend(true);
  bubble.wizard({ ...chime, id: "w2" });
  bubble.suspend(false);
  assert.equal(bubble.current, null);
  bubble.wizard({ ...chime, id: "w3" });
  assert.equal(bubble.current?.kind, "wizard");
  bubble.windowFront(true);
  assert.equal(bubble.current, null, "hidden while they look at the window");
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

test("a panel's top-left corner sits at the disk's center; it flips left or up when it doesn't fit", () => {
  const circle: Rect = { x: 100, y: 200, width: C, height: C };
  const disk = diskCenter(circle);
  assert.deepEqual(disk, { x: 132, y: 232 });
  assert.deepEqual(placePanel(disk, main, PANEL_SIZE.goal), { x: 132, y: 232, width: 440, height: 640 });
  const right = { x: diskCenter(defaultCircle(main)).x, y: 132 };
  const flipped = placePanel(right, main, PANEL_SIZE.dum);
  assert.equal(flipped.x + flipped.width, right.x, "no room on the right: its top-right corner is at the disk");
  assert.equal(flipped.y, right.y);
  const low = { x: 132, y: 800 };
  const up = placePanel(low, main, PANEL_SIZE.tree);
  assert.deepEqual(up, { x: 132, y: 800 - 560, width: 760, height: 560 }, "no room below: its bottom-left corner is at the disk");
  const corner = placePanel({ x: 1400, y: 850 }, main, PANEL_SIZE.dum);
  assert.deepEqual([corner.x + corner.width, corner.y + corner.height], [1400, 850], "both flips");
  const small: Rect = { x: 0, y: 0, width: 500, height: 400 };
  const shrunk = placePanel({ x: 250, y: 200 }, small, PANEL_SIZE.tree);
  assert.deepEqual(shrunk, { x: 8, y: 8, width: 484, height: 384 }, "shrunk to the work area and clamped");
  assert.ok(inside(placePanel({ x: -1000, y: -200 }, left, PANEL_SIZE.goal), left), "negative origins as they are");
  assert.ok(PANEL_CLEAR >= CIRCLE.disk / 2, "the disk over a corner stays inside the clear square");
});

test("the column grows down from the circle, one 64 DIP slot per circle, shifted up near the bottom", () => {
  const circle: Rect = { x: 1000, y: 300, width: C, height: C };
  assert.deepEqual(columnRect(circle, main, 7), { x: 1000, y: 300, width: C, height: 7 * COLUMN.pitch });
  assert.deepEqual(columnRect(circle, main, 1), circle, "one circle is the circle itself");
  const low = clampCircle({ x: 1000, y: 5000, width: C, height: C }, main);
  const shifted = columnRect(low, main, 7);
  assert.equal(shifted.y + shifted.height, main.y + main.height - CIRCLE.inset, "clamped to the work area's bottom");
  assert.equal(COLUMN.slots, 7, "Dum, three goals, the tree, the monitor, settings");
  assert.deepEqual(columnRect(circle, main, 9).height, 7 * COLUMN.pitch, "never more than seven slots");
  const short: Rect = { x: 0, y: 0, width: 800, height: 200 };
  assert.equal(columnRect({ x: 10, y: 50, width: C, height: C }, short, 7).y, CIRCLE.inset, "too tall: the top stays inset");
});

test("a click resolves to the disk under main's pointer sample; the gaps and corners are nothing", () => {
  const column: Rect = { x: 1000, y: 300, width: C, height: 7 * 64 };
  assert.deepEqual(slotCenter(column, 2), { x: 1032, y: 300 + 32 + 128 });
  assert.equal(slotAt({ x: 1032, y: 332 }, column, 7), 0);
  assert.equal(slotAt({ x: 1032, y: 332 + 64 * 6 + 28 }, column, 7), 6, "the rim of the last disk");
  assert.equal(slotAt({ x: 1032, y: 332 + 64 * 6 }, column, 6), null, "a slot past the count isn't one");
  assert.equal(slotAt({ x: 1032, y: 300 + 64 }, column, 7), null, "between two disks");
  assert.equal(slotAt({ x: 1003, y: 332 + 64 }, column, 7), null, "beside a disk");
  assert.ok(insideColumn({ x: 1032, y: 300 + 64 }, column), "between disks is still the shared background");
  assert.ok(insideColumn({ x: 1003, y: 300 + 160 }, column), "the background's straight side");
  assert.ok(!insideColumn({ x: 1001, y: 301 }, column), "its transparent corner");
  assert.ok(!insideColumn({ x: 1032, y: 300 + 7 * 64 + 1 }, column), "below it");
});

test("the thought cloud sits beside the circle, top-aligned, its puffs toward it; left of it near the right edge", () => {
  const circle: Rect = { x: 100, y: 300, width: C, height: C };
  const width = THOUGHT.cloud.width + THOUGHT.puffs;
  assert.deepEqual(placeThought(circle, main), { rect: { x: 100 + C + THOUGHT.gap, y: 300, width, height: THOUGHT.cloud.height }, toward: "left" });
  const edge = defaultCircle(main);
  const leftOf = placeThought(edge, main);
  assert.equal(leftOf.toward, "right", "the circle is on the cloud's right");
  assert.equal(leftOf.rect.x + leftOf.rect.width, edge.x - THOUGHT.gap);
  assert.equal(leftOf.rect.y, edge.y);
  const low = placeThought({ x: 100, y: 860, width: C, height: C }, main);
  assert.ok(inside(low.rect, main), "clamped onscreen");
});

const zoneRow = (id: string, name: string, updatedAt: string, deletedAt: string | null = null): Zone => ({
  id, parentId: null, name, goal: name, language: null, focusSkills: [], createdAt: updatedAt, updatedAt, deletedAt,
});
const goal = (id: string, done: number, total: number, step: StepView | null = null): GoalView => ({ id, path: [], progress: { done, total }, step, skippedAt: null });
const AGENT = { backend: "claude" } as unknown as NonNullable<Snapshot["settings"]["agent"]>;
type Recording = { screen?: boolean; paused?: boolean; permission?: Snapshot["look"]["permission"]; agent?: Snapshot["settings"]["agent"] };
const snap = (zones: Zone[], active: string | null, pinned: string[], goals: GoalView[] = [], rec: Recording = {}) => ({
  zones: { version: 1, revision: 3, activeZoneId: active, zones }, goals, pinned,
  settings: { look: { apps: true, screen: rec.screen ?? true }, agent: rec.agent === undefined ? AGENT : rec.agent },
  look: { paused: rec.paused ?? false, permission: rec.permission ?? "granted" },
} as unknown as Snapshot);

test("the column is Dum, the pinned goals or else the three latest with the active first, then the tree, monitor and settings", () => {
  const zones = [
    zoneRow("a", "learn sql", "2026-10-01T00:00:00.000Z"), zoneRow("b", "Rust", "2026-10-05T00:00:00.000Z"),
    zoneRow("c", "web app basics", "2026-10-04T00:00:00.000Z"), zoneRow("d", "Go", "2026-10-03T00:00:00.000Z"),
    zoneRow("e", "gone", "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z"),
  ];
  const latest = circleSlots(snap(zones, "a", [], [goal("a", 1, 4, { ...STEP, zoneId: "a" }), goal("b", 0, 0)]));
  assert.deepEqual(latest.map((s) => s.ref), [
    { kind: "dum" }, { kind: "goal", id: "a" }, { kind: "goal", id: "b" }, { kind: "goal", id: "c" }, { kind: "tree" }, { kind: "monitor" }, { kind: "settings" },
  ]);
  assert.deepEqual(latest[0], { ref: { kind: "dum" }, label: "Dum: your goals", mark: "D", progress: 0, waiting: false });
  assert.deepEqual(latest[1], { ref: { kind: "goal", id: "a" }, label: "Goal: learn sql", mark: "LS", progress: 0.25, waiting: true });
  assert.deepEqual(latest[2], { ref: { kind: "goal", id: "b" }, label: "Goal: Rust", mark: "R", progress: 0, waiting: false }, "no path yet is 0");
  assert.deepEqual(latest[4], { ref: { kind: "tree" }, label: "Skill tree", mark: "T", progress: 0, waiting: false });
  assert.deepEqual(latest[5], { ref: { kind: "monitor" }, label: "Monitor: recording", mark: "M", progress: 0, waiting: true });
  assert.deepEqual(latest[6], { ref: { kind: "settings" }, label: "Settings", mark: "S", progress: 0, waiting: false });

  const pinned = circleSlots(snap(zones, "a", ["d", "e", "missing"]));
  assert.deepEqual(pinned.map((s) => s.ref.kind === "goal" ? s.ref.id : s.ref.kind), ["dum", "d", "tree", "monitor", "settings"], "pinned only, live only");
  assert.deepEqual(circleSlots(snap([], null, [])).map((s) => s.ref.kind), ["dum", "tree", "monitor", "settings"]);
});

test("the monitor says it's recording only while the screen look is on, unpaused, allowed and powered", () => {
  const monitor = (rec: Recording) => circleSlots(snap([], null, [], [], rec)).find((s) => s.ref.kind === "monitor")!;
  assert.deepEqual([monitor({}).label, monitor({}).waiting], ["Monitor: recording", true]);
  assert.equal(monitor({ permission: "not-required" }).waiting, true, "no permission needed on this system");
  for (const rec of [{ screen: false }, { paused: true }, { permission: "denied" }, { permission: "not-determined" }, { agent: null }] as Recording[]) {
    assert.deepEqual([monitor(rec).label, monitor(rec).waiting], ["Monitor: not recording", false], JSON.stringify(rec));
  }
});

test("a goal's mark is one or two uppercase initials", () => {
  assert.equal(goalMark("learn sql"), "LS");
  assert.equal(goalMark("Rust"), "R");
  assert.equal(goalMark("  data -- engineering pipelines "), "DE");
  assert.equal(goalMark("ölçü birimi"), "ÖB");
  assert.equal(goalMark("---"), "G");
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

test("on the column, main's own hit test decides: the shared background clicks, its corners don't", () => {
  const c = gestureClock();
  const g = new CircleGesture(c.now);
  const column: Rect = { x: 1000, y: 300, width: C, height: 5 * 64 };
  const low = { x: 1032, y: 300 + 64 * 3 + 32 };
  const id = g.begin(low, column, insideColumn(low, column));
  assert.equal(g.end(id, low), "toggle", "a click on a lower disk, far outside the old 64×64 disk test");
  c.advance(1000);
  const corner = { x: 1001, y: 301 };
  const missed = g.begin(corner, column, insideColumn(corner, column));
  assert.equal(g.end(missed, corner), "none");
});

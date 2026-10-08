import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUBBLE_CHARS, BUBBLE_LINES, BUBBLE_TTL, Bubble, FocusReturn, MARGIN, bubbleLines, placeBubble, placeCentered, reclamp, type Rect,
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

test("a small display shrinks the bubble and the command bar to fit", () => {
  const tiny: Rect = { x: 100, y: 100, width: 300, height: 150 };
  const bubble = placeBubble({ x: 150, y: 150 }, tiny);
  assert.ok(inside(bubble, tiny));
  assert.equal(bubble.width, 300 - 2 * MARGIN);
  const bar = placeCentered(tiny, { width: 640, height: 360 });
  assert.ok(inside(bar, tiny));
  assert.deepEqual(placeCentered(main, { width: 640, height: 360 }), { x: 400, y: 283, width: 640, height: 360 });
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
  assert.equal(many.at(-1), "Open the command bar for the full reply");
  const long = bubbleLines(["x".repeat(2000)], null);
  assert.ok(long.slice(0, -1).join("").length <= BUBBLE_CHARS);
  assert.equal(long.at(-1), "Open the command bar for the full reply");
});

test("Esc gives focus back to the app that had it, or to Dum's panel", async () => {
  const calls: string[] = [];
  const focus = {
    capture: async () => { calls.push("capture"); return "h1"; },
    restore: async (handle: string) => { calls.push(`restore ${handle}`); return true; },
  };
  const back = new FocusReturn(focus);
  await back.summon(false);
  assert.equal(await back.dismiss(), true);
  assert.equal(await back.dismiss(), false, "a handle is used once");
  await back.summon(true);
  assert.equal(await back.dismiss(), "panel");
  assert.deepEqual(calls, ["capture", "restore h1"], "the panel case never touches the focus helper");

  const broken = new FocusReturn({ capture: async () => { throw new Error("no helper"); }, restore: async () => true });
  await broken.summon(false);
  assert.equal(await broken.dismiss(), false);
});

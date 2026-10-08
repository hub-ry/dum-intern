import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { Observer, changedCells, grid, maskCells, maskFrame, type Bitmap, type ObserverOptions, type Shot } from "../src/desktop/observer.ts";
import type { Rect } from "../src/desktop/surfaces.ts";
import { LOOK, TickSchema, type Tick } from "../src/observe-types.ts";
import { MAX_IMAGE_BYTES } from "../src/look.ts";

const [W, H] = LOOK.grid;
const ZONE = "1b4e28ba-2fa1-4d2b-9c3e-0123456789ab";
/** The display the rig captures: 1280×800 DIP at the origin, shot at 320×200 (5×5 px per grid cell, 20×20 DIP). */
const DISPLAY: Rect = { x: 0, y: 0, width: 1280, height: 800 };
const shot = (bitmap: Bitmap, displayId = "1", display: Rect = DISPLAY): Shot => ({ displayId, display, bitmap });

function solid(level: number, width = 320, height = 200): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = level; data[i + 3] = 255; }
  return { width, height, data };
}

/** Paint the top-left `cells` grid cells of a 320×200 bitmap (5×5 px each) to `level`. */
function paint(base: Bitmap, cells: number, level: number): Bitmap {
  const data = Uint8Array.from(base.data);
  for (let c = 0; c < cells; c++) {
    const cx = (c % W) * 5, cy = Math.floor(c / W) * 5;
    for (let y = cy; y < cy + 5; y++) for (let x = cx; x < cx + 5; x++) {
      const i = (y * base.width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = level;
    }
  }
  return { ...base, data };
}

function rig(over: Partial<ObserverOptions> = {}) {
  const ticks: Tick[] = [];
  let run: (() => void) | null = null;
  let interval = 0;
  let stopped = false;
  const calls = { thumbnail: 0, capture: 0, frontmost: 0 };
  let clock = 1_000;
  const frames: Shot[] = [];
  const own: { rects: Rect[] } = { rects: [] };
  const encoded: Bitmap[] = [];
  const state = { blocked: null as string | null, zone: { zoneId: ZONE, epoch: "e1" } as { zoneId: string; epoch: string } | null };
  const observer = new Observer({
    zone: () => state.zone,
    blocked: () => state.blocked,
    frontmost: async () => { calls.frontmost++; return { bundleId: "com.apple.Terminal", name: "Terminal", windowId: 7 }; },
    thumbnail: async () => { calls.thumbnail++; return frames.shift() ?? shot(solid(0)); },
    capture: async () => { calls.capture++; return shot(solid(0, 16, 10)); },
    encode: (frame) => { encoded.push(frame); return Buffer.from("png-bytes"); },
    own: () => own.rects,
    send: (t) => ticks.push(t),
    look: { apps: true, screen: true },
    now: () => clock,
    every: (ms, fn) => { interval = ms; run = fn; return () => { stopped = true; }; },
    ...over,
  });
  const fire = async () => { clock += LOOK.tickMs; run!(); await turn(); };
  const push = (...bitmaps: Bitmap[]) => frames.push(...bitmaps.map((b) => shot(b)));
  return { observer, ticks, calls, frames, push, own, encoded, state, fire, interval: () => interval, stopped: () => stopped };
}

test("grid reduces a bitmap to 64×40 gray means", () => {
  const g = grid(paint(solid(10), 1, 200));
  assert.equal(g.length, W * H);
  assert.equal(g[0], 200);
  assert.equal(g[1], 10);
  assert.throws(() => grid({ width: 4, height: 4, data: new Uint8Array(3) }));
});

test("changedCells counts only moves above the level delta", () => {
  const a = new Uint8Array(W * H).fill(100);
  const b = Uint8Array.from(a);
  b[0] = 100 + LOOK.levelDelta;      // at threshold: not changed
  b[1] = 100 + LOOK.levelDelta + 1;  // above
  b[2] = 100 - LOOK.levelDelta - 1;  // below, other direction
  assert.equal(changedCells(a, b), 2);
  assert.equal(changedCells(a, a), 0);
  assert.throws(() => changedCells(a, new Uint8Array(3)));
});

test("ticks every LOOK.tickMs with app and screen activity, schema-valid", async () => {
  const r = rig();
  assert.equal(r.interval(), LOOK.tickMs);
  r.push(solid(0), paint(solid(0), 5, 255));
  await r.fire();
  await r.fire();
  assert.equal(r.ticks.length, 2);
  assert.equal(r.ticks[0].screen, null, "first grid has nothing to compare against");
  assert.deepEqual(r.ticks[1].screen, { changedCells: 5 });
  assert.equal(r.ticks[1].app?.bundleId, "com.apple.Terminal");
  assert.equal(r.ticks[1].at - r.ticks[0].at, LOOK.tickMs);
  for (const t of r.ticks) TickSchema.parse(t);
  r.observer.close();
  assert.ok(r.stopped());
});

test("nothing is captured while look.screen is off", async () => {
  const r = rig({ look: { apps: true, screen: false } });
  await r.fire();
  await r.fire();
  assert.equal(r.calls.thumbnail, 0);
  assert.equal(await r.observer.frame(), null);
  assert.equal(r.calls.capture, 0);
  assert.equal(r.ticks.length, 2);
  assert.ok(r.ticks.every((t) => t.screen === null && t.app !== null));

  r.observer.setLook({ apps: false, screen: false });
  await r.fire();
  assert.equal(r.calls.frontmost, 2);
  assert.equal(r.ticks[2].app, null);
});

test("no tick and no capture while paused, blocked or without a zone", async () => {
  const r = rig();
  r.observer.pause(true);
  await r.fire();
  r.observer.pause(false);
  r.state.blocked = "recording";
  await r.fire();
  r.state.blocked = null;
  r.state.zone = null;
  await r.fire();
  assert.equal(r.ticks.length, 0);
  assert.equal(r.calls.thumbnail + r.calls.frontmost + r.calls.capture, 0);
  r.state.blocked = "locked";
  r.state.zone = { zoneId: ZONE, epoch: "e1" };
  assert.equal(await r.observer.frame(), null);
  assert.equal(r.calls.capture, 0);
});

test("the grid is kept for one tick only", async () => {
  const r = rig();
  const changed = paint(solid(0), 10, 255);
  r.push(solid(0), changed);
  await r.fire();
  await r.fire();
  assert.deepEqual(r.ticks[1].screen, { changedCells: 10 });
  // A blocked tick drops the grid: the next tick has no baseline to compare against.
  r.state.blocked = "sleep";
  await r.fire();
  r.state.blocked = null;
  r.push(solid(0));
  await r.fire();
  assert.equal(r.ticks[2].screen, null);
  // Comparison is always against the immediately previous grid, not an older one.
  r.push(solid(0));
  await r.fire();
  assert.deepEqual(r.ticks[3].screen, { changedCells: 0 });
});

test("frame returns one PNG and keeps none", async () => {
  const r = rig();
  const a = await r.observer.frame();
  assert.deepEqual(a, { mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") });
  assert.equal(r.calls.capture, 1);
  const b = await r.observer.frame();
  assert.equal(r.calls.capture, 2, "every request captures afresh; nothing cached");
  assert.notEqual(a, b);
  r.observer.close();
  assert.equal(await r.observer.frame(), null);
  assert.equal(r.calls.capture, 2);
});

test("frames get their own size: wider than the activity thumbnail, and never over look.ts's decode bound", async () => {
  assert.ok(LOOK.frameWidth >= 1280 && LOOK.frameWidth > LOOK.thumbWidth, "wide enough to read code");
  assert.ok(LOOK.frameBytes <= MAX_IMAGE_BYTES);
  const atCap = Buffer.alloc(LOOK.frameBytes, 1);
  assert.equal((await rig({ encode: () => atCap }).observer.frame())?.data, atCap.toString("base64"));
  const r = rig({ encode: () => Buffer.alloc(LOOK.frameBytes + 1, 1) });
  assert.equal(await r.observer.frame(), null, "an oversize frame is not sent");
});

/** Paint a DIP rect of the rig's 320×200 capture of DISPLAY (4 DIP per px) to `level`. */
function paintRect(base: Bitmap, rect: Rect, level: number): Bitmap {
  const data = Uint8Array.from(base.data);
  for (let y = Math.floor(rect.y / 4); y < Math.ceil((rect.y + rect.height) / 4); y++) {
    for (let x = Math.floor(rect.x / 4); x < Math.ceil((rect.x + rect.width) / 4); x++) {
      const i = (y * base.width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = level;
    }
  }
  return { ...base, data };
}

/** The always-on circle with an animated face, drawn onto otherwise unchanged external pixels. */
const circleAt = (x: number, y: number): Rect => ({ x, y, width: 64, height: 64 });
const withFace = (rect: Rect, level: number) => paintRect(solid(40), rect, level);

test("changedCells skips ignored cells and checks their size", () => {
  const a = new Uint8Array(W * H).fill(100);
  const b = Uint8Array.from(a).fill(200, 0, 10);
  const ignored = new Uint8Array(W * H).fill(1, 0, 4);
  assert.equal(changedCells(a, b, LOOK.levelDelta, ignored), 6);
  assert.throws(() => changedCells(a, b, LOOK.levelDelta, new Uint8Array(3)));
});

test("maskCells maps global DIP through the display's bounds and the capture's own size, negative origins included", () => {
  // 20 DIP per cell on this display: a 64 DIP circle at (100,100) covers cells 5..8 in both axes.
  const mask = maskCells(DISPLAY, { width: 320, height: 200 }, [circleAt(100, 100)]);
  const covered = [...mask.keys()].filter((c) => mask[c]);
  const expected: number[] = [];
  for (let row = 5; row <= 8; row++) for (let col = 5; col <= 8; col++) expected.push(row * W + col);
  assert.deepEqual(covered, expected);
  // The same circle on a display left of the primary, captured at a different size: same cells.
  const left: Rect = { x: -1280, y: -200, width: 1280, height: 800 };
  assert.deepEqual(maskCells(left, { width: 640, height: 400 }, [circleAt(-1180, -100)]), mask);
  assert.ok(maskCells(DISPLAY, { width: 320, height: 200 }, [circleAt(2000, 100)]).every((m) => m === 0), "a rect on another display masks nothing");
  const edge = maskCells(DISPLAY, { width: 320, height: 200 }, [{ x: 1270, y: 790, width: 64, height: 64 }]);
  assert.equal(edge[(H - 1) * W + (W - 1)], 1, "a rect hanging off the edge masks the cells it covers");
});

test("maskFrame paints Dum's rects neutral in a copy, in capture pixels", () => {
  const frame = solid(10, 128, 80); // 10 DIP per px of DISPLAY
  const masked = maskFrame(frame, DISPLAY, [circleAt(100, 100)]);
  const px = (b: Bitmap, x: number, y: number) => b.data[(y * b.width + x) * 4];
  assert.equal(px(masked, 10, 10), 128, "inside the circle's rect");
  assert.equal(px(masked, 16, 16), 128, "its last covered pixel");
  assert.equal(px(masked, 17, 17), 10, "outside it");
  assert.equal(px(masked, 9, 10), 10);
  assert.equal(px(frame, 10, 10), 10, "the input is untouched");
});

test("an animating circle and a drag over unchanged external pixels yield zero changed cells", async () => {
  const r = rig();
  let circle = circleAt(600, 300);
  r.own.rects = [circle];
  r.push(withFace(circle, 255));
  await r.fire();
  r.push(withFace(circle, 90)); // the face's next frame
  await r.fire();
  assert.deepEqual(r.ticks[1].screen, { changedCells: 0 }, "animation inside the circle is not activity");
  // Dragged elsewhere: the old place now shows the unchanged desktop, the new place shows the circle.
  circle = circleAt(200, 500);
  r.own.rects = [circle];
  r.push(withFace(circle, 255));
  await r.fire();
  assert.deepEqual(r.ticks[2].screen, { changedCells: 0 }, "neither the uncovered nor the newly covered cells count");
  r.push(withFace(circle, 255));
  await r.fire();
  assert.deepEqual(r.ticks[3].screen, { changedCells: 0 }, "no artificial change the tick after");
});

test("an external change outside Dum's windows still triggers", async () => {
  const r = rig();
  const circle = circleAt(600, 300);
  const windowRect: Rect = { x: 680, y: 40, width: 400, height: 600 };
  r.own.rects = [circle, windowRect];
  r.push(withFace(circle, 255), paintRect(withFace(circle, 90), { x: 0, y: 0, width: 100, height: 20 }, 255));
  await r.fire();
  await r.fire();
  assert.deepEqual(r.ticks[1].screen, { changedCells: 5 }, "five cells changed in the top-left, none of them Dum");
});

test("a capture from another display starts the comparison over", async () => {
  const r = rig();
  r.frames.push(shot(solid(0)), shot(paint(solid(0), 30, 255), "2"), shot(paint(solid(0), 30, 255), "2"));
  await r.fire();
  await r.fire();
  assert.equal(r.ticks[1].screen, null, "no baseline on the new display");
  await r.fire();
  assert.deepEqual(r.ticks[2].screen, { changedCells: 0 });
});

test("a frame for the host has Dum's current windows painted out before encoding", async () => {
  const r = rig();
  r.own.rects = [circleAt(0, 0)];
  assert.ok(await r.observer.frame());
  const sent = r.encoded.at(-1)!;
  // 16×10 capture of 1280×800: 80 DIP per px, so the circle covers pixel (0,0) only.
  assert.equal(sent.data[0], 128);
  assert.equal(sent.data[4], 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { Observer, changedCells, grid, type Bitmap, type ObserverOptions } from "../src/desktop/observer.ts";
import { LOOK, TickSchema, type Tick } from "../src/observe-types.ts";
import { MAX_IMAGE_BYTES } from "../src/look.ts";

const [W, H] = LOOK.grid;
const ZONE = "1b4e28ba-2fa1-4d2b-9c3e-0123456789ab";

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
  const frames: Bitmap[] = [];
  const state = { blocked: null as string | null, zone: { zoneId: ZONE, epoch: "e1" } as { zoneId: string; epoch: string } | null };
  const observer = new Observer({
    zone: () => state.zone,
    blocked: () => state.blocked,
    frontmost: async () => { calls.frontmost++; return { bundleId: "com.apple.Terminal", name: "Terminal", windowId: 7 }; },
    thumbnail: async () => { calls.thumbnail++; return frames.shift() ?? solid(0); },
    capture: async () => { calls.capture++; return Buffer.from("png-bytes"); },
    send: (t) => ticks.push(t),
    look: { apps: true, screen: true },
    now: () => clock,
    every: (ms, fn) => { interval = ms; run = fn; return () => { stopped = true; }; },
    ...over,
  });
  const fire = async () => { clock += LOOK.tickMs; run!(); await turn(); };
  return { observer, ticks, calls, frames, state, fire, interval: () => interval, stopped: () => stopped };
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
  r.frames.push(solid(0), paint(solid(0), 5, 255));
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
  assert.equal(await r.observer.frame("c1"), null);
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
  assert.equal(await r.observer.frame("c2"), null);
  assert.equal(r.calls.capture, 0);
  assert.match(r.observer.status, /locked/);
});

test("the grid is kept for one tick only", async () => {
  const r = rig();
  const changed = paint(solid(0), 10, 255);
  r.frames.push(solid(0), changed);
  await r.fire();
  await r.fire();
  assert.deepEqual(r.ticks[1].screen, { changedCells: 10 });
  // A blocked tick drops the grid: the next tick has no baseline to compare against.
  r.state.blocked = "sleep";
  await r.fire();
  r.state.blocked = null;
  r.frames.push(solid(0));
  await r.fire();
  assert.equal(r.ticks[2].screen, null);
  // Comparison is always against the immediately previous grid, not an older one.
  r.frames.push(solid(0));
  await r.fire();
  assert.deepEqual(r.ticks[3].screen, { changedCells: 0 });
});

test("frame returns one PNG and keeps none", async () => {
  const r = rig();
  const a = await r.observer.frame("check-1");
  assert.deepEqual(a, { mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") });
  assert.equal(r.calls.capture, 1);
  const b = await r.observer.frame("check-2");
  assert.equal(r.calls.capture, 2, "every request captures afresh; nothing cached");
  assert.notEqual(a, b);
  r.observer.close();
  assert.equal(await r.observer.frame("check-3"), null);
  assert.equal(r.calls.capture, 2);
});

test("frames get their own size: wider than the activity thumbnail, and never over look.ts's decode bound", async () => {
  assert.ok(LOOK.frameWidth >= 1280 && LOOK.frameWidth > LOOK.thumbWidth, "wide enough to read code");
  assert.ok(LOOK.frameBytes <= MAX_IMAGE_BYTES);
  const atCap = Buffer.alloc(LOOK.frameBytes, 1);
  assert.equal((await rig({ capture: async () => atCap }).observer.frame("fits"))?.data, atCap.toString("base64"));
  const r = rig({ capture: async () => Buffer.alloc(LOOK.frameBytes + 1, 1) });
  assert.equal(await r.observer.frame("too-big"), null, "an oversize frame is not sent");
  assert.match(r.observer.status, /too-big not sent/);
});

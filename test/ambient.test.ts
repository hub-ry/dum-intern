import assert from "node:assert/strict";
import test from "node:test";
import { Ambient, type AmbientOptions, type AmbientStatus } from "../src/ambient.ts";
import { LOOK } from "../src/observe-types.ts";
import type { Picture } from "../src/agent/types.ts";
import type { AmbientInput, AmbientResult, AppSignal, FileSignal, Tick } from "../src/observe-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

const ZONE = "11111111-1111-4111-8111-111111111111";
const EPOCH = "epoch-1";

type Pending = { input: AmbientInput; signal: AbortSignal; resolve: (r: AmbientResult) => void; reject: (e: Error) => void };

function app(bundleId: string, windowId: number | null = null): AppSignal {
  return { bundleId, name: bundleId, windowId };
}

function rig(over: Partial<AmbientOptions> & { auto?: boolean } = {}) {
  let now = 1_000_000;
  let scans: FileSignal[][] = [];
  let frameData = "frame-a";
  const calls: Pending[] = [];
  const records: { result: AmbientResult; input: AmbientInput }[] = [];
  const statuses: AmbientStatus[] = [];
  const frames: number[] = [];
  const state = { blocked: false, practicing: false, images: true };
  const auto = over.auto ?? true;
  const ambient = new Ambient({
    now: () => now,
    blocked: () => state.blocked,
    scan: async () => scans.shift() ?? [],
    diff: async (paths) => paths.map((path) => ({ path, diff: `diff of ${path}` })),
    frame: async (): Promise<Picture> => {
      frames.push(now);
      return { mimeType: "image/png", data: frameData };
    },
    context: () => ({
      zone: { id: ZONE } as unknown as ZoneContext,
      binding: { zoneId: ZONE, zoneEpoch: EPOCH, inputToken: "t", requestId: `r${calls.length}` },
      practicing: state.practicing,
    }),
    imagesAllowed: () => state.images,
    check: (input, signal) =>
      new Promise<AmbientResult>((resolve, reject) => {
        calls.push({ input, signal, resolve, reject });
        if (auto) resolve({ note: "note", aside: "aside" });
      }),
    record: async (result, input) => {
      records.push({ result, input });
    },
    status: (s) => statuses.push(s),
    ...over,
  });
  const settle = () => new Promise<void>((r) => setImmediate(r));
  async function tick(t: Partial<Pick<Tick, "app" | "screen">> = {}, files: FileSignal[] = []) {
    now += LOOK.tickMs;
    scans.push(files);
    await ambient.tick({ zoneId: ZONE, epoch: EPOCH, at: now, app: t.app ?? null, screen: t.screen ?? null });
    await settle();
  }
  async function ticks(n: number, t: Partial<Pick<Tick, "app" | "screen">> = {}) {
    for (let i = 0; i < n; i++) await tick(t);
  }
  return {
    ambient, calls, records, statuses, frames, state, tick, ticks, settle,
    advance: (ms: number) => { now += ms; },
    setFrame: (d: string) => { frameData = d; },
    clearScans: () => { scans = []; },
  };
}

const saved = (path: string, sha: string): FileSignal => ({ path, kind: "saved", sha });

test("code fires once after two quiet ticks, and not again inside 60 s", async () => {
  const r = rig();
  await r.tick({}, [saved("g/a.ts", "1")]);
  await r.tick();
  assert.equal(r.calls.length, 0, "one quiet tick is not enough");
  await r.tick();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input.triggers, ["code"]);
  assert.deepEqual(r.calls[0]!.input.files, [{ path: "g/a.ts", diff: "diff of g/a.ts" }]);
  assert.equal(r.calls[0]!.input.image, null, "code alone sends no frame");

  await r.advance(31_000);
  await r.tick({}, [saved("g/a.ts", "2")]);
  await r.ticks(3);
  assert.equal(r.calls.length, 1, "inside the code interval");
  await r.advance(30_000);
  await r.tick();
  assert.equal(r.calls.length, 2, "kept signals go out once the interval passes");
  assert.deepEqual(r.calls[1]!.input.files.map((f) => f.path), ["g/a.ts"]);
});

test("a format-on-save burst across files makes one call", async () => {
  const r = rig();
  await r.tick({}, [saved("g/a.ts", "1")]);
  await r.tick({}, [saved("g/a.ts", "2"), saved("g/b.ts", "1")]);
  await r.tick({}, [saved("g/c.ts", "1")]);
  await r.ticks(6);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input.files.map((f) => f.path), ["g/a.ts", "g/b.ts", "g/c.ts"]);
});

test("diffs are capped at 4 files and 96 KiB", async () => {
  const big = "x".repeat(60 * 1024);
  const r = rig({ diff: async (paths) => paths.map((path) => ({ path, diff: big })) });
  await r.tick({}, ["a", "b", "c", "d", "e"].map((p) => saved(`g/${p}`, "1")));
  await r.ticks(2);
  const files = r.calls[0]!.input.files;
  assert.equal(files.length, 2);
  assert.equal(files.reduce((n, f) => n + Buffer.byteLength(f.diff), 0), 96 * 1024);
});

test("an app switch fires after settling, with a frame, and not again inside 120 s", async () => {
  const r = rig();
  await r.ticks(2, { app: app("com.a") });
  await r.tick({ app: app("com.b") });
  assert.equal(r.calls.length, 0);
  await r.tick({ app: app("com.b") });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input.triggers, ["app"]);
  assert.equal(r.calls[0]!.input.app?.bundleId, "com.b");
  assert.equal(r.calls[0]!.input.image?.data, "frame-a");

  await r.advance(40_000);
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 1, "inside the app interval");
  await r.advance(120_000);
  await r.ticks(4, { app: app("com.c") });
  assert.equal(r.calls.length, 1, "a switch dropped inside its interval does not fire later");
  await r.ticks(2, { app: app("com.d") });
  assert.equal(r.calls.length, 2);
});

test("a window change on the same app counts when the window number is known", async () => {
  const r = rig();
  await r.ticks(2, { app: app("com.a", 1) });
  await r.ticks(2, { app: app("com.a", 2) });
  assert.equal(r.calls.length, 1);
});

test("app flicker shorter than two ticks makes no call", async () => {
  const r = rig();
  await r.ticks(2, { app: app("com.a") });
  await r.tick({ app: app("com.b") });
  await r.ticks(5, { app: app("com.a") });
  await r.tick({ app: app("com.c") });
  await r.tick({ app: app("com.a") });
  assert.equal(r.calls.length, 0);
});

test("returning to an app already sent within 10 minutes makes no call", async () => {
  const r = rig();
  await r.ticks(2, { app: app("com.a") });
  await r.ticks(2, { app: app("com.b") });
  assert.equal(r.calls.length, 1);
  r.advance(130_000);
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 2);
  r.advance(130_000);
  await r.ticks(2, { app: app("com.b") });
  assert.equal(r.calls.length, 2, "com.b was sent under 10 minutes ago");
  r.advance(LOOK.appRepeatMs);
  r.setFrame("frame-b");
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 3, "after 10 minutes the return counts");
});

test("typing needs 2 of 5 active ticks then 2 idle ticks on the same app", async () => {
  const r = rig();
  const a = app("com.editor");
  const active = { app: a, screen: { changedCells: 10 } };
  const still = { app: a, screen: { changedCells: 1 } };
  await r.tick(active);
  await r.ticks(2, still);
  assert.equal(r.calls.length, 0, "one active tick is not typing");

  await r.tick(active);
  await r.tick(still);
  await r.tick(active);
  await r.tick(still);
  assert.equal(r.calls.length, 0, "one idle tick has not settled");
  await r.tick(still);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input.triggers, ["typing"]);
  assert.equal(r.calls[0]!.input.image?.data, "frame-a");

  r.advance(40_000);
  await r.ticks(2, active);
  await r.ticks(2, still);
  assert.equal(r.calls.length, 1, "inside the typing interval");
  r.advance(90_000);
  r.setFrame("frame-b");
  await r.ticks(2, active);
  await r.ticks(2, still);
  assert.equal(r.calls.length, 2);
});

test("typing across an app change and without the screen signal makes no call", async () => {
  const r = rig();
  await r.ticks(2, { app: app("com.a"), screen: { changedCells: 10 } });
  await r.ticks(2, { app: app("com.b"), screen: { changedCells: 0 } });
  assert.deepEqual(r.calls.map((c) => c.input.triggers), [["app"]], "only the switch fires");
  const s = rig();
  await s.ticks(2, { app: app("com.a"), screen: null });
  await s.ticks(4, { app: app("com.a"), screen: null });
  assert.equal(s.calls.length, 0);
});

test("global 30 s gap and 40 per rolling hour", async () => {
  const r = rig();
  let n = 0;
  const burst = async () => {
    n += 1;
    await r.tick({}, [saved("g/a.ts", String(n))]);
    await r.ticks(2);
  };
  await burst();
  assert.equal(r.calls.length, 1);
  await r.ticks(2, { app: app("com.a") });
  await r.ticks(2, { app: app("com.b") });
  assert.equal(r.calls.length, 1, "the app switch waits for the 30 s gap");
  r.advance(30_000);
  await r.tick({ app: app("com.b") });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1]!.input.triggers, ["app"]);

  const c = rig();
  for (let i = 0; i < 45; i++) {
    c.advance(LOOK.minMs.code);
    await c.tick({}, [saved("g/a.ts", String(i))]);
    await c.ticks(2);
  }
  assert.equal(c.calls.length, LOOK.hourlyCap);
  c.advance(10 * 60_000);
  await c.tick();
  assert.equal(c.calls.length, LOOK.hourlyCap + 1, "the window rolls");
});

test("one call in flight; triggers during it coalesce into the next call", async () => {
  const r = rig({ auto: false });
  await r.ticks(2, { app: app("com.a") });
  await r.ticks(2, { app: app("com.b") });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.statuses.at(-1), "checking");
  await r.tick({ app: app("com.b") }, [saved("g/a.ts", "1")]);
  await r.ticks(2, { app: app("com.b"), screen: { changedCells: 9 } });
  await r.ticks(2, { app: app("com.b"), screen: { changedCells: 0 } });
  r.advance(60_000);
  await r.tick({ app: app("com.b"), screen: { changedCells: 0 } });
  assert.equal(r.calls.length, 1, "still in flight");
  r.calls[0]!.resolve({ note: "n", aside: "a" });
  await r.settle();
  assert.equal(r.statuses.at(-1), "watching");
  await r.tick({ app: app("com.b"), screen: { changedCells: 0 } });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1]!.input.triggers, ["code", "typing"]);
  assert.equal(r.records.length, 1);
  r.calls[1]!.resolve({ note: null, aside: null });
  await r.settle();
  assert.equal(r.records.length, 2);
});

test("an identical signal set never calls twice", async () => {
  const r = rig();
  const a = app("com.editor");
  await r.ticks(1, { app: a, screen: { changedCells: 0 } });
  await r.ticks(2, { app: a, screen: { changedCells: 9 } });
  await r.ticks(2, { app: a, screen: { changedCells: 0 } });
  assert.equal(r.calls.length, 1);
  r.advance(100_000);
  await r.ticks(2, { app: a, screen: { changedCells: 9 } });
  await r.ticks(2, { app: a, screen: { changedCells: 0 } });
  assert.equal(r.calls.length, 1, "same app and same frame");
  r.setFrame("frame-b");
  r.advance(100_000);
  await r.ticks(2, { app: a, screen: { changedCells: 9 } });
  await r.ticks(2, { app: a, screen: { changedCells: 0 } });
  assert.equal(r.calls.length, 2);
});

test("a timed-out or failed call frees the slot and counts toward the limits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = rig({ auto: false });
  await r.ticks(2, { app: app("com.a") });
  await r.ticks(2, { app: app("com.b") });
  assert.equal(r.calls.length, 1);
  t.mock.timers.tick(LOOK.checkMs);
  await r.settle();
  assert.equal(r.calls[0]!.signal.aborted, true);
  assert.equal(r.statuses.at(-1), "failed");
  r.calls[0]!.resolve({ note: "late", aside: "late" });
  await r.settle();
  assert.equal(r.records.length, 0, "a late answer is dropped");

  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 1, "the timed-out call still holds the 30 s gap");
  r.advance(130_000);
  await r.ticks(2, { app: app("com.d") });
  assert.equal(r.calls.length, 2);
  r.calls[1]!.reject(new Error("backend down"));
  await r.settle();
  assert.equal(r.statuses.at(-1), "failed");
  r.advance(10_000);
  await r.ticks(2, { app: app("com.e") });
  assert.equal(r.calls.length, 2, "a failed call counts toward the gap");
});

test("blocked ticks drop pending triggers", async () => {
  const r = rig();
  await r.tick({}, [saved("g/a.ts", "1")]);
  await r.tick();
  r.state.blocked = true;
  await r.tick();
  assert.equal(r.statuses.at(-1), "blocked");
  r.state.blocked = false;
  await r.ticks(4);
  assert.equal(r.calls.length, 0, "the save before the block was dropped");

  await r.ticks(2, { app: app("com.a") });
  r.state.blocked = true;
  await r.ticks(2, { app: app("com.b") });
  r.state.blocked = false;
  await r.ticks(3, { app: app("com.b") });
  assert.equal(r.calls.length, 0, "a switch made while blocked does not fire later");
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 1);
});

test("no frame when images are not allowed; no aside while practicing", async () => {
  const r = rig();
  r.state.images = false;
  r.state.practicing = true;
  await r.ticks(2, { app: app("com.a") });
  await r.ticks(2, { app: app("com.b") });
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.input.image, null);
  assert.equal(r.frames.length, 0, "main is never asked for a frame");
  assert.deepEqual(r.records[0]!.result, { note: "note", aside: null });
});

test("close aborts the call in flight and stops ticking", async () => {
  const r = rig({ auto: false });
  await r.ticks(2, { app: app("com.a") });
  await r.ticks(2, { app: app("com.b") });
  r.ambient.close();
  assert.equal(r.calls[0]!.signal.aborted, true);
  r.advance(200_000);
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 1);
});

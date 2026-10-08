import assert from "node:assert/strict";
import test from "node:test";
import { Ambient, MAX_NOTE, nearDuplicate, observationPrompt, observe, parseObservation, type AmbientOptions, type LookView } from "../src/ambient.ts";
import { createRegistry } from "../src/agent/registry.ts";
import { LOOK } from "../src/observe-types.ts";
import type { AgentBackend, AgentEvent, OpenOptions, Picture, Selector, UserTurn } from "../src/agent/types.ts";
import type { AmbientInput, AmbientResult, AppSignal, FileSignal, Tick } from "../src/observe-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

const ZONE = "11111111-1111-4111-8111-111111111111";
const EPOCH = "epoch-1";

type Pending = { input: AmbientInput; signal: AbortSignal; resolve: (r: AmbientResult) => void; reject: (e: Error) => void };

function app(bundleId: string, windowId: number | null = null): AppSignal {
  return { bundleId, name: bundleId, windowId };
}

const moving = { changedCells: LOOK.activeCells };
const still = { changedCells: LOOK.activeCells - 1 };

/**
 * A look with scripted collaborators. Frames are fresh on every capture unless `setFrame` pins one;
 * calls answer `reply` at once unless `auto` is false.
 */
function rig(over: Partial<AmbientOptions> & { auto?: boolean } = {}) {
  let now = 1_000_000;
  let scans: FileSignal[][] = [];
  let pinned: string | null = null;
  let captured = 0;
  const calls: Pending[] = [];
  const records: { result: AmbientResult; input: AmbientInput }[] = [];
  const views: LookView[] = [];
  const frames: number[] = [];
  const notes: string[] = [];
  const state = {
    blocked: false, advised: true,
    pictures: { ok: true, why: "" },
    reply: { note: "note" } as AmbientResult,
  };
  const auto = over.auto ?? true;
  const ambient = new Ambient({
    now: () => now,
    blocked: () => state.blocked,
    advised: () => state.advised,
    scan: async () => scans.shift() ?? [],
    diff: async (paths) => paths.map((path) => ({ path, diff: `diff of ${path}` })),
    frame: async (): Promise<Picture> => {
      frames.push(now);
      captured += 1;
      return { mimeType: "image/png", data: pinned ?? `frame-${captured}` };
    },
    context: () => ({
      zone: { id: ZONE } as unknown as ZoneContext,
      binding: { zoneId: ZONE, zoneEpoch: EPOCH, inputToken: "t", requestId: `r${calls.length}` },
    }),
    pictures: async () => state.pictures,
    check: (input, signal) =>
      new Promise<AmbientResult>((resolve, reject) => {
        calls.push({ input, signal, resolve, reject });
        if (auto) resolve(state.reply);
      }),
    notes: () => notes,
    record: async (result, input) => {
      records.push({ result, input });
      if (result.note) notes.push(result.note);
    },
    status: (v) => views.push(v),
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
    ambient, calls, records, views, frames, notes, state, tick, ticks, settle,
    statuses: () => views.map((v) => v.status),
    advance: (ms: number) => { now += ms; },
    setFrame: (d: string | null) => { pinned = d; },
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
  assert.equal(r.frames.length, 0);

  r.advance(31_000);
  await r.tick({}, [saved("g/a.ts", "2")]);
  await r.ticks(3);
  assert.equal(r.calls.length, 1, "inside the code interval");
  r.advance(30_000);
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
  assert.equal(r.calls[0]!.input.image?.data, "frame-1");

  r.advance(40_000);
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 1, "inside the app interval");
  r.advance(120_000);
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
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 3, "after 10 minutes the return counts");
});

test("the live look: every tick where the screen changed makes one call with one fresh frame", async () => {
  const r = rig();
  const a = app("com.editor");
  await r.tick({ app: a, screen: still });
  assert.equal(r.calls.length, 0, "fewer changed cells than LOOK.activeCells is no change");
  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input.triggers, ["screen"]);
  assert.equal(r.calls[0]!.input.image?.data, "frame-1");
  await r.ticks(3, { app: a, screen: moving });
  assert.equal(r.calls.length, 4, "one call a tick while the screen keeps changing");
  assert.deepEqual(r.calls.map((c) => c.input.image?.data), ["frame-1", "frame-2", "frame-3", "frame-4"]);
  r.setFrame("frame-4");
  await r.ticks(5, { app: a, screen: still });
  assert.equal(r.calls.length, 4, "a still screen makes no call");
  assert.equal(r.frames.length, 5, "the typing pause takes one frame, the same as the last one sent, so nothing goes out");
});

test("screen calls are at least LOOK.tickMs apart, one at a time, and coalesce while one is in flight", async () => {
  const r = rig({ auto: false });
  const a = app("com.editor");
  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 1);
  assert.equal(r.statuses().at(-1), "checking");
  await r.ticks(4, { app: a, screen: moving });
  await r.tick({ app: a, screen: still });
  assert.equal(r.calls.length, 1, "nothing else starts while a call is in flight");
  assert.equal(r.frames.length, 1, "and no frame is taken for it");
  r.calls[0]!.resolve({ note: "editing main.ts" });
  await r.settle();
  await r.tick({ app: a, screen: still });
  assert.equal(r.calls.length, 2, "the changes made during the call go out as one call");
  assert.deepEqual(r.calls[1]!.input.triggers, ["typing", "screen"]);
  assert.equal(r.frames.length, 2, "with one fresh frame taken now");

  const gap = rig();
  await gap.tick({ app: a, screen: moving });
  gap.advance(-LOOK.tickMs + 1);
  await gap.tick({ app: a, screen: moving });
  assert.equal(gap.calls.length, 1, "a tick under LOOK.minMs.any after the last start waits");
  await gap.tick({ app: a, screen: still });
  assert.equal(gap.calls.length, 2, "the change it saw goes out on the next tick");
});

test("at most LOOK.hourlyCap calls start in any rolling hour", async () => {
  assert.equal(LOOK.hourlyCap, 1_200);
  assert.equal(LOOK.minMs.any, LOOK.tickMs);
  const r = rig();
  const a = app("com.editor");
  const hour = 3_600_000 / LOOK.tickMs;
  await r.ticks(hour + 10, { app: a, screen: moving });
  const starts = r.frames;
  for (let i = 0; i < starts.length; i++) {
    const inHour = starts.filter((t) => t >= starts[i]! && t < starts[i]! + 3_600_000).length;
    assert.ok(inHour <= LOOK.hourlyCap, `${inHour} calls in the hour from call ${i}`);
  }
  assert.equal(r.calls.length, hour + 10, "one a tick is exactly the cap");
});

test("an identical frame is never sent twice", async () => {
  const r = rig();
  const a = app("com.editor");
  r.setFrame("same");
  await r.tick({ app: a, screen: moving });
  await r.ticks(3, { app: a, screen: moving });
  assert.equal(r.calls.length, 1, "the same frame hash makes no second call");
  r.advance(30 * 60_000);
  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 1, "not later in the hour either");
  r.setFrame("other");
  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 2);
});

test("each call is stateless: the previous observation in words, never an earlier frame", async () => {
  const r = rig();
  const a = app("com.editor");
  r.state.reply = { note: "reading the parser in parse.ts" };
  await r.tick({ app: a, screen: moving });
  r.state.reply = { note: "writing a test for the parser" };
  await r.tick({ app: a, screen: moving });
  await r.tick({ app: a, screen: moving });
  const [first, second, third] = r.calls.map((c) => c.input);
  assert.equal(first!.previous, null);
  assert.equal(second!.previous, "reading the parser in parse.ts");
  assert.equal(third!.previous, "writing a test for the parser");
  for (const [i, input] of [first!, second!, third!].entries()) {
    assert.equal(input.image?.data, `frame-${i + 1}`, "only the fresh frame of this call");
    assert.deepEqual(JSON.stringify(input).match(/frame-\d+/g), [`frame-${i + 1}`], "no earlier frame anywhere in the input");
  }
  assert.equal(r.views.at(-1)!.seen, "writing a test for the parser", "the latest observation is shown in the look status");
});

test("a memory note only when the activity changed, at most one a minute", async () => {
  const r = rig();
  const a = app("com.editor");
  r.state.reply = { note: "editing the tokenizer in lex.ts" };
  await r.tick({ app: a, screen: moving });
  assert.deepEqual(r.notes, ["editing the tokenizer in lex.ts"]);
  r.state.reply = { note: "debugging a failing test in parse.test.ts" };
  await r.tick({ app: a, screen: moving });
  assert.equal(r.notes.length, 1, "a new note inside 60 s waits");
  r.advance(LOOK.noteMs);
  r.state.reply = { note: "still editing the tokenizer in lex.ts" };
  await r.tick({ app: a, screen: moving });
  assert.equal(r.notes.length, 1, "a near-duplicate of a recent note isn't written");
  r.state.reply = { note: "debugging a failing test in parse.test.ts" };
  await r.tick({ app: a, screen: moving });
  assert.deepEqual(r.notes, ["editing the tokenizer in lex.ts", "debugging a failing test in parse.test.ts"]);
  assert.equal(nearDuplicate("Editing lex.ts!", "editing lex.ts"), true);
  assert.equal(nearDuplicate("editing lex.ts", "writing docs for the site"), false);
});

test("typing still counts and coalesces with the screen into one call", async () => {
  const r = rig({ auto: false });
  const a = app("com.editor");
  await r.tick({ app: a, screen: moving });
  await r.ticks(2, { app: a, screen: moving });
  await r.ticks(2, { app: a, screen: still });
  assert.equal(r.calls.length, 1, "the first change is in flight");
  r.calls[0]!.resolve({ note: null });
  await r.settle();
  await r.tick({ app: a, screen: still });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1]!.input.triggers, ["typing", "screen"]);
  assert.ok(r.calls[1]!.input.image);
});

test("when the look model can't be sent pictures, the status says why and screen changes alone make no call", async () => {
  const r = rig();
  r.state.pictures = { ok: false, why: "haiku changed to claude-haiku-9-9, which isn't verified for pictures yet" };
  const a = app("com.editor");
  await r.ticks(4, { app: a, screen: moving });
  assert.equal(r.calls.length, 0);
  assert.equal(r.frames.length, 0, "main is never asked for a frame");
  assert.equal(r.views.at(-1)!.noPictures, "haiku changed to claude-haiku-9-9, which isn't verified for pictures yet");

  await r.ticks(2, { app: app("com.b"), screen: still });
  assert.equal(r.calls.length, 1, "an app switch still makes a text-only call");
  assert.equal(r.calls[0]!.input.image, null);
  assert.deepEqual(r.records[0]!.result, { note: "note" });

  r.state.pictures = { ok: true, why: "" };
  r.advance(LOOK.minMs.any);
  await r.tick({ app: app("com.b"), screen: moving });
  assert.equal(r.views.at(-1)!.noPictures, "", "the status clears once pictures are allowed again");
  assert.equal(r.calls.length, 2);
});

test("typing makes a text-only call when pictures are refused", async () => {
  const r = rig();
  r.state.pictures = { ok: false, why: "" };
  const a = app("com.editor");
  await r.tick({ app: a, screen: moving });
  await r.tick({ app: a, screen: still });
  await r.tick({ app: a, screen: moving });
  await r.ticks(2, { app: a, screen: still });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.input.triggers, ["typing"]);
  assert.equal(r.calls[0]!.input.image, null);
});

test("a timed-out or failed call frees the slot and counts toward the limits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = rig({ auto: false });
  const a = app("com.editor");
  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 1);
  await r.ticks(3, { app: a, screen: moving });
  assert.equal(r.calls.length, 1, "the slot is held until the call ends");
  t.mock.timers.tick(LOOK.checkMs);
  await r.settle();
  assert.equal(r.calls[0]!.signal.aborted, true);
  assert.equal(r.statuses().at(-1), "failed");
  r.calls[0]!.resolve({ note: "late" });
  await r.settle();
  assert.equal(r.records.length, 0, "a late answer is dropped");

  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 2, "the slot is free again");
  r.calls[1]!.reject(new Error("backend down"));
  await r.settle();
  assert.equal(r.statuses().at(-1), "failed");
  r.advance(-LOOK.tickMs + 1);
  await r.tick({ app: a, screen: moving });
  assert.equal(r.calls.length, 2, "a failed call counts toward the gap");
});

test("blocked ticks drop pending triggers", async () => {
  const r = rig();
  await r.tick({}, [saved("g/a.ts", "1")]);
  await r.tick();
  r.state.blocked = true;
  await r.tick({ screen: moving });
  assert.equal(r.statuses().at(-1), "blocked");
  r.state.blocked = false;
  await r.ticks(4);
  assert.equal(r.calls.length, 0, "the save and the screen change before the block were dropped");

  await r.ticks(2, { app: app("com.a") });
  r.state.blocked = true;
  await r.ticks(2, { app: app("com.b") });
  r.state.blocked = false;
  await r.ticks(3, { app: app("com.b") });
  assert.equal(r.calls.length, 0, "a switch made while blocked does not fire later");
  await r.ticks(2, { app: app("com.c") });
  assert.equal(r.calls.length, 1);
});

test("with no backend the look says it's unadvised, and never calls or asks for a frame", async () => {
  const r = rig();
  r.state.advised = false;
  await r.tick({ app: app("com.a") }, [saved("g/a.ts", "1")]);
  await r.ticks(4, { app: app("com.b"), screen: moving });
  await r.ticks(4, { app: app("com.b"), screen: still });
  assert.deepEqual(r.statuses(), ["unadvised"]);
  assert.equal(r.calls.length, 0);
  assert.equal(r.frames.length, 0);

  r.state.advised = true;
  await r.tick({ app: app("com.b") }, [saved("g/b.ts", "1")]);
  assert.equal(r.statuses().at(-1), "watching");
  await r.ticks(2, { app: app("com.b") });
  assert.equal(r.calls.length, 1, "a change after a backend is chosen is advised");
  assert.deepEqual(r.calls[0]!.input.files.map((f) => f.path), ["g/b.ts"], "what was noticed without a backend isn't sent later");
});

test("close aborts the call in flight and stops ticking", async () => {
  const r = rig({ auto: false });
  await r.tick({ app: app("com.a"), screen: moving });
  r.ambient.close();
  assert.equal(r.calls[0]!.signal.aborted, true);
  r.advance(200_000);
  await r.ticks(2, { app: app("com.c"), screen: moving });
  assert.equal(r.calls.length, 1);
});

// -- the look call ------------------------------------------------------------

const zone = {
  id: ZONE, revision: 2, breadcrumb: [{ id: ZONE, name: "Leaderboard" }], goal: "Learn Python by building our club leaderboard",
  ancestorGoals: [], language: "python", focusSkills: [], notes: [],
} as ZoneContext;
const binding = { zoneId: ZONE, zoneEpoch: EPOCH, inputToken: "t", requestId: "r" };
const look = (over: Partial<AmbientInput> = {}): AmbientInput => ({
  zone, binding,
  triggers: ["code"],
  files: [{ path: "11111111-2222-4333-8444-555555555555/club/scores.py", diff: "+ ordered = sorted(scores, key=lambda row: row.score)" }],
  app: { bundleId: "com.microsoft.VSCode", name: "Code", windowId: 4 },
  image: null,
  previous: null,
  ...over,
});

/** A registry whose look model answers every one-shot with the next scripted reply. */
function lookModel(replies: (string | Error)[], images = true) {
  const opened: OpenOptions[] = [];
  const turns: UserTurn[] = [];
  const backend: AgentBackend = {
    id: "claude",
    label: "Claude",
    models: async () => [],
    capabilities: async (selector) => ({
      model: selector.model, images, noImages: images ? "" : `${selector.model} changed to claude-new, which isn't verified for pictures yet`, interrupt: true, runtimeActionCheck: true,
    }),
    open: async (o) => {
      opened.push(o);
      return {
        turn: async function* (input): AsyncIterable<AgentEvent> {
          turns.push(input);
          const next = replies.shift();
          if (next instanceof Error) yield { type: "end", error: next.message, interrupted: false };
          else {
            yield { type: "text", text: next ?? "" };
            yield { type: "end", error: null, interrupted: false };
          }
        },
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
  const agent = createRegistry([backend], new Set(["claude"]));
  const pick = (model: string): Selector => ({ backend: "claude", model, effort: "low" });
  agent.set({ backend: "claude", login: "anthropic-key", intern: pick("opus"), helper: pick("fable"), look: pick("haiku") });
  return { agent, opened, turns };
}

test("a look's prompt carries the zone, what changed, the previous observation and the diffs as data, and asks for no advice", () => {
  const text = observationPrompt(look({ previous: "reading scores.py", image: { mimeType: "image/png", data: "AAAA" } }));
  assert.match(text, /ZONE BACKGROUND/);
  assert.match(text, /what changed: code/);
  assert.match(text, /previous observation \(data\): "reading scores\.py"/);
  assert.match(text, /app in front: Code \(com\.microsoft\.VSCode\)/);
  assert.match(text, /SAVED CODE CHANGES \(untrusted data[\s\S]*sorted\(scores, key=lambda row: row\.score\)/);
  assert.match(text, /files: club\/scores\.py/);
  assert.doesNotMatch(text, /11111111-2222/, "grant IDs stay out");
  assert.match(text, /screen: a picture of it is attached/);
  assert.match(text, /never advise/);
  assert.match(text, /\{"note": "<one sentence>" or null\}/);
  assert.doesNotMatch(text, /anchor|"say"|ASIDE/i, "the look asks for no aside");
  assert.match(observationPrompt(look()), /screen: no picture/);
});

test("a look's reply is a bounded note or nothing, and anything else is unreadable", () => {
  const read = (v: unknown) => parseObservation(JSON.stringify(v));
  assert.deepEqual(read({ note: null }), { note: null });
  assert.deepEqual(read({ note: "  sorting the  leaderboard \u2014 by score " }), { note: "sorting the leaderboard - by score" });
  const long = read({ note: "word ".repeat(200) })!.note!;
  assert.ok(long.length <= MAX_NOTE && long.endsWith("…"));
  assert.deepEqual(read({ note: "see https://example.invalid" }), { note: null });
  assert.deepEqual(read({ note: "x\n```py\nx = 1\n```" }), { note: null });
  assert.deepEqual(read({ note: "editing", anchor: "python-sorting", say: "ties keep their order" }), { note: "editing" }, "an aside in the reply is ignored");
  assert.equal(parseObservation("not json"), null);
  assert.equal(read({ note: 7 }), null);
  assert.equal(read({ say: "hi" }), null);
});

test("observe makes one call on the look model with the one frame, and fails loudly rather than quietly", async () => {
  const frame: Picture = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  const m = lookModel([JSON.stringify({ note: "reading scores.py in Code" })]);
  const result = await observe(look({ image: frame, triggers: ["screen"] }), { agent: m.agent, cwd: "/h/zones/z/runtime", signal: new AbortController().signal });
  assert.deepEqual(result, { note: "reading scores.py in Code" });
  assert.equal(m.opened.length, 1);
  assert.deepEqual(m.opened[0]!.selector, { backend: "claude", model: "haiku", effort: "low" }, "the look role's model, not the helper's");
  assert.deepEqual(m.opened[0]!.actions, []);
  assert.deepEqual(m.turns[0]!.images, [frame]);
  const signal = new AbortController().signal;
  await assert.rejects(observe(look(), { agent: lookModel(["no idea"]).agent, cwd: "/tmp", signal }), /unreadable/);
  await assert.rejects(observe(look(), { agent: lookModel([new Error("rate limited")]).agent, cwd: "/tmp", signal }), /rate limited/);
  const moved = lookModel([], false);
  await assert.rejects(observe(look({ image: frame }), { agent: moved.agent, cwd: "/tmp", signal }), /haiku changed to claude-new, which isn't verified for pictures yet/);
  assert.equal(moved.opened.length, 0, "no picture went anywhere");
});

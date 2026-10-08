// Main's router, captures and the native seams, without Electron: role authority (circle, window,
// bubble), strict requests, typed-path consent, stale draft/voice/capture rejection, Do this as a
// consumed draft command, alignment without grants, independent debug with redaction, the circle's
// face and main's diagnostics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSetup } from "../src/desktop/agent-setup.ts";
import { Captures, type Capturer } from "../src/desktop/capture.ts";
import { Drafts } from "../src/desktop/draft.ts";
import { Router, circleView, ownedPage, type Host, type Native } from "../src/desktop/ipc.ts";
import { DesktopSettings } from "../src/desktop/settings.ts";
import { Bubble } from "../src/desktop/surfaces.ts";
import type { HostView } from "../src/desktop/host-client.ts";
import type { Context } from "../src/context.ts";
import type {
  AlignmentAcceptInput, AlignmentStepInput, ContextUseView, DecisionView, DirectionView, HandoffRunInput, HandoffView,
} from "../src/delegation-types.ts";
import type { DebugBinding, DebugView, MainStatus, SanitizedMainEvent } from "../src/diagnostic-types.ts";
import type { HostLookStatus } from "../src/observe-types.ts";
import type { BubbleView, CaptureSource, CircleReply, DesktopPreferences, Reply, Snapshot } from "../src/desktop/protocol.ts";
import type { VoiceEvent } from "../src/desktop/native-protocol.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../src/share-types.ts";
import type { SharedImage, State } from "../src/store-types.ts";
import type { StoryQuery, TrailQuery } from "../src/trail-types.ts";
import type { Zone, ZoneContext } from "../src/zone-types.ts";

const temp = () => mkdtempSync(join(tmpdir(), "dum-native-"));
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("IHDR-pretend-frame")]);
const SOURCES: CaptureSource[] = [
  { id: "screen:1:0", name: "Built-in display", kind: "screen" },
  { id: "window:42:0", name: "Editor - app.ts", kind: "window" },
];
const settle = () => new Promise((r) => setImmediate(r));
const zoneA = randomUUID();
const zoneB = randomUUID();
const bind = (patch: Partial<RequestBinding> = {}): RequestBinding => ({ zoneId: zoneA, zoneEpoch: "e1", inputToken: "t1", requestId: "r1", ...patch });

/** A capturer whose grabs finish only when the test says so. */
function capturer() {
  const grabs: { source: CaptureSource; finish: (png: Buffer | null) => void }[] = [];
  const c: Capturer = {
    list: async () => SOURCES,
    grab: (source) => {
      const { promise, resolve } = Promise.withResolvers<Buffer | null>();
      grabs.push({ source, finish: resolve });
      return promise;
    },
  };
  return { c, grabs };
}

// -- captures ---------------------------------------------------------------------------------

test("a capture is shown locally, then sent at most once, only for the binding it was taken for", async () => {
  let now = 1_000;
  const { c, grabs } = capturer();
  const captures = new Captures(c, 60_000, () => now);
  const here = bind();

  await assert.rejects(captures.preview("screen:1:0", here), /current list/, "only a listed source can be captured");
  await captures.sources();
  await assert.rejects(captures.preview("screen:9:0", here), /wasn't offered/);

  const first = captures.preview("window:42:0", here);
  await settle();
  await assert.rejects(captures.preview("screen:1:0", here), /already being taken/, "a racing second selection is refused");
  grabs[0]!.finish(Buffer.from(PNG));
  const preview = await first;
  assert.equal(preview.name, "Editor - app.ts");
  assert.ok(preview.dataUrl.startsWith("data:image/png;base64,"));
  assert.ok(!preview.dataUrl.includes(preview.token));

  assert.throws(() => captures.take(preview.token, bind({ requestId: "r2" })), /different prompt/, "another request can't take it");
  assert.equal(captures.holding, false, "a stale send releases the bytes");

  const again = captures.preview("window:42:0", here);
  grabs[1]!.finish(Buffer.from(PNG));
  const fresh = await again;
  const image: SharedImage = captures.take(fresh.token, here);
  assert.deepEqual(image, { data: PNG.toString("base64"), mimeType: "image/png", label: "Editor - app.ts" });
  assert.throws(() => captures.take(fresh.token, here), /no longer held/, "a token is consumed exactly once");

  const expiring = captures.preview("screen:1:0", here);
  grabs[2]!.finish(Buffer.from(PNG));
  const old = await expiring;
  now += 60_000;
  assert.throws(() => captures.take(old.token, here), /expired/);
  assert.equal(captures.holding, false);
});

test("discard and a binding change release a capture, including one still being taken", async () => {
  const { c, grabs } = capturer();
  const captures = new Captures(c);
  await captures.sources();

  const held = captures.preview("screen:1:0", bind());
  grabs[0]!.finish(Buffer.from(PNG));
  await held;
  captures.invalidate(bind());
  assert.equal(captures.holding, true, "the same binding keeps it");
  captures.invalidate(bind({ zoneEpoch: "e2" }));
  assert.equal(captures.holding, false, "a reopened zone drops it");

  const racing = captures.preview("window:42:0", bind());
  await settle();
  captures.invalidate(bind({ inputToken: "t2" }));
  const bytes = Buffer.from(PNG);
  grabs[1]!.finish(bytes);
  await assert.rejects(racing, /cancelled/);
  assert.ok(bytes.every((b) => b === 0), "a frame for the old prompt is wiped, never kept");

  const discarded = captures.preview("window:42:0", bind());
  await settle();
  captures.discard();
  grabs[2]!.finish(Buffer.from(PNG));
  await assert.rejects(discarded, /cancelled/);

  const gone = captures.preview("window:42:0", bind());
  grabs[3]!.finish(null);
  await assert.rejects(gone, /isn't available any more/);
  const junk = captures.preview("window:42:0", bind());
  grabs[4]!.finish(Buffer.from("GIF89a not a png"));
  await assert.rejects(junk, /isn't a PNG/);
  const empty = new Captures({ list: async () => [], grab: async () => null });
  await assert.rejects(empty.sources(), /No screens or windows/);
});

// -- the router -------------------------------------------------------------------------------

const AT = "2026-10-08T00:00:00.000Z";
const KEY = "sk-ant-api03-STOREDSTOREDSTOREDKEY";

function zone(id: string, parentId: string | null, name: string): Zone {
  return { id, parentId, name, goal: `learn ${name}`, language: null, focusSkills: [], createdAt: AT, updatedAt: AT, deletedAt: null };
}

function context(id: string, name: string): ZoneContext {
  return { id, revision: 1, breadcrumb: [{ id, name }], goal: `learn ${name}`, ancestorGoals: [], language: "", focusSkills: [], notes: [] };
}

function state(patch: Partial<State> = {}): State {
  return {
    zoneId: zoneA, zoneName: "Trees", mode: "understand", transcript: [], prompt: { type: "next" }, busy: false, status: "",
    stage: { kind: "conversation" }, unlocked: 0, models: { intern: null, helper: null, look: null }, ...patch,
  };
}

const LOOK: HostLookStatus = {
  status: "watching", reason: null, noPictures: "", seen: null, lastTick: null, lastAttempt: null, lastSuccess: null, chosen: null, resolved: null,
};
const NO_USE: ContextUseView = { subject: null, contextRevision: null, correctionRevision: 0, counts: { used: 0, omitted: 0, missing: 0, stale: 0 }, cursor: null };

function viewIn(patch: Partial<HostView> = {}): HostView {
  return {
    zoneEpoch: "e1", state: state(), tree: null,
    registry: { version: 1, revision: 3, activeZoneId: zoneA, zones: [zone(zoneA, null, "Trees"), zone(zoneB, zoneA, "AVL")] },
    activeZone: context(zoneA, "Trees"), inputToken: "t1", canAttach: true, shares: [], follows: [], changes: [],
    look: LOOK, direction: null, decision: null, handoff: null, contextUse: NO_USE, session: null, trail: null, ...patch,
  };
}

/** Opaque host results: the router forwards them, it never builds or reads them. */
const DIRECTION = { zoneId: zoneB, status: "aligning" } as unknown as DirectionView;
const DECISION = { id: randomUUID(), revision: 1 } as unknown as DecisionView;
const HANDOFF = { handoff: { id: randomUUID() } } as unknown as HandoffView;
const debugBinding = (): DebugBinding => ({ debugSessionId: randomUUID(), debugEpoch: "d1", requestId: "q1" });
const debugView = (texts: string[]): DebugView => ({
  binding: debugBinding(), state: "idle", entries: texts.map((text, id) => ({ id, from: id % 2 ? "dum" : "you", text })), dropped: 0, expiresAt: AT,
});

class FakeHost {
  view: HostView | null = viewIn();
  debug: DebugView | null = null;
  running = true;
  calls: string[] = [];
  /** What each new operation received, in order. */
  got: { op: string; input: unknown }[] = [];
  sent: { binding: RequestBinding; text: string; shares: ShareGrant[]; image?: SharedImage }[] = [];
  runs: HandoffRunInput[] = [];
  bindings: unknown[] = [];
  diagnostics: { events: readonly SanitizedMainEvent[]; status: MainStatus | null }[] = [];
  personalPath = "/me/background.md";
  /** Makes the next runHandoff wait until released. */
  hold: PromiseWithResolvers<void> | null = null;
  private record(op: string, input: unknown) { this.got.push({ op, input }); }
  async createZone(z: { name: string; goal: string }, enter: boolean) {
    this.calls.push(`create ${z.name} | ${z.goal} | ${enter}`);
    return { zone: zone(randomUUID(), null, z.name), direction: DIRECTION };
  }
  async openZone(id: string, rev: number) { this.calls.push(`enter ${id === zoneB ? "B" : id} ${rev}`); }
  async updateZone() { return { zone: zone(zoneB, zoneA, "AVL"), direction: DIRECTION }; }
  async zoneContext() { return context(zoneA, "Trees"); }
  async deleteZone(id: string) { this.calls.push(`delete ${id === zoneA ? "A" : "B"}`); return { activeZoneId: null, deletedIds: [zoneA, zoneB] }; }
  async settings(p: DesktopPreferences) { this.calls.push(`settings ${p.hotkey}`); }
  async agentSelect() {}
  async agentModels() { return []; }
  async send(binding: RequestBinding, text: string, shares: ShareGrant[], image?: SharedImage) { this.sent.push({ binding, text, shares, ...(image ? { image } : {}) }); }
  async respond(binding: RequestBinding) { this.bindings.push(binding); this.calls.push("respond"); }
  async command(name: string) { this.calls.push(`command ${name}`); }
  async selectView(view: string) { this.calls.push(`view ${view}`); }
  async shareAdd(path: string, kind: "file" | "folder", binding: RequestBinding): Promise<ShareGrant> {
    this.calls.push(`share ${kind} ${path}`);
    this.bindings.push(binding);
    const grant: ShareGrant = { id: randomUUID(), kind, scope: "request", label: "x", files: [] };
    this.view = { ...this.view!, shares: [...this.view!.shares, grant] };
    return grant;
  }
  async shareRemove() {}
  async followAdd(path: string) { this.calls.push(`follow ${path}`); return { id: randomUUID(), zoneId: zoneA, label: "x", addedAt: "", files: 0 }; }
  async followRemove() {}
  async changeRevert() { return {} as never; }
  async skillEdit(op: string) { this.calls.push(`skill ${op}`); }
  async treeSync() { return null; }
  async openRecord() { return "/app/record.md"; }
  async openPersonal(sourceId: string) { this.record("open-personal", sourceId); return this.personalPath; }
  async interrupt() { this.calls.push("interrupt"); }
  async alignmentRead(zoneId: string) { this.record("alignment-read", zoneId); return DIRECTION; }
  async alignmentStep(input: AlignmentStepInput) { this.record("alignment-step", input); return DIRECTION; }
  async alignmentAccept(input: AlignmentAcceptInput) { this.record("alignment-accept", input); return DIRECTION; }
  async directionRead(zoneId: string, directionId: string) { this.record("direction-read", { zoneId, directionId }); return {} as never; }
  async decisionHelp(binding: RequestBinding, outcome: string) { this.record("decision-help", { binding, outcome }); return DECISION; }
  async decisionDismiss(binding: RequestBinding) { this.record("decision-dismiss", binding); }
  async selectHandoff(input: unknown) { this.record("handoff-select", input); return HANDOFF; }
  async editHandoff(input: unknown) { this.record("handoff-edit", input); return HANDOFF; }
  async dismissHandoff(input: unknown) { this.record("handoff-dismiss", input); }
  async runHandoff(input: HandoffRunInput) {
    if (this.hold) await this.hold.promise;
    this.runs.push(input);
  }
  async readHandoff(zoneId: string, handoffId: string) { this.record("handoff-read", { zoneId, handoffId }); return HANDOFF; }
  async reviewHandoff(input: unknown) { this.record("handoff-review", input); return HANDOFF; }
  async contextUseRead(binding: RequestBinding, cursor: string | null) { this.record("context-use-read", { binding, cursor }); return { items: [], next: null }; }
  async contextReload(binding: RequestBinding, personal: Context) { this.record("context-reload", { binding, personal }); }
  async contextIgnoreObservation(input: unknown) { this.record("context-ignore-observation", input); }
  async newSession(binding: RequestBinding) { this.record("session-new", binding); }
  async trailRead(query: TrailQuery) { this.record("trail-read", query); return {} as never; }
  async trailSource(zoneId: string, sessionId: string, sourceId: string) { this.record("trail-source", { zoneId, sessionId, sourceId }); return {} as never; }
  async trailMap(input: unknown) { this.record("trail-map", input); }
  async storyRead(query: StoryQuery) { this.record("story-read", query); return { rows: [], next: null }; }
  async debugOpen() { this.record("debug-open", null); return this.debug ?? debugView([]); }
  async debugSend(binding: DebugBinding, text: string) { this.record("debug-send", { binding, text }); }
  async debugStop(binding: DebugBinding) { this.record("debug-stop", binding); }
  async debugReset() { this.record("debug-reset", null); return debugView([]); }
  async diagnosticMain(events: readonly SanitizedMainEvent[], status: MainStatus | null) { this.diagnostics.push({ events, status }); }
}

function desktop() {
  const dir = temp();
  const host = new FakeHost();
  const { c, grabs } = capturer();
  const captures = new Captures(c);
  const settings = DesktopSettings.load(dir);
  const calls: string[] = [];
  let conflict = "";
  let picked: string | null = null;
  let confirmed = true;
  let visible = false;
  let failure = "";
  let personal: Context = { path: "", text: "", warning: "" };
  const reloads: string[] = [];
  const stored: string[] = [];
  const displays = { displays: [{ id: "1", label: "Built-in", primary: true, current: true }], positioning: false };
  const native: Native = {
    choosePath: async (kind, purpose) => { calls.push(`pick ${kind} ${purpose}`); return picked; },
    confirm: async (message, detail) => { calls.push(`confirm ${message} ${detail}`); return confirmed; },
    openPath: async (path) => void calls.push(`open ${path}`),
    openExternal: async (url) => void calls.push(`external ${url}`),
    openScreenSettings: async () => void calls.push("screen settings"),
    screenPermission: () => "granted",
    apply(next) {
      if (next.hotkey === conflict) throw new Error(`${next.hotkey} is already used by another app`);
      calls.push(`apply ${next.hotkey}`);
    },
    hotkeyError: () => "",
    shortcuts: () => ({ open: null, voice: null, sendDraft: null }),
    showWindow: async () => void calls.push("show window"),
    dismissWindow: async () => void calls.push("dismiss window"),
    windowVisible: () => visible,
    openView: (v) => void calls.push(`open view ${v}`),
    circleBegin: () => { calls.push("circle begin"); return "g1"; },
    circleEnd: async (g) => void calls.push(`circle end ${g}`),
    circleCancel: (g) => void calls.push(`circle cancel ${g}`),
    circleToggle: async () => void calls.push("circle toggle"),
    circlePosition: (a) => { calls.push(`position ${a}`); return displays; },
    circleNudge: (dx, dy) => { calls.push(`nudge ${dx} ${dy}`); return displays; },
    circleDisplay: (id) => { calls.push(`display ${id}`); return displays; },
    displays: () => displays,
    personalFiles: () => (personal.text ? ["/me/background.md"] : []),
    quit: () => void calls.push("quit"),
  };
  const voice: string[] = [];
  const dictation = {
    status: () => ({ supported: true, available: true, version: "0.1.0", bridge: true, message: "" }),
    configure: async (k: string) => void voice.push(`configure ${k}`),
    setup: async () => void voice.push("setup"),
    start: async (b: InputBinding, g: string | null) => void voice.push(`start ${b.inputToken} ${g}`),
    stop: async (id: string) => void voice.push(`stop ${id}`),
    cancel: async (id?: string) => void voice.push(`cancel ${id ?? ""}`.trim()),
  };
  const bubbles: (BubbleView | null)[] = [];
  const bubble = new Bubble({ publish: (v) => bubbles.push(v), after: () => () => {} });
  const look: string[] = [];
  const router = new Router({
    host: host as unknown as Host, captures, drafts: new Drafts(), settings,
    agent: new AgentSetup([], new Set()), native, dictation,
    observer: { setLook: (p) => look.push(JSON.stringify(p)), pause: (p) => look.push(`pause ${p}`) },
    bubble,
    personal: { current: () => personal, reload: () => { reloads.push("reload"); return personal; } },
    secrets: async () => stored,
    hostFailure: () => failure,
    restart: async () => void calls.push("restart"), keySaved: () => void calls.push("key saved"), changed: () => {}, platform: "linux", version: "0.0.1",
  });
  router.changed();
  return {
    dir, host, router, captures, grabs, settings, calls, voice, bubbles, look, reloads, stored,
    pick: (p: string | null) => { picked = p; },
    answer: (yes: boolean) => { confirmed = yes; },
    conflictOn: (k: string) => { conflict = k; },
    show: (v: boolean) => { visible = v; },
    fail: (message: string) => { failure = message; },
    personal: (c: Context) => { personal = c; },
    live: () => router.snapshot().binding! as RequestBinding,
    /** Whatever the host reports next; the router follows. */
    update(patch: Partial<HostView>) { host.view = { ...host.view!, ...patch }; router.changed(); },
  };
}

const ok = (reply: Reply | CircleReply) => {
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  return reply;
};
const refused = (reply: Reply | CircleReply, pattern: RegExp) => {
  assert.ok(!reply.ok, "expected a refusal");
  assert.match(reply.error, pattern);
};
const okWindow = (reply: Reply) => {
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  return reply as Extract<Reply, { ok: true }>;
};

test("the window's requests are strictly validated, and refusals change nothing", async () => {
  const d = desktop();
  const live = d.live();
  for (const bad of [
    null,
    "snapshot",
    { type: "eval", code: "process.exit()" },
    { type: "snapshot", extra: true },
    { type: "send", binding: { ...live, zoneEpoch: "bad epoch!" }, draftRevision: 0 },
    { type: "send", text: "hi", inputToken: "t1" },
    { type: "panel", panel: "tree" },
    { type: "show-surface", surface: "command" },
    { type: "circle-press", phase: "begin" },
    { type: "respond", binding: live, decision: { kind: "plan", value: true } },
    { type: "command", name: "self", argument: "", binding: live },
    { type: "open-record", record: "proposal" },
    { type: "open-record", record: "personal", path: "/etc/passwd" },
    { type: "agent-key", backend: "claude", key: "has space" },
    { type: "settings", settings: { ...d.settings.get(), shell: "/bin/sh" } },
    { type: "handoff-run", binding: live, handoffId: randomUUID(), revision: 1 },
    { type: "handoff-run", binding: live, handoffId: randomUUID(), revision: 1, draftRevision: 0, shares: [] },
    { type: "handoff-select", binding: live, decisionId: randomUUID(), revision: 1, optionId: randomUUID(), shares: [] },
    { type: "alignment-step", binding: { zoneId: zoneB }, action: "answer" },
    { type: "debug-send", binding: live, text: "hi" },
    { type: "debug-send", binding: debugBinding(), text: "x".repeat(9000) },
    { type: "circle-nudge", dx: 10, dy: 10 },
    { type: "circle-display", displayId: "../../etc" },
  ]) {
    assert.equal((await d.router.handle(bad, "window")).ok, false, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(d.calls, []);
  assert.deepEqual(d.host.calls, []);
  assert.deepEqual(d.host.got, []);
  assert.equal(d.host.runs.length, 0);
  assert.equal(existsSync(join(d.dir, "settings.json")), false, "nothing was saved");
});

test("roles: the bubble invokes nothing, the circle only its gestures, toggle and view", async () => {
  const d = desktop();
  for (const request of [{ type: "snapshot" }, { type: "quit" }, { type: "circle-toggle" }, { type: "circle-view" }]) {
    refused(await d.router.handle(request, "bubble"), /bubble can't/);
  }
  for (const request of [
    { type: "snapshot" }, { type: "quit" }, { type: "settings", settings: d.settings.get() }, { type: "send", binding: d.live(), draftRevision: 0 },
    { type: "handoff-run", binding: d.live(), handoffId: randomUUID(), revision: 1, draftRevision: 0 }, { type: "show-surface", surface: "window" },
    { type: "dismiss-surface", surface: "window" }, { type: "debug-open" }, { type: "circle-position", action: "begin" },
  ]) {
    refused(await d.router.handle(request, "circle"), /doesn't accept/);
  }
  assert.deepEqual(d.calls, [], "nothing a refused circle request names happened");

  const begin = ok(await d.router.handle({ type: "circle-press", phase: "begin" }, "circle")) as Extract<CircleReply, { ok: true }>;
  assert.deepEqual(begin.gesture, { gestureId: "g1" });
  assert.deepEqual(Object.keys(begin.view).sort(), ["open", "paused", "reason", "state"], "the circle sees only its face");
  ok(await d.router.handle({ type: "circle-press", phase: "end", gestureId: "g1" }, "circle"));
  ok(await d.router.handle({ type: "circle-press", phase: "cancel", gestureId: "g1" }, "circle"));
  ok(await d.router.handle({ type: "circle-toggle" }, "circle"));
  const view = ok(await d.router.handle({ type: "circle-view" }, "circle")) as Extract<CircleReply, { ok: true }>;
  assert.equal(view.gesture, undefined);
  assert.deepEqual(d.calls, ["circle begin", "circle end g1", "circle cancel g1", "circle toggle"]);
  assert.deepEqual(d.host.calls, [], "the circle reaches no host operation");
});

test("the window shows, dismisses and switches its own views; Move circle returns sanitized displays", async () => {
  const d = desktop();
  ok(await d.router.handle({ type: "show-surface", surface: "window" }, "window"));
  ok(await d.router.handle({ type: "view", view: "story" }, "window"));
  const moved = okWindow(await d.router.handle({ type: "circle-position", action: "begin" }, "window"));
  assert.deepEqual(moved.displays?.displays.map((x) => x.id), ["1"]);
  ok(await d.router.handle({ type: "circle-nudge", dx: -10, dy: 0 }, "window"));
  ok(await d.router.handle({ type: "circle-display", displayId: "1" }, "window"));
  ok(await d.router.handle({ type: "dismiss-surface", surface: "window" }, "window"));
  assert.deepEqual(d.calls, ["show window", "position begin", "nudge -10 0", "display 1", "dismiss window"]);
  assert.deepEqual(d.host.calls, ["view story"]);
  d.show(true);
  assert.equal(d.router.snapshot().window.visible, true);
});

test("a page request counts only from Dum's own UI file", () => {
  const index = "file:///Applications/Dum.app/Contents/Resources/app.asar/dist/desktop/ui/index.html";
  assert.equal(ownedPage(`${index}?view=window`, index), true);
  assert.equal(ownedPage(`${index}?view=circle#x`, index), true);
  assert.equal(ownedPage("file:///tmp/evil/index.html?view=window", index), false);
  assert.equal(ownedPage("https://example.com/index.html", index), false);
  assert.equal(ownedPage("not a url", index), false);
});

test("Send consumes the draft under the live binding; the next request gets a fresh ID", async () => {
  const d = desktop();
  const live = d.live();
  assert.equal(live.zoneEpoch, "e1");
  assert.equal(live.inputToken, "t1");
  ok(await d.router.handle({ type: "draft-set", text: "explain AVL", expectedDraftRevision: 0, binding: live }, "window"));
  refused(await d.router.handle({ type: "send", binding: { ...live, inputToken: "old" }, draftRevision: 1 }, "window"), /nothing was sent/);
  refused(await d.router.handle({ type: "send", binding: live, draftRevision: 0 }, "window"), /changed after you pressed Send/);
  ok(await d.router.handle({ type: "send", binding: live, draftRevision: 1 }, "window"));
  assert.deepEqual(d.host.sent.map((s) => [s.text, s.binding]), [["explain AVL", live]]);
  assert.equal(d.router.snapshot().draft.text, "");

  // While it runs, the binding names that request: nested answers belong to it.
  d.update({ state: state({ busy: true, prompt: null }), inputToken: "idle" });
  assert.equal(d.live().requestId, live.requestId);
  d.update({ state: state({ prompt: { type: "question", question: "Do you know rotations?", why: "", purpose: "attest" } }), inputToken: "q1" });
  const nested = d.live();
  assert.equal(nested.requestId, live.requestId);
  ok(await d.router.handle({ type: "respond", binding: nested, decision: { kind: "attest", value: true } }, "window"));
  d.update({ state: state(), inputToken: "t9" });
  assert.notEqual(d.live().requestId, live.requestId, "a finished request's ID is never reused");
});

test("a prompt that moves under a draft keeps the text but refuses the stale Send once", async () => {
  const d = desktop();
  const live = d.live();
  ok(await d.router.handle({ type: "draft-set", text: "my answer", expectedDraftRevision: 0, binding: live }, "window"));
  d.update({ inputToken: "t2" });
  const moved = d.live();
  const draft = d.router.snapshot().draft;
  assert.equal(draft.text, "my answer");
  refused(await d.router.handle({ type: "send", binding: moved, draftRevision: draft.revision }, "window"), /moved on/);
  assert.equal(d.host.sent.length, 0);
  ok(await d.router.handle({ type: "send", binding: moved, draftRevision: d.router.snapshot().draft.revision }, "window"));
  assert.equal(d.host.sent[0]!.binding.inputToken, "t2");
});

test("first run: the goal draft becomes the root zone, and nothing goes to a model", async () => {
  const d = desktop();
  d.update({ zoneEpoch: null, activeZone: null, state: null, inputToken: "idle", registry: { version: 1, revision: 0, activeZoneId: null, zones: [] } });
  const goal = d.router.snapshot().binding!;
  assert.equal(goal.zoneId, null);
  ok(await d.router.handle({ type: "draft-set", text: "  learn   balanced trees\nproperly  ", expectedDraftRevision: 0, binding: goal }, "window"));
  refused(await d.router.handle({ type: "share-choose", kind: "file", binding: goal }, "window"), /request it doesn't accept/);
  ok(await d.router.handle({ type: "send", binding: goal, draftRevision: 1 }, "window"));
  assert.deepEqual(d.host.calls, ["create learn balanced trees properly | learn   balanced trees\nproperly | true"]);
  assert.equal(d.host.sent.length, 0);
  assert.equal(d.router.snapshot().draft.text, "", "the goal draft is gone once it became a zone");
});

test("a typed path is shared only after it resolves to the right kind and they confirm it natively", async () => {
  const d = desktop();
  const root = temp();
  const file = join(root, "app.ts");
  writeFileSync(file, "x");
  mkdirSync(join(root, "src"));
  symlinkSync(file, join(root, "link.ts"));
  const share = (path: string, kind: "file" | "folder") => d.router.handle({ type: "share-path", path, kind, binding: d.live() }, "window");

  refused(await share("relative/app.ts", "file"), /full path/);
  refused(await share(join(root, "missing.ts"), "file"), /Nothing exists/);
  refused(await share(join(root, "src"), "file"), /isn't a file/);
  refused(await share(file, "folder"), /isn't a folder/);
  d.answer(false);
  ok(await share(file, "file"));
  assert.deepEqual(d.host.calls, [], "declining grants nothing");
  d.answer(true);
  ok(await share(join(root, "link.ts"), "file"));
  assert.deepEqual(d.host.calls, [`share file ${realpathSync(file)}`], "the confirmed, resolved path is what the host gets");
  assert.ok(d.calls.at(-1)!.includes(realpathSync(file)), "they confirmed the resolved path, not the typed one");
  assert.equal(d.router.snapshot().draft.shareIds.length, 1, "the share is part of this draft's request");

  refused(await d.router.handle({ type: "share-path", path: file, kind: "file", binding: { ...d.live(), requestId: "other" } }, "window"), /prompt that's over/);
});

test("shares go with the request they were made for; a new epoch voids them", async () => {
  const d = desktop();
  d.pick("/picked/notes.md");
  ok(await d.router.handle({ type: "share-choose", kind: "file", binding: d.live() }, "window"));
  const shareId = d.router.snapshot().draft.shareIds[0]!;
  ok(await d.router.handle({ type: "draft-set", text: "look", expectedDraftRevision: d.router.snapshot().draft.revision, binding: d.live() }, "window"));
  ok(await d.router.handle({ type: "send", binding: d.live(), draftRevision: d.router.snapshot().draft.revision }, "window"));
  assert.deepEqual(d.host.sent[0]!.shares.map((s) => s.id), [shareId]);
  assert.deepEqual(d.host.bindings[0], d.host.sent[0]!.binding, "shared and sent under one binding");

  d.pick("/picked/other.md");
  d.update({ state: state(), inputToken: "t5" });
  ok(await d.router.handle({ type: "share-choose", kind: "file", binding: d.live() }, "window"));
  d.update({ zoneEpoch: "e2" });
  assert.deepEqual(d.router.snapshot().draft.shareIds, [], "a reopened zone drops the draft's shares");
});

test("captures need the live binding and an attach-capable prompt, and die with the epoch", async () => {
  const d = desktop();
  ok(await d.router.handle({ type: "capture-sources" }, "window"));
  refused(await d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: { ...d.live(), inputToken: "old" } }, "window"), /prompt that's over/);
  d.update({ canAttach: false });
  refused(await d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "window"), /next request/);
  d.update({ canAttach: true });
  const pending = d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "window");
  await settle();
  d.grabs[0]!.finish(Buffer.from(PNG));
  ok(await pending);
  assert.ok(d.router.snapshot().draft.captureToken);
  ok(await d.router.handle({ type: "draft-set", text: "what's wrong here?", expectedDraftRevision: d.router.snapshot().draft.revision, binding: d.live() }, "window"));
  ok(await d.router.handle({ type: "send", binding: d.live(), draftRevision: d.router.snapshot().draft.revision }, "window"));
  assert.equal(d.host.sent[0]!.image?.label, "Editor - app.ts");
  assert.equal(d.captures.holding, false);

  d.update({ state: state(), inputToken: "t3" });
  const again = d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "window");
  await settle();
  d.grabs[1]!.finish(Buffer.from(PNG));
  ok(await again);
  d.update({ zoneEpoch: "e2" });
  assert.equal(d.captures.holding, false, "a zone reopen drops the held capture");
  assert.equal(d.router.snapshot().draft.captureToken, undefined);
});

// -- Do this ------------------------------------------------------------------------------------

test("Do this consumes the canonical draft once: its shares and picture go along, a replay is refused", async () => {
  const d = desktop();
  const handoffId = randomUUID();
  d.pick("/picked/target.ts");
  ok(await d.router.handle({ type: "share-choose", kind: "file", binding: d.live() }, "window"));
  const shareId = d.router.snapshot().draft.shareIds[0]!;
  ok(await d.router.handle({ type: "capture-sources" }, "window"));
  const shot = d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "window");
  await settle();
  d.grabs[0]!.finish(Buffer.from(PNG));
  ok(await shot);
  const live = d.live();
  const revision = d.router.snapshot().draft.revision;

  refused(await d.router.handle({ type: "handoff-run", binding: live, handoffId, revision: 2, draftRevision: revision - 1 }, "window"), /draft changed/);
  refused(await d.router.handle({ type: "handoff-run", binding: { ...live, inputToken: "old" }, handoffId, revision: 2, draftRevision: revision }, "window"), /prompt that's over/);
  assert.equal(d.host.runs.length, 0);

  ok(await d.router.handle({ type: "handoff-run", binding: live, handoffId, revision: 2, draftRevision: revision }, "window"));
  assert.equal(d.host.runs.length, 1);
  const run = d.host.runs[0]!;
  assert.deepEqual(run.binding, live);
  assert.equal(run.handoffId, handoffId);
  assert.equal(run.revision, 2);
  assert.deepEqual(run.shares.map((s) => s.id), [shareId], "main supplies the draft's current shares");
  assert.equal(run.image?.label, "Editor - app.ts", "and its held picture, handed over once");
  assert.equal(d.captures.holding, false);
  assert.deepEqual(d.router.snapshot().draft.shareIds, []);
  assert.equal(d.host.sent.length, 0, "Do this is not a Send of draft text");

  refused(await d.router.handle({ type: "handoff-run", binding: live, handoffId, revision: 2, draftRevision: revision }, "window"), /draft changed/);
  assert.equal(d.host.runs.length, 1, "the consumed command never runs twice");

  // The command's binding is the running request until the host asks what's next again.
  d.update({ state: state({ busy: true, prompt: null }), inputToken: "idle" });
  assert.equal(d.live().requestId, live.requestId);
  d.update({ state: state(), inputToken: "t2" });
  assert.notEqual(d.live().requestId, live.requestId);
});

test("Do this refuses an unrelated draft and a racing second press", async () => {
  const d = desktop();
  const handoffId = randomUUID();
  ok(await d.router.handle({ type: "draft-set", text: "something else", expectedDraftRevision: 0, binding: d.live() }, "window"));
  refused(await d.router.handle({ type: "handoff-run", binding: d.live(), handoffId, revision: 1, draftRevision: 1 }, "window"), /isn't part of this handoff/);
  assert.equal(d.router.snapshot().draft.text, "something else", "their draft is kept");
  ok(await d.router.handle({ type: "draft-set", text: "", expectedDraftRevision: 1, binding: d.live() }, "window"));

  d.host.hold = Promise.withResolvers<void>();
  const first = d.router.handle({ type: "handoff-run", binding: d.live(), handoffId, revision: 1, draftRevision: 2 }, "window");
  await settle();
  refused(await d.router.handle({ type: "handoff-run", binding: d.live(), handoffId, revision: 1, draftRevision: 2 }, "window"), /still taking/);
  refused(await d.router.handle({ type: "send", binding: d.live(), draftRevision: 2 }, "window"), /still taking|Type something/);
  d.host.hold.resolve();
  ok(await first);
  assert.equal(d.host.runs.length, 1);
});

// -- alignment, decisions, handoffs ----------------------------------------------------------------

test("alignment of another zone carries only its own binding and returns that zone's direction", async () => {
  const d = desktop();
  const binding = {
    zoneId: zoneB, zoneRevision: 3, goalHash: "a".repeat(64), attemptId: randomUUID(), directionRevision: 0, contextRevision: "b".repeat(64),
  };
  const read = okWindow(await d.router.handle({ type: "alignment-read", zoneId: zoneB }, "window"));
  assert.equal(read.direction, DIRECTION);
  const step = okWindow(await d.router.handle({ type: "alignment-step", binding, action: "start" }, "window"));
  assert.equal(step.direction, DIRECTION);
  const questionId = randomUUID();
  ok(await d.router.handle({ type: "alignment-step", binding, action: "answer", questionId, text: "C++" }, "window"));
  ok(await d.router.handle({
    type: "alignment-accept", binding, choiceId: randomUUID(), ability: "write searches", reviewCriterion: "tests pass", assumptions: [],
  }, "window"));
  assert.deepEqual(d.host.got.map((g) => g.op), ["alignment-read", "alignment-step", "alignment-step", "alignment-accept"]);
  assert.deepEqual(d.host.got[1]!.input, { binding, action: "start" }, "exactly the alignment input: no type, no input binding, no shares");
  assert.deepEqual(d.host.got[2]!.input, { binding, action: "answer", questionId, text: "C++" });
  assert.equal(d.router.snapshot().binding!.zoneId, zoneA, "the active zone is untouched");
  assert.equal(d.host.sent.length + d.host.runs.length, 0);

  const updated = okWindow(await d.router.handle({ type: "zone-update", id: zoneB, patch: { goal: "learn AVL deletes" }, expectedRevision: 3 }, "window"));
  assert.equal(updated.direction, DIRECTION, "a goal edit returns the target zone's alignment even when it isn't open");
  const created = okWindow(await d.router.handle({ type: "zone-create", zone: { name: "Heaps", goal: "learn heaps", parentId: zoneA, language: null, focusSkills: [] }, enter: false }, "window"));
  assert.equal(created.direction, DIRECTION);
});

test("decision help needs the live binding and retires its request ID; card actions need the open zone", async () => {
  const d = desktop();
  const live = d.live();
  refused(await d.router.handle({ type: "decision-help", binding: { ...live, requestId: "old" }, outcome: "sort my list" }, "window"), /prompt that's over/);
  const help = okWindow(await d.router.handle({ type: "decision-help", binding: live, outcome: "sort my list" }, "window"));
  assert.equal(help.decision, DECISION);
  assert.notEqual(d.live().requestId, live.requestId, "a decision turn's ID is never reused");

  const stale = { ...d.live(), zoneEpoch: "e0" };
  const handoffId = randomUUID();
  for (const request of [
    { type: "decision-dismiss", binding: stale, decisionId: DECISION.id, revision: 1 },
    { type: "handoff-select", binding: stale, decisionId: DECISION.id, revision: 1, optionId: randomUUID() },
    { type: "handoff-edit", binding: stale, handoffId, revision: 1, patch: { task: "x" } },
    { type: "handoff-dismiss", binding: stale, handoffId, revision: 1 },
    { type: "handoff-review", binding: stale, handoffId, revision: 3, verdict: "did not advance the goal" },
  ]) {
    refused(await d.router.handle(request, "window"), /isn't open any more/);
  }
  assert.deepEqual(d.host.got.map((g) => g.op), ["decision-help"]);

  const now = d.live();
  const optionId = randomUUID();
  const selected = okWindow(await d.router.handle({ type: "handoff-select", binding: now, decisionId: DECISION.id, revision: 1, optionId }, "window"));
  assert.equal(selected.handoff, HANDOFF);
  assert.deepEqual(d.host.got.at(-1), { op: "handoff-select", input: { binding: now, decisionId: DECISION.id, revision: 1, optionId } });
  ok(await d.router.handle({ type: "handoff-edit", binding: now, handoffId, revision: 1, patch: { review: "the diff" } }, "window"));
  ok(await d.router.handle({ type: "handoff-review", binding: now, handoffId, revision: 3, verdict: "did what I needed" }, "window"));
  ok(await d.router.handle({ type: "decision-dismiss", binding: now, decisionId: DECISION.id, revision: 1 }, "window"));
  const read = okWindow(await d.router.handle({ type: "handoff-read", zoneId: zoneB, handoffId }, "window"));
  assert.equal(read.handoff, HANDOFF, "a historical read needs no binding and grants nothing");
  assert.equal(d.host.runs.length + d.host.sent.length, 0, "selection, edit and review write nothing");
});

test("context: reload hands the host main's fresh personal copy; corrections and sessions need the open zone", async () => {
  const d = desktop();
  const live = d.live();
  ok(await d.router.handle({ type: "context-reload", binding: live }, "window"));
  assert.deepEqual(d.host.got.at(-1)!.input, { binding: live, personal: { path: "", text: "", warning: "" } }, "opt-in off: nothing personal");
  assert.deepEqual(d.reloads, []);

  d.settings.set({ ...d.settings.get(), personalContext: true });
  d.personal({ path: "/me/background.md", text: "I like C++", warning: "" });
  ok(await d.router.handle({ type: "context-reload", binding: live }, "window"));
  assert.deepEqual(d.reloads, ["reload"], "main re-read its named files first");
  assert.deepEqual(d.host.got.at(-1)!.input, { binding: live, personal: { path: "/me/background.md", text: "I like C++", warning: "" } });

  const sourceId = randomUUID();
  refused(await d.router.handle({ type: "context-ignore-observation", binding: { ...live, zoneEpoch: "e0" }, sourceId, expectedCorrectionRevision: 0 }, "window"), /isn't open/);
  ok(await d.router.handle({ type: "context-ignore-observation", binding: live, sourceId, expectedCorrectionRevision: 0 }, "window"));
  assert.deepEqual(d.host.got.at(-1)!.input, { binding: live, sourceId, expectedCorrectionRevision: 0 });
  const use = okWindow(await d.router.handle({ type: "context-use-read", binding: live, cursor: null }, "window"));
  assert.deepEqual(use.contextUse, { items: [], next: null });

  refused(await d.router.handle({ type: "session-new", binding: { ...live, zoneEpoch: "e0" } }, "window"), /isn't open/);
  ok(await d.router.handle({ type: "session-new", binding: live }, "window"));
  const sessionId = randomUUID();
  ok(await d.router.handle({ type: "trail-read", zoneId: zoneB, sessionId, cursor: null }, "window"));
  ok(await d.router.handle({ type: "story-read", zoneId: null, skill: null, from: null, to: null, cursor: null }, "window"));
  assert.deepEqual(d.host.got.slice(-3).map((g) => g.input), [live, { zoneId: zoneB, sessionId, cursor: null }, { zoneId: null, skill: null, from: null, to: null, cursor: null }]);
  ok(await d.router.handle({ type: "trail-map", binding: live, sessionId, gapId: randomUUID(), skill: { name: "binary search", lang: "" } }, "window"));
});

test("a personal record opens only when the host's file is one of main's named files now", async () => {
  const d = desktop();
  const sourceId = randomUUID();
  refused(await d.router.handle({ type: "open-record", record: "personal", sourceId }, "window"), /isn't one of your current personal-context files/);
  d.personal({ path: "/me/background.md", text: "notes", warning: "" });
  ok(await d.router.handle({ type: "open-record", record: "personal", sourceId }, "window"));
  d.host.personalPath = "/etc/passwd";
  refused(await d.router.handle({ type: "open-record", record: "personal", sourceId }, "window"), /nothing was opened/);
  assert.deepEqual(d.calls, ["open /me/background.md"]);
  ok(await d.router.handle({ type: "open-record", record: "memory" }, "window"));
  assert.ok(d.calls.includes("open /app/record.md"), "main opens only the path the host validated");
});

// -- debug chat ---------------------------------------------------------------------------------

test("debug chat works with no zone, carries its own binding only, and never forwards or shows a secret", async () => {
  const d = desktop();
  d.update({ zoneEpoch: null, activeZone: null, state: null, registry: { version: 1, revision: 0, activeZoneId: null, zones: [] } });
  d.stored.push(KEY);
  const opened = okWindow(await d.router.handle({ type: "debug-open" }, "window"));
  assert.ok(opened.debug);
  const binding = debugBinding();
  const text = `which look model runs? my key is ${KEY} and also sk-ant-api03-PASTEDPASTEDPASTED, token ghp_abcdefghijklmnopqrstuvwxyz0123`;
  ok(await d.router.handle({ type: "debug-send", binding, text }, "window"));
  const forwarded = d.host.got.find((g) => g.op === "debug-send")!.input as { binding: DebugBinding; text: string };
  assert.deepEqual(forwarded.binding, binding);
  assert.ok(!forwarded.text.includes(KEY) && !forwarded.text.includes("PASTED") && !forwarded.text.includes("ghp_"), forwarded.text);
  assert.match(forwarded.text, /^which look model runs\?/);

  d.host.debug = debugView(["what is my key?", `It is ${KEY}`]);
  const shown = d.router.snapshot().debug!;
  assert.ok(shown.entries.every((e) => !e.text.includes(KEY)), "a reply naming the stored key is redacted before display");
  ok(await d.router.handle({ type: "debug-stop", binding }, "window"));
  ok(await d.router.handle({ type: "debug-reset" }, "window"));
  assert.deepEqual(d.host.got.map((g) => g.op), ["debug-open", "debug-send", "debug-stop", "debug-reset"]);
  assert.equal(d.host.sent.length, 0, "debug never touches the zone chat");
});

// -- voice ----------------------------------------------------------------------------------------

test("push-to-talk fills an empty draft for the live binding; stale or late voice is discarded", async () => {
  const d = desktop();
  const live = d.live();
  d.router.voiceEvent({ op: "pressed", gestureId: "g1" });
  await settle();
  assert.deepEqual(d.voice, [`start t1 g1`], "the press starts a recording for the live binding");
  d.router.voiceEvent({ op: "recording", recordingId: "rec1", binding: live });
  assert.equal(d.router.snapshot().voice.phase, "recording");
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["Listening…"]);
  d.router.voiceEvent({ op: "transcribing", recordingId: "rec1", binding: live });
  d.router.voiceEvent({ op: "transcript", recordingId: "rec1", binding: live, text: "how do rotations work" });
  const snap = d.router.snapshot();
  assert.equal(snap.draft.text, "how do rotations work");
  assert.equal(snap.draft.source, "voice");
  assert.equal(snap.voice.phase, "ready");
  assert.equal(d.host.sent.length, 0, "voice never sends");
  assert.ok(d.bubbles.at(-1)?.lines.some((l) => l.includes("open Dum")), "the bubble points at Dum, not a command bar");

  // A full draft refuses a new press and a mouse start.
  d.router.voiceEvent({ op: "pressed", gestureId: "g2" });
  await settle();
  assert.equal(d.voice.length, 1);
  refused(await d.router.handle({ type: "voice-start", binding: d.live() }, "window"), /isn't empty/);

  // Late text for an old epoch is dropped with a visible status, never written anywhere.
  const fresh = desktop();
  const old = fresh.live();
  fresh.update({ zoneEpoch: "e2" });
  assert.ok(fresh.voice.includes("cancel"), "a new epoch cancels the recording");
  fresh.router.voiceEvent({ op: "transcript", recordingId: "rec9", binding: old, text: "too late" } satisfies VoiceEvent);
  assert.equal(fresh.router.snapshot().draft.text, "");
  assert.equal(fresh.router.snapshot().voice.phase, "error");
  refused(await fresh.router.handle({ type: "voice-start", binding: old }, "window"), /changed/);
  refused(await fresh.router.handle({ type: "voice-stop", recordingId: "rec9" }, "window"), /no longer active/);
});

test("a voice request's reply shows in the bubble; a decision stays in the window", async () => {
  const d = desktop();
  const live = d.live();
  d.router.voiceEvent({ op: "transcript", recordingId: "r", binding: live, text: "explain" });
  ok(await d.router.handle({ type: "send", binding: live, draftRevision: d.router.snapshot().draft.revision }, "window"));
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["Dum is working…"]);
  d.update({ state: state({ busy: true, prompt: null, transcript: [{ kind: "say", id: 1, text: "A rotation keeps order." }] }), inputToken: "idle" });
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["A rotation keeps order."]);
  d.update({ state: state({ transcript: [{ kind: "say", id: 1, text: "A rotation keeps order." }] }), inputToken: "t7" });
  assert.equal(d.bubbles.at(-1)?.kind, "reply");
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["A rotation keeps order."]);

  const v = desktop();
  const vl = v.live();
  v.router.voiceEvent({ op: "transcript", recordingId: "r", binding: vl, text: "change it" });
  ok(await v.router.handle({ type: "send", binding: vl, draftRevision: v.router.snapshot().draft.revision }, "window"));
  v.update({ state: state({ prompt: { type: "question", question: "Share src?", why: "", purpose: "share" } }), inputToken: "q1" });
  assert.equal(v.bubbles.at(-1)?.lines.at(-1), "Decision waiting - answer it in Dum");
  assert.ok(!v.bubbles.at(-1)!.lines.some((l) => l.includes("Share src?")), "the decision itself is never in the bubble");
});

// -- settings, records, look, diagnostics -----------------------------------------------------------

test("settings: distinct shortcuts, applied before saved, rolled back on conflict; the agent isn't set here", async () => {
  const d = desktop();
  const prefs = d.settings.get();
  refused(await d.router.handle({ type: "settings", settings: { ...prefs, sendDraftHotkey: prefs.hotkey } }, "window"), /must all be different/);
  d.conflictOn("Alt+K");
  refused(await d.router.handle({ type: "settings", settings: { ...prefs, hotkey: "Alt+K" } }, "window"), /already used/);
  assert.equal(existsSync(join(d.dir, "settings.json")), false, "a refused shortcut saves nothing");
  assert.deepEqual(d.host.diagnostics.at(-1)?.events.map((e) => `${e.kind} ${e.outcome} ${e.reason}`), ["settings failed shortcut-conflict"]);
  const agent = {
    backend: "local", login: "none",
    intern: { backend: "local", model: "m", effort: null }, helper: { backend: "local", model: "m", effort: null }, look: { backend: "local", model: "m", effort: null },
  } as const;
  refused(await d.router.handle({ type: "settings", settings: { ...prefs, agent } }, "window"), /Who powers Dum|Agent/);

  ok(await d.router.handle({ type: "settings", settings: { ...prefs, hotkey: "Alt+J", voiceHotkey: "Control+Alt+V", look: { apps: true, screen: false } } }, "window"));
  assert.equal(DesktopSettings.load(d.dir).get().hotkey, "Alt+J");
  assert.deepEqual(d.voice, ["configure Control+Alt+V"]);
  assert.deepEqual(d.look, [JSON.stringify({ apps: true, screen: false })]);
  assert.deepEqual(d.host.calls, ["settings Alt+J"], "the host gets main's saved copy");
  assert.deepEqual(d.host.diagnostics.at(-1)?.events.map((e) => `${e.kind} ${e.outcome} ${e.reason}`), ["settings ok settings-change"]);

  ok(await d.router.handle({ type: "settings", settings: { ...d.settings.get(), personalContext: true } }, "window"));
  assert.ok(d.calls.includes("restart"), "personal context goes to a freshly started host");
});

test("zone delete and skill add need a native confirmation; deleting drops those zones' drafts", async () => {
  const d = desktop();
  d.answer(false);
  ok(await d.router.handle({ type: "zone-delete", id: zoneA, expectedRevision: 3 }, "window"));
  assert.ok(d.calls.at(-1)!.includes("1 zone inside it"));
  ok(await d.router.handle({ type: "skill-edit", op: "add", skill: { name: "recursion", lang: "" } }, "window"));
  assert.deepEqual(d.host.calls, [], "declined: nothing reaches the host");
  d.answer(true);
  ok(await d.router.handle({ type: "draft-set", text: "keep?", expectedDraftRevision: 0, binding: d.live() }, "window"));
  ok(await d.router.handle({ type: "zone-delete", id: zoneA, expectedRevision: 3 }, "window"));
  ok(await d.router.handle({ type: "skill-edit", op: "add", skill: { name: "recursion", lang: "" } }, "window"));
  assert.deepEqual(d.host.calls, ["delete A", "skill add"]);
  assert.equal(d.router.snapshot().draft.text, "");
  refused(await d.router.handle({ type: "zone-delete", id: randomUUID(), expectedRevision: 3 }, "window"), /doesn't exist/);
});

test("the snapshot merges the host's look with main's pause and permission, and the personal row", async () => {
  const d = desktop();
  ok(await d.router.handle({ type: "look-pause", paused: true }, "window"));
  const snap = d.router.snapshot();
  assert.deepEqual(snap.look, { ...LOOK, paused: true, permission: "granted" });
  assert.deepEqual(d.look, ["pause true"]);
  assert.equal(d.host.diagnostics.at(-1)?.status?.lookPaused, true, "the host hears main's changed status");
  assert.deepEqual(snap.contextUse, NO_USE);
  assert.deepEqual(snap.personal, { status: "off", files: [], warning: "" });

  d.settings.set({ ...d.settings.get(), personalContext: true });
  assert.equal(d.router.snapshot().personal.status, "missing");
  d.personal({ path: "/me/x.md", text: "", warning: "couldn't read personal context: EACCES" });
  assert.deepEqual(d.router.snapshot().personal, { status: "unreadable", files: [], warning: "couldn't read personal context: EACCES" });
  d.personal({ path: "/me/background.md", text: "notes", warning: "" });
  assert.deepEqual(d.router.snapshot().personal, { status: "loaded", files: ["/me/background.md"], warning: "" });

  d.host.view = null;
  d.host.running = false;
  d.router.changed();
  d.fail("Dum's teaching host stopped");
  assert.equal(d.router.snapshot().look.status, "failed");
  ok(await d.router.handle({ type: "zone-enter", id: zoneB, expectedRevision: 3 }, "window"));
  refused(await d.router.handle({ type: "interrupt", binding: bind() }, "window"), /isn't open/);
});

test("main's diagnostics: status only when it changed, events as they happen, nothing without a host", async () => {
  const d = desktop();
  const first = d.host.diagnostics.length;
  assert.ok(first >= 1, "the host heard main's status once it was running");
  assert.equal(d.host.diagnostics[0]!.status?.version, "0.0.1");
  d.router.changed();
  d.router.changed();
  assert.equal(d.host.diagnostics.length, first, "an unchanged status isn't repeated");
  d.router.diagnose([{ kind: "native", role: null, requestId: null, checkId: null, outcome: "ok", reason: "display-change", latencyMs: null, httpStatus: null }]);
  assert.equal(d.host.diagnostics.at(-1)!.status, null);
  assert.equal(d.host.diagnostics.at(-1)!.events[0]!.reason, "display-change");

  ok(await d.router.handle({ type: "agent-check" }, "window"));
  assert.equal(d.host.diagnostics.at(-1)!.events[0]!.reason, "backend-check");

  d.host.running = false;
  const count = d.host.diagnostics.length;
  d.router.diagnose([{ kind: "native", role: null, requestId: null, checkId: null, outcome: "ok", reason: "sleep", latencyMs: null, httpStatus: null }]);
  assert.equal(d.host.diagnostics.length, count);
  assert.deepEqual(Object.keys(d.router.mainStatus()).sort(), ["backends", "lookPaused", "platform", "screenPermission", "shortcuts", "version", "voice"]);
});

// -- the circle's face ----------------------------------------------------------------------------

test("the circle's face follows typed fields in priority order", () => {
  const d = desktop();
  const base = d.router.snapshot();
  const chosen = {
    backend: "local", login: "none",
    intern: { backend: "local", model: "m", effort: null }, helper: { backend: "local", model: "m", effort: null }, look: { backend: "local", model: "m", effort: null },
  } as const;
  const ready: Snapshot = {
    ...base, settings: { ...base.settings, agent: chosen },
    agent: { chosen, backends: [{ id: "local", label: "On this Mac", installed: true, methods: ["none"], ready: "none", loginRunning: false, message: "" }] },
  };
  const face = (s: Snapshot, failure = "", rejected = false) => {
    const v = circleView(s, failure, rejected);
    return `${v.state}/${v.reason}`;
  };
  assert.equal(face(base), "attention/setup", "no backend chosen needs setup");
  assert.equal(face(ready), "idle/none");
  assert.equal(face({ ...ready, look: { ...ready.look, paused: true } }), "idle/look-paused");
  assert.equal(face({ ...ready, look: { ...ready.look, status: "checking" } }), "looking/looking");
  assert.equal(face({ ...ready, debug: { ...debugView([]), state: "busy" } }), "thinking/debug");
  assert.equal(face({ ...ready, state: state({ busy: true }), look: { ...ready.look, status: "checking" } }), "thinking/zone");
  assert.equal(face({ ...ready, state: state({ busy: true }) }, "host stopped"), "attention/host-failed");
  assert.equal(face(ready, "", true), "attention/key-rejected");
  assert.equal(face({ ...ready, voice: { phase: "error", recordingId: null, status: "x" } }), "attention/voice-error");
  assert.equal(face({ ...ready, look: { ...ready.look, reason: "unverified-model" } }), "attention/look-route");
  assert.equal(face({ ...ready, state: state({ prompt: { type: "question", question: "q", why: "", purpose: "attest" } }) }), "attention/decision");
  assert.equal(face({ ...ready, voice: { phase: "transcribing", recordingId: "r", status: "" } }, "host stopped"), "listening/transcribing");
  assert.equal(face({ ...ready, voice: { phase: "recording", recordingId: "r", status: "" } }), "listening/recording");
  assert.equal(circleView({ ...ready, window: { visible: true } }, "").open, true);
});

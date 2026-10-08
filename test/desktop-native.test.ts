// Main's router, captures and the native seams, without Electron: Router role checks, strict
// requests, typed-path consent, stale draft/voice/capture rejection and the read-only bubble.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSetup } from "../src/desktop/agent-setup.ts";
import { Captures, type Capturer } from "../src/desktop/capture.ts";
import { Drafts } from "../src/desktop/draft.ts";
import { Router, ownedPage, type Host, type Native } from "../src/desktop/ipc.ts";
import { DesktopSettings } from "../src/desktop/settings.ts";
import { Bubble } from "../src/desktop/surfaces.ts";
import type { HostView } from "../src/desktop/host-client.ts";
import type { BubbleView, CaptureSource, DesktopPreferences, Reply } from "../src/desktop/protocol.ts";
import type { VoiceEvent } from "../src/desktop/native-protocol.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../src/share-types.ts";
import type { SharedImage, State } from "../src/store-types.ts";
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

function zone(id: string, parentId: string | null, name: string): Zone {
  const at = "2026-10-08T00:00:00.000Z";
  return { id, parentId, name, goal: `learn ${name}`, language: null, focusSkills: [], createdAt: at, updatedAt: at, deletedAt: null };
}

function context(id: string, name: string): ZoneContext {
  return { id, revision: 1, breadcrumb: [{ id, name }], goal: `learn ${name}`, ancestorGoals: [], language: "", focusSkills: [], notes: [] };
}

function state(patch: Partial<State> = {}): State {
  return {
    zoneId: zoneA, zoneName: "Trees", mode: "understand", transcript: [], prompt: { type: "next" }, busy: false, status: "",
    stage: { kind: "conversation" }, unlocked: 0, models: { intern: null, helper: null }, ...patch,
  };
}

function viewIn(patch: Partial<HostView> = {}): HostView {
  return {
    zoneEpoch: "e1", state: state(), tree: null,
    registry: { version: 1, revision: 3, activeZoneId: zoneA, zones: [zone(zoneA, null, "Trees"), zone(zoneB, zoneA, "AVL")] },
    activeZone: context(zoneA, "Trees"), inputToken: "t1", canAttach: true, shares: [], follows: [], changes: [],
    look: { status: "looking" }, ...patch,
  };
}

class FakeHost {
  view: HostView | null = viewIn();
  running = true;
  calls: string[] = [];
  sent: { binding: RequestBinding; text: string; shares: ShareGrant[]; image?: SharedImage }[] = [];
  bindings: unknown[] = [];
  async createZone(z: { name: string; goal: string }, enter: boolean) { this.calls.push(`create ${z.name} | ${z.goal} | ${enter}`); return zone(randomUUID(), null, z.name); }
  async openZone(id: string, rev: number) { this.calls.push(`enter ${id === zoneB ? "B" : id} ${rev}`); }
  async updateZone() { return zone(zoneA, null, "Trees"); }
  async zoneContext() { return context(zoneA, "Trees"); }
  async deleteZone(id: string) { this.calls.push(`delete ${id === zoneA ? "A" : "B"}`); return { activeZoneId: null, deletedIds: [zoneA, zoneB] }; }
  async settings(p: DesktopPreferences) { this.calls.push(`settings ${p.hotkey}`); }
  async agentSelect() {}
  async agentModels() { return []; }
  async send(binding: RequestBinding, text: string, shares: ShareGrant[], image?: SharedImage) { this.sent.push({ binding, text, shares, ...(image ? { image } : {}) }); }
  async respond(binding: RequestBinding) { this.bindings.push(binding); this.calls.push("respond"); }
  async command(name: string) { this.calls.push(`command ${name}`); }
  async panel(panel: string) { this.calls.push(`panel ${panel}`); }
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
  async interrupt() { this.calls.push("interrupt"); }
}

function desktop(o: { flavor?: "public" | "local" } = {}) {
  const dir = temp();
  const host = new FakeHost();
  const { c, grabs } = capturer();
  const captures = new Captures(c);
  const settings = DesktopSettings.load(dir, o.flavor ?? "local");
  const calls: string[] = [];
  let conflict = "";
  let picked: string | null = null;
  let confirmed = true;
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
    showSurface: async (s) => void calls.push(`show ${s}`),
    openPane: (p) => void calls.push(`pane ${p}`),
    dismissSurface: async (s) => void calls.push(`dismiss ${s}`),
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
    agent: new AgentSetup([], settings.flavor, new Set()), native, dictation,
    observer: { setLook: (p) => look.push(JSON.stringify(p)), pause: (p) => look.push(`pause ${p}`), status: "looking" },
    bubble, restart: async () => void calls.push("restart"), changed: () => {}, platform: "linux", version: "0.0.1",
  });
  router.changed();
  return {
    dir, host, router, captures, grabs, settings, calls, voice, bubbles, look,
    pick: (p: string | null) => { picked = p; },
    answer: (yes: boolean) => { confirmed = yes; },
    conflictOn: (k: string) => { conflict = k; },
    live: () => router.snapshot().binding!,
    /** Whatever the host reports next; the router follows. */
    update(patch: Partial<HostView>) { host.view = { ...host.view!, ...patch }; router.changed(); },
  };
}

const ok = (reply: Reply) => {
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  return reply;
};
const refused = (reply: Reply, pattern: RegExp) => {
  assert.ok(!reply.ok, "expected a refusal");
  assert.match(reply.error, pattern);
};

test("the renderer's requests are strictly validated, and refusals change nothing", async () => {
  const d = desktop();
  for (const bad of [
    null,
    "snapshot",
    { type: "eval", code: "process.exit()" },
    { type: "snapshot", extra: true },
    { type: "send", binding: { ...d.live(), zoneEpoch: "bad epoch!" }, draftRevision: 0 },
    { type: "send", text: "hi", inputToken: "t1" },
    { type: "choose-project" },
    { type: "open-project", root: "/tmp" },
    { type: "runtime-login" },
    { type: "respond", binding: d.live(), decision: { kind: "plan", value: true } },
    { type: "command", name: "self", argument: "", binding: d.live() },
    { type: "move-companion", dx: 1, dy: 0 },
    { type: "open-record", record: "proposal" },
    { type: "agent-key", backend: "claude", key: "has space" },
    { type: "settings", settings: { ...d.settings.get(), shell: "/bin/sh" } },
  ]) {
    assert.equal((await d.router.handle(bad, "panel")).ok, false, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(d.calls, []);
  assert.deepEqual(d.host.calls, []);
  assert.equal(existsSync(join(d.dir, "settings.json")), false, "nothing was saved");
});

test("the bubble is read-only and a window can only dismiss itself", async () => {
  const d = desktop();
  refused(await d.router.handle({ type: "snapshot" }, "bubble"), /bubble can't/);
  refused(await d.router.handle({ type: "quit" }, "bubble"), /bubble can't/);
  refused(await d.router.handle({ type: "dismiss-surface", surface: "panel" }, "command"), /only dismiss itself/);
  ok(await d.router.handle({ type: "dismiss-surface", surface: "command" }, "command"));
  ok(await d.router.handle({ type: "panel", panel: "tree" }, "command"));
  ok(await d.router.handle({ type: "panel", panel: "history" }, "panel"));
  assert.deepEqual(d.calls, ["dismiss command", "pane tree"], "only the command bar's panel request moves the panel window");
  assert.deepEqual(d.host.calls, ["panel tree", "panel history"]);
});

test("a page request counts only from Dum's own UI file", () => {
  const index = "file:///Applications/Dum.app/Contents/Resources/app.asar/dist/desktop/ui/index.html";
  assert.equal(ownedPage(`${index}?view=command`, index), true);
  assert.equal(ownedPage(`${index}?view=panel#tree`, index), true);
  assert.equal(ownedPage("file:///tmp/evil/index.html?view=panel", index), false);
  assert.equal(ownedPage("https://example.com/index.html", index), false);
  assert.equal(ownedPage("not a url", index), false);
});

test("Send consumes the draft under the live binding; the next request gets a fresh ID", async () => {
  const d = desktop();
  const live = d.live();
  assert.equal(live.zoneEpoch, "e1");
  assert.equal(live.inputToken, "t1");
  ok(await d.router.handle({ type: "draft-set", text: "explain AVL", expectedDraftRevision: 0, binding: live }, "command"));
  refused(await d.router.handle({ type: "send", binding: { ...live, inputToken: "old" }, draftRevision: 1 }, "command"), /nothing was sent/);
  refused(await d.router.handle({ type: "send", binding: live, draftRevision: 0 }, "command"), /changed after you pressed Send/);
  ok(await d.router.handle({ type: "send", binding: live, draftRevision: 1 }, "command"));
  assert.deepEqual(d.host.sent.map((s) => [s.text, s.binding]), [["explain AVL", live]]);
  assert.equal(d.router.snapshot().draft.text, "");

  // While it runs, the binding names that request: nested answers belong to it.
  d.update({ state: state({ busy: true, prompt: null }), inputToken: "idle" });
  assert.equal(d.live().requestId, live.requestId);
  d.update({ state: state({ prompt: { type: "question", question: "Do you know rotations?", why: "", purpose: "attest" } }), inputToken: "q1" });
  const nested = d.live();
  assert.equal(nested.requestId, live.requestId);
  ok(await d.router.handle({ type: "respond", binding: nested, decision: { kind: "attest", value: true } }, "command"));
  d.update({ state: state(), inputToken: "t9" });
  assert.notEqual(d.live().requestId, live.requestId, "a finished request's ID is never reused");
});

test("a prompt that moves under a draft keeps the text but refuses the stale Send once", async () => {
  const d = desktop();
  const live = d.live();
  ok(await d.router.handle({ type: "draft-set", text: "my answer", expectedDraftRevision: 0, binding: live }, "panel"));
  d.update({ inputToken: "t2" });
  const moved = d.live();
  const draft = d.router.snapshot().draft;
  assert.equal(draft.text, "my answer");
  refused(await d.router.handle({ type: "send", binding: moved, draftRevision: draft.revision }, "panel"), /moved on/);
  assert.equal(d.host.sent.length, 0);
  ok(await d.router.handle({ type: "send", binding: moved, draftRevision: d.router.snapshot().draft.revision }, "panel"));
  assert.equal(d.host.sent[0]!.binding.inputToken, "t2");
});

test("first run: the goal draft becomes the root zone, and nothing goes to a model", async () => {
  const d = desktop();
  d.update({ zoneEpoch: null, activeZone: null, state: null, inputToken: "idle", registry: { version: 1, revision: 0, activeZoneId: null, zones: [] } });
  const goal = d.live();
  assert.equal(goal.zoneId, null);
  ok(await d.router.handle({ type: "draft-set", text: "  learn   balanced trees\nproperly  ", expectedDraftRevision: 0, binding: goal }, "panel"));
  refused(await d.router.handle({ type: "share-choose", kind: "file", binding: goal }, "panel"), /request it doesn't accept/);
  ok(await d.router.handle({ type: "send", binding: goal, draftRevision: 1 }, "panel"));
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
  const share = (path: string, kind: "file" | "folder") => d.router.handle({ type: "share-path", path, kind, binding: d.live() }, "panel");

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

  refused(await d.router.handle({ type: "share-path", path: file, kind: "file", binding: { ...d.live(), requestId: "other" } }, "panel"), /prompt that's over/);
});

test("shares go with the request they were made for; a new epoch voids them", async () => {
  const d = desktop();
  d.pick("/picked/notes.md");
  ok(await d.router.handle({ type: "share-choose", kind: "file", binding: d.live() }, "command"));
  const shareId = d.router.snapshot().draft.shareIds[0]!;
  ok(await d.router.handle({ type: "draft-set", text: "look", expectedDraftRevision: d.router.snapshot().draft.revision, binding: d.live() }, "command"));
  ok(await d.router.handle({ type: "send", binding: d.live(), draftRevision: d.router.snapshot().draft.revision }, "command"));
  assert.deepEqual(d.host.sent[0]!.shares.map((s) => s.id), [shareId]);
  assert.deepEqual(d.host.bindings[0], d.host.sent[0]!.binding, "shared and sent under one binding");

  d.pick("/picked/other.md");
  d.update({ state: state(), inputToken: "t5" });
  ok(await d.router.handle({ type: "share-choose", kind: "file", binding: d.live() }, "command"));
  d.update({ zoneEpoch: "e2" });
  assert.deepEqual(d.router.snapshot().draft.shareIds, [], "a reopened zone drops the draft's shares");
});

test("captures need the live binding and an attach-capable prompt, and die with the epoch", async () => {
  const d = desktop();
  ok(await d.router.handle({ type: "capture-sources" }, "command"));
  refused(await d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: { ...d.live(), inputToken: "old" } }, "command"), /prompt that's over/);
  d.update({ canAttach: false });
  refused(await d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "command"), /next request/);
  d.update({ canAttach: true });
  const pending = d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "command");
  await settle();
  d.grabs[0]!.finish(Buffer.from(PNG));
  ok(await pending);
  assert.ok(d.router.snapshot().draft.captureToken);
  ok(await d.router.handle({ type: "draft-set", text: "what's wrong here?", expectedDraftRevision: d.router.snapshot().draft.revision, binding: d.live() }, "command"));
  ok(await d.router.handle({ type: "send", binding: d.live(), draftRevision: d.router.snapshot().draft.revision }, "command"));
  assert.equal(d.host.sent[0]!.image?.label, "Editor - app.ts");
  assert.equal(d.captures.holding, false);

  d.update({ state: state(), inputToken: "t3" });
  const again = d.router.handle({ type: "capture-preview", sourceId: "window:42:0", binding: d.live() }, "command");
  await settle();
  d.grabs[1]!.finish(Buffer.from(PNG));
  ok(await again);
  d.update({ zoneEpoch: "e2" });
  assert.equal(d.captures.holding, false, "a zone reopen drops the held capture");
  assert.equal(d.router.snapshot().draft.captureToken, undefined);
});

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

  // A full draft refuses a new press and a mouse start.
  d.router.voiceEvent({ op: "pressed", gestureId: "g2" });
  await settle();
  assert.equal(d.voice.length, 1);
  refused(await d.router.handle({ type: "voice-start", binding: d.live() }, "panel"), /isn't empty/);

  // Late text for an old epoch is dropped with a visible status, never written anywhere.
  const fresh = desktop();
  const old = fresh.live();
  fresh.update({ zoneEpoch: "e2" });
  assert.ok(fresh.voice.includes("cancel"), "a new epoch cancels the recording");
  fresh.router.voiceEvent({ op: "transcript", recordingId: "rec9", binding: old, text: "too late" } satisfies VoiceEvent);
  assert.equal(fresh.router.snapshot().draft.text, "");
  assert.equal(fresh.router.snapshot().voice.phase, "error");
  refused(await fresh.router.handle({ type: "voice-start", binding: old }, "panel"), /changed/);
  refused(await fresh.router.handle({ type: "voice-stop", recordingId: "rec9" }, "panel"), /no longer active/);
});

test("a voice request's reply shows in the bubble: Dum's words, then the Wizard's line", async () => {
  const d = desktop();
  const live = d.live();
  d.router.voiceEvent({ op: "transcript", recordingId: "r", binding: live, text: "explain" });
  ok(await d.router.handle({ type: "send", binding: live, draftRevision: d.router.snapshot().draft.revision }, "command"));
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["Dum is working…"]);
  d.update({ state: state({ busy: true, prompt: null, transcript: [{ kind: "say", id: 1, text: "A rotation keeps order." }] }), inputToken: "idle" });
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["A rotation keeps order."]);
  d.update({ state: state({ transcript: [{ kind: "say", id: 1, text: "A rotation keeps order." }, { kind: "quip", id: 2, text: "Knuth vol. 3 §6.2.3" }] }), inputToken: "t7" });
  assert.equal(d.bubbles.at(-1)?.kind, "reply");
  assert.deepEqual(d.bubbles.at(-1)?.lines, ["A rotation keeps order.", "Wizard: Knuth vol. 3 §6.2.3"]);
});

test("settings: distinct shortcuts, applied before saved, rolled back on conflict; the agent isn't set here", async () => {
  const d = desktop();
  const prefs = d.settings.get();
  refused(await d.router.handle({ type: "settings", settings: { ...prefs, sendDraftHotkey: prefs.hotkey } }, "panel"), /must all be different/);
  d.conflictOn("Alt+K");
  refused(await d.router.handle({ type: "settings", settings: { ...prefs, hotkey: "Alt+K" } }, "panel"), /already used/);
  assert.equal(existsSync(join(d.dir, "settings.json")), false, "a refused shortcut saves nothing");
  const agent = { backend: "local", login: "none", intern: { backend: "local", model: "m", effort: null }, helper: { backend: "local", model: "m", effort: null } } as const;
  refused(await d.router.handle({ type: "settings", settings: { ...prefs, agent } }, "panel"), /Who powers Dum|Agent/);

  ok(await d.router.handle({ type: "settings", settings: { ...prefs, hotkey: "Alt+J", voiceHotkey: "Control+Alt+V", look: { apps: true, screen: false } } }, "panel"));
  assert.equal(DesktopSettings.load(d.dir, "local").get().hotkey, "Alt+J");
  assert.deepEqual(d.voice, ["configure Control+Alt+V"]);
  assert.deepEqual(d.look, [JSON.stringify({ apps: true, screen: false })]);
  assert.deepEqual(d.host.calls, ["settings Alt+J"], "the host gets main's saved copy");

  ok(await d.router.handle({ type: "settings", settings: { ...d.settings.get(), personalContext: true } }, "panel"));
  assert.ok(d.calls.includes("restart"), "personal context goes to a freshly started host");
});

test("zone delete and skill add need a native confirmation; deleting drops those zones' drafts", async () => {
  const d = desktop();
  d.answer(false);
  ok(await d.router.handle({ type: "zone-delete", id: zoneA, expectedRevision: 3 }, "panel"));
  assert.ok(d.calls.at(-1)!.includes("1 zone inside it"));
  ok(await d.router.handle({ type: "skill-edit", op: "add", skill: { name: "recursion", lang: "" } }, "panel"));
  assert.deepEqual(d.host.calls, [], "declined: nothing reaches the host");
  d.answer(true);
  ok(await d.router.handle({ type: "draft-set", text: "keep?", expectedDraftRevision: 0, binding: d.live() }, "panel"));
  ok(await d.router.handle({ type: "zone-delete", id: zoneA, expectedRevision: 3 }, "panel"));
  ok(await d.router.handle({ type: "skill-edit", op: "add", skill: { name: "recursion", lang: "" } }, "panel"));
  assert.deepEqual(d.host.calls, ["delete A", "skill add"]);
  assert.equal(d.router.snapshot().draft.text, "");
  refused(await d.router.handle({ type: "zone-delete", id: randomUUID(), expectedRevision: 3 }, "panel"), /doesn't exist/);
});

test("look pause, records and the tray share the router", async () => {
  const d = desktop();
  ok(await d.router.handle({ type: "look-pause", paused: true }, "tray"));
  assert.equal(d.router.snapshot().look.paused, true);
  assert.deepEqual(d.look, ["pause true"]);
  ok(await d.router.handle({ type: "open-record", record: "memory" }, "panel"));
  assert.ok(d.calls.includes("open /app/record.md"), "main opens only the path the host validated");
  ok(await d.router.handle({ type: "zone-enter", id: zoneB, expectedRevision: 3 }, "tray"));
  assert.deepEqual(d.host.calls, ["enter B 3"]);
  refused(await d.router.handle({ type: "interrupt", binding: { ...d.live(), zoneEpoch: "e0" } }, "command"), /isn't open/);
  ok(await d.router.handle({ type: "interrupt", binding: d.live() }, "command"));
});

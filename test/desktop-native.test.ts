// The desktop main process without Electron: what a page may ask for, what a capture may become,
// what settings survive, and how the bundled Claude runtime is found, checked and signed in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "../src/context.ts";
import type { Mode } from "../src/gate.ts";
import type { State } from "../src/store.ts";
import type { SharedImage } from "../src/desktop/controller.ts";
import type { CaptureSource, Settings } from "../src/desktop/protocol.ts";
import { Captures, type Capturer } from "../src/desktop/capture.ts";
import { DictationHelper } from "../src/desktop/dictation.ts";
import { Router, ownedPage, type Controller, type Native } from "../src/desktop/ipc.ts";
import { DesktopSettings, placeOnScreen } from "../src/desktop/settings.ts";
import { RuntimeSetup, bundledCandidates, resolveBundled, type Probe } from "../src/desktop/runtime-setup.ts";
import { MODELS, claudeExecutable, closed, login, start } from "../src/runtime.ts";

const temp = () => mkdtempSync(join(tmpdir(), "dum-native-"));
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("IHDR-pretend-frame")]);
const SOURCES: CaptureSource[] = [
  { id: "screen:1:0", name: "Built-in display", kind: "screen" },
  { id: "window:42:0", name: "Editor - app.ts", kind: "window" },
];

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

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

const settle = () => new Promise((r) => setImmediate(r));

test("a capture is shown locally, then sent at most once, only for the prompt and project it was taken for", async () => {
  let now = 1_000;
  const { c, grabs } = capturer();
  const captures = new Captures(c, 60_000, () => now);
  const here = { root: "/p", inputToken: "t1" };

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
  assert.equal(Buffer.from(preview.dataUrl.split(",")[1]!, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(!preview.dataUrl.includes(preview.token));

  assert.throws(() => captures.take(preview.token, { root: "/p", inputToken: "t2" }), /different prompt/);
  assert.equal(captures.holding, false, "a stale send releases the bytes");
  assert.throws(() => captures.take(preview.token, here), /no longer held/);

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

test("discard, cancel and project switch release a capture, including one still being taken", async () => {
  const { c, grabs } = capturer();
  const captures = new Captures(c);
  const here = { root: "/p", inputToken: "t1" };
  await captures.sources();

  const held = captures.preview("screen:1:0", here);
  grabs[0]!.finish(Buffer.from(PNG));
  const preview = await held;
  captures.invalidate({ root: "/p", inputToken: "t1" });
  assert.equal(captures.holding, true, "the same prompt keeps it");
  captures.invalidate({ root: "/other", inputToken: "t1" });
  assert.equal(captures.holding, false, "another project drops it");
  assert.throws(() => captures.take(preview.token, here), /no longer held/);

  const racing = captures.preview("window:42:0", here);
  await settle();
  captures.discard();
  const bytes = Buffer.from(PNG);
  grabs[1]!.finish(bytes);
  await assert.rejects(racing, /cancelled/);
  assert.equal(captures.holding, false, "a grab finishing after discard is thrown away");
  assert.ok(bytes.every((b) => b === 0), "and its bytes are wiped");

  const gone = captures.preview("window:42:0", here);
  grabs[2]!.finish(null);
  await assert.rejects(gone, /isn't available any more/, "a closed window is reported, never a blank capture");
  const junk = captures.preview("window:42:0", here);
  grabs[3]!.finish(Buffer.from("GIF89a not a png"));
  await assert.rejects(junk, /isn't a PNG/);

  const denied = new Captures({ list: async () => { throw new Error("Screen Recording is off for dum."); }, grab: async () => null });
  await assert.rejects(denied.sources(), /Screen Recording is off/);
  const empty = new Captures({ list: async () => [], grab: async () => null });
  await assert.rejects(empty.sources(), /No screens or windows/);
});

test("a prompt that changes while a capture is being taken cancels that capture instead of holding it", async () => {
  const { c, grabs } = capturer();
  const captures = new Captures(c);
  await captures.sources();

  const racing = captures.preview("window:42:0", { root: "/p", inputToken: "t1" });
  await settle();
  captures.invalidate({ root: "/p", inputToken: "t2" });
  const bytes = Buffer.from(PNG);
  grabs[0]!.finish(bytes);
  await assert.rejects(racing, /cancelled|changed/);
  assert.equal(captures.holding, false, "the frame for the old prompt is never kept");
  assert.ok(bytes.every((b) => b === 0), "and its bytes are wiped");

  const same = captures.preview("window:42:0", { root: "/p", inputToken: "t2" });
  await settle();
  captures.invalidate({ root: "/p", inputToken: "t2" });
  grabs[1]!.finish(Buffer.from(PNG));
  assert.equal((await same).name, "Editor - app.ts", "an unchanged prompt keeps its capture");

  const closing = captures.preview("window:42:0", { root: "/p", inputToken: "t2" });
  await settle();
  captures.invalidate(null);
  grabs[2]!.finish(Buffer.from(PNG));
  await assert.rejects(closing, /cancelled|changed/, "no project at all cancels it too");
  assert.equal(captures.holding, false);
});

function stateFor(root: string, mode: Mode, extra: Partial<State> = {}): State {
  return {
    repo: root.split(sep).pop()!, root, files: [], mode, transcript: [], prompt: null, busy: false, status: "",
    stage: { kind: "conversation" }, unlocked: 0,
    models: { intern: { model: "m", effort: "high" }, wizard: { model: "m", effort: "high" } },
    ...extra,
  } as State;
}

class FakeController implements Controller {
  state: State | null = null;
  inputToken = "";
  canAttach = false;
  tree = null;
  wizardStatus = "wizard advice is off";
  adviceEnabled = false;
  async setWizardAdvice(enabled: boolean, _source?: 'screen' | 'files') {
    this.adviceEnabled = enabled;
    this.wizardStatus = enabled ? "wizard is watching" : "wizard advice is off";
  }
  sent: { text: string; inputToken: string; image?: SharedImage }[] = [];
  chosen: { root: string; personal: Context; mode?: Mode }[] = [];
  hold: Promise<void> | null = null;
  commands: string[] = [];
  async choose(root: string, personal: Context, mode?: Mode) {
    this.chosen.push({ root, personal, mode });
    if (this.hold) await this.hold;
    this.state = stateFor(root, mode ?? "understand");
    this.inputToken = `t${this.chosen.length}`;
    this.canAttach = true;
  }
  async send(text: string, inputToken: string, image?: SharedImage) {
    this.sent.push({ text, inputToken, ...(image ? { image } : {}) });
  }
  async command(name: string, argument?: string) {
    this.commands.push(`${name} ${argument ?? ""}`.trim());
  }
  async panel(panel: string) {
    this.commands.push(`panel ${panel}`);
  }
  async interrupt() {
    this.commands.push("interrupt");
  }
  async close() {}
}

function desktop(dir = temp()) {
  const controller = new FakeController();
  const { c, grabs } = capturer();
  const captures = new Captures(c);
  const settings = DesktopSettings.load(dir);
  const calls: string[] = [];
  let picked: string | null = null;
  let conflict = "";
  const native: Native = {
    chooseDirectory: async () => picked,
    openPath: async (path) => void calls.push(`open ${path}`),
    openExternal: async (url) => void calls.push(`external ${url}`),
    openScreenSettings: async () => void calls.push("screen settings"),
    screenPermission: () => "granted",
    applySettings(next: Settings) {
      if (next.hotkey === conflict) throw new Error(`${next.hotkey} is already used by another app`);
      calls.push(`apply ${next.hotkey}`);
    },
    hotkeyError: () => "",
    togglePanel: () => void calls.push("toggle"),
    hidePanel: () => void calls.push("hide"),
    moveCompanion: (dx, dy) => void calls.push(`move ${dx},${dy}`),
    quit: () => void calls.push("quit"),
  };
  const runtime = new RuntimeSetup({ error: "no runtime in tests" }, () => {}, { version: async () => false, auth: async () => ({}), git: async () => true }, "linux");
  const personalAsked: boolean[] = [];
  const router = new Router({
    controller, captures, settings, runtime, native, platform: "linux", version: "0.0.1",
    dictation: new DictationHelper({ platform: "linux", arch: "x64", systemVersion: "6.8.0", resourcesPath: () => dir, spawnOpen: () => { throw new Error("unsupported helper must not launch"); } }),
    personal: (enabled) => { personalAsked.push(enabled); return { path: "", text: "", warning: "" }; },
  });
  return {
    controller, captures, grabs, settings, calls, router, personalAsked, dir,
    pick: (root: string | null) => { picked = root; },
    conflictOn: (hotkey: string) => { conflict = hotkey; },
  };
}

test("the renderer's requests are strictly validated, and refusals change nothing", async () => {
  const d = desktop();
  for (const bad of [
    null,
    "snapshot",
    { type: "eval", code: "process.exit()" },
    { type: "snapshot", extra: true },
    { type: "send", text: "x".repeat(33 * 1024), inputToken: "" },
    { type: "move-companion", dx: 1.5, dy: 0 },
    { type: "move-companion", dx: 10_000, dy: 0 },
    { type: "command", name: "self", argument: "" },
    { type: "open-project", root: "" },
    { type: "settings", settings: { hotkey: "D", alwaysOnTop: true, allWorkspaces: true, launchAtLogin: false, personalContext: false } },
    { type: "settings", settings: { hotkey: "CommandOrControl+Shift+D", alwaysOnTop: true, allWorkspaces: true, launchAtLogin: false, personalContext: false, shell: "/bin/sh" } },
    { type: "open-record", record: "file", path: "/etc/passwd" },
  ]) {
    const reply = await d.router.handle(bad);
    assert.equal(reply.ok, false, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(d.calls, []);
  assert.equal(existsSync(join(d.dir, "settings.json")), false, "nothing was saved");

  const reply = await d.router.handle({ type: "move-companion", dx: -12, dy: 4 });
  assert.ok(reply.ok && reply.snapshot);
  assert.deepEqual(d.calls, ["move -12,4"]);
});

test("a page request counts only from dum's own UI file", () => {
  const index = "file:///Applications/dum.app/Contents/Resources/app.asar/dist/desktop/ui/index.html";
  assert.equal(ownedPage(`${index}?view=panel`, index), true);
  assert.equal(ownedPage("file:///tmp/evil/index.html?view=panel", index), false);
  assert.equal(ownedPage("https://claude.com/dist/desktop/ui/index.html", index), false);
  assert.equal(ownedPage("not a url", index), false);
});

test("projects open only from the native chooser or the recent list, never mid-turn or twice at once", async () => {
  const d = desktop();
  const project = temp();
  const unknown = await d.router.handle({ type: "open-project", root: project });
  assert.ok(!unknown.ok && /Open project/.test(unknown.error), "a root the person never chose is refused");
  d.pick(null);
  assert.equal((await d.router.handle({ type: "choose-project" })).ok, true, "a cancelled chooser is no change");
  assert.equal(d.controller.chosen.length, 0);

  d.pick(project);
  const opened = await d.router.handle({ type: "choose-project" });
  assert.ok(opened.ok && opened.snapshot?.state?.root === project);
  assert.deepEqual(opened.snapshot!.recentProjects, [{ name: project.split(sep).pop(), root: project }]);
  assert.deepEqual(d.personalAsked, [false], "personal context stays off unless the setting is on");
  assert.deepEqual(DesktopSettings.load(d.dir).recent, [project], "the recent list survives a restart");

  assert.equal((await d.router.handle({ type: "open-project", root: project })).ok, true);
  d.controller.state = { ...d.controller.state!, busy: true };
  const mid = await d.router.handle({ type: "open-project", root: project });
  assert.ok(!mid.ok && /Stop/.test(mid.error));
  d.controller.state = { ...d.controller.state!, busy: false };

  const gate = Promise.withResolvers<void>();
  d.controller.hold = gate.promise;
  const slow = d.router.handle({ type: "mode", mode: "anti-vibe" });
  const second = await d.router.handle({ type: "open-project", root: project });
  assert.ok(!second.ok && /already opening/.test(second.error));
  gate.resolve();
  assert.equal((await slow).ok, true);
  assert.equal(d.controller.state?.mode, "anti-vibe");
  assert.equal(d.controller.chosen.at(-1)?.mode, "anti-vibe");
});

test("Send carries a capture only once, only at an attach-capable prompt, and never after the prompt moved", async () => {
  const d = desktop();
  const project = temp();
  d.pick(project);
  await d.router.handle({ type: "choose-project" });
  const token = d.controller.inputToken;

  assert.equal((await d.router.handle({ type: "capture-preview", sourceId: "screen:1:0", inputToken: token })).ok, false, "only a listed source");
  const listed = await d.router.handle({ type: "capture-sources" });
  assert.ok(listed.ok && listed.sources?.length === 2);
  const stalePreview = await d.router.handle({ type: "capture-preview", sourceId: "screen:1:0", inputToken: "old" });
  assert.ok(!stalePreview.ok && /prompt changed/.test(stalePreview.error));

  const taking = d.router.handle({ type: "capture-preview", sourceId: "window:42:0", inputToken: token });
  await settle();
  d.grabs[0]!.finish(Buffer.from(PNG));
  const shown = await taking;
  assert.ok(shown.ok && shown.preview);
  const captureToken = shown.preview.token;

  const stale = await d.router.handle({ type: "send", text: "look", inputToken: "old", captureToken });
  assert.ok(!stale.ok && /nothing was sent/.test(stale.error));
  d.controller.canAttach = false;
  const locked = await d.router.handle({ type: "send", text: "look", inputToken: token, captureToken });
  assert.ok(!locked.ok && /can't take a screenshot/.test(locked.error));
  assert.equal(d.captures.holding, true, "a refused send keeps the preview for the next turn");
  d.controller.canAttach = true;

  const sent = await d.router.handle({ type: "send", text: "what is this error?", inputToken: token, captureToken });
  assert.equal(sent.ok, true);
  assert.equal(d.controller.sent.length, 1);
  assert.equal(Buffer.from(d.controller.sent[0]!.image!.data, "base64").equals(PNG), true, "the bytes main captured, not anything from the page");
  const twice = await d.router.handle({ type: "send", text: "again", inputToken: token, captureToken });
  assert.ok(!twice.ok && /no longer held/.test(twice.error));
  assert.equal(d.controller.sent.length, 1);

  const next = d.router.handle({ type: "capture-preview", sourceId: "screen:1:0", inputToken: token });
  await settle();
  d.grabs[1]!.finish(Buffer.from(PNG));
  const second = await next;
  assert.ok(second.ok && second.preview);
  d.controller.inputToken = "t-next";
  d.router.changed();
  assert.equal(d.captures.holding, false, "the prompt moved on, so the capture is released");
  const late = await d.router.handle({ type: "send", text: "x", inputToken: "t-next", captureToken: second.preview.token });
  assert.ok(!late.ok);
  assert.equal(d.controller.sent.length, 1);
  assert.equal((await d.router.handle({ type: "send", text: "  ", inputToken: "t-next" })).ok, false, "an empty send is refused");
});

test("settings are applied before they are saved, and a hotkey conflict leaves the saved file alone", async () => {
  const d = desktop();
  const next = { ...d.settings.settings, hotkey: "Alt+Shift+K", alwaysOnTop: !d.settings.settings.alwaysOnTop };
  assert.equal((await d.router.handle({ type: "settings", settings: next })).ok, true);
  assert.deepEqual(DesktopSettings.load(d.dir).settings, next);
  assert.equal(statSync(join(d.dir, "settings.json")).mode & 0o777, 0o600);

  d.conflictOn("Control+Alt+P");
  const refused = await d.router.handle({ type: "settings", settings: { ...next, hotkey: "Control+Alt+P" } });
  assert.ok(!refused.ok && /already used/.test(refused.error));
  assert.deepEqual(DesktopSettings.load(d.dir).settings, next, "the saved settings didn't change");
  const raw = readFileSync(join(d.dir, "settings.json"), "utf8");
  assert.doesNotMatch(raw, /token|transcript|data:image|email/i);
});

test("legacy settings keep their preferences and advice remains opt-in", () => {
  const dir = temp();
  const old = { hotkey: "Alt+Shift+K", alwaysOnTop: false, allWorkspaces: false, launchAtLogin: false, personalContext: true };
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, settings: old, recent: [], companion: { x: 12, y: 34 } }));
  const migrated = DesktopSettings.load(dir);
  assert.equal(migrated.warning, "");
  assert.deepEqual(migrated.settings, { ...old, wizardAdvice: false, wizardSource: 'screen' });
  assert.deepEqual(migrated.companion, { x: 12, y: 34 });
  const fresh = DesktopSettings.load(temp());
  assert.equal(fresh.settings.wizardAdvice, true, "fresh install defaults to wizard enabled");
  assert.equal(fresh.settings.wizardSource, 'screen', "fresh install defaults to screen source");
});

test("the advice toggle reaches the project controller and survives reopening", async () => {
  const d = desktop();
  assert.equal(d.router.snapshot().settings.wizardAdvice, true);
  const next = { ...d.settings.settings, wizardAdvice: false };
  assert.equal((await d.router.handle({ type: "settings", settings: next })).ok, true);
  assert.equal(d.controller.adviceEnabled, false);
  assert.equal(DesktopSettings.load(d.dir).settings.wizardAdvice, false);
  assert.equal(d.router.snapshot().wizardStatus, d.controller.wizardStatus);
  d.pick(d.dir);
  assert.equal((await d.router.handle({ type: "choose-project" })).ok, true);
  assert.equal(d.controller.adviceEnabled, false);
  assert.equal((await d.router.handle({ type: "settings", settings: { ...next, wizardAdvice: true } })).ok, true);
  assert.equal(d.controller.adviceEnabled, true);
});

test("a corrupt settings file is set aside rather than overwritten, and the companion stays on a screen", () => {
  const dir = temp();
  writeFileSync(join(dir, "settings.json"), "{ not json");
  const loaded = DesktopSettings.load(dir);
  assert.match(loaded.warning, /couldn't be read/);
  const aside = readdirSync(dir).find((f) => f.startsWith("settings.json.invalid-"));
  assert.ok(aside);
  assert.equal(readFileSync(join(dir, aside), "utf8"), "{ not json");

  const dir2 = temp();
  writeFileSync(join(dir2, "settings.json"), JSON.stringify({ version: 1, settings: loaded.settings, recent: ["relative/path"], companion: null }));
  assert.match(DesktopSettings.load(dir2).warning, /couldn't be read/, "a relative recent root isn't accepted");

  const main = { x: 0, y: 0, width: 1440, height: 875 };
  const side = { x: 1440, y: 0, width: 1920, height: 1055 };
  const size = { width: 118, height: 128 };
  assert.deepEqual(placeOnScreen({ x: 1500, y: 100 }, size, [main, side], main), { x: 1500, y: 100 });
  assert.deepEqual(placeOnScreen({ x: 1400, y: 900 }, size, [main, side], main), { x: 1440, y: 900 }, "straddling: onto the display it mostly covers");
  assert.deepEqual(placeOnScreen({ x: 5000, y: 3000 }, size, [main], main), { x: 1322, y: 747 }, "an unplugged display's spot comes back on screen");
});

test("open-record opens only reported proposals, current course scratch or memory, never through symlinks", async () => {
  const d = desktop();
  const root = temp();
  d.pick(root);
  await d.router.handle({ type: "choose-project" });
  mkdirSync(join(root, ".dum", "proposals"), { recursive: true });
  mkdirSync(join(root, ".dum", "courses"), { recursive: true });
  writeFileSync(join(root, ".dum", "proposals", "a.patch"), "patch");
  writeFileSync(join(root, ".dum", "proposals", "unreported.patch"), "patch");
  writeFileSync(join(root, ".dum", "memory.md"), "notes");
  writeFileSync(join(root, "secret.txt"), "x");
  symlinkSync(join(root, "secret.txt"), join(root, ".dum", "courses", "loops.py"));
  d.controller.state = stateFor(root, "understand", {
    transcript: [
      { kind: "diff", id: 1, path: "a.py", diff: "", outcome: "proposed", artifact: ".dum/proposals/a.patch" },
      { kind: "course", id: 2, card: { skill: "loops", lang: "python", lesson: "", example: "", wizard: "", task: "", path: ".dum/courses/loops.py", run: "" }, passed: null },
    ],
  });

  assert.equal((await d.router.handle({ type: "open-record", record: "proposal", path: ".dum/proposals/a.patch" })).ok, true);
  assert.equal((await d.router.handle({ type: "open-record", record: "memory" })).ok, true);
  for (const bad of [
    { record: "proposal", path: ".dum/proposals/unreported.patch" },
    { record: "proposal", path: "../../etc/passwd" },
    { record: "memory", path: "secret.txt" },
    { record: "course", path: ".dum/courses/loops.py" },
  ]) {
    const reply = await d.router.handle({ type: "open-record", ...bad });
    assert.equal(reply.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(d.calls, [`open ${join(root, ".dum", "proposals", "a.patch")}`, `open ${join(root, ".dum", "memory.md")}`]);
});

test("the Claude executable is the bundled binary by absolute path, or plain claude for the terminal", () => {
  const dir = temp();
  const bin = script(dir, "claude", "exit 0");
  writeFileSync(join(dir, "plain"), "x");
  assert.equal(claudeExecutable({}), "claude");
  assert.equal(claudeExecutable({ DUM_CLAUDE_BIN: bin }), bin);
  for (const bad of ["claude", "./claude", join(dir, "missing"), join(dir, "plain"), dir]) {
    assert.throws(() => claudeExecutable({ DUM_CLAUDE_BIN: bad }), /absolute path to the claude executable/, bad);
  }
  const before = process.env.DUM_CLAUDE_BIN;
  process.env.DUM_CLAUDE_BIN = bin;
  try {
    assert.equal(closed({ cwd: "/tmp", systemPrompt: "", ...MODELS.helper }).pathToClaudeCodeExecutable, bin);
  } finally {
    if (before === undefined) delete process.env.DUM_CLAUDE_BIN;
    else process.env.DUM_CLAUDE_BIN = before;
  }

  assert.deepEqual(bundledCandidates("darwin", "arm64", false), ["@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"]);
  assert.deepEqual(bundledCandidates("linux", "x64", true), ["@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude", "@anthropic-ai/claude-agent-sdk-linux-x64/claude"]);
  const app = join(dir, "dum.app", "Contents", "Resources");
  const unpacked = join(app, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64");
  mkdirSync(unpacked, { recursive: true });
  script(unpacked, "claude", "exit 0");
  const packed = join(app, "app.asar", "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude");
  assert.equal(resolveBundled(() => packed, "darwin", "arm64", false), join(unpacked, "claude"), "a packaged app runs the unpacked copy");
  assert.throws(() => resolveBundled(() => { throw new Error("not installed"); }, "darwin", "x64", false), /doesn't include Claude's runtime for darwin-x64/);
});

test("auth status yields login provenance only, through the isolated CLI flags", async () => {
  const dir = temp();
  const bin = script(dir, "claude", `[ "$1" = "--safe-mode" ] && [ "$3" = "" ] || exit 3
echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"private@example.com","orgName":"Private Org"}'`);
  assert.deepEqual(await login(bin), { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
  await assert.rejects(login(script(dir, "broken", "exit 1")), /couldn't verify/);
});

test("startup that is stopped during the login handshake closes Claude at once", async () => {
  const abortController = new AbortController();
  let wasClosed = false;
  const info = Promise.withResolvers<never>();
  info.promise.catch(() => {});
  const run = (() => Object.assign((async function* () {})(), {
    close() { wasClosed = true; info.reject(new Error("closed")); },
    accountInfo: () => info.promise,
  })) as unknown as Query;
  const opening = start("private", { ...closed({ cwd: "/tmp", systemPrompt: "", ...MODELS.helper }), abortController }, run, async () => ({ effective: {}, provenance: {}, sources: [] }));
  await settle();
  await settle();
  abortController.abort();
  await assert.rejects(opening, /stopped before Claude finished starting/);
  assert.equal(wasClosed, true);
});

/** The CLI is a real process, so its output arrives in its own time; wait for it, but not forever. */
async function until(pred: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !pred(); ) {
    if (Date.now() > end) throw new Error("timed out waiting for the sign-in process");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("first-launch sign-in runs the bundled CLI's own flow, exposes only its official page, and can be cancelled", async () => {
  const dir = temp();
  const bin = script(dir, "claude", `echo "Opening browser to sign in..."
echo "visit: https://evil.example/cai/oauth/authorize?x=1"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s"
printf "Paste code here if prompted > "
read code
[ "$code" = "abcDEF123#xyz789" ] && exit 0
exit 4`);
  let checks = 0;
  const probe: Probe = {
    version: async () => true,
    auth: async () => { checks++; return checks > 1 ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" } : { loggedIn: false }; },
    git: async () => true,
  };
  const setup = new RuntimeSetup({ path: bin }, () => {}, probe, "darwin");
  await setup.check();
  assert.equal(setup.status.available, true);
  assert.equal(setup.status.authenticated, false);
  assert.match(setup.status.message, /Sign in/);

  assert.throws(() => setup.loginPage(), /isn't running/);
  setup.login();
  assert.throws(() => setup.login(), /already running/);
  await until(() => setup.status.loginNeedsCode);
  assert.equal(setup.loginPage(), "https://claude.com/cai/oauth/authorize?code=true&state=s");
  assert.throws(() => setup.code("rm -rf /"), /doesn't look like a sign-in code/);
  setup.code("abcDEF123#xyz789");
  await until(() => setup.status.authenticated);
  assert.equal(setup.status.loginRunning, false);
  assert.doesNotMatch(JSON.stringify(setup.status), /abcDEF123|state=s/, "neither the code nor the page address is kept in status");

  const ended = new RuntimeSetup({ path: script(dir, "slow", `echo "visit: https://claude.ai/oauth"\nexec sleep 30`) }, () => {}, probe, "darwin");
  ended.login();
  await until(() => { try { return ended.loginPage() === "https://claude.ai/oauth"; } catch { return false; } });
  ended.cancel();
  await until(() => !ended.status.loginRunning);
  assert.match(ended.status.message, /cancelled/);
  assert.throws(() => ended.code("abcDEF123#xyz789"), /isn't waiting/);
});

test("a build without its runtime says so instead of falling back to another claude", async () => {
  const setup = new RuntimeSetup({ error: "this build of dum doesn't include Claude's runtime for darwin-arm64" }, () => {}, { version: async () => true, auth: async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }), git: async () => false }, "darwin");
  await setup.check();
  assert.equal(setup.status.available, false);
  assert.equal(setup.status.authenticated, false);
  assert.equal(setup.status.gitAvailable, false);
  assert.match(setup.status.message, /doesn't include Claude's runtime/);
  assert.throws(() => setup.login(), /doesn't include/);
  await assert.rejects(new RuntimeSetup({ path: "/x" }, () => {}, undefined, "linux").gitSetup(), /package manager/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, type DesktopPreferences } from "../src/desktop/protocol.ts";
import { DesktopSettings, withPlacement, type CircleLayout, type CirclePlacement } from "../src/desktop/settings.ts";
import { CLAUDE_DEFAULTS } from "../src/agent/schema.ts";
import type { AgentChoice } from "../src/agent/types.ts";

function scratch(): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dum-settings-"));
  return { dir, file: join(dir, "settings.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const v1 = (settings: Record<string, unknown>) => JSON.stringify({
  version: 1,
  settings: { hotkey: "Alt+K", alwaysOnTop: false, allWorkspaces: true, launchAtLogin: true, personalContext: true, ...settings },
  recent: ["/Users/me/project"],
  companion: { x: 10, y: 20 },
});

/** A Claude choice as builds before the look role and the API-key-only rule saved it. */
const older = {
  backend: "claude",
  login: "claude-subscription",
  intern: { backend: "claude", model: "opus", effort: "high" },
  helper: { backend: "claude", model: "fable", effort: "high" },
};
const apiKey: AgentChoice = { ...older, login: "anthropic-key", look: { ...CLAUDE_DEFAULTS.look } } as AgentChoice;

test("a fresh install uses the defaults, with the look on", () => {
  const { dir, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir);
    assert.deepEqual(settings.get(), DEFAULT_PREFERENCES);
    assert.deepEqual(settings.get().look, { apps: true, screen: true });
    assert.equal(settings.warning, "");
    assert.deepEqual(readdirSync(dir), [], "loading writes nothing");
  } finally { done(); }
});

const NO_CIRCLE: CircleLayout = { lastChosenDisplayId: null, placements: [] };
const v3 = (settings: unknown, circle: unknown = NO_CIRCLE) => JSON.stringify({ version: 3, settings, circle });

test("a version 1 file migrates in place once: window, workspace, recent and companion fields go, screen advice becomes the look", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, v1({ wizardAdvice: true, wizardSource: "screen" }));
    const settings = DesktopSettings.load(dir);
    const expected: DesktopPreferences = { ...DEFAULT_PREFERENCES, hotkey: "Alt+K", launchAtLogin: true, personalContext: true, look: { apps: true, screen: true } };
    assert.deepEqual(settings.get(), expected);
    assert.equal(settings.warning, "");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored, { version: 3, settings: expected, circle: NO_CIRCLE }, "the old companion position is not imported");
    assert.deepEqual(settings.circle(), NO_CIRCLE);
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
    assert.deepEqual(readdirSync(dir), ["settings.json"], "rewritten in place, nothing set aside");
    const again = DesktopSettings.load(dir);
    assert.deepEqual(again.get(), expected);
    assert.equal(again.warning, "");
  } finally { done(); }
});

test("saved-file advice maps to no screen look and a notice to follow a folder; advice that was off stays off", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, v1({ wizardAdvice: true, wizardSource: "files" }));
    const files = DesktopSettings.load(dir);
    assert.deepEqual(files.get().look, { apps: true, screen: false });
    assert.match(files.warning, /[Ff]ollow a folder/);

    writeFileSync(file, v1({ wizardAdvice: false, wizardSource: "screen" }));
    const off = DesktopSettings.load(dir);
    assert.deepEqual(off.get().look, { apps: true, screen: false });
    assert.equal(off.warning, "");

    writeFileSync(file, v1({}));
    assert.deepEqual(DesktopSettings.load(dir).get().look, { apps: true, screen: false }, "a file from before screen advice had it off");
  } finally { done(); }
});

test("an older Claude choice migrates once: the subscription becomes the API key with the same models, and the look gets its default", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, mode: "anti-vibe", agent: older } }));
    const settings = DesktopSettings.load(dir);
    assert.deepEqual(settings.get().agent, apiKey);
    assert.equal(settings.get().mode, "anti-vibe", "the rest of the preferences still load");
    assert.match(settings.warning, /only with your own Anthropic API key/);
    assert.match(settings.warning, /look model: haiku \(low\)/);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored.settings.agent, apiKey, "written once");
    assert.equal(stored.version, 3);
    assert.deepEqual(readdirSync(dir), ["settings.json"], "nothing set aside");
    const again = DesktopSettings.load(dir);
    assert.deepEqual(again.get().agent, apiKey);
    assert.equal(again.warning, "", "the migration runs once");
  } finally { done(); }
});

test("a non-Claude choice without a look model gets its own helper selector as the look", () => {
  const { dir, file, done } = scratch();
  try {
    const helper = { backend: "local", model: "ollama/llava:7b", effort: null };
    const local = { backend: "local", login: "none", intern: { backend: "local", model: "ollama/qwen3:8b", effort: "high" }, helper };
    writeFileSync(file, JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, agent: local } }));
    const settings = DesktopSettings.load(dir);
    assert.deepEqual(settings.get().agent, { ...local, look: helper });
    assert.match(settings.warning, /look model: ollama\/llava:7b/);
  } finally { done(); }
});

test("a current choice loads as saved; one that still doesn't parse loads as null, unchanged on disk", () => {
  const { dir, file, done } = scratch();
  try {
    const body = v3({ ...DEFAULT_PREFERENCES, agent: apiKey });
    writeFileSync(file, body);
    const settings = DesktopSettings.load(dir);
    assert.deepEqual(settings.get().agent, apiKey);
    assert.equal(settings.warning, "");
    assert.equal(readFileSync(file, "utf8"), body, "a current file is never rewritten by loading");

    const broken = JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, agent: { ...apiKey, login: "chatgpt" } } });
    writeFileSync(file, broken);
    const refused = DesktopSettings.load(dir);
    assert.equal(refused.get().agent, null);
    assert.match(refused.warning, /Choose again/);
    assert.equal(readFileSync(file, "utf8"), broken, "never set aside or rewritten");
    assert.throws(() => refused.set({ ...refused.get(), agent: { ...apiKey, login: "claude-subscription" } as unknown as AgentChoice }));
  } finally { done(); }
});

test("no tokens are accepted: extra fields are refused when set and never loaded from disk", () => {
  const { dir, file, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir);
    settings.set({ ...DEFAULT_PREFERENCES, hotkey: "Alt+J" });
    const saved = readFileSync(file, "utf8");
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, apiKey: "sk-ant-secret" } as DesktopPreferences));
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, agent: { ...apiKey, key: "sk-ant-secret" } as AgentChoice }));
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.equal(settings.get().hotkey, "Alt+J");

    writeFileSync(file, JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, agent: { ...apiKey, token: "sk-ant-secret" } } }));
    const loaded = DesktopSettings.load(dir);
    assert.equal(loaded.get().agent, null);
    assert.doesNotMatch(JSON.stringify(loaded.get()), /sk-ant/);

    writeFileSync(file, JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, token: "sk-ant-secret" } }));
    const asideFile = DesktopSettings.load(dir);
    assert.deepEqual(asideFile.get(), DEFAULT_PREFERENCES);
    assert.match(asideFile.warning, /kept as/);
  } finally { done(); }
});

test("an unreadable file is kept aside and defaults are used, never silently overwritten", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, "{not json");
    const settings = DesktopSettings.load(dir);
    assert.deepEqual(settings.get(), DEFAULT_PREFERENCES);
    assert.match(settings.warning, /kept as/);
    const aside = readdirSync(dir).find((f) => f.startsWith("settings.json.invalid-"));
    assert.ok(aside);
    assert.equal(readFileSync(join(dir, aside), "utf8"), "{not json");
  } finally { done(); }
});

test("a hotkey that could eat ordinary typing is refused", () => {
  const { dir, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir);
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, voiceHotkey: "Shift+A" }));
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, sendDraftHotkey: "K" }));
    assert.deepEqual(settings.get(), DEFAULT_PREFERENCES);
  } finally { done(); }
});

test("a failed write leaves the previous preferences in force; get() hands out copies", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const { dir, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir);
    const copy = settings.get();
    copy.look.screen = false;
    assert.equal(settings.get().look.screen, true);
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, mode: "anti-vibe" }));
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(settings.get().mode, "understand");
  } finally { done(); }
});

const placement = (displayId: string, usedAt: string, u = 0.5, v = 0.25): CirclePlacement => ({ displayId, u, v, usedAt });

test("a version 2 file becomes version 3 once with every preference unchanged and the circle at its default", () => {
  const { dir, file, done } = scratch();
  try {
    const prefs: DesktopPreferences = {
      ...DEFAULT_PREFERENCES, hotkey: "Alt+K", voiceHotkey: "Control+Option+V", sendDraftHotkey: "Alt+Return", mode: "anti-vibe",
      launchAtLogin: true, personalContext: true, look: { apps: false, screen: false }, agent: apiKey,
    };
    writeFileSync(file, JSON.stringify({ version: 2, settings: prefs }));
    const settings = DesktopSettings.load(dir);
    assert.deepEqual(settings.get(), prefs);
    assert.deepEqual(settings.circle(), NO_CIRCLE);
    assert.equal(settings.warning, "");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 3, settings: prefs, circle: NO_CIRCLE });
    const written = readFileSync(file, "utf8");
    const again = DesktopSettings.load(dir);
    assert.deepEqual(again.get(), prefs);
    assert.equal(readFileSync(file, "utf8"), written, "migrated once");
  } finally { done(); }
});

test("set keeps the circle's placement and setCircle keeps the preferences", () => {
  const { dir, file, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir);
    const layout: CircleLayout = { lastChosenDisplayId: "69733382", placements: [placement("69733382", "2026-10-08T10:00:00.000Z")] };
    settings.setCircle(layout);
    assert.deepEqual(settings.get(), DEFAULT_PREFERENCES);
    settings.set({ ...DEFAULT_PREFERENCES, mode: "anti-vibe" });
    assert.deepEqual(settings.circle(), layout, "a preference write keeps the placement");
    settings.setCircle({ ...layout, placements: [placement("69733382", "2026-10-08T11:00:00.000Z", 1, 0)] });
    assert.equal(settings.get().mode, "anti-vibe", "a placement write keeps the preferences");
    const reloaded = DesktopSettings.load(dir);
    assert.equal(reloaded.get().mode, "anti-vibe");
    assert.deepEqual(reloaded.circle().placements[0], placement("69733382", "2026-10-08T11:00:00.000Z", 1, 0));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 3);
    const copy = reloaded.circle();
    copy.placements.length = 0;
    assert.equal(reloaded.circle().placements.length, 1, "circle() hands out copies");
  } finally { done(); }
});

test("a placement outside [0,1], a bad display id or a duplicate display is refused and nothing is written", () => {
  const { dir, file, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir);
    settings.set(DEFAULT_PREFERENCES);
    const saved = readFileSync(file, "utf8");
    const at = "2026-10-08T10:00:00.000Z";
    assert.throws(() => settings.setCircle({ lastChosenDisplayId: null, placements: [placement("1", at, 1.5)] }));
    assert.throws(() => settings.setCircle({ lastChosenDisplayId: "../x", placements: [] }));
    assert.throws(() => settings.setCircle({ lastChosenDisplayId: null, placements: [placement("1", at), placement("1", at)] }));
    assert.throws(() => settings.setCircle({ lastChosenDisplayId: null, placements: [placement("1", "yesterday")] }));
    assert.throws(() => settings.setCircle({ lastChosenDisplayId: null, placements: Array.from({ length: 17 }, (_, i) => placement(String(i), at)) }));
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.deepEqual(settings.circle(), NO_CIRCLE);
  } finally { done(); }
});

test("an unreadable circle layout loads as none and keeps the preferences; the file is left until the next write", () => {
  const { dir, file, done } = scratch();
  try {
    const body = v3({ ...DEFAULT_PREFERENCES, mode: "anti-vibe" }, { lastChosenDisplayId: 7, placements: "everywhere" });
    writeFileSync(file, body);
    const settings = DesktopSettings.load(dir);
    assert.equal(settings.get().mode, "anti-vibe");
    assert.deepEqual(settings.circle(), NO_CIRCLE);
    assert.equal(readFileSync(file, "utf8"), body);
    assert.deepEqual(readdirSync(dir), ["settings.json"], "nothing set aside");
  } finally { done(); }
});

test("one placement per display, at most 16; the least recently user-chosen one goes", () => {
  let layout: CircleLayout = NO_CIRCLE;
  for (let i = 0; i < 16; i++) layout = withPlacement(layout, placement(`d${i}`, `2026-10-08T10:${String(i).padStart(2, "0")}:00.000Z`));
  assert.equal(layout.placements.length, 16);
  assert.equal(layout.lastChosenDisplayId, "d15");
  // Choosing d0 again refreshes it in place: no eviction.
  layout = withPlacement(layout, placement("d0", "2026-10-08T11:00:00.000Z", 0.1, 0.9));
  assert.equal(layout.placements.length, 16);
  assert.deepEqual(layout.placements.find((p) => p.displayId === "d0"), placement("d0", "2026-10-08T11:00:00.000Z", 0.1, 0.9));
  layout = withPlacement(layout, placement("new", "2026-10-08T12:00:00.000Z"));
  assert.equal(layout.placements.length, 16);
  assert.ok(!layout.placements.some((p) => p.displayId === "d1"), "d1 was the least recently chosen");
  assert.ok(layout.placements.some((p) => p.displayId === "d0"));
  assert.equal(layout.lastChosenDisplayId, "new");
});

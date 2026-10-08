import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, type DesktopPreferences } from "../src/desktop/protocol.ts";
import { DesktopSettings } from "../src/desktop/settings.ts";
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

test("a version 1 file migrates in place once: window, workspace, recent and companion fields go, screen advice becomes the look", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, v1({ wizardAdvice: true, wizardSource: "screen" }));
    const settings = DesktopSettings.load(dir);
    const expected: DesktopPreferences = { ...DEFAULT_PREFERENCES, hotkey: "Alt+K", launchAtLogin: true, personalContext: true, look: { apps: true, screen: true } };
    assert.deepEqual(settings.get(), expected);
    assert.equal(settings.warning, "");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored, { version: 2, settings: expected });
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
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).settings.agent, apiKey, "written once");
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
    const body = JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, agent: apiKey } });
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, type DesktopPreferences } from "../src/desktop/protocol.ts";
import { DesktopSettings } from "../src/desktop/settings.ts";
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

const subscription: AgentChoice = {
  backend: "claude",
  login: "claude-subscription",
  intern: { backend: "claude", model: "claude-sonnet-4-5", effort: null },
  helper: { backend: "claude", model: "claude-haiku-4-5", effort: null },
};
const apiKey: AgentChoice = { ...subscription, login: "anthropic-key" };

test("a fresh install uses the defaults, with the look on", () => {
  const { dir, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir, "public");
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
    const settings = DesktopSettings.load(dir, "local");
    const expected: DesktopPreferences = { ...DEFAULT_PREFERENCES, hotkey: "Alt+K", launchAtLogin: true, personalContext: true, look: { apps: true, screen: true } };
    assert.deepEqual(settings.get(), expected);
    assert.equal(settings.warning, "");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored, { version: 2, settings: expected });
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
    assert.deepEqual(readdirSync(dir), ["settings.json"], "rewritten in place, nothing set aside");
    const again = DesktopSettings.load(dir, "local");
    assert.deepEqual(again.get(), expected);
    assert.equal(again.warning, "");
  } finally { done(); }
});

test("saved-file advice maps to no screen look and a notice to follow a folder; advice that was off stays off", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, v1({ wizardAdvice: true, wizardSource: "files" }));
    const files = DesktopSettings.load(dir, "local");
    assert.deepEqual(files.get().look, { apps: true, screen: false });
    assert.match(files.warning, /[Ff]ollow a folder/);

    writeFileSync(file, v1({ wizardAdvice: false, wizardSource: "screen" }));
    const off = DesktopSettings.load(dir, "local");
    assert.deepEqual(off.get().look, { apps: true, screen: false });
    assert.equal(off.warning, "");

    writeFileSync(file, v1({}));
    assert.deepEqual(DesktopSettings.load(dir, "local").get().look, { apps: true, screen: false }, "a file from before screen advice had it off");
  } finally { done(); }
});

test("a public build drops a stored Claude subscription choice; a local build keeps it", () => {
  const { dir, file, done } = scratch();
  try {
    const body = JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, mode: "anti-vibe", agent: subscription } });
    writeFileSync(file, body);
    const local = DesktopSettings.load(dir, "local");
    assert.deepEqual(local.get().agent, subscription);
    assert.equal(local.warning, "");

    const pub = DesktopSettings.load(dir, "public");
    assert.equal(pub.get().agent, null);
    assert.equal(pub.get().mode, "anti-vibe", "the rest of the preferences still load");
    assert.match(pub.warning, /Choose again/);
    assert.equal(readFileSync(file, "utf8"), body, "loading never rewrites a version 2 file");

    assert.throws(() => pub.set({ ...pub.get(), agent: subscription }), /claude-subscription/);
    pub.set({ ...pub.get(), agent: apiKey });
    assert.deepEqual(DesktopSettings.load(dir, "public").get().agent, apiKey);
  } finally { done(); }
});

test("no tokens are accepted: extra fields are refused when set and never loaded from disk", () => {
  const { dir, file, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir, "local");
    settings.set({ ...DEFAULT_PREFERENCES, hotkey: "Alt+J" });
    const saved = readFileSync(file, "utf8");
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, apiKey: "sk-ant-secret" } as DesktopPreferences));
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, agent: { ...apiKey, key: "sk-ant-secret" } as AgentChoice }));
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.equal(settings.get().hotkey, "Alt+J");

    writeFileSync(file, JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, agent: { ...apiKey, token: "sk-ant-secret" } } }));
    const loaded = DesktopSettings.load(dir, "local");
    assert.equal(loaded.get().agent, null);
    assert.doesNotMatch(JSON.stringify(loaded.get()), /sk-ant/);

    writeFileSync(file, JSON.stringify({ version: 2, settings: { ...DEFAULT_PREFERENCES, token: "sk-ant-secret" } }));
    const asideFile = DesktopSettings.load(dir, "local");
    assert.deepEqual(asideFile.get(), DEFAULT_PREFERENCES);
    assert.match(asideFile.warning, /kept as/);
  } finally { done(); }
});

test("an unreadable file is kept aside and defaults are used, never silently overwritten", () => {
  const { dir, file, done } = scratch();
  try {
    writeFileSync(file, "{not json");
    const settings = DesktopSettings.load(dir, "local");
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
    const settings = DesktopSettings.load(dir, "local");
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, voiceHotkey: "Shift+A" }));
    assert.throws(() => settings.set({ ...DEFAULT_PREFERENCES, sendDraftHotkey: "K" }));
    assert.deepEqual(settings.get(), DEFAULT_PREFERENCES);
  } finally { done(); }
});

test("a failed write leaves the previous preferences in force; get() hands out copies", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const { dir, done } = scratch();
  try {
    const settings = DesktopSettings.load(dir, "local");
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

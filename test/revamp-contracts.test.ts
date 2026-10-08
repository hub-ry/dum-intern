import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ZoneRegistrySchema, ZoneContextSchema, ChangeReceiptSchema } from "../src/zone-types.ts";
import { ResourcePathSchema, ShareGrantSchema } from "../src/share-types.ts";
import { LedgerSchema } from "../src/evidence-types.ts";
import { TickSchema } from "../src/observe-types.ts";
import { RequestSchema, DEFAULT_PREFERENCES, DesktopPreferencesSchema } from "../src/desktop/protocol.ts";
import { HostRequestSchema, HostEventSchema } from "../src/desktop/host-protocol.ts";
import { VoiceEventSchema, FocusEventSchema } from "../src/desktop/native-protocol.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-contracts-"));
process.env.DUM_CONTEXT = "off";

// A no-Git fixture: two nested zones under an isolated DUM_HOME.
const home = process.env.DUM_HOME;
const now = new Date().toISOString();
const rootId = randomUUID();
const childId = randomUUID();
const zone = (id: string, parentId: string | null, name: string, goal: string, language: string | null) =>
  ({ id, parentId, name, goal, language, focusSkills: [], createdAt: now, updatedAt: now, deletedAt: null });
const registry = {
  version: 1,
  revision: 2,
  activeZoneId: childId,
  zones: [
    zone(rootId, null, "Programming", "learn to program", "python"),
    zone(childId, rootId, "Data Structures", "understand hash maps", null),
  ],
};
const context = {
  id: childId,
  revision: 2,
  breadcrumb: [{ id: rootId, name: "Programming" }, { id: childId, name: "Data Structures" }],
  goal: "understand hash maps",
  ancestorGoals: [{ id: rootId, goal: "learn to program" }],
  language: "python",
  focusSkills: [{ name: "hash map", lang: "" }],
  notes: [{ id: rootId, name: "Programming", text: "" }, { id: childId, name: "Data Structures", text: "I use vim" }],
};
const binding = { zoneId: childId, zoneEpoch: "e1", inputToken: "t1", requestId: "r1" };
const choice = {
  backend: "claude",
  login: "anthropic-key",
  intern: { backend: "claude", model: "opus", effort: "high" },
  helper: { backend: "claude", model: "fable", effort: "high" },
  look: { backend: "claude", model: "haiku", effort: "low" },
};
/** The Claude subscription login Dum removed: it no longer parses as a login method. */
const subscription = { ...choice, login: "claude-subscription" };
const sha = createHash("sha256").update("x").digest("hex");
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, true, JSON.stringify(value).slice(0, 300));
const bad = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, JSON.stringify(value).slice(0, 300));
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

test("the fixture is two nested zones in a folder with no Git", () => {
  assert.equal(existsSync(join(home, ".git")), false);
  ok(ZoneRegistrySchema, wire(registry));
  ok(ZoneContextSchema, wire(context));
  bad(ZoneRegistrySchema, { ...registry, repoRoot: home });
  bad(ZoneRegistrySchema, { ...registry, zones: [{ ...registry.zones[0], id: rootId.toUpperCase() }] });
  bad(ZoneRegistrySchema, { ...registry, zones: [{ ...registry.zones[0], name: " padded" }] });
});

const goodRequests = [
  { type: "snapshot" },
  { type: "zone-create", zone: { name: "Trees", goal: "learn tries", parentId: childId, language: null, focusSkills: [] }, enter: true },
  { type: "zone-enter", id: rootId, expectedRevision: 2 },
  { type: "zone-update", id: childId, patch: { language: "rust" }, expectedRevision: 2 },
  { type: "zone-context", id: childId, text: "notes", expectedRevision: 2 },
  { type: "draft-set", text: "learn to program", expectedDraftRevision: 0, binding: { ...binding, zoneId: null } },
  { type: "send", binding: { ...binding, zoneId: null }, draftRevision: 1 },
  { type: "send", binding, draftRevision: 3 },
  { type: "respond", binding, decision: { kind: "attest", value: true } },
  { type: "interrupt", binding },
  { type: "panel", panel: "projects" },
  { type: "command", name: "projects", argument: "hash map", binding },
  { type: "share-path", path: "/Users/me/code/main.py", kind: "file", binding },
  { type: "follow-add" },
  { type: "change-revert", changeId: randomUUID(), binding },
  { type: "skill-edit", op: "add", skill: { name: "loops", lang: "python" } },
  { type: "tree-sync", sync: { action: "link", server: "https://dum.example" } },
  { type: "tree-sync", sync: { action: "off" } },
  { type: "settings", settings: DEFAULT_PREFERENCES },
  { type: "settings", settings: { ...DEFAULT_PREFERENCES, agent: choice } },
  { type: "capture-preview", sourceId: "screen:1", binding },
  { type: "look-pause", paused: true },
  { type: "voice-start", binding: { ...binding, zoneId: null } },
  { type: "agent-login", backend: "claude", method: "anthropic-key" },
  { type: "agent-key", backend: "claude", key: "sk-ant-api03-abc" },
  { type: "agent-models", backend: "local", login: "none" },
  { type: "agent-select", choice },
  { type: "show-surface", surface: "command" },
  { type: "quit" },
];

test("real serialized renderer requests pass", () => {
  for (const r of goodRequests) ok(RequestSchema, wire(r));
});

test("renderer requests reject stale, malformed and extra fields", () => {
  bad(RequestSchema, { type: "respond", binding: { ...binding, zoneId: null }, decision: { kind: "attest", value: true } });
  bad(RequestSchema, { type: "command", name: "inspect", argument: "", binding: { ...binding, zoneId: null } });
  bad(RequestSchema, { type: "send", binding: { ...binding, inputToken: "" }, draftRevision: 1 });
  bad(RequestSchema, { type: "send", binding: { ...binding, zoneId: "Programming" }, draftRevision: 1 });
  bad(RequestSchema, { type: "send", binding: { ...binding, root: home }, draftRevision: 1 });
  bad(RequestSchema, { type: "zone-enter", id: rootId, expectedRevision: -1 });
  bad(RequestSchema, { type: "zone-update", id: childId, patch: {}, expectedRevision: 2 });
  bad(RequestSchema, { type: "zone-update", id: childId, patch: { parentId: null }, expectedRevision: 2 });
  bad(RequestSchema, { type: "zone-create", zone: { ...registry.zones[0] }, enter: true });
  bad(RequestSchema, { type: "tree-sync", sync: { action: "link" } });
  bad(RequestSchema, { type: "tree-sync", sync: { action: "link", server: "file:///etc/passwd" } });
});

test("renderer can't supply images, hashes, text to send, or a plan decision", () => {
  const image = { data: "iVBORw0KGgo=", mimeType: "image/png", label: "screen" };
  bad(RequestSchema, { type: "send", binding, draftRevision: 1, image });
  bad(RequestSchema, { type: "send", binding, draftRevision: 1, text: "hi" });
  bad(RequestSchema, { type: "send", binding, draftRevision: 1, sha });
  bad(RequestSchema, { type: "change-revert", changeId: randomUUID(), binding, nextSha: sha });
  bad(RequestSchema, { type: "respond", binding, decision: { kind: "plan", value: true } });
});

test("legacy and removed requests are gone", () => {
  for (const r of [
    { type: "open" }, { type: "choose-project" }, { type: "open-project", root: home }, { type: "git-setup" },
    { type: "course" }, { type: "course", skill: "loops" }, { type: "command", name: "practice", argument: "", binding },
    { type: "command", name: "changes", argument: "", binding }, { type: "open-record", record: "proposal" },
    { type: "open-record", record: "course" }, { type: "runtime-check" }, { type: "runtime-login" },
    { type: "runtime-login-open" }, { type: "runtime-login-code", code: "abc" }, { type: "runtime-login-cancel" },
    { type: "move-companion", dx: 1, dy: 1 }, { type: "toggle-panel" }, { type: "mode", mode: "understand" },
    { type: "agent-login-open" }, { type: "agent-login-code", code: "abcdefgh#12345678" },
    { type: "agent-login", backend: "claude", method: "claude-subscription" },
    { type: "agent-select", choice: subscription },
  ]) bad(RequestSchema, r);
});

test("only agent-key carries a secret", () => {
  for (const r of goodRequests.filter((r) => r.type !== "agent-key")) {
    for (const field of ["key", "token", "apiKey", "secret"]) bad(RequestSchema, { ...wire(r), [field]: "sk-ant-api03-abc" });
  }
  bad(RequestSchema, { type: "agent-key", backend: "chatgpt", key: "sk-abc" });
  bad(RequestSchema, { type: "settings", settings: { ...DEFAULT_PREFERENCES, apiKey: "sk-ant-api03-abc" } });
  bad(RequestSchema, { type: "agent-select", choice: { ...choice, key: "sk-ant-api03-abc" } });
});

test("fresh settings look at apps and the screen, with no backend chosen", () => {
  assert.deepEqual(DEFAULT_PREFERENCES.look, { apps: true, screen: true });
  assert.equal(DEFAULT_PREFERENCES.agent, null);
  ok(DesktopPreferencesSchema, DEFAULT_PREFERENCES);
  ok(DesktopPreferencesSchema, { ...DEFAULT_PREFERENCES, agent: choice });
  bad(DesktopPreferencesSchema, { ...DEFAULT_PREFERENCES, agent: subscription });
  bad(DesktopPreferencesSchema, { ...DEFAULT_PREFERENCES, agent: { backend: "claude", login: "anthropic-key", intern: choice.intern, helper: choice.helper } });
  bad(DesktopPreferencesSchema, { ...DEFAULT_PREFERENCES, hotkey: "D" });
  bad(DesktopPreferencesSchema, { ...DEFAULT_PREFERENCES, wizardAdvice: true });
});

const personal = { path: "", text: "", warning: "" };
const base = { epoch: "e1", id: "q1" };

test("host requests: initialize takes only a valid key-based choice, legacy ops are gone", () => {
  const init = { ...base, op: "initialize", home, claudeExecutable: null, personal };
  ok(HostRequestSchema, { ...init, settings: { ...DEFAULT_PREFERENCES, agent: choice } });
  ok(HostRequestSchema, { ...init, settings: DEFAULT_PREFERENCES });
  bad(HostRequestSchema, { ...init, settings: { ...DEFAULT_PREFERENCES, agent: subscription } });
  bad(HostRequestSchema, { ...init, home: "relative/dir", settings: DEFAULT_PREFERENCES });
  bad(HostRequestSchema, { ...base, op: "agent-select", choice: subscription });
  for (const op of ["open", "wizard-advice", "quip", "wizard-screen", "wizard-screen-cancel"]) bad(HostRequestSchema, { ...base, op });
  bad(HostRequestSchema, { ...base, op: "open", root: home, personal });
});

test("host requests carry bindings, credentials and the look", () => {
  const image = { data: "iVBORw0KGgo=", mimeType: "image/png", label: "screen" };
  const share = { id: randomUUID(), kind: "folder", scope: "request", label: "code", files: [] };
  ok(HostRequestSchema, wire({ ...base, op: "send", binding, text: "why?", shares: [share], image }));
  bad(HostRequestSchema, wire({ ...base, op: "send", binding: { ...binding, zoneId: null }, text: "why?", shares: [] }));
  bad(HostRequestSchema, wire({ ...base, op: "respond", binding, decision: { kind: "plan", value: true } }));
  ok(HostRequestSchema, { ...base, op: "credential", requestId: "c1", value: { value: "sk-ant-api03-abc", expiresAt: null } });
  ok(HostRequestSchema, { ...base, op: "credential", requestId: "c1", value: null });
  ok(HostRequestSchema, { ...base, op: "agent-select", choice: null });
  const tick = { zoneId: childId, epoch: "e1", at: Date.now(), app: { bundleId: "com.apple.Terminal", name: "Terminal", windowId: 4 }, screen: { changedCells: 3 } };
  ok(HostRequestSchema, { ...base, op: "observe-tick", tick });
  bad(HostRequestSchema, { ...base, op: "observe-tick", tick: { ...tick, image } });
  ok(HostRequestSchema, { ...base, op: "observe-frame", checkId: "k1", image: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
  bad(HostRequestSchema, { ...base, op: "observe-frame", checkId: "k1", image: { mimeType: "image/jpeg", data: "iVBORw0KGgo=" } });
  ok(HostRequestSchema, { ...base, op: "change-revert", changeId: randomUUID(), binding: { ...binding, zoneId: null } });
});

test("host events are validated too", () => {
  const state = {
    zoneId: childId, zoneName: "Data Structures", mode: "understand",
    transcript: [
      { kind: "say", id: 1, text: "hi" },
      { kind: "diff", id: 2, path: `${randomUUID()}/main.py`, diff: "+x", outcome: "applied", changeId: randomUUID() },
      { kind: "plan", id: 3, plan: "old", approved: true },
    ],
    prompt: { type: "question", question: "did you write it?", why: "proof", purpose: "attest" },
    busy: false, status: "", stage: { kind: "conversation" }, unlocked: 3,
    models: { intern: { backend: "claude", model: "claude-opus-4-1", effort: "high" }, helper: null, look: null },
  };
  const event = {
    type: "state", epoch: "e1", zoneEpoch: "z1", state, tree: { tracks: [], off: [], count: 0, usableBuilt: 0 }, registry, activeZone: context,
    inputToken: "t1", canAttach: true, shares: [], follows: [], changes: [], look: { status: "watching" },
  };
  ok(HostEventSchema, wire(event));
  ok(HostEventSchema, wire({ ...event, zoneEpoch: null }));
  bad(HostEventSchema, wire({ ...event, zoneEpoch: undefined }));
  bad(HostEventSchema, wire({ ...event, state: { ...state, prompt: { type: "plan", plan: "x" } } }));
  bad(HostEventSchema, wire({ ...event, state: { ...state, repo: home } }));
  ok(HostEventSchema, { type: "reply", epoch: "e1", id: "q1", ok: true, result: { models: [{ id: "m", resolved: "m-1", label: "M", efforts: [], images: false, actions: true, verified: false }] } });
  bad(HostEventSchema, { type: "reply", epoch: "e1", id: "q1", ok: true, result: { secret: "x" } });
  ok(HostEventSchema, { type: "credential-request", epoch: "e1", requestId: "c1", need: "chatgpt-access" });
  bad(HostEventSchema, { type: "credential-request", epoch: "e1", requestId: "c1", need: "chatgpt-refresh" });
  ok(HostEventSchema, { type: "frame-request", epoch: "e1", checkId: "k1" });
  bad(HostEventSchema, { type: "quip", epoch: "e1", text: "hi" });
});

test("voice and focus helper events", () => {
  ok(VoiceEventSchema, { op: "transcript", recordingId: "rec1", binding, text: "hello" });
  bad(VoiceEventSchema, { op: "transcript", recordingId: "rec1", binding, text: "é".repeat(16 * 1024 + 1) });
  bad(VoiceEventSchema, { op: "transcript", recordingId: "rec1", binding, text: "hi", audio: "AAAA" });
  bad(VoiceEventSchema, { op: "transcript", recordingId: "rec1", binding: { ...binding, extra: 1 }, text: "hi" });
  ok(VoiceEventSchema, { op: "ready", version: 1, nonce: "n1", bridgeVersion: "0.2.0", modelReady: true, microphoneStatus: "granted", shortcutStatus: "registered" });
  bad(VoiceEventSchema, { op: "ready", version: 2, nonce: "n1", bridgeVersion: "0.2.0", modelReady: true, microphoneStatus: "granted", shortcutStatus: "registered" });
  bad(VoiceEventSchema, { op: "paste", text: "hi" });
  ok(FocusEventSchema, { op: "frontmost", id: "f1", app: null });
  ok(FocusEventSchema, { op: "captured", id: "f1", handle: "h1" });
  bad(FocusEventSchema, { op: "frontmost", id: "f1", app: { bundleId: "com.apple.Terminal", name: "Terminal", windowId: null, pid: 7 } });
});

test("ticks, resource names, receipts and the ledger", () => {
  const tick = { zoneId: childId, epoch: "e1", at: 1, app: null, screen: null };
  ok(TickSchema, tick);
  bad(TickSchema, { ...tick, screen: { changedCells: -1 } });
  bad(TickSchema, { ...tick, screen: { changedCells: 64 * 40 + 1 } });
  const grant = randomUUID();
  ok(ResourcePathSchema, `${grant}/src/main.py`);
  for (const p of [`${grant}/../etc/passwd`, `${grant}//a`, `/abs/path`, "new/file.py", `${grant}`, `${grant}/a\\b`]) bad(ResourcePathSchema, p);
  bad(ShareGrantSchema, { id: grant, kind: "folder", scope: "request", label: "x", files: [`${grant}/../x`] });
  const receipt = { id: randomUUID(), zoneId: childId, target: `${grant}/a.py`, baseSha: null, nextSha: sha, diff: "+a", appliedAt: now, revertible: true };
  ok(ChangeReceiptSchema, receipt);
  bad(ChangeReceiptSchema, { ...receipt, absolute: "/Users/me/a.py" });
  const proof = { id: randomUUID(), zoneId: childId, zoneName: "Data Structures", at: now, kind: "build", skill: "loops", lang: "python", ok: true, why: "built" };
  ok(LedgerSchema, { version: 2, held: ["loops@python"], records: [proof] });
  bad(LedgerSchema, { version: 2, held: ["a", "a"], records: [] });
  bad(LedgerSchema, { version: 2, held: [], records: [{ ...proof, kind: "course" }] });
});

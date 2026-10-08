import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ZoneRegistrySchema, ZoneContextSchema, ChangeReceiptSchema } from "../src/zone-types.ts";
import { ResourcePathSchema, ShareGrantSchema } from "../src/share-types.ts";
import { LedgerSchema } from "../src/evidence-types.ts";
import { LookStatusViewSchema, TickSchema } from "../src/observe-types.ts";
import {
  AlignmentAttemptSchema, ContextCorrectionsSchema, ContextListSchema, ContextUsePageSchema, ContextUseViewSchema, DecisionInputSchema,
  DecisionResultSchema, DecisionViewSchema, DirectionHeadSchema, DirectionInputSchema, DirectionSchema, DirectionViewSchema, HandoffHeadSchema,
  HandoffInputSchema, HandoffResultSchema, HandoffSchema, HandoffViewSchema,
} from "../src/delegation-types.ts";
import {
  EventPageSchema, SessionIndexPageSchema, SessionIndexSchema, SessionMetaSchema, StoryCachePageSchema, StoryHeadSchema, StoryPageSchema,
  TopicHintsSchema, TrailEventSchema, TrailPageSchema, TrailSourceInputSchema, TrailSourceSchema, TrailViewSchema,
} from "../src/trail-types.ts";
import {
  DIAGNOSTIC_ACTIONS, DiagnosticActionSchema, DiagnosticEventSchema, DiagnosticEventsPageSchema, DiagnosticStatusSchema, DebugViewSchema,
  MainStatusSchema, SanitizedMainEventsSchema,
} from "../src/diagnostic-types.ts";
import {
  CircleDisplaysSchema, CircleReplySchema, CircleRequestSchema, CircleViewSchema, DEFAULT_PREFERENCES, DesktopPreferencesSchema, RequestSchema,
  parseRequest,
} from "../src/desktop/protocol.ts";
import { HostRequestSchema, HostEventSchema, HostResultSchema } from "../src/desktop/host-protocol.ts";
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
const goalHash = createHash("sha256").update("understand hash maps").digest("hex");
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, true, JSON.stringify(value).slice(0, 300));
const bad = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, JSON.stringify(value).slice(0, 300));
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const personal = { path: "", text: "", warning: "" };
/** Host request envelope. */
const base = { epoch: "e1", id: "q1" };

// ---- Delegation fixtures: one zone's alignment, a decision card, a handoff and what Dum used.
const grant = randomUUID();
const skill = { name: "hash map", lang: "python" };
const ref = { id: randomUUID(), kind: "goal", label: "Your goal", revision: sha, at: now, excerpt: "understand hash maps" };
const note = { id: randomUUID(), kind: "zone-note", label: "Data Structures notes", revision: sha, at: null, excerpt: "I use vim" };
const option = {
  id: randomUUID(), kind: "project", title: "Build a word counter", builds: [skill],
  advancesGoal: "Counting words is the classic hash map job.", contextIds: [ref.id], tradeoff: "Small, but only one operation.",
};
const question = { id: randomUUID(), text: "Python or C++?", changesPlan: "It decides which skills the gate checks.", answer: null };
const attempt = {
  id: randomUUID(), goalHash, contextRevision: sha, phase: "choose", reflection: "You want to use hash maps without looking things up.",
  questions: [question], options: [option], context: [ref, note],
};
const alignment = { zoneId: childId, zoneRevision: 2, goalHash, attemptId: attempt.id, directionRevision: 0, contextRevision: sha };
const direction = {
  version: 1, id: randomUUID(), zoneId: childId, at: now, goal: "understand hash maps", goalHash, contextRevision: sha, supersedes: null,
  ability: "Pick and use a dict for counting and lookup.", choice: option, reviewCriterion: "The counter is correct on a sample file.",
  assumptions: ["Python 3"], context: [ref],
};
const directionView = { zoneId: childId, goalHash, status: "aligning", current: null, attempt, binding: alignment, contextChanged: false };
const delegate = {
  id: randomUUID(), task: "Write the CLI argument parsing for the counter", expectedResult: "`count.py file.txt` reads the file",
  review: "Run it on a missing file", skills: [{ name: "argparse", lang: "python" }], advancesOutcome: "Frees you to write the counting.",
  contextIds: [ref.id], tradeoff: "You won't practise argparse.", eligibility: "can-delegate", blockers: [],
};
const learn = { ...delegate, id: randomUUID(), task: "Write the counting loop", eligibility: "learn-first", blockers: ["Build `dict` first: project p1"] };
const decision = {
  id: randomUUID(), revision: 1, outcome: "a word counter I understand", contextRevision: sha, directionId: direction.id,
  reflection: "You want the counting to be yours.", questions: [], options: [delegate, learn], context: [ref],
};
const sessionId = randomUUID();
const handoff = {
  version: 1, id: randomUUID(), revision: 1, zoneId: childId, sessionId, directionId: direction.id, goalHash, contextRevision: sha,
  outcome: decision.outcome, task: delegate.task, expectedResult: delegate.expectedResult, review: delegate.review, skills: delegate.skills,
  targets: [`${grant}/count.py`], context: [ref],
};
const head = { version: 1, id: handoff.id, revision: 1, requestId: null, state: "ready", changeIds: [], result: "", reviewed: null };
const handoffView = { handoff, head, needsRefresh: false, blockers: [] };
const contextUse = { subject: { kind: "decision", id: decision.id }, contextRevision: sha, correctionRevision: 0, counts: { used: 1, omitted: 1, missing: 0, stale: 0 }, cursor: "c1" };
const contextPage = { items: [{ ref, status: "used" }, { ref: note, status: "omitted" }], next: null };

// ---- Trail fixtures.
const step = {
  id: randomUUID(), skill, firstSeenAt: now, lastSeenAt: now, directionId: direction.id, origin: "look", mapping: "exact",
  topic: "hash maps", reason: "dict literal on screen", sourceIds: [randomUUID()], revisitOf: null,
};
const meta = {
  version: 1, id: sessionId, zoneId: childId, zoneName: "Data Structures", goal: "understand hash maps", directionId: direction.id,
  startedAt: now, endedAt: null, endReason: null, lastActivityAt: now, revision: 3, eventPages: 1, eventCount: 3,
  latestObservation: { sourceId: step.sourceIds[0]!, text: "They're writing a dict-based counter.", at: now },
};
const events = [
  { seq: 0, at: now, kind: "direction", directionId: direction.id, previousId: null },
  { seq: 1, at: now, kind: "visit", step },
  { seq: 2, at: now, kind: "gap", id: randomUUID(), topic: "Big-O", sourceId: randomUUID() },
  { seq: 3, at: now, kind: "handoff", handoffId: handoff.id, revision: 1, phase: "commanded", directionId: direction.id, sourceIds: [] },
];
const evidenceId = randomUUID();
const proof = { id: evidenceId, zoneId: childId, zoneName: "Data Structures", at: now, kind: "build", skill: "dict", lang: "python", ok: true, why: "built", unaided: true };
const source = {
  version: 1, id: randomUUID(), sessionId, at: now, kind: "evidence", excerpt: "built a counter", entryId: 4, requestId: "r1",
  evidenceId, changeId: null, handoffId: null, proof,
};
const row = {
  sessionId, zoneId: childId, startedAt: now, endedAt: null, directionId: direction.id, sourceRevision: 3, visits: 1, gaps: 1,
  handoffsDone: 0, handoffsReviewed: 0, preview: [skill], previewMore: 0,
};
const trailView = { sessionId, zoneId: childId, directionId: direction.id, visits: [step], markers: [events[0], events[3]], gaps: [events[2]], eventCount: 4 };

// ---- Look, diagnostics and debug fixtures.
const hostLook = {
  status: "watching", reason: "unchanged", noPictures: "", seen: { text: "They're writing a counter.", sourceId: step.sourceIds[0]!, at: now, stale: false },
  lastTick: now, lastAttempt: now, lastSuccess: now, chosen: choice.look, resolved: "claude-haiku-5-5",
};
const look = { ...hostLook, paused: false, permission: "granted" };
const debugBinding = { debugSessionId: randomUUID(), debugEpoch: "d1", requestId: "q9" };
const debugView = { binding: debugBinding, state: "idle", entries: [{ id: 0, from: "you", text: "which look model is running?" }, { id: 1, from: "dum", text: "haiku" }], dropped: 0, expiresAt: now };
const mainStatus = {
  version: "0.9.0", platform: "darwin", backends: [{ id: "claude", installed: true, ready: "anthropic-key" }], screenPermission: "granted",
  lookPaused: false, voice: { supported: true, available: true, bridge: true }, shortcuts: { open: null, voice: "conflict", sendDraft: null },
};
const mainEvent = { kind: "settings", role: null, requestId: null, checkId: null, outcome: "ok", reason: "settings-change", latencyMs: null, httpStatus: null };
const diagEvent = { seq: 7, at: Date.now(), kind: "call-end", role: "look", requestId: null, checkId: "k1", outcome: "failed", reason: "timeout", latencyMs: 45000, httpStatus: null };
const counters = { started: 3, ok: 2, failed: 1, timedOut: 1, lastLatencyMs: 900, inputTokens: null, outputTokens: null };
const status = {
  main: mainStatus,
  settings: { launchAtLogin: false, personalContext: false, look: { apps: true, screen: true }, mode: "understand", hotkey: "CommandOrControl+Shift+D", voiceHotkey: "Control+Option+Space", sendDraftHotkey: "CommandOrControl+Shift+Return" },
  models: { intern: { chosen: choice.intern, resolved: "claude-opus-5-5" }, helper: { chosen: choice.helper, resolved: null }, look: { chosen: choice.look, resolved: "claude-haiku-5-5" } },
  look: { status: "watching", reason: "unchanged", lastTick: now, lastAttempt: now, lastSuccess: null, pending: 0, inflight: 0 },
  calls: { intern: counters, helper: counters, look: counters, debug: counters },
  ring: { events: 1, bytes: 200, oldestSeq: 7, newestSeq: 7, maxEvents: 500, maxBytes: 524288, maxAgeMs: 1800000 },
};

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
  { type: "view", view: "projects" },
  { type: "view", view: "story" },
  { type: "command", name: "projects", argument: "hash map", binding },
  { type: "share-path", path: "/Users/me/code/main.py", kind: "file", binding },
  { type: "follow-add" },
  { type: "change-revert", changeId: randomUUID(), binding },
  { type: "open-record", record: "memory" },
  { type: "open-record", record: "change", id: randomUUID() },
  { type: "open-record", record: "personal", sourceId: randomUUID() },
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
  // Goal alignment, decisions and handoffs.
  { type: "alignment-read", zoneId: childId },
  { type: "alignment-step", binding: alignment, action: "start" },
  { type: "alignment-step", binding: alignment, action: "answer", questionId: question.id, text: "Python" },
  { type: "alignment-step", binding: alignment, action: "defer" },
  { type: "alignment-accept", binding: alignment, choiceId: option.id, ability: direction.ability, reviewCriterion: direction.reviewCriterion, assumptions: ["Python 3"] },
  { type: "alignment-accept", binding: alignment, choiceId: null, ability: "a", reviewCriterion: "r", assumptions: [], ownDirection: { ...option, id: randomUUID(), title: "My own plan" } },
  { type: "direction-read", zoneId: childId, directionId: direction.id },
  { type: "decision-help", binding, outcome: "a word counter I understand" },
  { type: "decision-dismiss", binding, decisionId: decision.id, revision: 1 },
  { type: "handoff-select", binding, decisionId: decision.id, revision: 1, optionId: delegate.id },
  { type: "handoff-edit", binding, handoffId: handoff.id, revision: 1, patch: { review: "Run it on an empty file too" } },
  { type: "handoff-dismiss", binding, handoffId: handoff.id, revision: 1 },
  { type: "handoff-run", binding, handoffId: handoff.id, revision: 1, draftRevision: 4 },
  { type: "handoff-read", zoneId: childId, handoffId: handoff.id },
  { type: "handoff-review", binding, handoffId: handoff.id, revision: 2, verdict: "did not advance the goal" },
  // Current context, sessions, trail and story.
  { type: "context-use-read", binding, cursor: null },
  { type: "context-use-read", binding, cursor: "c1" },
  { type: "context-reload", binding },
  { type: "context-ignore-observation", binding, sourceId: step.sourceIds[0], expectedCorrectionRevision: 0 },
  { type: "session-new", binding },
  { type: "trail-read", zoneId: childId, sessionId, cursor: null },
  { type: "trail-source", zoneId: childId, sessionId, sourceId: source.id },
  { type: "trail-map", binding, sessionId, gapId: events[2]!.id, skill },
  { type: "story-read", zoneId: null, skill: null, from: null, to: null, cursor: null },
  { type: "story-read", zoneId: childId, skill, from: now, to: now, cursor: "p2" },
  // Debug chat.
  { type: "debug-open" },
  { type: "debug-send", binding: debugBinding, text: "which look model is running?" },
  { type: "debug-stop", binding: debugBinding },
  { type: "debug-reset" },
  // Move circle, the window, quit.
  { type: "circle-position", action: "begin" },
  { type: "circle-nudge", dx: -10, dy: 0 },
  { type: "circle-nudge", dx: 0, dy: 1 },
  { type: "circle-display", displayId: "69733382" },
  { type: "show-surface", surface: "window" },
  { type: "dismiss-surface", surface: "window" },
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
  bad(RequestSchema, { type: "view", view: "wizard" });
  bad(RequestSchema, { type: "open-record", record: "personal", path: "/Users/me/context.md" });
  bad(RequestSchema, { type: "open-record", record: "personal", sourceId: randomUUID(), id: randomUUID() });
  bad(RequestSchema, { type: "open-record", record: "memory", sourceId: randomUUID() });
});

test("alignment requests: strict step variants, exactly one accepted direction", () => {
  bad(RequestSchema, { type: "alignment-step", binding: alignment, action: "answer" });
  bad(RequestSchema, { type: "alignment-step", binding: alignment, action: "answer", questionId: question.id, text: "   " });
  bad(RequestSchema, { type: "alignment-step", binding: alignment, action: "start", questionId: question.id });
  bad(RequestSchema, { type: "alignment-step", binding: alignment, action: "revise", text: "x" });
  bad(RequestSchema, { type: "alignment-step", binding: alignment, action: "accept" });
  bad(RequestSchema, { type: "alignment-step", binding: { ...alignment, goalHash: "old goal" }, action: "start" });
  const accept = { type: "alignment-accept", binding: alignment, choiceId: option.id, ability: "a", reviewCriterion: "r", assumptions: [] };
  bad(RequestSchema, { ...accept, choiceId: null });
  bad(RequestSchema, { ...accept, ownDirection: option });
  bad(RequestSchema, { ...accept, ability: "" });
  bad(RequestSchema, { ...accept, assumptions: Array.from({ length: 9 }, (_, i) => `a${i}`) });
  bad(RequestSchema, { ...accept, reviewCriterion: "é".repeat(1025) });
  bad(RequestSchema, { type: "direction-read", zoneId: childId, directionId: direction.id, binding });
});

test("inactive-zone alignment can't carry active grants", () => {
  // Alignment is bound to its own zone's goal and revisions, never to the active zone's input.
  bad(RequestSchema, { type: "alignment-step", binding, action: "start" });
  bad(RequestSchema, { type: "alignment-step", binding: { ...alignment, inputToken: "t1" }, action: "start" });
  const fields = { binding: alignment, choiceId: option.id, ability: "a", reviewCriterion: "r", assumptions: [] };
  const accept = { type: "alignment-accept", ...fields };
  const hostAccept = { ...base, op: "alignment-accept", ...fields };
  ok(RequestSchema, accept);
  ok(HostRequestSchema, hostAccept);
  bad(HostRequestSchema, { ...hostAccept, choiceId: null });
  bad(HostRequestSchema, { ...hostAccept, ownDirection: option });
  const share = { id: grant, kind: "folder", scope: "zone", label: "code", files: [] };
  for (const extra of [{ shares: [share] }, { image: { data: "iVBORw0KGgo=", mimeType: "image/png", label: "screen" } }, { draftRevision: 1 }, { inputToken: "t1" }]) {
    bad(RequestSchema, { ...accept, ...extra });
    bad(HostRequestSchema, { ...hostAccept, ...extra });
    bad(HostRequestSchema, { ...base, op: "alignment-step", binding: alignment, action: "start", ...extra });
  }
  // zone-create replies with the target zone's alignment; the state event never carries another zone's.
  ok(HostResultSchema, wire({ zone: registry.zones[0], direction: { ...directionView, zoneId: childId } }));
});

test("decision and handoff requests write nothing and handoff-run requires draftRevision", () => {
  const run = { type: "handoff-run", binding, handoffId: handoff.id, revision: 1, draftRevision: 4 };
  const { draftRevision: _drop, ...noDraft } = run;
  bad(RequestSchema, noDraft);
  bad(RequestSchema, { ...run, draftRevision: -1 });
  bad(RequestSchema, { ...run, binding: { ...binding, zoneId: null } });
  bad(RequestSchema, { ...run, text: "do it" });
  bad(RequestSchema, { ...run, shares: [] });
  bad(RequestSchema, { type: "handoff-select", binding, decisionId: decision.id, revision: 1, optionId: delegate.id, draftRevision: 4 });
  bad(RequestSchema, { type: "handoff-select", binding, decisionId: decision.id, revision: 1, optionId: delegate.id, shares: [] });
  bad(RequestSchema, { type: "handoff-edit", binding, handoffId: handoff.id, revision: 1, patch: {} });
  bad(RequestSchema, { type: "handoff-edit", binding, handoffId: handoff.id, revision: 1, patch: { targets: ["/etc/passwd"] } });
  bad(RequestSchema, { type: "handoff-edit", binding, handoffId: handoff.id, revision: 1, patch: { task: "" } });
  bad(RequestSchema, { type: "handoff-review", binding, handoffId: handoff.id, revision: 2, verdict: "" });
  bad(RequestSchema, { type: "handoff-review", binding, handoffId: handoff.id, revision: 2, verdict: "ok", evidence: true });
  bad(RequestSchema, { type: "decision-help", binding, outcome: "" });
  bad(RequestSchema, { type: "decision-help", binding: { ...binding, zoneId: null }, outcome: "x" });
  bad(RequestSchema, { type: "decision-help", binding, outcome: "x", moment: "alignment" });
  bad(RequestSchema, { type: "handoff-read", zoneId: childId, handoffId: handoff.id, binding });
});

test("context, trail and story requests are bounded; history confers nothing", () => {
  bad(RequestSchema, { type: "context-use-read", binding, cursor: "../../etc/passwd" });
  bad(RequestSchema, { type: "context-use-read", binding, cursor: "c".repeat(513) });
  bad(RequestSchema, { type: "context-reload", binding, personal: { path: "/x", text: "", warning: "" } });
  bad(RequestSchema, { type: "context-ignore-observation", binding, sourceId: "latest", expectedCorrectionRevision: 0 });
  bad(RequestSchema, { type: "context-ignore-observation", binding, sourceId: randomUUID() });
  bad(RequestSchema, { type: "session-new", binding: { ...binding, zoneId: null } });
  bad(RequestSchema, { type: "trail-read", zoneId: childId, sessionId, cursor: null, binding });
  bad(RequestSchema, { type: "trail-source", zoneId: childId, sessionId, sourceId: "/tmp/source.json" });
  bad(RequestSchema, { type: "trail-map", sessionId, gapId: events[2]!.id, skill });
  bad(RequestSchema, { type: "story-read", zoneId: null, skill: null, from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z", cursor: null });
  bad(RequestSchema, { type: "story-read", zoneId: null, skill: null, from: null, to: null });
});

test("renderer can't supply images, hashes, text to send, or a plan decision", () => {
  const image = { data: "iVBORw0KGgo=", mimeType: "image/png", label: "screen" };
  bad(RequestSchema, { type: "send", binding, draftRevision: 1, image });
  bad(RequestSchema, { type: "send", binding, draftRevision: 1, text: "hi" });
  bad(RequestSchema, { type: "send", binding, draftRevision: 1, sha });
  bad(RequestSchema, { type: "change-revert", changeId: randomUUID(), binding, nextSha: sha });
  bad(RequestSchema, { type: "respond", binding, decision: { kind: "plan", value: true } });
});

test("legacy, panel, command-bar and tray requests are gone", () => {
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
    { type: "panel", panel: "projects" }, { type: "show-surface", surface: "panel" }, { type: "show-surface", surface: "command" },
    { type: "dismiss-surface", surface: "command" }, { type: "dismiss-surface", surface: "panel" }, { type: "show-surface", surface: "circle" },
    { type: "wizard-aside" }, { type: "wizard-advice", value: true },
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

test("the bubble never invokes and the circle only sends gestures, toggles and reads its view", () => {
  const circleGood = [
    { type: "circle-press", phase: "begin" },
    { type: "circle-press", phase: "end", gestureId: "g1" },
    { type: "circle-press", phase: "cancel", gestureId: "g1" },
    { type: "circle-toggle" },
    { type: "circle-view" },
  ];
  for (const r of circleGood) {
    ok(CircleRequestSchema, r);
    assert.equal(parseRequest("circle", wire(r)).role, "circle");
    assert.throws(() => parseRequest("window", wire(r)));
    assert.throws(() => parseRequest("bubble", wire(r)), /bubble/);
  }
  for (const r of goodRequests) {
    assert.equal(parseRequest("window", wire(r)).role, "window");
    assert.throws(() => parseRequest("circle", wire(r)));
    assert.throws(() => parseRequest("bubble", wire(r)), /bubble/);
  }
  bad(CircleRequestSchema, { type: "circle-press", phase: "begin", gestureId: "g1" });
  bad(CircleRequestSchema, { type: "circle-press", phase: "end" });
  bad(CircleRequestSchema, { type: "circle-press", phase: "begin", x: 10, y: 20 });
  bad(CircleRequestSchema, { type: "circle-press", phase: "move", gestureId: "g1" });
  bad(CircleRequestSchema, { type: "circle-toggle", settings: DEFAULT_PREFERENCES });
  // Window circle controls: one axis, 1 or 10 DIP, a display by id; never coordinates.
  bad(RequestSchema, { type: "circle-nudge", dx: 10, dy: 10 });
  bad(RequestSchema, { type: "circle-nudge", dx: 0, dy: 0 });
  bad(RequestSchema, { type: "circle-nudge", dx: 5, dy: 0 });
  bad(RequestSchema, { type: "circle-position", action: "commit", x: 100, y: 200 });
  bad(RequestSchema, { type: "circle-display", displayId: "../1" });
  bad(RequestSchema, { type: "circle-display", displayId: "1", u: 0.5, v: 0.5 });
});

test("circle view, replies and display choices are typed", () => {
  const view = { state: "attention", reason: "decision", paused: false, open: false };
  ok(CircleViewSchema, view);
  ok(CircleViewSchema, { state: "idle", reason: "look-paused", paused: true, open: true });
  bad(CircleViewSchema, { state: "idle", reason: "look-paused", paused: false, open: true });
  bad(CircleViewSchema, { state: "thinking", reason: "decision", paused: false, open: false });
  bad(CircleViewSchema, { ...view, status: "Dum needs a decision" });
  bad(CircleViewSchema, { ...view, transcript: [] });
  ok(CircleReplySchema, { ok: true, view, gesture: { gestureId: "g1" } });
  ok(CircleReplySchema, { ok: false, error: "no display" });
  bad(CircleReplySchema, { ok: true, view, snapshot: {} });
  bad(CircleReplySchema, { ok: true });
  ok(CircleDisplaysSchema, { displays: [{ id: "1", label: "Built-in Retina Display", primary: true, current: true }, { id: "2", label: "Studio Display", primary: false, current: false }], positioning: false });
  bad(CircleDisplaysSchema, { displays: [{ id: "1", label: "A", primary: true, current: true, bounds: { x: 0, y: 0, width: 1, height: 1 } }], positioning: false });
  bad(CircleDisplaysSchema, { displays: [{ id: "1", label: "A", primary: true, current: true }, { id: "2", label: "B", primary: false, current: true }], positioning: true });
});

test("the debug channel can't reach zone operations", () => {
  // Debug has its own binding; a zone binding can't drive it and its binding can't drive zone work.
  bad(RequestSchema, { type: "debug-send", binding, text: "hi" });
  bad(RequestSchema, { type: "send", binding: debugBinding, draftRevision: 1 });
  bad(RequestSchema, { type: "interrupt", binding: debugBinding });
  bad(RequestSchema, { type: "handoff-run", binding: debugBinding, handoffId: handoff.id, revision: 1, draftRevision: 1 });
  bad(RequestSchema, { type: "debug-send", binding: { ...debugBinding, zoneId: childId }, text: "hi" });
  bad(RequestSchema, { type: "debug-send", binding: debugBinding, text: "" });
  bad(RequestSchema, { type: "debug-send", binding: debugBinding, text: "é".repeat(4097) });
  bad(RequestSchema, { type: "debug-send", binding: debugBinding, text: "hi", shares: [] });
  bad(RequestSchema, { type: "debug-open", zoneId: childId });
  bad(RequestSchema, { type: "debug-action", name: "diagnostic_status", args: {} });
  bad(HostRequestSchema, { epoch: "e1", id: "q1", op: "debug-send", binding, text: "hi" });
  bad(HostRequestSchema, { epoch: "e1", id: "q1", op: "debug-send", binding: debugBinding, text: "hi", zoneId: childId });
  bad(HostRequestSchema, { epoch: "e1", id: "q1", op: "send", binding: debugBinding, text: "hi", shares: [] });
  // The model's closure is exactly three bounded reads; every writer and unknown action is refused.
  assert.deepEqual(Object.keys(DIAGNOSTIC_ACTIONS).sort(), ["diagnostic_events", "diagnostic_reference", "diagnostic_status"]);
  ok(DiagnosticActionSchema, { name: "diagnostic_status", args: {} });
  ok(DiagnosticActionSchema, { name: "diagnostic_events", args: { limit: 50, kinds: ["call-end"] } });
  ok(DiagnosticActionSchema, { name: "diagnostic_reference", args: { topic: "models" } });
  for (const name of ["change", "remember", "skill-edit", "settings", "follow-add", "read_file", "decision_help", "report_context", "alignment-accept", "handoff-run", "handoff-review", "shell", "wizard_aside", "unknown"]) {
    bad(DiagnosticActionSchema, { name, args: {} });
  }
  bad(DiagnosticActionSchema, { name: "diagnostic_events", args: { limit: 51 } });
  bad(DiagnosticActionSchema, { name: "diagnostic_reference", args: { topic: "/etc/passwd" } });
  bad(DiagnosticActionSchema, { name: "diagnostic_status", args: { zoneId: childId } });
});

test("host requests: initialize takes only a valid key-based choice and main's sanitized status, legacy ops are gone", () => {
  const init = { ...base, op: "initialize", home, claudeExecutable: null, personal, main: mainStatus };
  ok(HostRequestSchema, { ...init, settings: { ...DEFAULT_PREFERENCES, agent: choice } });
  ok(HostRequestSchema, { ...init, settings: DEFAULT_PREFERENCES });
  bad(HostRequestSchema, { ...init, settings: { ...DEFAULT_PREFERENCES, agent: subscription } });
  bad(HostRequestSchema, { ...init, home: "relative/dir", settings: DEFAULT_PREFERENCES });
  bad(HostRequestSchema, { ...init, main: undefined, settings: DEFAULT_PREFERENCES });
  bad(HostRequestSchema, { ...init, main: { ...mainStatus, apiKey: "sk-ant-api03-abc" }, settings: DEFAULT_PREFERENCES });
  bad(HostRequestSchema, { ...base, op: "agent-select", choice: subscription });
  for (const op of ["open", "wizard-advice", "quip", "wizard-screen", "wizard-screen-cancel", "wizard-aside", "panel"]) bad(HostRequestSchema, { ...base, op });
  bad(HostRequestSchema, { ...base, op: "panel", panel: "projects" });
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
  ok(HostRequestSchema, { ...base, op: "view", view: "settings" });
  ok(HostRequestSchema, { ...base, op: "open-record", record: "personal", sourceId: randomUUID() });
  bad(HostRequestSchema, { ...base, op: "open-record", record: "personal", path: "/Users/me/context.md" });
});

test("host ops mirror every new request", () => {
  const share = { id: grant, kind: "folder", scope: "request", label: "code", files: [`${grant}/count.py`] };
  const goodOps = [
    { op: "alignment-read", zoneId: childId },
    { op: "alignment-step", binding: alignment, action: "answer", questionId: question.id, text: "Python" },
    { op: "alignment-step", binding: alignment, action: "revise" },
    { op: "alignment-accept", binding: alignment, choiceId: null, ability: "a", reviewCriterion: "r", assumptions: [], ownDirection: option },
    { op: "direction-read", zoneId: childId, directionId: direction.id },
    { op: "decision-help", binding, outcome: decision.outcome },
    { op: "decision-dismiss", binding, decisionId: decision.id, revision: 1 },
    { op: "handoff-select", binding, decisionId: decision.id, revision: 1, optionId: delegate.id },
    { op: "handoff-edit", binding, handoffId: handoff.id, revision: 1, patch: { task: "Parse args" } },
    { op: "handoff-dismiss", binding, handoffId: handoff.id, revision: 1 },
    { op: "handoff-run", binding, handoffId: handoff.id, revision: 1, shares: [share] },
    { op: "handoff-run", binding, handoffId: handoff.id, revision: 1, shares: [], image: { data: "iVBORw0KGgo=", mimeType: "image/png", label: "screen" } },
    { op: "handoff-read", zoneId: childId, handoffId: handoff.id },
    { op: "handoff-review", binding, handoffId: handoff.id, revision: 2, verdict: "done as expected" },
    { op: "context-use-read", binding, cursor: "c1" },
    { op: "context-reload", binding, personal },
    { op: "context-ignore-observation", binding, sourceId: step.sourceIds[0], expectedCorrectionRevision: 0 },
    { op: "session-new", binding },
    { op: "trail-read", zoneId: childId, sessionId, cursor: "p1" },
    { op: "trail-source", zoneId: childId, sessionId, sourceId: source.id },
    { op: "trail-map", binding, sessionId, gapId: events[2]!.id, skill },
    { op: "story-read", zoneId: null, skill, from: null, to: null, cursor: null },
    { op: "debug-open" },
    { op: "debug-send", binding: debugBinding, text: "is the look paused?" },
    { op: "debug-stop", binding: debugBinding },
    { op: "debug-reset" },
    { op: "diagnostic-main", events: [mainEvent], status: mainStatus },
    { op: "diagnostic-main", events: [], status: null },
  ];
  for (const o of goodOps) ok(HostRequestSchema, wire({ ...base, ...o }));
  // handoff-run carries main's grants as send does; the draft revision stays with main.
  bad(HostRequestSchema, { ...base, op: "handoff-run", binding, handoffId: handoff.id, revision: 1, shares: [], draftRevision: 4 });
  bad(HostRequestSchema, { ...base, op: "handoff-run", binding, handoffId: handoff.id, revision: 1 });
  bad(HostRequestSchema, { ...base, op: "handoff-select", binding, decisionId: decision.id, revision: 1, optionId: delegate.id, shares: [] });
  bad(HostRequestSchema, { ...base, op: "context-reload", binding });
  bad(HostRequestSchema, { ...base, op: "alignment-step", binding: alignment, action: "start", questionId: question.id });
  // Main's diagnostics are sanitized and bounded; it reports no requests and the host assigns seq/time.
  bad(HostRequestSchema, { ...base, op: "diagnostic-main", events: Array.from({ length: 21 }, () => mainEvent), status: null });
  bad(HostRequestSchema, { ...base, op: "diagnostic-main", events: [{ ...mainEvent, seq: 1, at: 1 }], status: null });
  bad(HostRequestSchema, { ...base, op: "diagnostic-main", events: [{ ...mainEvent, kind: "call-end" }], status: null });
  bad(HostRequestSchema, { ...base, op: "diagnostic-main", events: [{ ...mainEvent, requestId: "r1" }], status: null });
  bad(HostRequestSchema, { ...base, op: "diagnostic-main", events: [{ ...mainEvent, message: "401 invalid x-api-key sk-ant-…" }], status: null });
  bad(HostRequestSchema, { ...base, op: "diagnostic-main", events: [{ ...mainEvent, reason: "Unauthorized" }], status: null });
});

const state = {
  zoneId: childId, zoneName: "Data Structures", mode: "understand",
  transcript: [
    { kind: "say", id: 1, text: "hi" },
    { kind: "diff", id: 2, path: `${randomUUID()}/main.py`, diff: "+x", outcome: "applied", changeId: randomUUID() },
    { kind: "plan", id: 3, plan: "old", approved: true },
    { kind: "quip", id: 4, text: "a historical Wizard line stays readable" },
  ],
  prompt: { type: "question", question: "did you write it?", why: "proof", purpose: "attest" },
  busy: false, status: "", stage: { kind: "conversation" }, unlocked: 3,
  models: { intern: { backend: "claude", model: "claude-opus-4-1", effort: "high" }, helper: null, look: null },
};
const stateEvent = {
  type: "state", epoch: "e1", zoneEpoch: "z1", state, tree: { tracks: [], off: [], count: 0, usableBuilt: 0 }, registry, activeZone: context,
  inputToken: "t1", canAttach: true, shares: [], follows: [], changes: [], look: hostLook,
  direction: directionView, decision, handoff: handoffView, contextUse, session: meta, trail: trailView,
};

test("host events are validated too", () => {
  ok(HostEventSchema, wire(stateEvent));
  ok(HostEventSchema, wire({ ...stateEvent, zoneEpoch: null }));
  ok(HostEventSchema, wire({ ...stateEvent, activeZone: null, state: null, direction: null, decision: null, handoff: null, session: null, trail: null, contextUse: { ...contextUse, subject: null, contextRevision: null, cursor: null } }));
  bad(HostEventSchema, wire({ ...stateEvent, zoneEpoch: undefined }));
  bad(HostEventSchema, wire({ ...stateEvent, state: { ...state, prompt: { type: "plan", plan: "x" } } }));
  bad(HostEventSchema, wire({ ...stateEvent, state: { ...state, repo: home } }));
  bad(HostEventSchema, wire({ ...stateEvent, look: { status: "watching" } }));
  bad(HostEventSchema, wire({ ...stateEvent, look: look }));
  bad(HostEventSchema, wire({ ...stateEvent, direction: undefined }));
  bad(HostEventSchema, wire({ ...stateEvent, wizard: "aside" }));
  // The state event carries only the active zone's alignment, handoff and session.
  bad(HostEventSchema, wire({ ...stateEvent, direction: { ...directionView, zoneId: rootId, binding: { ...alignment, zoneId: rootId } } }));
  bad(HostEventSchema, wire({ ...stateEvent, handoff: { ...handoffView, handoff: { ...handoff, zoneId: rootId } } }));
  bad(HostEventSchema, wire({ ...stateEvent, session: { ...meta, zoneId: rootId } }));
  ok(HostEventSchema, { type: "reply", epoch: "e1", id: "q1", ok: true, result: { models: [{ id: "m", resolved: "m-1", label: "M", efforts: [], images: false, actions: true, verified: false }] } });
  bad(HostEventSchema, { type: "reply", epoch: "e1", id: "q1", ok: true, result: { secret: "x" } });
  ok(HostEventSchema, { type: "credential-request", epoch: "e1", requestId: "c1", need: "chatgpt-access" });
  bad(HostEventSchema, { type: "credential-request", epoch: "e1", requestId: "c1", need: "chatgpt-refresh" });
  ok(HostEventSchema, { type: "frame-request", epoch: "e1", checkId: "k1" });
  bad(HostEventSchema, { type: "quip", epoch: "e1", text: "hi" });
  bad(HostEventSchema, { type: "wizard-aside", epoch: "e1", text: "hi" });
  ok(HostEventSchema, wire({ type: "debug-state", epoch: "e1", view: debugView }));
  ok(HostEventSchema, { type: "debug-state", epoch: "e1", view: null });
  bad(HostEventSchema, wire({ type: "debug-state", epoch: "e1", view: debugView, zoneId: childId }));
  bad(HostEventSchema, wire({ type: "debug-state", epoch: "e1", view: { ...debugView, binding } }));
});

test("host replies carry every new typed result", () => {
  const results = [
    { direction: directionView },
    { direction: { ...directionView, status: "aligned", current: direction, attempt: null } },
    { directionRecord: direction },
    { decision },
    { handoff: handoffView },
    { contextUse: contextPage },
    { trail: { session: meta, events, next: "p2" } },
    { trailSource: source },
    { story: { rows: [row], next: null } },
    { debug: debugView },
  ];
  for (const result of results) ok(HostEventSchema, wire({ type: "reply", epoch: "e1", id: "q1", ok: true, result }));
  for (const result of [
    { direction: { ...directionView, current: { ...direction, goalHash: sha } } },
    { decision: { ...decision, options: [delegate, learn, delegate, learn] } },
    { handoff: { ...handoffView, head: { ...head, id: randomUUID() } } },
    { contextUse: { items: Array.from({ length: 51 }, () => ({ ref, status: "used" })), next: null } },
    { trail: { session: meta, events, next: "/etc" } },
    { story: { rows: Array.from({ length: 51 }, () => row), next: null } },
    { debug: { ...debugView, entries: [{ id: 0, from: "model", text: "x" }] } },
  ]) bad(HostResultSchema, wire(result));
});

test("directions: bounded, cited and fingerprinted", () => {
  ok(DirectionSchema, wire(direction));
  ok(DirectionInputSchema, wire({ contextRevision: sha, ability: direction.ability, choice: option, reviewCriterion: "r", assumptions: [], context: [ref] }));
  ok(AlignmentAttemptSchema, wire(attempt));
  ok(DirectionHeadSchema, wire({ version: 1, revision: 4, goalHash, currentId: direction.id, attempt }));
  ok(DirectionHeadSchema, { version: 1, revision: 0, goalHash, currentId: null, attempt: null });
  ok(ContextCorrectionsSchema, { version: 1, revision: 2, ignoredObservationSourceId: step.sourceIds[0] });
  ok(DirectionViewSchema, wire(directionView));
  bad(DirectionSchema, { ...direction, choice: { ...option, contextIds: [randomUUID()] } });
  bad(DirectionSchema, { ...direction, goal: " padded " });
  bad(DirectionSchema, { ...direction, goalHash: "abc" });
  bad(DirectionSchema, { ...direction, writes: [`${grant}/x.py`] });
  bad(DirectionSchema, { ...direction, assumptions: Array.from({ length: 9 }, (_, i) => `a${i}`) });
  bad(AlignmentAttemptSchema, { ...attempt, questions: [question, { ...question, id: randomUUID() }, { ...question, id: randomUUID() }] });
  bad(AlignmentAttemptSchema, { ...attempt, options: [option, option] });
  bad(AlignmentAttemptSchema, { ...attempt, options: [1, 2, 3, 4].map(() => ({ ...option, id: randomUUID() })) });
  bad(AlignmentAttemptSchema, { ...attempt, phase: "accepted" });
  bad(ContextListSchema, Array.from({ length: 17 }, () => ({ ...ref, id: randomUUID() })));
  bad(ContextListSchema, [{ ...ref, excerpt: "x".repeat(513) }]);
  bad(ContextListSchema, [{ ...ref, kind: "screenshot" }]);
  bad(ContextListSchema, [{ ...ref, path: "/Users/me/notes.md" }]);
  bad(ContextListSchema, [ref, ref]);
  // A direction for another goal is never current, and aligned needs one.
  bad(DirectionViewSchema, { ...directionView, current: { ...direction, goalHash: sha } });
  bad(DirectionViewSchema, { ...directionView, status: "aligned" });
  bad(DirectionViewSchema, { ...directionView, binding: { ...alignment, zoneId: rootId } });
  bad(DirectionViewSchema, { ...directionView, binding: { ...alignment, attemptId: randomUUID() } });
});

test("decisions: the model proposes, the host decides eligibility", () => {
  ok(DecisionViewSchema, wire(decision));
  bad(DecisionViewSchema, { ...decision, options: [{ ...delegate, contextIds: [randomUUID()] }] });
  bad(DecisionViewSchema, { ...decision, options: [{ ...delegate, blockers: ["needs dict"] }] });
  bad(DecisionViewSchema, { ...decision, options: [{ ...learn, blockers: [] }] });
  bad(DecisionViewSchema, { ...decision, options: [{ ...delegate, eligibility: "approved" }] });
  bad(DecisionViewSchema, { ...decision, options: [{ ...delegate, task: "" }] });
  bad(DecisionViewSchema, { ...decision, questions: [1, 2, 3].map(() => ({ id: randomUUID(), text: "q", changesPlan: "c" })) });
  const input = { moment: "delegation", goal: "understand hash maps", outcome: "a counter", language: "python", direction, answers: [], context: [ref], candidates: [skill] };
  ok(DecisionInputSchema, wire(input));
  ok(DecisionInputSchema, wire({ ...input, moment: "alignment", outcome: null, direction: null }));
  bad(DecisionInputSchema, { ...input, outcome: null });
  bad(DecisionInputSchema, { ...input, moment: "ambient" });
  bad(DecisionInputSchema, { ...input, candidates: Array.from({ length: 129 }, (_, i) => ({ name: `s${i}`, lang: "" })) });
  const { eligibility: _e, blockers: _b, ...proposal } = delegate;
  ok(DecisionResultSchema, wire({ moment: "delegation", reflection: "r", questions: [], options: [{ ...proposal, needs: null }] }));
  ok(DecisionResultSchema, wire({ moment: "alignment", reflection: "r", questions: [], options: [option] }));
  bad(DecisionResultSchema, { moment: "delegation", reflection: "r", questions: [], options: [delegate] });
  bad(DecisionResultSchema, { moment: "delegation", reflection: "r", questions: [], options: [{ ...proposal, needs: null, url: "https://example.com" }] });
  bad(DecisionResultSchema, { moment: "alignment", reflection: "r", questions: [], options: [option], say: "aside" });
});

test("handoffs: three mandatory texts, resource targets, consumed command state", () => {
  ok(HandoffSchema, wire(handoff));
  const { version: _v, id: _i, revision: _r, ...input } = handoff;
  ok(HandoffInputSchema, wire(input));
  ok(HandoffHeadSchema, wire(head));
  ok(HandoffViewSchema, wire(handoffView));
  const done = { ...head, revision: 2, requestId: "r2", state: "done", changeIds: [randomUUID()], result: "Applied 1 change; expected-result check not observed." };
  ok(HandoffHeadSchema, wire(done));
  ok(HandoffHeadSchema, wire({ ...done, reviewed: { at: now, verdict: "did not advance the goal" } }));
  ok(HandoffResultSchema, { state: "failed", changeIds: [], result: "hash changed" });
  for (const field of ["task", "expectedResult", "review"]) bad(HandoffSchema, { ...handoff, [field]: " " });
  bad(HandoffSchema, { ...handoff, targets: ["/Users/me/code/count.py"] });
  bad(HandoffSchema, { ...handoff, targets: Array.from({ length: 17 }, (_, i) => `${grant}/f${i}.py`) });
  bad(HandoffSchema, { ...handoff, skills: Array.from({ length: 33 }, (_, i) => ({ name: `s${i}`, lang: "" })) });
  bad(HandoffSchema, { ...handoff, task: "x".repeat(2049) });
  bad(HandoffHeadSchema, { ...head, requestId: "r1" });
  bad(HandoffHeadSchema, { ...done, requestId: null });
  bad(HandoffHeadSchema, { ...head, reviewed: { at: now, verdict: "fine" } });
  bad(HandoffHeadSchema, { ...done, changeIds: Array.from({ length: 33 }, () => randomUUID()) });
  bad(HandoffHeadSchema, { ...done, result: "x".repeat(2049) });
  bad(HandoffHeadSchema, { ...head, state: "approved" });
  bad(HandoffResultSchema, { state: "running", changeIds: [], result: "" });
  bad(HandoffResultSchema, { state: "done", changeIds: [], result: "", proof: true });
});

test("context use: summary in the snapshot, paged bounded inventory on request", () => {
  ok(ContextUseViewSchema, wire(contextUse));
  ok(ContextUsePageSchema, wire(contextPage));
  bad(ContextUseViewSchema, { ...contextUse, refs: [ref] });
  bad(ContextUseViewSchema, { ...contextUse, cursor: "a/b" });
  bad(ContextUsePageSchema, { items: [{ ref, status: "used", body: "file text" }], next: null });
  bad(ContextUsePageSchema, { items: [{ ref, status: "hidden" }], next: null });
});

test("look status: typed, timed and sourced", () => {
  ok(LookStatusViewSchema, wire(look));
  ok(LookStatusViewSchema, wire({ ...look, status: "no-backend", reason: null, seen: null, chosen: null, resolved: null, lastTick: null, lastAttempt: null, lastSuccess: null, permission: "not-required" }));
  bad(LookStatusViewSchema, { ...look, status: "unadvised" });
  bad(LookStatusViewSchema, { ...look, reason: "aside" });
  bad(LookStatusViewSchema, { ...look, seen: { ...look.seen, text: "x".repeat(281) } });
  bad(LookStatusViewSchema, { ...look, seen: { text: "x", at: now, stale: false } });
  bad(LookStatusViewSchema, { ...look, permission: "maybe" });
  bad(LookStatusViewSchema, { ...look, frame: "iVBORw0KGgo=" });
  ok(TopicHintsSchema, [{ topic: "binary search", skill, confidence: 0.85, reason: "bisect on screen" }, { topic: "tab bar", skill: null, confidence: 0, reason: "" }]);
  bad(TopicHintsSchema, [1, 2, 3, 4].map(() => ({ topic: "t", skill: null, confidence: 0.5, reason: "" })));
  bad(TopicHintsSchema, [{ topic: "t", skill: null, confidence: 1.2, reason: "" }]);
  bad(TopicHintsSchema, [{ topic: "t", skill: null, confidence: Number.NaN, reason: "" }]);
  bad(TopicHintsSchema, [{ topic: "x".repeat(161), skill: null, confidence: 0.5, reason: "" }]);
});

test("sessions, trail events, sources and story pages", () => {
  ok(SessionMetaSchema, wire(meta));
  ok(SessionMetaSchema, wire({ ...meta, endedAt: now, endReason: "idle", latestObservation: null }));
  bad(SessionMetaSchema, { ...meta, endedAt: now });
  bad(SessionMetaSchema, { ...meta, endReason: "bored", endedAt: now });
  for (const e of events) ok(TrailEventSchema, wire(e));
  ok(TrailEventSchema, wire({ seq: 4, at: now, kind: "touch", stepId: step.id, sourceId: null }));
  ok(TrailEventSchema, wire({ seq: 5, at: now, kind: "map-gap", gapId: events[2]!.id, step: { ...step, origin: "user-map", mapping: "user" } }));
  bad(TrailEventSchema, { ...events[1], step: { ...step, origin: "user-map" } });
  bad(TrailEventSchema, { ...events[1], step: { ...step, sourceIds: Array.from({ length: 17 }, () => randomUUID()) } });
  bad(TrailEventSchema, { ...events[3], phase: "approved" });
  bad(TrailEventSchema, { seq: 6, at: now, kind: "skill-granted", skill });
  ok(EventPageSchema, wire({ version: 1, sessionId, page: 0, events }));
  bad(EventPageSchema, { version: 1, sessionId, page: 0, events: [events[1], events[0]] });
  bad(EventPageSchema, { version: 1, sessionId, page: 0, events: Array.from({ length: 129 }, (_, seq) => ({ ...events[0], seq })) });
  ok(SessionIndexSchema, { version: 1, pages: 1, sessions: 1, activeSessionId: sessionId });
  ok(SessionIndexPageSchema, { version: 1, page: 0, ids: [sessionId] });
  bad(SessionIndexPageSchema, { version: 1, page: 0, ids: Array.from({ length: 129 }, () => randomUUID()) });
  ok(TrailSourceSchema, wire(source));
  ok(TrailSourceInputSchema, wire({ kind: "look", excerpt: "dict on screen", entryId: null, requestId: null, evidenceId: null, changeId: null, handoffId: null, proof: null }));
  bad(TrailSourceSchema, { ...source, evidenceId: null });
  bad(TrailSourceSchema, { ...source, kind: "look" });
  bad(TrailSourceSchema, { ...source, proof: { ...proof, files: [{ path: `${grant}/a.py`, sha, sourcePath: "/Users/me/a.py" }] } });
  bad(TrailSourceSchema, { ...source, excerpt: "x".repeat(2049) });
  bad(TrailSourceSchema, { ...source, screenshot: "iVBORw0KGgo=" });
  ok(StoryHeadSchema, { version: 1, generation: randomUUID(), pages: 1, revision: 3 });
  ok(StoryCachePageSchema, wire({ version: 1, generation: randomUUID(), page: 0, rows: [row] }));
  ok(StoryPageSchema, wire({ rows: [row], next: "p2" }));
  bad(StoryCachePageSchema, { version: 1, generation: randomUUID(), page: 0, rows: [{ ...row, preview: Array.from({ length: 33 }, (_, i) => ({ name: `s${i}`, lang: "" })) }] });
  bad(StoryCachePageSchema, { version: 1, generation: randomUUID(), page: 0, rows: [{ ...row, summary: "a model retrospective" }] });
  ok(TrailViewSchema, wire(trailView));
  bad(TrailViewSchema, { ...trailView, visits: Array.from({ length: 7 }, () => step) });
  bad(TrailViewSchema, { ...trailView, markers: [events[1]] });
  ok(TrailPageSchema, wire({ session: meta, events, next: null }));
});

test("diagnostics and debug view", () => {
  ok(DiagnosticEventSchema, diagEvent);
  bad(DiagnosticEventSchema, { ...diagEvent, reason: "invalid x-api-key" });
  bad(DiagnosticEventSchema, { ...diagEvent, body: "{\"error\":\"…\"}" });
  bad(DiagnosticEventSchema, { ...diagEvent, httpStatus: 42 });
  ok(DiagnosticEventsPageSchema, { events: [diagEvent], nextBeforeSeq: null, expiredBefore: 3 });
  bad(DiagnosticEventsPageSchema, { events: Array.from({ length: 51 }, (_, seq) => ({ ...diagEvent, seq })), nextBeforeSeq: null, expiredBefore: null });
  ok(DiagnosticStatusSchema, wire(status));
  bad(DiagnosticStatusSchema, { ...status, settings: { ...status.settings, agent: choice } });
  bad(DiagnosticStatusSchema, { ...status, main: { ...mainStatus, displays: ["69733382"] } });
  bad(DiagnosticStatusSchema, { ...status, costUsd: 0.42 });
  ok(MainStatusSchema, mainStatus);
  bad(MainStatusSchema, { ...mainStatus, personalPath: "/Users/me/context.md" });
  ok(SanitizedMainEventsSchema, [mainEvent]);
  ok(DebugViewSchema, wire(debugView));
  bad(DebugViewSchema, { ...debugView, entries: Array.from({ length: 101 }, (_, id) => ({ id, from: "you", text: "x" })) });
  bad(DebugViewSchema, { ...debugView, entries: [{ id: 0, from: "you", text: "é".repeat(4097) }] });
  bad(DebugViewSchema, { ...debugView, zoneId: childId });
  bad(DebugViewSchema, { ...debugView, binding: { ...debugBinding, debugSessionId: "s1" } });
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
  bad(DesktopPreferencesSchema, { ...DEFAULT_PREFERENCES, circle: { lastChosenDisplayId: null, placements: [] } });
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
  ok(ResourcePathSchema, `${grant}/src/main.py`);
  for (const p of [`${grant}/../etc/passwd`, `${grant}//a`, `/abs/path`, "new/file.py", `${grant}`, `${grant}/a\\b`]) bad(ResourcePathSchema, p);
  bad(ShareGrantSchema, { id: grant, kind: "folder", scope: "request", label: "x", files: [`${grant}/../x`] });
  const receipt = { id: randomUUID(), zoneId: childId, target: `${grant}/a.py`, baseSha: null, nextSha: sha, diff: "+a", appliedAt: now, revertible: true };
  ok(ChangeReceiptSchema, receipt);
  bad(ChangeReceiptSchema, { ...receipt, absolute: "/Users/me/a.py" });
  const proof2 = { id: randomUUID(), zoneId: childId, zoneName: "Data Structures", at: now, kind: "build", skill: "loops", lang: "python", ok: true, why: "built" };
  ok(LedgerSchema, { version: 2, held: ["loops@python"], records: [proof2] });
  bad(LedgerSchema, { version: 2, held: ["a", "a"], records: [] });
  bad(LedgerSchema, { version: 2, held: [], records: [{ ...proof2, kind: "course" }] });
});

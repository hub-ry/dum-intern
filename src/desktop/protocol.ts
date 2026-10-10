// The renderer's whole surface: a finite set of strict, bounded requests and the snapshot it draws.
// The renderer has no Node access; ipc.ts validates with `parseRequest` and never duplicates it.
// Three surfaces (docs/circle-design.md §9 and "Superseded parts (goals column)"): the working
// window asks for everything below, the circle only sends gestures, picks, toggles and reads its own
// small view, and the bubble asks for nothing: it only draws.

import { z } from "zod";
import { AgentChoiceSchema, BackendIdSchema, LoginMethodSchema, SelectorSchema } from "../agent/schema.ts";
import {
  AlignmentAcceptInputSchema, AlignmentAnswerSchema, AlignmentMoveSchema, CursorSchema, DecisionDismissInputSchema,
  DecisionHelpInputSchema, HandoffDismissInputSchema, HandoffEditInputSchema, HandoffReviewInputSchema, HandoffSelectInputSchema,
  IgnoreObservationInputSchema,
} from "../delegation-types.ts";
import { DebugBindingSchema, DebugTextSchema } from "../diagnostic-types.ts";
import { LookPrefsSchema } from "../observe-types.ts";
import { IdSchema, InputBindingSchema, RequestBindingSchema, TokenSchema } from "../share-types.ts";
import { StoryQuerySchema, TrailMapInputSchema, TrailQuerySchema } from "../trail-types.ts";
import { FocusSkillsSchema, LanguageSchema, SkillRefSchema, ZONE_LIMITS, ZoneGoalSchema, ZoneNameSchema } from "../zone-types.ts";
import { StepIdSchema, type GoalView, type NextSkill, type StepView } from "../step-types.ts";
import type { AgentChoice, BackendId, BackendStatus, LoginMethod, ModelOption, Selector } from "../agent/types.ts";
import type {
  AlignmentAcceptInput, AlignmentStepInput, ContextUsePage, ContextUseView, DecisionDismissInput, DecisionHelpInput, DecisionView,
  Direction, DirectionView, HandoffDismissInput, HandoffEditInput, HandoffReviewInput, HandoffSelectInput, HandoffView,
  IgnoreObservationInput,
} from "../delegation-types.ts";
import type { DebugBinding, DebugView } from "../diagnostic-types.ts";
import type { Mode } from "../gate.ts";
import type { LookLogEntry, LookPrefs, LookStatusView, WizardChime } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../share-types.ts";
import type { State } from "../store-types.ts";
import type { SessionMeta, StoryPage, StoryQuery, TrailMapInput, TrailPage, TrailQuery, TrailSource, TrailView } from "../trail-types.ts";
import type { View as TreeView } from "../web/view.ts";
import type { ChangeReceipt, FollowGrant, SkillRef, Zone, ZoneContext, ZoneId, ZoneRegistry } from "../zone-types.ts";
import type { VoiceState } from "./native-protocol.ts";

/** Main-owned and token-free. `agent` stays null until the user chooses who powers Dum. */
export type DesktopPreferences = {
  hotkey: string;
  voiceHotkey: string;
  sendDraftHotkey: string;
  launchAtLogin: boolean;
  personalContext: boolean;
  look: LookPrefs;
  mode: Mode;
  agent: AgentChoice | null;
};

export const DEFAULT_PREFERENCES: DesktopPreferences = {
  hotkey: "CommandOrControl+Shift+D",
  voiceHotkey: "Control+Option+Space",
  sendDraftHotkey: "CommandOrControl+Shift+Return",
  launchAtLogin: false,
  personalContext: false,
  look: { apps: true, screen: true },
  mode: "understand",
  agent: null,
};

const MODIFIERS: Record<string, "shift" | "other"> = {
  Command: "other", Cmd: "other", Control: "other", Ctrl: "other", CommandOrControl: "other", CmdOrCtrl: "other",
  Alt: "other", Option: "other", AltGr: "other", Super: "other", Meta: "other", Shift: "shift",
};
const NAMED_KEYS: Record<string, true> = {
  Plus: true, Space: true, Tab: true, Backspace: true, Delete: true, Insert: true, Return: true, Enter: true, Up: true,
  Down: true, Left: true, Right: true, Home: true, End: true, PageUp: true, PageDown: true, Escape: true, Esc: true,
};

/** An Electron accelerator with at least one non-Shift modifier and exactly one key, so a global hotkey can't eat ordinary typing. */
export function accelerator(value: string): boolean {
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  if (!parts.length || new Set(parts).size !== parts.length) return false;
  if (!parts.every((p) => MODIFIERS[p] !== undefined) || !parts.some((p) => MODIFIERS[p] === "other")) return false;
  return /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS[key] === true || /^[`\-=[\]\\;',./]$/.test(key);
}

const hotkey = z.string().max(80).refine(accelerator, "use a shortcut with Command, Control, Alt or Option plus one key");
export const ModeSchema = z.enum(["understand", "anti-vibe"]) satisfies z.ZodType<Mode>;

/** Complete preferences. */
export const DesktopPreferencesSchema = z.object({
  hotkey,
  voiceHotkey: hotkey,
  sendDraftHotkey: hotkey,
  launchAtLogin: z.boolean(),
  personalContext: z.boolean(),
  look: LookPrefsSchema,
  mode: ModeSchema,
  agent: AgentChoiceSchema.nullable(),
}).strict() satisfies z.ZodType<DesktopPreferences>;

/** Main owns one draft per zone, plus the first-run goal draft with a null-zone binding. */
export type DraftState = {
  binding: InputBinding | null;
  revision: number;
  text: string;
  source: "keyboard" | "voice";
  shareIds: string[];
  captureToken?: string;
};
/** An in-window view: a Records/Skills/Story/Settings region inside a panel, or the goal tree. */
export type ViewName =
  | "zones" | "tree" | "memory" | "history" | "context" | "evidence" | "boundary" | "projects" | "changes" | "settings" | "story";
/**
 * One circle in the column and the panel it opens: Dum (the global goals folder you prompt), one
 * goal, the skill tree, the Monitor (recording status and the live context log) or Settings. Main
 * owns which panel shows; the working window draws it.
 */
export type PanelRef = { kind: "dum" } | { kind: "goal"; id: ZoneId } | { kind: "tree" } | { kind: "monitor" } | { kind: "settings" };
export type CaptureSource = { id: string; name: string; kind: "screen" | "window" };
export type CapturePreview = { token: string; name: string; dataUrl: string; expiresAt: number };

/** Who sent a request. Each surface is its own window with its own preload. */
export type Role = "circle" | "window" | "bubble";

/** The circle's face. Derived from typed fields in main, never from status prose. */
export type CircleState = "idle" | "looking" | "thinking" | "listening" | "attention";
/** What the accessible label says; each state takes only its own reasons. */
export type CircleReason =
  | "none" | "look-paused"
  | "looking"
  | "zone" | "debug"
  | "recording" | "transcribing"
  | "decision" | "host-failed" | "setup" | "key-rejected" | "voice-error" | "look-route";
/**
 * One circle in the expanded column. `mark` is the one or two characters drawn on a goal's disk;
 * `progress` is 0..1 of the goal's path; `waiting` means its step is waiting on the user, and on the
 * Monitor's circle that the look is recording.
 */
export type CircleSlot = { ref: PanelRef; label: string; mark: string; progress: number; waiting: boolean };
/** All the circle sees: its face, the column's slots and which panel is open. No transcript, tree, settings or keys. */
export type CircleView = {
  state: CircleState; reason: CircleReason; paused: boolean; open: boolean;
  /** The column is out. Main decides; the page only animates to it. */
  expanded: boolean;
  /** Dum first, then up to three goals, then the skill tree, the Monitor and Settings. */
  slots: CircleSlot[];
  /** The panel the working window shows while `open`; the collapsed circle wears its slot. */
  showing: PanelRef | null;
};
export type CircleRequest =
  | { type: "circle-press"; phase: "begin" }
  | { type: "circle-press"; phase: "end" | "cancel"; gestureId: string }
  /** The accessibility button's press: the same toggle as a click. */
  | { type: "circle-toggle" }
  /** A slot's accessibility button, or Enter on it: opens that panel. Mouse picks go through press gestures. */
  | { type: "circle-pick"; slot: PanelRef }
  /** Esc on the column: fold it back into one circle. */
  | { type: "circle-collapse" }
  | { type: "circle-view" };
export type CircleReply = { ok: true; view: CircleView; gesture?: { gestureId: string } } | { ok: false; error: string };
/** Displays the window's Move circle offers, sanitized: no bounds or hardware detail. */
export type CircleDisplays = {
  displays: { id: string; label: string; primary: boolean; current: boolean }[];
  /** A keyboard positioning gesture is live. */
  positioning: boolean;
};

/**
 * Settings' view-only "Use personal context" row: main's current named files and how they loaded.
 * Working window only; never in the circle, bubble or diagnostics. `warning` is context.ts's fixed sentence.
 */
export type PersonalView = { status: "off" | "loaded" | "missing" | "unreadable"; files: string[]; warning: string };

export type Snapshot = {
  state: State | null;
  tree: TreeView | null;
  settings: DesktopPreferences;
  zones: ZoneRegistry;
  activeZone: ZoneContext | null;
  zoneEpoch: string;
  binding: InputBinding | null;
  draft: DraftState;
  shares: ShareGrant[];
  follows: FollowGrant[];
  changes: ChangeReceipt[];
  voice: VoiceState;
  agent: { backends: BackendStatus[]; chosen: AgentChoice | null };
  look: LookStatusView;
  /** The active zone's alignment; an inactive zone's comes back in its own reply. */
  direction: DirectionView | null;
  decision: DecisionView | null;
  handoff: HandoffView | null;
  contextUse: ContextUseView;
  session: SessionMeta | null;
  trail: TrailView | null;
  debug: DebugView | null;
  window: { visible: boolean };
  personal: PersonalView;
  hotkeyError: string;
  platform: string;
  version: string;
  canAttach: boolean;
  /** Every live goal's progress and next step, in registry order. */
  goals: GoalView[];
  /** The active goal's step: what the bubble shows until it's done or skipped. */
  step: StepView | null;
  /** The play button's recommendation; null when nothing is open to work on. */
  next: NextSkill | null;
  /** Which panel the working window draws. */
  panel: PanelRef;
  /** Goals pinned to the column, at most three; main-owned like the circle's placement. */
  pinned: ZoneId[];
  /** The Monitor's context log, oldest first: memory only in the host. */
  lookLog: LookLogEntry[];
  /** The Wizard's latest jump-in from the look; the bubble shows it once per id. */
  wizard: WizardChime | null;
};

/** Editable creation fields; ids, revision and timestamps are app-issued. */
export type ZoneCreate = Pick<Zone, "name" | "goal" | "parentId" | "language" | "focusSkills">;
export type ZonePatch = Partial<Pick<Zone, "name" | "goal" | "language" | "focusSkills">>;
export type TreeSync = { action: "link"; server: string } | { action: "sync" | "rotate" | "off" };

/** The working window's requests. */
export type Request =
  | { type: "snapshot" }
  | { type: "zone-create"; zone: ZoneCreate; enter: boolean }
  | { type: "zone-enter"; id: ZoneId; expectedRevision: number }
  | { type: "zone-delete"; id: ZoneId; expectedRevision: number }
  | { type: "zone-update"; id: ZoneId; patch: ZonePatch; expectedRevision: number }
  | { type: "zone-context"; id: ZoneId; text: string; expectedRevision: number }
  | { type: "draft-set"; text: string; expectedDraftRevision: number; binding: InputBinding | null }
  | { type: "send"; binding: InputBinding; draftRevision: number }
  | { type: "respond"; binding: RequestBinding; decision: { kind: "attest" | "share"; value: boolean } }
  | { type: "interrupt"; binding: InputBinding }
  | { type: "view"; view: ViewName }
  | { type: "command"; name: "inspect" | "projects" | "submit" | "remember"; argument: string; binding: RequestBinding }
  | { type: "share-choose"; kind: "file" | "folder"; binding: RequestBinding }
  | { type: "share-path"; path: string; kind: "file" | "folder"; binding: RequestBinding }
  | { type: "share-remove"; shareId: string; binding: RequestBinding }
  | { type: "follow-add" }
  | { type: "follow-remove"; followId: string }
  | { type: "change-revert"; changeId: string; binding: InputBinding }
  | { type: "open-record"; record: "change" | "memory"; id?: string }
  /** A personal-context source, resolved only against main's current named inventory. */
  | { type: "open-record"; record: "personal"; sourceId: string }
  | { type: "skill-edit"; op: "add" | "remove"; skill: SkillRef }
  | { type: "tree-sync"; sync: TreeSync }
  | { type: "settings"; settings: DesktopPreferences }
  | { type: "capture-sources" }
  | { type: "capture-preview"; sourceId: string; binding: RequestBinding }
  | { type: "capture-discard"; token: string }
  | { type: "screen-permission" }
  | { type: "look-pause"; paused: boolean }
  | { type: "voice-setup" }
  | { type: "voice-start"; binding: InputBinding }
  | { type: "voice-stop"; recordingId: string }
  | { type: "voice-cancel"; recordingId: string }
  | { type: "agent-check" }
  | { type: "agent-login"; backend: BackendId; method: LoginMethod }
  | { type: "agent-login-cancel" }
  /** The only request that carries a secret; main never echoes it. */
  | { type: "agent-key"; backend: "claude"; key: string }
  | { type: "agent-signout"; backend: BackendId; method: LoginMethod }
  | { type: "agent-models"; backend: BackendId; login: LoginMethod }
  /** Verify for pictures: one small real picture call; on success the catalog's row reads `verified: true`. */
  | { type: "agent-verify-images"; backend: "claude"; selector: Selector }
  | { type: "agent-select"; choice: AgentChoice }
  // Goal alignment: any zone, by its own alignment binding; never the active zone's grants.
  | { type: "alignment-read"; zoneId: ZoneId }
  | ({ type: "alignment-step" } & AlignmentStepInput)
  | ({ type: "alignment-accept" } & AlignmentAcceptInput)
  /** A historical direction revision: read-only. */
  | { type: "direction-read"; zoneId: ZoneId; directionId: string }
  // Decisions and handoffs in the active zone. Selection and edits write no source file.
  | ({ type: "decision-help" } & DecisionHelpInput)
  | ({ type: "decision-dismiss" } & DecisionDismissInput)
  | ({ type: "handoff-select" } & HandoffSelectInput)
  | ({ type: "handoff-edit" } & HandoffEditInput)
  | ({ type: "handoff-dismiss" } & HandoffDismissInput)
  /** Do this: the explicit command, bound to the canonical draft revision it consumes. */
  | { type: "handoff-run"; binding: RequestBinding; handoffId: string; revision: number; draftRevision: number }
  | { type: "handoff-read"; zoneId: ZoneId; handoffId: string }
  | ({ type: "handoff-review" } & HandoffReviewInput)
  // Current context: Using / Inspect / Correct.
  | { type: "context-use-read"; binding: RequestBinding; cursor: string | null }
  | { type: "context-reload"; binding: RequestBinding }
  | ({ type: "context-ignore-observation" } & IgnoreObservationInput)
  // Sessions, trail and story. Historical reads confer nothing.
  | { type: "session-new"; binding: RequestBinding }
  | ({ type: "trail-read" } & TrailQuery)
  | { type: "trail-source"; zoneId: ZoneId; sessionId: string; sourceId: string }
  | ({ type: "trail-map" } & TrailMapInput)
  | ({ type: "story-read" } & StoryQuery)
  // Debug chat: its own binding, typed text only, no zone input.
  | { type: "debug-open" }
  | { type: "debug-send"; binding: DebugBinding; text: string }
  | { type: "debug-stop"; binding: DebugBinding }
  | { type: "debug-reset" }
  // Move circle: main samples and clamps; the window names no coordinates.
  | { type: "circle-position"; action: "begin" | "commit" | "cancel" }
  /** One axis, ±1 or ±10 DIP, inside a live positioning gesture. */
  | { type: "circle-nudge"; dx: number; dy: number }
  | { type: "circle-display"; displayId: string }
  | { type: "show-surface"; surface: "window" }
  | { type: "dismiss-surface"; surface: "window" }
  | { type: "quit" }
  // Goals, steps and play.
  /** Switch the working window to another panel; main re-places it at the circle. */
  | { type: "panel"; panel: PanelRef }
  | { type: "goal-pin"; id: ZoneId; pinned: boolean }
  /** Skip a whole goal: its path's skills become trusted. `skip: false` clears the goal's skip mark only. */
  | { type: "goal-skip"; id: ZoneId; skip: boolean }
  /** Skip one step. A skill step's skill becomes trusted. Refused unconfirmed when the step has `confirmSkip`. */
  | { type: "step-skip"; zoneId: ZoneId; stepId: string; confirmed: boolean }
  /** "Pick … for me": the step's pick prompt goes to Dum in that goal, as if typed. */
  | { type: "step-pick"; zoneId: ZoneId; stepId: string }
  /** Play: work on this skill next in the active goal, or on the recommended one when null. */
  | { type: "play"; skill: SkillRef | null };

export const ViewNameSchema = z.enum([
  "zones", "tree", "memory", "history", "context", "evidence", "boundary", "projects", "changes", "settings", "story",
]) satisfies z.ZodType<ViewName>;
export const CommandNameSchema = z.enum(["inspect", "projects", "submit", "remember"]);
export const ShareKindSchema = z.enum(["file", "folder"]);
export const RespondDecisionSchema = z.object({ kind: z.enum(["attest", "share"]), value: z.boolean() }).strict();
export const SkillEditOpSchema = z.enum(["add", "remove"]);
export const RecordSchema = z.enum(["change", "memory"]);
/** Electron display ids, as strings: matching hints, not hardware identities. */
export const DisplayIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a display id");
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const surface = z.literal("window");
export const PanelRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dum") }).strict(),
  z.object({ kind: z.literal("goal"), id: IdSchema }).strict(),
  z.object({ kind: z.literal("tree") }).strict(),
  z.object({ kind: z.literal("monitor") }).strict(),
  z.object({ kind: z.literal("settings") }).strict(),
]) satisfies z.ZodType<PanelRef>;
const utf8Max = (max: number) => z.string().refine((t) => new TextEncoder().encode(t).length <= max, "is too long");

export const ZoneCreateSchema = z.object({
  name: ZoneNameSchema,
  goal: ZoneGoalSchema,
  parentId: IdSchema.nullable(),
  language: LanguageSchema.min(1).nullable(),
  focusSkills: FocusSkillsSchema,
}).strict() satisfies z.ZodType<ZoneCreate>;
export const ZonePatchSchema = z.object({
  name: ZoneNameSchema.optional(),
  goal: ZoneGoalSchema.optional(),
  language: LanguageSchema.min(1).nullable().optional(),
  focusSkills: FocusSkillsSchema.optional(),
}).strict().refine((p) => Object.keys(p).length > 0, "changes nothing") satisfies z.ZodType<ZonePatch>;
export const ZoneContextTextSchema = utf8Max(ZONE_LIMITS.contextBytes);
/** Absolute path the user typed; main resolves and confirms it natively before any grant. */
export const TypedPathSchema = z.string().min(1).max(4096).refine((p) => !/[\u0000-\u001f]/.test(p), "has control characters");
export const TreeSyncSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), server: z.url({ protocol: /^https?$/ }).max(2048) }).strict(),
  z.object({ action: z.enum(["sync", "rotate", "off"]) }).strict(),
]) satisfies z.ZodType<TreeSync>;
/** A keyboard nudge step: 1 DIP with Shift, else 10, or 0 on the other axis. */
const step = z.union([z.literal(0), z.literal(1), z.literal(-1), z.literal(10), z.literal(-10)]);

const type = <T extends string>(name: T) => ({ type: z.literal(name) });

export const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("zone-create"), zone: ZoneCreateSchema, enter: z.boolean() }).strict(),
  z.object({ type: z.literal("zone-enter"), id: IdSchema, expectedRevision: revision }).strict(),
  z.object({ type: z.literal("zone-delete"), id: IdSchema, expectedRevision: revision }).strict(),
  z.object({ type: z.literal("zone-update"), id: IdSchema, patch: ZonePatchSchema, expectedRevision: revision }).strict(),
  z.object({ type: z.literal("zone-context"), id: IdSchema, text: ZoneContextTextSchema, expectedRevision: revision }).strict(),
  z.object({ type: z.literal("draft-set"), text: utf8Max(32 * 1024), expectedDraftRevision: revision, binding: InputBindingSchema.nullable() }).strict(),
  z.object({ type: z.literal("send"), binding: InputBindingSchema, draftRevision: revision }).strict(),
  z.object({ type: z.literal("respond"), binding: RequestBindingSchema, decision: RespondDecisionSchema }).strict(),
  z.object({ type: z.literal("interrupt"), binding: InputBindingSchema }).strict(),
  z.object({ type: z.literal("view"), view: ViewNameSchema }).strict(),
  z.object({ type: z.literal("command"), name: CommandNameSchema, argument: z.string().max(4096), binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("share-choose"), kind: ShareKindSchema, binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("share-path"), path: TypedPathSchema, kind: ShareKindSchema, binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("share-remove"), shareId: IdSchema, binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("follow-add") }).strict(),
  z.object({ type: z.literal("follow-remove"), followId: IdSchema }).strict(),
  z.object({ type: z.literal("change-revert"), changeId: IdSchema, binding: InputBindingSchema }).strict(),
  z.discriminatedUnion("record", [
    z.object({ type: z.literal("open-record"), record: RecordSchema, id: IdSchema.optional() }).strict(),
    z.object({ type: z.literal("open-record"), record: z.literal("personal"), sourceId: IdSchema }).strict(),
  ]),
  z.object({ type: z.literal("skill-edit"), op: SkillEditOpSchema, skill: SkillRefSchema }).strict(),
  z.object({ type: z.literal("tree-sync"), sync: TreeSyncSchema }).strict(),
  z.object({ type: z.literal("settings"), settings: DesktopPreferencesSchema }).strict(),
  z.object({ type: z.literal("capture-sources") }).strict(),
  z.object({ type: z.literal("capture-preview"), sourceId: z.string().min(1).max(256), binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("capture-discard"), token: TokenSchema }).strict(),
  z.object({ type: z.literal("screen-permission") }).strict(),
  z.object({ type: z.literal("look-pause"), paused: z.boolean() }).strict(),
  z.object({ type: z.literal("voice-setup") }).strict(),
  z.object({ type: z.literal("voice-start"), binding: InputBindingSchema }).strict(),
  z.object({ type: z.literal("voice-stop"), recordingId: TokenSchema }).strict(),
  z.object({ type: z.literal("voice-cancel"), recordingId: TokenSchema }).strict(),
  z.object({ type: z.literal("agent-check") }).strict(),
  z.object({ type: z.literal("agent-login"), backend: BackendIdSchema, method: LoginMethodSchema }).strict(),
  z.object({ type: z.literal("agent-login-cancel") }).strict(),
  z.object({ type: z.literal("agent-key"), backend: z.literal("claude"), key: z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/, "not an API key") }).strict(),
  z.object({ type: z.literal("agent-signout"), backend: BackendIdSchema, method: LoginMethodSchema }).strict(),
  z.object({ type: z.literal("agent-models"), backend: BackendIdSchema, login: LoginMethodSchema }).strict(),
  z.object({ type: z.literal("agent-verify-images"), backend: z.literal("claude"), selector: SelectorSchema.extend({ backend: z.literal("claude") }).strict() }).strict(),
  z.object({ type: z.literal("agent-select"), choice: AgentChoiceSchema }).strict(),
  z.object({ type: z.literal("alignment-read"), zoneId: IdSchema }).strict(),
  z.discriminatedUnion("action", [AlignmentAnswerSchema.extend(type("alignment-step")).strict(), AlignmentMoveSchema.extend(type("alignment-step")).strict()]),
  AlignmentAcceptInputSchema.extend(type("alignment-accept")).strict(),
  z.object({ type: z.literal("direction-read"), zoneId: IdSchema, directionId: IdSchema }).strict(),
  DecisionHelpInputSchema.extend(type("decision-help")).strict(),
  DecisionDismissInputSchema.extend(type("decision-dismiss")).strict(),
  HandoffSelectInputSchema.extend(type("handoff-select")).strict(),
  HandoffEditInputSchema.extend(type("handoff-edit")).strict(),
  HandoffDismissInputSchema.extend(type("handoff-dismiss")).strict(),
  z.object({ type: z.literal("handoff-run"), binding: RequestBindingSchema, handoffId: IdSchema, revision, draftRevision: revision }).strict(),
  z.object({ type: z.literal("handoff-read"), zoneId: IdSchema, handoffId: IdSchema }).strict(),
  HandoffReviewInputSchema.extend(type("handoff-review")).strict(),
  z.object({ type: z.literal("context-use-read"), binding: RequestBindingSchema, cursor: CursorSchema.nullable() }).strict(),
  z.object({ type: z.literal("context-reload"), binding: RequestBindingSchema }).strict(),
  IgnoreObservationInputSchema.extend(type("context-ignore-observation")).strict(),
  z.object({ type: z.literal("session-new"), binding: RequestBindingSchema }).strict(),
  TrailQuerySchema.extend(type("trail-read")).strict(),
  z.object({ type: z.literal("trail-source"), zoneId: IdSchema, sessionId: IdSchema, sourceId: IdSchema }).strict(),
  TrailMapInputSchema.extend(type("trail-map")).strict(),
  StoryQuerySchema.extend(type("story-read")).strict(),
  z.object({ type: z.literal("debug-open") }).strict(),
  z.object({ type: z.literal("debug-send"), binding: DebugBindingSchema, text: DebugTextSchema }).strict(),
  z.object({ type: z.literal("debug-stop"), binding: DebugBindingSchema }).strict(),
  z.object({ type: z.literal("debug-reset") }).strict(),
  z.object({ type: z.literal("circle-position"), action: z.enum(["begin", "commit", "cancel"]) }).strict(),
  z.object({ type: z.literal("circle-nudge"), dx: step, dy: step }).strict().refine((n) => (n.dx === 0) !== (n.dy === 0), "move along one axis"),
  z.object({ type: z.literal("circle-display"), displayId: DisplayIdSchema }).strict(),
  z.object({ type: z.literal("show-surface"), surface }).strict(),
  z.object({ type: z.literal("dismiss-surface"), surface }).strict(),
  z.object({ type: z.literal("quit") }).strict(),
  z.object({ type: z.literal("panel"), panel: PanelRefSchema }).strict(),
  z.object({ type: z.literal("goal-pin"), id: IdSchema, pinned: z.boolean() }).strict(),
  z.object({ type: z.literal("goal-skip"), id: IdSchema, skip: z.boolean() }).strict(),
  z.object({ type: z.literal("step-skip"), zoneId: IdSchema, stepId: StepIdSchema, confirmed: z.boolean() }).strict(),
  z.object({ type: z.literal("step-pick"), zoneId: IdSchema, stepId: StepIdSchema }).strict(),
  z.object({ type: z.literal("play"), skill: SkillRefSchema.nullable() }).strict(),
]) satisfies z.ZodType<Request>;

export const CircleRequestSchema = z.discriminatedUnion("type", [
  z.discriminatedUnion("phase", [
    z.object({ type: z.literal("circle-press"), phase: z.literal("begin") }).strict(),
    z.object({ type: z.literal("circle-press"), phase: z.enum(["end", "cancel"]), gestureId: TokenSchema }).strict(),
  ]),
  z.object({ type: z.literal("circle-toggle") }).strict(),
  z.object({ type: z.literal("circle-pick"), slot: PanelRefSchema }).strict(),
  z.object({ type: z.literal("circle-collapse") }).strict(),
  z.object({ type: z.literal("circle-view") }).strict(),
]) satisfies z.ZodType<CircleRequest>;

/** Each face state and the reasons its label may give. */
export const CIRCLE_REASONS: Record<CircleState, readonly CircleReason[]> = {
  idle: ["none", "look-paused"],
  looking: ["looking"],
  thinking: ["zone", "debug"],
  listening: ["recording", "transcribing"],
  attention: ["decision", "host-failed", "setup", "key-rejected", "voice-error", "look-route"],
};
export const CircleViewSchema = z.object({
  state: z.enum(["idle", "looking", "thinking", "listening", "attention"]),
  reason: z.enum([
    "none", "look-paused", "looking", "zone", "debug", "recording", "transcribing",
    "decision", "host-failed", "setup", "key-rejected", "voice-error", "look-route",
  ]),
  paused: z.boolean(),
  open: z.boolean(),
  expanded: z.boolean(),
  slots: z.array(z.object({
    ref: PanelRefSchema,
    label: z.string().min(1).max(160),
    mark: z.string().min(1).max(4),
    progress: z.number().min(0).max(1),
    waiting: z.boolean(),
  }).strict()).max(7),
  showing: PanelRefSchema.nullable(),
}).strict()
  .refine((v) => CIRCLE_REASONS[v.state].includes(v.reason), "that reason belongs to another state")
  .refine((v) => v.reason !== "look-paused" || v.paused, "look-paused needs the look paused") satisfies z.ZodType<CircleView>;
export const CircleReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), view: CircleViewSchema, gesture: z.object({ gestureId: TokenSchema }).strict().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }).strict(),
]) satisfies z.ZodType<CircleReply>;
export const CircleDisplaysSchema = z.object({
  displays: z.array(z.object({
    id: DisplayIdSchema, label: z.string().min(1).max(160), primary: z.boolean(), current: z.boolean(),
  }).strict()).max(16),
  positioning: z.boolean(),
}).strict().refine((d) => d.displays.filter((x) => x.current).length <= 1, "the circle is on one display") satisfies z.ZodType<CircleDisplays>;

/**
 * The one authorization rule for every surface: the bubble invokes nothing, the circle only its
 * gestures, picks, toggle and view, the working window everything else. Throws on anything outside it.
 */
export function parseRequest(role: Role, raw: unknown): { role: "circle"; request: CircleRequest } | { role: "window"; request: Request } {
  switch (role) {
    case "bubble": throw new Error("The bubble can't ask for anything");
    case "circle": return { role, request: CircleRequestSchema.parse(raw) as CircleRequest };
    case "window": return { role, request: RequestSchema.parse(raw) as Request };
  }
}

/** Typed results; each request fills at most the fields it owns. */
export type Reply =
  | {
    ok: true;
    snapshot?: Snapshot;
    sources?: CaptureSource[];
    preview?: CapturePreview;
    models?: ModelOption[];
    /** Alignment of the zone a request named, active or not: alignment-*, zone-create, zone-update. */
    direction?: DirectionView;
    /** direction-read: one historical revision. */
    directionRecord?: Direction;
    decision?: DecisionView;
    handoff?: HandoffView;
    contextUse?: ContextUsePage;
    trail?: TrailPage;
    trailSource?: TrailSource;
    story?: StoryPage;
    debug?: DebugView;
    displays?: CircleDisplays;
  }
  | { ok: false; error: string };

export type DesktopAPI = {
  invoke(request: Request): Promise<Reply>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
};
/** The circle's restricted `dum:circle` channel. */
export type CircleAPI = {
  invoke(request: CircleRequest): Promise<CircleReply>;
  subscribe(listener: (view: CircleView) => void): () => void;
};
/**
 * The bubble, drawn as a thought cloud trailing toward the circle. It has no buttons and takes no
 * input. `reply` is at most one sentence of Dum's; `voice` is the dictation preview; `step` is the
 * active goal's step, which stays (expiresAt 0) until it's done, skipped or replaced; `wizard` is the
 * Wizard jumping in because the look saw the user stuck. Step and wizard sit beside the circle:
 * `toward` is the side of the bubble window the circle is on, where the cloud's puffs trail off.
 */
export type BubbleView =
  | { kind: "voice" | "reply"; lines: string[]; expiresAt: number }
  | { kind: "step"; step: StepView; expiresAt: 0; toward?: "left" | "right" }
  | { kind: "wizard"; text: string; expiresAt: number; toward?: "left" | "right" };
/** Read-only: the bubble can't invoke anything. */
export type BubbleAPI = { subscribe(listener: (view: BubbleView) => void): () => void };

// The renderer's whole surface: a finite set of strict, bounded requests and the snapshot it draws.
// The renderer has no Node access; ipc.ts validates with RequestSchema and never duplicates it.

import { z } from "zod";
import { AgentChoiceSchema, BackendIdSchema, LoginMethodSchema } from "../agent/schema.ts";
import { LookPrefsSchema } from "../observe-types.ts";
import { IdSchema, InputBindingSchema, RequestBindingSchema, TokenSchema } from "../share-types.ts";
import { FocusSkillsSchema, LanguageSchema, SkillRefSchema, ZONE_LIMITS, ZoneGoalSchema, ZoneNameSchema } from "../zone-types.ts";
import type { AgentChoice, BackendId, BackendStatus, LoginMethod, ModelOption } from "../agent/types.ts";
import type { Mode } from "../gate.ts";
import type { LookPrefs } from "../observe-types.ts";
import type { InputBinding, RequestBinding, ShareGrant } from "../share-types.ts";
import type { State } from "../store-types.ts";
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
export type Panel = "zones" | "tree" | "memory" | "history" | "context" | "evidence" | "boundary" | "projects" | "changes" | "settings";
export type CaptureSource = { id: string; name: string; kind: "screen" | "window" };
export type CapturePreview = { token: string; name: string; dataUrl: string; expiresAt: number };

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
  look: { status: string; paused: boolean; screenPermission: string };
  hotkeyError: string;
  platform: string;
  version: string;
  canAttach: boolean;
};

/** Editable creation fields; ids, revision and timestamps are app-issued. */
export type ZoneCreate = Pick<Zone, "name" | "goal" | "parentId" | "language" | "focusSkills">;
export type ZonePatch = Partial<Pick<Zone, "name" | "goal" | "language" | "focusSkills">>;
export type TreeSync = { action: "link"; server: string } | { action: "sync" | "rotate" | "off" };

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
  | { type: "panel"; panel: Panel }
  | { type: "command"; name: "inspect" | "projects" | "submit" | "remember"; argument: string; binding: RequestBinding }
  | { type: "share-choose"; kind: "file" | "folder"; binding: RequestBinding }
  | { type: "share-path"; path: string; kind: "file" | "folder"; binding: RequestBinding }
  | { type: "share-remove"; shareId: string; binding: RequestBinding }
  | { type: "follow-add" }
  | { type: "follow-remove"; followId: string }
  | { type: "change-revert"; changeId: string; binding: InputBinding }
  | { type: "open-record"; record: "change" | "memory"; id?: string }
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
  | { type: "agent-select"; choice: AgentChoice }
  | { type: "show-surface"; surface: "panel" | "command" }
  | { type: "dismiss-surface"; surface: "panel" | "command" }
  | { type: "quit" };

export const PanelSchema = z.enum(["zones", "tree", "memory", "history", "context", "evidence", "boundary", "projects", "changes", "settings"]) satisfies z.ZodType<Panel>;
export const CommandNameSchema = z.enum(["inspect", "projects", "submit", "remember"]);
export const ShareKindSchema = z.enum(["file", "folder"]);
export const RespondDecisionSchema = z.object({ kind: z.enum(["attest", "share"]), value: z.boolean() }).strict();
export const SkillEditOpSchema = z.enum(["add", "remove"]);
export const RecordSchema = z.enum(["change", "memory"]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const surface = z.enum(["panel", "command"]);
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
  z.object({ type: z.literal("panel"), panel: PanelSchema }).strict(),
  z.object({ type: z.literal("command"), name: CommandNameSchema, argument: z.string().max(4096), binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("share-choose"), kind: ShareKindSchema, binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("share-path"), path: TypedPathSchema, kind: ShareKindSchema, binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("share-remove"), shareId: IdSchema, binding: RequestBindingSchema }).strict(),
  z.object({ type: z.literal("follow-add") }).strict(),
  z.object({ type: z.literal("follow-remove"), followId: IdSchema }).strict(),
  z.object({ type: z.literal("change-revert"), changeId: IdSchema, binding: InputBindingSchema }).strict(),
  z.object({ type: z.literal("open-record"), record: RecordSchema, id: IdSchema.optional() }).strict(),
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
  z.object({ type: z.literal("agent-select"), choice: AgentChoiceSchema }).strict(),
  z.object({ type: z.literal("show-surface"), surface }).strict(),
  z.object({ type: z.literal("dismiss-surface"), surface }).strict(),
  z.object({ type: z.literal("quit") }).strict(),
]) satisfies z.ZodType<Request>;

export type Reply =
  | { ok: true; snapshot?: Snapshot; sources?: CaptureSource[]; preview?: CapturePreview; models?: ModelOption[] }
  | { ok: false; error: string };

export type DesktopAPI = {
  invoke(request: Request): Promise<Reply>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
};
/** The cursor bubble: what it shows and when it goes away. */
export type BubbleView = { kind: "voice" | "reply"; lines: string[]; expiresAt: number };
/** Read-only: the bubble can't invoke anything. */
export type BubbleAPI = { subscribe(listener: (view: BubbleView) => void): () => void };

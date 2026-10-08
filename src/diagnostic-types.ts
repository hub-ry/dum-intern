// Diagnostics and the debug chat (docs/circle-design.md §6). Data and schemas only.
// The ring is host memory: allowlisted, categorical events, never keys, provider bodies, request
// text, paths, titles or source. Debug's only authority is three bounded diagnostic reads.

import { z } from "zod";
import { BackendIdSchema, LoginMethodSchema, SelectorSchema } from "./agent/schema.ts";
import { LOOK_REASONS, LookPrefsSchema, LookStatusSchema, ScreenPermissionSchema } from "./observe-types.ts";
import { IdSchema, TokenSchema } from "./share-types.ts";
import { IsoSchema } from "./zone-types.ts";
import type { BackendId, LoginMethod, Role as ModelRole, Selector } from "./agent/types.ts";
import type { Mode } from "./gate.ts";
import type { LookPrefs, LookReason, LookStatus, ScreenPermission } from "./observe-types.ts";

export const DIAGNOSTIC_LIMITS = {
  ringEvents: 500,
  ringBytes: 524288,
  ringMs: 30 * 60_000,
  eventBytes: 1024,
  /** One diagnostic_events reply. */
  pageEvents: 50,
  pageBytes: 32768,
  referenceBytes: 8192,
  /** One diagnostic-main message from main. */
  mainEvents: 20,
  mainBytes: 16384,
  debugEntries: 100,
  debugBytes: 131072,
  debugTextBytes: 8192,
  debugRounds: 8,
  debugMs: 45_000,
  debugIdleMs: 30 * 60_000,
} as const;

const D = DIAGNOSTIC_LIMITS;
const encoder = new TextEncoder();
const jsonBytes = (v: unknown) => encoder.encode(JSON.stringify(v)).length;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ms = z.number().int().nonnegative().max(24 * 60 * 60_000);

export type DiagnosticKind = "look-decision" | "call-start" | "call-end" | "backend" | "settings" | "native" | "host";
export type DiagnosticRole = "intern" | "helper" | "look" | "debug";
export type DiagnosticOutcome = "started" | "ok" | "skipped" | "blocked" | "failed" | "cancelled";
/** Closed categories; the look's reasons are a subset. Never provider text. */
export const DIAGNOSTIC_CODES = [
  ...LOOK_REASONS,
  "none", "paused", "no-backend", "authentication", "network", "provider", "isolation", "io", "invalid-reply",
  "shortcut-conflict", "display-change", "sleep", "unlock", "settings-change", "backend-check", "host-start", "host-exit",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type DiagnosticEvent = {
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  kind: DiagnosticKind;
  role: DiagnosticRole | null;
  requestId: string | null;
  checkId: string | null;
  outcome: DiagnosticOutcome;
  reason: DiagnosticCode;
  latencyMs: number | null;
  httpStatus: number | null;
};
/** What main may report: OS, settings and backend facts. The host assigns sequence and time. */
export type SanitizedMainEvent = Omit<DiagnosticEvent, "seq" | "at" | "kind"> & { kind: "backend" | "settings" | "native" };

export const DiagnosticKindSchema = z.enum(["look-decision", "call-start", "call-end", "backend", "settings", "native", "host"]) satisfies z.ZodType<DiagnosticKind>;
export const DiagnosticRoleSchema = z.enum(["intern", "helper", "look", "debug"]) satisfies z.ZodType<DiagnosticRole>;
export const DiagnosticOutcomeSchema = z.enum(["started", "ok", "skipped", "blocked", "failed", "cancelled"]) satisfies z.ZodType<DiagnosticOutcome>;
export const DiagnosticCodeSchema = z.enum(DIAGNOSTIC_CODES) satisfies z.ZodType<DiagnosticCode>;

const eventFields = {
  role: DiagnosticRoleSchema.nullable(),
  requestId: TokenSchema.nullable(),
  checkId: TokenSchema.nullable(),
  outcome: DiagnosticOutcomeSchema,
  reason: DiagnosticCodeSchema,
  latencyMs: ms.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
};
export const DiagnosticEventSchema = z.object({ seq: count, at: count, kind: DiagnosticKindSchema, ...eventFields }).strict()
  .refine((e) => jsonBytes(e) <= D.eventBytes, "event is too large") satisfies z.ZodType<DiagnosticEvent>;
export const SanitizedMainEventSchema = z.object({ kind: z.enum(["backend", "settings", "native"]), ...eventFields }).strict()
  .refine((e) => e.role !== "debug" && e.requestId === null && e.checkId === null, "main reports no requests") satisfies z.ZodType<SanitizedMainEvent>;
/** At most 20 events and 16 KiB per message. */
export const SanitizedMainEventsSchema = z.array(SanitizedMainEventSchema).max(D.mainEvents)
  .refine((list) => jsonBytes(list) <= D.mainBytes, "too many diagnostic bytes");

// ---- Status ------------------------------------------------------------------------------------

export type ShortcutProblem = "conflict" | "invalid" | "unavailable";
/** Main's sanitized facts, on initialize and with each diagnostic-main update. */
export type MainStatus = {
  version: string;
  platform: string;
  backends: { id: BackendId; installed: boolean; ready: LoginMethod | null }[];
  screenPermission: ScreenPermission;
  lookPaused: boolean;
  voice: { supported: boolean; available: boolean; bridge: boolean };
  shortcuts: { open: ShortcutProblem | null; voice: ShortcutProblem | null; sendDraft: ShortcutProblem | null };
};
/** Allowlisted settings: booleans, mode and the three accelerators. No paths, display ids or keys. */
export type DiagnosticSettings = {
  launchAtLogin: boolean;
  personalContext: boolean;
  look: LookPrefs;
  mode: Mode;
  hotkey: string;
  voiceHotkey: string;
  sendDraftHotkey: string;
};
export type CallCounters = {
  started: number;
  ok: number;
  failed: number;
  timedOut: number;
  lastLatencyMs: number | null;
  /** Only when the backend actually reported them. */
  inputTokens: number | null;
  outputTokens: number | null;
};
/** diagnostic_status: sanitized current state. No billing estimates. */
export type DiagnosticStatus = {
  main: MainStatus;
  settings: DiagnosticSettings;
  models: Record<ModelRole, { chosen: Selector | null; resolved: string | null }>;
  look: {
    status: LookStatus;
    reason: LookReason | null;
    lastTick: string | null;
    lastAttempt: string | null;
    lastSuccess: string | null;
    pending: number;
    inflight: number;
  };
  calls: Record<DiagnosticRole, CallCounters>;
  ring: { events: number; bytes: number; oldestSeq: number | null; newestSeq: number | null; maxEvents: number; maxBytes: number; maxAgeMs: number };
};

const version = z.string().min(1).max(64).regex(/^[0-9A-Za-z.+_-]+$/, "not a version");
const shortcut = z.enum(["conflict", "invalid", "unavailable"]).nullable();
export const MainStatusSchema = z.object({
  version,
  platform: z.string().regex(/^[a-z0-9]{1,32}$/, "not a platform"),
  backends: z.array(z.object({ id: BackendIdSchema, installed: z.boolean(), ready: LoginMethodSchema.nullable() }).strict()).max(4),
  screenPermission: ScreenPermissionSchema,
  lookPaused: z.boolean(),
  voice: z.object({ supported: z.boolean(), available: z.boolean(), bridge: z.boolean() }).strict(),
  shortcuts: z.object({ open: shortcut, voice: shortcut, sendDraft: shortcut }).strict(),
}).strict() satisfies z.ZodType<MainStatus>;

const accelerator = z.string().min(1).max(80).regex(/^[A-Za-z0-9+`\-=[\]\\;',./]+$/, "not an accelerator");
export const DiagnosticSettingsSchema = z.object({
  launchAtLogin: z.boolean(),
  personalContext: z.boolean(),
  look: LookPrefsSchema,
  mode: z.enum(["understand", "anti-vibe"]),
  hotkey: accelerator,
  voiceHotkey: accelerator,
  sendDraftHotkey: accelerator,
}).strict() satisfies z.ZodType<DiagnosticSettings>;

const counters = z.object({
  started: count, ok: count, failed: count, timedOut: count, lastLatencyMs: ms.nullable(), inputTokens: count.nullable(), outputTokens: count.nullable(),
}).strict() satisfies z.ZodType<CallCounters>;
const model = z.object({ chosen: SelectorSchema.nullable(), resolved: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "not a model id").nullable() }).strict();
export const DiagnosticStatusSchema = z.object({
  main: MainStatusSchema,
  settings: DiagnosticSettingsSchema,
  models: z.object({ intern: model, helper: model, look: model }).strict(),
  look: z.object({
    status: LookStatusSchema,
    reason: z.enum(LOOK_REASONS).nullable(),
    lastTick: IsoSchema.nullable(),
    lastAttempt: IsoSchema.nullable(),
    lastSuccess: IsoSchema.nullable(),
    pending: count,
    inflight: z.number().int().min(0).max(1),
  }).strict(),
  calls: z.object({ intern: counters, helper: counters, look: counters, debug: counters }).strict(),
  ring: z.object({
    events: count.max(D.ringEvents), bytes: count.max(D.ringBytes), oldestSeq: count.nullable(), newestSeq: count.nullable(),
    maxEvents: z.literal(D.ringEvents), maxBytes: z.literal(D.ringBytes), maxAgeMs: z.literal(D.ringMs),
  }).strict(),
}).strict() satisfies z.ZodType<DiagnosticStatus>;

// ---- The three read-only actions ---------------------------------------------------------------

export type DiagnosticTopic = "look" | "models" | "status" | "voice" | "storage" | "shortcuts";
export type DiagnosticEventsQuery = { beforeSeq?: number; limit: number; kinds?: DiagnosticKind[] };
/** `expiredBefore`: sequence numbers below it aged out of the ring and are explicitly absent. */
export type DiagnosticEventsPage = { events: DiagnosticEvent[]; nextBeforeSeq: number | null; expiredBefore: number | null };

export const DiagnosticTopicSchema = z.enum(["look", "models", "status", "voice", "storage", "shortcuts"]) satisfies z.ZodType<DiagnosticTopic>;
export const DiagnosticEventsPageSchema = z.object({
  events: z.array(DiagnosticEventSchema).max(D.pageEvents),
  nextBeforeSeq: count.nullable(),
  expiredBefore: count.nullable(),
}).strict().refine((p) => jsonBytes(p) <= D.pageBytes, "events page is too large") satisfies z.ZodType<DiagnosticEventsPage>;

/** The debug session's whole closure. Diagnostics implements more; debug receives only this. */
export interface ReadonlyDiagnostics {
  status(): DiagnosticStatus;
  events(query: DiagnosticEventsQuery): DiagnosticEventsPage;
  /** Fixed app-owned text, at most 8 KiB. */
  reference(topic: DiagnosticTopic): string;
}

/** Argument shapes of the closed action list, as DumAction schemas. Anything else is refused. */
export const DIAGNOSTIC_ACTIONS = {
  diagnostic_status: {},
  diagnostic_events: {
    beforeSeq: count.optional(),
    limit: z.number().int().min(1).max(D.pageEvents),
    kinds: z.array(DiagnosticKindSchema).max(7).optional(),
  },
  diagnostic_reference: { topic: DiagnosticTopicSchema },
} as const satisfies Record<string, z.ZodRawShape>;
export type DiagnosticActionName = keyof typeof DIAGNOSTIC_ACTIONS;
export const DiagnosticActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("diagnostic_status"), args: z.object(DIAGNOSTIC_ACTIONS.diagnostic_status).strict() }).strict(),
  z.object({ name: z.literal("diagnostic_events"), args: z.object(DIAGNOSTIC_ACTIONS.diagnostic_events).strict() }).strict(),
  z.object({ name: z.literal("diagnostic_reference"), args: z.object(DIAGNOSTIC_ACTIONS.diagnostic_reference).strict() }).strict(),
]);

// ---- Debug chat --------------------------------------------------------------------------------

/** Independent of zone epochs, input tokens and learning sessions. */
export type DebugBinding = { debugSessionId: string; debugEpoch: string; requestId: string };
export type DebugEntry = { id: number; from: "you" | "dum" | "notice"; text: string };
/**
 * Debug chat as Settings shows it. `binding` names the running request while `state` is busy, else
 * the next one. In memory only: at most 100 entries / 128 KiB, oldest dropped with a notice.
 */
export type DebugView = {
  binding: DebugBinding;
  state: "idle" | "busy" | "needs-backend" | "expired";
  entries: DebugEntry[];
  dropped: number;
  expiresAt: string;
};

export const DebugBindingSchema = z.object({ debugSessionId: IdSchema, debugEpoch: TokenSchema, requestId: TokenSchema }).strict() satisfies z.ZodType<DebugBinding>;
/** One debug question: typed, at most 8 KiB. */
export const DebugTextSchema = z.string().min(1).refine((s) => encoder.encode(s).length <= D.debugTextBytes && s.trim().length > 0, "is empty or too long");
export const DebugEntrySchema = z.object({
  id: count,
  from: z.enum(["you", "dum", "notice"]),
  text: z.string().refine((s) => encoder.encode(s).length <= D.debugTextBytes, "is too long"),
}).strict() satisfies z.ZodType<DebugEntry>;
export const DebugViewSchema = z.object({
  binding: DebugBindingSchema,
  state: z.enum(["idle", "busy", "needs-backend", "expired"]),
  entries: z.array(DebugEntrySchema).max(D.debugEntries).refine((list) => jsonBytes(list) <= D.debugBytes, "debug history is too large"),
  dropped: count,
  expiresAt: IsoSchema,
}).strict() satisfies z.ZodType<DebugView>;

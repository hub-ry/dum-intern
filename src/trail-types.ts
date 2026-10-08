// Sessions, trails and the goal-relative story (docs/circle-design.md §4). Data and schemas only.
// A trail is an ordered chain of skill visits with decision and result markers: supporting
// observations, never competency evidence, a prerequisite graph or authority of any kind.

import { z } from "zod";
import { CursorSchema } from "./delegation-types.ts";
import { Proof2Schema } from "./evidence-types.ts";
import { IdSchema, RequestBindingSchema, TokenSchema } from "./share-types.ts";
import { IsoSchema, SkillRefSchema, ZoneGoalSchema, ZoneNameSchema } from "./zone-types.ts";
import type { Proof2 } from "./evidence-types.ts";
import type { RequestBinding } from "./share-types.ts";
import type { SkillRef, ZoneId } from "./zone-types.ts";

export const TRAIL_LIMITS = {
  metaBytes: 32768,
  indexIds: 128,
  indexBytes: 32768,
  pageEvents: 128,
  pageBytes: 262144,
  sourceBytes: 16384,
  excerptBytes: 2048,
  proofBytes: 8192,
  /** Source refs on one step; further sources become touches. */
  stepSources: 16,
  storyRows: 128,
  storyBytes: 262144,
  preview: 32,
  /** One query reply. */
  queryRows: 50,
  queryBytes: 262144,
  /** Inline trail: the latest six visits. */
  recentVisits: 6,
  recentMarkers: 12,
  recentGaps: 6,
  hints: 3,
  topicChars: 160,
  reasonChars: 240,
  /** Look notes are one sentence. */
  observationChars: 280,
  /** Inferred hints become visits only at or above this claimed confidence. */
  inferredConfidence: 0.8,
} as const;

const T = TRAIL_LIMITS;
const encoder = new TextEncoder();
const jsonBytes = (v: unknown) => encoder.encode(JSON.stringify(v)).length;
const CONTROL = /[\u0000-\u001f\u007f]/;
const line = (max: number) => z.string().max(max).refine((s) => !CONTROL.test(s), "has control characters");
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Why a session ended. A host crash is closed as `interrupted` on restart. */
export type EndReason =
  | "leave" | "delete" | "new-session" | "idle" | "sleep" | "quit" | "reconfigure" | "switch-attempt" | "interrupted";
export const EndReasonSchema = z.enum([
  "leave", "delete", "new-session", "idle", "sleep", "quit", "reconfigure", "switch-attempt", "interrupted",
]) satisfies z.ZodType<EndReason>;

/** One topic a look or a conversation reported, mapped to a catalog skill or left unmapped. */
export type TopicHint = { topic: string; skill: SkillRef | null; confidence: number; reason: string };
export const TopicHintSchema = z.object({
  topic: line(T.topicChars).min(1),
  skill: SkillRefSchema.nullable(),
  confidence: z.number().min(0).max(1),
  reason: line(T.reasonChars),
}).strict() satisfies z.ZodType<TopicHint>;
export const TopicHintsSchema = z.array(TopicHintSchema).max(T.hints);

export type SessionMeta = {
  version: 1;
  id: string;
  zoneId: ZoneId;
  zoneName: string;
  goal: string;
  /** The agreed revision at start; later changes are direction markers. */
  directionId: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: EndReason | null;
  lastActivityAt: string;
  revision: number;
  eventPages: number;
  eventCount: number;
  latestObservation: { sourceId: string; text: string; at: string } | null;
};
export type TrailOrigin = "look" | "conversation" | "artifact" | "user-map";
export type TrailMapping = "exact" | "inferred" | "user";
export type TrailStep = {
  id: string;
  skill: SkillRef;
  firstSeenAt: string;
  lastSeenAt: string;
  directionId: string | null;
  origin: TrailOrigin;
  mapping: TrailMapping;
  topic: string;
  reason: string;
  sourceIds: string[];
  /** The earlier visit this one returns to: a dashed revisit link. */
  revisitOf: string | null;
};
export type HandoffPhase = "commanded" | "done" | "blocked" | "failed" | "cancelled" | "interrupted" | "reviewed";
export type TrailEvent =
  | { seq: number; at: string; kind: "visit"; step: TrailStep }
  | { seq: number; at: string; kind: "touch"; stepId: string; sourceId: string | null }
  | { seq: number; at: string; kind: "gap"; id: string; topic: string; sourceId: string }
  | { seq: number; at: string; kind: "map-gap"; gapId: string; step: TrailStep }
  | { seq: number; at: string; kind: "direction"; directionId: string; previousId: string | null }
  | {
    seq: number; at: string; kind: "handoff"; handoffId: string; revision: number; phase: HandoffPhase;
    directionId: string | null; sourceIds: string[];
  };
/** Existing validated evidence as it was, without files or paths: readable, never current permission. */
export type RetainedProof = Omit<Proof2, "files">;
export type TrailSourceKind = "look" | "conversation" | "evidence" | "change" | "project" | "handoff";
/** Retained link material for a visit or marker: a supporting observation, not competency evidence. */
export type TrailSource = {
  version: 1;
  id: string;
  sessionId: string;
  at: string;
  kind: TrailSourceKind;
  excerpt: string;
  entryId: number | null;
  requestId: string | null;
  evidenceId: string | null;
  changeId: string | null;
  handoffId: string | null;
  proof: RetainedProof | null;
};
export type StoryRow = {
  sessionId: string;
  zoneId: ZoneId;
  startedAt: string;
  endedAt: string | null;
  directionId: string | null;
  sourceRevision: number;
  visits: number;
  gaps: number;
  handoffsDone: number;
  handoffsReviewed: number;
  preview: SkillRef[];
  /** Distinct skills beyond `preview`. */
  previewMore: number;
};

// On-disk headers and pages.
export type SessionIndex = { version: 1; pages: number; sessions: number; activeSessionId: string | null };
export type SessionIndexPage = { version: 1; page: number; ids: string[] };
export type EventPage = { version: 1; sessionId: string; page: number; events: TrailEvent[] };
export type StoryHead = { version: 1; generation: string; pages: number; revision: number };
export type StoryCachePage = { version: 1; generation: string; page: number; rows: StoryRow[] };

// Trails service inputs: host-issued id/session/time are added by Trails.
export type TrailSourceInput = Omit<TrailSource, "version" | "id" | "sessionId" | "at">;
export type DecisionEventInput =
  | { kind: "direction"; directionId: string; previousId: string | null }
  | { kind: "handoff"; handoffId: string; revision: number; phase: HandoffPhase; directionId: string | null; sourceIds: string[] };

// Read models.
type Marker = Extract<TrailEvent, { kind: "direction" | "handoff" }>;
type Gap = Extract<TrailEvent, { kind: "gap" }>;
/** The inline trail: the latest six visits, bounded markers and unmapped gaps, in order. */
export type TrailView = {
  sessionId: string;
  zoneId: ZoneId;
  directionId: string | null;
  visits: TrailStep[];
  markers: Marker[];
  gaps: Gap[];
  eventCount: number;
};
export type TrailQuery = { zoneId: ZoneId; sessionId: string; cursor: string | null };
export type TrailPage = { session: SessionMeta; events: TrailEvent[]; next: string | null };
export type StoryQuery = { zoneId: ZoneId | null; skill: SkillRef | null; from: string | null; to: string | null; cursor: string | null };
export type StoryPage = { rows: StoryRow[]; next: string | null };
export type TrailMapInput = { binding: RequestBinding; sessionId: string; gapId: string; skill: SkillRef };

export const SessionMetaSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  zoneId: IdSchema,
  zoneName: ZoneNameSchema,
  goal: ZoneGoalSchema,
  directionId: IdSchema.nullable(),
  startedAt: IsoSchema,
  endedAt: IsoSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
  lastActivityAt: IsoSchema,
  revision: index,
  eventPages: index,
  eventCount: index,
  latestObservation: z.object({ sourceId: IdSchema, text: line(T.observationChars).min(1), at: IsoSchema }).strict().nullable(),
}).strict()
  .refine((m) => (m.endedAt === null) === (m.endReason === null), "an ended session has a reason")
  .refine((m) => jsonBytes(m) <= T.metaBytes, "session meta is too large") satisfies z.ZodType<SessionMeta>;

export const TrailStepSchema = z.object({
  id: IdSchema,
  skill: SkillRefSchema,
  firstSeenAt: IsoSchema,
  lastSeenAt: IsoSchema,
  directionId: IdSchema.nullable(),
  origin: z.enum(["look", "conversation", "artifact", "user-map"]),
  mapping: z.enum(["exact", "inferred", "user"]),
  topic: line(T.topicChars),
  reason: line(T.reasonChars),
  sourceIds: z.array(IdSchema).max(T.stepSources),
  revisitOf: IdSchema.nullable(),
}).strict()
  .refine((s) => (s.origin === "user-map") === (s.mapping === "user"), "only a user mapping is user-mapped")
  .refine((s) => s.firstSeenAt <= s.lastSeenAt, "last seen before first seen") satisfies z.ZodType<TrailStep>;

export const HandoffPhaseSchema = z.enum(["commanded", "done", "blocked", "failed", "cancelled", "interrupted", "reviewed"]) satisfies z.ZodType<HandoffPhase>;

const stamp = { seq: index, at: IsoSchema };
const directionEvent = { kind: z.literal("direction"), directionId: IdSchema, previousId: IdSchema.nullable() };
const handoffEvent = {
  kind: z.literal("handoff"), handoffId: IdSchema, revision: index, phase: HandoffPhaseSchema,
  directionId: IdSchema.nullable(), sourceIds: z.array(IdSchema).max(T.stepSources),
};
const DirectionMarkerSchema = z.object({ ...stamp, ...directionEvent }).strict();
const HandoffMarkerSchema = z.object({ ...stamp, ...handoffEvent }).strict();
const GapSchema = z.object({ ...stamp, kind: z.literal("gap"), id: IdSchema, topic: line(T.topicChars).min(1), sourceId: IdSchema }).strict();

export const TrailEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...stamp, kind: z.literal("visit"), step: TrailStepSchema }).strict(),
  z.object({ ...stamp, kind: z.literal("touch"), stepId: IdSchema, sourceId: IdSchema.nullable() }).strict(),
  GapSchema,
  z.object({ ...stamp, kind: z.literal("map-gap"), gapId: IdSchema, step: TrailStepSchema }).strict(),
  DirectionMarkerSchema,
  HandoffMarkerSchema,
]) satisfies z.ZodType<TrailEvent>;

export const DecisionEventInputSchema = z.discriminatedUnion("kind", [
  z.object(directionEvent).strict(),
  z.object(handoffEvent).strict(),
]) satisfies z.ZodType<DecisionEventInput>;

export const RetainedProofSchema = Proof2Schema.omit({ files: true })
  .refine((p) => jsonBytes(p) <= T.proofBytes, "proof is too large") satisfies z.ZodType<RetainedProof>;

const sourceFields = {
  kind: z.enum(["look", "conversation", "evidence", "change", "project", "handoff"]),
  excerpt: z.string().refine((s) => encoder.encode(s).length <= T.excerptBytes, "excerpt is too long"),
  entryId: z.number().int().nonnegative().nullable(),
  requestId: TokenSchema.nullable(),
  evidenceId: IdSchema.nullable(),
  changeId: IdSchema.nullable(),
  handoffId: IdSchema.nullable(),
  proof: RetainedProofSchema.nullable(),
};
/** Evidence and change sources name what they link to; only an evidence source retains a proof. */
const linked = (s: { kind: TrailSourceKind; evidenceId: string | null; changeId: string | null; handoffId: string | null; proof: RetainedProof | null }) =>
  (s.kind !== "evidence" || s.evidenceId !== null) && (s.kind !== "change" || s.changeId !== null)
  && (s.kind !== "handoff" || s.handoffId !== null) && (s.proof === null || (s.kind === "evidence" && s.proof.id === s.evidenceId));
export const TrailSourceSchema = z.object({ version: z.literal(1), id: IdSchema, sessionId: IdSchema, at: IsoSchema, ...sourceFields }).strict()
  .refine(linked, "source links don't match its kind")
  .refine((s) => jsonBytes(s) <= T.sourceBytes, "source is too large") satisfies z.ZodType<TrailSource>;
export const TrailSourceInputSchema = z.object(sourceFields).strict().refine(linked, "source links don't match its kind") satisfies z.ZodType<TrailSourceInput>;

export const StoryRowSchema = z.object({
  sessionId: IdSchema,
  zoneId: IdSchema,
  startedAt: IsoSchema,
  endedAt: IsoSchema.nullable(),
  directionId: IdSchema.nullable(),
  sourceRevision: index,
  visits: index,
  gaps: index,
  handoffsDone: index,
  handoffsReviewed: index,
  preview: z.array(SkillRefSchema).max(T.preview),
  previewMore: index,
}).strict() satisfies z.ZodType<StoryRow>;

export const SessionIndexSchema = z.object({ version: z.literal(1), pages: index, sessions: index, activeSessionId: IdSchema.nullable() }).strict() satisfies z.ZodType<SessionIndex>;
export const SessionIndexPageSchema = z.object({ version: z.literal(1), page: index, ids: z.array(IdSchema).max(T.indexIds) }).strict()
  .refine((p) => jsonBytes(p) <= T.indexBytes, "index page is too large") satisfies z.ZodType<SessionIndexPage>;
export const EventPageSchema = z.object({ version: z.literal(1), sessionId: IdSchema, page: index, events: z.array(TrailEventSchema).max(T.pageEvents) }).strict()
  .refine((p) => p.events.every((e, i) => i === 0 || e.seq > p.events[i - 1]!.seq), "events out of order")
  .refine((p) => jsonBytes(p) <= T.pageBytes, "event page is too large") satisfies z.ZodType<EventPage>;
export const StoryHeadSchema = z.object({ version: z.literal(1), generation: IdSchema, pages: index, revision: index }).strict() satisfies z.ZodType<StoryHead>;
export const StoryCachePageSchema = z.object({ version: z.literal(1), generation: IdSchema, page: index, rows: z.array(StoryRowSchema).max(T.storyRows) }).strict()
  .refine((p) => jsonBytes(p) <= T.storyBytes, "story page is too large") satisfies z.ZodType<StoryCachePage>;

export const TrailViewSchema = z.object({
  sessionId: IdSchema,
  zoneId: IdSchema,
  directionId: IdSchema.nullable(),
  visits: z.array(TrailStepSchema).max(T.recentVisits),
  markers: z.array(z.discriminatedUnion("kind", [DirectionMarkerSchema, HandoffMarkerSchema])).max(T.recentMarkers),
  gaps: z.array(GapSchema).max(T.recentGaps),
  eventCount: index,
}).strict() satisfies z.ZodType<TrailView>;

export const TrailQuerySchema = z.object({ zoneId: IdSchema, sessionId: IdSchema, cursor: CursorSchema.nullable() }).strict() satisfies z.ZodType<TrailQuery>;
export const TrailPageSchema = z.object({ session: SessionMetaSchema, events: z.array(TrailEventSchema).max(T.queryRows), next: CursorSchema.nullable() }).strict()
  .refine((p) => jsonBytes(p) <= T.queryBytes, "trail page is too large") satisfies z.ZodType<TrailPage>;
export const StoryQuerySchema = z.object({
  zoneId: IdSchema.nullable(),
  skill: SkillRefSchema.nullable(),
  from: IsoSchema.nullable(),
  to: IsoSchema.nullable(),
  cursor: CursorSchema.nullable(),
}).strict().refine((q) => q.from === null || q.to === null || q.from <= q.to, "the range ends before it starts") satisfies z.ZodType<StoryQuery>;
export const StoryPageSchema = z.object({ rows: z.array(StoryRowSchema).max(T.queryRows), next: CursorSchema.nullable() }).strict()
  .refine((p) => jsonBytes(p) <= T.queryBytes, "story page is too large") satisfies z.ZodType<StoryPage>;
export const TrailMapInputSchema = z.object({ binding: RequestBindingSchema, sessionId: IdSchema, gapId: IdSchema, skill: SkillRefSchema }).strict() satisfies z.ZodType<TrailMapInput>;

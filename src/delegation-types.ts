// Delegation (docs/circle-design.md §3, §4, §9): a zone's goal alignment and agreed direction, the
// Wizard's decision cards, the handoff the user commands, and what Dum used to decide. Data and
// schemas only. IDs, times, hashes and revisions are host-issued; every schema is strict and bounded.
// None of these records is permission: selecting, accepting or editing writes no source file and
// proves no skill (docs/architecture.md rules 1 and 6).

import { z } from "zod";
import { IdSchema, RequestBindingSchema, ResourcePathSchema, TokenSchema } from "./share-types.ts";
import { IsoSchema, LanguageSchema, ShaSchema, SkillRefSchema, ZoneGoalSchema } from "./zone-types.ts";
import type { RequestBinding, ResourcePath, ShareGrant } from "./share-types.ts";
import type { SharedImage } from "./store-types.ts";
import type { SkillRef, ZoneId } from "./zone-types.ts";

export const DELEGATION_LIMITS = {
  /** UTF-8 bytes of any free-text field except goals and labels. */
  textBytes: 2048,
  labelChars: 160,
  options: 3,
  questions: 2,
  assumptions: 8,
  blockers: 8,
  contextRefs: 16,
  excerptBytes: 512,
  skills: 32,
  /** Canonical skill candidates the host offers one decision. */
  candidates: 128,
  targets: 16,
  changeIds: 32,
  /** Direction revision, direction head, corrections and handoff version files. */
  recordBytes: 32768,
  handoffHeadBytes: 16384,
  /** One page of the Using inventory. */
  inventoryRefs: 50,
  inventoryBytes: 32768,
  cursorChars: 512,
} as const;

const L = DELEGATION_LIMITS;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;
const jsonBytes = (v: unknown) => bytes(JSON.stringify(v));
/** Free text: at most `max` UTF-8 bytes, no control characters but newline and tab. */
const text = (max: number = L.textBytes) => z.string().refine((s) => bytes(s) <= max && !CONTROL.test(s), "is too long or has control characters");
/** Free text that must say something. */
const required = (max: number = L.textBytes) => text(max).refine((s) => s.trim().length > 0, "is empty");
const label = z.string().min(1).max(L.labelChars).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "has control characters");
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unique = <T>(key: (v: T) => string) => (list: readonly T[]) => new Set(list.map(key)).size === list.length;
const skills = z.array(SkillRefSchema).max(L.skills)
  .refine(unique((s: SkillRef) => `${s.name.toLowerCase()}\u0000${s.lang.toLowerCase()}`), "repeats a skill");
const contextIds = z.array(IdSchema).max(L.contextRefs).refine(unique((id: string) => id), "repeats a context id");

/** Opaque host-issued paging cursor; never a path. */
export const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, "not a cursor");

// ---- Context: what Dum used, as host-issued references -------------------------------------

export type ContextRefKind =
  | "goal" | "direction" | "zone-note" | "memory" | "personal" | "look" | "conversation" | "skill" | "evidence" | "share";
/** One input a decision or request used. Producers issue refs; a model can only cite ids it was given. */
export type ContextRef = {
  id: string;
  kind: ContextRefKind;
  label: string;
  /** Content digest of the source as it was used. */
  revision: string;
  /** When the source was observed or written, when known. */
  at: string | null;
  excerpt: string;
};

export const ContextRefKindSchema = z.enum([
  "goal", "direction", "zone-note", "memory", "personal", "look", "conversation", "skill", "evidence", "share",
]) satisfies z.ZodType<ContextRefKind>;

export const ContextRefSchema = z.object({
  id: IdSchema,
  kind: ContextRefKindSchema,
  label,
  revision: ShaSchema,
  at: IsoSchema.nullable(),
  excerpt: text(L.excerptBytes),
}).strict() satisfies z.ZodType<ContextRef>;

/** At most 16 distinct refs; at 512 bytes each, their excerpts stay within 8 KiB. */
export const ContextListSchema = z.array(ContextRefSchema).max(L.contextRefs)
  .refine(unique((r: ContextRef) => r.id), "repeats a context ref");

/** Every id the options cite is one of the supplied refs: unsupported refs reject. */
const cited = (v: { options: readonly { contextIds: readonly string[] }[]; context: readonly ContextRef[] }) => {
  const known = new Set(v.context.map((r) => r.id));
  return v.options.every((o) => o.contextIds.every((id) => known.has(id)));
};
const CITED = "cites context it wasn't given";

// ---- Goal alignment and the agreed direction --------------------------------------------------

/** A project or decision that would advance a zone's goal, and the skills it builds. */
export type DirectionOption = {
  id: string;
  kind: "project" | "decision";
  title: string;
  builds: SkillRef[];
  advancesGoal: string;
  contextIds: string[];
  tradeoff: string;
};
/** An approved, immutable direction revision. Intent only: no schedule, no write permission. */
export type Direction = {
  version: 1;
  id: string;
  zoneId: ZoneId;
  at: string;
  /** Provenance snapshot; the registry stays the only owner of goal text. */
  goal: string;
  /** Lowercase SHA-256 hex of the goal's UTF-8 bytes; compared with the registry goal on every read. */
  goalHash: string;
  /** The context revision it was agreed under; a later one shows "Context changed - review direction". */
  contextRevision: string;
  supersedes: string | null;
  ability: string;
  choice: DirectionOption;
  reviewCriterion: string;
  assumptions: string[];
  context: ContextRef[];
};
export type AlignmentQuestion = { id: string; text: string; changesPlan: string; answer: string | null };
export type AlignmentPhase = "reflect" | "clarify" | "choose" | "deferred" | "needs-backend";
/** The zone's one pending attempt: reflection, at most two consequential questions, at most three options. */
export type AlignmentAttempt = {
  id: string;
  goalHash: string;
  contextRevision: string;
  phase: AlignmentPhase;
  reflection: string;
  questions: AlignmentQuestion[];
  options: DirectionOption[];
  context: ContextRef[];
};
export type DirectionHead = {
  version: 1;
  revision: number;
  goalHash: string;
  currentId: string | null;
  attempt: AlignmentAttempt | null;
};
export type ContextCorrections = { version: 1; revision: number; ignoredObservationSourceId: string | null };

/** What the user accepts, under the attempt's context revision; the host adds id, zone, time, goal snapshot and supersedes. */
export type DirectionInput = Pick<Direction, "contextRevision" | "ability" | "choice" | "reviewCriterion" | "assumptions" | "context">;

/** Binds alignment work to one zone's goal and revisions, separately from active-zone input. */
export type AlignmentBinding = {
  zoneId: ZoneId;
  zoneRevision: number;
  goalHash: string;
  attemptId: string;
  directionRevision: number;
  contextRevision: string;
};
/**
 * A zone's alignment as the window shows it. `binding` names the pending attempt, or the next one
 * the host will start. `status` is computed after the goal-fingerprint check: a direction for an
 * older goal is never `current`.
 */
export type DirectionView = {
  zoneId: ZoneId;
  goalHash: string;
  status: "aligned" | "needed" | "aligning" | "deferred" | "needs-backend";
  current: Direction | null;
  attempt: AlignmentAttempt | null;
  binding: AlignmentBinding;
  /** Context revision moved since `current` was agreed: "Context changed - review direction". */
  contextChanged: boolean;
};

export const DirectionOptionSchema = z.object({
  id: IdSchema,
  kind: z.enum(["project", "decision"]),
  title: label,
  builds: skills,
  advancesGoal: required(),
  contextIds,
  tradeoff: required(),
}).strict() satisfies z.ZodType<DirectionOption>;

export const DirectionSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  zoneId: IdSchema,
  at: IsoSchema,
  goal: ZoneGoalSchema,
  goalHash: ShaSchema,
  supersedes: IdSchema.nullable(),
  contextRevision: ShaSchema,
  ability: required(),
  choice: DirectionOptionSchema,
  reviewCriterion: required(),
  assumptions: z.array(required()).max(L.assumptions),
  context: ContextListSchema,
}).strict()
  .refine((d) => cited({ options: [d.choice], context: d.context }), CITED)
  .refine((d) => jsonBytes(d) <= L.recordBytes, "direction is too large") satisfies z.ZodType<Direction>;

export const AlignmentQuestionSchema = z.object({
  id: IdSchema,
  text: required(),
  changesPlan: required(),
  answer: text().nullable(),
}).strict() satisfies z.ZodType<AlignmentQuestion>;

export const AlignmentPhaseSchema = z.enum(["reflect", "clarify", "choose", "deferred", "needs-backend"]) satisfies z.ZodType<AlignmentPhase>;

export const AlignmentAttemptSchema = z.object({
  id: IdSchema,
  goalHash: ShaSchema,
  contextRevision: ShaSchema,
  phase: AlignmentPhaseSchema,
  reflection: text(),
  questions: z.array(AlignmentQuestionSchema).max(L.questions).refine(unique((q: AlignmentQuestion) => q.id), "repeats a question"),
  options: z.array(DirectionOptionSchema).max(L.options).refine(unique((o: DirectionOption) => o.id), "repeats an option"),
  context: ContextListSchema,
}).strict().refine(cited, CITED) satisfies z.ZodType<AlignmentAttempt>;

export const DirectionHeadSchema = z.object({
  version: z.literal(1),
  revision,
  goalHash: ShaSchema,
  currentId: IdSchema.nullable(),
  attempt: AlignmentAttemptSchema.nullable(),
}).strict().refine((h) => jsonBytes(h) <= L.recordBytes, "direction head is too large") satisfies z.ZodType<DirectionHead>;

export const ContextCorrectionsSchema = z.object({
  version: z.literal(1),
  revision,
  ignoredObservationSourceId: IdSchema.nullable(),
}).strict() satisfies z.ZodType<ContextCorrections>;

export const DirectionInputSchema = z.object({
  contextRevision: ShaSchema,
  ability: required(),
  choice: DirectionOptionSchema,
  reviewCriterion: required(),
  assumptions: z.array(required()).max(L.assumptions),
  context: ContextListSchema,
}).strict().refine((d) => cited({ options: [d.choice], context: d.context }), CITED) satisfies z.ZodType<DirectionInput>;

export const AlignmentBindingSchema = z.object({
  zoneId: IdSchema,
  zoneRevision: revision,
  goalHash: ShaSchema,
  attemptId: IdSchema,
  directionRevision: revision,
  contextRevision: ShaSchema,
}).strict() satisfies z.ZodType<AlignmentBinding>;

export const DirectionViewSchema = z.object({
  zoneId: IdSchema,
  goalHash: ShaSchema,
  status: z.enum(["aligned", "needed", "aligning", "deferred", "needs-backend"]),
  current: DirectionSchema.nullable(),
  attempt: AlignmentAttemptSchema.nullable(),
  binding: AlignmentBindingSchema,
  contextChanged: z.boolean(),
}).strict()
  .refine((v) => v.binding.zoneId === v.zoneId && v.binding.goalHash === v.goalHash, "binding names another zone or goal")
  .refine((v) => v.current === null || (v.current.zoneId === v.zoneId && v.current.goalHash === v.goalHash), "a direction for another zone or goal is never current")
  .refine((v) => v.status !== "aligned" || v.current !== null, "aligned needs a current direction")
  .refine((v) => v.attempt === null || (v.attempt.id === v.binding.attemptId && v.attempt.goalHash === v.goalHash), "attempt doesn't match the binding") satisfies z.ZodType<DirectionView>;

// ---- Alignment requests (renderer → main → host, without wire fields) ------------------------

/** answer needs its question and text; start, revise and defer carry neither. */
export type AlignmentStepInput =
  | { binding: AlignmentBinding; action: "answer"; questionId: string; text: string }
  | { binding: AlignmentBinding; action: "start" | "revise" | "defer" };
/**
 * Use this direction (`choiceId`) or Use my own direction (`ownDirection`, with `choiceId` null):
 * exactly one. Silence is never acceptance.
 */
export type AlignmentAcceptInput = {
  binding: AlignmentBinding;
  choiceId: string | null;
  ability: string;
  reviewCriterion: string;
  assumptions: string[];
  ownDirection?: DirectionOption;
};

export const AlignmentAnswerSchema = z.object({
  binding: AlignmentBindingSchema,
  action: z.literal("answer"),
  questionId: IdSchema,
  text: required(),
}).strict();
export const AlignmentMoveSchema = z.object({
  binding: AlignmentBindingSchema,
  action: z.enum(["start", "revise", "defer"]),
}).strict();
export const AlignmentStepInputSchema = z.discriminatedUnion("action", [AlignmentAnswerSchema, AlignmentMoveSchema]) satisfies z.ZodType<AlignmentStepInput>;

/** Wire schemas extend this; zod carries the exactly-one refinement into each extension. */
export const AlignmentAcceptInputSchema = z.object({
  binding: AlignmentBindingSchema,
  choiceId: IdSchema.nullable(),
  ability: required(),
  reviewCriterion: required(),
  assumptions: z.array(required()).max(L.assumptions),
  ownDirection: DirectionOptionSchema.optional(),
}).strict()
  .refine((a) => (a.choiceId === null) === (a.ownDirection !== undefined), "accept either one offered option or your own direction") satisfies z.ZodType<AlignmentAcceptInput>;

// ---- Wizard decision cards ------------------------------------------------------------------

/** Host-computed against the live gate; the model never decides eligibility. */
export type Eligibility = "can-delegate" | "learn-first" | "needs-detail";
export type DelegationOption = {
  id: string;
  task: string;
  expectedResult: string;
  review: string;
  skills: SkillRef[];
  advancesOutcome: string;
  contextIds: string[];
  tradeoff: string;
  eligibility: Eligibility;
  /** Learn first: the smallest missing skill and its suggested project. Needs detail: what's missing. */
  blockers: string[];
};
export type DecisionQuestion = { id: string; text: string; changesPlan: string };
/**
 * The one latest card for an outcome, in host memory only. `reflection` and `questions` are Dum's
 * reading of the outcome shown above the options; dismissal, revision or Stop invalidates the card.
 */
export type DecisionView = {
  id: string;
  revision: number;
  outcome: string;
  contextRevision: string;
  directionId: string | null;
  reflection: string;
  questions: DecisionQuestion[];
  options: DelegationOption[];
  context: ContextRef[];
};

export const EligibilitySchema = z.enum(["can-delegate", "learn-first", "needs-detail"]) satisfies z.ZodType<Eligibility>;

const delegationFields = {
  id: IdSchema,
  task: required(),
  expectedResult: required(),
  review: required(),
  skills,
  advancesOutcome: required(),
  contextIds,
  tradeoff: required(),
};
export const DelegationOptionSchema = z.object({
  ...delegationFields,
  eligibility: EligibilitySchema,
  blockers: z.array(required(512)).max(L.blockers),
}).strict()
  .refine((o) => o.eligibility === "can-delegate" ? o.blockers.length === 0 : o.blockers.length > 0, "blockers must match eligibility") satisfies z.ZodType<DelegationOption>;

export const DecisionQuestionSchema = z.object({ id: IdSchema, text: required(), changesPlan: required() }).strict() satisfies z.ZodType<DecisionQuestion>;

export const DecisionViewSchema = z.object({
  id: IdSchema,
  revision,
  outcome: required(),
  contextRevision: ShaSchema,
  directionId: IdSchema.nullable(),
  reflection: text(),
  questions: z.array(DecisionQuestionSchema).max(L.questions),
  options: z.array(DelegationOptionSchema).max(L.options).refine(unique((o: DelegationOption) => o.id), "repeats an option"),
  context: ContextListSchema,
}).strict().refine(cited, CITED) satisfies z.ZodType<DecisionView>;

/** What the action-free helper is given: host-selected, at most 16 refs, typed moment. */
export type DecisionInput = {
  moment: "alignment" | "delegation";
  goal: string;
  /** The concrete outcome for a delegation; null while aligning on the goal. */
  outcome: string | null;
  language: string;
  /** The agreed direction, or the last agreement as Revise's labeled starting point. */
  direction: Direction | null;
  /** Answers to this attempt's consequential questions. */
  answers: { question: string; answer: string }[];
  context: ContextRef[];
  candidates: SkillRef[];
};
/** A proposed delegation before the host computes eligibility; `needs` names a missing material detail. */
export type DelegationProposal = Omit<DelegationOption, "eligibility" | "blockers"> & { needs: string | null };
/**
 * The helper's validated cards. Catalog anchors are rendered into `tradeoff` from the catalog's own
 * claim and URL; a model never supplies a URL or a context ref it wasn't given.
 */
export type DecisionResult =
  | { moment: "alignment"; reflection: string; questions: DecisionQuestion[]; options: DirectionOption[] }
  | { moment: "delegation"; reflection: string; questions: DecisionQuestion[]; options: DelegationProposal[] };

export const DecisionInputSchema = z.object({
  moment: z.enum(["alignment", "delegation"]),
  goal: ZoneGoalSchema,
  outcome: required().nullable(),
  language: LanguageSchema,
  direction: DirectionSchema.nullable(),
  answers: z.array(z.object({ question: required(), answer: required() }).strict()).max(L.questions),
  context: ContextListSchema,
  candidates: z.array(SkillRefSchema).max(L.candidates),
}).strict().refine((d) => (d.moment === "delegation") === (d.outcome !== null), "a delegation needs an outcome; alignment has none") satisfies z.ZodType<DecisionInput>;

export const DelegationProposalSchema = z.object({ ...delegationFields, needs: required(512).nullable() }).strict() satisfies z.ZodType<DelegationProposal>;

const resultFields = {
  reflection: required(),
  questions: z.array(DecisionQuestionSchema).max(L.questions),
};
export const DecisionResultSchema = z.discriminatedUnion("moment", [
  z.object({ moment: z.literal("alignment"), ...resultFields, options: z.array(DirectionOptionSchema).max(L.options) }).strict(),
  z.object({ moment: z.literal("delegation"), ...resultFields, options: z.array(DelegationProposalSchema).max(L.options) }).strict(),
]) satisfies z.ZodType<DecisionResult>;

// ---- Handoffs ---------------------------------------------------------------------------------

/** One immutable handoff version: task, expected result and what the user reviews. */
export type Handoff = {
  version: 1;
  id: string;
  revision: number;
  zoneId: ZoneId;
  /** The durable learning session it was created in. */
  sessionId: string;
  directionId: string | null;
  goalHash: string;
  contextRevision: string;
  outcome: string;
  task: string;
  expectedResult: string;
  review: string;
  skills: SkillRef[];
  /** Broker-validated resource names it may change; never a path. */
  targets: ResourcePath[];
  context: ContextRef[];
};
export type HandoffState = "ready" | "running" | "done" | "blocked" | "failed" | "cancelled" | "interrupted" | "dismissed";
export type HandoffHead = {
  version: 1;
  id: string;
  revision: number;
  /** The request Do this started; null until commanded. */
  requestId: string | null;
  state: HandoffState;
  changeIds: string[];
  /** Orchestration's bounded report of what happened, never the model's claim of success. */
  result: string;
  reviewed: { at: string; verdict: string } | null;
};
/** A handoff as the window shows it. `needsRefresh`: its session, context or grants moved on. */
export type HandoffView = { handoff: Handoff; head: HandoffHead; needsRefresh: boolean; blockers: string[] };

/** What selection supplies; the host issues id and revision. */
export type HandoffInput = Omit<Handoff, "version" | "id" | "revision">;
/** Only the three texts are editable, at least one at a time. */
export type HandoffEdit = Partial<Pick<Handoff, "task" | "expectedResult" | "review">>;
/** How a commanded handoff ended, from orchestration and the change receipts. */
export type HandoffResult = { state: "done" | "blocked" | "failed" | "cancelled" | "interrupted"; changeIds: string[]; result: string };

const handoffFields = {
  zoneId: IdSchema,
  sessionId: IdSchema,
  directionId: IdSchema.nullable(),
  goalHash: ShaSchema,
  contextRevision: ShaSchema,
  outcome: required(),
  task: required(),
  expectedResult: required(),
  review: required(),
  skills,
  targets: z.array(ResourcePathSchema).max(L.targets).refine(unique((t: string) => t), "repeats a target"),
  context: ContextListSchema,
};
export const HandoffSchema = z.object({ version: z.literal(1), id: IdSchema, revision, ...handoffFields }).strict()
  .refine((h) => jsonBytes(h) <= L.recordBytes, "handoff is too large") satisfies z.ZodType<Handoff>;
export const HandoffInputSchema = z.object(handoffFields).strict()
  .refine((h) => jsonBytes(h) <= L.recordBytes, "handoff is too large") satisfies z.ZodType<HandoffInput>;

export const HandoffStateSchema = z.enum(["ready", "running", "done", "blocked", "failed", "cancelled", "interrupted", "dismissed"]) satisfies z.ZodType<HandoffState>;
const changeIds = z.array(IdSchema).max(L.changeIds).refine(unique((id: string) => id), "repeats a change");

export const HandoffHeadSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  revision,
  requestId: TokenSchema.nullable(),
  state: HandoffStateSchema,
  changeIds,
  result: text(),
  reviewed: z.object({ at: IsoSchema, verdict: required() }).strict().nullable(),
}).strict()
  .refine((h) => (h.state === "ready" || h.state === "dismissed") === (h.requestId === null), "only a commanded handoff has a request")
  .refine((h) => h.reviewed === null || h.state === "done" || h.state === "blocked" || h.state === "failed" || h.state === "cancelled" || h.state === "interrupted", "only a finished handoff is reviewed")
  .refine((h) => jsonBytes(h) <= L.handoffHeadBytes, "handoff head is too large") satisfies z.ZodType<HandoffHead>;

export const HandoffViewSchema = z.object({
  handoff: HandoffSchema,
  head: HandoffHeadSchema,
  needsRefresh: z.boolean(),
  blockers: z.array(required(512)).max(L.blockers),
}).strict().refine((v) => v.head.id === v.handoff.id, "head belongs to another handoff") satisfies z.ZodType<HandoffView>;

export const HandoffEditSchema = z.object({ task: required().optional(), expectedResult: required().optional(), review: required().optional() })
  .strict().refine((p) => Object.keys(p).length > 0, "changes nothing") satisfies z.ZodType<HandoffEdit>;

export const HandoffResultSchema = z.object({
  state: z.enum(["done", "blocked", "failed", "cancelled", "interrupted"]),
  changeIds,
  result: text(),
}).strict() satisfies z.ZodType<HandoffResult>;

// ---- Decision and handoff requests (without wire fields) -------------------------------------

export type DecisionHelpInput = { binding: RequestBinding; outcome: string };
export type DecisionDismissInput = { binding: RequestBinding; decisionId: string; revision: number };
export type HandoffSelectInput = { binding: RequestBinding; decisionId: string; revision: number; optionId: string };
export type HandoffEditInput = { binding: RequestBinding; handoffId: string; revision: number; patch: HandoffEdit };
export type HandoffDismissInput = { binding: RequestBinding; handoffId: string; revision: number };
export type HandoffReviewInput = { binding: RequestBinding; handoffId: string; revision: number; verdict: string };
/**
 * Do this, as the host receives it: main already checked the draft revision and consumed the
 * command once, and supplies the current authorized shares and picture exactly as Send does.
 */
export type HandoffRunInput = { binding: RequestBinding; handoffId: string; revision: number; shares: ShareGrant[]; image?: SharedImage };

export const DecisionHelpInputSchema = z.object({ binding: RequestBindingSchema, outcome: required() }).strict() satisfies z.ZodType<DecisionHelpInput>;
export const DecisionDismissInputSchema = z.object({ binding: RequestBindingSchema, decisionId: IdSchema, revision }).strict() satisfies z.ZodType<DecisionDismissInput>;
export const HandoffSelectInputSchema = z.object({ binding: RequestBindingSchema, decisionId: IdSchema, revision, optionId: IdSchema }).strict() satisfies z.ZodType<HandoffSelectInput>;
export const HandoffEditInputSchema = z.object({ binding: RequestBindingSchema, handoffId: IdSchema, revision, patch: HandoffEditSchema }).strict() satisfies z.ZodType<HandoffEditInput>;
export const HandoffDismissInputSchema = z.object({ binding: RequestBindingSchema, handoffId: IdSchema, revision }).strict() satisfies z.ZodType<HandoffDismissInput>;
export const HandoffReviewInputSchema = z.object({ binding: RequestBindingSchema, handoffId: IdSchema, revision, verdict: required() }).strict() satisfies z.ZodType<HandoffReviewInput>;

// ---- Current context: Using / Inspect / Correct -----------------------------------------------

export type ContextUseStatus = "used" | "omitted" | "missing" | "stale";
export type ContextUseItem = { ref: ContextRef; status: ContextUseStatus };
/**
 * The snapshot's summary of what the latest decision or request used: counts and a cursor to the
 * paged inventory, never file bodies.
 */
export type ContextUseView = {
  subject: { kind: "alignment" | "decision" | "request"; id: string } | null;
  contextRevision: string | null;
  correctionRevision: number;
  counts: Record<ContextUseStatus, number>;
  cursor: string | null;
};
export type ContextUsePage = { items: ContextUseItem[]; next: string | null };
export type IgnoreObservationInput = { binding: RequestBinding; sourceId: string; expectedCorrectionRevision: number };

export const ContextUseStatusSchema = z.enum(["used", "omitted", "missing", "stale"]) satisfies z.ZodType<ContextUseStatus>;
export const ContextUseItemSchema = z.object({ ref: ContextRefSchema, status: ContextUseStatusSchema }).strict() satisfies z.ZodType<ContextUseItem>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ContextUseViewSchema = z.object({
  subject: z.object({ kind: z.enum(["alignment", "decision", "request"]), id: TokenSchema }).strict().nullable(),
  contextRevision: ShaSchema.nullable(),
  correctionRevision: revision,
  counts: z.object({ used: count, omitted: count, missing: count, stale: count }).strict(),
  cursor: CursorSchema.nullable(),
}).strict() satisfies z.ZodType<ContextUseView>;
export const ContextUsePageSchema = z.object({
  items: z.array(ContextUseItemSchema).max(L.inventoryRefs),
  next: CursorSchema.nullable(),
}).strict().refine((p) => jsonBytes(p) <= L.inventoryBytes, "inventory page is too large") satisfies z.ZodType<ContextUsePage>;
export const IgnoreObservationInputSchema = z.object({
  binding: RequestBindingSchema,
  sourceId: IdSchema,
  expectedCorrectionRevision: revision,
}).strict() satisfies z.ZodType<IgnoreObservationInput>;

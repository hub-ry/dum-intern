// Main ↔ utility host. Every request carries {epoch, id, op}; both directions are strict and validated.
// The host owns zones, sessions, directions, handoffs, trails and every model call; main owns
// settings, credentials, circle placement and native surfaces.

import { z } from "zod";
import { AgentChoiceSchema, BackendIdSchema, LoginMethodSchema, ModelOptionSchema, PictureSchema, SelectorSchema } from "../agent/schema.ts";
import {
  AlignmentAcceptInputSchema, AlignmentAnswerSchema, AlignmentMoveSchema, ContextUsePageSchema, ContextUseViewSchema, CursorSchema,
  DecisionDismissInputSchema, DecisionHelpInputSchema, DecisionViewSchema, DirectionSchema, DirectionViewSchema, HandoffDismissInputSchema,
  HandoffEditInputSchema, HandoffReviewInputSchema, HandoffSelectInputSchema, HandoffViewSchema, IgnoreObservationInputSchema,
} from "../delegation-types.ts";
import { DebugBindingSchema, DebugTextSchema, DebugViewSchema, MainStatusSchema, SanitizedMainEventsSchema } from "../diagnostic-types.ts";
import { HostLookStatusSchema, TickSchema } from "../observe-types.ts";
import { IdSchema, InputBindingSchema, RequestBindingSchema, ShareGrantSchema, TokenSchema } from "../share-types.ts";
import {
  SessionMetaSchema, StoryPageSchema, StoryQuerySchema, TrailMapInputSchema, TrailPageSchema, TrailQuerySchema, TrailSourceSchema, TrailViewSchema,
} from "../trail-types.ts";
import { ChangeReceiptSchema, FollowGrantSchema, ShaSchema, SkillRefSchema, ZoneContextSchema, ZoneRegistrySchema, ZoneSchema } from "../zone-types.ts";
import {
  CommandNameSchema, ModeSchema, RecordSchema, RespondDecisionSchema, ShareKindSchema, SkillEditOpSchema, TreeSyncSchema, ViewNameSchema,
  ZoneContextTextSchema, ZoneCreateSchema, ZonePatchSchema, DesktopPreferencesSchema,
} from "./protocol.ts";
import type { CredentialNeed, ModelOption } from "../agent/types.ts";
import type { ContextUsePage, ContextUseView, DecisionView, Direction, DirectionView, HandoffView } from "../delegation-types.ts";
import type { DebugView } from "../diagnostic-types.ts";
import type { HostLookStatus } from "../observe-types.ts";
import type { ShareGrant } from "../share-types.ts";
import type { SessionMeta, StoryPage, TrailPage, TrailSource, TrailView } from "../trail-types.ts";
import type { ChangeReceipt, FollowGrant, Zone, ZoneContext, ZoneId, ZoneRegistry } from "../zone-types.ts";
import type { State } from "../store-types.ts";
import type { View } from "../web/view.ts";

const text = z.string().max(48 * 1024);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absolute = z.string().min(1).max(4096).refine((p) => p.startsWith("/") && !/[\u0000-\u001f]/.test(p), "not an absolute path");
const base = { epoch: TokenSchema, id: TokenSchema };
const op = <T extends string>(name: T) => ({ ...base, op: z.literal(name) });

/** A picture the user chose to share with one request, captured and checked by main. */
export const SharedImageSchema = z.object({
  data: PictureSchema.shape.data,
  mimeType: z.literal("image/png"),
  label: z.string().max(300),
}).strict();

export const PersonalSchema = z.object({ path: z.string().max(8192), text: z.string().max(64 * 1024), warning: z.string().max(8192) }).strict();

const shares = z.array(ShareGrantSchema).max(64);

export const HostRequestSchema = z.discriminatedUnion("op", [
  z.object({
    ...op("initialize"), home: absolute, claudeExecutable: absolute.nullable(),
    personal: PersonalSchema, settings: DesktopPreferencesSchema, main: MainStatusSchema,
  }).strict(),
  z.object({ ...op("zone-create"), zone: ZoneCreateSchema, enter: z.boolean() }).strict(),
  z.object({ ...op("zone-enter"), zoneId: IdSchema, expectedRevision: revision }).strict(),
  z.object({ ...op("zone-update"), zoneId: IdSchema, patch: ZonePatchSchema, expectedRevision: revision }).strict(),
  z.object({ ...op("zone-context"), zoneId: IdSchema, text: ZoneContextTextSchema, expectedRevision: revision }).strict(),
  z.object({ ...op("zone-delete"), zoneId: IdSchema, expectedRevision: revision }).strict(),
  z.object({ ...op("settings"), settings: DesktopPreferencesSchema }).strict(),
  z.object({ ...op("agent-select"), choice: AgentChoiceSchema.nullable() }).strict(),
  z.object({ ...op("agent-models"), backend: BackendIdSchema, login: LoginMethodSchema }).strict(),
  /** One real picture call that marks the selector's resolved model verified on this install. */
  z.object({ ...op("agent-verify-images"), selector: SelectorSchema, login: LoginMethodSchema }).strict(),
  z.object({
    ...op("credential"), requestId: TokenSchema,
    value: z.object({ value: z.string().min(1).max(16 * 1024), expiresAt: z.number().int().nonnegative().nullable() }).strict().nullable(),
  }).strict(),
  z.object({ ...op("send"), binding: RequestBindingSchema, text, shares, image: SharedImageSchema.optional() }).strict(),
  z.object({ ...op("respond"), binding: RequestBindingSchema, decision: RespondDecisionSchema }).strict(),
  z.object({ ...op("command"), name: CommandNameSchema, argument: z.string().max(4096), binding: RequestBindingSchema }).strict(),
  z.object({ ...op("view"), view: ViewNameSchema }).strict(),
  z.object({ ...op("share-add"), path: absolute, kind: ShareKindSchema, binding: RequestBindingSchema }).strict(),
  z.object({ ...op("share-remove"), shareId: IdSchema, binding: RequestBindingSchema }).strict(),
  z.object({ ...op("follow-add"), path: absolute }).strict(),
  z.object({ ...op("follow-remove"), followId: IdSchema }).strict(),
  z.object({ ...op("change-revert"), changeId: IdSchema, binding: InputBindingSchema }).strict(),
  z.object({ ...op("skill-edit"), edit: SkillEditOpSchema, skill: SkillRefSchema }).strict(),
  z.object({ ...op("tree-sync"), sync: TreeSyncSchema }).strict(),
  z.discriminatedUnion("record", [
    z.object({ ...op("open-record"), record: RecordSchema, recordId: IdSchema.optional() }).strict(),
    /** The host names the personal file behind its ref; main opens it only if it is in main's named inventory. */
    z.object({ ...op("open-record"), record: z.literal("personal"), sourceId: IdSchema }).strict(),
  ]),
  z.object({ ...op("observe-tick"), tick: TickSchema }).strict(),
  z.object({ ...op("observe-frame"), checkId: TokenSchema, image: PictureSchema.nullable() }).strict(),
  z.object({ ...op("interrupt") }).strict(),
  z.object({ ...op("close") }).strict(),
  // Goal alignment of any zone, bound to that zone's goal and revisions; no active-zone grants.
  z.object({ ...op("alignment-read"), zoneId: IdSchema }).strict(),
  z.discriminatedUnion("action", [AlignmentAnswerSchema.extend(op("alignment-step")).strict(), AlignmentMoveSchema.extend(op("alignment-step")).strict()]),
  AlignmentAcceptInputSchema.extend(op("alignment-accept")).strict(),
  z.object({ ...op("direction-read"), zoneId: IdSchema, directionId: IdSchema }).strict(),
  // Decisions and handoffs. Only handoff-run carries grants, exactly as send does.
  DecisionHelpInputSchema.extend(op("decision-help")).strict(),
  DecisionDismissInputSchema.extend(op("decision-dismiss")).strict(),
  HandoffSelectInputSchema.extend(op("handoff-select")).strict(),
  HandoffEditInputSchema.extend(op("handoff-edit")).strict(),
  HandoffDismissInputSchema.extend(op("handoff-dismiss")).strict(),
  z.object({ ...op("handoff-run"), binding: RequestBindingSchema, handoffId: IdSchema, revision, shares, image: SharedImageSchema.optional() }).strict(),
  z.object({ ...op("handoff-read"), zoneId: IdSchema, handoffId: IdSchema }).strict(),
  HandoffReviewInputSchema.extend(op("handoff-review")).strict(),
  // Current context.
  z.object({ ...op("context-use-read"), binding: RequestBindingSchema, cursor: CursorSchema.nullable() }).strict(),
  /** Main refreshed its opted-in personal-context copy first. */
  z.object({ ...op("context-reload"), binding: RequestBindingSchema, personal: PersonalSchema }).strict(),
  IgnoreObservationInputSchema.extend(op("context-ignore-observation")).strict(),
  // Sessions, trail and story.
  z.object({ ...op("session-new"), binding: RequestBindingSchema }).strict(),
  TrailQuerySchema.extend(op("trail-read")).strict(),
  z.object({ ...op("trail-source"), zoneId: IdSchema, sessionId: IdSchema, sourceId: IdSchema }).strict(),
  TrailMapInputSchema.extend(op("trail-map")).strict(),
  StoryQuerySchema.extend(op("story-read")).strict(),
  // Debug chat: an independent binding and no zone field anywhere.
  z.object({ ...op("debug-open") }).strict(),
  z.object({ ...op("debug-send"), binding: DebugBindingSchema, text: DebugTextSchema }).strict(),
  z.object({ ...op("debug-stop"), binding: DebugBindingSchema }).strict(),
  z.object({ ...op("debug-reset") }).strict(),
  /** Trusted main's sanitized events and, when they changed, its status; the host assigns sequence and time. */
  z.object({ ...op("diagnostic-main"), events: SanitizedMainEventsSchema, status: MainStatusSchema.nullable() }).strict(),
]);
export type HostRequest = z.infer<typeof HostRequestSchema>;

/** The typed result of a host operation; each operation fills at most the field it owns. */
export type HostResult = {
  zone?: Zone;
  context?: ZoneContext;
  deleted?: { activeZoneId: ZoneId | null; deletedIds: ZoneId[] };
  models?: ModelOption[];
  share?: ShareGrant;
  follow?: FollowGrant;
  change?: ChangeReceipt;
  /** open-record: the validated app-owned (or named personal) file main may open. */
  path?: string;
  /** tree-sync link: the page's URL. */
  url?: string;
  /** The named zone's alignment: alignment-*, and the target zone of zone-create/zone-update. */
  direction?: DirectionView;
  directionRecord?: Direction;
  decision?: DecisionView;
  handoff?: HandoffView;
  contextUse?: ContextUsePage;
  trail?: TrailPage;
  trailSource?: TrailSource;
  story?: StoryPage;
  debug?: DebugView;
};

export type HostEvent =
  | { type: "ready"; epoch: string }
  | {
    type: "state"; epoch: string; zoneEpoch: string | null; state: State | null; tree: View | null; registry: ZoneRegistry; activeZone: ZoneContext | null;
    inputToken: string; runningRequestId: string | null; canAttach: boolean; shares: ShareGrant[]; follows: FollowGrant[]; changes: ChangeReceipt[];
    look: HostLookStatus;
    direction: DirectionView | null; decision: DecisionView | null; handoff: HandoffView | null; contextUse: ContextUseView;
    session: SessionMeta | null; trail: TrailView | null;
  }
  /** Debug chat's own state, separate from any zone's. */
  | { type: "debug-state"; epoch: string; view: DebugView | null }
  | { type: "reply"; epoch: string; id: string; ok: boolean; error?: string; result?: HostResult }
  | { type: "fatal"; epoch: string; message: string }
  | { type: "credential-request"; epoch: string; requestId: string; need: CredentialNeed }
  | { type: "frame-request"; epoch: string; checkId: string };

const line = z.string().max(2000);
const body = z.string().max(256 * 1024);
const entryId = z.number().int().nonnegative();
const skillName = z.string().max(200);
const langName = z.string().max(64);
const level = z.enum(["recognize", "build", "apply"]);
const modelLabel = z.object({ backend: BackendIdSchema, model: z.string().min(1).max(200), effort: z.string().max(32).nullable() }).strict();
const courseCard = z.object({
  skill: skillName, lang: langName, lesson: body, example: body, wizard: line, task: body, path: z.string().max(4096), run: line,
}).strict();

export const EntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("say"), id: entryId, text: body, lead: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("question"), id: entryId, question: body, why: body, answer: body.nullable() }).strict(),
  z.object({ kind: z.literal("quip"), id: entryId, text: body }).strict(),
  z.object({ kind: z.literal("plan"), id: entryId, plan: body, approved: z.boolean().nullable(), paused: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("course"), id: entryId, card: courseCard, passed: z.boolean().nullable() }).strict(),
  z.object({ kind: z.literal("tool"), id: entryId, name: line, detail: body, outcome: z.enum(["ran", "held", "refused"]), why: body.optional() }).strict(),
  z.object({ kind: z.literal("fill"), id: entryId, path: z.string().max(4096), concept: line, code: body }).strict(),
  z.object({ kind: z.literal("note"), id: entryId, text: body }).strict(),
  z.object({
    kind: z.literal("excerpt"), id: entryId, path: z.string().max(4096), from: z.number().int().positive(), text: body,
    by: z.enum(["you", "dum"]), note: body.optional(),
  }).strict(),
  z.object({
    kind: z.literal("diff"), id: entryId, path: z.string().max(4096), diff: z.string().max(1024 * 1024),
    outcome: z.enum(["proposed", "created", "refused", "applied", "reverted"]), changeId: IdSchema.optional(), artifact: z.string().max(4096).optional(),
  }).strict(),
  z.object({ kind: z.literal("user"), id: entryId, text: body }).strict(),
  z.object({ kind: z.literal("result"), id: entryId, label: line, output: body, code: z.number().int() }).strict(),
  z.object({ kind: z.literal("shot"), id: entryId, label: line, observation: body, sha: ShaSchema }).strict(),
]);

export const StateSchema = z.object({
  zoneId: IdSchema,
  zoneName: z.string().max(80),
  mode: ModeSchema,
  transcript: z.array(EntrySchema).max(5000),
  prompt: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("question"), question: body, why: body, intern: z.boolean().optional(), purpose: z.enum(["attest", "share"]).optional(),
    }).strict(),
    z.object({ type: z.literal("next") }).strict(),
  ]).nullable(),
  busy: z.boolean(),
  status: line,
  stage: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("info"), title: line, body }).strict(),
    z.object({ kind: z.literal("conversation") }).strict(),
  ]),
  unlocked: z.number().int().nonnegative(),
  models: z.object({ intern: modelLabel.nullable(), helper: modelLabel.nullable(), look: modelLabel.nullable() }).strict(),
}).strict() satisfies z.ZodType<State>;

const nodeView = z.object({
  name: skillName, state: z.enum(["built", "recognized", "open", "locked"]), level: level.nullable(),
  needs: z.array(skillName).max(200), requires: z.array(skillName).max(200), next: line, depth: z.number().int().nonnegative(),
}).strict();
export const ViewSchema = z.object({
  tracks: z.array(z.object({
    name: line, lang: langName, done: z.number().int().nonnegative(), total: z.number().int().nonnegative(), nodes: z.array(nodeView).max(2000),
  }).strict()).max(500),
  off: z.array(z.object({ name: skillName, lang: langName, level }).strict()).max(5000),
  count: z.number().int().nonnegative(),
  usableBuilt: z.number().int().nonnegative(),
}).strict() satisfies z.ZodType<View>;

export const HostResultSchema = z.object({
  zone: ZoneSchema.optional(),
  context: ZoneContextSchema.optional(),
  deleted: z.object({ activeZoneId: IdSchema.nullable(), deletedIds: z.array(IdSchema).max(1000) }).strict().optional(),
  models: z.array(ModelOptionSchema).max(500).optional(),
  share: ShareGrantSchema.optional(),
  follow: FollowGrantSchema.optional(),
  change: ChangeReceiptSchema.optional(),
  path: z.string().min(1).max(4096).optional(),
  url: z.url().max(2048).optional(),
  direction: DirectionViewSchema.optional(),
  directionRecord: DirectionSchema.optional(),
  decision: DecisionViewSchema.optional(),
  handoff: HandoffViewSchema.optional(),
  contextUse: ContextUsePageSchema.optional(),
  trail: TrailPageSchema.optional(),
  trailSource: TrailSourceSchema.optional(),
  story: StoryPageSchema.optional(),
  debug: DebugViewSchema.optional(),
}).strict() satisfies z.ZodType<HostResult>;

export const HostEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), epoch: TokenSchema }).strict(),
  z.object({
    type: z.literal("state"), epoch: TokenSchema, zoneEpoch: TokenSchema.nullable(), state: StateSchema.nullable(), tree: ViewSchema.nullable(), registry: ZoneRegistrySchema,
    activeZone: ZoneContextSchema.nullable(), inputToken: TokenSchema, runningRequestId: TokenSchema.nullable(), canAttach: z.boolean(), shares: z.array(ShareGrantSchema).max(64),
    follows: z.array(FollowGrantSchema).max(64), changes: z.array(ChangeReceiptSchema).max(200), look: HostLookStatusSchema,
    direction: DirectionViewSchema.nullable(), decision: DecisionViewSchema.nullable(), handoff: HandoffViewSchema.nullable(),
    contextUse: ContextUseViewSchema, session: SessionMetaSchema.nullable(), trail: TrailViewSchema.nullable(),
  }).strict()
    .refine((e) => e.direction === null || e.direction.zoneId === e.activeZone?.id, "state carries only the active zone's alignment")
    .refine((e) => e.session === null || e.session.zoneId === e.activeZone?.id, "state carries only the active zone's session")
    .refine((e) => e.handoff === null || e.handoff.handoff.zoneId === e.activeZone?.id, "state carries only the active zone's handoff"),
  z.object({ type: z.literal("debug-state"), epoch: TokenSchema, view: DebugViewSchema.nullable() }).strict(),
  z.object({
    type: z.literal("reply"), epoch: TokenSchema, id: TokenSchema, ok: z.boolean(), error: line.optional(), result: HostResultSchema.optional(),
  }).strict(),
  z.object({ type: z.literal("fatal"), epoch: TokenSchema, message: line }).strict(),
  z.object({ type: z.literal("credential-request"), epoch: TokenSchema, requestId: TokenSchema, need: z.enum(["anthropic-key", "chatgpt-access"]) }).strict(),
  z.object({ type: z.literal("frame-request"), epoch: TokenSchema, checkId: TokenSchema }).strict(),
]) satisfies z.ZodType<HostEvent>;

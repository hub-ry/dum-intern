// Zones: the learning places Dum keeps under its home directory. Data and schemas only.
// A zone is context, never permission (docs/architecture.md rules 3 and 5).

import { z } from "zod";
import { IdSchema, ResourcePathSchema } from "./share-types.ts";

export type ZoneId = string;
/** A canonical skill name; `lang` "" is language-free. */
export type SkillRef = { name: string; lang: string };
export type Zone = {
  id: ZoneId;
  parentId: ZoneId | null;
  /** Trimmed, 1..80 characters, no control characters. */
  name: string;
  /** Trimmed, 1..2000 characters, user-written. */
  goal: string;
  /** Canonical language name, or null to inherit. */
  language: string | null;
  /** At most 32, deduplicated. */
  focusSkills: SkillRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type ZoneRegistry = { version: 1; revision: number; activeZoneId: ZoneId | null; zones: Zone[] };
/** A resolved zone: leaf goal plus root→leaf inheritance. Prompt background, not authority. */
export type ZoneContext = {
  id: ZoneId;
  /** Registry revision; invalidates context-bound work. */
  revision: number;
  breadcrumb: { id: ZoneId; name: string }[];
  goal: string;
  ancestorGoals: { id: ZoneId; goal: string }[];
  /** Nearest non-null language, else "". */
  language: string;
  focusSkills: SkillRef[];
  notes: { id: ZoneId; name: string; text: string }[];
};
/** A folder the user chose to follow in one zone. The absolute path stays host-private. */
export type FollowGrant = { id: string; zoneId: ZoneId; label: string; addedAt: string; files: number };
/** What the host stores for each direct change, for revert. The absolute path is host-private. */
export type ChangeManifest = {
  version: 1;
  id: string;
  zoneId: ZoneId;
  requestId: string;
  createdAt: string;
  /** ResourcePath of the written file. */
  target: string;
  baseSha: string | null;
  nextSha: string;
  skills: SkillRef[];
  revertedAt: string | null;
};
/** What a change shows after it is written: the diff, and whether revert can still restore it. */
export type ChangeReceipt = {
  id: string;
  zoneId: ZoneId;
  target: string;
  baseSha: string | null;
  nextSha: string;
  diff: string;
  appliedAt: string;
  revertible: boolean;
};

export const ZONE_LIMITS = {
  name: 80,
  goal: 2000,
  focusSkills: 32,
  depth: 16,
  zones: 1000,
  contextBytes: 16384,
  memoryBytes: 16384,
  contextBudget: 65536,
  transcriptEntries: 500,
  transcriptBytes: 4194304,
  changeBytes: 262144,
} as const;

/** A UTC ISO timestamp as `Date.prototype.toISOString` writes it. */
export const IsoSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "not a UTC timestamp");
/** A lowercase hex SHA-256. */
export const ShaSchema = z.string().regex(/^[0-9a-f]{64}$/, "not a SHA-256");

const CONTROL = /[\u0000-\u001f\u007f]/;
export const ZoneNameSchema = z.string().min(1).max(ZONE_LIMITS.name)
  .refine((s) => s === s.trim() && !CONTROL.test(s), "has surrounding whitespace or control characters");
export const ZoneGoalSchema = z.string().min(1).max(ZONE_LIMITS.goal).refine((s) => s === s.trim(), "has surrounding whitespace");
export const LanguageSchema = z.string().max(64).refine((s) => !CONTROL.test(s), "has control characters");

export const SkillRefSchema = z.object({
  name: z.string().min(1).max(200).refine((s) => !CONTROL.test(s), "has control characters"),
  lang: LanguageSchema,
}).strict() satisfies z.ZodType<SkillRef>;

export const FocusSkillsSchema = z.array(SkillRefSchema).max(ZONE_LIMITS.focusSkills).refine(
  (list) => new Set(list.map((s) => `${s.name.toLowerCase()}\u0000${s.lang.toLowerCase()}`)).size === list.length,
  "repeats a skill",
);

export const ZoneSchema = z.object({
  id: IdSchema,
  parentId: IdSchema.nullable(),
  name: ZoneNameSchema,
  goal: ZoneGoalSchema,
  language: LanguageSchema.min(1).nullable(),
  focusSkills: FocusSkillsSchema,
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
  deletedAt: IsoSchema.nullable(),
}).strict() satisfies z.ZodType<Zone>;

export const ZoneRegistrySchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  activeZoneId: IdSchema.nullable(),
  zones: z.array(ZoneSchema).max(ZONE_LIMITS.zones),
}).strict() satisfies z.ZodType<ZoneRegistry>;

export const ZoneContextSchema = z.object({
  id: IdSchema,
  revision: z.number().int().nonnegative(),
  breadcrumb: z.array(z.object({ id: IdSchema, name: ZoneNameSchema }).strict()).min(1).max(ZONE_LIMITS.depth),
  goal: ZoneGoalSchema,
  ancestorGoals: z.array(z.object({ id: IdSchema, goal: ZoneGoalSchema }).strict()).max(ZONE_LIMITS.depth),
  language: LanguageSchema,
  focusSkills: z.array(SkillRefSchema).max(ZONE_LIMITS.focusSkills * ZONE_LIMITS.depth),
  notes: z.array(z.object({ id: IdSchema, name: ZoneNameSchema, text: z.string().max(ZONE_LIMITS.contextBytes) }).strict())
    .max(ZONE_LIMITS.depth),
}).strict() satisfies z.ZodType<ZoneContext>;

export const FollowGrantSchema = z.object({
  id: IdSchema,
  zoneId: IdSchema,
  label: z.string().min(1).max(300),
  addedAt: IsoSchema,
  files: z.number().int().nonnegative(),
}).strict() satisfies z.ZodType<FollowGrant>;

export const ChangeManifestSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  zoneId: IdSchema,
  requestId: z.string().min(1).max(64),
  createdAt: IsoSchema,
  target: ResourcePathSchema,
  baseSha: ShaSchema.nullable(),
  nextSha: ShaSchema,
  skills: z.array(SkillRefSchema).max(ZONE_LIMITS.focusSkills),
  revertedAt: IsoSchema.nullable(),
}).strict() satisfies z.ZodType<ChangeManifest>;

export const ChangeReceiptSchema = z.object({
  id: IdSchema,
  zoneId: IdSchema,
  target: ResourcePathSchema,
  baseSha: ShaSchema.nullable(),
  nextSha: ShaSchema,
  diff: z.string().max(ZONE_LIMITS.changeBytes * 2),
  appliedAt: IsoSchema,
  revertible: z.boolean(),
}).strict() satisfies z.ZodType<ChangeReceipt>;

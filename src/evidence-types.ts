// The global proof ledger and the payloads the evidence actions carry. Data and schemas only.
// Notes stay the competency source of truth; this ledger is what :evidence shows.

import { z } from "zod";
import { IdSchema, ResourcePathSchema } from "./share-types.ts";
import { IsoSchema, ShaSchema, ZoneNameSchema } from "./zone-types.ts";
import type { ResourcePath } from "./share-types.ts";
import type { ZoneId } from "./zone-types.ts";

/** What the intern sends when they explained a skill in their own words this turn. */
export type ExplanationInput = { skill: string; lang?: string; quote: string; feedback: string; apply?: boolean; passed?: boolean };
/** What the intern sends after reviewing shared files. Paths are current resource names only; no hash from the model. */
export type SubmissionInput = {
  skill: string;
  lang?: string;
  paths: ResourcePath[];
  unaided: boolean;
  feedback: string;
  passed: boolean;
  requires?: string[];
};

/** One thing the tree heard. `quote` and `sourcePath` are local only, never in a note that may sync. */
export type Proof = {
  at: string;
  kind: "recognize" | "apply" | "build" | "undo";
  skill: string;
  lang: string;
  ok: boolean;
  why: string;
  quote?: string;
  /** `path` is the request resource name; `sha` the full reviewed-bytes digest. */
  files?: { path: ResourcePath; sha: string; sourcePath?: string }[];
  unaided?: boolean;
  feedback?: string;
};
/** A proof with the zone it came from; `zoneName` is a snapshot for renamed or deleted zones. */
export type Proof2 = Proof & { id: string; zoneId: ZoneId; zoneName: string };
/** `held`: skills.id values taken back with "not yet"; trimming records never trims holds. */
export type Ledger = { version: 2; held: string[]; records: Proof2[] };

export const LEDGER_LIMITS = { records: 200, bytes: 524288, held: 1000 } as const;

const ProofFileSchema = z.object({
  path: ResourcePathSchema,
  sha: ShaSchema,
  sourcePath: z.string().min(1).max(4096).optional(),
}).strict();

export const Proof2Schema = z.object({
  id: IdSchema,
  zoneId: IdSchema,
  zoneName: ZoneNameSchema,
  at: IsoSchema,
  kind: z.enum(["recognize", "apply", "build", "undo"]),
  skill: z.string().min(1).max(200),
  lang: z.string().max(64),
  ok: z.boolean(),
  why: z.string().max(2000),
  quote: z.string().max(400).optional(),
  files: z.array(ProofFileSchema).max(16).optional(),
  unaided: z.boolean().optional(),
  feedback: z.string().max(400).optional(),
}).strict() satisfies z.ZodType<Proof2>;

export const LedgerSchema = z.object({
  version: z.literal(2),
  held: z.array(z.string().min(1).max(300)).max(LEDGER_LIMITS.held)
    .refine((held) => new Set(held).size === held.length, "repeats a held skill"),
  records: z.array(Proof2Schema).max(LEDGER_LIMITS.records),
}).strict() satisfies z.ZodType<Ledger>;

// Goals, each goal's one next step, skips, and the play recommendation. Data and schemas only.
// A goal is stored as a zone (zone-types.ts); "goal" is the user's word for it. The host derives
// every step from state it already owns, so a step goes away by itself once it's done.

import { z } from "zod";
import { IdSchema, TokenSchema } from "./share-types.ts";
import { SkillRefSchema, type SkillRef, type ZoneId } from "./zone-types.ts";

/**
 * What the step asks for. `align`: say what finishing the goal looks like. `project`: pick a
 * project theme or idea. `milestone`: the chosen project's next milestone. `recognize`/`build`: the
 * next skill on the goal's path, explained or written unaided.
 */
export type StepKind = "align" | "project" | "milestone" | "recognize" | "build";

export const STEP_LIMITS = {
  /** One sentence. */
  text: 140,
  goal: 80,
  label: 60,
  prompt: 400,
  why: 140,
  goals: 1000,
} as const;

export type StepView = {
  /** `<kind>-<hex>`: the same id while it is the same step; a new id is a new step. */
  id: string;
  zoneId: ZoneId;
  /** The goal's name, for the bubble's header. */
  goal: string;
  kind: StepKind;
  /** Exactly one sentence, e.g. "Pick a project theme or idea." */
  text: string;
  skill: SkillRef | null;
  /** "Pick … for me": the button label, and the message Dum gets, as if typed, when it's pressed. */
  pick: { label: string; prompt: string } | null;
  /** Skip is always offered. True when the step is past beginner level, so skipping asks "Sure?" first. */
  confirmSkip: boolean;
};

export type GoalView = {
  id: ZoneId;
  /** The goal's skills in prerequisite order: what `progress` counts and the goal panel's Path strip shows. */
  path: SkillRef[];
  /** Skills on `path` that are built, applied or trusted, over the path's length. */
  progress: { done: number; total: number };
  /** Null once every step is done or the goal was skipped. */
  step: StepView | null;
  /** When the user skipped the whole goal; null otherwise. */
  skippedAt: string | null;
};

/** The play button's pick: the one skill to work on next, and why, in one sentence. */
export type NextSkill = { skill: SkillRef; zoneId: ZoneId | null; why: string };

const line = (max: number) => z.string().min(1).max(max).refine((s) => s === s.trim() && !/[\u0000-\u001f\u007f]/.test(s), "isn't one clean line");

export const StepIdSchema = TokenSchema;
export const StepKindSchema = z.enum(["align", "project", "milestone", "recognize", "build"]) satisfies z.ZodType<StepKind>;

export const StepViewSchema = z.object({
  id: StepIdSchema,
  zoneId: IdSchema,
  goal: line(STEP_LIMITS.goal),
  kind: StepKindSchema,
  text: line(STEP_LIMITS.text),
  skill: SkillRefSchema.nullable(),
  pick: z.object({ label: line(STEP_LIMITS.label), prompt: line(STEP_LIMITS.prompt) }).strict().nullable(),
  confirmSkip: z.boolean(),
}).strict() satisfies z.ZodType<StepView>;

const count = z.number().int().nonnegative();
export const GoalViewSchema = z.object({
  id: IdSchema,
  path: z.array(SkillRefSchema).max(500),
  progress: z.object({ done: count, total: count }).strict().refine((p) => p.done <= p.total, "done exceeds total"),
  step: StepViewSchema.nullable(),
  skippedAt: z.string().nullable(),
}).strict() satisfies z.ZodType<GoalView>;

export const NextSkillSchema = z.object({
  skill: SkillRefSchema,
  zoneId: IdSchema.nullable(),
  why: line(STEP_LIMITS.why),
}).strict() satisfies z.ZodType<NextSkill>;

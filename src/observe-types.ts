// The look (docs/llm-setup-design.md §6 and §8.4): main ticks every 3 seconds without a model; the host
// decides whether something changed and makes at most one bounded helper call for it.

import { z } from "zod";
import { IdSchema, TokenSchema } from "./share-types.ts";
import type { Picture } from "./agent/types.ts";
import type { RequestBinding, ResourcePath } from "./share-types.ts";
import type { ZoneContext, ZoneId } from "./zone-types.ts";

export const LOOK = {
  tickMs: 3_000,
  /** App switch and typing stop. */
  settleTicks: 2,
  /** Code. */
  quietTicks: 2,
  /** Changed cells of the grid that make a tick active; starting value, tune on a real Mac. */
  activeCells: 3,
  /** Active ticks needed in the recent window. */
  activeOf: [2, 5],
  /** Ticks between folder re-listings. */
  relistEvery: 5,
  minMs: { code: 60_000, app: 120_000, typing: 90_000, any: 30_000 },
  appRepeatMs: 600_000,
  hourlyCap: 40,
  checkMs: 45_000,
  /** Downscaled grid the screen is compared on. */
  grid: [64, 40],
  /** Mean level change that marks a cell changed. */
  levelDelta: 8,
  /** Width of the activity thumbnail that is reduced to the grid; never sent anywhere. */
  thumbWidth: 320,
  /** Width of a frame sent to the helper: wide enough to read code on screen. */
  frameWidth: 1280,
  /** Largest frame PNG sent to the helper; within look.ts's MAX_IMAGE_BYTES. A bigger one is not sent. */
  frameBytes: 3_750_000,
} as const;

/** Defaults on a fresh install: apps and screen on (rule 8). */
export type LookPrefs = { apps: boolean; screen: boolean };
export type AppSignal = { bundleId: string; name: string; windowId: number | null };
export type Tick = { zoneId: ZoneId; epoch: string; at: number; app: AppSignal | null; screen: { changedCells: number } | null };
export type FileSignal = { path: ResourcePath; kind: "new" | "saved" | "removed"; sha: string | null };
export type Trigger = "code" | "app" | "typing";
export type AmbientInput = {
  zone: ZoneContext;
  binding: RequestBinding;
  triggers: readonly Trigger[];
  files: readonly { path: ResourcePath; diff: string }[];
  app: AppSignal | null;
  image: Picture | null;
};
export type AmbientResult = { note: string | null; aside: string | null };

export const LookPrefsSchema = z.object({ apps: z.boolean(), screen: z.boolean() }).strict() satisfies z.ZodType<LookPrefs>;

export const AppSignalSchema = z.object({
  bundleId: z.string().min(1).max(255).regex(/^[A-Za-z0-9.-]+$/, "not a bundle id"),
  name: z.string().max(255),
  windowId: z.number().int().nonnegative().nullable(),
}).strict() satisfies z.ZodType<AppSignal>;

export const TickSchema = z.object({
  zoneId: IdSchema,
  epoch: TokenSchema,
  at: z.number().int().nonnegative(),
  app: AppSignalSchema.nullable(),
  screen: z.object({ changedCells: z.number().int().min(0).max(LOOK.grid[0] * LOOK.grid[1]) }).strict().nullable(),
}).strict() satisfies z.ZodType<Tick>;

// The look (docs/llm-setup-design.md §6 and §8.4): main ticks every 3 seconds without a model; the host
// decides whether something changed and makes at most one bounded look-model call for it at a time.

import { z } from "zod";
import { SelectorSchema } from "./agent/schema.ts";
import { IdSchema, TokenSchema } from "./share-types.ts";
import { IsoSchema } from "./zone-types.ts";
import type { Picture, Selector } from "./agent/types.ts";
import type { RequestBinding, ResourcePath } from "./share-types.ts";
import type { TopicHint } from "./trail-types.ts";
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
  /** Least time between calls of each trigger. Screen and any call: one tick (`tickMs`). */
  minMs: { code: 60_000, app: 120_000, typing: 90_000, screen: 3_000, any: 3_000 },
  appRepeatMs: 600_000,
  /** Calls started in any hour, timed-out ones included: at most one every 3 s. */
  hourlyCap: 1_200,
  /** A call that hasn't answered by then is stopped; it still counts toward the limits. */
  checkMs: 45_000,
  /** At most one memory note a minute, and none that nearly repeats one of the last `recentNotes`. */
  noteMs: 60_000,
  recentNotes: 5,
  /** Word overlap (Jaccard) at or above which two notes count as the same observation. */
  sameNote: 0.6,
  /** Downscaled grid the screen is compared on. */
  grid: [64, 40],
  /** Mean level change that marks a cell changed. */
  levelDelta: 8,
  /** Width of the activity thumbnail that is reduced to the grid; never sent anywhere. */
  thumbWidth: 320,
  /** Width of a frame sent to the look model: wide enough to read code on screen. */
  frameWidth: 1280,
  /** Largest frame PNG sent to the look model; within look.ts's MAX_IMAGE_BYTES. A bigger one is not sent. */
  frameBytes: 3_750_000,
} as const;

/** Defaults on a fresh install: apps and screen on (rule 8). */
export type LookPrefs = { apps: boolean; screen: boolean };
export type AppSignal = { bundleId: string; name: string; windowId: number | null };
export type Tick = { zoneId: ZoneId; epoch: string; at: number; app: AppSignal | null; screen: { changedCells: number } | null };
export type FileSignal = { path: ResourcePath; kind: "new" | "saved" | "removed"; sha: string | null };
/** `screen`: a tick with at least `LOOK.activeCells` changed cells (the live look). */
export type Trigger = "code" | "app" | "typing" | "screen";
export type AmbientInput = {
  zone: ZoneContext;
  binding: RequestBinding;
  triggers: readonly Trigger[];
  files: readonly { path: ResourcePath; diff: string }[];
  app: AppSignal | null;
  /** The one fresh frame of this call; earlier frames are never sent again. */
  image: Picture | null;
  /** What the last look saw, in words: the only thing carried from one call to the next. */
  previous: string | null;
};
/**
 * What one look saw, in one sentence, or null when nothing was worth noting, plus at most three
 * topic hints for the trail. The look never advises.
 */
export type AmbientResult = { note: string | null; topics: TopicHint[] };

/** Why the look didn't call, or how its last call went. A subset of the diagnostic codes. */
export const LOOK_REASONS = [
  "unchanged", "dedup", "coalesced", "busy", "decision", "voice", "no-zone", "no-frame", "permission",
  "unverified-model", "stale-epoch", "rate-limit", "timeout", "call-failed",
] as const;
export type LookReason = (typeof LOOK_REASONS)[number];
/** `no-backend`: the look runs and notices changes, but nothing is ever sent. */
export type LookStatus = "watching" | "checking" | "blocked" | "no-backend" | "failed";
/** macOS screen-recording access as Electron reports it; `not-required` elsewhere. */
export type ScreenPermission = "granted" | "denied" | "restricted" | "not-determined" | "unknown" | "not-required";
/** The host's half of the look status. `seen.stale`: a later call failed, so it may be out of date. */
export type HostLookStatus = {
  status: LookStatus;
  reason: LookReason | null;
  /** Why pictures can't go to the look model now; "" when they can or screen look is off. */
  noPictures: string;
  seen: { text: string; sourceId: string; at: string; stale: boolean } | null;
  lastTick: string | null;
  lastAttempt: string | null;
  lastSuccess: string | null;
  chosen: Selector | null;
  /** The model `chosen` runs today, from the live catalog. */
  resolved: string | null;
};
/** What Current context shows: the host's status plus main's pause and permission. */
export type LookStatusView = HostLookStatus & { paused: boolean; permission: ScreenPermission };

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

export const LookStatusSchema = z.enum(["watching", "checking", "blocked", "no-backend", "failed"]) satisfies z.ZodType<LookStatus>;
export const ScreenPermissionSchema = z.enum(["granted", "denied", "restricted", "not-determined", "unknown", "not-required"]) satisfies z.ZodType<ScreenPermission>;

const hostLook = {
  status: LookStatusSchema,
  reason: z.enum(LOOK_REASONS).nullable(),
  noPictures: z.string().max(2000),
  seen: z.object({
    text: z.string().min(1).max(280).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "has control characters"),
    sourceId: IdSchema,
    at: IsoSchema,
    stale: z.boolean(),
  }).strict().nullable(),
  lastTick: IsoSchema.nullable(),
  lastAttempt: IsoSchema.nullable(),
  lastSuccess: IsoSchema.nullable(),
  chosen: SelectorSchema.nullable(),
  resolved: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "not a model id").nullable(),
};
export const HostLookStatusSchema = z.object(hostLook).strict() satisfies z.ZodType<HostLookStatus>;
export const LookStatusViewSchema = z.object({ ...hostLook, paused: z.boolean(), permission: ScreenPermissionSchema }).strict() satisfies z.ZodType<LookStatusView>;

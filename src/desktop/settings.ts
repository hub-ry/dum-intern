// Desktop preferences, the circle's placement and the goals pinned to its column, version 3, in one
// private file under Electron's userData. Main is the only writer; the host gets copies of the preferences. Nothing secret goes in
// it: no tokens, keys, transcripts or captures.

import { renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentChoiceSchema, CLAUDE_DEFAULTS, SelectorSchema } from "../agent/schema.ts";
import { readState, writeState } from "../state-files.ts";
import { IdSchema } from "../share-types.ts";
import { IsoSchema, type ZoneId } from "../zone-types.ts";
import { accelerator, DEFAULT_PREFERENCES, DesktopPreferencesSchema, DisplayIdSchema, type DesktopPreferences } from "./protocol.ts";
import { CIRCLE } from "./surfaces.ts";

const FILE = "settings.json";
const MAX_FILE = 64 * 1024;

/**
 * Where the circle sits on one display: normalized top-left fractions over its travel range, and when
 * the user last put it there. Electron display ids are matching hints, not hardware identities.
 */
export type CirclePlacement = { displayId: string; u: number; v: number; usedAt: string };
export type CircleLayout = { lastChosenDisplayId: string | null; placements: CirclePlacement[] };

const unit = z.number().finite().min(0).max(1);
export const CircleLayoutSchema = z.object({
  lastChosenDisplayId: DisplayIdSchema.nullable(),
  placements: z.array(z.object({ displayId: DisplayIdSchema, u: unit, v: unit, usedAt: IsoSchema }).strict())
    .max(CIRCLE.placements)
    .refine((ps) => new Set(ps.map((p) => p.displayId)).size === ps.length, "one placement per display"),
}).strict() satisfies z.ZodType<CircleLayout>;

const EMPTY_LAYOUT: CircleLayout = { lastChosenDisplayId: null, placements: [] };

/** Goals pinned to the circle's column, at most this many. */
export const MAX_PINS = 3;
export const PinsSchema = z.array(IdSchema).max(MAX_PINS).refine((ids) => new Set(ids).size === ids.length, "a goal is pinned once");

const StoredV3 = z.object({
  version: z.literal(3), settings: z.record(z.string(), z.unknown()), circle: z.unknown(), pinned: z.unknown().optional(),
}).strict();
const StoredV2 = z.object({ version: z.literal(2), settings: z.record(z.string(), z.unknown()) }).strict();

/** The version 1 file exactly as older builds wrote it; read only to migrate. */
const StoredV1 = z.object({
  version: z.literal(1),
  settings: z.object({
    hotkey: z.string().max(80).refine(accelerator),
    alwaysOnTop: z.boolean(),
    allWorkspaces: z.boolean(),
    launchAtLogin: z.boolean(),
    personalContext: z.boolean(),
    wizardAdvice: z.boolean().default(false),
    wizardSource: z.enum(["screen", "files"]).default("screen"),
  }).strict(),
  recent: z.array(z.string().max(4096)).max(8),
  companion: z.object({ x: z.number(), y: z.number() }).strict().nullable(),
}).strict();

/**
 * `layout` with the user's placement for one display put in, as the most recently chosen. Over the
 * cap, the least recently user-chosen other placement goes.
 */
export function withPlacement(layout: CircleLayout, placement: CirclePlacement): CircleLayout {
  const others = layout.placements.filter((p) => p.displayId !== placement.displayId);
  while (others.length >= CIRCLE.placements) {
    let oldest = 0;
    for (let i = 1; i < others.length; i++) if (others[i]!.usedAt < others[oldest]!.usedAt) oldest = i;
    others.splice(oldest, 1);
  }
  return { lastChosenDisplayId: placement.displayId, placements: [...others, { ...placement }] };
}

/**
 * A saved agent choice from before the look role and before Claude took only API keys: the
 * explicit migration to today's shape. A choice without `look` gets Claude's look default on
 * Claude and its own helper selector elsewhere; a Claude subscription sign-in becomes the API key
 * with the same models. Anything else is left for the schema to judge.
 */
function migrateAgent(agent: unknown): { agent: unknown; notes: string[] } {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return { agent, notes: [] };
  const next: Record<string, unknown> = { ...agent };
  const notes: string[] = [];
  if (next.login === "claude-subscription" && next.backend === "claude") {
    next.login = "anthropic-key";
    notes.push("Claude now connects only with your own Anthropic API key. Add it in Settings › Agent; your models are kept.");
  }
  const helper = SelectorSchema.safeParse(next.helper);
  if (!("look" in next) && helper.success) {
    const look = next.backend === "claude" ? { ...CLAUDE_DEFAULTS.look } : helper.data;
    next.look = look;
    notes.push(`Dum now looks at your screen with its own look model: ${look.model}${look.effort ? ` (${look.effort})` : ""}. Change it in Settings › Agent.`);
  }
  return { agent: next, notes };
}

export class DesktopSettings {
  /** Why the saved file wasn't used as it was, if it wasn't; shown once, never fatal. */
  warning = "";
  private prefs: DesktopPreferences = structuredClone(DEFAULT_PREFERENCES);
  private layout: CircleLayout = structuredClone(EMPTY_LAYOUT);
  private pins: ZoneId[] = [];

  private constructor(readonly dir: string) {}

  /**
   * A missing file means defaults. A version 1 or 2 file is migrated and rewritten as version 3 once,
   * and so is a saved agent choice of an older shape; version 2 preferences carry over unchanged and
   * the circle starts at its default. An unreadable file is kept aside, never silently overwritten.
   * A saved agent choice that still doesn't parse loads as null and the file is left as it is; so is
   * a circle layout or a pin list that doesn't parse, which loads as none.
   */
  static load(dir: string): DesktopSettings {
    const out = new DesktopSettings(dir);
    let raw: unknown;
    try {
      const text = readState(dir, FILE, MAX_FILE);
      if (text === null) return out;
      raw = JSON.parse(text);
    } catch {
      out.setAside();
      return out;
    }
    const v1 = StoredV1.safeParse(raw);
    if (v1.success) {
      out.migrate(v1.data.settings);
      return out;
    }
    const v3 = StoredV3.safeParse(raw);
    const v2 = v3.success ? null : StoredV2.safeParse(raw);
    const stored = v3.success ? v3.data : v2?.success ? v2.data : null;
    if (!stored) {
      out.setAside();
      return out;
    }
    const { agent: saved, ...rest } = stored.settings;
    const prefs = DesktopPreferencesSchema.safeParse({ ...rest, agent: null });
    if (!prefs.success) {
      out.setAside();
      return out;
    }
    if (v3.success) {
      const layout = CircleLayoutSchema.safeParse(v3.data.circle);
      if (layout.success) out.layout = layout.data;
      const pins = PinsSchema.safeParse(v3.data.pinned ?? []);
      if (pins.success) out.pins = pins.data;
    }
    const { agent, notes } = migrateAgent(saved ?? null);
    const choice = AgentChoiceSchema.nullable().safeParse(agent);
    out.prefs = { ...prefs.data, agent: choice.success ? choice.data : null };
    if (!choice.success) {
      out.warning = "The saved choice of who powers Dum isn't valid any more. Choose again in Settings › Agent.";
    } else if (notes.length || !v3.success) {
      out.warning = notes.join("\n");
      out.save();
    }
    return out;
  }

  get(): DesktopPreferences {
    return structuredClone(this.prefs);
  }

  /** Validated and saved before it counts: a failed write leaves the previous preferences in force. The circle's layout and pins are kept. */
  set(p: DesktopPreferences): void {
    const next = DesktopPreferencesSchema.parse(p);
    this.write(next, this.layout, this.pins);
    this.prefs = next;
  }

  circle(): CircleLayout {
    return structuredClone(this.layout);
  }

  /** Validated and saved before it counts, like `set`. The preferences and pins are kept. */
  setCircle(layout: CircleLayout): void {
    const next = CircleLayoutSchema.parse(layout);
    this.write(this.prefs, next, this.pins);
    this.layout = next;
  }

  /** The goals pinned to the column, in the order they were pinned. */
  pinned(): ZoneId[] {
    return [...this.pins];
  }

  /** At most three distinct goal ids, validated and saved before they count, like `set`. */
  setPinned(ids: readonly ZoneId[]): void {
    if (ids.length > MAX_PINS) throw new Error("You can pin up to three goals - unpin one first");
    const next = PinsSchema.parse([...ids]);
    this.write(this.prefs, this.layout, next);
    this.pins = next;
  }

  private write(prefs: DesktopPreferences, circle: CircleLayout, pinned: readonly ZoneId[]): void {
    writeState(this.dir, FILE, `${JSON.stringify({ version: 3, settings: prefs, circle, pinned }, null, 2)}\n`);
  }

  /** Window, workspace, recent-project and companion fields are dropped; screen advice becomes the look. */
  private migrate(old: z.infer<typeof StoredV1>["settings"]): void {
    const screen = old.wizardAdvice && old.wizardSource === "screen";
    this.prefs = {
      ...structuredClone(DEFAULT_PREFERENCES),
      hotkey: old.hotkey,
      launchAtLogin: old.launchAtLogin,
      personalContext: old.personalContext,
      look: { apps: DEFAULT_PREFERENCES.look.apps, screen },
    };
    if (old.wizardAdvice && old.wizardSource === "files") {
      this.warning = "Dum no longer watches a project for saved changes. Follow a folder in a goal to get advice when you save code there.";
    }
    this.save();
  }

  /** A migration's result, written once; if that fails it still applies and is saved on the next change. */
  private save(): void {
    try {
      this.write(this.prefs, this.layout, this.pins);
    } catch (err) {
      const why = `Upgraded desktop settings couldn't be saved (${(err as Error).message}); they apply for now and will be saved on the next change.`;
      this.warning = this.warning ? `${this.warning}\n${why}` : why;
    }
  }

  private setAside(): void {
    const file = join(this.dir, FILE);
    const aside = `${file}.invalid-${Date.now()}`;
    try {
      renameSync(file, aside);
      this.warning = `Saved desktop settings couldn't be read, so defaults are in use. The old file is kept as ${aside}.`;
    } catch {
      this.warning = "Saved desktop settings couldn't be read, so defaults are in use.";
    }
  }
}

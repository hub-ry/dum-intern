// Desktop preferences, version 2, in one private file under Electron's userData. Main is the only
// writer; the host gets copies. Nothing secret goes in it: no tokens, keys, transcripts or captures.

import { renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentChoiceSchema, CLAUDE_DEFAULTS, SelectorSchema } from "../agent/schema.ts";
import { readState, writeState } from "../state-files.ts";
import { accelerator, DEFAULT_PREFERENCES, DesktopPreferencesSchema, type DesktopPreferences } from "./protocol.ts";

const FILE = "settings.json";
const MAX_FILE = 64 * 1024;

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

  private constructor(readonly dir: string) {}

  /**
   * A missing file means defaults. A version 1 file is migrated and rewritten as version 2 once,
   * and so is a saved agent choice of an older shape. An unreadable file is kept aside, never
   * silently overwritten. A saved agent choice that still doesn't parse loads as null.
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
    const v2 = StoredV2.safeParse(raw);
    if (!v2.success) {
      out.setAside();
      return out;
    }
    const { agent: saved, ...rest } = v2.data.settings;
    const prefs = DesktopPreferencesSchema.safeParse({ ...rest, agent: null });
    if (!prefs.success) {
      out.setAside();
      return out;
    }
    const { agent, notes } = migrateAgent(saved ?? null);
    const choice = AgentChoiceSchema.nullable().safeParse(agent);
    out.prefs = { ...prefs.data, agent: choice.success ? choice.data : null };
    if (!choice.success) {
      out.warning = "The saved choice of who powers Dum isn't valid any more. Choose again in Settings › Agent.";
    } else if (notes.length) {
      out.warning = notes.join("\n");
      out.save();
    }
    return out;
  }

  get(): DesktopPreferences {
    return structuredClone(this.prefs);
  }

  /** Validated and saved before it counts: a failed write leaves the previous preferences in force. */
  set(p: DesktopPreferences): void {
    const next = DesktopPreferencesSchema.parse(p);
    this.write(next);
    this.prefs = next;
  }

  private write(prefs: DesktopPreferences): void {
    writeState(this.dir, FILE, `${JSON.stringify({ version: 2, settings: prefs }, null, 2)}\n`);
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
      this.warning = "Dum no longer watches a project for saved changes. Follow a folder in a zone to get advice when you save code there.";
    }
    this.save();
  }

  /** A migration's result, written once; if that fails it still applies and is saved on the next change. */
  private save(): void {
    try {
      this.write(this.prefs);
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

// Desktop preferences, version 2, in one private file under Electron's userData. Main is the only
// writer; the host gets copies. Nothing secret goes in it: no tokens, keys, transcripts or captures.

import { renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentChoiceSchema } from "../agent/schema.ts";
import type { Flavor } from "../agent/types.ts";
import { readState, writeState } from "../state-files.ts";
import { accelerator, DEFAULT_PREFERENCES, desktopPreferencesSchema, type DesktopPreferences } from "./protocol.ts";

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

export class DesktopSettings {
  /** Why the saved file wasn't used as it was, if it wasn't; shown once, never fatal. */
  warning = "";
  private prefs: DesktopPreferences = structuredClone(DEFAULT_PREFERENCES);

  private constructor(readonly dir: string, readonly flavor: Flavor) {}

  /**
   * A missing file means defaults. A version 1 file is migrated and rewritten as version 2 once.
   * An unreadable one is kept aside, never silently overwritten. A saved agent choice this build
   * doesn't offer loads as null.
   */
  static load(dir: string, flavor: Flavor): DesktopSettings {
    const out = new DesktopSettings(dir, flavor);
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
    const { agent, ...rest } = v2.data.settings;
    const prefs = desktopPreferencesSchema(flavor).safeParse({ ...rest, agent: null });
    if (!prefs.success) {
      out.setAside();
      return out;
    }
    const choice = agentChoiceSchema(flavor).nullable().safeParse(agent ?? null);
    out.prefs = { ...prefs.data, agent: choice.success ? choice.data : null };
    if (!choice.success) out.warning = "The saved choice of who powers Dum isn't available in this build. Choose again in Settings.";
    return out;
  }

  get(): DesktopPreferences {
    return structuredClone(this.prefs);
  }

  /** Validated for this build's flavor and saved before it counts: a failed write leaves the previous preferences in force. */
  set(p: DesktopPreferences): void {
    const next = desktopPreferencesSchema(this.flavor).parse(p);
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

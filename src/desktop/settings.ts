// Desktop preferences, recent projects and where the companion sits, in one private file under
// Electron's userData. Nothing secret goes in it: no tokens, transcripts, captures or account data.

import { lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Settings } from "./protocol.ts";

export const DEFAULTS: Settings = {
  hotkey: "CommandOrControl+Shift+D",
  alwaysOnTop: true,
  allWorkspaces: true,
  launchAtLogin: false,
  personalContext: false,
};

const MODIFIERS: Record<string, "shift" | "other"> = {
  Command: "other", Cmd: "other", Control: "other", Ctrl: "other", CommandOrControl: "other", CmdOrCtrl: "other",
  Alt: "other", Option: "other", AltGr: "other", Super: "other", Meta: "other", Shift: "shift",
};
const NAMED_KEYS = new Set([
  "Plus", "Space", "Tab", "Backspace", "Delete", "Insert", "Return", "Enter", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Escape", "Esc",
]);

/** An Electron accelerator with at least one non-Shift modifier and exactly one key, so a global hotkey can't eat ordinary typing. */
export function accelerator(value: string): boolean {
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  if (!parts.length || new Set(parts).size !== parts.length) return false;
  if (!parts.every((p) => MODIFIERS[p] !== undefined) || !parts.some((p) => MODIFIERS[p] === "other")) return false;
  return /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS.has(key) || /^[`\-=[\]\\;',./]$/.test(key);
}

export const SettingsSchema = z.object({
  hotkey: z.string().max(80).refine(accelerator, "use a shortcut with Command, Control, Alt or Option plus one key"),
  alwaysOnTop: z.boolean(),
  allWorkspaces: z.boolean(),
  launchAtLogin: z.boolean(),
  personalContext: z.boolean(),
}).strict();

const MAX_RECENT = 8;
const MAX_FILE = 64 * 1024;
const Point = z.object({ x: z.number().int().min(-100_000).max(100_000), y: z.number().int().min(-100_000).max(100_000) }).strict();
const Stored = z.object({
  version: z.literal(1),
  settings: SettingsSchema,
  recent: z.array(z.string().min(1).max(4096).refine(isAbsolute)).max(MAX_RECENT),
  companion: Point.nullable(),
}).strict();

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class DesktopSettings {
  settings: Settings = { ...DEFAULTS };
  /** Project roots the person opened, newest first. The only roots open-project accepts. */
  recent: string[] = [];
  companion: Point | null = null;
  /** Why the saved file wasn't used, if it wasn't; shown once, never fatal. */
  warning = "";
  private readonly file: string;

  private constructor(readonly dir: string) {
    this.file = join(dir, "settings.json");
  }

  /** A missing file means defaults. An unreadable one is kept aside, never silently overwritten. */
  static load(dir: string): DesktopSettings {
    const out = new DesktopSettings(dir);
    let raw: string;
    try {
      const st = lstatSync(out.file);
      if (!st.isFile() || st.size > MAX_FILE) throw new Error("not a small regular file");
      raw = readFileSync(out.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      out.setAside();
      return out;
    }
    let parsed: z.infer<typeof Stored>;
    try {
      parsed = Stored.parse(JSON.parse(raw));
    } catch {
      out.setAside();
      return out;
    }
    out.settings = parsed.settings;
    out.recent = parsed.recent.filter(directory);
    out.companion = parsed.companion;
    return out;
  }

  private setAside(): void {
    const aside = `${this.file}.invalid-${Date.now()}`;
    try {
      renameSync(this.file, aside);
      this.warning = `Saved desktop settings couldn't be read, so defaults are in use. The old file is kept as ${aside}.`;
    } catch {
      this.warning = "Saved desktop settings couldn't be read, so defaults are in use.";
    }
  }

  /** Replace the file atomically with a complete private temp file; a symlink at the name is replaced, never followed. */
  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: 1, settings: this.settings, recent: this.recent, companion: this.companion }, null, 2);
    const temp = join(this.dir, `.settings.json.${process.pid}.${randomBytes(6).toString("hex")}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.file);
    } catch (err) {
      unlinkSync(temp);
      throw err;
    }
  }

  /** Saved before it counts: a failed write leaves the previous settings in force. */
  update(next: Settings): void {
    const previous = this.settings;
    this.settings = SettingsSchema.parse(next);
    try {
      this.save();
    } catch (err) {
      this.settings = previous;
      throw err;
    }
  }

  remember(root: string): void {
    if (!isAbsolute(root)) throw new Error("a project root must be an absolute path");
    this.recent = [root, ...this.recent.filter((r) => r !== root)].slice(0, MAX_RECENT);
    this.save();
  }

  move(point: Point): void {
    this.companion = Point.parse(point);
    this.save();
  }
}

/**
 * Where a window of `size` goes so it is fully on one display's work area: the display it mostly
 * overlaps, or the nearest one when it has drifted off every screen (a monitor was unplugged).
 * With no saved point it starts at the bottom right of the primary display.
 */
export function placeOnScreen(saved: Point | null, size: { width: number; height: number }, areas: Rect[], primary: Rect): Point {
  const margin = 24;
  if (!saved) return { x: primary.x + primary.width - size.width - margin, y: primary.y + primary.height - size.height - margin };
  const overlap = (a: Rect) =>
    Math.max(0, Math.min(saved.x + size.width, a.x + a.width) - Math.max(saved.x, a.x)) *
    Math.max(0, Math.min(saved.y + size.height, a.y + a.height) - Math.max(saved.y, a.y));
  const distance = (a: Rect) => Math.hypot(a.x + a.width / 2 - (saved.x + size.width / 2), a.y + a.height / 2 - (saved.y + size.height / 2));
  const area = areas.length
    ? areas.reduce((best, a) => (overlap(a) > overlap(best) || (overlap(a) === overlap(best) && distance(a) < distance(best)) ? a : best))
    : primary;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));
  return {
    x: clamp(saved.x, area.x, area.x + area.width - size.width),
    y: clamp(saved.y, area.y, area.y + area.height - size.height),
  };
}

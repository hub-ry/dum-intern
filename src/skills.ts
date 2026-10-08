// What you've unlocked, as a tree that follows you across every zone.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileName, fromNote, toNote } from "./notes.ts";

/**
 * How a skill got unlocked. Every way is something they did, never something dum assumed.
 * "course" is history only: guided courses are gone, but notes they left still read.
 */
export type How = "typed" | "explained" | "course" | "added" | "reasoned";

/**
 * How far they've shown it. Recognize: they can say what it is and what it's for. Build: they
 * wrote it themselves. Apply: they have built it and decided when and why to use it.
 */
export type Level = "recognize" | "build" | "apply";

export const LEVELS: Level[] = ["recognize", "build", "apply"];

export function rank(l: Level): number {
  return LEVELS.indexOf(l) + 1;
}

/** The level a way of unlocking shows. */
export function levelOf(how: How): Level {
  return how === "explained" || how === "reasoned" ? "recognize" : "build";
}

export type Skill = {
  /** The name an engineer says out loud, so it matches the curated trees and what the wizard says. */
  name: string;
  /** The one language it's about, or "" for an idea that carries across languages. */
  lang: string;
  how: How;
  level: Level;
  /** Skills this one builds on directly, by name. */
  requires: string[];
  why: string;
  at: string;
};

export type Tree = { skills: Skill[] };

/** `DUM_HOME` exists for tests, and for anyone who wants their tree somewhere else. */
export function home(): string {
  return process.env.DUM_HOME || `${homedir()}/.dum`;
}

/** Where the notes live. Obsidian can open this folder as a vault. */
export function folder(dir = home()) {
  return `${dir}/skills`;
}

/**
 * The identity of a skill name, loose enough that obvious respellings of one idea land on one
 * node.
 */
export function key(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

/** Plural to singular for the obvious cases only. "status" and "redis" stay put. */
function singular(w: string): string {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

/** "printing" in python and "printing" in c++ are two skills. */
export function id(name: string, lang: string): string {
  return `${langName(lang)}:${key(name)}`;
}

const idOf = (s: Skill) => id(s.name, s.lang);

/** Every note in the folder, as a tree. */
export function read(dir = home()): Tree {
  let names: string[];
  try {
    names = readdirSync(folder(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return { skills: [] };
  }
  const byId = new Map<string, Skill>();
  for (const n of names.sort()) {
    let s: Skill | null = null;
    try {
      s = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
    } catch {
      continue;
    }
    if (!s || !key(s.name)) continue;
    // Two notes for one skill - a copy made by hand, usually. The newer wins.
    const prev = byId.get(idOf(s));
    if (!prev || s.at > prev.at) byId.set(idOf(s), s);
  }
  return { skills: [...byId.values()] };
}

/** All notes for one skill, newest first, including hand-named copies. */
function notesFor(dir: string, name: string, lang: string): string[] {
  const want = id(name, lang);
  try {
    return readdirSync(folder(dir))
      .filter((n) => n.endsWith(".md") && !n.startsWith("."))
      .flatMap((n) => {
        try {
          const s = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
          return s && idOf(s) === want ? [{ name: n, at: s.at }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.at === b.at ? a.name.localeCompare(b.name) : a.at > b.at ? -1 : 1)
      .map((n) => n.name);
  } catch {
    return [];
  }
}

/** The file name for a new note. The language goes in it, or two "printing"s would collide. */
export function noteName(s: { name: string; lang: string }): string {
  return fileName(s.lang ? `${s.name} (${s.lang})` : s.name);
}

/**
 * Write every skill whose note changed, each through a temp file and a rename. Throws on any IO
 * failure: a caller must not report credit that isn't on disk.
 */
export function write(t: Tree, dir = home()) {
  mkdirSync(folder(dir), { recursive: true });
  for (const s of t.skills) {
    const path = `${folder(dir)}/${notesFor(dir, s.name, s.lang)[0] ?? noteName(s)}`;
    const text = toNote(s);
    let was: string | null = null;
    try {
      was = readFileSync(path, "utf8");
    } catch {
      /* new note */
    }
    if (was === text) continue;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}

/**
 * When each skill was taken off, by id. Kept so a sync with the web copy knows the skill went
 * away on purpose, instead of bringing it back.
 */
export function removed(dir = home()): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(`${dir}/removed.json`, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function writeRemoved(all: Record<string, string>, dir = home()) {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${dir}/removed.json.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, `${dir}/removed.json`);
  } catch {
    /* a sync may bring it back; taking it off again is one command */
  }
}

/** Delete a skill's note. How you take one back. */
export function remove(name: string, lang: string, dir = home(), at = new Date().toISOString()): boolean {
  const notes = notesFor(dir, name, lang);
  if (!notes.length) return false;
  try {
    for (const n of notes) unlinkSync(`${folder(dir)}/${n}`);
    writeRemoved({ ...removed(dir), [id(name, lang)]: at }, dir);
    return true;
  } catch {
    return false;
  }
}

/** Start over, with the old notes moved aside rather than deleted. */
export function reset(dir = home()): string | null {
  // Every skill counts as taken off, or the web copy would hand them all straight back.
  const now = new Date().toISOString();
  writeRemoved({ ...removed(dir), ...Object.fromEntries(read(dir).skills.map((s) => [idOf(s), now])) }, dir);
  const stamp = now.replace(/[:.]/g, "-");
  const aside = `${folder(dir)}.before-reset-${stamp}`;
  let moved = false;
  if (existsSync(folder(dir))) {
    renameSync(folder(dir), aside);
    moved = true;
  }
  mkdirSync(folder(dir), { recursive: true });
  return moved ? aside : null;
}

export type Unlock = { name: string; lang?: string; how: How; level?: Level; requires?: string[]; why: string };

/** The tree with one more skill unlocked, or an existing one refreshed. */
export function unlock(t: Tree, u: Unlock): Tree {
  const lang = langName(u.lang ?? "");
  if (!key(u.name)) return t;
  const me = id(u.name, lang);
  const prev = t.skills.find((s) => idOf(s) === me);
  const requires: string[] = [];
  for (const r of [...(prev?.requires ?? []), ...(u.requires ?? [])]) {
    const name = r.trim();
    if (name && key(name) !== key(u.name) && !requires.some((x) => key(x) === key(name))) requires.push(name);
  }
  // A level never goes down by being shown again at a lower one.
  // Choosing an approach proves judgment, not implementation. Apply requires a prior build.
  const level = u.how === "reasoned"
    ? prev && rank(prev.level) >= rank("build") ? "apply" : "recognize"
    : u.level ?? levelOf(u.how);
  const raised = !prev || rank(level) >= rank(prev.level);
  const next: Skill = {
    name: prev?.name ?? u.name.trim(),
    lang,
    how: raised ? u.how : prev.how,
    level: raised ? level : prev.level,
    requires: requires.slice(0, 3),
    why: raised ? u.why : prev.why,
    at: new Date().toISOString(),
  };
  return { skills: [...t.skills.filter((s) => idOf(s) !== me), next] };
}

/** That exact skill: this name, in this language ("" for the language-free idea). */
export function find(t: Tree, name: string, lang = ""): Skill | undefined {
  const want = id(name, lang);
  return t.skills.find((s) => idOf(s) === want);
}

/** Every skill with this name, in any language. */
export function named(t: Tree, name: string): Skill[] {
  return t.skills.filter((s) => key(s.name) === key(name));
}

/**
 * Whether it's theirs at `need` or above, in this language. The language-free idea counts too,
 * but only in a language they've shown something in: knowing recursion doesn't write Rust.
 */
export function holds(t: Tree, name: string, lang: string, need: Level = "build"): boolean {
  const l = langName(lang);
  const enough = (s: Skill | undefined) => !!s && rank(s.level) >= rank(need);
  if (enough(find(t, name, l))) return true;
  if (!l) return named(t, name).some(enough);
  return enough(find(t, name, "")) && spoken(t, l);
}

/** The highest level they've shown a skill at here, or null. */
export function levelIn(t: Tree, name: string, lang: string): Level | null {
  for (const l of [...LEVELS].reverse()) if (holds(t, name, lang, l)) return l;
  return null;
}

/** Whether they've written anything at all in this language. Recognizing a library isn't that. */
export function spoken(t: Tree, lang: string): boolean {
  const l = langName(lang);
  return t.skills.some((s) => s.lang === l && rank(s.level) >= rank("build"));
}

const LANG_ALIASES: Record<string, string> = {
  cpp: "c++", cxx: "c++", cc: "c++", "c plus plus": "c++",
  py: "python", python3: "python",
  js: "javascript", node: "javascript", nodejs: "javascript",
  ts: "typescript", rs: "rust", golang: "go", rb: "ruby", kt: "kotlin", cs: "c#", csharp: "c#", sh: "shell", bash: "shell", zsh: "shell",
};

/** One spelling per language, so "cpp" and "C++" are the same tag. */
export function langName(l: string): string {
  const k = l.trim().toLowerCase();
  return LANG_ALIASES[k] ?? k;
}

const EXT_LANG: Record<string, string> = {
  c: "c", h: "c", cc: "c++", cpp: "c++", cxx: "c++", hpp: "c++", hh: "c++", py: "python", js: "javascript", mjs: "javascript",
  cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", rs: "rust", go: "go", java: "java", rb: "ruby",
  swift: "swift", kt: "kotlin", cs: "c#", php: "php", lua: "lua", sh: "shell", bash: "shell", zsh: "shell", zig: "zig", dart: "dart", sql: "sql",
};

/** The language a file is written in, by extension. "" when it isn't source. */
export function langOf(path: string): string {
  const ext = path.split("/").pop()!.split(".").slice(1).pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "";
}

/** "recursion (python)", or just the name for an idea that isn't one language's. */
export function label(s: { name: string; lang?: string }): string {
  return s.lang ? `${s.name} (${s.lang})` : s.name;
}

/** The tree as the intern sees it. */
export function describe(t: Tree): string {
  if (!t.skills.length) {
    return "THEIR SKILL TREE is empty. Every skill is locked: nothing gets written for them until they unlock it.";
  }
  const byLang = new Map<string, Skill[]>();
  for (const s of t.skills) byLang.set(s.lang, [...(byLang.get(s.lang) ?? []), s]);
  const out = [
    "THEIR SKILL TREE - what they've unlocked, and how far: recognize (can say what",
    "it is and what it's for), build (wrote it themselves), apply (decided when and",
    "why to use it after building it themselves). Anything not here is locked.",
    "A skill under a language counts only in that language. An idea with no",
    "language counts in any language they've unlocked something in.",
  ];
  for (const [lang, list] of [...byLang].sort(([a], [b]) => a.localeCompare(b))) {
    out.push("", `${lang || "any language"}:`, ...list.map((s) => `  - ${s.name} (${s.level})`));
  }
  return out.join("\n");
}

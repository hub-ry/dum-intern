// What you've unlocked, as a tree that follows you across repos.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileName, fromNote, toNote } from "./notes.ts";

/** How a skill got unlocked. Every way is something they did, never something dum assumed. */
export type How = "typed" | "explained" | "course" | "added";

export type Skill = {
  /** The name an engineer says out loud, so it matches the curated trees and what the wizard says. */
  name: string;
  /** The one language it's about, or "" for an idea that carries across languages. */
  lang: string;
  how: How;
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

/** The file a skill's note is in, if it has one already - it may have been named by hand. */
function noteFor(dir: string, name: string, lang: string): string | undefined {
  const want = id(name, lang);
  try {
    return readdirSync(folder(dir))
      .filter((n) => n.endsWith(".md"))
      .find((n) => {
        try {
          const s = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
          return !!s && idOf(s) === want;
        } catch {
          return false;
        }
      });
  } catch {
    return undefined;
  }
}

/** The file name for a new note. The language goes in it, or two "printing"s would collide. */
export function noteName(s: { name: string; lang: string }): string {
  return fileName(s.lang ? `${s.name} (${s.lang})` : s.name);
}

/** Write every skill whose note changed, each through a temp file and a rename. */
export function write(t: Tree, dir = home()) {
  try {
    mkdirSync(folder(dir), { recursive: true });
    for (const s of t.skills) {
      const path = `${folder(dir)}/${noteFor(dir, s.name, s.lang) ?? noteName(s)}`;
      const text = toNote(s);
      let was: string | null = null;
      try {
        was = readFileSync(path, "utf8");
      } catch {
        /* new note */
      }
      if (was === text) continue;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    }
  } catch {
    /* losing the record is bad, crashing over it is worse */
  }
}

/** Delete a skill's note. How you take one back. */
export function remove(name: string, lang: string, dir = home()): boolean {
  const n = noteFor(dir, name, lang);
  if (!n) return false;
  try {
    unlinkSync(`${folder(dir)}/${n}`);
    return true;
  } catch {
    return false;
  }
}

/** Start over, with the old notes moved aside rather than deleted. */
export function reset(dir = home()): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${folder(dir)}.before-reset-${stamp}`;
  let moved = false;
  if (existsSync(folder(dir))) {
    renameSync(folder(dir), aside);
    moved = true;
  }
  mkdirSync(folder(dir), { recursive: true });
  return moved ? aside : null;
}

export type Unlock = { name: string; lang?: string; how: How; requires?: string[]; why: string };

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
  const next: Skill = {
    name: prev?.name ?? u.name.trim(),
    lang,
    how: u.how,
    requires: requires.slice(0, 3),
    why: u.why,
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
 * Whether it's theirs, for writing code on it in this language. The language-free idea counts
 * too, but only in a language they've shown something in: knowing recursion doesn't write Rust.
 */
export function holds(t: Tree, name: string, lang: string): boolean {
  const l = langName(lang);
  if (find(t, name, l)) return true;
  if (!l) return named(t, name).length > 0;
  return !!find(t, name, "") && spoken(t, l);
}

/** Whether they've unlocked anything at all in this language. */
export function spoken(t: Tree, lang: string): boolean {
  const l = langName(lang);
  return t.skills.some((s) => s.lang === l);
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
  swift: "swift", kt: "kotlin", cs: "c#", php: "php", lua: "lua", sh: "shell", bash: "shell", zsh: "shell", zig: "zig", dart: "dart",
};

/** The language a file is written in, by extension. "" when it isn't source. */
export function langOf(path: string): string {
  const ext = path.split("/").pop()!.split(".").slice(1).pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "";
}

/** A file extension for a language, for the scratch files a course writes. */
export function extFor(lang: string): string {
  const l = langName(lang);
  return Object.entries(EXT_LANG).find(([, v]) => v === l)?.[0] ?? "txt";
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
    "THEIR SKILL TREE - what they've unlocked. Anything not here is locked.",
    "A skill under a language counts only in that language. An idea with no",
    "language counts in any language they've unlocked something in.",
  ];
  for (const [lang, list] of [...byLang].sort(([a], [b]) => a.localeCompare(b))) {
    out.push("", `${lang || "any language"}:`, ...list.map((s) => `  - ${s.name}`));
  }
  return out.join("\n");
}

// What you have already shown you understand, as a tree that follows you.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { fileName, fromNote, toNote } from "./notes.ts";

export type Breadth = "general" | "niche";

export type Skill = {
  /** The industry name, so it matches what the wizard and `teach` would say. */
  name: string;
  /** True once they explained it. False when the intern had to teach it. */
  solid: boolean;
  /**
   * They say they hold it - a scan of their own project, or a note they wrote - but never
   * showed dum.
   */
  claimed: boolean;
  breadth: Breadth;
  /**
   * The one language this skill is about, when it's syntax, a standard library or an idiom:
   * "range-based for" is c++.
   */
  lang: string;
  /** Skills this one builds on directly, by name. May name skills not yet on the tree. */
  requires: string[];
  why: string;
  /** Repo roots where it was shown. Only meaningful while solid. */
  repos: string[];
  at: string;
};

export type Tree = { skills: Skill[] };

const EMPTY: Tree = { skills: [] };

/** `DUM_HOME` exists for tests, and for anyone who wants their tree somewhere else. */
export function home(): string {
  return process.env.DUM_HOME || `${homedir()}/.dum`;
}

/** The old single-file tree, read once to seed the notes. */
function legacy(dir: string) {
  return `${dir}/skills.json`;
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
  return words(name).join(" ");
}

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
    .map(singular);
}

/** Plural to singular for the obvious cases only. "status" and "redis" stay put. */
function singular(w: string): string {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

const MINOR = new Set(["a", "an", "the", "of", "in", "on", "for", "to", "and", "with"]);

/** A skill already on the tree that might be this one under another name, or undefined. */
export function similar(t: Tree, name: string): Skill | undefined {
  const mine = new Set(words(name).filter((w) => !MINOR.has(w)));
  if (!mine.size) return undefined;
  return t.skills.find((s) => {
    if (key(s.name) === key(name)) return false;
    const theirs = new Set(words(s.name).filter((w) => !MINOR.has(w)));
    if (!theirs.size) return false;
    const [small, big] = mine.size <= theirs.size ? [mine, theirs] : [theirs, mine];
    return [...small].every((w) => big.has(w));
  });
}

const str = (v: unknown): v is string => typeof v === "string";

function clean(raw: unknown): Skill | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (!str(s.name) || !s.name.trim() || typeof s.solid !== "boolean") return null;
  return {
    name: s.name.trim(),
    solid: s.solid,
    claimed: s.claimed === true,
    breadth: s.breadth === "niche" ? "niche" : "general",
    lang: typeof s.lang === "string" ? langName(s.lang) : "",
    requires: Array.isArray(s.requires) ? s.requires.filter(str) : [],
    why: str(s.why) ? s.why : "",
    repos: Array.isArray(s.repos) ? s.repos.filter(str) : [],
    at: str(s.at) ? s.at : "",
  };
}

/** Every note in the folder, as a tree. */
export function read(dir = home()): Tree {
  seed(dir);
  let names: string[];
  try {
    names = readdirSync(folder(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return EMPTY;
  }
  const byKey = new Map<string, Skill>();
  for (const n of names.sort()) {
    let s: Skill | null = null;
    try {
      s = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
    } catch {
      continue;
    }
    if (!s || !key(s.name)) continue;
    // Two notes for one skill - a copy made by hand, usually. The newer wins.
    const prev = byKey.get(key(s.name));
    if (!prev || s.at > prev.at) byKey.set(key(s.name), s);
  }
  return { skills: [...byKey.values()] };
}

function seed(dir: string) {
  if (existsSync(folder(dir)) || !existsSync(legacy(dir))) return;
  let raw: { skills?: unknown };
  try {
    raw = JSON.parse(readFileSync(legacy(dir), "utf8"));
  } catch {
    return; // unreadable - left where it is for a person to look at
  }
  const skills = Array.isArray(raw?.skills) ? raw.skills.map(clean).filter((s): s is Skill => !!s) : [];
  write({ skills }, dir);
  try {
    renameSync(legacy(dir), `${legacy(dir)}.migrated`);
  } catch {
    /* the notes exist now, so the old file is never read again */
  }
}

function noteFor(dir: string, name: string): string | undefined {
  const k = key(name);
  try {
    return readdirSync(folder(dir))
      .filter((n) => n.endsWith(".md"))
      .find((n) => {
        try {
          const s = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
          return s && key(s.name) === k;
        } catch {
          return false;
        }
      });
  } catch {
    return undefined;
  }
}

/** Write every skill whose note changed, each through a temp file and a rename. */
export function write(t: Tree, dir = home()) {
  try {
    mkdirSync(folder(dir), { recursive: true });
    for (const s of t.skills) {
      const name = noteFor(dir, s.name) ?? fileName(s.name);
      const path = `${folder(dir)}/${name}`;
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

/** Delete a skill's note. How you dispute something, or take back a claim. */
export function remove(name: string, dir = home()): boolean {
  const n = noteFor(dir, name);
  if (!n) return false;
  try {
    unlinkSync(`${folder(dir)}/${n}`);
    return true;
  } catch {
    return false;
  }
}

/** Start over. */
export function reset(dir = home()): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${folder(dir)}.before-reset-${stamp}`;
  let moved = false;
  if (existsSync(folder(dir))) {
    renameSync(folder(dir), aside);
    moved = true;
  }
  // Or the old file would seed the fresh tree straight back.
  if (existsSync(legacy(dir))) {
    renameSync(legacy(dir), `${legacy(dir)}.before-reset-${stamp}`);
    moved = true;
  }
  mkdirSync(folder(dir), { recursive: true });
  return moved ? aside : null;
}

export type Entry = {
  name: string;
  solid: boolean;
  breadth: Breadth;
  lang?: string;
  requires: string[];
  why: string;
};

/** Record what a skill looks like now, as shown in `root`. */
export function note(t: Tree, e: Entry, root: string): Tree {
  const k = key(e.name);
  if (!k) return t;
  const prev = t.skills.find((s) => key(s.name) === k);

  // Prerequisites are spelled the way the tree already spells them, so a casing difference does
  // not grow a second node.
  const canon = (n: string) => t.skills.find((s) => key(s.name) === key(n))?.name ?? n.trim();
  const requires: string[] = [];
  for (const r of [...(prev?.requires ?? []), ...e.requires]) {
    const name = canon(r);
    if (name && key(name) !== k && !requires.some((x) => key(x) === key(name))) requires.push(name);
  }

  // Where it was shown only means something while it is solid.
  const repos = e.solid
    ? [...new Set([...(prev?.solid ? prev.repos : []), root])]
    : [];

  const next: Skill = {
    name: prev?.name ?? e.name.trim(),
    solid: e.solid,
    // dum saw it for itself, so whatever was claimed is now settled.
    claimed: false,
    breadth: e.breadth,
    lang: e.lang !== undefined ? langName(e.lang) : prev?.lang ?? "",
    requires,
    why: e.why,
    repos,
    at: new Date().toISOString(),
  };
  return { skills: [...t.skills.filter((s) => key(s.name) !== k), next] };
}

export type Claim = { name: string; breadth: Breadth; requires: string[]; why: string; lang?: string };

/** Add what they say they hold, from a scan of their own project. */
export function claim(t: Tree, c: Claim, root: string): Tree {
  const k = key(c.name);
  const prev = t.skills.find((s) => key(s.name) === k);
  if (!k || (prev && !prev.claimed)) return t;
  const next: Skill = {
    name: prev?.name ?? c.name.trim(),
    solid: true,
    claimed: true,
    breadth: c.breadth,
    lang: c.lang !== undefined ? langName(c.lang) : prev?.lang ?? "",
    requires: [...new Set([...(prev?.requires ?? []), ...c.requires])].filter((r) => key(r) !== k).slice(0, 3),
    why: c.why,
    repos: [...new Set([...(prev?.repos ?? []), root])],
    at: new Date().toISOString(),
  };
  return { skills: [...t.skills.filter((s) => key(s.name) !== k), next] };
}

export function find(t: Tree, name: string): Skill | undefined {
  return t.skills.find((s) => key(s.name) === key(name));
}

/** Take a skill off the tree. How you dispute something the intern got wrong. */
export function forget(t: Tree, name: string): Tree {
  return { skills: t.skills.filter((s) => key(s.name) !== key(name)) };
}

/** How long a skill counts as known before it earns one quick re-check. */
const FRESH_DAYS: Record<Breadth, number> = { general: 365, niche: 60 };

/** Known, but long enough ago that one quick check is fair. */
export function stale(s: Skill, now = new Date()): boolean {
  if (!s.solid || !s.at) return false;
  const age = (now.getTime() - new Date(s.at).getTime()) / 86_400_000;
  return Number.isFinite(age) && age > FRESH_DAYS[s.breadth];
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

/** Whether a skill on the tree lets dum write code for it in this file. */
export function holdsIn(t: Tree, name: string, path: string, root: string): boolean {
  const s = find(t, name);
  if (!s || !s.solid) return false;
  if (s.breadth === "niche" && !s.claimed && !s.repos.includes(root)) return false;
  const here = langOf(path);
  if (!here) return true;
  if (s.lang && s.lang !== here) return false;
  // A language they've never shown anything in: every line of it is theirs, however well they
  // know the idea.
  return spoken(t, here);
}

export type Level = { name: "novice" | "developing" | "fluent"; count: number; gap: number; scaffold: boolean };

/**
 * How far along they are in a language, for fading (Kalyuga et al., 2003):
 * novices get most of the code given and small gaps, fluent ones do the work.
 * `gap` is the most lines one hole may ask of them; `scaffold` is whether dum
 * may write the code around the gaps itself.
 */
export function level(t: Tree, lang: string): Level {
  const count = t.skills.filter((s) => s.solid && !s.claimed && (lang ? s.lang === lang : true)).length;
  if (count < 3) return { name: "novice", count, gap: 3, scaffold: true };
  if (count < 10) return { name: "developing", count, gap: 8, scaffold: true };
  return { name: "fluent", count, gap: Infinity, scaffold: false };
}

/** Whether they've shown anything at all in this language. */
export function spoken(t: Tree, lang: string): boolean {
  return t.skills.some((s) => s.solid && s.lang === lang);
}

/** Solid and trusted in this repo: general anywhere, niche only where shown. */
export function known(t: Tree, root: string): Skill[] {
  return t.skills.filter((s) => s.solid && !s.claimed && (s.breadth === "general" || s.repos.includes(root)));
}

/** They say they hold it; dum has not seen it yet. */
export function claimed(t: Tree): Skill[] {
  return t.skills.filter((s) => s.claimed);
}

/** Solid, but niche and shown somewhere else. Worth one quick check here. */
export function elsewhere(t: Tree, root: string): Skill[] {
  return t.skills.filter((s) => s.solid && !s.claimed && s.breadth === "niche" && !s.repos.includes(root));
}

/** Taught, or claimed and then fumbled. */
export function shaky(t: Tree): Skill[] {
  return t.skills.filter((s) => !s.solid);
}

/** Fold a repo's old `.dum/knowledge.json` into the tree. */
export function migrate(t: Tree, root: string): Tree {
  let old: unknown;
  try {
    old = JSON.parse(readFileSync(`${root}/.dum/knowledge.json`, "utf8"));
  } catch {
    return t;
  }
  const topics = (old as { topics?: unknown })?.topics;
  if (!Array.isArray(topics)) return t;
  const added: Skill[] = [];
  for (const raw of topics) {
    const o = raw as Record<string, unknown>;
    if (!o || !str(o.topic) || !o.topic.trim() || typeof o.solid !== "boolean") continue;
    if (find(t, o.topic) || added.some((s) => key(s.name) === key(o.topic as string))) continue;
    added.push({
      name: o.topic.trim(),
      solid: o.solid,
      claimed: false,
      lang: "",
      breadth: "general",
      requires: [],
      why: str(o.why) ? o.why : "",
      repos: o.solid ? [root] : [],
      at: str(o.at) ? o.at : "",
    });
  }
  return added.length ? { skills: [...t.skills, ...added] } : t;
}

/** The tree as the intern sees it. Empty string when there is nothing to say. */
export function describe(t: Tree, root: string): string {
  if (!t.skills.length) return "";
  const line = (s: Skill) => {
    const on = s.requires.length ? `  [builds on: ${s.requires.join(", ")}]` : "";
    const only = s.lang ? `  (${s.lang} only)` : "";
    return `  - ${s.name}${only}${on}`;
  };
  const out: string[] = [
    "THEIR SKILL TREE",
    "",
    "Everything they have shown you or been taught, across every project. Use",
    "these exact names when you record something that is the same idea.",
    "A skill marked (<language> only) counts only in that language. In another",
    "language it is NOT known: their Python for loops don't write C++'s.",
  ];
  const now = new Date();
  const k = known(t, root).filter((s) => !stale(s, now));
  if (k.length) {
    out.push(
      "",
      "KNOWN. They explained these. Build on them without asking, and never",
      "re-teach them:",
      ...k.map(line),
    );
  }
  const old = known(t, root).filter((s) => stale(s, now));
  if (old.length) {
    out.push(
      "",
      "KNOWN, BUT A WHILE AGO. If this build leans on one, ONE short check is fair",
      "- never a re-teach:",
      ...old.map(line),
    );
  }
  const e = elsewhere(t, root);
  if (e.length) {
    out.push(
      "",
      "SHOWN IN ANOTHER PROJECT, AND NICHE. One-off knowledge fades. If this build",
      "actually leans on one of these, ONE short check is fair - never a re-teach:",
      ...e.map((s) => `${line(s)}  (in ${s.repos.map((r) => basename(r)).join(", ")})`),
    );
  }
  const cl = claimed(t);
  if (cl.length) {
    out.push(
      "",
      "CLAIMED. They say they hold these - from code they wrote themselves - but",
      "never showed you. Don't teach them. The first time this build actually",
      "leans on one, ONE short check; if they get it, note_understanding solid:",
      ...cl.map(line),
    );
  }
  const w = shaky(t);
  if (w.length) {
    out.push(
      "",
      "SHAKY. You had to teach these, or they fumbled them. A quick check is fair",
      "when this build leans on one, but do not teach it from scratch again:",
      ...w.map(line),
    );
  }
  return out.join("\n");
}

/** Counts for a header. */
export function summary(t: Tree, root: string): { known: number; shaky: number; claimed: number } {
  return { known: known(t, root).length, shaky: shaky(t).length, claimed: claimed(t).length };
}

export type Row = {
  depth: number;
  name: string;
  /** `ghost` is a prerequisite something builds on that they have not shown yet. */
  state: "solid" | "shaky" | "claimed" | "ghost";
  niche: boolean;
  /** The language it's scoped to, or "". */
  lang: string;
  /** Already drawn further up under another parent, so its children are not repeated. */
  repeat: boolean;
};

/** The tree as rows to draw, roots first. */
export function rows(t: Tree): Row[] {
  const byKey = new Map(t.skills.map((s) => [key(s.name), s]));
  const ghosts = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const s of t.skills) {
    for (const r of s.requires) {
      const rk = key(r);
      if (!byKey.has(rk) && !ghosts.has(rk)) ghosts.set(rk, r);
      children.set(rk, [...(children.get(rk) ?? []), key(s.name)]);
    }
  }
  const nameOf = (k: string) => byKey.get(k)?.name ?? ghosts.get(k) ?? k;
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b));

  // Real roots before ghosts, so a skill is drawn in full under the branch you actually built
  // and only back-referenced under a prerequisite you have not shown yet.
  const all = [...byKey.keys(), ...ghosts.keys()];
  const roots = [
    ...[...byKey.keys()].filter((k) => !byKey.get(k)!.requires.length).sort(byName),
    ...[...ghosts.keys()].sort(byName),
  ];

  const out: Row[] = [];
  const drawn = new Set<string>();
  const walk = (k: string, depth: number) => {
    const s = byKey.get(k);
    const repeat = drawn.has(k);
    out.push({
      depth,
      name: nameOf(k),
      state: s ? (s.claimed ? "claimed" : s.solid ? "solid" : "shaky") : "ghost",
      niche: s?.breadth === "niche",
      lang: s?.lang ?? "",
      repeat,
    });
    if (repeat) return;
    drawn.add(k);
    for (const c of [...(children.get(k) ?? [])].sort(byName)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const k of all.sort(byName)) if (!drawn.has(k)) walk(k, 0);
  return out;
}

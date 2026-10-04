// The curated skill tracks, and the rule they exist for: no course before its prerequisites.
// Someone who can't print hello world doesn't get to unlock recursion.

import YAML from "yaml";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import * as skills from "./skills.ts";

/** `in`: for a skill no one language owns (git, http), the language its course is written in. */
export type Node = { name: string; requires: string[]; in?: string };
/** A named ladder in one language, or in none ("" - ideas like http that carry everywhere). */
export type Track = { name: string; lang: string; skills: Node[] };

const DIR = new URL("./trees/", import.meta.url).pathname;
let loaded: Track[] | null = null;

/**
 * A track as written: each skill a name, a name mapped to what it builds on, or a name mapped to
 * `{ requires, in }`.
 */
export function parseTrack(text: string, file = ""): Track | null {
  let raw: any;
  try {
    raw = YAML.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw.lang !== "string" || !Array.isArray(raw.skills)) return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : []);
  const nodes: Node[] = [];
  for (const item of raw.skills) {
    if (typeof item === "string") nodes.push({ name: item, requires: [] });
    else if (item && typeof item === "object") {
      const [name, v] = Object.entries(item)[0] ?? [];
      if (typeof name !== "string") continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        nodes.push({ name, requires: strs(o.requires), ...(typeof o.in === "string" ? { in: skills.langName(o.in) } : {}) });
      } else nodes.push({ name, requires: strs(v) });
    }
  }
  const lang = skills.langName(raw.lang);
  const name = typeof raw.track === "string" ? raw.track : lang || file;
  return { name, lang, skills: nodes };
}

/** Every curated track. */
export function tracks(): Track[] {
  if (!loaded) {
    loaded = [];
    let files: string[] = [];
    try {
      files = readdirSync(DIR).filter((n) => n.endsWith(".yaml")).sort();
    } catch {
      /* no tracks: the model maps every prerequisite instead */
    }
    for (const f of files) {
      try {
        const t = parseTrack(readFileSync(`${DIR}${f}`, "utf8"), f.slice(0, -5));
        if (t) loaded.push(t);
      } catch {
        /* a broken file is no track */
      }
    }
  }
  return loaded;
}

/** Languages with a curated track of their own. */
export function languages(): string[] {
  return [...new Set(tracks().map((t) => t.lang).filter(Boolean))].sort();
}

/** Every curated skill in a language, across its tracks. */
function nodes(lang: string): Node[] {
  const l = skills.langName(lang);
  return tracks().filter((t) => t.lang === l).flatMap((t) => t.skills);
}

/** Every curated skill name in a language, lowest first. */
export function names(lang: string): string[] {
  return nodes(lang).map((n) => n.name);
}

export function curated(name: string, lang: string): Node | undefined {
  return nodes(lang).find((n) => skills.key(n.name) === skills.key(name));
}

/** The track's spelling of a skill, so the intern's "Recursion" lands on the tree's "recursion". */
export function canonical(name: string, lang: string): string {
  return curated(name, lang)?.name ?? name.trim();
}

/**
 * Where a skill lives, asked about from a language. "http" from python is the language-free
 * builder skill, and its course is written in python unless the track says otherwise.
 */
export function locate(name: string, lang: string): { lang: string; exercise: string } {
  const l = skills.langName(lang);
  if (l && curated(name, l)) return { lang: l, exercise: l };
  const idea = curated(name, "");
  if (idea) return { lang: "", exercise: idea.in ?? l };
  return { lang: l, exercise: l };
}

// Prerequisites the model named for skills off the curated tracks, kept so the gate gives the
// same answer every time it's asked rather than whatever the model says today.
const mapFile = () => `${skills.home()}/prereqs.json`;

function readMap(): Record<string, string[]> {
  try {
    const raw = JSON.parse(readFileSync(mapFile(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function mapped(name: string, lang: string): string[] | undefined {
  const got = readMap()[skills.id(name, lang)];
  return Array.isArray(got) ? got.filter((r) => typeof r === "string") : undefined;
}

/** Remember what an off-track skill builds on. A curated skill's prerequisites are never overridden. */
export function map(name: string, lang: string, requires: string[]) {
  if (curated(name, lang) || mapped(name, lang)) return;
  const all = readMap();
  all[skills.id(name, lang)] = requires
    .map((r) => canonical(r, lang))
    .filter((r) => r && skills.key(r) !== skills.key(name))
    .slice(0, 3);
  try {
    mkdirSync(skills.home(), { recursive: true });
    const tmp = `${mapFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, mapFile());
  } catch {
    /* the gate falls back to "no prerequisites known", which is the old behaviour */
  }
}

/** What a skill builds on: the track's word first, then what the model mapped. */
export function prereqs(name: string, lang: string): string[] {
  return curated(name, lang)?.requires ?? mapped(name, lang) ?? [];
}

export type Status =
  | { state: "unlocked" }
  /** Every prerequisite is theirs, so the course (or the explanation) is open. */
  | { state: "open" }
  /** `next` is the lowest rung they can take a course on right now. */
  | { state: "locked"; missing: string[]; next: string };

/** What a prerequisite has to be held at, to ask for a skill at `need`. Deciding when isn't required below. */
function below(need: skills.Level): skills.Level {
  return need === "apply" ? "build" : need;
}

/** Whether a skill is theirs at `need`, and if not, whether they can get it from here. */
export function status(t: skills.Tree, name: string, lang: string, need: skills.Level = "build"): Status {
  if (skills.holds(t, name, lang, need)) return { state: "unlocked" };
  const missing = prereqs(name, lang).filter((r) => !skills.holds(t, r, lang, below(need)));
  if (!missing.length) return { state: "open" };
  return { state: "locked", missing, next: firstRung(t, missing, lang, below(need), new Set([skills.key(name)])) };
}

/** Down through what's missing until something is open. "" if every path loops. */
function firstRung(t: skills.Tree, from: string[], lang: string, need: skills.Level, seen: Set<string>): string {
  for (const m of from) {
    const k = skills.key(m);
    if (seen.has(k)) continue;
    seen.add(k);
    const miss = prereqs(m, lang).filter((r) => !skills.holds(t, r, lang, need));
    if (!miss.length) return canonical(m, lang);
    const deeper = firstRung(t, miss, lang, need, seen);
    if (deeper) return deeper;
  }
  return "";
}

/** The courses open right now on a track. */
export function frontier(t: skills.Tree, track: Track): string[] {
  return track.skills.filter((n) => status(t, n.name, track.lang).state === "open").map((n) => n.name);
}

/** How far along a track they are, counting what they've built. */
export function progress(t: skills.Tree, track: Track): { done: number; total: number } {
  return { done: track.skills.filter((n) => skills.holds(t, n.name, track.lang)).length, total: track.skills.length };
}

/** ▰ for what they've built, ▱ for the rest: the edge AI works up to. */
export function bar(done: number, total: number, cells = 16): string {
  if (total <= 0) return "";
  const on = Math.round((Math.min(done, total) / total) * cells);
  return "█".repeat(on) + "░".repeat(cells - on);
}

/** How many locked skills a track shows before it says how many more there are. */
const LOCKED_SHOWN = 3;

/**
 * The tree as plain lines: each track as a bar, then what's built, what's only recognized, what's
 * open and the first of what's locked, plus anything unlocked off the tracks.
 */
export function view(t: skills.Tree, langs: string[]): string[] {
  const want = new Set(langs.map(skills.langName).filter(Boolean));
  const mine = new Set(t.skills.map((s) => s.lang));
  const shown = tracks().filter((tr) => !tr.lang || want.has(tr.lang) || tr.skills.some((n) => skills.levelIn(t, n.name, tr.lang)));
  const out: string[] = [];
  const mark = (name: string, lang: string) => {
    const level = skills.levelIn(t, name, lang);
    if (level && skills.rank(level) >= skills.rank("build")) return `  ● ${name}${level === "apply" ? "  applied" : ""}`;
    if (level) return `  ◐ ${name}  recognized`;
    return null;
  };
  for (const tr of shown) {
    const p = progress(t, tr);
    out.push(`${tr.lang && tr.name !== tr.lang ? `${tr.lang} · ${tr.name}` : tr.name}  ${bar(p.done, p.total)}  ${p.done}/${p.total}`);
    let locked = 0;
    for (const n of tr.skills) {
      const m = mark(n.name, tr.lang);
      if (m) {
        out.push(m);
        continue;
      }
      const st = status(t, n.name, tr.lang);
      if (st.state === "open") out.push(`  ○ ${n.name}  course open`);
      else if (st.state === "locked" && locked++ < LOCKED_SHOWN) out.push(`  · ${n.name}  needs ${st.missing.join(", ")}${st.next ? `  next: course ${st.next}${tr.lang ? ` in ${tr.lang}` : ""}` : ""}`);
    }
    if (locked > LOCKED_SHOWN) out.push(`  · ${locked - LOCKED_SHOWN} more locked`);
    out.push("");
  }
  // Anything unlocked off the tracks: libraries, tools, one-off ideas.
  for (const lang of [...mine].sort()) {
    const off = t.skills.filter((s) => s.lang === lang && !curated(s.name, lang));
    if (!off.length) continue;
    out.push(`${lang || "any language"} · off the tracks`);
    for (const s of off) out.push(mark(s.name, lang)!);
    out.push("");
  }
  return out;
}

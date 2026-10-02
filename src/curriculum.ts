// The curated skill trees, and the rule they exist for: no course before its prerequisites.
// Someone who can't print hello world doesn't get to unlock recursion.

import YAML from "yaml";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import * as skills from "./skills.ts";

export type Node = { name: string; requires: string[] };
export type Track = { lang: string; skills: Node[] };

const DIR = new URL("./trees/", import.meta.url).pathname;
const tracks = new Map<string, Track | null>();

/** A curated track as written: each skill a name, or a name mapped to what it builds on. */
export function parseTrack(text: string): Track | null {
  let raw: any;
  try {
    raw = YAML.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw.lang !== "string" || !Array.isArray(raw.skills)) return null;
  const nodes: Node[] = [];
  for (const item of raw.skills) {
    if (typeof item === "string") nodes.push({ name: item, requires: [] });
    else if (item && typeof item === "object") {
      const [name, req] = Object.entries(item)[0] ?? [];
      if (typeof name === "string") nodes.push({ name, requires: Array.isArray(req) ? req.filter((r) => typeof r === "string") : [] });
    }
  }
  return { lang: skills.langName(raw.lang), skills: nodes };
}

/** The curated track for a language, or null when there isn't one. */
export function track(lang: string): Track | null {
  const l = skills.langName(lang);
  if (!l) return null;
  if (!tracks.has(l)) {
    let t: Track | null = null;
    try {
      t = parseTrack(readFileSync(`${DIR}${l}.yaml`, "utf8"));
    } catch {
      /* no track for this language: the model maps its prerequisites instead */
    }
    tracks.set(l, t);
  }
  return tracks.get(l)!;
}

/** Languages with a curated track. */
export function languages(): string[] {
  try {
    return readdirSync(DIR)
      .filter((n) => n.endsWith(".yaml"))
      .map((n) => n.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

export function curated(name: string, lang: string): Node | undefined {
  return track(lang)?.skills.find((n) => skills.key(n.name) === skills.key(name));
}

/** The track's spelling of a skill, so the intern's "Recursion" lands on the tree's "recursion". */
export function canonical(name: string, lang: string): string {
  return curated(name, lang)?.name ?? name.trim();
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
  /** Every prerequisite is theirs, so the course is open. */
  | { state: "open" }
  /** `next` is the lowest rung they can take a course on right now. */
  | { state: "locked"; missing: string[]; next: string };

export function status(t: skills.Tree, name: string, lang: string): Status {
  if (skills.holds(t, name, lang)) return { state: "unlocked" };
  const missing = prereqs(name, lang).filter((r) => !skills.holds(t, r, lang));
  if (!missing.length) return { state: "open" };
  return { state: "locked", missing, next: firstRung(t, missing, lang, new Set([skills.key(name)])) };
}

/** Down through what's missing until something is open. "" if every path loops. */
function firstRung(t: skills.Tree, from: string[], lang: string, seen: Set<string>): string {
  for (const m of from) {
    const k = skills.key(m);
    if (seen.has(k)) continue;
    seen.add(k);
    const miss = prereqs(m, lang).filter((r) => !skills.holds(t, r, lang));
    if (!miss.length) return canonical(m, lang);
    const deeper = firstRung(t, miss, lang, seen);
    if (deeper) return deeper;
  }
  return "";
}

/** The courses open right now in a language: curated skills whose prerequisites are all theirs. */
export function frontier(t: skills.Tree, lang: string): string[] {
  return (track(lang)?.skills ?? []).filter((n) => status(t, n.name, lang).state === "open").map((n) => n.name);
}

/** How far along a curated track they are. */
export function progress(t: skills.Tree, lang: string): { done: number; total: number } | null {
  const tr = track(lang);
  if (!tr) return null;
  return { done: tr.skills.filter((n) => skills.holds(t, n.name, lang)).length, total: tr.skills.length };
}

export type Row = { name: string; state: Status["state"]; needs: string[]; curated: boolean };

/** A language's skills to draw: the curated track in order, then anything unlocked off it. */
export function rows(t: skills.Tree, lang: string): Row[] {
  const l = skills.langName(lang);
  const out: Row[] = (track(l)?.skills ?? []).map((n) => {
    const s = status(t, n.name, l);
    return { name: n.name, state: s.state, needs: s.state === "locked" ? s.missing : [], curated: true };
  });
  for (const s of t.skills) {
    if (s.lang !== l || curated(s.name, l)) continue;
    out.push({ name: s.name, state: "unlocked", needs: [], curated: false });
  }
  return out;
}

/** The tree as plain lines: per language, what's unlocked, what's open, and what's still locked. */
export function view(t: skills.Tree, langs: string[]): string[] {
  const out: string[] = [];
  const shown = new Set<string>();
  for (const lang of langs.map(skills.langName)) {
    if (!lang || shown.has(lang)) continue;
    shown.add(lang);
    const rs = rows(t, lang);
    if (!rs.length) continue;
    const p = progress(t, lang);
    out.push(`${lang}${p ? `  ${p.done}/${p.total}` : ""}`);
    for (const r of rs) {
      if (r.state === "unlocked") out.push(`  ● ${r.name}`);
      else if (r.state === "open") out.push(`  ○ ${r.name}  course open`);
      else out.push(`  · ${r.name}  needs ${r.needs.join(", ")}`);
    }
    out.push("");
  }
  const ideas = t.skills.filter((s) => !s.lang);
  if (ideas.length) {
    out.push("any language");
    for (const s of ideas) out.push(`  ● ${s.name}`);
    out.push("");
  }
  return out;
}

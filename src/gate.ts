// The capability gate, decided in code: what AI may write from the user's unlocked tree.
// Pure: reads the tree and the curated tracks, never writes a file. Paths are shared resource
// names (`<grant-id>/<relative>`), matched exactly; a held skill never opens an unshared file.

import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import { ResourcePathSchema } from "./share-types.ts";

/**
 * Both modes keep the same gate: a concept needs building and a tool needs recognizing.
 * Anti-vibe uses the user's approach and asks only for reasoning the implementation still needs.
 */
export type Mode = "understand" | "anti-vibe";

/**
 * What a piece of a build is. A concept is something to know how to write: a language feature, a
 * data structure, an algorithm, anything on a curated track. A tool is technology breadth: one
 * library, framework, API or command. You don't have to memorize breadth before AI uses it.
 */
export type Kind = "concept" | "tool";

/** One skill a change rests on, as the intern names it. */
export type PieceInput = {
  skill: string;
  lang?: string;
  what: string;
  requires?: string[];
  kind?: Kind;
  core?: boolean;
  /** Shared resource names this piece would change. */
  paths?: string[];
};

/** One skill a change rests on, and where it stands on their tree. */
export type Piece = {
  skill: string;
  lang: string;
  what: string;
  requires: string[];
  kind: Kind;
  /** The heart of the request - the part that makes it this program and not another. */
  core: boolean;
  paths: string[];
  need: skills.Level;
  status: curriculum.Status;
};

/** The level a piece needs before AI may write it: building for a concept, recognizing for a tool. */
export function needFor(kind: Kind, _mode: Mode): skills.Level {
  return kind === "tool" ? "recognize" : "build";
}

/** A shared resource name exactly as granted, or "" for anything else. */
export function normalPath(p: string): string {
  const clean = p.trim();
  return ResourcePathSchema.safeParse(clean).success ? clean : "";
}

/** What a skill builds on: the tracks' word, what was mapped before, then what the intern named. */
function requiresOf(skill: string, lang: string, named: string[] = []): string[] {
  const known = curriculum.curated(skill, lang)?.requires ?? curriculum.mapped(skill, lang);
  if (known) return known;
  const out: string[] = [];
  for (const r of named) {
    const name = curriculum.canonical(r, lang);
    if (skills.key(name) && skills.key(name) !== skills.key(skill) && !out.some((o) => skills.key(o) === skills.key(name))) out.push(name);
  }
  return out.slice(0, 3);
}

/** The tree without anything taken back this session with "not yet". */
export function withoutHeld(t: skills.Tree, held: ReadonlySet<string>): skills.Tree {
  return held.size ? { skills: t.skills.filter((s) => !held.has(skills.id(s.name, s.lang))) } : t;
}

/**
 * Where a piece stands now: a "not yet" from this session counts as not held, and a skill on the
 * tree still needs its prerequisites today, so taking one back locks what builds on it.
 */
function standing(t: skills.Tree, skill: string, lang: string, need: skills.Level, requires: string[], held: ReadonlySet<string>): curriculum.Status {
  return curriculum.current(withoutHeld(t, held), skill, lang, need, requires);
}

/** The pieces a change names, spelled the tracks' way and checked against the tree. */
export function classify(t: skills.Tree, raw: PieceInput[], mode: Mode = "understand", held: ReadonlySet<string> = new Set()): Piece[] {
  const out: Piece[] = [];
  for (const p of raw) {
    // "http" asked for from python is the builder track's, which no language owns.
    const lang = curriculum.locate(p.skill, p.lang ?? "").lang;
    const skill = curriculum.canonical(p.skill, lang);
    if (!skills.key(skill) || out.some((o) => skills.id(o.skill, o.lang) === skills.id(skill, lang))) continue;
    // A curated skill is a concept, whatever the intern called it: a track is fundamentals.
    const kind: Kind = curriculum.curated(skill, lang) ? "concept" : p.kind === "tool" ? "tool" : "concept";
    const core = !!p.core && !out.some((o) => o.core);
    const need = needFor(kind, mode);
    const requires = requiresOf(skill, lang, p.requires);
    const paths = [...new Set((p.paths ?? []).map(normalPath).filter(Boolean))];
    out.push({ skill, lang, what: p.what.replace(/\s+/g, " ").trim(), requires, kind, core, paths, need, status: standing(t, skill, lang, need, requires, held) });
  }
  return out;
}

/** Whether AI may write a piece: unlocked at its level, including the core. */
export function aiWrites(p: Piece, _mode: Mode): boolean {
  return p.status.state === "unlocked";
}

/**
 * The step worth offering for a piece they can't hand over yet: the skill itself when it's open,
 * else the lowest open rung under it, including for the core algorithm.
 */
export function nextStep(t: skills.Tree, piece: { skill: string; lang?: string; path?: string; core?: boolean }): string {
  const lang = piece.lang ?? skills.langOf(piece.path ?? "");
  const st = curriculum.status(t, piece.skill, lang);
  return st.state === "locked" ? st.next : piece.skill;
}

/**
 * Why AI may not write a piece into a file today, or "" if it may. A file in another language is
 * judged in that language: knowing recursion in python doesn't write it in rust.
 */
function blocker(t: skills.Tree, mode: Mode, piece: Piece, fileLang: string, held: ReadonlySet<string>): string {
  const lang = fileLang && piece.lang && piece.lang !== fileLang ? fileLang : piece.lang || fileLang;
  const need = needFor(piece.kind, mode);
  const st = standing(t, piece.skill, lang, need, requiresOf(piece.skill, lang, piece.requires), held);
  if (st.state === "unlocked") return "";
  const what = skills.label({ name: piece.skill, lang });
  return st.state === "locked"
    ? `${what} is locked - it builds on ${st.missing.join(", ")}`
    : `${what} isn't theirs at ${need} yet - ${need === "build" ? "they implement it" : "they say what it's for first"}`;
}

/**
 * Whether AI may change `path` for the pieces named by `skillNames`, decided now against the
 * current tree. Every named skill must be a classified piece unlocked at its level today, for the
 * language of the file, and at least one must list the path. A path stays shut while any piece
 * placed there is locked, whether or not the change names it.
 */
export function mayChange(
  t: skills.Tree,
  mode: Mode,
  pieces: Piece[],
  path: string,
  skillNames: string[],
  held: ReadonlySet<string> = new Set(),
): { ok: boolean; why: string } {
  const rel = normalPath(path);
  if (!rel) return { ok: false, why: `${path} isn't a shared file - Dum changes only files you shared or follow` };
  if (!pieces.length) return { ok: false, why: "name the skills this change is for" };
  const fileLang = skills.langOf(rel);
  for (const p of pieces) {
    if (!p.paths.includes(rel)) continue;
    const why = blocker(t, mode, p, fileLang, held);
    if (why) return { ok: false, why: `${p.skill} goes in ${rel}, and ${why}` };
  }
  if (!skillNames.length) return { ok: false, why: "name the skills this change is for" };
  let listed = false;
  for (const raw of skillNames) {
    const piece = pieces.find((p) => skills.key(p.skill) === skills.key(raw) || skills.key(p.skill) === skills.key(curriculum.canonical(raw, p.lang)));
    if (!piece) return { ok: false, why: `"${raw}" isn't one of the skills this change was checked for` };
    const why = blocker(t, mode, piece, fileLang, held);
    if (why) return { ok: false, why };
    if (piece.paths.includes(rel)) listed = true;
  }
  if (!listed) return { ok: false, why: `${rel} isn't a file listed for ${skillNames.join(", ")}` };
  return { ok: true, why: `${rel}: ${skillNames.join(", ")} held` };
}

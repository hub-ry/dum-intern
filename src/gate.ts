// The learning gate, decided in code: what AI may write for them, and what stays theirs.
// Pure: reads the tree and the curated tracks, never writes a file.

import { posix } from "node:path";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";

/**
 * How dum coaches. Both modes keep the same gate: a concept needs building, a tool needs
 * recognizing, and the core of what they ask for is always theirs. Anti-vibe changes the coaching:
 * dum asks them to explain their approach before they implement it.
 */
export type Mode = "understand" | "anti-vibe";

/**
 * What a piece of a build is. A concept is something to know how to write: a language feature, a
 * data structure, an algorithm, anything on a curated track. A tool is technology breadth: one
 * library, framework, API or command. You don't have to memorize breadth before AI uses it.
 */
export type Kind = "concept" | "tool";

/** One piece of a plan, as the intern names it. */
export type PieceInput = {
  skill: string;
  lang?: string;
  what: string;
  requires?: string[];
  kind?: Kind;
  core?: boolean;
  /** Repo-relative files this piece would change. */
  paths?: string[];
};

/** One skill a plan rests on, and where it stands on their tree. */
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

/** Locked pieces one plan may carry. Working memory holds about four chunks (Cowan, 2001). */
export const MAX_LOCKED = 4;

/** The level a piece needs before AI may write it: building for a concept, recognizing for a tool. */
export function needFor(kind: Kind, _mode: Mode): skills.Level {
  return kind === "tool" ? "recognize" : "build";
}

/** A repo-relative path, or "" for anything outside the repo. */
export function normalPath(p: string): string {
  const clean = p.trim().replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.startsWith("~")) return "";
  const n = posix.normalize(clean).replace(/^\.\/+/, "");
  return n === "." || n === ".." || n.startsWith("../") ? "" : n;
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
export function withoutHeld(t: skills.Tree, held: Set<string>): skills.Tree {
  return held.size ? { skills: t.skills.filter((s) => !held.has(skills.id(s.name, s.lang))) } : t;
}

/**
 * Where a piece stands now: a "not yet" from this session counts as not held, and a skill on the
 * tree still needs its prerequisites today, so taking one back locks what builds on it.
 */
function standing(t: skills.Tree, skill: string, lang: string, need: skills.Level, requires: string[], held: Set<string>): curriculum.Status {
  return curriculum.current(withoutHeld(t, held), skill, lang, need, requires);
}

/** The pieces a plan names, spelled the tracks' way and checked against the tree. */
export function classify(t: skills.Tree, raw: PieceInput[], mode: Mode = "understand", held: Set<string> = new Set()): Piece[] {
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

/** Whether AI may write a piece: unlocked at its level, and never the core. */
export function aiWrites(p: Piece, _mode: Mode): boolean {
  return !p.core && p.status.state === "unlocked";
}

/**
 * The step worth offering for a piece they can't hand over yet: the skill itself when it's open,
 * else the lowest open rung under it. None for the core - that's this program's own logic.
 */
export function nextStep(t: skills.Tree, piece: { skill: string; lang?: string; path?: string; core?: boolean }): string {
  if (piece.core) return "";
  const lang = piece.lang ?? skills.langOf(piece.path ?? "");
  const st = curriculum.status(t, piece.skill, lang);
  return st.state === "locked" ? st.next : piece.skill;
}

/**
 * The plan, laid out by dum. The intern names the skills; whether each is unlocked is the
 * tree's call, made here in code, never the model's.
 */
export function planCard(summary: string, pieces: Piece[], mode: Mode, run = ""): string {
  const one = (t: string) => t.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  const name = (p: Piece) => skills.label({ name: p.skill, lang: p.lang });
  const where = (p: Piece) => (p.paths.length ? ` · ${p.paths.join(", ")}` : "");
  const practice = (skill: string, lang: string) => `\`:practice ${skill}${lang ? ` in ${lang}` : ""}\``;
  const may = pieces.filter((p) => aiWrites(p, mode));
  const core = pieces.filter((p) => p.core);
  const tools = pieces.filter((p) => !p.core && p.kind === "tool" && p.status.state === "open");
  const open = pieces.filter((p) => !p.core && p.kind === "concept" && p.status.state === "open");
  const deep = pieces.filter((p) => !p.core && p.status.state === "locked");
  const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines, ""] : []);
  return [
    `**${one(summary)}**`,
    "",
    ...section("dum may write", may.map((p) => `- ${name(p)}${p.kind === "tool" ? ": a tool you recognize" : ": you've built it"}${where(p)}`)),
    ...section(
      mode === "anti-vibe" ? "yours: explain your approach to dum, then implement" : "yours to implement - the core",
      core.map((p) => `- ${name(p)}: ${one(p.what)}${where(p)}`),
    ),
    ...section("what's it for?", tools.map((p) => `- ${name(p)}: ${one(p.what)} · say what it's for, in a line`)),
    ...section(
      mode === "anti-vibe" ? "yours: explain it, then implement it or practice first" : "yours to implement, or practice first",
      open.map((p) => `- ${name(p)}: ${one(p.what)} · ${practice(p.skill, p.lang)}`),
    ),
    ...section(
      "locked deeper",
      deep.map((p) => {
        const st = p.status as Extract<curriculum.Status, { state: "locked" }>;
        return `- ${name(p)}: needs ${st.missing.join(", ")}${st.next ? ` · start with ${practice(st.next, p.lang)}` : ""}`;
      }),
    ),
    ...(run ? ["## run", `- \`${one(run)}\``] : []),
  ]
    .join("\n")
    .trim();
}

/**
 * Why AI may not write a piece into a file today, or "" if it may. A file in another language is
 * judged in that language: knowing recursion in python doesn't write it in rust.
 */
function blocker(t: skills.Tree, mode: Mode, piece: Piece, fileLang: string, held: Set<string>): string {
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
 * Whether AI may change `path` for the approved pieces named by `skillNames`, decided now against
 * the current tree. Every named skill must be a non-core piece of the plan that is unlocked at its
 * level today, for the language of the file, and at least one of them must list the path. A path
 * any core piece lists is theirs, whatever else claims it, and a path any other piece lists stays
 * shut while that piece is locked, whether or not the change names it.
 */
export function mayChange(
  t: skills.Tree,
  mode: Mode,
  pieces: Piece[],
  path: string,
  skillNames: string[],
  held: Set<string> = new Set(),
): { ok: boolean; why: string } {
  const rel = normalPath(path);
  if (!rel) return { ok: false, why: `${path} is outside the project` };
  if (!pieces.length) return { ok: false, why: "there's no approved plan to change anything under" };
  const core = pieces.find((p) => p.core && p.paths.includes(rel));
  if (core) return { ok: false, why: `${rel} holds the core (${core.skill}) - it's theirs to implement` };
  const fileLang = skills.langOf(rel);
  for (const p of pieces) {
    if (!p.paths.includes(rel)) continue;
    const why = blocker(t, mode, p, fileLang, held);
    if (why) return { ok: false, why: `the plan puts ${p.skill} in ${rel}, and ${why}` };
  }
  if (!skillNames.length) return { ok: false, why: "name the plan's skills this change is for" };
  let listed = false;
  for (const raw of skillNames) {
    const piece = pieces.find((p) => skills.key(p.skill) === skills.key(raw) || skills.key(p.skill) === skills.key(curriculum.canonical(raw, p.lang)));
    if (!piece) return { ok: false, why: `"${raw}" isn't a piece of the approved plan` };
    if (piece.core) return { ok: false, why: `"${piece.skill}" is the core - it's theirs to implement` };
    const why = blocker(t, mode, piece, fileLang, held);
    if (why) return { ok: false, why };
    if (piece.paths.includes(rel)) listed = true;
  }
  if (!listed) return { ok: false, why: `${rel} isn't a file the approved plan lists for ${skillNames.join(", ")}` };
  return { ok: true, why: `${rel}: ${skillNames.join(", ")} approved and held` };
}

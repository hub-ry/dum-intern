// The other way onto the skill tree: you type it.
//
// Explaining a concept was the only way to prove it, and that makes the whole
// product a prompt-engineering problem - the tree is exactly as good as the
// intern's judgement of your sentences. Writing the code is harder to fake. So
// when a question comes up you can answer it, or say "type it": the intern
// builds everything around that piece and leaves a marked hole, and filling the
// hole is what unlocks the skill.
//
// The hole is a comment with a fixed marker so code can find it. The intern
// still judges what you wrote - a deleted marker is not an implementation - but
// "nothing changed yet" is settled here without spending a turn on it.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import type { Breadth } from "./skills.ts";

export const MARKER = "TODO(dum)";

export type Todo = {
  /** The skill it unlocks, by the tree's name. */
  concept: string;
  /** Repo-relative file the hole is in. */
  path: string;
  /** What the code has to do. Never how. */
  what: string;
  breadth: Breadth;
  requires: string[];
  /** The file as the intern left it, so an untouched hole is caught in code. */
  before: string;
  /** The request it was left under. That request isn't built until its holes are. */
  request?: string;
  /** The language the skill is scoped to, if any - carried to the tree when it passes. */
  lang?: string;
};

/**
 * A reply that hands the concept to your fingers instead of your words.
 *
 * Deliberately narrow, like `notAnAnswer`: "type it as a string" is an answer
 * to a question about types, and must not be read as opting out of it.
 */
export function wantsToType(reply: string): boolean {
  return /^(let me |i'?ll |i will |i wanna |i want to )?type (it|this|that)( myself| out)?[.!]*$|^type[.!]*$/i.test(
    reply.trim(),
  );
}

/** The 0-based line the hole for `concept` starts on, or -1. Any marker if no concept matches. */
export function hole(text: string, concept = ""): number {
  const lines = text.split("\n");
  const want = concept.trim().toLowerCase();
  if (want) {
    const i = lines.findIndex((l) => l.includes(MARKER) && l.toLowerCase().includes(want));
    if (i >= 0) return i;
  }
  return lines.findIndex((l) => l.includes(MARKER));
}

/**
 * The lines a hole spans: the marker, the comment lines under it, and the one
 * stub line after those. [from, to] inclusive, or null if `at` is not a marker.
 *
 * The comment run is found by the marker's own prefix - `//`, `#`, `--` - so
 * it works in any language without knowing any of them.
 */
export function span(lines: string[], at: number): [number, number] | null {
  const line = lines[at];
  if (line === undefined || !line.includes(MARKER)) return null;
  const prefix = line.slice(0, line.indexOf(MARKER)).trim().replace(/\s+$/, "");
  const lead = prefix.replace(/^\/\*+$/, "*") || "#";
  let to = at;
  while (to + 1 < lines.length && lines[to + 1]!.trim() && lines[to + 1]!.trimStart().startsWith(lead)) to++;
  // The stub, unless the block runs into a blank line or the end.
  if (to + 1 < lines.length && lines[to + 1]!.trim()) to++;
  return [at, to];
}

/** Every hole in a file, as spans. For the pane, which paints them. */
export function spans(text: string): [number, number][] {
  const lines = text.split("\n");
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const s = span(lines, i);
    if (s) {
      out.push(s);
      i = s[1];
    }
  }
  return out;
}

/** The file with a hole replaced by code, or null if there is no such hole. */
export function fill(text: string, concept: string, code: string): string | null {
  const lines = text.split("\n");
  const at = hole(text, concept);
  const s = at < 0 ? null : span(lines, at);
  if (!s) return null;
  const body = code.replace(/\n+$/, "").split("\n");
  return [...lines.slice(0, s[0]), ...body, ...lines.slice(s[1] + 1)].join("\n");
}

/**
 * How a language writes a line comment, by file extension. Only languages in
 * here are gated: without knowing what a comment looks like, "only holes and
 * comments" can't be checked, and `#include` would pass as one.
 */
const COMMENTS: Record<string, RegExp> = {};
for (const ext of ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "go", "rs", "swift", "kt", "cs", "php", "scala", "zig", "dart"])
  COMMENTS[ext] = /^(\/\/|\/\*|\*\/?)/;
for (const ext of ["py", "sh", "bash", "zsh", "rb", "pl", "r", "makefile", "mk", "cmake"]) COMMENTS[ext] = /^#(?!include|define|if|else|endif|pragma|import)/;
for (const ext of ["lua", "sql", "hs"]) COMMENTS[ext] = /^--/;

function lang(path: string): string {
  const base = path.split("/").pop()!.toLowerCase();
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  return base.includes(".") ? base.split(".").pop()! : "";
}

/** Whether this is a source file the hole rule applies to. */
export function gated(path: string): boolean {
  return lang(path) in COMMENTS;
}

/**
 * Lines in `text` that are code outside any hole - what "code just appearing"
 * looks like. Blank lines, comments and TODO(dum) blocks (with their one-line
 * stub) are fine; anything else is a line nobody typed or explained.
 */
export function loose(text: string, path: string): string[] {
  const comment = COMMENTS[lang(path)];
  if (!comment) return [];
  const lines = text.split("\n");
  const inHole = new Set<number>();
  for (const [a, b] of spans(text)) for (let i = a; i <= b; i++) inHole.add(i);
  return lines.filter((l, i) => l.trim() && !inHole.has(i) && !comment.test(l.trim()));
}

/** Holes whose file is exactly as the intern left it, or gone. */
export function untouched(todos: Todo[], read: (path: string) => string | null): Todo[] {
  return todos.filter((t) => read(t.path) === t.before);
}

const file = (root: string) => `${root}/.dum/todos.json`;

/** Open holes survive quitting, since typing them is usually the next session's work. */
export function load(root: string): Todo[] {
  try {
    const raw = JSON.parse(readFileSync(file(root), "utf8")) as { todos?: unknown };
    if (!Array.isArray(raw?.todos)) return [];
    return raw.todos.filter(
      (t): t is Todo =>
        !!t &&
        typeof t.concept === "string" &&
        typeof t.path === "string" &&
        typeof t.what === "string" &&
        typeof t.before === "string",
    );
  } catch {
    return [];
  }
}

export function save(root: string, todos: Todo[]) {
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    const tmp = `${file(root)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ todos }, null, 2) + "\n");
    renameSync(tmp, file(root));
  } catch {
    /* losing the list is bad, crashing over it is worse */
  }
}

/** The turn that asks the intern to look at what you typed. */
export function reviewTurn(todos: Todo[]): string {
  return [
    "They say they've typed their TODO(dum) holes. Read each file and judge the code they wrote there.",
    "",
    ...todos.map((t) => `- "${t.concept}" in ${t.path}: ${t.what}`),
    "",
    "For EACH one call check_todo. passed=true only if their code does what the hole said and would",
    "actually work - style doesn't matter, and a leftover marker comment doesn't matter.",
    "If it fails, feedback is a question that makes them run the failing case in their head, never",
    "the fix. Do NOT edit their code and do not write the answer anywhere.",
  ].join("\n");
}

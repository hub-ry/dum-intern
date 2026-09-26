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

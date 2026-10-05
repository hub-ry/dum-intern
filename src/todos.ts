// Pending user implementation from older sessions. Markers are optional, not a write gate.

import { readState, writeState } from "./workspace.ts";

export const MARKER = "TODO(dum)";

export type Todo = {
  /** The skill it unlocks, by the tree's name. */
  concept: string;
  /** Repo-relative file the hole is in. */
  path: string;
  /** What the code has to do. Never how. */
  what: string;
  requires: string[];
  /** The file as the intern left it, so an untouched hole is caught in code. */
  before: string;
  /** The request it was left under. That request isn't built until its holes are. */
  request?: string;
  /** The language the skill is scoped to, if any - carried to the tree when it passes. */
  lang?: string;
  /** A concept to write, or a tool to recognize - what it needs before AI may fill it. */
  kind?: "concept" | "tool";
  /** The heart of its build: in understand mode, always theirs. */
  core?: boolean;
};

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


/** Read old handoffs without changing their files or claiming implementation evidence. */
export function load(root: string): Todo[] {
  try {
    const raw = JSON.parse(readState(root, "todos.json", 1024 * 1024) ?? "null") as { todos?: unknown };
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
  writeState(root, "todos.json", JSON.stringify({ todos }, null, 2) + "\n");
}

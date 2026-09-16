// What you have already proven you understand.
//
// The intern starts out asking about everything with a hole in it. Once you
// have explained visibility timeouts to it properly, asking you again next
// week is not rigour, it is amnesia - and a tool that re-interrogates you over
// ground you have already covered is one you stop running.
//
// So demonstrated topics are written down, per repo, and the intern is told
// what is on the list. That buys it autonomy: fewer questions, and more scope
// inside one spec.
//
// What it explicitly does NOT buy is skipping the spec. The gate is the whole
// product. An intern that earns its way out of showing you what it is about to
// build has earned its way out of being useful.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export type Topic = {
  /** The industry name, so it matches what the wizard and `teach` would say. */
  topic: string;
  /** True once they explained it. False when the intern had to teach it. */
  solid: boolean;
  why: string;
  at: string;
};

export type Knowledge = { topics: Topic[] };

export type Level = "new" | "trusted" | "senior";

const EMPTY: Knowledge = { topics: [] };

function file(root: string) {
  return `${root}/.dum/knowledge.json`;
}

export function read(root: string): Knowledge {
  try {
    const raw = JSON.parse(readFileSync(file(root), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as Knowledge).topics)) {
      return EMPTY;
    }
    const topics = (raw as Knowledge).topics.filter(
      (t): t is Topic => !!t && typeof t.topic === "string" && typeof t.solid === "boolean",
    );
    return { topics };
  } catch {
    // No file, or someone edited it into nonsense. Starting from nothing is
    // correct here: it means more questions, which is the safe direction.
    return EMPTY;
  }
}

export function write(root: string, k: Knowledge) {
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    writeFileSync(file(root), JSON.stringify(k, null, 2) + "\n");
  } catch {
    /* losing the record is bad, crashing over it is worse */
  }
}

/**
 * Record what a topic looks like now.
 *
 * Last write wins, deliberately. A topic the intern had to teach and that you
 * later explained back should end up solid, and one you fumbled after claiming
 * to know should stop being solid. Keeping the best-ever answer would let the
 * record drift permanently upward.
 */
export function note(k: Knowledge, entry: Omit<Topic, "at">): Knowledge {
  const key = entry.topic.trim().toLowerCase();
  if (!key) return k;
  const topics = k.topics.filter((t) => t.topic.trim().toLowerCase() !== key);
  return { topics: [...topics, { ...entry, topic: entry.topic.trim(), at: new Date().toISOString() }] };
}

export function proven(k: Knowledge): Topic[] {
  return k.topics.filter((t) => t.solid);
}

export function taught(k: Knowledge): Topic[] {
  return k.topics.filter((t) => !t.solid);
}

/**
 * How much rope the intern gets.
 *
 * Deliberately coarse. Three steps you can feel are worth more than a score
 * that moves invisibly, and the whole point is that you can tell when you have
 * earned something.
 */
export function level(k: Knowledge): Level {
  const n = proven(k).length;
  if (n >= 6) return "senior";
  if (n >= 2) return "trusted";
  return "new";
}

/** What the next level needs, for showing a person. */
export function toNext(k: Knowledge): { level: Level; have: number; need: number } {
  const have = proven(k).length;
  const lvl = level(k);
  return { level: lvl, have, need: lvl === "new" ? 2 : lvl === "trusted" ? 6 : have };
}

/** The record as the intern sees it. Empty string when there is nothing to say. */
export function describe(k: Knowledge): string {
  const solid = proven(k);
  const weak = taught(k);
  if (!solid.length && !weak.length) return "";
  const out: string[] = ["WHAT THEY HAVE ALREADY SHOWN YOU"];
  if (solid.length) {
    out.push(
      "",
      "They explained these themselves. Do NOT re-teach them and do NOT ask",
      "basic questions about them. Treat them as known:",
      ...solid.map((t) => `  - ${t.topic}${t.why ? ` (${t.why})` : ""}`),
    );
  }
  if (weak.length) {
    out.push(
      "",
      "You had to teach these. They may still be shaky, so it is fair to check,",
      "but do not teach them from scratch again:",
      ...weak.map((t) => `  - ${t.topic}`),
    );
  }
  return out.join("\n");
}

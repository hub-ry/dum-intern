// One skill, as a markdown note you can open, edit, or write yourself.
//
// The tree used to be one JSON file. It worked for the program and was closed
// to the person it is about: fixing a wrong entry meant hand-editing JSON, and
// adding one meant knowing the schema. As a folder of notes it is something
// you can read in any editor, and Obsidian opens it as a vault - "builds on"
// is a [[link]], so its graph view draws the tree, and a prerequisite nobody
// has recorded yet is an unresolved link, which Obsidian draws as a grey node.
// That is the frontier, for free, again.
//
// Anything you write by hand counts as claimed: you say you hold it, and the
// first build that leans on it gets one short check. A note with no
// frontmatter at all is fine - the file name is the skill.

import YAML from "yaml";
import type { Breadth, Skill } from "./skills.ts";

export type State = "solid" | "shaky" | "claimed";

export function stateOf(s: Skill): State {
  return s.claimed ? "claimed" : s.solid ? "solid" : "shaky";
}

/**
 * The file a skill lives in. Its name, minus what a file system or Obsidian
 * will not take in a file name. The real name is kept in the frontmatter, so
 * nothing is lost to this.
 */
export function fileName(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return (safe || "skill") + ".md";
}

/** `[[target]]`, or `[[target|name]]` when the file name had to change. */
function link(name: string): string {
  const target = fileName(name).slice(0, -3);
  return target === name ? `[[${name}]]` : `[[${target}|${name}]]`;
}

const LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const BUILDS_ON = /^builds on:.*$/im;

export function toNote(s: Skill): string {
  const state = stateOf(s);
  const front: Record<string, unknown> = {
    name: s.name,
    state,
    breadth: s.breadth,
  };
  if (s.repos.length) front.repos = s.repos;
  if (s.at) front.at = s.at;
  // Tags, so Obsidian's graph can colour by state. Written, never read back:
  // `state` is the source of truth and a stale tag must not override it.
  front.tags = [`dum/${state}`, ...(s.breadth === "niche" ? ["dum/niche"] : [])];
  const body = [s.why.trim(), s.requires.length ? `builds on: ${s.requires.map(link).join(", ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n${body ? "\n" + body + "\n" : ""}`;
}

const str = (v: unknown): v is string => typeof v === "string";

/**
 * A note back into a skill, or null if it is not one.
 *
 * Forgiving on purpose, because people write these by hand: no frontmatter
 * means the file name is the skill and it is claimed, an unknown state is
 * claimed, and every [[link]] in the body is something it builds on - not
 * only the ones on the `builds on:` line dum writes.
 */
export function fromNote(text: string, file: string): Skill | null {
  let front: Record<string, unknown> = {};
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    try {
      const parsed = YAML.parse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
    } catch {
      return null; // broken YAML is not a claim about anything
    }
    body = text.slice(m[0].length);
  }
  const name = (str(front.name) && front.name.trim()) || file.replace(/\.md$/i, "").trim();
  if (!name) return null;
  const state: State = front.state === "solid" || front.state === "shaky" ? front.state : "claimed";
  const requires: string[] = [];
  for (const [, target, alias] of body.matchAll(LINK)) {
    const r = (alias ?? target!).trim();
    if (r && !requires.includes(r)) requires.push(r);
  }
  return {
    name,
    solid: state !== "shaky",
    claimed: state === "claimed",
    breadth: (front.breadth === "niche" ? "niche" : "general") as Breadth,
    requires,
    why: body.replace(BUILDS_ON, "").trim(),
    repos: Array.isArray(front.repos) ? front.repos.filter(str) : [],
    at: str(front.at) ? front.at : front.at instanceof Date ? front.at.toISOString() : "",
  };
}

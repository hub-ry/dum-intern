// One skill, as a markdown note you can open, edit, or write yourself.

import YAML from "yaml";
import { langName, type Breadth, type Skill } from "./skills.ts";

export type State = "solid" | "shaky" | "claimed";

export function stateOf(s: Skill): State {
  return s.claimed ? "claimed" : s.solid ? "solid" : "shaky";
}

/** The file a skill lives in. */
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
  if (s.lang) front.lang = s.lang;
  if (s.repos.length) front.repos = s.repos;
  if (s.at) front.at = s.at;
  // Tags, so Obsidian's graph can colour by state.
  front.tags = [`dum/${state}`, ...(s.breadth === "niche" ? ["dum/niche"] : [])];
  const body = [s.why.trim(), s.requires.length ? `builds on: ${s.requires.map(link).join(", ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n${body ? "\n" + body + "\n" : ""}`;
}

const str = (v: unknown): v is string => typeof v === "string";

/** A note back into a skill, or null if it is not one. */
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
    lang: str(front.lang) ? langName(front.lang) : "",
    requires,
    why: body.replace(BUILDS_ON, "").trim(),
    repos: Array.isArray(front.repos) ? front.repos.filter(str) : [],
    at: str(front.at) ? front.at : front.at instanceof Date ? front.at.toISOString() : "",
  };
}

// One skill, as a markdown note you can open, edit, or write yourself.

import YAML from "yaml";
import { langName, levelOf, LEVELS, type How, type Level, type Skill } from "./skills.ts";

const HOWS: How[] = ["typed", "explained", "course", "added", "reasoned"];

/** The file a skill lives in. */
export function fileName(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return (safe || "skill") + ".md";
}

/** `[[target|name]]` pointing at the prerequisite's note in the same language. */
function link(name: string, lang: string): string {
  const target = fileName(lang ? `${name} (${lang})` : name).slice(0, -3);
  return target === name ? `[[${name}]]` : `[[${target}|${name}]]`;
}

const LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const BUILDS_ON = /^builds on:.*$/im;

export function toNote(s: Skill): string {
  const front: Record<string, unknown> = { name: s.name };
  if (s.lang) front.lang = s.lang;
  front.how = s.how;
  front.level = s.level;
  if (s.at) front.at = s.at;
  // Tags, so Obsidian's graph can colour by level.
  front.tags = [`dum/${s.level}`];
  const body = [s.why.trim(), s.requires.length ? `builds on: ${s.requires.map((r) => link(r, s.lang)).join(", ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n${body ? "\n" + body + "\n" : ""}`;
}

const str = (v: unknown): v is string => typeof v === "string";

/**
 * How an older note was unlocked. Shaky ones were taught, never shown, so they read as locked;
 * a note with nothing to say is one somebody wrote by hand, which is adding it.
 */
function howOf(front: Record<string, unknown>): How | null {
  if (str(front.how) && (HOWS as string[]).includes(front.how)) return front.how as How;
  if (front.state === "shaky") return null;
  if (front.state === "solid") return Array.isArray(front["shown-in"]) && front["shown-in"].length ? "typed" : "explained";
  return "added";
}

/** A note back into a skill, or null if it isn't an unlocked one. */
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
  const how = howOf(front);
  if (!name || !how) return null;
  const requires: string[] = [];
  for (const [, target, alias] of body.matchAll(LINK)) {
    const r = (alias ?? target!).trim();
    if (r && !requires.includes(r)) requires.push(r);
  }
  const level: Level = str(front.level) && (LEVELS as string[]).includes(front.level) ? (front.level as Level) : levelOf(how);
  return {
    name,
    lang: str(front.lang) ? langName(front.lang) : "",
    how,
    level,
    requires,
    why: body.replace(BUILDS_ON, "").trim(),
    at: str(front.at) ? front.at : front.at instanceof Date ? front.at.toISOString() : "",
  };
}

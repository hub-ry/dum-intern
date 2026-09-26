// Their taste: rules in their own words, kept in ~/.dum/taste.md.
// The intern reads it every session and the scenario judge scores against it.

import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { home } from "./skills.ts";

export function file(dir = home()) {
  return `${dir}/taste.md`;
}

const HEADER = "# taste\n\nHow I want dum to behave, in my words. dum reads this every session.\n\n";

/** The rules, one per bullet. Empty when there's no file. */
export function read(dir = home()): string[] {
  let text: string;
  try {
    text = readFileSync(file(dir), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

/** Add one rule. */
export function add(rule: string, dir = home()) {
  const r = rule.trim().replace(/\s+/g, " ");
  if (!r) return;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file(dir))) writeFileSync(file(dir), HEADER);
  appendFileSync(file(dir), `- ${r}\n`);
}

/** The taste as the intern sees it. "" when there is none. */
export function describe(rules: string[]): string {
  if (!rules.length) return "";
  return ["THEIR TASTE - their own rules for how you work. Follow them.", ...rules.map((r) => `- ${r}`)].join("\n");
}

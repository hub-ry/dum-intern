// Projects you want to build, and the ones you have to build first.
//
// The tree says what you hold. A project needs more than that, sometimes far
// more: a multiplayer game server rests on sockets, which rest on processes
// and byte streams, which rest on things you may never have touched. dum won't
// build what you can't explain, so a goal eight tiers above your tree is a
// goal you can't start - unless something walks you up to it.
//
// So each queued project gets a plan. The skills it rests on are mapped (a
// model's job), then tiered against your tree (this file's job, in code):
// what you know is tier 0, and anything else sits one above the highest thing
// it builds on. Every tier below the goal becomes stepping-stone projects, each
// small enough to unlock a few skills in an evening.
//
// Nothing here is ticked off by hand. A project is done when the skills it
// unlocks are known on the tree, and ready when what it comes after is done -
// so explaining something, or typing it into a hole, is what moves the queue.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import YAML from "yaml";
import * as skills from "./skills.ts";
import { fileName } from "./notes.ts";

export type Kind = "goal" | "step" | "idea";

export type Project = {
  title: string;
  kind: Kind;
  /** What building it should put on the tree. */
  unlocks: string[];
  /** Projects that come first, by title. */
  after: string[];
  /** The goal a step leads to, if it's a step. */
  leadsTo: string;
  /** The first thing to say to dum, in the project's folder. */
  start: string;
  /** When it was planned. "" for an idea someone dropped in by hand. */
  planned: string;
  /** The brief, as markdown. For a hand-written note, the idea itself. */
  body: string;
  /** An honest estimate, so "an evening" is a number. */
  minutes?: number;
};

/** Beside the skills, so one Obsidian vault on ~/.dum links the two. */
export function folder(dir = skills.home()) {
  return `${dir}/projects`;
}

const str = (v: unknown): v is string => typeof v === "string";
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str).map((s) => s.trim()).filter(Boolean) : []);

const link = (name: string) => {
  const target = fileName(name).slice(0, -3);
  return target === name ? `[[${name}]]` : `[[${target}|${name}]]`;
};

export function toNote(p: Project): string {
  const front: Record<string, unknown> = { title: p.title, kind: p.kind };
  if (p.unlocks.length) front.unlocks = p.unlocks;
  if (p.after.length) front.after = p.after;
  if (p.leadsTo) front["leads-to"] = p.leadsTo;
  if (p.start) front.start = p.start;
  if (p.planned) front.planned = p.planned;
  if (p.minutes) front.minutes = p.minutes;
  front.tags = [`dum/project/${p.kind}`];
  // The same edges again as links, for the graph view. Frontmatter is what
  // gets read back; these are regenerated on every write.
  const links = [
    p.unlocks.length ? `unlocks: ${p.unlocks.map(link).join(", ")}` : "",
    p.after.length ? `after: ${p.after.map(link).join(", ")}` : "",
    p.leadsTo ? `leads to: ${link(p.leadsTo)}` : "",
  ].filter(Boolean);
  const body = [p.body.trim(), links.join("\n")].filter(Boolean).join("\n\n");
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n${body ? "\n" + body + "\n" : ""}`;
}

const LINKS_LINE = /^(unlocks|after|leads to):.*$/gim;

/** A note back into a project. No frontmatter means an unplanned idea, titled by its file. */
export function fromNote(text: string, file: string): Project | null {
  let front: Record<string, unknown> = {};
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    try {
      const parsed = YAML.parse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    body = text.slice(m[0].length);
  }
  const title = (str(front.title) && front.title.trim()) || file.replace(/\.md$/i, "").trim();
  if (!title) return null;
  const kind: Kind = front.kind === "goal" || front.kind === "step" ? front.kind : "idea";
  return {
    title,
    kind,
    unlocks: strs(front.unlocks),
    after: strs(front.after),
    leadsTo: str(front["leads-to"]) ? front["leads-to"].trim() : "",
    start: str(front.start) ? front.start.trim() : "",
    planned: str(front.planned) ? front.planned : front.planned instanceof Date ? front.planned.toISOString().slice(0, 10) : "",
    body: body.replace(LINKS_LINE, "").trim(),
    ...(typeof front.minutes === "number" && front.minutes > 0 ? { minutes: front.minutes } : {}),
  };
}

export function read(dir = skills.home()): Project[] {
  let names: string[];
  try {
    names = readdirSync(folder(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return [];
  }
  const out: Project[] = [];
  for (const n of names.sort()) {
    try {
      const p = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
      if (p) out.push(p);
    } catch {
      /* one bad note is not worth the whole queue */
    }
  }
  return out;
}

/** Write projects, each to the note named for its title, replacing any note with that title. */
export function write(ps: Project[], dir = skills.home()) {
  mkdirSync(folder(dir), { recursive: true });
  const existing = new Map<string, string>();
  try {
    for (const n of readdirSync(folder(dir)).filter((n) => n.endsWith(".md"))) {
      try {
        const p = fromNote(readFileSync(`${folder(dir)}/${n}`, "utf8"), n);
        if (p) existing.set(skills.key(p.title), n);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* empty folder */
  }
  for (const p of ps) {
    const path = `${folder(dir)}/${existing.get(skills.key(p.title)) ?? fileName(p.title)}`;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, toNote(p));
    renameSync(tmp, path);
  }
}

// -- planning, in code ----------------------------------------------------

export type Need = { name: string; requires: string[] };

/**
 * How far above the tree each needed skill sits.
 *
 * Known (or claimed - they said so, and planning is not an exam) is 0.
 * Anything else is one more than the highest thing it builds on. A
 * prerequisite the map named but did not describe counts as a leaf: one above
 * what they know. A cycle is cut where it closes rather than recursing
 * forever - the map is a model's output, and models draw cycles.
 */
export function tiers(needs: Need[], holds: (name: string) => boolean): Map<string, number> {
  const byKey = new Map(needs.map((n) => [skills.key(n.name), n]));
  const tier = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (name: string): number => {
    const k = skills.key(name);
    if (holds(name)) return 0;
    const done = tier.get(k);
    if (done !== undefined) return done;
    if (visiting.has(k)) return 0;
    visiting.add(k);
    const n = byKey.get(k);
    const below = n ? Math.max(0, ...n.requires.map(walk)) : 0;
    visiting.delete(k);
    tier.set(k, below + 1);
    return below + 1;
  };
  const out = new Map<string, number>();
  for (const n of needs) out.set(n.name, walk(n.name));
  return out;
}

/** Skills one step project should unlock, at most. An evening, not a semester. */
export const PER_STEP = 3;

export type Step = { tier: number; unlocks: string[]; after: number[] };

/**
 * The stepping stones under a goal: every missing tier below the top, cut
 * into groups of at most PER_STEP skills. The goal itself takes the top tier.
 *
 * A step comes after another only when one of its skills builds on one of the
 * other's - so two independent branches can be climbed in either order,
 * instead of a single line that makes you learn SQL before you're allowed to
 * touch sockets.
 */
export function ladder(
  needs: Need[],
  holds: (name: string) => boolean,
): { steps: Step[]; top: string[]; topAfter: number[]; height: number } {
  const t = tiers(needs, holds);
  const missing = needs.filter((n) => (t.get(n.name) ?? 0) > 0);
  const height = Math.max(0, ...missing.map((n) => t.get(n.name)!));
  const top = missing.filter((n) => t.get(n.name) === height).map((n) => n.name);
  // Everything tier 1 can be learned inside the goal itself when that's all
  // there is: dum asks about it, or leaves it as a hole.
  if (height <= 1) return { steps: [], top: missing.map((n) => n.name), topAfter: [], height };
  const steps: Step[] = [];
  const stepOf = new Map<string, number>();
  for (let tier = 1; tier < height; tier++) {
    const here = missing.filter((n) => t.get(n.name) === tier).map((n) => n.name);
    for (let i = 0; i < here.length; i += PER_STEP) {
      const unlocks = here.slice(i, i + PER_STEP);
      for (const u of unlocks) stepOf.set(skills.key(u), steps.length);
      steps.push({ tier, unlocks, after: [] });
    }
  }
  const byKey = new Map(needs.map((n) => [skills.key(n.name), n]));
  const deps = (names: string[]) => {
    const out = new Set<number>();
    for (const u of names) for (const r of byKey.get(skills.key(u))?.requires ?? []) {
      const s = stepOf.get(skills.key(r));
      if (s !== undefined) out.add(s);
    }
    return [...out].sort((a, b) => a - b);
  };
  for (const s of steps) s.after = deps(s.unlocks).filter((i) => steps[i] !== s);
  return { steps, top, topAfter: deps(top), height };
}

// -- where the queue stands, off the tree -----------------------------------

export type Status = "done" | "ready" | "waiting" | "unplanned";

/** Known or claimed on the tree right now. */
export function holder(t: skills.Tree): (name: string) => boolean {
  return (name) => {
    const s = skills.find(t, name);
    return !!s && s.solid;
  };
}

export function status(
  p: Project,
  all: Project[],
  holds: (name: string) => boolean,
  seen = new Set<string>(),
): Status {
  if (!p.planned && p.kind === "idea" && !p.unlocks.length) return "unplanned";
  if (p.unlocks.length && p.unlocks.every(holds)) return "done";
  // Notes are hand-editable, so `after` can loop. A loop blocks nothing.
  const k = skills.key(p.title);
  if (seen.has(k)) return "ready";
  const next = new Set([...seen, k]);
  const before = p.after.map((a) => all.find((q) => skills.key(q.title) === skills.key(a)));
  const blocked = before.some((q) => q && status(q, all, holds, next) !== "done");
  return blocked ? "waiting" : "ready";
}

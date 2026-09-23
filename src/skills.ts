// What you have already shown you understand, as a tree that follows you.
//
// This used to be a flat list per repo with a three-step ladder on top: prove
// two topics and you were "trusted", six and you were "senior". Both halves
// were wrong. A skill is something you have, not something a repo has, so
// explaining leases in one project and being asked about them again in the
// next is amnesia, not rigour. And a single level is gameable - six trivial
// topics bought the same rope as six hard ones - and it is the opposite of
// what a tree is for. Autonomy is local now: the intern stops asking about the
// parts of a request that sit on skills you hold, and asks about the rest.
//
// The edges are grown, not curated. When a skill is recorded the intern names
// what it builds on, so the tree takes the shape of what you actually build.
// A prerequisite nobody has recorded yet still shows up, as a node you have
// not shown - which is the frontier, for free.
//
// Breadth matters as much as the edges. General concepts (idempotency, Rust
// ownership, SQL joins) transfer, so once shown they count everywhere. Niche
// ones (one library's pagination quirks, a file format you touched once) fade,
// so they only count in the repo where you showed them and get one quick
// re-check anywhere else.
//
// What none of this buys is skipping the spec. The gate is absolute no matter
// how big the tree gets.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

export type Breadth = "general" | "niche";

export type Skill = {
  /** The industry name, so it matches what the wizard and `teach` would say. */
  name: string;
  /** True once they explained it. False when the intern had to teach it. */
  solid: boolean;
  breadth: Breadth;
  /** Skills this one builds on directly, by name. May name skills not yet on the tree. */
  requires: string[];
  why: string;
  /** Repo roots where it was shown. Only meaningful while solid. */
  repos: string[];
  at: string;
};

export type Tree = { skills: Skill[] };

const EMPTY: Tree = { skills: [] };

/** `DUM_HOME` exists for tests, and for anyone who wants their tree somewhere else. */
export function home(): string {
  return process.env.DUM_HOME || `${homedir()}/.dum`;
}

function file(dir: string) {
  return `${dir}/skills.json`;
}

const key = (name: string) => name.trim().toLowerCase();

const str = (v: unknown): v is string => typeof v === "string";

function clean(raw: unknown): Skill | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (!str(s.name) || !s.name.trim() || typeof s.solid !== "boolean") return null;
  return {
    name: s.name.trim(),
    solid: s.solid,
    breadth: s.breadth === "niche" ? "niche" : "general",
    requires: Array.isArray(s.requires) ? s.requires.filter(str) : [],
    why: str(s.why) ? s.why : "",
    repos: Array.isArray(s.repos) ? s.repos.filter(str) : [],
    at: str(s.at) ? s.at : "",
  };
}

export function read(dir = home()): Tree {
  try {
    const raw = JSON.parse(readFileSync(file(dir), "utf8")) as { skills?: unknown };
    if (!Array.isArray(raw?.skills)) return EMPTY;
    return { skills: raw.skills.map(clean).filter((s): s is Skill => !!s) };
  } catch {
    // No file, or someone edited it into nonsense. Starting from nothing is
    // correct here: it means more questions, which is the safe direction.
    return EMPTY;
  }
}

/**
 * Written through a temp file and a rename.
 *
 * The tree is shared by every dum session on the machine now, so a torn write
 * no longer costs one repo's record, it costs all of them.
 */
export function write(t: Tree, dir = home()) {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n");
    renameSync(tmp, file(dir));
  } catch {
    /* losing the record is bad, crashing over it is worse */
  }
}

export type Entry = {
  name: string;
  solid: boolean;
  breadth: Breadth;
  requires: string[];
  why: string;
};

/**
 * Record what a skill looks like now, as shown in `root`.
 *
 * Last write wins on whether it is solid, deliberately. A skill the intern had
 * to teach and that you later explained back should end up solid, and one you
 * fumbled after claiming to know should stop being solid. Keeping the
 * best-ever answer would let the tree drift permanently upward.
 *
 * Edges only accumulate. A prerequisite named once is still a prerequisite the
 * next time the skill comes up in a context that did not happen to mention it.
 */
export function note(t: Tree, e: Entry, root: string): Tree {
  const k = key(e.name);
  if (!k) return t;
  const prev = t.skills.find((s) => key(s.name) === k);

  // Prerequisites are spelled the way the tree already spells them, so a
  // casing difference does not grow a second node.
  const canon = (n: string) => t.skills.find((s) => key(s.name) === key(n))?.name ?? n.trim();
  const requires: string[] = [];
  for (const r of [...(prev?.requires ?? []), ...e.requires]) {
    const name = canon(r);
    if (name && key(name) !== k && !requires.some((x) => key(x) === key(name))) requires.push(name);
  }

  // Where it was shown only means something while it is solid. A downgrade
  // wipes it, so re-proving it later starts that list over from here.
  const repos = e.solid
    ? [...new Set([...(prev?.solid ? prev.repos : []), root])]
    : [];

  const next: Skill = {
    name: prev?.name ?? e.name.trim(),
    solid: e.solid,
    breadth: e.breadth,
    requires,
    why: e.why,
    repos,
    at: new Date().toISOString(),
  };
  return { skills: [...t.skills.filter((s) => key(s.name) !== k), next] };
}

export function find(t: Tree, name: string): Skill | undefined {
  return t.skills.find((s) => key(s.name) === key(name));
}

/** Take a skill off the tree. How you dispute something the intern got wrong. */
export function forget(t: Tree, name: string): Tree {
  return { skills: t.skills.filter((s) => key(s.name) !== key(name)) };
}

/** Solid and trusted in this repo: general anywhere, niche only where shown. */
export function known(t: Tree, root: string): Skill[] {
  return t.skills.filter((s) => s.solid && (s.breadth === "general" || s.repos.includes(root)));
}

/** Solid, but niche and shown somewhere else. Worth one quick check here. */
export function elsewhere(t: Tree, root: string): Skill[] {
  return t.skills.filter((s) => s.solid && s.breadth === "niche" && !s.repos.includes(root));
}

/** Taught, or claimed and then fumbled. */
export function shaky(t: Tree): Skill[] {
  return t.skills.filter((s) => !s.solid);
}

/**
 * Fold a repo's old `.dum/knowledge.json` into the tree.
 *
 * Only adds skills the tree does not have yet, so running it every session is
 * harmless and a newer judgement on the tree is never overwritten by an older
 * one from a file. Old entries had no breadth; they come in as general, which
 * matches how they were treated before, and the intern re-records the breadth
 * the next time the skill comes up.
 */
export function migrate(t: Tree, root: string): Tree {
  let old: unknown;
  try {
    old = JSON.parse(readFileSync(`${root}/.dum/knowledge.json`, "utf8"));
  } catch {
    return t;
  }
  const topics = (old as { topics?: unknown })?.topics;
  if (!Array.isArray(topics)) return t;
  const added: Skill[] = [];
  for (const raw of topics) {
    const o = raw as Record<string, unknown>;
    if (!o || !str(o.topic) || !o.topic.trim() || typeof o.solid !== "boolean") continue;
    if (find(t, o.topic) || added.some((s) => key(s.name) === key(o.topic as string))) continue;
    added.push({
      name: o.topic.trim(),
      solid: o.solid,
      breadth: "general",
      requires: [],
      why: str(o.why) ? o.why : "",
      repos: o.solid ? [root] : [],
      at: str(o.at) ? o.at : "",
    });
  }
  return added.length ? { skills: [...t.skills, ...added] } : t;
}

/** The tree as the intern sees it. Empty string when there is nothing to say. */
export function describe(t: Tree, root: string): string {
  if (!t.skills.length) return "";
  const line = (s: Skill) => {
    const on = s.requires.length ? `  [builds on: ${s.requires.join(", ")}]` : "";
    return `  - ${s.name}${on}`;
  };
  const out: string[] = [
    "THEIR SKILL TREE",
    "",
    "Everything they have shown you or been taught, across every project. Use",
    "these exact names when you record something that is the same idea.",
  ];
  const k = known(t, root);
  if (k.length) {
    out.push(
      "",
      "KNOWN. They explained these. Build on them without asking, and never",
      "re-teach them:",
      ...k.map(line),
    );
  }
  const e = elsewhere(t, root);
  if (e.length) {
    out.push(
      "",
      "SHOWN IN ANOTHER PROJECT, AND NICHE. One-off knowledge fades. If this build",
      "actually leans on one of these, ONE short check is fair - never a re-teach:",
      ...e.map((s) => `${line(s)}  (in ${s.repos.map((r) => basename(r)).join(", ")})`),
    );
  }
  const w = shaky(t);
  if (w.length) {
    out.push(
      "",
      "SHAKY. You had to teach these, or they fumbled them. A quick check is fair",
      "when this build leans on one, but do not teach it from scratch again:",
      ...w.map(line),
    );
  }
  return out.join("\n");
}

/** Counts for a header. */
export function summary(t: Tree, root: string): { known: number; shaky: number } {
  return { known: known(t, root).length, shaky: shaky(t).length };
}

export type Row = {
  depth: number;
  name: string;
  /** `ghost` is a prerequisite something builds on that they have not shown yet. */
  state: "solid" | "shaky" | "ghost";
  niche: boolean;
  /** Already drawn further up under another parent, so its children are not repeated. */
  repeat: boolean;
};

/**
 * The tree as rows to draw, roots first.
 *
 * It is really a graph: a skill can build on two others, so it appears under
 * both, fully the first time and as a back-reference after that. A skill that
 * is only reachable through a cycle is drawn as a root at the end rather than
 * silently disappearing.
 */
export function rows(t: Tree): Row[] {
  const byKey = new Map(t.skills.map((s) => [key(s.name), s]));
  const ghosts = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const s of t.skills) {
    for (const r of s.requires) {
      const rk = key(r);
      if (!byKey.has(rk) && !ghosts.has(rk)) ghosts.set(rk, r);
      children.set(rk, [...(children.get(rk) ?? []), key(s.name)]);
    }
  }
  const nameOf = (k: string) => byKey.get(k)?.name ?? ghosts.get(k) ?? k;
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b));

  // Real roots before ghosts, so a skill is drawn in full under the branch
  // you actually built and only back-referenced under a prerequisite you
  // have not shown yet.
  const all = [...byKey.keys(), ...ghosts.keys()];
  const roots = [
    ...[...byKey.keys()].filter((k) => !byKey.get(k)!.requires.length).sort(byName),
    ...[...ghosts.keys()].sort(byName),
  ];

  const out: Row[] = [];
  const drawn = new Set<string>();
  const walk = (k: string, depth: number) => {
    const s = byKey.get(k);
    const repeat = drawn.has(k);
    out.push({
      depth,
      name: nameOf(k),
      state: s ? (s.solid ? "solid" : "shaky") : "ghost",
      niche: s?.breadth === "niche",
      repeat,
    });
    if (repeat) return;
    drawn.add(k);
    for (const c of [...(children.get(k) ?? [])].sort(byName)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const k of all.sort(byName)) if (!drawn.has(k)) walk(k, 0);
  return out;
}

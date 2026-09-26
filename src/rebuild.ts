// Rebuild a project you already have, from nothing, without vibecoding it.
//
// Having a project is not the same as being able to explain it - especially
// one that got written quickly, or with a model's help. So you point dum at it,
// and it becomes a goal like any other: mapped for what it rests on, laddered
// against your tree, and cut into milestones you build one by one in a fresh
// folder.
//
// The original stays out of reach. The rebuild folder is its own repo and the
// intern's path gate refuses anything outside it, so the one way the code gets
// there is the usual way: explained, typed into a hole, or - for skills you
// already hold - filled in front of you. Skipping the parts you know is fine.
// Code turning up without you seeing it isn't.

import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as skills from "./skills.ts";
import type { Mapped } from "./planner.ts";
import { oneShot, json } from "./oneshot.ts";

const MODEL = "claude-opus-5-5";
const TOOLS = ["Read", "Glob", "Grep"];

export type Milestone = { request: string; done: boolean };
export type Rebuild = { source: string; goal: string; milestones: Milestone[] };

const file = (root: string) => `${root}/.dum/rebuild.json`;

export function load(root: string): Rebuild | null {
  try {
    const raw = JSON.parse(readFileSync(file(root), "utf8"));
    if (!raw || typeof raw.goal !== "string" || !Array.isArray(raw.milestones)) return null;
    return {
      source: typeof raw.source === "string" ? raw.source : "",
      goal: raw.goal,
      milestones: raw.milestones
        .filter((m: any) => m && typeof m.request === "string")
        .map((m: any) => ({ request: m.request, done: m.done === true })),
    };
  } catch {
    return null;
  }
}

export function save(root: string, r: Rebuild) {
  mkdirSync(`${root}/.dum`, { recursive: true });
  const tmp = `${file(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  renameSync(tmp, file(root));
}

/** The first milestone not built yet, with its number, or null when it's all built. */
export function nextUp(r: Rebuild): { index: number; request: string } | null {
  const i = r.milestones.findIndex((m) => !m.done);
  return i < 0 ? null : { index: i, request: r.milestones[i]!.request };
}

/** Mark the milestone built, if that's what this request was. */
export function built(r: Rebuild, request: string): Rebuild {
  const i = r.milestones.findIndex((m) => !m.done && m.request === request);
  if (i < 0) return r;
  return { ...r, milestones: r.milestones.map((m, j) => (j === i ? { ...m, done: true } : m)) };
}

/** What the intern hears about a rebuild at the start of a session. "" outside one. */
export function context(r: Rebuild | null): string {
  if (!r) return "";
  const n = nextUp(r);
  return `THIS IS A REBUILD
They're rebuilding ${basename(r.source)} from scratch in this folder, to be able
to explain every part of it. The original is not here and you can't read it -
don't go looking. Build what each request asks, in this repo, the usual way:
the gate, the questions, the holes. Pieces on skills they hold get filled in
front of them; the rest are theirs to type.
Milestones: ${r.milestones.map((m, i) => `${i + 1}. ${m.request}${m.done ? " (built)" : ""}`).join("  ")}
${n ? `Next up: ${n.index + 1}.` : "All milestones are built."}`;
}

/** Where a rebuild goes when no target is named: beside the original. */
export function defaultTarget(source: string): string {
  const base = resolve(source);
  return `${dirname(base)}/${basename(base)}-rebuild`;
}

/** A folder that's missing or empty, made into a git repo. Null, or why not. */
export function prepare(target: string): string | null {
  if (existsSync(target) && readdirSync(target).filter((n) => !n.startsWith(".")).length) {
    return `${target} already has files in it. name an empty folder, or a new one.`;
  }
  try {
    mkdirSync(target, { recursive: true });
    if (!existsSync(`${target}/.git`)) execFileSync("git", ["init", "-q"], { cwd: target });
  } catch (err) {
    return `couldn't set up ${target}: ${(err as Error).message}`;
  }
  return null;
}

const Read = z.object({
  title: z.string().min(1),
  summary: z.string().catch(""),
  milestones: z.array(z.string().min(1)).min(1),
  skills: z.array(z.object({ name: z.string().min(1), requires: z.array(z.string()).catch([]) })).catch([]),
});

/** Read the original: what it rests on, and the order to rebuild it in. */
export async function read(
  source: string,
  t: skills.Tree,
  onStatus?: (s: string) => void,
): Promise<(Mapped & { milestones: string[] }) | null> {
  const names = t.skills.filter((s) => s.solid).map((s) => s.name);
  const reply = await oneShot(
    `The project in this directory is going to be rebuilt from scratch by someone
who wants to understand every part of it. They'll use dum, a coding tool that
won't write code they can't explain.

Read it - the file list, then the files that carry the logic; skip lockfiles,
vendored and generated code - and reply with two things.

1. milestones: the order to rebuild it in, as requests to dum. Each is one
   small working step that builds on the last, one plain sentence under 20
   words ("a CLI that reads the config file and prints it"). Start from the
   smallest thing that runs. Six to twelve of them. Describe what to build,
   not what the original's files are called.

2. skills: every concept the project rests on that you'd need to understand to
   write it - named the way an engineer says it out loud - and for each, what it
   builds on directly, down to what they hold or basic programming.
   ${names.length ? `What they hold (reuse these exact names): ${names.join(", ")}.` : "Their skill tree is empty."}
   requires may only name concepts in your list or on their tree. At most 30.

Reply with ONLY JSON, no prose and no fence:
{"title": "rebuild <project name>", "summary": "one sentence on what it is", "milestones": ["..."], "skills": [{"name": "...", "requires": ["..."]}]}`,
    { model: MODEL, cwd: source, tools: TOOLS, onStatus },
  );
  const r = Read.safeParse(json(reply, "{"));
  if (!r.success) return null;
  const seen = new Set<string>();
  const needs = r.data.skills
    .filter((s) => {
      const k = skills.key(s.name);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((s) => ({ name: s.name.trim(), requires: s.requires.map((x) => x.trim()).filter(Boolean) }));
  return {
    title: r.data.title.trim().toLowerCase(),
    summary: r.data.summary.trim(),
    needs,
    milestones: r.data.milestones.map((m) => m.trim()).filter(Boolean),
  };
}

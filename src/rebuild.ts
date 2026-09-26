// Rebuild a project you already have, from nothing, without vibecoding it.

import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as skills from "./skills.ts";
import type { Mapped } from "./planner.ts";
import { oneShot, json } from "./oneshot.ts";

const MODEL = "claude-opus-5-5";
const EFFORT = "high";
export const VOICE = { model: MODEL, effort: EFFORT };
const TOOLS = ["Read", "Glob", "Grep"];

export type Milestone = { request: string; done: boolean; minutes?: number };
/** A folder built one milestone at a time. */
export type Rebuild = { source: string; goal: string; milestones: Milestone[]; topic?: string };

const file = (root: string) => `${root}/.dum/milestones.json`;
/** Where rebuilds kept them before learning projects shared the format. */
const legacy = (root: string) => `${root}/.dum/rebuild.json`;

export function load(root: string): Rebuild | null {
  let text: string;
  try {
    text = readFileSync(file(root), "utf8");
  } catch {
    try {
      text = readFileSync(legacy(root), "utf8");
    } catch {
      return null;
    }
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw.goal !== "string" || !Array.isArray(raw.milestones)) return null;
    return {
      source: typeof raw.source === "string" ? raw.source : "",
      ...(typeof raw.topic === "string" && raw.topic ? { topic: raw.topic } : {}),
      goal: raw.goal,
      milestones: raw.milestones
        .filter((m: any) => m && typeof m.request === "string")
        .map((m: any) => ({
          request: m.request,
          done: m.done === true,
          ...(typeof m.minutes === "number" && m.minutes > 0 ? { minutes: m.minutes } : {}),
        })),
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
export function nextUp(r: Rebuild): { index: number; request: string; minutes?: number } | null {
  const i = r.milestones.findIndex((m) => !m.done);
  if (i < 0) return null;
  const m = r.milestones[i]!;
  return { index: i, request: m.request, ...(m.minutes ? { minutes: m.minutes } : {}) };
}

/** What a unit is called here, and how far along it is. */
export function progress(r: Rebuild): { done: number; total: number; unit: string } {
  return { done: r.milestones.filter((m) => m.done).length, total: r.milestones.length, unit: r.topic ? "feature" : "milestone" };
}

/** A feature or milestone as the model wrote it: a sentence, or a sentence with minutes. */
export const Step = z.union([
  z.string().min(1).transform((request) => ({ request, minutes: undefined as number | undefined })),
  z.object({ request: z.string().min(1), minutes: z.number().positive().max(600).optional().catch(undefined) }),
]);

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
  const list = r.milestones.map((m, i) => `${i + 1}. ${m.request}${m.done ? " (built)" : ""}`).join("  ");
  if (r.topic) {
    return `THIS IS A LEARNING PROJECT
They asked to learn ${r.topic}, and "${r.goal}" was designed around it: small,
and resting on skills they already hold wherever it could, so the new parts
are the topic. Build it one feature at a time, the usual way - the gate, the
questions, the holes. Pieces on skills they hold get filled in front of them.
The rest are theirs: typed, or explained and then filled. Aim your questions
at ${r.topic}, not at what's around it.
Features: ${list}
${n ? `Next up: ${n.index + 1}.` : "All features are built."}`;
  }
  return `THIS IS A REBUILD
They're rebuilding ${basename(r.source)} from scratch in this folder, to be able
to explain every part of it. The original is not here and you can't read it -
don't go looking. Build what each request asks, in this repo, the usual way:
the gate, the questions, the holes. Pieces on skills they hold get filled in
front of them; the rest are theirs to type.
Milestones: ${list}
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
  milestones: z.array(Step).min(1),
  skills: z.array(z.object({ name: z.string().min(1), requires: z.array(z.string()).catch([]) })).catch([]),
});

/** Read the original: what it rests on, and the order to rebuild it in. */
export async function read(
  source: string,
  t: skills.Tree,
  onStatus?: (s: string) => void,
): Promise<(Mapped & { milestones: { request: string; minutes?: number }[] }) | null> {
  const names = t.skills.filter((s) => s.solid).map((s) => s.name);
  const reply = await oneShot(
    `The project in this directory is going to be rebuilt from scratch by someone
who wants to understand every part of it. They'll use dum, a coding tool that
won't write code they can't explain.

Read it - the file list, then the files that carry the logic; skip lockfiles,
vendored and generated code - and reply with two things.

1. milestones: the order to rebuild it in, as requests to dum. Each is one
   small working step that builds on the last, one plain sentence under 20
   words ("a CLI that reads the config file and prints it"), with an honest
   estimate in minutes for someone learning as they go. Start from the
   smallest thing that runs. Six to twelve of them, none over 45 minutes -
   split any that would be. Describe what to build, not the original's files.

2. skills: every concept the project rests on that you'd need to understand to
   write it - named the way an engineer says it out loud - and for each, what it
   builds on directly, down to what they hold or basic programming.
   ${names.length ? `What they hold (reuse these exact names): ${names.join(", ")}.` : "Their skill tree is empty."}
   requires may only name concepts in your list or on their tree. At most 30.

Reply with ONLY JSON, no prose and no fence:
{"title": "rebuild <project name>", "summary": "one sentence on what it is", "milestones": [{"request": "...", "minutes": 20}], "skills": [{"name": "...", "requires": ["..."]}]}`,
    { model: MODEL, effort: EFFORT, cwd: source, tools: TOOLS, onStatus },
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
    milestones: r.data.milestones.map((m) => ({ request: m.request.trim(), ...(m.minutes ? { minutes: Math.round(m.minutes) } : {}) })).filter((m) => m.request),
  };
}

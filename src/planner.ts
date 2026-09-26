// The model's half of planning: what a goal rests on, and what to build on
// the way up. Tiering and ordering are code, in projects.ts - a model is good
// at knowing that websockets sit on HTTP and TCP, and bad at counting.

import { z } from "zod";
import * as skills from "./skills.ts";
import * as projects from "./projects.ts";
import { oneShot, json } from "./oneshot.ts";

/**
 * Opus, not the Sonnet the voices use. Those are about latency; this runs
 * once, prints, and everything after it follows the map it draws - a wrong
 * prerequisite here is a project you're sent to build for nothing.
 */
const MODEL = "claude-opus-5-5";
export const EFFORT = "high";
export const VOICE = { model: MODEL, effort: EFFORT };

function knownList(t: skills.Tree): string {
  const names = t.skills.filter((s) => s.solid).map((s) => s.name);
  return names.length
    ? `What they already hold (reuse these exact names): ${names.join(", ")}.`
    : "Their skill tree is empty - assume they can write basic programs (variables, loops, functions, conditionals) and nothing more.";
}

const Map = z.object({
  title: z.string().min(1),
  summary: z.string().catch(""),
  skills: z
    .array(z.object({ name: z.string().min(1), requires: z.array(z.string()).catch([]) }))
    .catch([]),
});

export type Mapped = { title: string; summary: string; needs: projects.Need[] };

/** What a goal rests on, as a graph down to their tree. Null if the model gave nothing usable. */
export async function map(idea: string, t: skills.Tree, onStatus?: (s: string) => void): Promise<Mapped | null> {
  const reply = await oneShot(
    `Someone wants to build this, and understand every part of it - they won't let code be written that they can't explain:

${idea}

Map what building it rests on.
- Every concept they'd need to understand to write it themselves. Not tools
  they'd install, not boilerplate: concepts, the way an engineer names them
  out loud ("tcp sockets", "sql joins", "rust ownership").
- For each, what it builds on directly. Keep going down until you reach
  something they already hold, or basic programming.
- ${knownList(t)}
- requires may only name concepts in your list or on their tree.
- At most 30 concepts. The load-bearing ones.

Reply with ONLY JSON, no prose and no fence:
{"title": "a short name for the project, lowercase", "summary": "one sentence", "skills": [{"name": "...", "requires": ["..."]}]}`,
    { model: MODEL, effort: EFFORT, onStatus },
  );
  const m = Map.safeParse(json(reply, "{"));
  if (!m.success || !m.data.skills.length) return null;
  const seen = new Set<string>();
  const needs: projects.Need[] = [];
  for (const s of m.data.skills) {
    const k = skills.key(s.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    needs.push({ name: s.name.trim(), requires: s.requires.map((r) => r.trim()).filter(Boolean) });
  }
  return { title: m.data.title.trim(), summary: m.data.summary.trim(), needs };
}

const Brief = z.object({
  minutes: z.number().positive().max(2400).optional().catch(undefined),
  title: z.string().min(1),
  brief: z.string().catch(""),
  done_when: z.string().catch(""),
  start: z.string().catch(""),
});

export type Written = z.infer<typeof Brief>;

function briefPrompt(context: string, jobs: string[], t: skills.Tree): string {
  return `${context}

${knownList(t)}

Write one small project for each numbered item below. Each is built with dum,
a coding tool that won't write what the person can't explain: it asks them
about the concepts, or leaves them holes to type. So each project must really
exercise exactly the concepts listed - building it is how they learn them.

- small: an evening or two, one clear thing that runs.
- concrete and a little fun. "a CLI that tails a log and colours errors", not
  "a project demonstrating file streams".
- title: short, lowercase, no punctuation beyond spaces and hyphens.
- brief: two or three sentences - what it does, and why it's the right
  size step. Written to them: "you", never "they".
- done_when: one sentence, something they can see working.
- minutes: an honest estimate for someone learning as they go. A number.
- start: the first thing to say to dum in an empty folder - one plain request,
  under 15 words, the way you'd ask a teammate. "a vec2 class with add and length".

${jobs.map((j, i) => `${i + 1}. ${j}`).join("\n")}

Reply with ONLY a JSON array of ${jobs.length} objects, in order, no prose and no fence:
[{"title": "...", "brief": "...", "done_when": "...", "start": "...", "minutes": 90}]`;
}

async function briefs(prompt: string, count: number, onStatus?: (s: string) => void): Promise<Written[] | null> {
  const raw = json(await oneShot(prompt, { model: MODEL, effort: EFFORT, onStatus }), "[");
  if (!Array.isArray(raw) || raw.length < count) return null;
  const out: Written[] = [];
  for (const r of raw.slice(0, count)) {
    const b = Brief.safeParse(r);
    if (!b.success) return null;
    out.push(b.data);
  }
  return out;
}

export function body(w: Written): string {
  return [w.brief.trim(), w.done_when.trim() ? `**done when:** ${w.done_when.trim()}` : ""].filter(Boolean).join("\n\n");
}

/**
 * Plan a goal: map it, cut the ladder, write the steps. Returns the notes to
 * write - the goal itself last - or null if the model gave nothing usable.
 */
export async function plan(
  idea: { title: string; body: string },
  t: skills.Tree,
  existing: projects.Project[],
  onStatus?: (s: string) => void,
  /** Already mapped - a rebuild reads the original and maps it in one go. */
  mapped?: Mapped,
): Promise<{ goal: projects.Project; steps: projects.Project[]; height: number } | null> {
  const text = idea.body.trim() ? `${idea.title}\n\n${idea.body}` : idea.title;
  if (!mapped) onStatus?.("mapping what it rests on");
  const m = mapped ?? (await map(text, t, onStatus));
  if (!m) return null;
  const holds = projects.holder(t);
  const { steps, top, topAfter, height } = projects.ladder(m.needs, holds);
  const today = new Date().toISOString().slice(0, 10);
  const goalTitle = idea.title;

  let written: Written[] = [];
  const jobs = [
    ...steps.map((s) => `a step toward the goal, exercising: ${s.unlocks.join(", ")}`),
    `the goal itself, exercising: ${top.join(", ") || "what it needs"}`,
  ];
  onStatus?.(`writing ${jobs.length} project${jobs.length === 1 ? "" : "s"}`);
  written =
    (await briefs(
      briefPrompt(`The goal they're working up to: ${text}\n(${m.summary})`, jobs, t),
      jobs.length,
      onStatus,
    )) ?? [];
  if (written.length !== jobs.length) return null;

  // Step titles must not land on another project's note.
  const taken = new Set(existing.filter((p) => skills.key(p.title) !== skills.key(goalTitle)).map((p) => skills.key(p.title)));
  const titles: string[] = [];
  for (const w of written.slice(0, -1)) {
    let title = w.title.trim();
    if (taken.has(skills.key(title)) || skills.key(title) === skills.key(goalTitle)) title = `${title} (for ${goalTitle})`;
    taken.add(skills.key(title));
    titles.push(title);
  }

  const stepNotes: projects.Project[] = steps.map((s, i) => ({
    title: titles[i]!,
    kind: "step",
    unlocks: s.unlocks,
    after: s.after.map((j) => titles[j]!),
    leadsTo: goalTitle,
    start: written[i]!.start.trim(),
    planned: today,
    body: body(written[i]!),
    ...(written[i]!.minutes ? { minutes: Math.round(written[i]!.minutes!) } : {}),
  }));
  const last = written[written.length - 1]!;
  const goal: projects.Project = {
    title: goalTitle,
    kind: "goal",
    unlocks: top,
    after: topAfter.map((j) => titles[j]!),
    leadsTo: "",
    start: last.start.trim(),
    planned: today,
    ...(last.minutes ? { minutes: Math.round(last.minutes) } : {}),
    body: [idea.body.trim() && idea.body.trim() !== idea.title ? idea.body.trim() : m.summary, body({ ...last, brief: last.brief })]
      .filter(Boolean)
      .join("\n\n"),
  };
  return { goal, steps: stepNotes, height };
}

/**
 * The skills to unlock next, cheapest first: what the queue's ready steps
 * need, then what they were taught but haven't shown, then prerequisites the
 * tree names but nobody has recorded.
 */
export function frontier(t: skills.Tree, queue: projects.Project[]): string[] {
  const holds = projects.holder(t);
  const out: string[] = [];
  const add = (n: string) => {
    if (!holds(n) && !out.some((o) => skills.key(o) === skills.key(n))) out.push(n);
  };
  for (const p of queue) if (projects.status(p, queue, holds) === "ready") p.unlocks.forEach(add);
  for (const s of skills.shaky(t)) add(s.name);
  for (const s of t.skills) for (const r of s.requires) if (!skills.find(t, r)) add(r);
  return out;
}

/** n project ideas that each unlock something from the frontier. */
export async function ideas(
  targets: string[],
  n: number,
  t: skills.Tree,
  onStatus?: (s: string) => void,
): Promise<projects.Project[] | null> {
  const picks = Array.from({ length: n }, (_, i) => targets.slice((i * 2) % targets.length, ((i * 2) % targets.length) + 2));
  const jobs = picks.map((p) => `the fastest way to unlock: ${p.join(", ")}`);
  onStatus?.(`writing ${n} idea${n === 1 ? "" : "s"}`);
  const written = await briefs(
    briefPrompt("They want to unlock the next skills on their tree as fast as possible.", jobs, t),
    n,
    onStatus,
  );
  if (!written) return null;
  const today = new Date().toISOString().slice(0, 10);
  return written.map((w, i) => ({
    title: w.title.trim(),
    kind: "idea" as const,
    unlocks: picks[i]!,
    after: [],
    leadsTo: "",
    start: w.start.trim(),
    planned: today,
    body: body(w),
    ...(w.minutes ? { minutes: Math.round(w.minutes) } : {}),
  }));
}

// Ask to learn a topic, and get a project that teaches it fast.

import { z } from "zod";
import * as skills from "./skills.ts";
import * as projects from "./projects.ts";
import type { Mapped } from "./planner.ts";
import { oneShot, json } from "./oneshot.ts";
import { Step } from "./rebuild.ts";

const MODEL = "claude-opus-5-5";
const EFFORT = "high";
export const VOICE = { model: MODEL, effort: EFFORT };

const Design = z.object({
  title: z.string().min(1),
  summary: z.string().catch(""),
  why: z.string().catch(""),
  features: z.array(Step).min(1),
  skills: z.array(z.object({ name: z.string().min(1), requires: z.array(z.string()).catch([]) })).catch([]),
});

export type Designed = Mapped & { why: string; features: { request: string; minutes?: number }[] };

export async function design(topic: string, t: skills.Tree, onStatus?: (s: string) => void): Promise<Designed | null> {
  const held = t.skills.filter((s) => s.solid).map((s) => s.name);
  const reply = await oneShot(
    `Someone wants to learn this, fast, by building something:

${topic}

Design one small project for it. They'll build it with dum, a coding tool that
won't write code they can't explain: it asks about concepts, leaves holes to
type, and fills in only what's on their skill tree.

${
  held.length
    ? `Their skill tree - what they already hold (reuse these exact names): ${held.join(", ")}.`
    : "Their skill tree is empty. Assume basic programming and nothing else."
}

- The topic must be the point, and as much of the rest as possible should rest
  on what they already hold. The new concepts should be the topic's, not
  incidental ones.
- Small: a few evenings at most. Something that runs early and grows.
- features: the order to build it in, as requests to dum. Each one small and
  working, building on the last, one plain sentence under 20 words, with an
  honest estimate in minutes for someone learning it. Five to ten of them,
  none over 30 minutes - split any that would be. The first is the smallest
  thing that runs, and should take about ten.
- skills: every concept the project rests on - the topic's AND the ones from
  their tree it uses, listed by their exact tree names with requires: [].
  Name each the way an engineer says it out loud, at the grain of a skill tree:
  "asyncio basics", not "asyncio.run" and "async for" separately. Each with
  what it builds on directly. requires may only name concepts in your list or
  on their tree. Eight to fifteen in all.
- why: one or two sentences, to them ("you"), on why this project teaches the
  topic fast.
- title: short, lowercase.

Reply with ONLY JSON, no prose and no fence:
{"title": "...", "summary": "one sentence on what it is", "why": "...", "features": [{"request": "...", "minutes": 15}], "skills": [{"name": "...", "requires": ["..."]}]}`,
    { model: MODEL, effort: EFFORT, onStatus },
  );
  const d = Design.safeParse(json(reply, "{"));
  if (!d.success) return null;
  const seen = new Set<string>();
  const needs = d.data.skills
    .filter((s) => {
      const k = skills.key(s.name);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((s) => ({ name: s.name.trim(), requires: s.requires.map((x) => x.trim()).filter(Boolean) }));
  return {
    title: d.data.title.trim().toLowerCase(),
    summary: d.data.summary.trim(),
    why: d.data.why.trim(),
    needs,
    features: d.data.features.map((f) => ({ request: f.request.trim(), ...(f.minutes ? { minutes: Math.round(f.minutes) } : {}) })).filter((f) => f.request),
  };
}

/** How much of what a project rests on is already on the tree. */
export function coverage(needs: projects.Need[], t: skills.Tree): { held: string[]; missing: string[] } {
  const holds = projects.holder(t);
  const held: string[] = [];
  const add = (n: string) => {
    if (holds(n) && !held.some((h) => skills.key(h) === skills.key(n))) held.push(skills.find(t, n)?.name ?? n);
  };
  for (const n of needs) {
    add(n.name);
    n.requires.forEach(add);
  }
  return { held, missing: needs.filter((n) => !holds(n.name)).map((n) => n.name) };
}

/** A folder name for a topic: ./learn-websockets. */
export function slug(topic: string): string {
  const s = topic
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `learn-${s || "topic"}`;
}

// Each goal's path, progress and one next step, the skips the user made, and the play pick. A goal
// is stored as a zone; this reads what the zone's other owners already keep (directions, the chosen
// project, the tree) and owns only `zones/<id>/steps.json`, written by the host alone. Skipping a
// skill step is trust: it goes through evidence's self-report, the same word-not-review path as
// adding a skill by hand, so the gate counts it and Undo trust takes it back.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import { goalHash, type Directions } from "./directions.ts";
import { activeProject } from "./practice.ts";
import { readState, writeState } from "./state-files.ts";
import { trackDepths } from "./web/view.ts";
import { SkillRefSchema, type SkillRef, type ZoneId, type ZoneRegistry } from "./zone-types.ts";
import { STEP_LIMITS, type GoalView, type NextSkill, type StepKind, type StepView } from "./step-types.ts";

/** What a goal's steps need from its zone: language and focus skills resolved up the parent chain. */
export type GoalZone = { id: ZoneId; name: string; goal: string; language: string; focusSkills: SkillRef[] };

/** `zones/<id>/steps.json`: skipped step ids, the whole-goal skip mark, and the skill being played. */
export type StepsRecord = {
  version: 1;
  skipped: Record<string, string>;
  goalSkippedAt: string | null;
  playing: SkillRef | null;
};

/** How many skip marks one goal keeps; the oldest go first. */
const MAX_SKIPPED = 500;
const MAX_BYTES = 128 * 1024;
const iso = z.string().min(1).max(64);

export const StepsRecordSchema = z.object({
  version: z.literal(1),
  skipped: z.record(z.string().regex(/^[a-z]+-[0-9a-f]{16}$/), iso).refine((m) => Object.keys(m).length <= MAX_SKIPPED, "too many skips"),
  goalSkippedAt: iso.nullable(),
  playing: SkillRefSchema.nullable(),
}).strict() satisfies z.ZodType<StepsRecord>;

export const EMPTY_STEPS: StepsRecord = { version: 1, skipped: {}, goalSkippedAt: null, playing: null };

export const stepsFile = (zoneId: ZoneId) => `zones/${zoneId}/steps.json`;

/** A goal's step record; absent is empty. Unreadable throws naming the file, and nothing replaces it. */
export function readSteps(home: string, zoneId: ZoneId): StepsRecord {
  const rel = stepsFile(zoneId);
  let raw: string | null;
  try {
    raw = readState(home, rel, MAX_BYTES);
  } catch (err) {
    throw new Error(`${rel} can't be read (${(err as Error).message}) - Dum left it as it is`);
  }
  if (raw === null) return EMPTY_STEPS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${rel} isn't valid JSON - fix or move it; Dum left it as it is`);
  }
  const parsed = StepsRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${rel} isn't a goal steps file Dum can read - fix or move it; Dum left it as it is`);
  return parsed.data;
}

/** Atomic private write; the oldest skip marks go past the bound. */
export function writeSteps(home: string, zoneId: ZoneId, record: StepsRecord): void {
  const entries = Object.entries(record.skipped).sort((a, b) => a[1].localeCompare(b[1])).slice(-MAX_SKIPPED);
  const next = StepsRecordSchema.parse({ ...record, skipped: Object.fromEntries(entries) });
  writeState(home, stepsFile(zoneId), `${JSON.stringify(next, null, 2)}\n`);
}

/** Every live zone as a goal, registry order, with its language and focus skills inherited as `resolveZone` does. */
export function goalZones(registry: ZoneRegistry): GoalZone[] {
  const byId = new Map(registry.zones.map((z) => [z.id, z]));
  const out: GoalZone[] = [];
  for (const z of registry.zones) {
    if (z.deletedAt !== null) continue;
    const chain = [z];
    for (let p = z.parentId ? byId.get(z.parentId) : undefined; p && chain.length < 64 && !chain.includes(p); p = p.parentId ? byId.get(p.parentId) : undefined) chain.unshift(p);
    const seen = new Set<string>();
    const focusSkills: SkillRef[] = [];
    for (const c of chain) {
      for (const s of c.focusSkills) {
        const k = skills.id(s.name, s.lang);
        if (seen.has(k)) continue;
        seen.add(k);
        focusSkills.push(s);
      }
    }
    out.push({ id: z.id, name: z.name, goal: z.goal, language: chain.findLast((c) => c.language !== null)?.language ?? "", focusSkills });
  }
  return out;
}

// -- the path -------------------------------------------------------------------------------------

/** Where a skill lives when a goal in `lang` names it, spelled the tracks' way. */
function place(name: string, lang: string): SkillRef {
  const at = curriculum.locate(name, lang).lang;
  return { name: curriculum.canonical(name, at), lang: at };
}

/**
 * The skills a goal works through: its focus skills and everything they build on, in the goal's
 * language, prerequisites first (by depth, then name). No focus skills: the language's whole curated
 * track. No language: nothing.
 */
export function goalPath(zone: GoalZone): SkillRef[] {
  const lang = skills.langName(zone.language);
  if (!lang) return [];
  const roots = zone.focusSkills.length
    ? zone.focusSkills.map((s) => place(s.name, s.lang || lang))
    : curriculum.names(lang).map((name) => ({ name, lang }));
  const nodes = new Map<string, { ref: SkillRef; requires: string[] }>();
  const visit = (ref: SkillRef) => {
    const id = skills.id(ref.name, ref.lang);
    if (nodes.has(id)) return;
    const node = { ref, requires: [] as string[] };
    nodes.set(id, node);
    for (const r of curriculum.prereqs(ref.name, ref.lang)) {
      const under = place(r, ref.lang || lang);
      node.requires.push(skills.id(under.name, under.lang));
      visit(under);
    }
  };
  for (const r of roots) visit(r);
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = nodes.get(id);
    if (!node || seen.has(id)) return 0;
    seen.add(id);
    const d = node.requires.length ? 1 + Math.max(...node.requires.map((r) => depth(r, seen))) : 0;
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  return [...nodes.entries()]
    .map(([id, n]) => ({ ref: n.ref, d: depth(id, new Set()) }))
    .sort((a, b) => a.d - b.d || a.ref.name.localeCompare(b.ref.name) || a.ref.lang.localeCompare(b.ref.lang))
    .map((x) => x.ref);
}

/** A beginner skill skips in one click: depth 0 or 1 on its curated track, or off the tracks with nothing under it. */
export function beginner(skill: SkillRef): boolean {
  const lang = skills.langName(skill.lang);
  const track = curriculum.tracks().find((t) => t.lang === lang && t.skills.some((n) => skills.key(n.name) === skills.key(skill.name)));
  if (!track) return curriculum.prereqs(skill.name, lang).length === 0;
  const node = track.skills.find((n) => skills.key(n.name) === skills.key(skill.name))!;
  return (trackDepths(track).get(node.name) ?? 0) <= 1;
}

const built = (t: skills.Tree, s: SkillRef) => skills.holds(t, s.name, s.lang, "build");
const open = (t: skills.Tree, s: SkillRef) => curriculum.current(t, s.name, s.lang).state === "open";

// -- text -----------------------------------------------------------------------------------------

/** One clean line of at most `max` characters. */
function line(text: string, max: number): string {
  const one = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The first sentence of `text`, without its closing punctuation. */
function firstSentence(text: string): string {
  const one = line(text, 4000);
  return (one.split(/(?<=[.!?])\s/)[0] ?? one).replace(/[.!?]+$/, "").trim();
}

/** `prefix` then as much of `body` as fits one sentence of STEP_LIMITS.text. */
function sentence(prefix: string, body: string): string {
  const room = STEP_LIMITS.text - prefix.length - 1;
  const b = line(body, Math.max(room, 8));
  return line(b.endsWith("…") ? `${prefix}${b}` : `${prefix}${b}.`, STEP_LIMITS.text);
}

export function stepId(kind: StepKind, zoneId: ZoneId, subject: string): string {
  return `${kind}-${createHash("sha256").update(zoneId + subject).digest("hex").slice(0, 16)}`;
}

// -- steps ----------------------------------------------------------------------------------------

/** A chosen project's milestones, as the step needs them. */
export type ChosenProject = { id: string; title: string; exercise: string; milestones: { skill: string; text: string }[] };

/** What a goal's step rests on besides the tree: read from disk, cached by the host. */
export type GoalFacts = { aligned: boolean; project: ChosenProject | null; steps: StepsRecord };

function step(zone: GoalZone, kind: StepKind, subject: string, text: string, skill: SkillRef | null, pick: StepView["pick"], confirmSkip: boolean): StepView {
  return {
    id: stepId(kind, zone.id, subject), zoneId: zone.id, goal: line(zone.name, STEP_LIMITS.goal), kind, text, skill,
    pick: pick && { label: line(pick.label, STEP_LIMITS.label), prompt: line(pick.prompt, STEP_LIMITS.prompt) }, confirmSkip,
  };
}

/** The skill the goal works on now: the played one (or the first open rung under it), else the path's first open skill. */
function skillTarget(t: skills.Tree, path: SkillRef[], playing: SkillRef | null): SkillRef | null {
  if (playing && !built(t, playing)) {
    const st = curriculum.current(t, playing.name, playing.lang);
    if (st.state === "open") return playing;
    if (st.state === "locked" && st.next) {
      const rung = place(st.next, playing.lang);
      if (!built(t, rung)) return rung;
    }
  }
  return path.find((s) => !built(t, s) && open(t, s)) ?? null;
}

/** The goal's one next step, or null once there's none or the goal was skipped. The first match wins. */
export function currentStep(t: skills.Tree, zone: GoalZone, facts: GoalFacts, path = goalPath(zone)): StepView | null {
  const { steps } = facts;
  if (steps.goalSkippedAt !== null) return null;
  const skipped = (id: string) => id in steps.skipped;
  const align = step(zone, "align", `align\0${goalHash(zone.goal)}`, "Say what finishing this goal looks like.", null, {
    label: "Pick a direction for me", prompt: "Pick a direction for this goal for me: what I'll be able to do when it's done and how I'll know.",
  }, false);
  if (!facts.aligned && !skipped(align.id)) return align;
  if (!facts.project) {
    const project = step(zone, "project", "project", "Pick a project theme or idea.", null, {
      label: "Pick the project idea for me", prompt: "Pick a project idea for me that fits this goal, and say why in one line.",
    }, false);
    if (!skipped(project.id)) return project;
  } else {
    const p = facts.project;
    for (const [i, m] of p.milestones.entries()) {
      const ref = place(m.skill, p.exercise);
      if (curriculum.current(t, ref.name, ref.lang).state === "unlocked") continue;
      const s = step(zone, "milestone", `milestone\0${p.id}\0${i}\0${skills.key(m.skill)}`, sentence(`Finish milestone ${i + 1}: `, firstSentence(m.text) || m.skill), ref, {
        label: "Break it down for me", prompt: "Break my next milestone into the first small thing I should do.",
      }, false);
      if (!skipped(s.id)) return s;
    }
  }
  const target = skillTarget(t, path, steps.playing);
  if (!target) return null;
  const name = line(target.name, 100);
  const confirm = !beginner(target);
  if (!skills.levelIn(t, target.name, target.lang)) {
    return step(zone, "recognize", `recognize\0${skills.id(target.name, target.lang)}`, sentence("Explain what ", `${name} is for, in your own words`), target, {
      label: "Show me an example first", prompt: `Show me one short example of ${name}, then ask me to explain it back.`,
    }, confirm);
  }
  return step(zone, "build", `build\0${skills.id(target.name, target.lang)}`, sentence("Write ", `${name} yourself, without AI`), target, {
    label: "Pick a tiny exercise for me", prompt: `Pick a tiny exercise for ${name} I can write unaided in about 15 minutes.`,
  }, confirm);
}

/** A goal's path, progress and step. */
export function goalView(t: skills.Tree, zone: GoalZone, facts: GoalFacts): GoalView {
  const path = goalPath(zone);
  return {
    id: zone.id,
    path,
    progress: { done: path.filter((s) => built(t, s)).length, total: path.length },
    step: currentStep(t, zone, facts, path),
    skippedAt: facts.steps.goalSkippedAt,
  };
}

/** The play pick for a goal: its path's first open skill, else the open frontier of its language's tracks. */
export function nextSkill(t: skills.Tree, zone: GoalZone): NextSkill | null {
  const onPath = goalPath(zone).find((s) => !built(t, s) && open(t, s));
  if (onPath) return { skill: onPath, zoneId: zone.id, why: line(`Its prerequisites are done and ${zone.name} needs it.`, STEP_LIMITS.why) };
  const lang = skills.langName(zone.language);
  if (!lang) return null;
  for (const track of curriculum.tracks().filter((tr) => tr.lang === lang)) {
    const name = curriculum.frontier(t, track)[0];
    if (name) return { skill: { name, lang }, zoneId: null, why: line(`Its prerequisites are done and it's next on your ${lang} ${track.name} track.`, STEP_LIMITS.why) };
  }
  return null;
}

// -- the host's side: facts on disk, cached; skips and play -------------------------------------

/** Their word on one skill, through evidence's self-report. */
export type Trust = (skill: SkillRef) => { ok: boolean; why: string };

/** A file's identity: an atomic replace changes the inode, any write the time. */
function signature(home: string, rel: string): string {
  try {
    const s = statSync(join(home, rel), { bigint: true });
    return `${s.ino}:${s.mtimeNs}:${s.size}`;
  } catch {
    return "-";
  }
}

/** One goal's facts and why its steps file couldn't be read, if it couldn't. */
type Cached = { sig: string; facts: GoalFacts; error: string | null };

/**
 * The host's goal state: facts per goal cached by the files they come from, so a change elsewhere
 * rereads nothing; the step skips, goal skips and play it records.
 */
export class Goals {
  private readonly cache = new Map<ZoneId, Cached>();

  constructor(private readonly home: string, private readonly directions: Directions, private readonly now: () => number = Date.now) {}

  /** What the goal's step rests on, reread only when one of its files or its goal text changed. */
  facts(zone: GoalZone): Cached {
    const sig = [
      goalHash(zone.goal),
      signature(this.home, `zones/${zone.id}/direction/head.json`),
      signature(this.home, `zones/${zone.id}/practice.json`),
      signature(this.home, stepsFile(zone.id)),
    ].join("|");
    const was = this.cache.get(zone.id);
    if (was && was.sig === sig) return was;
    let aligned = false;
    try {
      const ctx = { id: zone.id, revision: 0, breadcrumb: [{ id: zone.id, name: zone.name }], goal: zone.goal, ancestorGoals: [], language: "", focusSkills: [], notes: [] };
      aligned = this.directions.read(ctx, goalHash(zone.goal)).current !== null;
    } catch { /* an unreadable direction is no agreed direction; directions reports it where it's used */ }
    let project: ChosenProject | null = null;
    try {
      const p = activeProject(this.home, zone.id);
      if (p && p.state === "open") project = { id: p.id, title: p.title, exercise: p.exercise, milestones: p.targets.map((m) => ({ skill: m.skill, text: m.milestone })) };
    } catch { /* practice reports its own file */ }
    let steps = EMPTY_STEPS;
    let error: string | null = null;
    try {
      steps = readSteps(this.home, zone.id);
    } catch (err) {
      error = (err as Error).message;
    }
    const next = { sig, facts: { aligned, project, steps }, error };
    this.cache.set(zone.id, next);
    return next;
  }

  /** The goal as the state shows it. A played skill they now hold stops being played. */
  view(t: skills.Tree, zone: GoalZone): GoalView {
    let { facts, error } = this.facts(zone);
    const playing = facts.steps.playing;
    if (!error && playing && built(t, playing)) {
      try {
        writeSteps(this.home, zone.id, { ...facts.steps, playing: null });
        facts = this.facts(zone).facts;
      } catch { /* shown again next time; the step already moved on */ }
    }
    return goalView(t, zone, facts);
  }

  /** The goal's record, or the reason it can't be changed. */
  private record(zone: GoalZone): StepsRecord {
    const { facts, error } = this.facts(zone);
    if (error) throw new Error(error);
    return facts.steps;
  }

  /**
   * Skip the whole goal: every unheld skill on its path is trusted, prerequisites first, then the
   * goal is marked skipped. `skip` false takes back only the mark; trusted skills stay.
   */
  skipGoal(zone: GoalZone, skip: boolean, tree: () => skills.Tree, trust: Trust): void {
    const record = this.record(zone);
    if (!skip) {
      if (record.goalSkippedAt !== null) writeSteps(this.home, zone.id, { ...record, goalSkippedAt: null });
      return;
    }
    // Prerequisites first; each skill is asked once, so a refusal-free no-op can't loop.
    const waiting = goalPath(zone);
    for (let moved = true; moved;) {
      moved = false;
      for (const s of [...waiting]) {
        const t = tree();
        if (built(t, s)) {
          waiting.splice(waiting.indexOf(s), 1);
          continue;
        }
        if (!open(t, s)) continue;
        const result = trust(s);
        if (!result.ok) throw new Error(result.why);
        waiting.splice(waiting.indexOf(s), 1);
        moved = true;
      }
    }
    writeSteps(this.home, zone.id, { ...record, goalSkippedAt: new Date(this.now()).toISOString() });
  }

  /** Skip the goal's current step. A skill step is trusted; any other is marked skipped. */
  skipStep(zone: GoalZone, stepId: string, confirmed: boolean, tree: () => skills.Tree, trust: Trust): void {
    const record = this.record(zone);
    const current = currentStep(tree(), zone, this.facts(zone).facts);
    if (!current || current.id !== stepId) throw new Error("That step changed");
    if (current.confirmSkip && !confirmed) throw new Error("Skipping that step needs a yes first");
    if ((current.kind === "recognize" || current.kind === "build") && current.skill) {
      const result = trust(current.skill);
      if (!result.ok) throw new Error(result.why);
      return;
    }
    writeSteps(this.home, zone.id, { ...record, skipped: { ...record.skipped, [stepId]: new Date(this.now()).toISOString() } });
  }

  /** Work on this skill next in the goal; null takes the play pick. Returns what's being played. */
  play(t: skills.Tree, zone: GoalZone, skill: SkillRef | null): SkillRef {
    const record = this.record(zone);
    const pick = skill ? place(skill.name, skill.lang || skills.langName(zone.language)) : nextSkill(t, zone)?.skill;
    if (!pick) throw new Error("Nothing is open to work on next");
    if (built(t, pick)) throw new Error(`${skills.label(pick)} is already yours`);
    writeSteps(this.home, zone.id, { ...record, playing: pick });
    return pick;
  }
}

// Goals, their one next step, skips as trust, and play: through the steps module with real
// directions, practice and evidence records, and through the real host controller's state event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as skills from "../src/skills.ts";
import * as gate from "../src/gate.ts";
import { Evidence } from "../src/evidence.ts";
import { Directions } from "../src/directions.ts";
import { Store } from "../src/store.ts";
import { writeState } from "../src/state-files.ts";
import { view as treeView } from "../src/web/view.ts";
import { Goals, beginner, goalPath, nextSkill, readSteps, stepsFile, type GoalZone } from "../src/steps.ts";
import { StepViewSchema } from "../src/step-types.ts";
import { DesktopController } from "../src/desktop/controller.ts";
import { HostEventSchema, HostRequestSchema, type HostEvent } from "../src/desktop/host-protocol.ts";
import { DEFAULT_PREFERENCES } from "../src/desktop/protocol.ts";
import type { AlignmentAttempt, ContextRef } from "../src/delegation-types.ts";
import type { SkillRef, ZoneContext } from "../src/zone-types.ts";

process.env.DUM_CONTEXT = "off";

/** A fresh H for one test: skills, evidence and every goal record live under it. */
function fresh() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dum-steps-")));
  process.env.DUM_HOME = home;
  const directions = new Directions(home, Date.now);
  const evidence = new Evidence(home);
  return { home, directions, evidence, goals: new Goals(home, directions) };
}

const py = (name: string): SkillRef => ({ name, lang: "python" });
const goal = (focus: string[], language = "python"): GoalZone => ({
  id: randomUUID(), name: "Python", goal: "Write small Python programs on my own", language, focusSkills: focus.map(py),
});

/** Their word on a skill, the way the host records a skip. */
function trusting(evidence: Evidence, zone: GoalZone) {
  const store = new Store({ id: zone.id, name: zone.name }, DEFAULT_PREFERENCES.mode);
  return (s: SkillRef) => evidence.selfReport({ zoneId: zone.id, zoneName: zone.name, store }, s, true);
}

const tree = (evidence: Evidence) => () => gate.withoutHeld(skills.read(), evidence.held);

/** A note they earned some other way than trust. */
function earned(name: string, level: skills.Level = "build") {
  skills.write(skills.unlock(skills.read(), { name, lang: "python", how: level === "recognize" ? "explained" : "typed", level, why: "test" }));
}

/** An agreed direction for the goal, the way the host accepts one. */
function agree(directions: Directions, zone: GoalZone) {
  const ctx: ZoneContext = { id: zone.id, revision: 1, breadcrumb: [{ id: zone.id, name: zone.name }], goal: zone.goal, ancestorGoals: [], language: zone.language, focusSkills: zone.focusSkills, notes: [] };
  const ref: ContextRef = { id: randomUUID(), kind: "zone-note", label: "Zone note", revision: "a".repeat(64), at: null, excerpt: "Wants a CLI" };
  const begun = directions.begin(ctx, [ref]);
  const option = { id: randomUUID(), kind: "project" as const, title: "Build a greeter", builds: [py("variables")], advancesGoal: "It is a small program.", contextIds: [ref.id], tradeoff: "It is small." };
  const attempt: AlignmentAttempt = { ...begun.attempt!, phase: "choose", reflection: "You want to write small programs.", options: [option] };
  const head = directions.draft(zone.id, begun.revision, attempt);
  directions.accept(ctx, head.revision, {
    contextRevision: attempt.contextRevision, ability: "Write a small Python program", choice: option,
    reviewCriterion: "I can explain each line", assumptions: [], context: attempt.context,
  });
}

/** A chosen suggested project with two milestones. */
function choose(home: string, zone: GoalZone) {
  const target = (skill: string, requires: string[], milestone: string) => ({ skill, requires, milestone, done: "it runs" });
  const project = {
    id: "p1", title: "Greeter", task: "Greets people", done: "It greets", exercise: "python", focus: null, uses: [],
    duration: { minHours: 1, maxHours: 2 }, difficulty: "beginner", fit: "small",
    targets: [target("printing", [], "Print a greeting to the screen. Then print two."), target("variables", ["printing"], "Keep the name in a variable")],
    at: new Date().toISOString(), state: "open", submissions: [],
  };
  writeState(home, `zones/${zone.id}/practice.json`, JSON.stringify({ version: 2, next: 2, active: "p1", projects: [project] }));
}

test("a goal's path is its focus skills and everything under them, prerequisites first", () => {
  fresh();
  assert.deepEqual(goalPath(goal(["recursion"])).map((s) => s.name), ["printing", "variables", "conditionals", "functions", "return values", "recursion"]);
  const whole = goalPath(goal([]));
  assert.ok(whole.length > 20, "no focus skills: the language's whole track");
  assert.equal(whole[0]!.name, "printing");
  assert.deepEqual(goalPath(goal(["recursion"], "")), [], "no language: no path");
  assert.equal(beginner(py("printing")), true);
  assert.equal(beginner(py("variables")), true);
  assert.equal(beginner(py("recursion")), false);
  assert.equal(beginner(py("a made-up library")), true, "off the tracks with nothing under it");
});

test("progress counts built and trusted skills on the path, not recognition", () => {
  const { goals, evidence } = fresh();
  const zone = goal(["recursion"]);
  assert.deepEqual(goals.view(tree(evidence)(), zone).progress, { done: 0, total: 6 });
  earned("printing");
  earned("variables", "recognize");
  assert.deepEqual(goals.view(tree(evidence)(), zone).progress, { done: 1, total: 6 });
  assert.equal(trusting(evidence, zone)(py("variables")).ok, true);
  assert.deepEqual(goals.view(tree(evidence)(), zone).progress, { done: 2, total: 6 });
  assert.deepEqual(goals.view(tree(evidence)(), goal(["recursion"], "")).progress, { done: 0, total: 0 });
});

test("steps go align, then project, then each unfinished milestone, then the path's next skill", () => {
  const { home, goals, evidence, directions } = fresh();
  const zone = goal(["variables"]);
  const step = () => {
    const s = goals.view(tree(evidence)(), zone).step;
    if (s) StepViewSchema.parse(s);
    return s;
  };
  const align = step()!;
  assert.equal(align.kind, "align");
  assert.equal(align.text, "Say what finishing this goal looks like.");
  assert.deepEqual(align.pick, { label: "Pick a direction for me", prompt: "Pick a direction for this goal for me: what I'll be able to do when it's done and how I'll know." });
  assert.equal(align.confirmSkip, false);
  assert.equal(step()!.id, align.id, "the same step keeps its id");

  agree(directions, zone);
  const project = step()!;
  assert.equal(project.kind, "project");
  assert.equal(project.text, "Pick a project theme or idea.");
  assert.equal(project.pick!.label, "Pick the project idea for me");

  choose(home, zone);
  const first = step()!;
  assert.equal(first.kind, "milestone");
  assert.equal(first.text, "Finish milestone 1: Print a greeting to the screen.");
  assert.deepEqual(first.skill, py("printing"));
  assert.equal(first.pick!.label, "Break it down for me");

  earned("printing");
  const second = step()!;
  assert.equal(second.text, "Finish milestone 2: Keep the name in a variable.");
  goals.skipStep(zone, second.id, false, tree(evidence), trusting(evidence, zone));

  const skill = step()!;
  assert.equal(skill.kind, "recognize");
  assert.equal(skill.text, "Explain what variables is for, in your own words.");
  assert.deepEqual(skill.pick, { label: "Show me an example first", prompt: "Show me one short example of variables, then ask me to explain it back." });
  earned("variables", "recognize");
  const build = step()!;
  assert.equal(build.kind, "build");
  assert.equal(build.text, "Write variables yourself, without AI.");
  assert.equal(build.pick!.label, "Pick a tiny exercise for me");
  earned("variables");
  assert.equal(step(), null, "every step done");
});

test("skips persist across a restart, a stale step id is refused, and an unreadable record is left alone", () => {
  const { home, goals, evidence, directions } = fresh();
  const zone = goal(["variables"]);
  const align = goals.view(tree(evidence)(), zone).step!;
  goals.skipStep(zone, align.id, false, tree(evidence), trusting(evidence, zone));
  assert.ok(readSteps(home, zone.id).skipped[align.id]);

  const restarted = new Goals(home, directions);
  const project = restarted.view(tree(evidence)(), zone).step!;
  assert.equal(project.kind, "project");
  assert.throws(() => restarted.skipStep(zone, align.id, false, tree(evidence), trusting(evidence, zone)), /That step changed/);
  restarted.skipStep(zone, project.id, false, tree(evidence), trusting(evidence, zone));
  assert.equal(restarted.view(tree(evidence)(), zone).step!.kind, "recognize");

  const bad = join(home, stepsFile(zone.id));
  writeFileSync(bad, "{ not json");
  assert.match(restarted.facts(zone).error!, /steps\.json isn't valid JSON/);
  assert.throws(() => restarted.skipStep(zone, project.id, false, tree(evidence), trusting(evidence, zone)), /steps\.json isn't valid JSON/);
  assert.equal(readFileSync(bad, "utf8"), "{ not json", "nothing replaced it");
});

test("skipping an advanced skill asks first, and the trusted skill then passes the gate", () => {
  const { home, goals, evidence } = fresh();
  const zone = goal(["recursion"]);
  for (const s of ["printing", "variables", "conditionals", "functions", "return values"]) earned(s);
  writeState(home, stepsFile(zone.id), JSON.stringify({ version: 1, skipped: {}, goalSkippedAt: null, playing: null }));
  const align = goals.view(tree(evidence)(), zone).step!;
  goals.skipStep(zone, align.id, false, tree(evidence), trusting(evidence, zone));
  goals.skipStep(zone, goals.view(tree(evidence)(), zone).step!.id, false, tree(evidence), trusting(evidence, zone));
  const step = goals.view(tree(evidence)(), zone).step!;
  assert.equal(step.kind, "recognize");
  assert.deepEqual(step.skill, py("recursion"));
  assert.equal(step.confirmSkip, true);

  const piece = () => gate.classify(skills.read(), [{ skill: "recursion", lang: "python", what: "" }])[0]!;
  assert.equal(gate.aiWrites(piece(), "understand"), false);
  assert.throws(() => goals.skipStep(zone, step.id, false, tree(evidence), trusting(evidence, zone)), /needs a yes/);
  goals.skipStep(zone, step.id, true, tree(evidence), trusting(evidence, zone));
  const note = skills.find(skills.read(), "recursion", "python")!;
  assert.deepEqual([note.how, note.level], ["added", "build"]);
  assert.equal(gate.aiWrites(piece(), "understand"), true, "trusted counts as known for the gate");
  const node = treeView(skills.read()).tracks.find((t) => t.lang === "python" && t.name === "basics")!.nodes.find((n) => n.name === "recursion")!;
  assert.equal(node.trusted, true);
  assert.equal(treeView(skills.read()).tracks.find((t) => t.lang === "python")!.nodes.find((n) => n.name === "printing")!.trusted, false);
  assert.equal(goals.view(tree(evidence)(), zone).step, null);
});

test("skipping a whole goal trusts its path in prerequisite order; taking it back keeps the skills", () => {
  const { home, goals, evidence } = fresh();
  const zone = goal(["recursion"]);
  goals.skipGoal(zone, true, tree(evidence), trusting(evidence, zone));
  const skipped = goals.view(tree(evidence)(), zone);
  assert.deepEqual(skipped.progress, { done: 6, total: 6 });
  assert.equal(skipped.step, null);
  assert.ok(skipped.skippedAt);
  assert.ok(goalPath(zone).every((s) => skills.find(skills.read(), s.name, s.lang)?.how === "added"));
  goals.skipGoal(zone, false, tree(evidence), trusting(evidence, zone));
  const back = goals.view(tree(evidence)(), zone);
  assert.equal(back.skippedAt, null);
  assert.deepEqual(back.progress, { done: 6, total: 6 });
  assert.equal(readSteps(home, zone.id).goalSkippedAt, null);
});

test("play picks the next open skill, plays a chosen one, and stops once it's held", () => {
  const { home, goals, evidence } = fresh();
  const zone = goal(["variables"]);
  assert.deepEqual(nextSkill(tree(evidence)(), zone), { skill: py("printing"), zoneId: zone.id, why: "Its prerequisites are done and Python needs it." });
  earned("printing");
  earned("variables");
  const frontier = nextSkill(tree(evidence)(), zone)!;
  assert.equal(frontier.zoneId, null, "past the goal's path: the language's frontier");
  assert.equal(frontier.skill.lang, "python");
  assert.match(frontier.why, /next on your python/);

  for (const kind of ["align", "project"]) {
    const s = goals.view(tree(evidence)(), zone).step!;
    assert.equal(s.kind, kind);
    goals.skipStep(zone, s.id, false, tree(evidence), trusting(evidence, zone));
  }
  assert.equal(goals.view(tree(evidence)(), zone).step, null);
  assert.deepEqual(goals.play(tree(evidence)(), zone, null), frontier.skill);
  assert.deepEqual(goals.view(tree(evidence)(), zone).step!.skill, frontier.skill);

  goals.play(tree(evidence)(), zone, { name: "Lists", lang: "python" });
  const played = goals.view(tree(evidence)(), zone).step!;
  assert.deepEqual(played.skill, py("lists"));
  assert.equal(played.text, "Explain what lists is for, in your own words.");
  assert.throws(() => goals.play(tree(evidence)(), zone, py("printing")), /already yours/);

  earned("lists");
  assert.equal(goals.view(tree(evidence)(), zone).step, null);
  assert.equal(readSteps(home, zone.id).playing, null, "held, so it stopped being played");
});

test("the host's state carries every goal's step and the play pick; skips and play go through it", { timeout: 30_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dum-steps-host-")));
  const events: HostEvent[] = [];
  const listeners = new Set<() => void>();
  const epoch = randomUUID();
  const host = new DesktopController({
    epoch, backends: () => [],
    post: (e) => {
      events.push(HostEventSchema.parse(JSON.parse(JSON.stringify(e))));
      for (const l of listeners) l();
    },
  });
  type State = Extract<HostEvent, { type: "state" }>;
  /** The latest state once it matches; the test's own timeout bounds the wait. */
  const until = (pred: (s: State) => boolean) => new Promise<State>((resolve) => {
    const look = () => {
      const s = events.findLast((e): e is State => e.type === "state");
      if (s && pred(s)) {
        listeners.delete(look);
        resolve(s);
      }
    };
    listeners.add(look);
    look();
  });
  let n = 0;
  const call = (fields: object) => host.handle(HostRequestSchema.parse({ epoch, id: `r${++n}`, ...fields }));
  const main = {
    version: "0.0.0-test", platform: "linux", backends: [], screenPermission: "not-required", lookPaused: false,
    voice: { supported: false, available: false, bridge: false }, shortcuts: { open: null, voice: null, sendDraft: null },
  };
  await call({ op: "initialize", home, claudeExecutable: null, personal: { path: "", text: "", warning: "" }, settings: DEFAULT_PREFERENCES, main });
  try {
    const empty = await until(() => true);
    assert.deepEqual([empty.goals, empty.next], [[], null]);
    await assert.rejects(call({ op: "play", skill: null }), /Open a goal first/);

    const created = await call({ op: "zone-create", zone: { name: "Python", goal: "Write small programs", parentId: null, language: "python", focusSkills: [py("variables")] }, enter: true });
    const id = created!.zone!.id;
    const opened = await until((s) => s.activeZone?.id === id && s.goals.length === 1);
    const align = opened.goals[0]!.step!;
    assert.equal(align.kind, "align");
    assert.deepEqual(opened.goals[0]!.progress, { done: 0, total: 2 });
    assert.deepEqual(opened.next?.skill, py("printing"));

    await call({ op: "step-skip", zoneId: id, stepId: align.id, confirmed: false });
    const project = (await until((s) => s.goals[0]?.step?.kind === "project")).goals[0]!.step!;
    await assert.rejects(call({ op: "step-skip", zoneId: id, stepId: align.id, confirmed: false }), /That step changed/);
    await call({ op: "step-skip", zoneId: id, stepId: project.id, confirmed: false });
    await until((s) => s.goals[0]?.step?.kind === "recognize");

    await call({ op: "play", skill: { name: "lists", lang: "python" } });
    assert.deepEqual(readSteps(home, id).playing, py("lists"));
    // Lists is locked, so the step is the first open rung under it.
    assert.deepEqual((await until((s) => s.goals[0]?.step?.kind === "recognize")).goals[0]!.step!.skill, py("printing"));

    await call({ op: "goal-skip", zoneId: id, skip: true });
    const done = await until((s) => s.goals[0]?.skippedAt !== null);
    assert.deepEqual(done.goals[0]!.progress, { done: 2, total: 2 });
    assert.equal(done.goals[0]!.step, null);
    assert.equal(done.tree!.tracks.find((t) => t.lang === "python")!.nodes.find((x) => x.name === "printing")!.trusted, true);
  } finally {
    await call({ op: "close" });
  }
});

// Suggested projects: sized to a skill or the zone, carrying the zone and opted-in personal
// context, never unlocking anything by being suggested, and reviewed target by target in
// prerequisite order under the evidence rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Practice, active, checkedProject, parseSubmit, parseTarget, toProject, MAX_PROJECTS, type LearningTarget } from "../src/practice.ts";
import { Evidence } from "../src/evidence.ts";
import { Store, Cancelled } from "../src/store.ts";
import { createRegistry } from "../src/agent/registry.ts";
import * as skills from "../src/skills.ts";
import * as curriculum from "../src/curriculum.ts";
import * as memory from "../src/memory.ts";
import type { Context } from "../src/context.ts";
import type { Resources, SourceSnapshot } from "../src/share-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";
import type { Opts } from "../src/oneshot.ts";

process.env.DUM_CONTEXT = "off";

const BASICS = ["printing", "variables", "functions", "conditionals", "return values"];
const NONE: Context = { path: "", text: "", warning: "" };

/** Files shared with one request, by name under one grant. */
class Shared implements Resources {
  readonly grant = randomUUID();
  private readonly files = new Map<string, string>();
  add(name: string, text: string) {
    this.files.set(`${this.grant}/${name}`, text);
  }
  list() {
    return [...this.files.keys()];
  }
  async file(path: string): Promise<SourceSnapshot> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error("not shared");
    return { path, sourcePath: `/elsewhere/${path}`, text, sha: createHash("sha256").update(text).digest("hex"), complete: true };
  }
  async read(): Promise<never> {
    throw new Error("not used by practice");
  }
  async target(): Promise<never> {
    throw new Error("not used by practice");
  }
}

type Reply = (prompt: string) => string | Promise<string>;

function setup(built: string[], o: { reply?: Reply; audit?: Reply; zone?: Partial<ZoneContext>; personal?: Context } = {}) {
  const root = mkdtempSync(`${tmpdir()}/dum-practice-`);
  const home = `${root}/home`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.DUM_HOME = home;
  let t: skills.Tree = { skills: [] };
  for (const name of built) t = skills.unlock(t, { name, lang: "python", how: "added", level: "build", why: "" });
  if (t.skills.length) skills.write(t);
  const id = randomUUID();
  const zone: ZoneContext = {
    id, revision: 3, breadcrumb: [{ id, name: "Learning Go" }], goal: "Learn Go by building tools for my football group",
    ancestorGoals: [], language: "go", focusSkills: [], notes: [], ...o.zone,
  };
  const store = new Store({ id, name: "Learning Go" }, "understand");
  const evidence = new Evidence(home);
  const files = new Shared();
  const prompts: string[] = [];
  const calls: Opts[] = [];
  const binding = { zoneId: id, zoneEpoch: "epoch1", inputToken: "token1", requestId: "request1" };
  const reply = o.reply ?? (() => assert.fail("no model call expected"));
  const audit = o.audit ?? (() => assert.fail("no audit expected"));
  const practice = new Practice(zone, store, files, evidence, o.personal ?? NONE, createRegistry([], new Set()), binding, async (prompt, opts) => {
    prompts.push(prompt);
    calls.push(opts);
    return /^You check suggested projects/.test(prompt) ? audit(prompt) : reply(prompt);
  });
  const file = `${home}/zones/${id}/practice.json`;
  const saved = () => JSON.parse(readFileSync(file, "utf8"));
  return { home, zone, store, files, practice, prompts, calls, file, saved, done: () => rmSync(root, { recursive: true, force: true }) };
}

const level = (name: string, lang = "python") => skills.find(skills.read(), name, lang)?.level ?? null;

const project = (over: Record<string, unknown> = {}) => ({
  title: "pickup-match scheduler",
  task: "Build a scheduler that prints match rosters using named player variables.",
  done: "a useful roster is printed",
  uses: [],
  duration: { minHours: 20, maxHours: 40 },
  difficulty: "intermediate",
  fit: "Your zone goal is tools for your football group.",
  targets: [
    { skill: "variables", requires: ["printing"], milestone: "Represent named players in the roster.", done: "player variables meaningfully determine roster output" },
    { skill: "printing", requires: [], milestone: "Show the scheduled roster.", done: "the roster is printed from working code" },
  ],
  ...over,
});

function check(raw: { targets: LearningTarget[] }, n = 1, requires: string[] = []) {
  return { n, requires, targets: raw.targets.map((t) => ({ skill: t.skill, requires: t.requires })) };
}

const projects = (...list: unknown[]) => JSON.stringify({ projects: list });
const audits = (...list: unknown[]) => JSON.stringify({ projects: list });

test("practice and submit arguments parse predictably", () => {
  assert.deepEqual(parseTarget("for loops in py"), { skill: "for loops", lang: "python" });
  assert.deepEqual(parseSubmit("p3 src/walk.py --unaided"), { id: "p3", paths: ["src/walk.py"], unaided: true });
  assert.deepEqual(parseSubmit('--unaided P2 "my code/sort it.go" util.go'), { id: "p2", paths: ["my code/sort it.go", "util.go"], unaided: true });
  assert.equal(parseSubmit("recursion walk.py"), null, "only a saved project is submitted");
  assert.equal(parseSubmit("p1"), null, "a submission needs files");
  assert.equal(parseSubmit("--unaided"), null);
});

test("a skill request yields only projects that make that skill a learning target, sized to it, and unlocks nothing", async () => {
  const forLoops = project({ title: "roster rounds", targets: [
    { skill: "for loops", requires: ["conditionals"], milestone: "Go round the roster.", done: "a loop visits each player" },
    { skill: "conditionals", requires: ["variables"], milestone: "Skip injured players.", done: "a branch changes who plays" },
    ...project().targets,
  ] });
  const elsewhere = project({ title: "plain roster" });
  const s = setup(BASICS, { reply: () => projects(forLoops, elsewhere), audit: () => audits(check(forLoops)) });
  try {
    const out = await s.practice.suggest("for loops");
    assert.match(s.prompts[0]!, /SIZE EVERY PROJECT TO ONE SKILL: for loops/);
    assert.match(out, /^suggested projects for for loops \(go\) in go/);
    assert.match(out, /plain roster: it doesn't make for loops a learning target/);
    const saved = s.saved();
    assert.deepEqual(saved.projects.map((p: { id: string; title: string; focus: string }) => [p.id, p.title, p.focus]), [["p1", "roster rounds", "for loops"]]);
    assert.deepEqual(saved.projects[0].targets.map((t: { skill: string }) => t.skill), ["printing", "variables", "conditionals", "for loops"]);
    for (const name of ["for loops", "conditionals", "variables", "printing"]) assert.equal(level(name, "go"), null, "a suggestion never unlocks");
    assert.equal(curriculum.mapped("for loops", "go"), undefined);
    assert.match(s.calls[0]!.cwd, new RegExp(`/zones/${s.zone.id}/runtime$`));
    assert.equal(s.calls[0]!.zone, s.zone);
    assert.equal(s.calls[0]!.binding.requestId, "request1");
  } finally {
    s.done();
  }
});

test("a built skill gets no suggestion, and a request with no language asks for one", async () => {
  const built = setup(BASICS, { zone: { language: "python" } });
  try {
    assert.match(await built.practice.suggest("functions"), /^functions \(python\) is already built\. :projects new in python/);
  } finally {
    built.done();
  }
  const none = setup([], { zone: { language: "" } });
  try {
    assert.match(await none.practice.suggest("new"), /pick the language/);
    assert.match(await none.practice.suggest("match fairness"), /say which/);
  } finally {
    none.done();
  }
});

test("zone context, bounded memory and opted-in personal context reach the generator; opting out keeps personal context out", async () => {
  const personal = { path: "personal.md", text: "I organize a local football group.", warning: "" };
  const s = setup(BASICS, { reply: () => projects(project()), audit: () => audits(check(project())), personal,
    zone: { notes: [{ id: randomUUID(), name: "Learning Go", text: "weekly five-a-side, waiting lists" }] } });
  try {
    memory.remember(s.home, s.zone.id, "wants a waiting-list feature");
    s.store.restoreTranscript([{ kind: "user", id: 1, text: "I write Python at work and want to learn Go." }]);
    s.files.add("league/main.go", "package main\n");
    await s.practice.suggest("new");
    const generation = s.prompts[0]!;
    assert.match(generation, /ZONE BACKGROUND/);
    assert.match(generation, /tools for my football group/);
    assert.match(generation, /weekly five-a-side, waiting lists/);
    assert.match(generation, /wants a waiting-list feature/);
    assert.match(generation, /I write Python at work and want to learn Go/);
    assert.match(generation, /I organize a local football group/);
    assert.match(generation, /SHARED FILES: league\/main\.go/);
    assert.doesNotMatch(generation, new RegExp(s.files.grant), "grant IDs stay out of prompts");
    assert.match(generation, /"lang":"python","level":"build"/);
    assert.doesNotMatch(s.prompts[1]!, /football group/, "the audit judges the projects, not their background");
  } finally {
    s.done();
  }
  const out = setup(BASICS, { reply: () => projects(project()), audit: () => audits(check(project())) });
  try {
    await out.practice.suggest("new");
    assert.doesNotMatch(out.prompts[0]!, /PERSONAL BACKGROUND/);
  } finally {
    out.done();
  }
});

test("suggested projects are ordered by size then difficulty and none of them grants credit", async () => {
  const larger = project({ title: "season scheduler", duration: { minHours: 100, maxHours: 180 }, difficulty: "advanced",
    task: "Manage a season's pickup rosters with eligibility conditions and lists of players, showing match assignments.",
    targets: [
      { skill: "range", requires: ["slices"], milestone: "Show each roster assignment.", done: "range meaningfully visits the roster" },
      { skill: "slices", requires: ["for loops"], milestone: "Keep rosters and waiting players together.", done: "slices hold real roster values" },
      { skill: "for loops", requires: ["conditionals"], milestone: "Build the match rosters.", done: "a bounded loop handles players" },
      { skill: "conditionals", requires: ["variables"], milestone: "Decide player eligibility.", done: "eligibility branches affect assignments" },
      ...project().targets,
    ],
  });
  const harder = project({ title: "league scheduler", difficulty: "advanced" });
  const smaller = project();
  const s = setup(BASICS, { reply: () => projects(larger, harder, smaller), audit: () => audits(check(larger, 1), check(harder, 2), check(smaller, 3)) });
  try {
    const out = await s.practice.suggest("new in go");
    assert.deepEqual(s.saved().projects.map((p: { title: string }) => p.title), ["pickup-match scheduler", "league scheduler", "season scheduler"]);
    assert.deepEqual(s.saved().projects[2].targets.map((t: { skill: string }) => t.skill), ["printing", "variables", "conditionals", "for loops", "slices", "range"]);
    assert.match(out, /20-40 active hours · difficulty: intermediate/);
    assert.match(out, /why it fits: .*football group/);
    assert.match(await s.practice.suggest("p1"), /1\. printing:[\s\S]*2\. variables:/);
    assert.match(s.practice.describe(), /p1  ○ pickup-match scheduler \(go\) - printing, variables/);
    assert.equal(level("printing", "go"), null);
    assert.equal(level("variables"), "build", "other languages are untouched");
    assert.equal(s.saved().projects[0].state, "open");
  } finally {
    s.done();
  }
});

test("project coverage rejects undeclared implied skills, target prerequisites, cycles and foreign-language assumptions", () => {
  const empty = () => false;
  const p = toProject(project(), "go", empty)!;
  assert.ok(p);
  assert.equal(toProject(project({ targets: [project().targets[0]] }), "go", empty), null, "printing prerequisite is not grandfathered");
  assert.equal(toProject(project({ uses: ["functions"] }), "go", empty), null, "Python functions don't establish Go functions");
  assert.equal(checkedProject(check(project(), 1, ["input"]), p, empty), null, "undeclared input is an uncovered learning goal");
  const prerequisite = check(project());
  prerequisite.targets[0]!.requires.push("strings");
  assert.equal(checkedProject(prerequisite, p, empty), null, "audited target prerequisites must be covered too");
  assert.equal(checkedProject({ n: 1, requires: [], targets: [] }, p, empty), null, "all target prerequisites must be audited");
  const cyclic = project({ targets: [
    { skill: "one", requires: ["two"], milestone: "one", done: "one works" },
    { skill: "two", requires: ["one"], milestone: "two", done: "two works" },
  ] });
  assert.equal(toProject(cyclic, "go", empty), null);
  const unfamiliar = project({ targets: [
    { skill: "match fairness", requires: ["variables"], milestone: "Compare roster fairness.", done: "fairness is calculated meaningfully" },
    ...project().targets,
  ] });
  const unknown = toProject(unfamiliar, "go", empty)!;
  assert.deepEqual(unknown.targets.map((t) => t.skill), ["printing", "variables", "match fairness"]);
  assert.ok(checkedProject(check(unfamiliar), unknown, empty));
  assert.equal(curriculum.mapped("match fairness", "go"), undefined, "suggestions don't establish off-track prerequisites or ability");
});

test("an audited missing requirement becomes an explicit learning milestone, never assumed ability", async () => {
  const goal = { skill: "arithmetic", requires: ["variables"], milestone: "Calculate remaining roster places.",
    done: "the number of open places changes correctly as players join" };
  const audited = { ...check(project(), 1, ["arithmetic"]), targets: [...check(project()).targets, goal] };
  const s = setup([], { reply: () => projects(project({ task: "Show a pickup roster and calculate its remaining places." })), audit: () => audits(audited) });
  try {
    await s.practice.suggest("new");
    const targets = s.saved().projects[0].targets;
    assert.deepEqual(targets.map((t: { skill: string }) => t.skill), ["printing", "variables", "arithmetic"]);
    assert.equal(targets[2].milestone, goal.milestone);
    assert.equal(level("arithmetic", "go"), null);
    const offered = toProject(project(), "go", () => false)!;
    assert.equal(checkedProject({ ...audited, requires: [] }, offered, () => false), null, "an unrelated additional goal is refused");
    assert.equal(checkedProject({ ...audited, targets: [...check(project()).targets, { ...goal, done: "" }] }, offered, () => false), null,
      "an additional required goal needs its own passing-evidence criterion");
  } finally {
    s.done();
  }
});

test("when the check clears no project, or can't be read, nothing is offered or saved", async () => {
  const uncovered = setup([], { reply: () => projects(project()), audit: () => audits(check(project(), 1, ["input"])) });
  try {
    const out = await uncovered.practice.suggest("new");
    assert.match(out, /nothing saved/);
    assert.equal(existsSync(uncovered.file), false);
  } finally {
    uncovered.done();
  }
  for (const reply of ["no idea", audits(check(project(), 2))]) {
    const unread = setup([], { reply: () => projects(project()), audit: () => reply });
    try {
      const out = await unread.practice.suggest("new").catch((err: Error) => err.message);
      assert.match(out, /nothing saved/);
      assert.equal(existsSync(unread.file), false);
    } finally {
      unread.done();
    }
  }
});

test("a skill taken back while the model works isn't leaned on by anything saved", async () => {
  const uses = project({ title: "loop roster", uses: ["for loops"], targets: [
    { skill: "printing", requires: [], milestone: "Show the roster.", done: "the roster prints" },
  ] });
  const open = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const s = setup([], { reply: () => projects(uses), audit: async () => (waiting.resolve(), await open.promise, audits(check(uses))) });
  try {
    for (const name of ["printing", "variables", "conditionals", "for loops"]) {
      skills.write(skills.unlock(skills.read(), { name, lang: "go", how: "added", level: "build", why: "" }));
    }
    const pending = s.practice.suggest("new");
    await waiting.promise;
    skills.remove("conditionals", "go");
    open.resolve();
    assert.match(await pending, /no suggested projects cleared the independent check - nothing saved/);
    assert.equal(existsSync(s.file), false);
  } finally {
    s.done();
  }
});

test("a broken practice file is reported, not replaced, and keeps the Wizard quiet", async () => {
  const s = setup(BASICS);
  try {
    mkdirSync(`${s.home}/zones/${s.zone.id}`, { recursive: true });
    writeFileSync(s.file, "{nope");
    await assert.rejects(s.practice.suggest("new"), /isn't valid JSON/);
    assert.equal(readFileSync(s.file, "utf8"), "{nope");
    assert.equal(active(s.home, s.zone.id), true);
  } finally {
    s.done();
  }
});

test("starting a project marks it as being built until it's stopped or every target passes", async () => {
  const s = setup(BASICS, { reply: (prompt) => prompt.startsWith("You review")
    ? JSON.stringify({ targets: ["variables", "printing"].map((skill) => ({ skill, passed: true, feedback: `${skill} drives real roster output` })) })
    : projects(project()), audit: () => audits(check(project())) });
  try {
    await s.practice.suggest("new");
    assert.equal(active(s.home, s.zone.id), false, "a suggestion alone isn't being built");
    assert.match(await s.practice.suggest("start p9"), /no saved project p9/);
    assert.match(await s.practice.suggest("start p1"), /^building p1/);
    assert.equal(active(s.home, s.zone.id), true);
    assert.match(s.practice.describe(), /p1  ▶ .*building now/);
    assert.match(await s.practice.suggest("stop"), /stopped building p1/);
    assert.equal(active(s.home, s.zone.id), false);
    assert.match(await s.practice.suggest("stop"), /aren't building/);
    await s.practice.suggest("start p1");
    s.files.add("main.go", 'package main\nimport "fmt"\nfunc main() { player := "Ada"; fmt.Println(player) }\n');
    assert.match(await s.practice.submit("p1 main.go --unaided"), /2\/2 targets passed review; 2 recorded/);
    assert.equal(s.saved().projects[0].state, "passed");
    assert.equal(active(s.home, s.zone.id), false, "a finished project isn't being built");
    assert.match(await s.practice.suggest("start p1"), /already built/);
  } finally {
    s.done();
  }
});

test("project submission awards only individually passing unaided targets in prerequisite order and can finish later", async () => {
  let passes: Record<string, boolean> = { printing: true, variables: false };
  const s = setup(BASICS, { reply: (prompt) => prompt.startsWith("You review")
    ? JSON.stringify({ targets: ["variables", "printing"].map((skill) => ({ skill, passed: passes[skill], feedback: passes[skill] ? `${skill} drives real roster output` : "where are the player values stored?" })) })
    : projects(project()), audit: () => audits(check(project())) });
  try {
    await s.practice.suggest("new");
    s.files.add("league/main.go", 'package main\nimport "fmt"\nfunc main() { player := "Ada"; fmt.Println(player) }\n');
    assert.match(await s.practice.submit("p1 main.go"), /0 recorded/);
    assert.equal(level("printing", "go"), null);
    const partial = await s.practice.submit("p1 main.go --unaided");
    assert.match(partial, /1\/2 targets passed review; 1 recorded/);
    assert.equal(level("printing", "go"), "build");
    assert.equal(level("variables", "go"), null);
    assert.equal(s.saved().projects[0].state, "open");
    assert.deepEqual(s.saved().projects[0].submissions.at(-1).targets.map((t: { skill: string; built: boolean }) => [t.skill, t.built]), [["printing", true], ["variables", false]]);
    assert.match(await s.practice.suggest("p1"), /last review · variables: not yet/);
    passes = { printing: true, variables: true };
    assert.match(await s.practice.submit(`p1 ${s.files.grant}/league/main.go --unaided`), /2\/2 targets passed review; 2 recorded/);
    assert.equal(level("variables", "go"), "build");
    assert.equal(s.saved().projects[0].state, "passed");
    assert.equal(level("functions", "go"), null, "no blanket advancement");
    assert.equal(level("functions"), "build", "other languages remain unchanged");
  } finally {
    s.done();
  }
});

test("a failed project prerequisite blocks a higher passing target and malformed reviews record nothing", async () => {
  let response: unknown = { targets: [
    { skill: "printing", passed: false, feedback: "where is the roster shown?" },
    { skill: "variables", passed: true, feedback: "named player variables drive the roster" },
  ] };
  const s = setup([], { reply: (prompt) => prompt.startsWith("You review") ? JSON.stringify(response) : projects(project()), audit: () => audits(check(project())) });
  try {
    await s.practice.suggest("new");
    s.files.add("main.go", "package main\nfunc main() {}\n");
    assert.match(await s.practice.submit("p1 main.go --unaided"), /variables:[\s\S]*not recorded: prerequisites not built: printing/);
    assert.equal(level("printing", "go"), null);
    assert.equal(level("variables", "go"), null);
    const before = s.saved().projects[0].submissions.length;
    response = { targets: [{ skill: "printing", passed: true, feedback: "roster output works" }] };
    await assert.rejects(s.practice.submit("p1 main.go --unaided"), /nothing recorded/);
    assert.equal(s.saved().projects[0].submissions.length, before);
    response = { targets: [
      { skill: "printing", passed: true, feedback: "roster output works" },
      { skill: "printing", passed: true, feedback: "roster output works" },
    ] };
    await assert.rejects(s.practice.submit("p1 main.go --unaided"), /nothing recorded/);
    assert.equal(level("printing", "go"), null);
  } finally {
    s.done();
  }
});

test("project review does not grandfather a named prerequisite that fails its own review", async () => {
  const s = setup([], { reply: (prompt) => prompt.startsWith("You review")
    ? JSON.stringify({ targets: [
      { skill: "printing", passed: false, feedback: "where is the actual roster printed?" },
      { skill: "variables", passed: true, feedback: "player variables drive real assignments" },
    ] }) : projects(project()), audit: () => audits(check(project())) });
  try {
    await s.practice.suggest("new");
    skills.write(skills.unlock(skills.read(), { name: "printing", lang: "go", how: "typed", level: "build", why: "earlier project" }));
    s.files.add("main.go", "package main\nfunc main() { player := 1; _ = player }\n");
    assert.match(await s.practice.submit("p1 main.go --unaided"), /not recorded: prerequisites not built: printing/);
    assert.equal(level("variables", "go"), null);
    assert.equal(level("printing", "go"), "build", "a failed review doesn't revoke earlier evidence");
  } finally {
    s.done();
  }
});

test("an unfamiliar learning goal stays a goal until its own passing unaided review", async () => {
  const unfamiliar = project({ targets: [
    { skill: "match fairness", requires: ["variables"], milestone: "Compare roster fairness.", done: "fairness is calculated meaningfully" },
    ...project().targets,
  ] });
  const s = setup([], { reply: (prompt) => prompt.startsWith("You review")
    ? JSON.stringify({ targets: unfamiliar.targets.map((t) => ({ skill: t.skill, passed: true, feedback: `${t.skill} is demonstrated in roster calculations` })) })
    : projects(unfamiliar), audit: () => audits(check(unfamiliar)) });
  try {
    await s.practice.suggest("new");
    assert.equal(curriculum.mapped("match fairness", "go"), undefined);
    assert.equal(level("match fairness", "go"), null);
    s.files.add("main.go", 'package main\nimport "fmt"\nfunc main() { fairness := 2; fmt.Println(fairness) }\n');
    await s.practice.submit("p1 main.go --unaided");
    assert.equal(level("match fairness", "go"), "build");
    assert.deepEqual(curriculum.mapped("match fairness", "go"), ["variables"]);
    assert.equal(level("match fairness"), null);
  } finally {
    s.done();
  }
});

test("a submission names only shared files of the project's language, within the review bounds", async () => {
  const s = setup([], { reply: () => projects(project()), audit: () => audits(check(project())) });
  try {
    await s.practice.suggest("new");
    assert.match(await s.practice.submit("p9 main.go"), /no saved project p9/);
    assert.match(await s.practice.submit("p1 main.go"), /main\.go isn't a file you've shared/);
    s.files.add("a/main.go", "package main\n");
    s.files.add("b/main.go", "package main\n");
    assert.match(await s.practice.submit("p1 main.go"), /names more than one shared file/);
    s.files.add("notes.py", "print(1)\n");
    assert.match(await s.practice.submit("p1 notes.py"), /none of those files is go/);
    assert.match(await s.practice.submit("p1 a.go b.go c.go d.go e.go"), /at most 4 files/);
    s.files.add("big.go", "x".repeat(97 * 1024));
    assert.match(await s.practice.submit("p1 big.go"), /at most 96 KiB/);
    assert.equal(s.saved().projects[0].submissions.length, 0);
  } finally {
    s.done();
  }
});

test("saved projects stay bounded and the one being built is kept", async () => {
  const large = project({ targets: Array.from({ length: 40 }, (_, i) => ({
    skill: `goal ${i}`, requires: [], milestone: "m".repeat(600), done: "d".repeat(600),
  })) });
  let count = 0;
  const s = setup([], { reply: () => projects({ ...large, title: `large project ${++count}` }), audit: () => audits(check(large)) });
  try {
    await s.practice.suggest("new");
    await s.practice.suggest("start p1");
    for (let i = 0; i < 11; i++) await s.practice.suggest("new");
    assert.ok(Buffer.byteLength(readFileSync(s.file, "utf8")) <= 512 * 1024);
    assert.ok(s.saved().projects.length < 12, "old projects are evicted before the file becomes unreadable");
    assert.ok(s.saved().projects.length <= MAX_PROJECTS);
    assert.equal(s.saved().projects[0].id, "p1", "the project being built is never evicted");
    assert.match(await s.practice.suggest("p12"), /large project 12/);
  } finally {
    s.done();
  }
});

test("generation or review that returns after Stop or close records and saves nothing", async () => {
  const review = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const a = setup([], { reply: (prompt) => {
    if (!prompt.startsWith("You review")) return projects(project());
    started.resolve();
    return review.promise;
  }, audit: () => audits(check(project())) });
  try {
    await a.practice.suggest("new");
    a.files.add("main.go", 'package main\nimport "fmt"\nfunc main() { player := "Ada"; fmt.Println(player) }\n');
    const pending = a.practice.submit("p1 main.go --unaided");
    await started.promise;
    a.store.cancel();
    review.resolve(JSON.stringify({ targets: project().targets.map((t) => ({ skill: t.skill, passed: true, feedback: `${t.skill} drives roster output` })) }));
    await assert.rejects(pending, Cancelled);
    assert.equal(level("printing", "go"), null);
    assert.equal(level("variables", "go"), null);
    assert.equal(a.saved().projects[0].submissions.length, 0);
    await a.store.settled();
  } finally {
    a.done();
  }

  const generation = Promise.withResolvers<string>();
  const asked = Promise.withResolvers<void>();
  const b = setup([], { reply: () => (asked.resolve(), generation.promise) });
  try {
    const suggesting = b.practice.suggest("new");
    await asked.promise;
    b.store.close();
    generation.resolve(projects(project()));
    await assert.rejects(suggesting, (err) => err instanceof Cancelled && err.final);
    assert.equal(existsSync(b.file), false);
    await b.store.settled();
  } finally {
    b.done();
  }
});

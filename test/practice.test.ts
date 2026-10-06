// Optional practice: only open next steps, only built skills leaned on, nothing unlocked by being
// suggested, and a submission that builds only under the evidence rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Practice, parseSubmit, parseTarget, toTask, toProject, checkedProject, MAX_TASKS, type ProjectPlan } from "../src/practice.ts";
import { Evidence } from "../src/evidence.ts";
import { Workspace } from "../src/workspace.ts";
import * as skills from "../src/skills.ts";
import { Store, Cancelled } from "../src/store.ts";
import * as curriculum from "../src/curriculum.ts";

const BASICS = ["printing", "variables", "functions", "conditionals", "return values"];

/** Nothing found beyond what each task declared: the separate check's quietest answer. */
const CLEAR = JSON.stringify({ tasks: [1, 2, 3, 4].map((n) => ({ n, requires: [] })) });

function setup(built: string[], reply: (prompt: string) => string | Promise<string> = () => assert.fail("no model call expected"), audit: () => string | Promise<string> = () => CLEAR) {
  const root = mkdtempSync(`${tmpdir()}/dum-practice-`);
  process.env.DUM_HOME = `${root}/home`;
  let t: skills.Tree = { skills: [] };
  for (const name of built) t = skills.unlock(t, { name, lang: "python", how: "added", level: "build", why: "" });
  if (t.skills.length) skills.write(t);
  const store = new Store("r", "understand", root);
  const evidence = new Evidence(root, store);
  const prompts: string[] = [];
  const practice = new Practice(root, store, new Workspace(root), evidence, undefined, async (prompt) => {
    prompts.push(prompt);
    return /^You check practice tasks/.test(prompt) ? audit() : reply(prompt);
  });
  const saved = () => JSON.parse(readFileSync(`${root}/.dum/practice.json`, "utf8"));
  return { root, store, practice, prompts, saved, done: () => rmSync(root, { recursive: true, force: true }) };
}

const level = (name: string) => skills.find(skills.read(), name, "python")?.level ?? null;
const task = (over: Record<string, unknown> = {}) => ({
  shape: "implement",
  title: "count down",
  task: "Write countdown(n) that returns the numbers from n down to 1 without a loop.",
  uses: ["functions", "conditionals"],
  done: "it stops at 1 and never loops forever",
  ...over,
});

test("practice and submit arguments parse predictably", () => {
  assert.deepEqual(parseTarget("for loops in py"), { skill: "for loops", lang: "python" });
  assert.deepEqual(parseSubmit("p3 src/walk.py --unaided"), { target: "p3", lang: "", paths: ["src/walk.py"], unaided: true });
  assert.deepEqual(parseSubmit("--unaided recursion in python walk.py lib/util.py"), {
    target: "recursion",
    lang: "python",
    paths: ["walk.py", "lib/util.py"],
    unaided: true,
  });
  assert.deepEqual(parseSubmit('sorting with keys "my code/sort it.py"'), { target: "sorting with keys", lang: "", paths: ["my code/sort it.py"], unaided: false });
  assert.deepEqual(parseSubmit("recursion Makefile"), { target: "recursion", lang: "", paths: ["Makefile"], unaided: false }, "the last token is always a path");
  assert.equal(parseSubmit("walk.py"), null, "a path needs a skill or task to count for");
  assert.equal(parseSubmit("--unaided"), null);
});

test("a generated task may lean only on built skills; the target itself is exempt", () => {
  const built = (n: string) => ["functions", "conditionals"].includes(n);
  const target = { skill: "recursion", lang: "python", exercise: "python" };
  const ok = toTask(task({ uses: ["Functions", "recursion", "conditionals"] }), target, built)!;
  assert.deepEqual(ok.uses, ["functions", "conditionals"]);
  assert.equal(toTask(task({ uses: ["functions", "classes"] }), target, built), null, "classes isn't built");
  assert.equal(toTask(task({ shape: "quiz" }), target, built), null);
  assert.equal(toTask(task({ task: "  " }), target, built), null);
  assert.deepEqual(toTask(task({ uses: "Functions, conditionals," }), target, built)!.uses, ["functions", "conditionals"], "a list written out is the same list");
  assert.equal(toTask(task({ uses: "functions, classes" }), target, built), null, "and is checked the same");
  assert.equal(toTask(task({ uses: [7] }), target, built), null);
});

test("suggestions keep only valid tasks, persist them, and unlock nothing", async () => {
  const { practice, saved, done } = setup(BASICS, () =>
    JSON.stringify({ tasks: [task(), task({ title: "class tree", uses: ["classes"] }), task({ shape: "project", title: "folder sizes", uses: ["functions"] })] }),
  );
  try {
    const out = await practice.suggest("recursion in python");
    assert.match(out, /p1  implement: count down/);
    assert.doesNotMatch(out, /class tree/);
    const s = saved();
    assert.deepEqual(s.tasks.map((t: { id: string; skill: string; state: string }) => [t.id, t.skill, t.state]), [["p1", "recursion", "open"], ["p2", "recursion", "open"]]);
    assert.equal(s.next, 3);
    assert.equal(level("recursion"), null, "a suggestion never unlocks");
    assert.match(await practice.suggest("p2"), /folder sizes/);
  } finally {
    done();
  }
});

test("a locked skill's practice starts at the lowest open rung", async () => {
  const { practice, saved, done } = setup(["printing"], () => JSON.stringify({ tasks: [task({ uses: ["printing"] })] }));
  try {
    const out = await practice.suggest("recursion in python");
    assert.match(out, /^recursion \(python\) builds on return values, conditionals, which you haven't built yet\. Practice starts at variables\./);
    assert.equal(saved().tasks[0].skill, "variables");
  } finally {
    done();
  }
});

test("a built skill gets no generated practice, and a generator that only assumes locked skills saves nothing", async () => {
  const built = setup(BASICS);
  try {
    assert.match(await built.practice.suggest("functions in python"), /^functions \(python\) is already built\./);
  } finally {
    built.done();
  }
  const bad = setup(BASICS, () => JSON.stringify({ tasks: [task({ uses: ["classes"] }), task({ uses: ["decorators"] })] }));
  try {
    await assert.rejects(bad.practice.suggest("recursion in python"), /leaned on skills you haven't built/);
    assert.equal(bad.practice.describe(), "no practice tasks saved. :practice <skill> makes some.");
  } finally {
    bad.done();
  }
});

test("what a separate check finds a task needs decides, not what it declared; the target itself is fine", async () => {
  const generated = JSON.stringify({
    tasks: [
      task({ title: "divide safely", uses: ["conditionals"] }),
      task({ title: "parse an amount", uses: ["functions"] }),
      task({ title: "menu until quit", uses: ["conditionals"] }),
    ],
  });
  const audit = JSON.stringify({
    tasks: [
      { n: 1, requires: ["input", "exceptions", "conditionals"] },
      { n: 2, requires: ["Exceptions", "functions", "return values"] },
      { n: 3, requires: ["while loops", "input", "exceptions"] },
    ],
  });
  const { practice, saved, done } = setup(BASICS, () => generated, () => audit);
  try {
    const out = await practice.suggest("exceptions in python");
    assert.match(out, /p1  implement: parse an amount\n[\s\S]*uses what you've built: functions, return values/);
    assert.match(out, /divide safely: it needs input, which you haven't built yet/);
    assert.match(out, /menu until quit: it needs while loops, input, which you haven't built yet/);
    assert.deepEqual(saved().tasks.map((t: { title: string; uses: string[] }) => [t.title, t.uses]), [["parse an amount", ["functions", "return values"]]]);
  } finally {
    done();
  }
});

test("when the check clears no task, or can't be read, nothing is offered or saved", async () => {
  // recursion's note stands on return values, which isn't on the tree: built on paper, not today.
  const generated = JSON.stringify({ tasks: [task({ title: "walk the folders", uses: ["functions"] })] });
  const locked = setup(["printing", "variables", "functions", "conditionals", "recursion"], () => generated, () => JSON.stringify({ tasks: [{ n: 1, requires: ["exceptions", "recursion"] }] }));
  try {
    const out = await locked.practice.suggest("exceptions in python");
    assert.match(out, /nothing saved/);
    assert.match(out, /walk the folders: it needs recursion, which you haven't built yet/);
    assert.doesNotMatch(out, /:submit p1/);
    assert.equal(existsSync(`${locked.root}/.dum/practice.json`), false);
  } finally {
    locked.done();
  }
  for (const reply of ["no idea", JSON.stringify({ tasks: [{ n: 2, requires: [] }] })]) {
    const unread = setup(BASICS, () => generated, () => reply);
    try {
      const out = await unread.practice.suggest("exceptions in python").catch((err: Error) => err.message);
      assert.match(out, /nothing saved/);
      assert.equal(existsSync(`${unread.root}/.dum/practice.json`), false);
    } finally {
      unread.done();
    }
  }
});

test("a skill taken off the tree while dum waits on the model isn't leaned on by anything saved", async () => {
  const generated = JSON.stringify({ tasks: [task({ title: "tally rows", uses: ["for loops"] }), task({ title: "parse an amount", uses: ["functions"] })] });
  /** A model call that holds until the test lets it answer: another terminal edits the tree meanwhile. */
  const held = (answer: string) => {
    let release!: () => void;
    let asked!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const waiting = new Promise<void>((r) => (asked = r));
    return { release, waiting, call: async () => (asked(), await open, answer) };
  };

  // During the check, lists is taken back: for loops stands on it, though the check didn't name it.
  const check = held(JSON.stringify({ tasks: [{ n: 1, requires: ["exceptions"] }, { n: 2, requires: ["functions"] }] }));
  const during = setup([...BASICS, "lists", "for loops"], () => generated, check.call);
  try {
    const pending = during.practice.suggest("exceptions in python");
    await check.waiting;
    skills.remove("lists", "python");
    check.release();
    const out = await pending;
    assert.match(out, /tally rows: it needs for loops, which you haven't built yet/);
    assert.deepEqual(during.saved().tasks.map((t: { title: string }) => t.title), ["parse an amount"]);
  } finally {
    during.done();
  }

  // During generation, the target's own prerequisite is taken back: nothing for it is open now.
  const gen = held(generated);
  const before = setup([...BASICS, "lists", "for loops"], gen.call);
  try {
    const pending = before.practice.suggest("exceptions in python");
    await gen.waiting;
    skills.remove("functions", "python");
    gen.release();
    assert.match(await pending, /^exceptions \(python\) builds on functions, which you haven't built yet/);
    assert.equal(existsSync(`${before.root}/.dum/practice.json`), false);
  } finally {
    before.done();
  }
});

test("a built note whose prerequisite was taken off isn't offered to or leaned on by generated practice", async () => {
  const { practice, prompts, saved, done } = setup(["printing", "variables", "functions", "conditionals", "recursion"], () =>
    JSON.stringify({ tasks: [task({ title: "walk down", uses: ["recursion"] }), task({ title: "add up", uses: ["functions"] })] }),
  );
  try {
    await practice.suggest("return values in python");
    const built = /SKILLS THEY HAVE BUILT IN PYTHON[^\n]*\n([^\n]*)/.exec(prompts[0]!)![1]!;
    assert.match(built, /functions/);
    assert.doesNotMatch(built, /recursion/, "recursion builds on return values, which isn't on the tree");
    assert.deepEqual(saved().tasks.map((t: { title: string }) => t.title), ["add up"]);
  } finally {
    done();
  }
});

test("saved practice stays bounded", async () => {
  const { practice, saved, done } = setup(BASICS, () => JSON.stringify({ tasks: [1, 2, 3, 4].map((i) => task({ title: `t${i}` })) }));
  try {
    for (let i = 0; i < 11; i++) await practice.suggest("recursion in python");
    const s = saved();
    assert.equal(s.tasks.length, MAX_TASKS);
    assert.equal(s.tasks[0].id, "p5", "the oldest go first");
    assert.equal(s.next, 45);
  } finally {
    done();
  }
});

test("a broken practice file is reported, not replaced", async () => {
  const { practice, root, done } = setup(BASICS);
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    writeFileSync(`${root}/.dum/practice.json`, "{nope");
    await assert.rejects(practice.suggest("recursion in python"), /isn't valid JSON/);
    assert.equal(readFileSync(`${root}/.dum/practice.json`, "utf8"), "{nope");
  } finally {
    done();
  }
});

test("a submission without the unaided self-report is reviewed but never builds", async () => {
  const { practice, root, saved, done } = setup(BASICS, (prompt) =>
    prompt.includes("practice submission") ? JSON.stringify({ passed: true, feedback: "base case and the step are both there" }) : JSON.stringify({ tasks: [task()] }),
  );
  try {
    await practice.suggest("recursion in python");
    writeFileSync(`${root}/walk.py`, "def countdown(n):\n    return [] if n == 0 else [n] + countdown(n - 1)\n");
    const out = await practice.submit("p1 walk.py");
    assert.match(out, /^✓ base case/);
    assert.match(out, /not recorded: .*without AI help/);
    assert.match(out, /--unaided/);
    assert.equal(level("recursion"), null);
    const t = saved().tasks[0];
    assert.equal(t.state, "open");
    assert.equal(t.submissions[0].unaided, false);

    const built = await practice.submit("p1 walk.py --unaided");
    assert.match(built, /recorded: recorded build/);
    assert.equal(level("recursion"), "build");
    assert.equal(saved().tasks[0].state, "passed");
  } finally {
    done();
  }
});

test("a failing review or an unreadable one records nothing", async () => {
  let verdict = JSON.stringify({ passed: false, feedback: "what happens when n is 0?" });
  const { practice, root, done } = setup(BASICS, () => verdict);
  try {
    writeFileSync(`${root}/walk.py`, "def countdown(n):\n    return countdown(n - 1)\n");
    assert.match(await practice.submit("recursion in python walk.py --unaided"), /^✗ what happens when n is 0\?\nnot recorded/);
    verdict = "I think it's fine";
    await assert.rejects(practice.submit("recursion in python walk.py --unaided"), /couldn't be read - nothing recorded/);
    assert.equal(level("recursion"), null);
  } finally {
    done();
  }
});

test("a submission for a locked skill, an unknown task or a missing file is refused before any review", async () => {
  const { practice, root, done } = setup(["printing"]);
  try {
    writeFileSync(`${root}/walk.py`, "print('hi')\n");
    assert.match(await practice.submit("recursion in python walk.py --unaided"), /builds on return values, conditionals/);
    assert.match(await practice.submit("p9 walk.py"), /no saved task p9/);
    assert.match(await practice.submit("variables in python gone.py --unaided"), /couldn't read gone\.py/);
    writeFileSync(`${root}/walk.js`, "console.log(1)\n");
    assert.match(await practice.submit("variables in python walk.js --unaided"), /none of those files is python/);
  } finally {
    done();
  }
});

test("a review or generation that returns after Stop or close records and saves nothing", async () => {
  const late = (answer: string) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    return { call: () => (started.resolve(), promise), started: started.promise, finish: () => resolve(answer) };
  };

  // Stop: the reviewer's pass comes back anyway, after the person pressed Stop.
  const review = late(JSON.stringify({ passed: true, feedback: "base case and the step are both there" }));
  const a = setup(BASICS, review.call);
  try {
    writeFileSync(`${a.root}/walk.py`, "def countdown(n):\n    return [] if n == 0 else [n] + countdown(n - 1)\n");
    const submitting = a.practice.submit("recursion in python walk.py --unaided");
    await review.started;
    a.store.cancel();
    review.finish();
    await assert.rejects(submitting, Cancelled);
    assert.equal(level("recursion"), null, "a stopped review builds nothing, even one that passed");
    await a.store.settled();
  } finally {
    a.done();
  }

  // Close: generated tasks that arrive after the project closed are not saved.
  const generate = late(JSON.stringify({ tasks: [task()] }));
  const b = setup(BASICS, generate.call);
  try {
    const suggesting = b.practice.suggest("recursion in python");
    await generate.started;
    b.store.close();
    generate.finish();
    await assert.rejects(suggesting, (err) => err instanceof Cancelled && err.final);
    assert.equal(existsSync(`${b.root}/.dum/practice.json`), false);
    await b.store.settled();
  } finally {
    b.done();
  }
});

const project = (over: Record<string, unknown> = {}) => ({
  title: "pickup-match scheduler",
  task: "Build a scheduler that prints match rosters using named player variables.",
  done: "a useful roster is printed",
  uses: [],
  duration: { minHours: 20, maxHours: 40 },
  difficulty: "intermediate",
  fit: "Your project notes mention pickup-match scheduling and waiting lists.",
  targets: [
    { skill: "variables", requires: ["printing"], milestone: "Represent named players in the roster.", done: "player variables meaningfully determine roster output" },
    { skill: "printing", requires: [], milestone: "Show the scheduled roster.", done: "the roster is printed from working code" },
  ],
  ...over,
});

function projectCheck(raw: Pick<ProjectPlan, "targets">, n = 1, requires: string[] = []) {
  return { n, requires, targets: raw.targets.map((t) => ({ skill: t.skill, requires: t.requires })) };
}

test("project recommendations include multiple new-language levels, stable size order, context and no credit", async () => {
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
  const { root, store, practice, saved, done } = setup(BASICS, () => JSON.stringify({ tasks: [larger, harder, smaller] }),
    () => JSON.stringify({ tasks: [projectCheck(larger, 1), projectCheck(harder, 2), projectCheck(smaller, 3)] }));
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    writeFileSync(`${root}/.dum/memory.md`, "I'm an experienced Python programmer. I want pickup-match scheduling with waiting lists.");
    store.restoreTranscript([{ kind: "user", id: 1, text: "I want to learn Go with one connected project." }]);
    const out = await practice.suggest("projects in go");
    assert.deepEqual(saved().tasks.map((t: { title: string }) => t.title), ["pickup-match scheduler", "league scheduler", "season scheduler"]);
    const plan = saved().tasks[0].project;
    assert.deepEqual(plan.targets.map((t: { skill: string }) => t.skill), ["printing", "variables"]);
    assert.deepEqual(plan.targets[1].requires, ["printing"]);
    assert.deepEqual(saved().tasks[2].project.targets.map((t: { skill: string }) => t.skill),
      ["printing", "variables", "conditionals", "for loops", "slices", "range"]);
    assert.match(out, /20-40 active hours · difficulty: intermediate/);
    assert.match(out, /100-180 active hours/);
    assert.match(out, /why it fits: .*waiting lists/);
    assert.match(await practice.suggest("p1"), /1\. printing:[\s\S]*2\. variables:/);
    assert.match(practice.describe(), /printing, variables/);
    assert.equal(skills.find(skills.read(), "printing", "go"), undefined);
    assert.equal(skills.find(skills.read(), "variables", "go"), undefined);
    assert.equal(level("variables"), "build");
    assert.equal(saved().tasks[0].state, "open");
  } finally {
    done();
  }
});

test("project generation carries bounded memory, personal opt-in and foreign experience into the recommendation call", async () => {
  const { root, store, practice, done } = setup(BASICS);
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    writeFileSync(`${root}/.dum/memory.md`, "waiting lists for pickup matches");
    store.restoreTranscript([{ kind: "user", id: 1, text: "I write Python at work and want to learn Go." }]);
    let input = "";
    const personal = { path: "personal.txt", text: "I organize a local football group.", warning: "" };
    const contextual = new Practice(root, store, practice.workspace, practice.evidence, personal, async (prompt) => {
      if (prompt.startsWith("You check practice tasks")) return JSON.stringify({ tasks: [projectCheck(project())] });
      input = prompt;
      return JSON.stringify({ tasks: [project()] });
    });
    await contextual.suggest("projects in go");
    assert.match(input, /waiting lists for pickup matches/);
    assert.match(input, /I write Python at work and want to learn Go/);
    assert.match(input, /I organize a local football group/);
    assert.match(input, /"lang":"python","level":"build"/);
    assert.match(input, /"lang":"go"/);
  } finally {
    done();
  }
});

test("project coverage rejects undeclared implied skills, target prerequisites, cycles and foreign-language assumptions", () => {
  const empty = () => false;
  const p = toProject(project(), "go", empty)!;
  assert.ok(p);
  assert.equal(toProject(project({ targets: [project().targets[0]] }), "go", empty), null, "printing prerequisite is not grandfathered");
  assert.equal(toProject(project({ uses: ["functions"] }), "go", empty), null, "Python functions don't establish Go functions");
  assert.equal(checkedProject(projectCheck(project(), 1, ["input"]), p, empty), null, "undeclared input is an uncovered learning goal");
  const prerequisite = projectCheck(project());
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
  assert.deepEqual(unknown.project!.targets.map((t) => t.skill), ["printing", "variables", "match fairness"]);
  assert.ok(checkedProject(projectCheck(unfamiliar), unknown, empty));
  assert.equal(curriculum.mapped("match fairness", "go"), undefined, "suggestions don't establish off-track prerequisites or ability");
});

test("an audited missing requirement becomes an explicit learning milestone, never assumed ability", async () => {
  const goal = { skill: "arithmetic", requires: ["variables"], milestone: "Calculate remaining roster places.",
    done: "the number of open places changes correctly as players join" };
  const checked = { ...projectCheck(project(), 1, ["arithmetic"]), targets: [...projectCheck(project()).targets, goal] };
  const { practice, saved, done } = setup([], () => JSON.stringify({ tasks: [project({
    task: "Show a pickup roster and calculate its remaining places.",
  })] }), () => JSON.stringify({ tasks: [checked] }));
  try {
    await practice.suggest("projects in go");
    const targets = saved().tasks[0].project.targets;
    assert.deepEqual(targets.map((t: { skill: string }) => t.skill), ["printing", "variables", "arithmetic"]);
    assert.equal(targets[2].milestone, goal.milestone);
    assert.deepEqual(targets[2].requires, ["variables"]);
    assert.equal(skills.find(skills.read(), "arithmetic", "go"), undefined);
    const offered = toProject(project(), "go", () => false)!;
    assert.equal(checkedProject({ ...checked, requires: [] }, offered, () => false), null, "an unrelated additional goal is refused");
    assert.equal(checkedProject({ ...checked, targets: [...projectCheck(project()).targets, { ...goal, done: "" }] }, offered, () => false), null,
      "an additional required goal needs its own passing-evidence criterion");
  } finally { done(); }
});

test("project submission awards only individually passing unaided targets in prerequisite order and can finish later", async () => {
  let passes: Record<string, boolean> = { printing: true, variables: false };
  const { practice, root, saved, done } = setup(BASICS, (prompt) => prompt.startsWith("You review a project")
    ? JSON.stringify({ targets: ["variables", "printing"].map((skill) => ({ skill, passed: passes[skill], feedback: passes[skill] ? `${skill} drives real roster output` : "where are the player values stored?" })) })
    : JSON.stringify({ tasks: [project()] }), () => JSON.stringify({ tasks: [projectCheck(project())] }));
  try {
    await practice.suggest("projects in go");
    writeFileSync(`${root}/main.go`, 'package main\nimport "fmt"\nfunc main() { player := "Ada"; fmt.Println(player) }\n');
    assert.match(await practice.submit("p1 main.go"), /0 recorded/);
    assert.equal(skills.find(skills.read(), "printing", "go"), undefined);
    const partial = await practice.submit("p1 main.go --unaided");
    assert.match(partial, /1\/2 targets passed review; 1 recorded/);
    assert.equal(skills.find(skills.read(), "printing", "go")?.level, "build");
    assert.equal(skills.find(skills.read(), "variables", "go"), undefined);
    assert.equal(saved().tasks[0].state, "open");
    assert.deepEqual(saved().tasks[0].submissions.at(-1).targets.map((t: { skill: string; built: boolean }) => [t.skill, t.built]), [["printing", true], ["variables", false]]);
    assert.match(await practice.suggest("p1"), /last review · variables: not yet/);
    passes = { printing: true, variables: true };
    assert.match(await practice.submit("p1 main.go --unaided"), /2\/2 targets passed review; 2 recorded/);
    assert.equal(skills.find(skills.read(), "variables", "go")?.level, "build");
    assert.equal(saved().tasks[0].state, "passed");
    assert.equal(skills.find(skills.read(), "functions", "go"), undefined, "no blanket advancement");
    assert.equal(level("functions"), "build", "other languages remain unchanged");
  } finally {
    done();
  }
});

test("a failed project prerequisite blocks a higher passing target and malformed reviews record nothing", async () => {
  let response: unknown = { targets: [
    { skill: "printing", passed: false, feedback: "where is the roster shown?" },
    { skill: "variables", passed: true, feedback: "named player variables drive the roster" },
  ] };
  const { practice, root, saved, done } = setup([], (prompt) => prompt.startsWith("You review a project")
    ? JSON.stringify(response) : JSON.stringify({ tasks: [project()] }),
  () => JSON.stringify({ tasks: [projectCheck(project())] }));
  try {
    await practice.suggest("projects in go");
    writeFileSync(`${root}/main.go`, "package main\nfunc main() {}\n");
    assert.match(await practice.submit("p1 main.go --unaided"), /variables:[\s\S]*not recorded: prerequisites not built: printing/);
    assert.equal(skills.find(skills.read(), "printing", "go"), undefined);
    assert.equal(skills.find(skills.read(), "variables", "go"), undefined);
    assert.equal(saved().tasks[0].state, "open");
    const before = saved().tasks[0].submissions.length;
    response = { targets: [{ skill: "printing", passed: true, feedback: "roster output works" }] };
    await assert.rejects(practice.submit("p1 main.go --unaided"), /nothing recorded/);
    assert.equal(saved().tasks[0].submissions.length, before);
    response = { targets: [
      { skill: "printing", passed: true, feedback: "roster output works" },
      { skill: "printing", passed: true, feedback: "roster output works" },
    ] };
    await assert.rejects(practice.submit("p1 main.go --unaided"), /nothing recorded/);
    assert.equal(skills.find(skills.read(), "printing", "go"), undefined);
  } finally {
    done();
  }
});

test("old saved single-skill tasks retain their metadata and review behavior", async () => {
  const { root, practice, saved, done } = setup(BASICS, () => JSON.stringify({ passed: true, feedback: "the base case and recursive call work" }));
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    const legacy = { ...toTask(task(), { skill: "recursion", lang: "python", exercise: "python" }, () => true)!,
      id: "p7", at: "2026-01-01T00:00:00.000Z", state: "open", submissions: [] };
    writeFileSync(`${root}/.dum/practice.json`, JSON.stringify({ version: 1, next: 8, tasks: [legacy] }));
    assert.match(await practice.suggest("p7"), /implement: count down/);
    assert.deepEqual(saved().tasks[0], legacy);
    writeFileSync(`${root}/walk.py`, "def countdown(n):\n    return [] if n == 0 else [n] + countdown(n - 1)\n");
    await practice.submit("p7 walk.py --unaided");
    assert.equal(level("recursion"), "build");
    assert.equal(saved().tasks[0].project, undefined);
    assert.equal(saved().tasks[0].submissions[0].targets, undefined);
  } finally {
    done();
  }
});

test("project review does not grandfather a named prerequisite that fails its own review", async () => {
  const { root, practice, done } = setup([], (prompt) => prompt.startsWith("You review a project")
    ? JSON.stringify({ targets: [
      { skill: "printing", passed: false, feedback: "where is the actual roster printed?" },
      { skill: "variables", passed: true, feedback: "player variables drive real assignments" },
    ] }) : JSON.stringify({ tasks: [project()] }), () => JSON.stringify({ tasks: [projectCheck(project())] }));
  try {
    await practice.suggest("projects in go");
    skills.write(skills.unlock(skills.read(), { name: "printing", lang: "go", how: "typed", level: "build", why: "earlier project" }));
    writeFileSync(`${root}/main.go`, "package main\nfunc main() { player := 1; _ = player }\n");
    assert.match(await practice.submit("p1 main.go --unaided"), /not recorded: prerequisites not built: printing/);
    assert.equal(skills.find(skills.read(), "variables", "go"), undefined);
    assert.equal(skills.find(skills.read(), "printing", "go")?.level, "build", "failed review doesn't revoke earlier evidence");
  } finally {
    done();
  }
});

test("an unfamiliar project learning goal stays a goal until its own passing unaided review", async () => {
  const unfamiliar = project({ targets: [
    { skill: "match fairness", requires: ["variables"], milestone: "Compare roster fairness.", done: "fairness is calculated meaningfully" },
    ...project().targets,
  ] });
  const { practice, root, done } = setup([], (prompt) => prompt.startsWith("You review a project")
    ? JSON.stringify({ targets: unfamiliar.targets.map((t) => ({ skill: t.skill, passed: true, feedback: `${t.skill} is demonstrated in roster calculations` })) })
    : JSON.stringify({ tasks: [unfamiliar] }), () => JSON.stringify({ tasks: [projectCheck(unfamiliar)] }));
  try {
    await practice.suggest("projects in go");
    assert.equal(curriculum.mapped("match fairness", "go"), undefined);
    assert.equal(skills.find(skills.read(), "match fairness", "go"), undefined);
    writeFileSync(`${root}/main.go`, 'package main\nimport "fmt"\nfunc main() { fairness := 2; fmt.Println(fairness) }\n');
    await practice.submit("p1 main.go --unaided");
    assert.equal(skills.find(skills.read(), "match fairness", "go")?.level, "build");
    assert.deepEqual(curriculum.mapped("match fairness", "go"), ["variables"]);
    assert.equal(skills.find(skills.read(), "match fairness", "python"), undefined);
  } finally {
    done();
  }
});

test("large project metadata stays inside the readable saved-state byte bound", async () => {
  const large = project({ targets: Array.from({ length: 40 }, (_, i) => ({
    skill: `goal ${i}`, requires: [], milestone: "m".repeat(600), done: "d".repeat(600),
  })) });
  let count = 0;
  const { root, practice, saved, done } = setup([], () => JSON.stringify({ tasks: [{ ...large, title: `large project ${++count}` }] }),
    () => JSON.stringify({ tasks: [projectCheck(large)] }));
  try {
    for (let i = 0; i < 12; i++) await practice.suggest("projects in go");
    assert.ok(Buffer.byteLength(readFileSync(`${root}/.dum/practice.json`, "utf8")) <= 512 * 1024);
    assert.ok(saved().tasks.length < 12, "old projects are evicted before the file becomes unreadable");
    assert.match(await practice.suggest("p12"), /large project 12/);
  } finally {
    done();
  }
});

test("a stopped per-target project review records none of its passing targets", async () => {
  const review = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const { root, store, practice, done } = setup([], (prompt) => {
    if (prompt.startsWith("You review a project")) {
      started.resolve();
      return review.promise;
    }
    return JSON.stringify({ tasks: [project()] });
  }, () => JSON.stringify({ tasks: [projectCheck(project())] }));
  try {
    await practice.suggest("projects in go");
    writeFileSync(`${root}/main.go`, 'package main\nimport "fmt"\nfunc main() { player := "Ada"; fmt.Println(player) }\n');
    const pending = practice.submit("p1 main.go --unaided");
    await started.promise;
    store.cancel();
    review.resolve(JSON.stringify({ targets: project().targets.map((t) => ({ skill: t.skill, passed: true, feedback: `${t.skill} drives roster output` })) }));
    await assert.rejects(pending, Cancelled);
    assert.equal(skills.find(skills.read(), "printing", "go"), undefined);
    assert.equal(skills.find(skills.read(), "variables", "go"), undefined);
    await store.settled();
  } finally {
    done();
  }
});

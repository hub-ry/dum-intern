// Optional practice: only open next steps, only built skills leaned on, nothing unlocked by being
// suggested, and a submission that builds only under the evidence rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Practice, parseSubmit, parseTarget, toTask, MAX_TASKS } from "../src/practice.ts";
import { Evidence } from "../src/evidence.ts";
import { Workspace } from "../src/workspace.ts";
import * as skills from "../src/skills.ts";
import { Store, Cancelled } from "../src/store.ts";

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
    assert.match(out, /p2  project: folder sizes[\s\S]*the core of it is yours to implement/);
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

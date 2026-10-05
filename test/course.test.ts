import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseCommand, slug, toCourse, toVerdict, active, take, newScratch } from "../src/course.ts";
import { Store } from "../src/store.ts";
import * as skills from "../src/skills.ts";

test("a course is asked for the ways people say it", () => {
  assert.deepEqual(parseCommand("course recursion"), { skill: "recursion", lang: "" });
  assert.deepEqual(parseCommand(":course for loops in py"), { skill: "for loops", lang: "python" });
  assert.deepEqual(parseCommand("Learn range-based for in c++"), { skill: "range-based for", lang: "c++" });
  assert.deepEqual(parseCommand("unlock pointers"), { skill: "pointers", lang: "" });
  assert.equal(parseCommand("of course"), null);
  assert.equal(parseCommand("add a course list page"), null);
  assert.equal(parseCommand("course"), null);
});

test("a skill becomes a file name", () => {
  assert.equal(slug("range-based for"), "range-based-for");
  assert.equal(slug("C++ templates"), "cpp-templates");
  assert.equal(slug("???"), "course");
});

const raw = {
  requires: ["functions", 7],
  lesson: "a function that calls itself — on a smaller input.",
  example: "\ndef count(n):\n    ...\n",
  task: "make fact(n) return n!",
  starter: "def fact(n):\n    # TODO(dum): recursion\n    # return n * fact(n - 1) down to 1\n    pass\n\nprint(fact(5))",
  run: "python .dum/courses/recursion.py",
};

test("a course comes back whole or not at all", () => {
  const c = toCourse(raw, "recursion", "python", ".dum/courses/recursion.py")!;
  assert.deepEqual(c.requires, ["functions"]);
  assert.ok(c.starter.endsWith("print(fact(5))\n"));
  assert.equal(toCourse({ ...raw, starter: "def fact(n):\n    pass\n" }, "recursion", "python", "x.py"), null, "a starter with no gap for the skill");
  assert.equal(toCourse({ ...raw, task: "" }, "recursion", "python", "x.py"), null);
  assert.equal(toCourse("nope", "recursion", "python", "x.py"), null);
});

test("a verdict needs both a pass or fail and words", () => {
  assert.deepEqual(toVerdict({ passed: true, feedback: " base case and all. " }), { passed: true, feedback: "base case and all." });
  assert.equal(toVerdict({ passed: "yes", feedback: "ok" }), null);
  assert.equal(toVerdict({ passed: false, feedback: "  " }), null);
});


/** A project with printing and variables built, and a saved functions course in progress. */
function inProgress(typed: string | null) {
  const root = mkdtempSync(`${tmpdir()}/dum-resume-course-`);
  const previous = process.env.DUM_HOME;
  process.env.DUM_HOME = `${root}/home`;
  let tree: skills.Tree = { skills: [] };
  for (const name of ["printing", "variables"]) tree = skills.unlock(tree, { name, lang: "python", how: "typed", why: "" });
  skills.write(tree);
  const path = ".dum/courses/functions.py";
  const c = toCourse({ ...raw, task: "make add return the sum", starter: "def add(a, b):\n    # TODO(dum): functions\n    pass\n" }, "functions", "python", path)!;
  mkdirSync(`${root}/.dum/courses`, { recursive: true });
  if (typed !== null) writeFileSync(`${root}/${path}`, typed);
  writeFileSync(`${root}/.dum/active-course.json`, JSON.stringify({ course: c, lang: "python", wizard: "a function groups work" }));
  return {
    root,
    path,
    c,
    done: () => {
      if (previous === undefined) delete process.env.DUM_HOME;
      else process.env.DUM_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an unfinished course resumes its saved lesson without overwriting the learner's code", async () => {
  const typed = "def add(a, b):\n    # TODO(dum): functions\n    return a + b\n";
  const { root, path, c, done } = inProgress(typed);
  try {
    assert.equal(active(root)?.course.task, c.task);
    const store = new Store("practice", "understand", root);
    const finishing = take("functions", "python", { root, store, unlock: () => assert.fail("quitting mustn't unlock the skill") });
    store.submit("quit");
    await finishing;
    assert.equal(readFileSync(`${root}/${path}`, "utf8"), typed);
    assert.equal(active(root), null);
    assert.ok(store.getSnapshot().transcript.some((e) => e.kind === "course" && e.card.task === c.task && e.passed === false));
  } finally {
    done();
  }
});

test("a resumed course whose scratch file is gone gets its original starter back, and nothing else is written", async () => {
  const { root, path, c, done } = inProgress(null);
  try {
    const store = new Store("practice", "understand", root);
    const finishing = take("functions", "python", { root, store, unlock: () => assert.fail("quitting mustn't unlock the skill") });
    store.submit("quit");
    await finishing;
    assert.equal(readFileSync(`${root}/${path}`, "utf8"), c.starter);
  } finally {
    done();
  }
});

test("a new course never overwrites a scratch file, whoever saved it", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-scratch-`);
  try {
    mkdirSync(`${root}/.dum/courses`, { recursive: true });
    writeFileSync(`${root}/.dum/courses/recursion.py`, "mine\n");
    assert.equal(newScratch(root, "recursion", "python", "starter\n"), ".dum/courses/recursion-2.py");
    assert.equal(readFileSync(`${root}/.dum/courses/recursion.py`, "utf8"), "mine\n");
    assert.equal(readFileSync(`${root}/.dum/courses/recursion-2.py`, "utf8"), "starter\n");
    assert.equal(newScratch(root, "recursion", "python", "again\n"), ".dum/courses/recursion-3.py");
    assert.equal(readFileSync(`${root}/.dum/courses/recursion-2.py`, "utf8"), "starter\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a saved course only ever points into .dum/courses", () => {
  const { root, c, done } = inProgress("x\n");
  try {
    for (const path of ["src/main.py", ".dum/courses/../../main.py", ".dum/courses/other.py", ".dum/courses/functions.js"]) {
      writeFileSync(`${root}/.dum/active-course.json`, JSON.stringify({ course: { ...c, path }, lang: "python", wizard: "" }));
      assert.equal(active(root), null, path);
    }
    writeFileSync(`${root}/.dum/active-course.json`, JSON.stringify({ course: { ...c, path: ".dum/courses/functions-2.py" }, lang: "python", wizard: "" }));
    assert.equal(active(root)?.course.path, ".dum/courses/functions-2.py", "an alternate scratch name resumes");
    assert.ok(existsSync(`${root}/.dum/active-course.json`));
  } finally {
    done();
  }
});

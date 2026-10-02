import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, slug, toCourse, toVerdict, lockedLine } from "../src/course.ts";

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
  assert.equal(c.lesson, "a function that calls itself - on a smaller input.", "no em dash reaches the screen");
  assert.equal(c.example, "def count(n):\n    ...");
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

test("a locked course says what it builds on and where to start", () => {
  assert.equal(
    lockedLine("recursion", "python", { state: "locked", missing: ["return values"], next: "functions" }),
    "recursion (python) is locked - it builds on return values, and you don't have that yet. start lower: course functions",
  );
  assert.equal(
    lockedLine("recursion", "python", { state: "locked", missing: ["return values", "conditionals"], next: "return values" }),
    "recursion (python) is locked - it builds on return values, conditionals, and you don't have those yet. course return values first.",
  );
});

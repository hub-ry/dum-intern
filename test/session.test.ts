// A turn that ends on an error must say so, in words that point at the fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { failure } from "../src/session.ts";

test("a normal turn is not a failure", () => {
  assert.equal(failure({ subtype: "success", is_error: false, result: "done" }), null);
});

test("an API error is reported with its text", () => {
  assert.match(failure({ subtype: "success", is_error: true, result: "API Error: 529 overloaded" })!, /529 overloaded/);
});

test("a model newer than the bundled Claude Code says how to update dum", () => {
  // Verbatim from a real run, right after the default model was switched.
  const f = failure({
    subtype: "success",
    is_error: true,
    result:
      "API Error: 400 Claude Code 2.1.234 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
  });
  assert.match(f!, /npm update @anthropic-ai\/claude-agent-sdk/);
  assert.doesNotMatch(f!, /claude update/, "claude update fixes the wrong copy");
});

test("an early stop names why", () => {
  assert.match(failure({ subtype: "error_max_turns", is_error: true })!, /error_max_turns/);
});

test("the gate refuses rewriting a hole, and allows adding one", async () => {
  const { erasesHole } = await import("../src/session.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(`${tmpdir()}/dum-gate-`);
  writeFileSync(`${root}/a.py`, "def f():\n    # TODO(dum): retries\n    # try three times\n    pass\n");
  assert.ok(erasesHole(root, "Edit", { old_string: "    # TODO(dum): retries\n    pass" }));
  assert.ok(!erasesHole(root, "Edit", { old_string: "def f():", new_string: "# TODO(dum): x\ndef f():" }));
  assert.ok(erasesHole(root, "MultiEdit", { edits: [{ old_string: "x" }, { old_string: "# TODO(dum): retries" }] }));
  assert.ok(erasesHole(root, "Write", { file_path: "a.py", content: "def f():\n    return 1\n" }));
  assert.ok(!erasesHole(root, "Write", { file_path: "a.py", content: "import x\ndef f():\n    # TODO(dum): retries\n    pass\n" }));
  assert.ok(!erasesHole(root, "Write", { file_path: "new.py", content: "anything" }));
});

test("not yet takes a skill back without costing the turn, and is an answer when there's nothing to take", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand");
  const taken: string[] = [];
  let has = true;
  s.onNotYet = (name) => (has ? (taken.push(name), true) : false);
  const reply = s.askQuestion("have you added tests?", "");
  s.submit("not yet");
  s.submit("Not yet: rust macros");
  assert.deepEqual(taken, ["", "rust macros"]);
  has = false;
  s.submit("not yet");
  assert.equal(await reply, "not yet");
});

test("an init without effort never wipes an effort already read back", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand");
  s.setModel("intern", "claude-opus-5-5", "high");
  s.setModel("intern", "claude-opus-5-5");
  assert.deepEqual(s.getSnapshot().models.intern, { model: "claude-opus-5-5", effort: "high" });
  s.setModel("intern", "claude-sonnet-5");
  assert.deepEqual(s.getSnapshot().models.intern, { model: "claude-sonnet-5", effort: "" });
});

test("shift-tab flips the middle between file and shell; a long reply opens the board, esc closes it", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand", process.cwd());
  s.openFile("package.json");
  s.toggleMiddle();
  assert.equal(s.getSnapshot().stage.kind, "shell");
  s.toggleMiddle();
  assert.equal(s.getSnapshot().stage.kind, "code");
  s.say("short");
  assert.equal(s.getSnapshot().stage.kind, "code");
  s.say("a two-sentence build summary. ".repeat(10));
  assert.equal(s.getSnapshot().stage.kind, "code", "an ordinary reply stays in the thread");
  s.say("x".repeat(700));
  assert.equal(s.getSnapshot().stage.kind, "reply");
  s.closeBoard();
  assert.equal(s.getSnapshot().stage.kind, "code", "back to what the middle had");
});

test("a hole handed to them can't be rewritten; one still being shaped can", async () => {
  const { erasesHole } = await import("../src/session.ts");
  const edit = { old_string: "// TODO(dum): vector growth\n// grow it", new_string: "grow();" };
  assert.ok(erasesHole("/", "Edit", edit, ["vector growth"]));
  assert.ok(!erasesHole("/", "Edit", edit, ["something else"]));
  assert.ok(erasesHole("/", "Edit", edit), "no list: every hole is protected");
});

test("live comments pin to lines, replace per line, and clear together", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand", process.cwd());
  s.openFile("package.json");
  s.pin("package.json", 3, "first");
  s.pin("package.json", 3, "second");
  s.pin("package.json", 5, "other");
  assert.deepEqual(s.getSnapshot().pins["package.json"], [{ line: 3, text: "second" }, { line: 5, text: "other" }]);
  s.unpin();
  assert.deepEqual(s.getSnapshot().pins, {});
});

test("the thread keeps everything said, and ends on whose turn it is", async () => {
  const { thread } = await import("../src/panes/Cast.tsx");
  const { printable } = await import("../src/lines.ts");
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand");
  s.say("run it with g++ -std=c++17 guess.cpp -o guess");
  const done = s.askNext();
  s.submit("done");
  await done;
  s.say('secret 50, you type 30, and it says "too high". is 30 bigger than 50?', true);
  s.setTodos([{ concept: "conditionals", path: "guess.cpp", course: "conditionals" }]);
  void s.askNext();
  const text = thread(s.getSnapshot(), 40).map((l) => printable(l.text));
  assert.ok(text.some((l) => l.includes("g++")), "earlier messages stay");
  assert.ok(text.some((l) => l === "› done"), "your reply shows");
  assert.ok(text.some((l) => l.includes("is 30 bigger than 50?")));
  const tail = text.slice(-4).join(" ");
  assert.match(tail, /your turn: conditionals in guess\.cpp/);
  assert.match(tail, /course conditionals$/, "the way out of a hole is always the last thing on screen");
});

test("the plan is laid out by dum, and whether a piece is locked is the tree's call", async () => {
  const { planCard, classify } = await import("../src/session.ts");
  const { markdown, printable } = await import("../src/lines.ts");
  const { unlock } = await import("../src/skills.ts");
  process.env.DUM_HOME = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/dum-plan-`);
  let t = { skills: [] as import("../src/skills.ts").Skill[] };
  for (const name of ["printing", "variables", "conditionals", "functions"]) t = unlock(t, { name, lang: "python", how: "added", why: "" });
  const pieces = classify(t, [
    { skill: "Printing", lang: "py", what: "print the answer" },
    { skill: "return values", lang: "python", what: "fib returns the nth number" },
    { skill: "recursion", lang: "python", what: "fib calls itself" },
  ]);
  assert.deepEqual(pieces.map((p) => [p.skill, p.lang, p.status.state]), [
    ["printing", "python", "unlocked"],
    ["return values", "python", "open"],
    ["recursion", "python", "locked"],
  ]);
  const card = planCard("a recursive | fibonacci", pieces, "understand", "python fib.py");
  assert.equal(
    card,
    "**a recursive / fibonacci**\n\n## you already know - dum writes\n- printing (python)\n\n## you type, or take the course\n- return values (python): fib returns the nth number · `course return values`\n\n## locked deeper\n- recursion (python): needs return values · start with `course return values`\n\n## run\n- `python fib.py`",
  );
  assert.match(planCard("x", pieces, "anti-vibe"), /## you explain, or take the course/);
  const shown = markdown(card, 60).map(printable);
  assert.ok(shown.every((l) => !/[#*|`]/.test(l)), "nothing raw reaches the screen");
});

test("a skill taken back with not yet reads as locked in the plan, whatever the tree says", async () => {
  const { classify } = await import("../src/session.ts");
  const { unlock, id } = await import("../src/skills.ts");
  const t = unlock({ skills: [] }, { name: "printing", lang: "rust", how: "typed", why: "" });
  assert.equal(classify(t, [{ skill: "printing", lang: "rust", what: "" }])[0]!.status.state, "unlocked");
  assert.equal(classify(t, [{ skill: "printing", lang: "rust", what: "" }], "understand", new Set([id("printing", "rust")]))[0]!.status.state, "open");
});

test("the language a repo is written in is the one most of its files are", async () => {
  const { mainLang } = await import("../src/session.ts");
  assert.equal(mainLang({ files: ["a.py", "b.py", "c.rs", "README.md"] }), "python");
  assert.equal(mainLang({ files: ["README.md"] }), "");
});

test("a plan and a course each take the board, and a course ends back on the code", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand", process.cwd());
  s.openFile("package.json");
  const reply = s.proposePlan("**x**");
  assert.equal(s.getSnapshot().stage.kind, "plan");
  assert.equal(s.getSnapshot().prompt?.type, "plan");
  s.submit("course recursion");
  assert.equal(await reply, "course recursion", "a course command comes back to whoever asked for the plan");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "plan" && e.paused && e.approved === null), "a course pauses the plan, it doesn't decline it");
  const card = { skill: "recursion", lang: "python", lesson: "l", example: "", wizard: "that's recursion.", task: "t", path: ".dum/courses/recursion.py", run: "" };
  s.course(card);
  assert.equal(s.getSnapshot().stage.kind, "course");
  s.openFile("package.json", 0);
  assert.equal(s.getSnapshot().stage.kind, "course", "opening the scratch file keeps the lesson up");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "quip" && e.text === "that's recursion."), "the wizard's line is in the thread");
  const done = s.askCourse(card);
  assert.equal(s.getSnapshot().prompt?.type, "course");
  s.submit("done");
  assert.equal(await done, "done");
  s.endCourse(card, true);
  assert.equal(s.getSnapshot().stage.kind, "code");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "course" && e.passed === true));
});

test("a tool only needs recognizing, a concept needs building, and the core is yours in understand mode", async () => {
  const { classify, planCard, aiWrites, needFor } = await import("../src/session.ts");
  const { unlock } = await import("../src/skills.ts");
  let t = { skills: [] as import("../src/skills.ts").Skill[] };
  for (const name of ["printing", "variables", "functions", "conditionals", "lists", "for loops"]) t = unlock(t, { name, lang: "python", how: "typed", why: "" });
  t = unlock(t, { name: "watchdog", lang: "python", how: "explained", why: "watches a folder for changes" });
  t = unlock(t, { name: "change detection", lang: "python", how: "reasoned", why: "compare hashes to the last run" });
  const raw = [
    { skill: "for loops", lang: "python", what: "walk the files" },
    { skill: "watchdog", lang: "python", what: "watch the folder", kind: "tool" as const },
    { skill: "argparse", lang: "python", what: "read the folder to watch", kind: "tool" as const },
    { skill: "dictionaries", lang: "python", what: "the last hash per file", kind: "tool" as const },
    { skill: "change detection", lang: "python", what: "which files changed since the last backup", core: true },
  ];
  const u = classify(t, raw, "understand");
  assert.equal(u.find((p) => p.skill === "dictionaries")!.kind, "concept", "a track skill is a concept whatever the intern says");
  assert.deepEqual(u.map((p) => [p.skill, aiWrites(p, "understand")]), [
    ["for loops", true],
    ["watchdog", true],
    ["argparse", false],
    ["dictionaries", false],
    ["change detection", false],
  ]);
  const card = planCard("backs up what changed", u, "understand");
  assert.match(card, /## you already know - dum writes\n- for loops \(python\)\n/);
  assert.match(card, /## ai may implement\n- watchdog \(python\): a tool you recognize\n/);
  assert.match(card, /## you must implement\n- change detection \(python\): which files changed since the last backup\n/);
  assert.match(card, /## what's it for\?\n- argparse \(python\): read the folder to watch · say what it's for, in a line\n/);
  assert.match(card, /## you type, or take the course\n- dictionaries \(python\)/);
  const a = classify(t, raw, "anti-vibe");
  assert.ok(aiWrites(a.find((p) => p.core)!, "anti-vibe"), "in anti-vibe, reasoning that holds lets AI write the core");
  assert.match(planCard("x", a, "anti-vibe"), /- change detection \(python\): your reasoning holds/);
  assert.equal(needFor("tool", "understand"), "recognize");
  assert.equal(needFor("concept", "understand"), "build");
  assert.equal(needFor("concept", "anti-vibe"), "recognize");
});

test("a builder skill asked for from a language is the language-free one", async () => {
  const { classify } = await import("../src/session.ts");
  const { unlock } = await import("../src/skills.ts");
  const t = unlock({ skills: [] }, { name: "functions", lang: "go", how: "typed", why: "" });
  const [p] = classify(t, [{ skill: "Command-line programs", lang: "go", what: "flags" }]);
  assert.deepEqual([p!.skill, p!.lang, p!.kind, p!.status.state], ["command-line programs", "", "concept", "open"]);
});

test("a hole offers the course you can take now: its own, the rung under it, or none for the core", async () => {
  const { courseFor } = await import("../src/session.ts");
  const { unlock } = await import("../src/skills.ts");
  let t = { skills: [] as import("../src/skills.ts").Skill[] };
  for (const name of ["printing", "variables"]) t = unlock(t, { name, lang: "python", how: "typed", why: "" });
  assert.equal(courseFor(t, { concept: "conditionals", path: "a.py" }), "conditionals");
  assert.equal(courseFor(t, { concept: "input", path: "a.py" }), "strings", "input needs strings first");
  assert.equal(courseFor(t, { concept: "change detection", path: "a.py", core: true }), "");
});

test("submitting a request dismisses welcome panels so replies are visible", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand");
  s.show("nothing's unlocked yet", "Ask for something.");
  const request = s.askQuestion("what do you want?", "", false);
  s.submit("hello");
  assert.equal(await request, "hello");
  s.say("Hello. What would you like to build?");
  assert.equal(s.getSnapshot().stage.kind, "code");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "say" && e.text.startsWith("Hello.")));
});

test("execution failures show the SDK's errors instead of a generic subtype", () => {
  assert.match(failure({ subtype: "error_during_execution", is_error: true, errors: ["Authentication failed"] })!, /Authentication failed/);
});


test("API retries name connection failures and service errors instead of thinking", async () => {
  const { retryStatus } = await import("../src/session.ts");
  assert.equal(retryStatus({ type: "system", subtype: "api_retry", error_status: null, retry_delay_ms: 2500 }), "Claude connection failed - retrying in 3s");
  assert.equal(retryStatus({ type: "system", subtype: "api_retry", error_status: 529, error: "overloaded", retry_delay_ms: 1000 }), "Claude API 529 (overloaded) - retrying in 1s");
  assert.equal(retryStatus({ type: "system", subtype: "init" }), null);
});

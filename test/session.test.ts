// The session's tools, exercised without a model: what dum may change, what counts as evidence,
// and what reaches dum from your commands. The gate and the ledger decide; the model can't.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mainLang, prepare, toolkit, applyEdits, type Ctx } from "../src/session.ts";
import { Store } from "../src/store.ts";
import * as skills from "../src/skills.ts";
import * as todos from "../src/todos.ts";

const tick = () => new Promise((r) => setImmediate(r));

/** A scratch repo and tree, dum wired to it, and its tools by name. */
function setup(files: Record<string, string> = {}) {
  const home = mkdtempSync(`${tmpdir()}/dum-home-`);
  process.env.DUM_HOME = home;
  const root = mkdtempSync(`${tmpdir()}/dum-repo-`);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, body] of Object.entries(files)) writeFileSync(`${root}/${path}`, body);
  const store = new Store("scratch", "understand", root, Object.keys(files));
  const ctx = prepare({ name: "scratch", root, files: Object.keys(files), readme: "" }, "understand", store, { path: "", text: "", warning: "" });
  const tools = Object.fromEntries(toolkit(ctx).map((t) => [t.name, t.run]));
  const done = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { root, store, ctx, tools, done };
}

/** Answer the prompt of this type once it shows and takes input: a running command suspends it. */
async function reply(store: Store, type: string, text: string) {
  for (let i = 0; i < 200 && !(store.getSnapshot().prompt?.type === type && store.inputReady); i++) await tick();
  assert.equal(store.getSnapshot().prompt?.type, type);
  assert.ok(store.inputReady, `the ${type} prompt never took input`);
  store.submit(text);
}

function built(name: string, lang: string) {
  skills.write(skills.unlock(skills.read(), { name, lang, how: "typed", why: "test" }));
}

test("nothing changes before a plan is approved, and refusals are shown", async () => {
  const { root, store, tools, done } = setup({ "main.py": "print('hi')\n" });
  try {
    built("printing", "python");
    assert.match(await tools.propose_change!({ path: "main.py", skills: ["printing"], edits: [{ old_text: "hi", new_text: "hello" }] }), /approve a plan/);
    assert.match(await tools.create_file!({ path: "extra.py", skills: ["printing"], content: "print(1)\n" }), /approve a plan/);
    assert.equal(readFileSync(`${root}/main.py`, "utf8"), "print('hi')\n");
    assert.ok(!existsSync(`${root}/extra.py`));
    assert.equal(store.getSnapshot().transcript.filter((e) => e.kind === "tool" && e.outcome === "held").length, 2);
  } finally { done(); }
});

test("an approved plan lets dum propose what's unlocked - as a diff, never the core or a locked piece", async () => {
  const { root, store, ctx, tools, done } = setup({ "main.py": "print('hi')\n", "detect.py": "# yours\n" });
  try {
    built("printing", "python");
    const pieces = [
      { skill: "printing", lang: "python", what: "print the result", paths: ["main.py", "util.py"] },
      { skill: "recursion", lang: "python", what: "walk the folders", paths: ["walk.py"] },
      { skill: "change detection", lang: "python", what: "which files changed", core: true, paths: ["detect.py"] },
    ];
    assert.match(await tools.propose_plan!({ summary: "x", pieces: pieces.map(({ core, ...p }) => p) }), /core: true/, "no core, no plan");
    const plan = tools.propose_plan!({ summary: "a backup tool", pieces });
    await reply(store, "plan", "y");
    const approved = await plan;
    assert.match(approved, /You may propose changes for: printing \(python\)/);
    assert.match(approved, /Theirs to implement.*change detection/s);
    assert.ok(ctx.plan);

    const proposed = await tools.propose_change!({ path: "main.py", skills: ["printing"], edits: [{ old_text: "hi", new_text: "hello" }] });
    assert.match(proposed, /NOT applied/);
    assert.equal(readFileSync(`${root}/main.py`, "utf8"), "print('hi')\n", "their file is untouched");
    const diff = store.getSnapshot().transcript.find((e) => e.kind === "diff");
    assert.ok(diff?.kind === "diff" && diff.outcome === "proposed" && diff.artifact && existsSync(resolve(root, diff.artifact)));
    assert.match(readFileSync(resolve(root, diff.artifact), "utf8"), /hello/, "the proposal holds the change for their editor");

    assert.match(await tools.propose_change!({ path: "detect.py", skills: ["printing"], edits: [{ old_text: "# yours", new_text: "x = 1" }] }), /Refused: .*core/);
    assert.match(await tools.create_file!({ path: "walk.py", skills: ["recursion"], content: "def walk(): pass\n" }), /Refused/);
    assert.match(await tools.create_file!({ path: "other.py", skills: ["printing"], content: "print(2)\n" }), /Refused: .*isn't a file the approved plan lists/);
    assert.equal(readFileSync(`${root}/detect.py`, "utf8"), "# yours\n");
    assert.ok(!existsSync(`${root}/walk.py`) && !existsSync(`${root}/other.py`));

    assert.match(await tools.create_file!({ path: "util.py", skills: ["printing"], content: "def show(x):\n    print(x)\n" }), /Created util\.py/);
    assert.equal(readFileSync(`${root}/util.py`, "utf8"), "def show(x):\n    print(x)\n");
    writeFileSync(`${root}/util.py`, "# their save\n");
    assert.match(await tools.create_file!({ path: "util.py", skills: ["printing"], content: "print(3)\n" }), /Not created/);
    assert.equal(readFileSync(`${root}/util.py`, "utf8"), "# their save\n", "an existing file is never overwritten");
  } finally { done(); }
});

test("a declined plan approves nothing, and a not-yet locks a piece again at execution time", async () => {
  const { store, ctx, tools, done } = setup({ "main.py": "print('hi')\n" });
  try {
    built("printing", "python");
    const pieces = [
      { skill: "printing", lang: "python", what: "print", paths: ["main.py"] },
      { skill: "change detection", lang: "python", what: "core", core: true, paths: ["core.py"] },
    ];
    const declined = tools.propose_plan!({ summary: "x", pieces });
    await reply(store, "plan", "smaller please");
    assert.match(await declined, /Not approved\. They said: "smaller please"/);
    assert.equal(ctx.plan, null);
    const again = tools.propose_plan!({ summary: "x", pieces });
    await reply(store, "plan", "y");
    await again;
    ctx.evidence.undo("printing");
    assert.match(await tools.propose_change!({ path: "main.py", skills: ["printing"], edits: [{ old_text: "hi", new_text: "yo" }] }), /Refused/);
  } finally { done(); }
});

test("a new plan revokes the old approval even when it's refused before it's shown", async () => {
  const { root, store, ctx, tools, done } = setup({ "main.py": "print('hi')\n" });
  try {
    built("printing", "python");
    const approved = [
      { skill: "printing", lang: "python", what: "print", paths: ["util.py"] },
      { skill: "change detection", lang: "python", what: "core", core: true, paths: ["core.py"] },
    ];
    const invalid = [
      // No core path: the files that stay theirs aren't named.
      [approved[0]!, { ...approved[1]!, paths: [] }],
      // The core spells an earlier piece again, so it classifies away.
      [approved[0]!, { ...approved[0]!, core: true }],
      // No core at all.
      [approved[0]!],
    ];
    for (const pieces of invalid) {
      const plan = tools.propose_plan!({ summary: "x", pieces: approved });
      await reply(store, "plan", "y");
      await plan;
      assert.ok(ctx.plan);
      await tools.propose_plan!({ summary: "y", pieces });
      assert.equal(ctx.plan, null);
      await tools.create_file!({ path: "util.py", skills: ["printing"], content: "print(1)\n" });
      assert.ok(!existsSync(`${root}/util.py`), "the old approval created nothing");
    }
  } finally { done(); }
});

test("an explanation counts only when quoted from what they said this turn, and only as recognition", async () => {
  const { store, ctx, tools, done } = setup();
  try {
    ctx.said = ["make it print hello"];
    const quote = "print puts text on the screen so you can see what the program did";
    assert.match(await tools.check_answer!({ skill: "printing", lang: "python", quote, holds: true, feedback: "right" }), /Not recorded/);
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), null);
    assert.match(await tools.check_answer!({ skill: "printing", lang: "python", quote: "x", holds: false, feedback: "what does it show?" }), /Nothing recorded/);
    ctx.said = [`I think ${quote}.`];
    assert.doesNotMatch(await tools.check_answer!({ skill: "printing", lang: "python", quote, holds: true, feedback: "that's what it's for" }), /Not recorded/);
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), "recognize", "an explanation is never a build");
    store.submit("not yet");
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), null);
  } finally { done(); }
});

test("a reviewed submission builds only on their own direct unaided yes, and settles an old handoff", async () => {
  const { root, store, ctx, tools, done } = setup({ "hello.py": "print('hello')\n" });
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    writeFileSync(`${root}/.dum/todos.json`, JSON.stringify({ todos: [{ concept: "printing", path: "hello.py", what: "say hello", requires: [], before: "", lang: "python" }] }));
    ctx.legacy = todos.load(root);
    assert.equal(ctx.legacy.length, 1);

    const failed = await tools.review_submission!({ skill: "printing", lang: "python", paths: ["hello.py"], passed: false, feedback: "what does it print when the name is empty?" });
    const asked = store.getSnapshot().transcript.some((e) => e.kind === "question" && /yourself/.test(e.question));
    assert.match(failed, /Not passed/);
    assert.ok(!asked, "no self-report is asked for a failing review");

    const no = tools.review_submission!({ skill: "printing", lang: "python", paths: ["hello.py"], passed: true, feedback: "prints the greeting it should" });
    await reply(store, "question", "no, copilot helped");
    assert.match(await no, /Not recorded/);
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), null);

    const yes = tools.review_submission!({ skill: "printing", lang: "python", paths: ["hello.py"], passed: true, feedback: "prints the greeting it should" });
    await reply(store, "question", "y");
    assert.match(await yes, /Recorded/);
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), "build");
    assert.deepEqual(ctx.legacy, []);
    assert.deepEqual(JSON.parse(readFileSync(`${root}/.dum/todos.json`, "utf8")).todos, []);
  } finally { done(); }
});

test("what they share with a command reaches dum with its next answer, without answering for them", async () => {
  const { store, ctx, tools, done } = setup({ "main.py": "a = 1\nb = 2\n" });
  try {
    const asked = tools.ask!({ question: "which file holds the loop?", why_it_matters: "" });
    await reply(store, "question", ":inspect main.py");
    for (let i = 0; i < 200 && !ctx.shared.length; i++) await tick();
    assert.equal(store.getSnapshot().prompt?.type, "question", "the command didn't answer the question");
    assert.ok(store.getSnapshot().transcript.some((e) => e.kind === "excerpt" && e.path === "main.py" && e.by === "you"));
    await reply(store, "question", "main.py, line 2");
    const back = await asked;
    assert.match(back, /They shared main\.py/);
    assert.match(back, /b = 2/);
    assert.match(back, /They said: main\.py, line 2/);
    assert.deepEqual(ctx.shared, [], "shared once, not every turn");
    assert.ok(ctx.said.includes("main.py, line 2"), "their answer is what explanations quote");
  } finally { done(); }
});


test("edits apply only where old text appears exactly once", () => {
  assert.deepEqual(applyEdits("a\nb\n", [{ old_text: "b", new_text: "c" }]), { next: "a\nc\n" });
  for (const bad of [
    applyEdits("a\na\n", [{ old_text: "a", new_text: "c" }]),
    applyEdits("a\n", [{ old_text: "z", new_text: "c" }]),
    applyEdits("a\n", [{ old_text: "a", new_text: "a" }]),
    applyEdits("a\nb\n", [{ old_text: "b", new_text: "c" }, { old_text: "b", new_text: "d" }]),
  ]) assert.ok("why" in bad, "ambiguous, stale or empty edits propose nothing");
});


test("the language a repo is written in is the one most of its files are", () => {
  assert.equal(mainLang({ files: ["a.py", "b.py", "c.rs", "README.md"] }), "python");
  assert.equal(mainLang({ files: ["README.md"] }), "");
});

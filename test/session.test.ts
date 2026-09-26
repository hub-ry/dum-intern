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

import { onboarding } from "../src/session.ts";

const tree = (n: number) => ({
  skills: Array.from({ length: n }, (_, i) => ({
    name: `skill ${i}`, solid: true, breadth: "general" as const, requires: [], why: "", repos: [], at: "",
  })),
});

test("an empty tree gets the first-session guidance", () => {
  const text = onboarding(tree(0));
  assert.match(text, /first session/);
  assert.match(text, /idk is a fine answer/);
});

test("a small tree still gets it, and says how small", () => {
  assert.match(onboarding(tree(3)), /3 skills/);
  assert.match(onboarding(tree(1)), /1 skill\)/);
});

test("a tree with five skills is past onboarding", () => {
  assert.equal(onboarding(tree(5)), "");
});

import { notAnAnswer } from "../src/session.ts";

test("idk and friends are not answers the wizard can comment on", () => {
  for (const r of ["idk", "IDK", "i dont know", "I don't know.", "no idea", "?", "??", "what do you mean?", "not sure"]) {
    assert.equal(notAnAnswer(r), true, r);
  }
});

test("a real answer that mentions not knowing still goes to the wizard", () => {
  assert.equal(notAnAnswer("not sure, maybe a lock file?"), false);
  assert.equal(notAnAnswer("index 1"), false);
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

test("the stage flips back like alt-tab, and a long reply opens on it", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand", process.cwd());
  s.openFile("package.json");
  s.say("short");
  assert.equal(s.getSnapshot().stage.kind, "code");
  s.say("x".repeat(400));
  assert.equal(s.getSnapshot().stage.kind, "reply");
  s.flipStage();
  assert.equal(s.getSnapshot().stage.kind, "code");
  s.flipStage();
  assert.equal(s.getSnapshot().stage.kind, "reply");
  // The middle pages between code only: the file and the shell.
  s.flipStage();
  s.pageStage(1);
  assert.equal(s.getSnapshot().stage.kind, "shell");
  assert.equal(s.getSnapshot().middle, "shell");
  s.pageStage(1);
  assert.equal(s.getSnapshot().stage.kind, "code");
});

test("holes a write would add are counted, not the ones already there", async () => {
  const { newHoles } = await import("../src/session.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(`${tmpdir()}/dum-holes-`);
  const hole = (n: string) => `// TODO(dum): ${n}\n// does ${n}\n\n`;
  assert.equal(newHoles(root, "Write", { file_path: "a.cpp", content: hole("a") + hole("b") + hole("c") }), 3);
  writeFileSync(`${root}/a.cpp`, hole("a"));
  assert.equal(newHoles(root, "Write", { file_path: "a.cpp", content: hole("a") + hole("b") }), 1);
  assert.equal(newHoles(root, "Edit", { old_string: "x", new_string: hole("z") }), 1);
  assert.equal(newHoles(root, "Read", {}), 0);
});

test("a hole handed to them can't be rewritten; one still being shaped can", async () => {
  const { erasesHole } = await import("../src/session.ts");
  const edit = { old_string: "// TODO(dum): vector growth\n// grow it", new_string: "grow();" };
  assert.ok(erasesHole("/", "Edit", edit, ["vector growth"]));
  assert.ok(!erasesHole("/", "Edit", edit, ["something else"]));
  assert.ok(erasesHole("/", "Edit", edit), "no list: every hole is protected");
});

test("the spec is laid out by dum from one-line fields", async () => {
  const { specCard } = await import("../src/session.ts");
  const { markdown, printable } = await import("../src/lines.ts");
  const card = specCard({
    summary: "a tiny\nvector that prints when it grows",
    you_type: ["vec.cpp: grow the buffer | keep the elements"],
    decisions: ["copying is blocked"],
    not_doing: [],
    run: "c++ vec.cpp && ./vec",
  });
  assert.equal(card, "**a tiny vector that prints when it grows**\n\n## you type\n- vec.cpp: grow the buffer / keep the elements\n\n## you decided\n- copying is blocked\n\n## run\n- `c++ vec.cpp && ./vec`");
  const shown = markdown(card, 60).map(printable);
  assert.ok(shown.every((l) => !/[#*|`]/.test(l)), "nothing raw reaches the screen");
});

test("gaps per request grow with the level: one the first time in a language", async () => {
  const { holesAllowed } = await import("../src/session.ts");
  assert.equal(holesAllowed({ name: "novice", count: 0, gap: 3, scaffold: true }), 1);
  assert.equal(holesAllowed({ name: "novice", count: 2, gap: 3, scaffold: true }), 2);
  assert.equal(holesAllowed({ name: "developing", count: 5, gap: 8, scaffold: true }), 3);
  assert.equal(holesAllowed({ name: "fluent", count: 12, gap: Infinity, scaffold: false }), 4);
});

test("a question put back after a side question counts as a re-ask", async () => {
  const { reasks } = await import("../src/session.ts");
  const q = "what should mode([1, 1, 2, 2, 3]) return?";
  assert.ok(reasks(q, "right now it's just mean. so for a tie like mode([1, 1, 2, 2, 3]), what should come back? return one?"));
  assert.ok(reasks(q, q));
  assert.ok(!reasks(q, "should an empty list raise, or return None?"));
  assert.ok(!reasks("", q));
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
  s.setTodos([{ concept: "if/else", path: "guess.cpp" }]);
  void s.askNext();
  const text = thread(s.getSnapshot(), 40).map((l) => printable(l.text));
  assert.ok(text.some((l) => l.includes("g++")), "earlier messages stay");
  assert.ok(text.some((l) => l === "› done"), "your reply shows");
  assert.ok(text.some((l) => l.includes("is 30 bigger than 50?")));
  assert.match(text[text.length - 2]!, /your turn: if\/else in guess\.cpp/);
});

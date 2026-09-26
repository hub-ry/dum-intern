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

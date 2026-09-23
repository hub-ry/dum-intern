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

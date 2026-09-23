// What reaches the margin. A pass that leaks through shows the wizard thinking
// out loud, and a nudge that opens with the answer does the thinking for you -
// both are worse than silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, opensWithQuestion } from "../src/wizard.ts";

test("a tagged fact comes through", () => {
  assert.equal(parse("fact: that's a lease."), "that's a lease.");
  assert.equal(parse('"fact: that\'s a lease."'), "that's a lease.");
});

test("an untagged line is a format break, and dropped", () => {
  assert.equal(parse("actually backwards - `..=` is the inclusive one."), null);
});

test("pass is a pass", () => {
  assert.equal(parse("pass"), null);
  assert.equal(parse("  Pass.  "), null);
  assert.equal(parse(""), null);
  assert.equal(parse("fact:"), null);
});

test("reasoning followed by pass is a pass", () => {
  // Verbatim from a real session.
  const raw =
    "range in rust needs `..=10` for inclusive, but that's a detail they'll hit immediately when 10 doesn't print - not worth interrupting for.\n\npass";
  assert.equal(parse(raw), null);
});

test("two paragraphs is never a quip", () => {
  assert.equal(parse("fact: that's a lease.\n\nalso a heartbeat."), null);
});

test("a word merely containing pass is fine", () => {
  assert.equal(parse("fact: that's a bypass cache."), "that's a bypass cache.");
  assert.equal(parse("fact: nginx can passthrough the header."), "nginx can passthrough the header.");
});

test("a line opening with inline code keeps its backtick", () => {
  assert.equal(parse("fact: `..=` is the inclusive one."), "`..=` is the inclusive one.");
});

test("a line wrapped in quotes loses them", () => {
  assert.equal(parse("fact: `that's a lease`"), "that's a lease");
});

test("an em dash becomes a plain dash", () => {
  assert.equal(
    parse("fact: that's a lease \u2014 sqs calls it a visibility timeout."),
    "that's a lease - sqs calls it a visibility timeout.",
  );
});

test("a nudge that opens with its question comes through", () => {
  assert.equal(
    parse("nudge: what does 0.1 + 0.2 give you as a float? money usually lives in integer cents."),
    "what does 0.1 + 0.2 give you as a float? money usually lives in integer cents.",
  );
});

test("a nudge that opens with the answer is dropped", () => {
  // Verbatim shape from an eval run.
  assert.equal(parse("nudge: wait, `1..=10` is inclusive - `1..10` stops at 9. is that what you meant?"), null);
});

test("a dot inside a number does not end the first sentence", () => {
  assert.ok(opensWithQuestion("what's $10.00 split three ways, summed back up? integer cents."));
  assert.ok(opensWithQuestion("what does 0.1 + 0.2 give you? not 0.3."));
  assert.ok(!opensWithQuestion("floats drift. what does 0.1 + 0.2 give you?"));
  assert.ok(!opensWithQuestion("no question here at all"));
});

test("a sources list after a searched line is stripped, not a reason to drop it", () => {
  // Verbatim shape from a real run: the search tool asks for sources.
  const raw =
    "fact: opus 5.5 came out september 22 - $4/$20 per million tokens, cheaper than opus 5.\n\nSources:\n- [Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)";
  assert.equal(parse(raw), "opus 5.5 came out september 22 - $4/$20 per million tokens, cheaper than opus 5.");
});

test("a markdown link inside a line keeps its words", () => {
  assert.equal(
    parse("fact: that's a lease - [sqs](https://aws.amazon.com/sqs/) calls it a visibility timeout."),
    "that's a lease - sqs calls it a visibility timeout.",
  );
});

test("a line that mentions sources mid-sentence is left alone", () => {
  assert.equal(parse("fact: kafka keeps sources of truth in a log."), "kafka keeps sources of truth in a log.");
});

// The checker's reply is parsed in code, and two of its rules live here rather
// than in its prompt.
import { judge } from "../src/checker.ts";

test("a clean ok passes", () => {
  assert.equal(judge("said: right\nline: ok", "fact").ok, true);
});

test("a drop carries its reason", () => {
  const j = judge("said: no claim\nline: drop: wrong name, that's a lease", "fact");
  assert.equal(j.ok, false);
  assert.equal(j.reason, "wrong name, that's a lease");
});

test("a fact on a wrong answer is dropped even if the checker says ok", () => {
  assert.equal(judge("said: wrong\nline: ok", "fact").ok, false);
});

test("a nudge on a choice the checker calls right still passes", () => {
  // "i'll store the amounts as floats" contains no false claim, so the checker
  // says right - and the nudge about it is the whole point.
  assert.equal(judge("said: right\nline: ok", "nudge").ok, true);
});

test("a nudge on a wrong answer can pass", () => {
  assert.equal(judge("said: wrong\nline: ok", "nudge").ok, true);
});

test("a reply that is neither ok nor drop is a drop", () => {
  assert.equal(judge("hmm, hard to say", "fact").ok, false);
});

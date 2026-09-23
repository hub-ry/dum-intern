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

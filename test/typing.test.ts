// An Enter that arrives in the same chunk as the text before it must still
// submit. Reproduced end to end first: `tmux send-keys "print hi" Enter` left
// the request sitting in the field.

import { test } from "node:test";
import assert from "node:assert/strict";
import { typed, pasted } from "../src/typing.ts";

const empty = { value: "", at: 0 };

test("plain typing inserts at the cursor", () => {
  assert.deepEqual(typed({ value: "ac", at: 1 }, "b"), { field: { value: "abc", at: 2 }, submit: [] });
});

test("text and an Enter in one chunk submits it", () => {
  assert.deepEqual(typed(empty, "print hi in python\r"), {
    field: empty,
    submit: ["print hi in python"],
  });
});

test("the chunk joins what was already typed", () => {
  assert.deepEqual(typed({ value: "print ", at: 6 }, "hi\n").submit, ["print hi"]);
});

test("text after the Enter stays in the field", () => {
  assert.deepEqual(typed(empty, "y\rnext thing"), {
    field: { value: "next thing", at: 10 },
    submit: ["y"],
  });
});

test("two Enters submit twice", () => {
  assert.deepEqual(typed(empty, "a\r\nb\r").submit, ["a", "b"]);
});

test("a paste never submits and flattens its line breaks", () => {
  assert.deepEqual(pasted(empty, "first line\nsecond line\n"), { value: "first line second line", at: 22 });
});

test("a paste lands at the cursor", () => {
  assert.deepEqual(pasted({ value: "ab", at: 1 }, "XY"), { value: "aXYb", at: 3 });
});

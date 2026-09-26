import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { hole, load, save, untouched, wantsToType, type Todo } from "../src/todos.ts";

test("type it, in the ways people say it", () => {
  for (const s of ["type it", "Type it.", "i'll type it", "let me type it myself", "type", "I want to type this"]) {
    assert.ok(wantsToType(s), s);
  }
});

test("an answer that mentions typing is still an answer", () => {
  for (const s of ["type it as a string", "the type is u32", "typed", "idk", ""]) {
    assert.ok(!wantsToType(s), s);
  }
});

test("finds the hole for the concept, else any hole", () => {
  const src = ["a", "// TODO(dum): retries with backoff", "b", "# TODO(dum): http status codes"].join("\n");
  assert.equal(hole(src, "http status codes"), 3);
  assert.equal(hole(src, "Retries with backoff"), 1);
  assert.equal(hole(src, "something else"), 1);
  assert.equal(hole("nothing here", "x"), -1);
});

const todo = (path: string, before: string): Todo => ({
  concept: path,
  path,
  what: "w",
  breadth: "general",
  requires: [],
  before,
});

test("untouched is exactly-as-left, and a missing file is not untouched", () => {
  const files: Record<string, string> = { a: "same", b: "changed" };
  const got = untouched([todo("a", "same"), todo("b", "orig"), todo("c", "gone")], (p) => files[p] ?? null);
  assert.deepEqual(got.map((t) => t.path), ["a"]);
});

test("round-trips through .dum/todos.json", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-todos-`);
  assert.deepEqual(load(root), []);
  save(root, [todo("x.ts", "body")]);
  assert.deepEqual(load(root), [todo("x.ts", "body")]);
});

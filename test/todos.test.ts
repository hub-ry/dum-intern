import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { hole, load, save, untouched, type Todo } from "../src/todos.ts";

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
  requires: [],
  before,
});

test("untouched is exactly-as-left, and a missing file is not untouched", () => {
  const files: Record<string, string> = { a: "same", b: "changed" };
  const got = untouched([todo("a", "same"), todo("b", "orig"), todo("c", "gone")], (p) => files[p] ?? null);
  assert.deepEqual(got.map((t) => t.path), ["a"]);
});

test("round-trips through .dum/todos.json", (t) => {
  const root = mkdtempSync(`${tmpdir()}/dum-todos-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(load(root), []);
  save(root, [todo("x.ts", "body")]);
  assert.deepEqual(load(root), [todo("x.ts", "body")]);
});

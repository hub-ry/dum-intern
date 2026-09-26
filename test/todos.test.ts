import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fill, hole, load, save, span, spans, untouched, wantsToType, type Todo } from "../src/todos.ts";

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

const py = [
  "def median(xs):",
  "    s = sorted(xs)",
  "    # TODO(dum): median of a sorted list",
  "    # Return the middle value; average the two middles when even.",
  "    raise NotImplementedError",
  "",
  "def mode(xs):",
  "    // not a comment here",
].join("\n");

test("a hole spans its marker, its comment lines, and the stub", () => {
  assert.deepEqual(span(py.split("\n"), 2), [2, 4]);
  assert.deepEqual(span(py.split("\n"), 1), null);
  assert.deepEqual(spans(py), [[2, 4]]);
  const js = ["  // TODO(dum): debounce", "  // wait 300ms after the last call", '  throw new Error("todo");', "}"];
  assert.deepEqual(span(js, 0), [0, 2]);
  // A marker with no stub after it ends at the comment run.
  assert.deepEqual(span(["# TODO(dum): x", "# does y", ""], 0), [0, 1]);
});

test("fill swaps the whole hole for the code and nothing else", () => {
  const out = fill(py, "median of a sorted list", "    n = len(s)\n    return s[n // 2]\n");
  assert.equal(
    out,
    ["def median(xs):", "    s = sorted(xs)", "    n = len(s)", "    return s[n // 2]", "", "def mode(xs):", "    // not a comment here"].join("\n"),
  );
  assert.equal(fill("no holes", "x", "y"), null);
});

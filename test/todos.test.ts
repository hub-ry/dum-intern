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

test("only holes and comments pass: #include is code, not a comment", async () => {
  const { loose, gated } = await import("../src/todos.ts");
  const skeleton = [
    "// vector_lab - watch a std::vector grow",
    "",
    "// TODO(dum): c++ includes",
    "// the headers this file needs for input, output and vectors",
    "",
    "// TODO(dum): main loop",
    "// read commands until quit and run them on the vector",
    "int main() { return 0; }",
  ].join("\n");
  assert.deepEqual(loose(skeleton, "cpp/vector_lab.cpp"), []);
  const written = "#include <iostream>\n#include <vector>\n\nint main() {\n  std::vector<int> v;\n}\n";
  assert.deepEqual(loose(written, "vector_lab.cpp"), ["#include <iostream>", "#include <vector>", "int main() {", "  std::vector<int> v;", "}"]);
  // Python: a comment is a comment, an import is code.
  assert.deepEqual(loose("# a comment\nimport re\n", "a.py"), ["import re"]);
  assert.deepEqual(loose("# TODO(dum): regex search\n# find the ip\nraise NotImplementedError\n", "a.py"), []);
  // Not source: not gated.
  assert.ok(!gated("README.md") && !gated("notes.txt") && gated("Makefile") && gated("x.rs"));
  assert.deepEqual(loose("anything goes", "README.md"), []);
});

test("the gate names the loose lines of any Write, Edit or MultiEdit to source", async () => {
  const { looseCode } = await import("../src/session.ts");
  assert.deepEqual(looseCode("Write", { file_path: "a.py", content: "print('hi')\n" }), ["print('hi')"]);
  assert.deepEqual(looseCode("Edit", { file_path: "a.py", old_string: "x", new_string: "# just a comment" }), []);
  assert.deepEqual(looseCode("MultiEdit", { file_path: "a.go", edits: [{ new_string: "// ok" }, { new_string: "fmt.Println(1)" }] }), ["fmt.Println(1)"]);
  assert.deepEqual(looseCode("Write", { file_path: "notes.md", content: "print('hi')" }), []);
});

test("comment runs over three lines are too long, a hole's heading starts a new run", async () => {
  const { wordy } = await import("../src/todos.ts");
  const essay = "// one\n// two\n// three\n// four\nint x;\n";
  assert.deepEqual(wordy(essay, "a.cpp"), ["// one"]);
  const hole = "// header line\n\n// TODO(dum): x\n// what it does\n// the edge case\nint y;\n";
  assert.deepEqual(wordy(hole, "a.cpp"), []);
  assert.deepEqual(wordy("# a\n# b\n# c\n# d\n", "a.py"), ["# a"]);
  assert.deepEqual(wordy(essay, "notes.md"), []);
});

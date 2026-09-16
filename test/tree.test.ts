import { test } from "node:test";
import assert from "node:assert/strict";
import { build, rows, initialOpen } from "../src/tree.ts";

const files = ["src/panes/App.tsx", "src/store.ts", "README.md", "bin/dum", "src/panes/Code.tsx"];

test("nests paths and keeps directories above files", () => {
  const root = build(files);
  assert.deepEqual(
    root.children.map((c) => `${c.dir ? "d" : "f"}:${c.name}`),
    ["d:bin", "d:src", "f:README.md"],
  );
});

test("a directory and a file can share a name without merging", () => {
  const root = build(["x", "x/y"]);
  assert.equal(root.children.length, 2);
  assert.deepEqual(root.children.map((c) => c.dir), [true, false]);
});

test("collapsed directories hide their contents", () => {
  const root = build(files);
  const shut = rows(root, new Set());
  assert.deepEqual(shut.map((r) => r.node.path), ["bin", "src", "README.md"]);
});

test("expanding shows children at the next depth", () => {
  const root = build(files);
  const open = rows(root, new Set(["src"]));
  assert.deepEqual(
    open.map((r) => `${r.depth}:${r.node.path}`),
    ["0:bin", "0:src", "1:src/panes", "1:src/store.ts", "0:README.md"],
  );
});

test("single-child directory chains start expanded", () => {
  const root = build(["a/b/c/deep.ts", "top.ts"]);
  const open = initialOpen(root);
  assert.ok(open.has("a") && open.has("a/b"));
  assert.deepEqual(
    rows(root, open).map((r) => r.node.path),
    ["a", "a/b", "a/b/c", "top.ts"],
  );
});

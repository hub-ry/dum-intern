import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, read, DEFAULT, type Node } from "../src/layout.ts";

const box = { x: 0, y: 0, width: 100, height: 30 };

test("fixed sizes are honoured and the rest is shared", () => {
  const l: Node = {
    direction: "row",
    children: [{ pane: "tree", size: 20 }, { pane: "chat", flex: 1 }, { pane: "code", flex: 1 }],
  };
  const p = allocate(l, box);
  assert.deepEqual(p.map((x) => x.width), [20, 39, 39]);
  // 20 + 39 + 39 + 2 dividers = 100: the row is filled exactly.
  assert.equal(p.reduce((a, x) => a + x.width, 0) + 2, 100);
});

test("uneven shares still fill the row exactly", () => {
  const l: Node = {
    direction: "row",
    children: [{ pane: "chat", flex: 1 }, { pane: "code", flex: 1 }, { pane: "cast", flex: 1 }],
  };
  const p = allocate(l, { ...box, width: 50 });
  assert.equal(p.reduce((a, x) => a + x.width, 0) + 2, 50);
});

test("panes are placed left to right in order", () => {
  const p = allocate(DEFAULT, box);
  assert.deepEqual(p.map((x) => x.pane), ["tree", "code", "cast"]);
  for (let i = 1; i < p.length; i++) assert.ok(p[i]!.x > p[i - 1]!.x);
});

test("the default fills the terminal exactly", () => {
  for (const width of [80, 100, 133, 200]) {
    const p = allocate(DEFAULT, { ...box, width });
    const used = p.reduce((a, x) => a + x.width, 0) + (p.length - 1);
    assert.equal(used, width, `default layout leaves dead space at ${width} columns`);
  }
});

test("a column splits height instead of width", () => {
  const l: Node = {
    direction: "column",
    children: [{ pane: "code", flex: 1 }, { pane: "cast", size: 10 }],
  };
  const p = allocate(l, box);
  assert.deepEqual(p.map((x) => x.height), [19, 10]);
  assert.deepEqual(p.map((x) => x.width), [100, 100]);
});

test("nested splits work", () => {
  const l: Node = {
    direction: "row",
    children: [
      { pane: "chat", flex: 1 },
      { direction: "column", children: [{ pane: "code", flex: 1 }, { pane: "cast", size: 9 }] },
    ],
  };
  const p = allocate(l, box);
  assert.deepEqual(p.map((x) => x.pane), ["chat", "code", "cast"]);
  assert.equal(p[1]!.height + p[2]!.height + 1, 30);
});

test("a fixed size wider than the row does not go negative", () => {
  const l: Node = {
    direction: "row",
    children: [{ pane: "tree", size: 500 }, { pane: "chat", flex: 1 }],
  };
  const p = allocate(l, box);
  assert.ok(p.every((x) => x.width >= 0));
});

test("a missing or broken config falls back instead of throwing", () => {
  assert.deepEqual(read("/nope/not/a/dir"), DEFAULT);
});

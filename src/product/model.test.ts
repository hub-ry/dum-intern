import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBuild,
  defaultDraft,
  emptyTree,
  flattenDraft,
  hints,
  markRead,
  MAX_STACK,
  parseOutline,
  parseTree,
  ProductError,
  swearSkill,
  type Tree,
} from "./model.ts";

const at = "2026-10-23T04:00:00.000Z";

function workspace() {
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const goal = { id: ids(), title: "Clothing recommender", aim: "Rank items I would keep.", createdAt: at };
  const skills = flattenDraft(goal.id, defaultDraft(goal.title, goal.aim), null, ids);
  return { goal, tree: { version: 1 as const, goals: [goal], skills, builds: [] } };
}

test("an indented outline becomes a tree", () => {
  const nodes = parseOutline("vectors\n  distance\n    rank\nratings\n  taste");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].children[0].children[0].title, "rank");
  assert.equal(nodes[1].children[0].title, "taste");
});

test("a bad indent is refused", () => {
  assert.throws(() => parseOutline("vectors\n    distance"), ProductError);
});

test("the last page unlocks a block, and a swear skips the reading", () => {
  const { tree, goal } = workspace();
  const first = tree.skills.find((s) => s.title === "The smallest piece")!;
  assert.throws(() => markRead(tree, first.id, 1, 2, at), ProductError);
  const read = markRead(tree, first.id, 2, 2, at);
  assert.equal(read.skills.find((s) => s.id === first.id)?.unlock?.kind, "read");
  const child = read.skills.find((s) => s.parentId === first.id)!;
  const sworn = swearSkill(read, child.id, "I swear I can check this by hand.", at);
  assert.equal(sworn.skills.find((s) => s.id === child.id)?.unlock?.kind, "sworn");
  const built = addBuild(sworn, {
    id: "00000000-0000-4000-8000-000000000099",
    goalId: goal.id,
    title: "A tiny ranker",
    blockIds: [first.id, child.id],
    createdAt: at,
  });
  assert.equal(built.builds[0].blockIds.length, 2);
});

test("a locked block cannot be stacked", () => {
  const { tree, goal } = workspace();
  assert.throws(() => addBuild(tree, {
    id: "00000000-0000-4000-8000-000000000099",
    goalId: goal.id,
    title: "Too soon",
    blockIds: [tree.skills[0].id],
    createdAt: at,
  }), /locked/);
});

test("hints offer the next reading and a stack of what is unlocked", () => {
  const { tree } = workspace();
  const parent = tree.skills.find((s) => s.title === "The smallest piece");
  assert.ok(parent);
  const opened = markRead(tree, parent.id, 1, 1, at);
  const hint = hints(opened, opened.goals[0].id);
  assert.ok(hint.learn.some((item) => item.parentTitle === "The smallest piece"));
  assert.ok(hint.build.some((item) => item.blockIds[0] === parent.id));
});

test("a saved tree round-trips", () => {
  const { tree } = workspace();
  assert.equal(parseTree(tree).skills.length, tree.skills.length);
  assert.equal(parseTree(emptyTree()).goals.length, 0);
  assert.throws(() => parseTree({ version: 2, goals: [], skills: [], builds: [] }), ProductError);
});

test("regression: outlines reject invalid text before constructing blocks", () => {
  assert.equal(parseOutline("x".repeat(80))[0].title.length, 80);
  assert.throws(() => parseOutline("x".repeat(81)), ProductError);
  for (const outline of [" root", "root\n child", "root\n   child", "root\n  child\n     leaf"]) {
    assert.throws(() => parseOutline(outline), ProductError);
  }
  assert.equal(parseOutline("root\n  child")[0].children[0].title, "child");
});

test("regression: editable trees reject duplicate identities and cyclic ancestry", () => {
  const { tree, goal } = workspace();
  const unlocked = swearSkill(tree, tree.skills[0].id, "I can explain this block.", at);
  const build = {
    id: "00000000-0000-4000-8000-000000000099",
    goalId: goal.id,
    title: "Build",
    blockIds: [tree.skills[0].id],
    createdAt: at,
  };
  const built = addBuild(unlocked, build);
  for (const collection of ["goals", "skills", "builds"] as const) {
    assert.throws(() => parseTree({ ...built, [collection]: [...built[collection], built[collection][0]] }), /duplicate/);
  }
  const root = tree.skills.find((s) => s.title === "The smallest piece")!;
  const child = tree.skills.find((s) => s.parentId === root.id)!;
  for (const parentId of [root.id, child.id]) {
    assert.throws(() => parseTree({ ...tree, skills: tree.skills.map((s) => s.id === root.id ? { ...s, parentId } : s) }), /cyclic/);
  }
  assert.equal(parseTree(built).builds.length, 1);
});

test("regression: every suggested stack can be saved within the build limit", () => {
  const { goal } = workspace();
  let n = 100;
  const skills = flattenDraft(goal.id, parseOutline(Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}Block ${i}`).join("\n")), null, () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
  let tree: Tree = { version: 1, goals: [goal], skills, builds: [] };
  for (const [index, skill] of skills.entries()) {
    tree = markRead(tree, skill.id, 1, 1, at);
    const suggestions = hints(tree, goal.id).build;
    if (index < MAX_STACK) assert.equal(suggestions.length, 1);
    for (const hint of suggestions) {
      assert.ok(hint.blockIds.length <= MAX_STACK);
      const built = addBuild(tree, { id: "00000000-0000-4000-8000-000000000099", goalId: goal.id, title: "Suggested build", blockIds: hint.blockIds, createdAt: at });
      assert.deepEqual(parseTree(built).builds[0].blockIds, hint.blockIds);
    }
  }
  assert.throws(() => addBuild(tree, { id: "00000000-0000-4000-8000-000000000099", goalId: goal.id, title: "Too many", blockIds: skills.slice(0, MAX_STACK + 1).map((s) => s.id), createdAt: at }), /at most/);
});

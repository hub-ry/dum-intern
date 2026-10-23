import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBuild,
  defaultDraft,
  emptyTree,
  flattenDraft,
  hints,
  markRead,
  parseOutline,
  parseTree,
  ProductError,
  swearSkill,
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

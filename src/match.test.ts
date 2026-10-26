import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, commandGap, refusal } from "./match.ts";
import { seedNodes } from "./seed.ts";
import type { NodeStatus, SkillNode } from "./types.ts";

function tree(statuses: Record<string, NodeStatus> = {}): SkillNode[] {
  return seedNodes().map((node) => ({ ...node, status: statuses[node.id] ?? node.status }));
}

test("the seed is a small prerequisite tree", () => {
  const nodes = seedNodes();
  assert.ok(nodes.length >= 10 && nodes.length <= 15);
  const ids = new Set(nodes.map((node) => node.id));
  assert.equal(ids.size, nodes.length);
  const walk = (id: string, stack: string[]) => {
    assert.ok(!stack.includes(id), `cycle at ${id}`);
    const node = nodes.find((item) => item.id === id);
    assert.ok(node);
    for (const pre of node.prereqs) {
      assert.ok(ids.has(pre));
      walk(pre, [...stack, id]);
    }
  };
  for (const node of nodes) walk(node.id, []);
});

test("a branch task names the locked branching node", () => {
  const nodes = tree({ "terminal-basics": "unlocked" });
  const decision = classify("create a git branch called feature", nodes);
  assert.equal(decision.kind, "blocked");
  if (decision.kind !== "blocked") return;
  assert.equal(decision.node.id, "git-branching");
  assert.match(refusal(decision.node, nodes, decision.also), /The missing node is Git branching/);
});

test("listing files is allowed once the terminal is taught", () => {
  const locked = classify("list the files in the home directory", tree());
  assert.equal(locked.kind, "blocked");
  if (locked.kind === "blocked") assert.equal(locked.node.id, "terminal-basics");

  const open = classify("list the files in the home directory", tree({ "terminal-basics": "unlocked" }));
  assert.equal(open.kind, "task");
  if (open.kind === "task") assert.deepEqual(open.skills.map((skill) => skill.id), ["terminal-basics"]);
});

test("questions are not tasks", () => {
  assert.equal(classify("what can you do?", tree()).kind, "chat");
  assert.equal(classify("how does git branching work?", tree()).kind, "chat");
});

test("kubernetes is proposed instead of attempted", () => {
  const decision = classify("set up kubernetes for the app", tree());
  assert.equal(decision.kind, "propose");
  if (decision.kind === "propose") assert.equal(decision.proposal.id, "kubernetes");
});

test("a shell command for a locked skill is refused", () => {
  const gap = commandGap("docker ps", tree({ "terminal-basics": "unlocked" }));
  assert.equal(gap?.title, "Docker basics");
  assert.equal(commandGap("ls -la", tree({ "terminal-basics": "unlocked" })), null);
  assert.equal(commandGap("ls -la", tree())?.title, "Terminal basics");
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "./store.ts";

test("regression: workspace mutations preserve malformed trees and unrelated build files", async (t) => {
  const dir = await mkdtemp(join(process.cwd(), ".store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const account = await store.ensureAccount(7, "alice");
  const workspace = await store.workspace(account);
  let tree = await store.createGoal(account, "First goal", "Build a tiny example", "root\n  child");
  const skill = tree.skills[0];
  tree = await store.swear(account, skill.id, "I can explain this block.");
  tree = await store.build(account, tree.goals[0].id, "First build", [skill.id]);
  const buildPath = join(workspace, "builds", `${tree.builds[0].id}.json`);
  const savedBuild = await readFile(buildPath, "utf8");
  const goalPath = join(workspace, "goal.md");
  const savedGoals = await readFile(goalPath, "utf8");
  const treePath = join(workspace, "tree.json");
  const savedTree = await readFile(treePath, "utf8");
  const malformed = "{ invalid JSON";
  await writeFile(treePath, malformed);
  const operations = [
    () => store.tree(account),
    () => store.createGoal(account, "Second goal", "Keep my original data", "root"),
    () => store.readSkill(account, skill.id, 1, 1),
    () => store.swear(account, skill.id, "I can explain this block."),
    () => store.build(account, tree.goals[0].id, "Another build", [skill.id]),
    () => store.readingPdf(account, skill.id),
  ];
  for (const operation of operations) {
    await assert.rejects(operation);
    assert.equal(await readFile(treePath, "utf8"), malformed);
    assert.equal(await readFile(buildPath, "utf8"), savedBuild);
    assert.equal(await readFile(goalPath, "utf8"), savedGoals);
  }
  await rm(treePath);
  await mkdir(treePath);
  for (const operation of operations) await assert.rejects(operation);
  await rm(treePath, { recursive: true });
  await writeFile(treePath, savedTree);
  const notePath = join(workspace, "builds", "README.md");
  const nestedPath = join(workspace, "builds", "notes", "draft.md");
  await mkdir(join(workspace, "builds", "notes"));
  await writeFile(notePath, "My build notes");
  await writeFile(nestedPath, "Unfinished idea");
  await store.createGoal(account, "Second goal", "Preserve my files", "root");
  await store.readSkill(account, tree.skills[1].id, 1, 1);
  await store.build(account, tree.goals[0].id, "Second build", [skill.id]);
  assert.equal(await readFile(notePath, "utf8"), "My build notes");
  assert.equal(await readFile(nestedPath, "utf8"), "Unfinished idea");
  assert.equal((await store.tree(account)).goals.length, 2);
  assert.equal((await store.tree(account)).builds.length, 2);
});

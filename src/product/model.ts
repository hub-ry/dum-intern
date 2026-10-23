// The Dum workspace: goals, a skill tree, readings that unlock blocks, and builds
// that stack unlocked blocks in an order the person chose.

import { z } from "zod";

export const MAX_TITLE = 80;
export const MAX_AIM = 2000;
export const MAX_SWEAR = 500;
export const MAX_OUTLINE = 8000;

const Id = z.string().uuid();

export const Unlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), at: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("sworn"), at: z.string().min(1).max(40), text: z.string().min(1).max(MAX_SWEAR) }),
]);
export type Unlock = z.infer<typeof Unlock>;

export const Goal = z.object({
  id: Id,
  title: z.string().min(1).max(MAX_TITLE),
  aim: z.string().min(1).max(MAX_AIM),
  createdAt: z.string().min(1).max(40),
});
export type Goal = z.infer<typeof Goal>;

export const Skill = z.object({
  id: Id,
  goalId: Id,
  parentId: Id.nullable(),
  title: z.string().min(1).max(MAX_TITLE),
  summary: z.string().min(1).max(MAX_AIM),
  reading: z.string().regex(/^readings\/[0-9a-f-]{36}\.tex$/),
  unlock: Unlock.nullable(),
});
export type Skill = z.infer<typeof Skill>;

export const Build = z.object({
  id: Id,
  goalId: Id,
  title: z.string().min(1).max(MAX_TITLE),
  blockIds: z.array(Id).min(1).max(24),
  createdAt: z.string().min(1).max(40),
});
export type Build = z.infer<typeof Build>;

export const Tree = z.object({
  version: z.literal(1),
  goals: z.array(Goal).max(40),
  skills: z.array(Skill).max(200),
  builds: z.array(Build).max(80),
});
export type Tree = z.infer<typeof Tree>;

export class ProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductError";
  }
}

export function emptyTree(): Tree {
  return { version: 1, goals: [], skills: [], builds: [] };
}

export function parseTree(value: unknown): Tree {
  const parsed = Tree.safeParse(value);
  if (!parsed.success) throw new ProductError("tree.json is not a Dum workspace.");
  const tree = parsed.data;
  const goals = new Set(tree.goals.map((g) => g.id));
  const skills = new Set(tree.skills.map((s) => s.id));
  for (const skill of tree.skills) {
    if (!goals.has(skill.goalId)) throw new ProductError(`block ${skill.title} points at a missing goal.`);
    if (skill.parentId !== null && !skills.has(skill.parentId)) throw new ProductError(`block ${skill.title} points at a missing parent.`);
    if (skill.parentId !== null) {
      const parent = tree.skills.find((s) => s.id === skill.parentId);
      if (parent && parent.goalId !== skill.goalId) throw new ProductError(`block ${skill.title} sits under a different goal.`);
    }
  }
  for (const build of tree.builds) {
    if (!goals.has(build.goalId)) throw new ProductError(`build ${build.title} points at a missing goal.`);
    checkStack(tree, build.goalId, build.blockIds, false);
  }
  return tree;
}

export type DraftNode = { title: string; summary: string; children: DraftNode[] };

/** Indent with two spaces per level. Blank lines are skipped. */
export function parseOutline(text: string): DraftNode[] {
  const lines = text.split("\n").map((line) => line.replace(/\t/g, "  ")).filter((line) => line.trim() !== "");
  if (lines.length > 40) throw new ProductError("An outline can have at most 40 blocks.");
  const roots: DraftNode[] = [];
  const stack: { depth: number; node: DraftNode }[] = [];
  for (const line of lines) {
    const depth = Math.floor((line.length - line.trimStart().length) / 2);
    const title = line.trim().slice(0, MAX_TITLE);
    if (!title) throw new ProductError("An outline line is empty.");
    if (title.length > MAX_TITLE) throw new ProductError(`"${title.slice(0, 24)}" is too long for a block name.`);
    const node: DraftNode = { title, summary: title, children: [] };
    if (depth === 0) {
      roots.push(node);
      stack.length = 0;
      stack.push({ depth, node });
      continue;
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent || parent.depth !== depth - 1) throw new ProductError(`"${title}" is indented past its parent.`);
    parent.node.children.push(node);
    stack.push({ depth, node });
  }
  if (roots.length === 0) throw new ProductError("The outline has no blocks.");
  return roots;
}

export function defaultDraft(title: string, aim: string): DraftNode[] {
  const short = title.trim();
  return [
    { title: "What this is", summary: aim, children: [] },
    {
      title: "The smallest piece",
      summary: `The smallest piece of ${short} you can check by hand.`,
      children: [{ title: "Check it by hand", summary: `Do one step of ${short} on an input small enough to check.`, children: [] }],
    },
    {
      title: "The next piece",
      summary: `A second piece of ${short}, still small.`,
      children: [{ title: "Stack the pieces", summary: `Use the two pieces of ${short} together, in order.`, children: [] }],
    },
  ];
}

export function flattenDraft(goalId: string, nodes: DraftNode[], parentId: string | null, ids: () => string): Skill[] {
  const out: Skill[] = [];
  for (const node of nodes) {
    const id = ids();
    out.push({
      id,
      goalId,
      parentId,
      title: node.title,
      summary: node.summary,
      reading: `readings/${id}.tex`,
      unlock: null,
    });
    out.push(...flattenDraft(goalId, node.children, id, ids));
  }
  return out;
}

export function skillById(tree: Tree, id: string): Skill {
  const skill = tree.skills.find((s) => s.id === id);
  if (!skill) throw new ProductError("That block is not in this Dum.");
  return skill;
}

export function goalById(tree: Tree, id: string): Goal {
  const goal = tree.goals.find((g) => g.id === id);
  if (!goal) throw new ProductError("That goal is not in this Dum.");
  return goal;
}

export function isUnlocked(skill: Skill): boolean {
  return skill.unlock !== null;
}

/** Reading unlocks the block. A sworn block stays sworn. */
export function markRead(tree: Tree, skillId: string, page: number, pages: number, at: string): Tree {
  if (!Number.isInteger(page) || !Number.isInteger(pages) || pages < 1 || page !== pages) {
    throw new ProductError("The reading unlocks when you are on its last page.");
  }
  const skill = skillById(tree, skillId);
  if (skill.unlock) return tree;
  return replaceSkill(tree, { ...skill, unlock: { kind: "read", at } });
}

export function swearSkill(tree: Tree, skillId: string, text: string, at: string): Tree {
  const said = text.trim();
  if (said.length < 12) throw new ProductError("Say what you know, in a sentence.");
  if (said.length > MAX_SWEAR) throw new ProductError("That swear is too long.");
  const skill = skillById(tree, skillId);
  if (skill.unlock?.kind === "read") return tree;
  if (skill.unlock?.kind === "sworn") return tree;
  return replaceSkill(tree, { ...skill, unlock: { kind: "sworn", at, text: said } });
}

export function checkStack(tree: Tree, goalId: string, blockIds: string[], requireUnlocked = true): void {
  if (blockIds.length === 0) throw new ProductError("A build needs at least one block.");
  if (new Set(blockIds).size !== blockIds.length) throw new ProductError("A block can only appear once in a stack.");
  for (const id of blockIds) {
    const skill = skillById(tree, id);
    if (skill.goalId !== goalId) throw new ProductError(`${skill.title} belongs to a different goal.`);
    if (requireUnlocked && !isUnlocked(skill)) throw new ProductError(`${skill.title} is still locked. Read it, or swear you know it.`);
  }
}

export function addBuild(tree: Tree, build: Build): Tree {
  goalById(tree, build.goalId);
  checkStack(tree, build.goalId, build.blockIds, true);
  return { ...tree, builds: [build, ...tree.builds] };
}

export type LearnHint = { skillId: string; title: string; parentTitle: string | null };
export type BuildHint = { title: string; blockIds: string[]; blockTitles: string[] };

export function hints(tree: Tree, goalId: string): { learn: LearnHint[]; build: BuildHint[] } {
  goalById(tree, goalId);
  const skills = tree.skills.filter((s) => s.goalId === goalId);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const learn: LearnHint[] = [];
  for (const skill of skills) {
    if (skill.unlock) continue;
    const parent = skill.parentId ? byId.get(skill.parentId) : undefined;
    if (skill.parentId && !parent?.unlock) continue;
    learn.push({ skillId: skill.id, title: skill.title, parentTitle: parent?.title ?? null });
  }
  const build: BuildHint[] = [];
  for (const skill of skills) {
    if (!skill.unlock) continue;
    const childUnlocked = skills.some((s) => s.parentId === skill.id && s.unlock);
    if (childUnlocked) continue;
    const chain: Skill[] = [];
    let cursor: Skill | undefined = skill;
    while (cursor?.unlock) {
      chain.push(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    chain.reverse();
    if (chain.length === 0) continue;
    build.push({
      title: chain.map((s) => s.title).join(" → "),
      blockIds: chain.map((s) => s.id),
      blockTitles: chain.map((s) => s.title),
    });
  }
  return { learn, build };
}

export function childrenOf(tree: Tree, goalId: string, parentId: string | null): Skill[] {
  return tree.skills.filter((s) => s.goalId === goalId && s.parentId === parentId);
}

function replaceSkill(tree: Tree, skill: Skill): Tree {
  return { ...tree, skills: tree.skills.map((s) => (s.id === skill.id ? skill : s)) };
}

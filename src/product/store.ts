// One directory per GitHub account on hub. The Dum they open is a folder
// inside it named `dum`, unless they assign a different root.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addBuild,
  defaultDraft,
  emptyTree,
  flattenDraft,
  markRead,
  parseOutline,
  parseTree,
  ProductError,
  skillById,
  swearSkill,
  type Build,
  type Goal,
  type Tree,
} from "./model.ts";

export type Account = { githubId: number; login: string; root: string };

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "template", "dum");

export function defaultStateDir(): string {
  return process.env.DUM_PRODUCT_STATE?.trim() || join(homedir(), ".local", "state", "dum-product");
}

export class Store {
  private chains = new Map<number, Promise<unknown>>();

  constructor(readonly stateDir: string) {}

  userDir(githubId: number): string {
    return join(this.stateDir, "users", String(githubId));
  }

  async account(githubId: number): Promise<Account | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.userDir(githubId), "account.json"), "utf8")) as Account;
      if (!raw || typeof raw.login !== "string" || typeof raw.root !== "string" || raw.githubId !== githubId) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async ensureAccount(githubId: number, login: string): Promise<Account> {
    return this.locked(githubId, async () => {
      const existing = await this.account(githubId);
      if (existing) return existing;
      const account: Account = { githubId, login, root: "dum" };
      const dir = this.userDir(githubId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeJson(join(dir, "account.json"), account);
      await this.copyTemplate(join(dir, "dum"));
      return account;
    });
  }

  async workspace(account: Account): Promise<string> {
    const path = await this.resolveRoot(account, account.root);
    await this.copyTemplate(path);
    return path;
  }

  async setRoot(account: Account, root: string): Promise<Account> {
    return this.locked(account.githubId, async () => {
      const path = await this.resolveRoot(account, root);
      await this.copyTemplate(path);
      const next = { ...account, root: isAbsolute(root.trim()) ? path : root.trim() || "dum" };
      await writeJson(join(this.userDir(account.githubId), "account.json"), next);
      return next;
    });
  }

  async tree(account: Account): Promise<Tree> {
    const path = join(await this.workspace(account), "tree.json");
    try {
      return parseTree(JSON.parse(await readFile(path, "utf8")));
    } catch (err) {
      if (err instanceof ProductError) throw err;
      return emptyTree();
    }
  }

  async createGoal(account: Account, title: string, aim: string, outline: string): Promise<Tree> {
    return this.locked(account.githubId, async () => {
      const workspace = await this.workspace(account);
      const tree = await this.readTree(workspace);
      const goal: Goal = { id: randomUUID(), title: title.trim(), aim: aim.trim(), createdAt: new Date().toISOString() };
      const nodes = outline.trim() ? parseOutline(outline) : defaultDraft(goal.title, goal.aim);
      const skills = flattenDraft(goal.id, nodes, null, randomUUID);
      let next: Tree = { ...tree, goals: [goal, ...tree.goals], skills: [...tree.skills, ...skills] };
      next = parseTree(next);
      await mkdir(join(workspace, "readings"), { recursive: true, mode: 0o700 });
      for (const skill of skills) {
        const parent = skill.parentId ? skillById(next, skill.parentId) : null;
        await writeJson(join(workspace, "readings", `${skill.id}.brief.json`), {
          goal: goal.title,
          aim: goal.aim,
          title: skill.title,
          summary: skill.summary,
          parent: parent?.title ?? null,
          tex: skill.reading,
          pdf: `readings/pdf/${skill.id}.pdf`,
        });
      }
      await this.persist(workspace, next);
      return next;
    });
  }

  async readSkill(account: Account, skillId: string, page: number, pages: number): Promise<Tree> {
    return this.mutate(account, (tree) => markRead(tree, skillId, page, pages, new Date().toISOString()));
  }

  async swear(account: Account, skillId: string, text: string): Promise<Tree> {
    return this.mutate(account, (tree) => swearSkill(tree, skillId, text, new Date().toISOString()));
  }

  async build(account: Account, goalId: string, title: string, blockIds: string[]): Promise<Tree> {
    return this.mutate(account, (tree) => {
      const build: Build = { id: randomUUID(), goalId, title: title.trim(), blockIds, createdAt: new Date().toISOString() };
      return addBuild(tree, build);
    });
  }

  async readingPdf(account: Account, skillId: string): Promise<{ pdf: string; pages: number; skillTitle: string }> {
    const workspace = await this.workspace(account);
    const tree = await this.readTree(workspace);
    const skill = skillById(tree, skillId);
    const pdf = join(workspace, "readings", "pdf", `${skill.id}.pdf`);
    try {
      await readFile(pdf);
    } catch {
      throw new ProductError(`No paper for ${skill.title} yet. In Cursor, open this Dum folder and ask it to write the paper. The dum-paper skill runs on your machine. This server does not write or compile it.`);
    }
    const pages = await pdfPages(pdf);
    return { pdf, pages, skillTitle: skill.title };
  }

  private async mutate(account: Account, change: (tree: Tree) => Tree): Promise<Tree> {
    return this.locked(account.githubId, async () => {
      const workspace = await this.workspace(account);
      const next = parseTree(change(await this.readTree(workspace)));
      await this.persist(workspace, next);
      return next;
    });
  }

  private async readTree(workspace: string): Promise<Tree> {
    try {
      return parseTree(JSON.parse(await readFile(join(workspace, "tree.json"), "utf8")));
    } catch (err) {
      if (err instanceof ProductError) throw err;
      return emptyTree();
    }
  }

  private async persist(workspace: string, tree: Tree): Promise<void> {
    const checked = parseTree(tree);
    await writeJson(join(workspace, "tree.json"), checked);
    await writeFile(join(workspace, "goal.md"), goalsMarkdown(checked), { mode: 0o600 });
    const buildsDir = join(workspace, "builds");
    await mkdir(buildsDir, { recursive: true, mode: 0o700 });
    const keep = new Set(checked.builds.map((b) => `${b.id}.json`));
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(buildsDir).catch(() => [])) {
      if (!keep.has(name)) await rm(join(buildsDir, name), { force: true });
    }
    for (const build of checked.builds) {
      const skills = build.blockIds.map((id) => skillById(checked, id));
      await writeJson(join(buildsDir, `${build.id}.json`), {
        ...build,
        blocks: skills.map((s) => ({ id: s.id, title: s.title, unlock: s.unlock?.kind ?? null })),
      });
    }
  }

  private async resolveRoot(account: Account, root: string): Promise<string> {
    const trimmed = root.trim();
    if (!trimmed) throw new ProductError("Name the folder, or give a path.");
    const userBase = this.userDir(account.githubId);
    if (isAbsolute(trimmed)) {
      if (account.login !== "hub-ry") throw new ProductError("An absolute root is only available for the hub owner. Use a folder name.");
      const path = resolve(trimmed);
      const home = homedir();
      if (!isInside(home, path)) throw new ProductError("The root has to live under your home directory on hub.");
      const banned = [join(home, ".ssh"), join(home, ".config"), join(home, ".gnupg")];
      if (banned.some((dir) => path === dir || isInside(dir, path))) throw new ProductError("That path is not a Dum root.");
      return path;
    }
    if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.includes("\0")) throw new ProductError("Use a plain folder name.");
    const path = resolve(userBase, trimmed);
    if (!isInside(userBase, path)) throw new ProductError("That folder leaves your Dum.");
    return path;
  }

  private async copyTemplate(dest: string): Promise<void> {
    await mkdir(dest, { recursive: true, mode: 0o700 });
    await mkdir(join(dest, "readings"), { recursive: true, mode: 0o700 });
    await mkdir(join(dest, "builds"), { recursive: true, mode: 0o700 });
    for (const name of ["learn.sty", "README.md"]) {
      const target = join(dest, name);
      try {
        await readFile(target);
      } catch {
        await writeFile(target, await readFile(join(TEMPLATE, name)));
      }
    }
    const readingsSty = join(dest, "readings", "learn.sty");
    try {
      await readFile(readingsSty);
    } catch {
      await writeFile(readingsSty, await readFile(join(TEMPLATE, "learn.sty")));
    }
    try {
      await readFile(join(dest, "tree.json"));
    } catch {
      await writeFile(join(dest, "tree.json"), await readFile(join(TEMPLATE, "tree.json")), { mode: 0o600 });
    }
    try {
      await readFile(join(dest, "goal.md"));
    } catch {
      await writeFile(join(dest, "goal.md"), await readFile(join(TEMPLATE, "goal.md")), { mode: 0o600 });
    }
  }

  private locked<T>(githubId: number, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(githubId) ?? Promise.resolve();
    const run = prev.then(job, job);
    this.chains.set(githubId, run.then(() => undefined, () => undefined));
    return run;
  }
}

function goalsMarkdown(tree: Tree): string {
  if (tree.goals.length === 0) return "# Goals\n\nNo goals yet.\n";
  const parts = ["# Goals\n"];
  for (const goal of tree.goals) {
    parts.push(`## ${goal.title}\n\n${goal.aim}\n\nSet ${goal.createdAt}.\n`);
  }
  return parts.join("\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function pdfPages(pdf: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pdfinfo", [pdf], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (buf: Buffer) => { out += buf.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      const match = out.match(/^Pages:\s+(\d+)/m);
      if (code === 0 && match) resolvePromise(Number(match[1]));
      else reject(new ProductError("That paper is there, but its page count could not be read."));
    });
  });
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

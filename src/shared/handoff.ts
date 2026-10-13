// The ~/handoff exchange between agents (omp and Codex on hub, Claude on the laptop), in the
// format its README defines: one directory per task, the requester owns task.md, the executor owns
// result.md. This is how hub and the laptop hand work to each other. No credentials, ever: any
// write with a credential-looking line is refused before it touches disk.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrub } from "../context/root-context.ts";

export const DEFAULT_HANDOFF_DIR = join(homedir(), "handoff");

export type HandoffStatus = "open" | "running" | "done" | "partial" | "blocked";

export type Handoff = {
  id: string;
  title: string;
  executor: string;
  requester: string;
  /** "open" until result.md exists; then the status its result reports. */
  status: HandoffStatus;
  updatedAt: string;
};

const TASK_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{1,80}$/;
const MAX_READ = 64 * 1024;
const MAX_WRITE = 32 * 1024;

export class HandoffError extends Error {}

export function isTaskId(id: string): boolean {
  return TASK_ID.test(id) && !id.includes("--");
}

/** A `- Name: value` line; the bullet is optional, since people write it both ways. */
function field(text: string, name: string): string {
  const m = new RegExp(`^(?:- )?${name}:\\s*(.+)$`, "mi").exec(text);
  return m ? m[1]!.trim() : "";
}

function readCapped(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const text = readFileSync(path, "utf8");
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n\n[cut at 64 KB]" : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Parses a result's status line; anything unrecognized counts as running. */
export function parseStatus(result: string | null): HandoffStatus {
  if (result === null) return "open";
  const raw = field(result, "Status").toLowerCase();
  for (const s of ["done", "partial", "blocked", "running"] as const) if (raw.startsWith(s)) return s;
  return "running";
}

function heading(text: string | null): string {
  return (text && /^#\s+(.+)$/m.exec(text)?.[1]?.trim().replace(/^(?:Result|Handoff):\s*/i, "")) || "";
}

export function summarize(id: string, task: string | null, result: string | null, updatedAt: string): Handoff {
  return {
    id,
    title: heading(task) || heading(result) || id,
    executor: (task && field(task, "Assigned executor")) || (result && (field(result, "Executor") || field(result, "From"))) || "unassigned",
    requester: (task && field(task, "Requester")) || "",
    status: parseStatus(result),
    updatedAt,
  };
}

export function listHandoffs(root: string): Handoff[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Handoff[] = [];
  for (const id of names) {
    if (!isTaskId(id)) continue;
    const dir = join(root, id);
    const task = readCapped(join(dir, "task.md"));
    const result = readCapped(join(dir, "result.md"));
    if (task === null && result === null) continue;
    const times = ["task.md", "result.md"].map((f) => {
      try {
        return statSync(join(dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    });
    out.push(summarize(id, task, result, new Date(Math.max(...times)).toISOString()));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readHandoff(root: string, id: string): { summary: Handoff; task: string | null; result: string | null } {
  if (!isTaskId(id)) throw new HandoffError("That isn't a task id (YYYY-MM-DD-project-purpose).");
  const task = readCapped(join(root, id, "task.md"));
  const result = readCapped(join(root, id, "result.md"));
  if (task === null && result === null) throw new HandoffError(`No handoff ${id}.`);
  return { summary: summarize(id, task, result, new Date().toISOString()), task, result };
}

function refuseSecrets(text: string): void {
  if (scrub(text) !== text) throw new HandoffError("Refused: a line looks like a credential. Handoffs never carry secrets; point to the protected config path instead.");
  if (text.length > MAX_WRITE) throw new HandoffError("Too long for a handoff (32 KB). Point to files instead of pasting them.");
}

function writeFile(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "task";
}

export function createHandoff(
  root: string,
  input: { title: string; executor: string; requester: string; project?: string; body: string },
  now = new Date(),
): Handoff {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) throw new HandoffError("A handoff needs a title.");
  if (!input.executor.trim()) throw new HandoffError("Say who should do it: laptop or hub.");
  const date = now.toISOString().slice(0, 10);
  const base = `${date}-${slugify(title)}`;
  let id = base;
  for (let n = 2; existsSync(join(root, id)); n++) id = `${base}-${n}`;
  const text = [
    `# ${title}`,
    "",
    `- Task ID: ${id}`,
    `- Requester: ${input.requester.trim()}`,
    `- Assigned executor: ${input.executor.trim()}`,
    ...(input.project?.trim() ? [`- Project: ${input.project.trim()}`] : []),
    `- Date: ${date}`,
    `- Write result.md beside this file. A handoff is not permission to commit, push or deploy.`,
    "",
    input.body.trim(),
    "",
  ].join("\n");
  refuseSecrets(text);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, id), { mode: 0o700 });
  writeFile(join(root, id, "task.md"), text);
  return summarize(id, text, null, now.toISOString());
}

/** Writes the executor's result, or adds a dated update to it, keeping what was there. */
export function writeResult(root: string, input: { id: string; executor: string; status: Exclude<HandoffStatus, "open">; body: string }, now = new Date()): Handoff {
  if (!isTaskId(input.id)) throw new HandoffError("That isn't a task id.");
  // Only the new words are checked; what's already in the file was someone else's to write.
  refuseSecrets(input.body);
  const dir = join(root, input.id);
  const task = readCapped(join(dir, "task.md"));
  if (task === null) throw new HandoffError(`No task ${input.id} to answer.`);
  const path = join(dir, "result.md");
  const existing = readCapped(path);
  let text: string;
  if (existing === null) {
    text = [
      `# Result: ${summarize(input.id, task, null, "").title}`,
      "",
      `- Task ID: ${input.id}`,
      `- Executor: ${input.executor.trim()}`,
      `- Date: ${now.toISOString().slice(0, 10)}`,
      `- Status: ${input.status}`,
      "",
      input.body.trim(),
      "",
    ].join("\n");
  } else {
    const statusLine = /^- Status:.*$/m.test(existing) ? existing.replace(/^- Status:.*$/m, `- Status: ${input.status}`) : existing;
    text = `${statusLine.trimEnd()}\n\n## Update ${now.toISOString().slice(0, 16).replace("T", " ")} UTC\n\n- Status: ${input.status}\n\n${input.body.trim()}\n`;
  }
  if (text.length > MAX_READ) throw new HandoffError("The result file is full (64 KB). Start a follow-up task instead.");
  writeFile(path, text);
  return summarize(input.id, task, text, now.toISOString());
}

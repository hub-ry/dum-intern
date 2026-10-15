// One record per Workday application Dum was asked to prefill, on hub. The MCP tool creates it,
// `dum workday run` fills in how the agent did, and the hub side of request_submit links the
// approval request. No vault values ever land here: the agent never has them.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRequestId } from "../shared/requests.ts";

export const DEFAULT_WORKDAY_DIR = join(homedir(), ".local", "state", "dum", "workday");

export type JobStatus = "queued" | "running" | "awaiting_approval" | "needs_ryan" | "failed";

export type WorkdayJob = {
  schemaVersion: 1;
  id: string;
  url: string;
  /** Anything Ryan said about this application, passed to the agent. */
  note: string;
  goalId: string;
  requestedBy: string;
  createdAt: string;
  status: JobStatus;
  /** The workday-submit approval request, once the agent reached the review page. */
  requestId?: string;
  /** The agent's one-line account, shown as its words, not Dum's. */
  agentNote?: string;
  finishedAt?: string;
};

function write(dir: string, job: WorkdayJob): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${job.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 1), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function createJob(dir: string, input: { url: string; note: string; goalId: string; requestedBy: string }, now = new Date()): WorkdayJob {
  const job: WorkdayJob = { schemaVersion: 1, id: randomUUID(), ...input, requestedBy: input.requestedBy.slice(0, 80), createdAt: now.toISOString(), status: "queued" };
  write(dir, job);
  return job;
}

export function readJob(dir: string, id: string): WorkdayJob | null {
  if (!isRequestId(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as WorkdayJob;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function updateJob(dir: string, id: string, patch: Partial<Pick<WorkdayJob, "status" | "requestId" | "agentNote" | "finishedAt">>): WorkdayJob {
  const job = readJob(dir, id);
  if (!job) throw new Error(`no Workday job ${id}`);
  const next = { ...job, ...patch };
  write(dir, next);
  return next;
}

export function listJobs(dir: string): WorkdayJob[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .map((n) => /^(.+)\.json$/.exec(n)?.[1])
    .flatMap((id) => (id ? [readJob(dir, id)] : []))
    .filter((j): j is WorkdayJob => j?.schemaVersion === 1)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

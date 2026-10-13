// One client for the workshop's own HTTP API, shared by the Discord bot, the MCP server and the
// CLI. Nothing outside the workshop touches its store; everything goes through here.

import { readFileSync } from "node:fs";
import { DEFAULT_ENV_FILE, parseEnvFile, resolveConfig } from "../workshop/notes-cli.ts";

export type JobState = "queued" | "running" | "ready" | "failed";

export type GoalView = { id: string; title: string };

export type Material = { id: string; concept: string; title: string; body: string; url?: string };

export type Schedule = { intervalMinutes: number; nextRunAt: string } | null;

export type GoalDetail = GoalView & { ambition: string; baseContext: string; materials: Material[]; schedule: Schedule; createdAt?: string };

export type Panel = { image?: string; code?: string; caption: string; teachingIds?: string[] };

export type JobView = {
  id: string;
  goalId: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  parentId?: string;
  correction?: string;
  artifactId?: string;
  result?: { title: string; panels: Panel[] };
};

export type ConceptProgress = { concept: string; counts: Record<string, number>; latest: string | null };

export type Teaching = { id: string; concept: string; text: string; createdAt: string };

/** A file shared through the workshop. `size` is null when the file no longer passes its checks. */
export type SharedContext = { id: string; name: string; text: string; goalIds: string[]; createdAt: string; updatedAt: string };

export type ShareView = { id: string; path: string; name: string; createdAt: string; size: number | null; urlPath: string };

export type Workshop = {
  goals(): Promise<GoalView[]>;
  goal(goalId: string): Promise<GoalDetail>;
  jobs(): Promise<JobView[]>;
  job(jobId: string): Promise<JobView>;
  teachings(goalId: string): Promise<Teaching[]>;
  createGoal(title: string, ambition: string): Promise<GoalView>;
  teach(goalId: string, concept: string, text: string): Promise<void>;
  setContext(goalId: string, context: string): Promise<void>;
  studied(goalId: string, concept: string): Promise<void>;
  tried(goalId: string, concept: string, text: string, helped: boolean): Promise<void>;
  revisit(goalId: string, concept: string, note: string): Promise<void>;
  progress(goalId: string): Promise<ConceptProgress[]>;
  schedule(goalId: string, minutes: number | null): Promise<Schedule>;
  build(goalId: string): Promise<JobView>;
  correct(jobId: string, correction: string): Promise<JobView>;
  share(path: string): Promise<ShareView>;
  shares(): Promise<ShareView[]>;
  unshare(shareId: string): Promise<ShareView>;
  sharedContexts(): Promise<SharedContext[]>;
  /** Create or update by name: `text` replaces the text, `goalIds` replaces the linked goals. */
  setShared(name: string, patch: { text?: string; goalIds?: string[] }): Promise<SharedContext>;
  deleteShared(name: string): Promise<SharedContext>;
  /** A shared file's bytes, by its /files/... path, or null when the workshop won't serve it. */
  file(urlPath: string): Promise<Uint8Array | null>;
};

/** A workshop answer that wasn't OK. 4xx messages are the workshop's own validation text. */
export class WorkshopRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WorkshopRequestError";
  }
  /** Safe to show the person: the workshop's validation text, never a server failure's details. */
  get shown(): string {
    return this.status >= 400 && this.status < 500 ? this.message : "The workshop couldn't do that. The reason is in its log on hub.";
  }
}

export type ClientConfig = { baseUrl: string; token: string };

/** The workshop origin and token from the environment, then the protected environment file. */
export function loadClientConfig(env: Record<string, string | undefined> = process.env, file = DEFAULT_ENV_FILE): ClientConfig {
  let parsed = new Map();
  try {
    parsed = parseEnvFile(readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return resolveConfig(env, parsed);
}

export function workshopClient(config: ClientConfig): Workshop {
  async function ws<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
    const res = await fetch(config.baseUrl + path, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${config.token}`, ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new WorkshopRequestError(res.status, json.error ?? `workshop ${path}: ${res.status}`);
    return json;
  }
  const goalPath = (goalId: string, sub = "") => `/api/goals/${encodeURIComponent(goalId)}${sub}`;
  return {
    goals: async () => (await ws<{ goals: GoalView[] }>("/api/goals")).goals,
    goal: async (goalId) => (await ws<{ goal: GoalDetail }>(goalPath(goalId))).goal,
    jobs: async () => (await ws<{ jobs: JobView[] }>("/api/jobs")).jobs,
    job: async (jobId) => (await ws<{ job: JobView }>(`/api/jobs/${encodeURIComponent(jobId)}`)).job,
    teachings: async (goalId) => (await ws<{ teachings: Teaching[] }>(goalPath(goalId, "/teachings"))).teachings,
    createGoal: async (title, ambition) => (await ws<{ goal: GoalView }>("/api/goals", { method: "POST", body: { title, ambition } })).goal,
    teach: async (goalId, concept, text) => void (await ws(goalPath(goalId, "/teach"), { method: "POST", body: { concept, text } })),
    setContext: async (goalId, context) => void (await ws(goalPath(goalId, "/context"), { method: "PUT", body: { context } })),
    studied: async (goalId, concept) => void (await ws(goalPath(goalId, "/studied"), { method: "POST", body: { concept } })),
    tried: async (goalId, concept, text, helped) => void (await ws(goalPath(goalId, "/report"), { method: "POST", body: { concept, text, helped } })),
    revisit: async (goalId, concept, note) => void (await ws(goalPath(goalId, "/revisit"), { method: "POST", body: { concept, note } })),
    progress: async (goalId) => (await ws<{ progress: { concepts: ConceptProgress[] } }>(goalPath(goalId, "/progress"))).progress.concepts,
    schedule: async (goalId, minutes) => (await ws<{ schedule: Schedule }>(goalPath(goalId, "/schedule"), { method: "POST", body: { intervalMinutes: minutes } })).schedule,
    build: async (goalId) => (await ws<{ job: JobView }>(goalPath(goalId, "/jobs"), { method: "POST", body: {} })).job,
    correct: async (jobId, correction) => (await ws<{ job: JobView }>(`/api/jobs/${encodeURIComponent(jobId)}/correction`, { method: "POST", body: { correction } })).job,
    share: async (path) => (await ws<{ share: ShareView }>("/api/shares", { method: "POST", body: { path } })).share,
    shares: async () => (await ws<{ shares: ShareView[] }>("/api/shares")).shares,
    unshare: async (shareId) => (await ws<{ share: ShareView }>(`/api/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" })).share,
    sharedContexts: async () => (await ws<{ shared: SharedContext[] }>("/api/shared-contexts")).shared,
    setShared: async (name, patch) => (await ws<{ shared: SharedContext }>(`/api/shared-contexts/${encodeURIComponent(name)}`, { method: "PUT", body: patch })).shared,
    deleteShared: async (name) => (await ws<{ shared: SharedContext }>(`/api/shared-contexts/${encodeURIComponent(name)}`, { method: "DELETE" })).shared,
    file: async (urlPath) => {
      if (!urlPath.startsWith("/files/")) return null;
      const res = await fetch(config.baseUrl + urlPath, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    },
  };
}

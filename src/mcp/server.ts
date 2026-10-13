// Dum as an MCP server: one stdio process that any agent can start (Claude on the laptop over
// `ssh hub dum mcp`, omp and Codex on hub) to work with Dum through the workshop's API and the
// ~/handoff exchange. Plain JSON-RPC over newline-delimited stdio; no SDK, no network listener.
//
// The rule that shapes it: an agent can't record something as Ryan's own words. Teaching and
// attempt reports become approval requests that Ryan answers in Discord; everything else acts
// directly and shows up where Ryan already looks.

import type { GoalDetail, JobView, Workshop } from "../client/workshop.ts";
import { WorkshopRequestError } from "../client/workshop.ts";
import { createRequest, readRequest, listRequests, isRequestId, isVerbatim, type DumRequest } from "../shared/requests.ts";
import { createHandoff, listHandoffs, readHandoff, writeResult, HandoffError, type HandoffStatus } from "../shared/handoff.ts";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "1.0.0";
const MAX_WAIT_SECONDS = 110;

export type Deps = {
  workshop: Workshop;
  requestsDir: string;
  handoffDir: string;
  /** Where Ryan opens the workshop, for links in answers. */
  appUrl: string;
  /** Set only by Dum's own Discord chat: the message Ryan just sent, to check teaching against. */
  chatSource?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

type Json = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

class ToolError extends Error {}

const INSTRUCTIONS = `Dum is Ryan's learning companion, running on his server "hub". Ryan teaches Dum concepts in his own words; Dum builds real, working creations from that teaching and presents them as illustrated pages. Goals organize the work; each has its own context, study materials and Discord channel.

Rules:
- Teaching and attempt reports must be Ryan's own words, verbatim. Never write, paraphrase or improve them. They are sent to Ryan in Discord for approval and only recorded if he approves, so tell him to check Discord.
- Building costs real compute. Build when Ryan asks or clearly wants it.
- Handoffs pass work between agents: create one for "laptop" (Claude on Ryan's Mac, with his apps and browser) or "hub" (omp/Codex on the server). Never put secrets in a handoff.
Start with dum_overview.`;

const goalArg = { type: "string", description: "Goal id, or the goal's exact title." };
const waitArg = (what: string, d: number) => ({ type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, description: `Seconds to wait for ${what} before returning (default ${d}).` });

type ToolDef = { name: string; title: string; description: string; inputSchema: Json; annotations?: Json };

const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  { name: "dum_overview", title: "Dum overview", description: "Start here. Goals with their ids, recent creations, requests waiting on Ryan, and open handoffs.", inputSchema: { type: "object", properties: {} }, annotations: read },
  { name: "dum_goal", title: "Read a goal", description: "A goal's ambition, its own context, study materials, what Ryan has taught for it, progress and schedule.", inputSchema: { type: "object", properties: { goal: goalArg }, required: ["goal"] }, annotations: read },
  {
    name: "dum_create_goal",
    title: "Create a goal",
    description: "Start a new goal. It gets its own private Discord channel within seconds.",
    inputSchema: { type: "object", properties: { title: { type: "string", maxLength: 160 }, ambition: { type: "string", maxLength: 4000, description: "What Dum should eventually be able to build for this goal." } }, required: ["title", "ambition"] },
    annotations: write,
  },
  {
    name: "dum_set_context",
    title: "Set goal context",
    description: "Replace or add to a goal's own context: notes, course details, constraints Dum should know. Root context comes from files on hub and can't be set here.",
    inputSchema: { type: "object", properties: { goal: goalArg, context: { type: "string" }, mode: { type: "string", enum: ["append", "replace"], description: "Default append." } }, required: ["goal", "context"] },
    annotations: write,
  },
  { name: "dum_read_material", title: "Read study material", description: "The full text of one of a goal's study materials.", inputSchema: { type: "object", properties: { goal: goalArg, material_id: { type: "string" } }, required: ["goal", "material_id"] }, annotations: read },
  {
    name: "dum_teach",
    title: "Teach Dum (asks Ryan)",
    description: "Send Ryan's own explanation of a concept, verbatim, for him to approve in Discord. Only an approval records it. Never write or rephrase the text yourself.",
    inputSchema: { type: "object", properties: { goal: goalArg, concept: { type: "string", maxLength: 160 }, text: { type: "string", maxLength: 12000, description: "Ryan's exact words." }, wait_seconds: waitArg("Ryan's answer", 45) }, required: ["goal", "concept", "text"] },
    annotations: write,
  },
  {
    name: "dum_report_attempt",
    title: "Report an attempt (asks Ryan)",
    description: "Send Ryan's own report of trying a concept, verbatim, for him to approve in Discord. Recorded as his self-report, not as proof.",
    inputSchema: { type: "object", properties: { goal: goalArg, concept: { type: "string", maxLength: 160 }, text: { type: "string", maxLength: 12000 }, needed_help: { type: "boolean" }, wait_seconds: waitArg("Ryan's answer", 45) }, required: ["goal", "concept", "text", "needed_help"] },
    annotations: write,
  },
  { name: "dum_request_status", title: "Check an approval", description: "Whether Ryan approved, declined, or hasn't answered a teaching or attempt request yet.", inputSchema: { type: "object", properties: { request_id: { type: "string" }, wait_seconds: waitArg("an answer", 0) }, required: ["request_id"] }, annotations: read },
  { name: "dum_mark_studied", title: "Mark studied", description: "Record that Ryan studied a concept's material.", inputSchema: { type: "object", properties: { goal: goalArg, concept: { type: "string" } }, required: ["goal", "concept"] }, annotations: write },
  { name: "dum_flag_revisit", title: "Flag for revisit", description: "Record that a concept needs another look, with what's shaky.", inputSchema: { type: "object", properties: { goal: goalArg, concept: { type: "string" }, note: { type: "string", maxLength: 12000 } }, required: ["goal", "concept", "note"] }, annotations: write },
  { name: "dum_progress", title: "Progress", description: "Ryan's records for a goal, concept by concept. Records, not a mastery score.", inputSchema: { type: "object", properties: { goal: goalArg }, required: ["goal"] }, annotations: read },
  { name: "dum_build", title: "Build a creation", description: "Ask Dum to make a real creation from what Ryan has taught for this goal. Takes a few minutes; Discord pings Ryan when it's ready.", inputSchema: { type: "object", properties: { goal: goalArg }, required: ["goal"] }, annotations: write },
  {
    name: "dum_correct",
    title: "Correct a creation",
    description: "Ask for a new version of a finished creation with a correction. The original is kept.",
    inputSchema: { type: "object", properties: { creation: { type: "string", description: "Creation id, or its first 8 characters." }, correction: { type: "string", maxLength: 12000 } }, required: ["creation", "correction"] },
    annotations: write,
  },
  { name: "dum_creations", title: "List creations", description: "Recent creations and their state, optionally for one goal.", inputSchema: { type: "object", properties: { goal: goalArg } }, annotations: read },
  {
    name: "dum_creation",
    title: "Read a creation",
    description: "A creation's state, title, each page's caption and code, and the link to its presentation. Can wait for it to finish.",
    inputSchema: { type: "object", properties: { creation: { type: "string", description: "Creation id, or its first 8 characters." }, wait_seconds: waitArg("it to finish", 0) }, required: ["creation"] },
    annotations: read,
  },
  {
    name: "dum_schedule",
    title: "Schedule builds",
    description: "Build for a goal every so many minutes, or turn it off.",
    inputSchema: { type: "object", properties: { goal: goalArg, minutes: { type: ["integer", "null"], minimum: 1, maximum: 525600, description: "Minutes between builds, or null to turn off." } }, required: ["goal", "minutes"] },
    annotations: write,
  },
  {
    name: "handoff_list",
    title: "List handoffs",
    description: "Tasks agents passed to each other in ~/handoff on hub. Filter by executor (laptop or hub) and status.",
    inputSchema: { type: "object", properties: { executor: { type: "string", description: "Substring of the assigned executor, e.g. laptop or hub." }, status: { type: "string", enum: ["open", "running", "done", "partial", "blocked", "unfinished"], description: "unfinished = open, running, partial or blocked." } } },
    annotations: read,
  },
  { name: "handoff_read", title: "Read a handoff", description: "A handoff's task and result.", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] }, annotations: read },
  {
    name: "handoff_create",
    title: "Hand work to another agent",
    description: "Create a task for the laptop (Claude on Ryan's Mac: apps, browser, GUI) or hub (omp/Codex on the server). Include the goal, scope, boundaries and how to check it's done. Discord tells Ryan. No secrets.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, executor: { type: "string", description: "laptop, hub, or a specific agent." }, body: { type: "string", description: "Markdown: goal, background, scope, non-goals, acceptance checks." }, project: { type: "string" } }, required: ["title", "executor", "body"] },
    annotations: write,
  },
  {
    name: "handoff_result",
    title: "Answer a handoff",
    description: "Write or update the result of a handoff you're executing: what you actually did and observed, changed files, gaps. A later call adds a dated update and keeps what was there.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, status: { type: "string", enum: ["running", "done", "partial", "blocked"] }, body: { type: "string" } }, required: ["task_id", "status", "body"] },
    annotations: write,
  },
  { name: "handoff_wait", title: "Wait for a handoff", description: "Wait until a handoff's result reports done, partial or blocked.", inputSchema: { type: "object", properties: { task_id: { type: "string" }, wait_seconds: waitArg("the result", 60) }, required: ["task_id"] }, annotations: read },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function str(args: Json, name: string, required = true): string {
  const v = args[name];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new ToolError(`"${name}" is required.`);
  return "";
}

function waitFor(args: Json, fallback: number): number {
  const v = args.wait_seconds;
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(n)));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

export function createMcp(deps: Deps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  let client = "an MCP client";

  const link = (jobId: string) => `${deps.appUrl}/#job=${jobId}`;
  const goalLink = (goalId: string) => `${deps.appUrl}/#goal=${goalId}`;

  async function goalOf(ref: string): Promise<GoalDetail> {
    const goals = await deps.workshop.goals();
    const hit = UUID.test(ref) ? goals.find((g) => g.id === ref) : goals.filter((g) => g.title.toLowerCase() === ref.toLowerCase()).at(0);
    if (!hit) throw new ToolError(`No goal "${ref}". Goals: ${goals.map((g) => `${g.title} (${g.id})`).join("; ") || "none yet"}.`);
    return deps.workshop.goal(hit.id);
  }

  async function jobOf(ref: string): Promise<JobView> {
    const r = ref.toLowerCase();
    if (UUID.test(r)) return deps.workshop.job(r);
    if (!/^[0-9a-f]{6,}$/.test(r)) throw new ToolError("A creation id is a UUID or its first 8 characters.");
    const hits = (await deps.workshop.jobs()).filter((j) => j.id.startsWith(r));
    if (hits.length !== 1) throw new ToolError(hits.length ? `"${ref}" matches ${hits.length} creations; use more characters.` : `No creation "${ref}".`);
    return hits[0]!;
  }

  function describeJob(j: JobView, goalTitle?: string): string {
    const head = `${j.id.slice(0, 8)} · ${j.state}${goalTitle ? ` · ${goalTitle}` : ""}${j.result ? ` · ${j.result.title}` : ""}`;
    return j.parentId ? `${head} (correction of ${j.parentId.slice(0, 8)})` : head;
  }

  function describeRequest(r: DumRequest): string {
    const what = r.kind === "teach" ? `teaching "${r.concept}"` : `attempt report on "${r.concept}"`;
    if (r.status === "pending" && r.verbatim) return `Recording ${what} in Ryan's exact words (request ${r.id}).`;
    if (r.status === "pending") return `Waiting for Ryan to approve ${what} in Discord (request ${r.id}). Check later with dum_request_status.`;
    if (r.status === "approved") return `Ryan approved ${what}; it's recorded as his.${r.outcome ? ` ${r.outcome}` : ""}`;
    if (r.status === "declined") return `Ryan declined ${what}; nothing was recorded.`;
    return `Ryan approved ${what}, but recording it failed: ${r.outcome ?? "see the bot's log on hub"}.`;
  }

  async function waitRequest(id: string, seconds: number): Promise<DumRequest> {
    const deadline = now().getTime() + seconds * 1000;
    for (;;) {
      const r = readRequest(deps.requestsDir, id);
      if (!r) throw new ToolError(`No request ${id}.`);
      if (r.status !== "pending" || now().getTime() >= deadline) return r;
      await sleep(1000);
    }
  }

  async function ask(kind: "teach" | "tried", args: Json): Promise<string> {
    const goal = await goalOf(str(args, "goal"));
    const text = str(args, "text");
    const req = createRequest(deps.requestsDir, {
      kind,
      goalId: goal.id,
      concept: str(args, "concept"),
      text,
      helped: args.needed_help === true,
      requestedBy: client,
      verbatim: deps.chatSource !== undefined && isVerbatim(text, deps.chatSource),
    });
    return describeRequest(await waitRequest(req.id, waitFor(args, 45)));
  }

  const tools: Record<string, (args: Json) => Promise<string>> = {
    async dum_overview() {
      const [goals, jobs] = await Promise.all([deps.workshop.goals(), deps.workshop.jobs()]);
      const names = new Map(goals.map((g) => [g.id, g.title]));
      const pending = listRequests(deps.requestsDir).filter((r) => r.status === "pending");
      const open = listHandoffs(deps.handoffDir).filter((h) => h.status !== "done").slice(0, 8);
      const recent = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
      return [
        `Goals (${goals.length}):`,
        ...(goals.length ? goals.map((g) => `- ${g.title} (${g.id}) · ${goalLink(g.id)}`) : ["- none yet; create one with dum_create_goal"]),
        "",
        "Recent creations:",
        ...(recent.length ? recent.map((j) => `- ${describeJob(j, names.get(j.goalId))}`) : ["- none yet"]),
        "",
        `Waiting on Ryan in Discord: ${pending.length ? pending.map((r) => `${r.kind} "${r.concept}" from ${r.requestedBy}`).join("; ") : "nothing"}`,
        "",
        "Unfinished handoffs:",
        ...(open.length ? open.map((h) => `- ${h.id} · ${h.status} · for ${h.executor} · ${h.title}`) : ["- none"]),
        "",
        `Workshop: ${deps.appUrl}`,
      ].join("\n");
    },

    async dum_goal(args) {
      const goal = await goalOf(str(args, "goal"));
      const [teachings, progress] = await Promise.all([deps.workshop.teachings(goal.id), deps.workshop.progress(goal.id)]);
      return [
        `# ${goal.title} (${goal.id})`,
        "",
        `Ambition: ${goal.ambition}`,
        "",
        `Goal context:\n${goal.baseContext.trim() || "(empty)"}`,
        "",
        "Study materials:",
        ...goal.materials.map((m) => `- ${m.title} [concept: ${m.concept}] (material_id ${m.id})`),
        "",
        `Taught by Ryan (${teachings.length}):`,
        ...teachings.map((t) => `- ${t.concept}: ${clip(t.text.replace(/\s+/g, " "), 300)}`),
        "",
        "Progress records:",
        ...(progress.length ? progress.map((c) => `- ${c.concept}: ${Object.entries(c.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`) : ["- none"]),
        "",
        `Schedule: ${goal.schedule ? `every ${goal.schedule.intervalMinutes} minutes, next ${goal.schedule.nextRunAt}` : "off"}`,
        `Workshop page for this goal (progression, teaching, creations): ${goalLink(goal.id)}`,
      ].join("\n");
    },

    async dum_create_goal(args) {
      const goal = await deps.workshop.createGoal(str(args, "title"), str(args, "ambition"));
      return `Created "${goal.title}" (${goal.id}). Its Discord channel appears within a few seconds.`;
    },

    async dum_set_context(args) {
      const goal = await goalOf(str(args, "goal"));
      const text = str(args, "context");
      const replace = args.mode === "replace";
      const next = replace ? text : goal.baseContext.trim() ? `${goal.baseContext.trimEnd()}\n\n${text}` : text;
      await deps.workshop.setContext(goal.id, next);
      return `${replace ? "Replaced" : "Added to"} the context of "${goal.title}" (${next.length} characters now).`;
    },

    async dum_read_material(args) {
      const goal = await goalOf(str(args, "goal"));
      const m = goal.materials.find((x) => x.id === str(args, "material_id"));
      if (!m) throw new ToolError(`No material with that id in "${goal.title}". Use dum_goal to list them.`);
      return `# ${m.title}\nConcept: ${m.concept}${m.url ? `\nReference: ${m.url}` : ""}\n\n${m.body}`;
    },

    dum_teach: (args) => ask("teach", args),
    dum_report_attempt: (args) => ask("tried", args),

    async dum_request_status(args) {
      const id = str(args, "request_id");
      if (!isRequestId(id)) throw new ToolError("That isn't a request id.");
      return describeRequest(await waitRequest(id, waitFor(args, 0)));
    },

    async dum_mark_studied(args) {
      const goal = await goalOf(str(args, "goal"));
      await deps.workshop.studied(goal.id, str(args, "concept"));
      return `Recorded: Ryan studied "${str(args, "concept")}" for "${goal.title}".`;
    },

    async dum_flag_revisit(args) {
      const goal = await goalOf(str(args, "goal"));
      await deps.workshop.revisit(goal.id, str(args, "concept"), str(args, "note"));
      return `Flagged "${str(args, "concept")}" to revisit in "${goal.title}".`;
    },

    async dum_progress(args) {
      const goal = await goalOf(str(args, "goal"));
      const progress = await deps.workshop.progress(goal.id);
      const page = `Full progression in the workshop: ${goalLink(goal.id)}`;
      if (!progress.length) return `No records for "${goal.title}" yet.\n${page}`;
      return progress
        .map((c) => `- ${c.concept}: ${Object.entries(c.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}${c.latest ? ` (latest ${c.latest})` : ""}`)
        .concat("These are Ryan's records, not a mastery score.", page)
        .join("\n");
    },

    async dum_build(args) {
      const goal = await goalOf(str(args, "goal"));
      const job = await deps.workshop.build(goal.id);
      return `Queued creation ${job.id} for "${goal.title}". It takes a few minutes; Discord pings Ryan when it's ready. Follow it with dum_creation and wait_seconds.`;
    },

    async dum_correct(args) {
      const parent = await jobOf(str(args, "creation"));
      const job = await deps.workshop.correct(parent.id, str(args, "correction"));
      return `Queued correction ${job.id} of ${parent.id.slice(0, 8)}. The original stays as it was: ${link(parent.id)}`;
    },

    async dum_creations(args) {
      const ref = str(args, "goal", false);
      const goal = ref ? await goalOf(ref) : null;
      const [jobs, goals] = await Promise.all([deps.workshop.jobs(), deps.workshop.goals()]);
      const names = new Map(goals.map((g) => [g.id, g.title]));
      const list = jobs.filter((j) => !goal || j.goalId === goal.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15);
      return list.length ? list.map((j) => `- ${describeJob(j, goal ? undefined : names.get(j.goalId))}`).join("\n") : "No creations yet.";
    },

    async dum_creation(args) {
      let job = await jobOf(str(args, "creation"));
      const deadline = now().getTime() + waitFor(args, 0) * 1000;
      while ((job.state === "queued" || job.state === "running") && now().getTime() < deadline) {
        await sleep(3000);
        job = await deps.workshop.job(job.id);
      }
      const lines = [describeJob(job), `Presentation: ${link(job.id)}`];
      if (job.correction) lines.push(`Correction asked for: ${job.correction}`);
      if (job.result) {
        job.result.panels.forEach((p, n) => {
          lines.push("", `Page ${n + 1}: ${p.caption}`);
          if (p.code) lines.push("```", clip(p.code, 1500), "```");
        });
      } else if (job.state === "queued" || job.state === "running") lines.push("Still working. Call again with wait_seconds to wait for it.");
      else if (job.state === "failed") lines.push("It failed. The details are on hub, not here.");
      return lines.join("\n");
    },

    async dum_schedule(args) {
      const goal = await goalOf(str(args, "goal"));
      const minutes = typeof args.minutes === "number" ? args.minutes : null;
      const s = await deps.workshop.schedule(goal.id, minutes);
      return s ? `"${goal.title}" builds every ${s.intervalMinutes} minutes; next at ${s.nextRunAt}.` : `Scheduled builds are off for "${goal.title}".`;
    },

    async handoff_list(args) {
      const executor = str(args, "executor", false).toLowerCase();
      const status = str(args, "status", false);
      const list = listHandoffs(deps.handoffDir).filter(
        (h) => (!executor || h.executor.toLowerCase().includes(executor)) && (!status || (status === "unfinished" ? h.status !== "done" : h.status === status)),
      );
      return list.length ? list.map((h) => `- ${h.id} · ${h.status} · for ${h.executor} · ${h.title}`).join("\n") : "No matching handoffs.";
    },

    async handoff_read(args) {
      const h = readHandoff(deps.handoffDir, str(args, "task_id"));
      return `${h.task ?? "(no task.md)"}\n\n---\n\n${h.result ?? "(no result.md yet)"}`;
    },

    async handoff_create(args) {
      const h = createHandoff(deps.handoffDir, { title: str(args, "title"), executor: str(args, "executor"), requester: client, project: str(args, "project", false), body: str(args, "body") }, now());
      return `Created handoff ${h.id} for ${h.executor}. Discord lets Ryan know. Wait for it with handoff_wait.`;
    },

    async handoff_result(args) {
      const status = str(args, "status") as Exclude<HandoffStatus, "open">;
      if (!["running", "done", "partial", "blocked"].includes(status)) throw new ToolError("status is running, done, partial or blocked.");
      const h = writeResult(deps.handoffDir, { id: str(args, "task_id"), executor: client, status, body: str(args, "body") }, now());
      return `Result for ${h.id} is now ${h.status}.`;
    },

    async handoff_wait(args) {
      const id = str(args, "task_id");
      const deadline = now().getTime() + waitFor(args, 60) * 1000;
      for (;;) {
        const h = readHandoff(deps.handoffDir, id);
        const finished = ["done", "partial", "blocked"].includes(h.summary.status);
        if (finished || now().getTime() >= deadline) {
          return finished ? `${id} is ${h.summary.status}.\n\n${h.result}` : `${id} is still ${h.summary.status}. Wait again later.`;
        }
        await sleep(2000);
      }
    },
  };

  async function call(name: string, args: Json): Promise<ToolResult> {
    const fn = tools[name];
    if (!fn) return { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true };
    try {
      return { content: [{ type: "text", text: await fn(args ?? {}) }] };
    } catch (err) {
      const text =
        err instanceof ToolError || err instanceof HandoffError
          ? err.message
          : err instanceof WorkshopRequestError
            ? err.shown
            : "Something went wrong on hub. The details are in the MCP server's stderr.";
      if (!(err instanceof ToolError || err instanceof HandoffError || err instanceof WorkshopRequestError)) console.error("[dum-mcp]", err);
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  /** One JSON-RPC message in, its response out (null for notifications). */
  async function handle(msg: unknown): Promise<Json | null> {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const m = msg as { id?: string | number | null; method?: unknown; params?: Json };
    const isRequest = m.id !== undefined && m.id !== null;
    const reply = (result: Json) => (isRequest ? { jsonrpc: "2.0", id: m.id, result } : null);
    const fail = (code: number, message: string) => (isRequest ? { jsonrpc: "2.0", id: m.id, error: { code, message } } : null);
    if (typeof m.method !== "string") return isRequest ? fail(-32600, "Invalid request") : null;

    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
        const info = m.params?.clientInfo as { name?: unknown } | undefined;
        if (typeof info?.name === "string" && info.name.trim()) client = clip(info.name.trim(), 60);
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dum", title: "Dum", version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = typeof m.params?.name === "string" ? m.params.name : "";
        const args = (m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {}) as Json;
        return reply((await call(name, args)) as unknown as Json);
      }
      default:
        if (m.method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }

  return { handle, call };
}

/** Serves Dum's tools on stdin/stdout until stdin closes. */
export function serveStdio(deps: Deps): Promise<void> {
  return serveLines(createMcp(deps).handle);
}

/** Serves newline-delimited JSON-RPC on stdin/stdout with any handler, until stdin closes. */
export async function serveLines(handle: (msg: unknown) => Promise<Json | null>): Promise<void> {
  const mcp = { handle };
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  let buffer = "";
  const inflight = new Set<Promise<void>>();
  const process1 = (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const work = (async () => {
      if (Array.isArray(msg)) {
        const replies = (await Promise.all(msg.map((x) => mcp.handle(x)))).filter(Boolean);
        if (replies.length) out(replies);
      } else {
        const reply = await mcp.handle(msg);
        if (reply) out(reply);
      }
    })();
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  };
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) process1(line);
    }
  }
  await Promise.all(inflight);
}

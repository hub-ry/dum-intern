// What Discord should show for each workshop job, decided from records alone. Pure: no network,
// no clock, no files. The bot feeds it the workshop's job list and its own ledger, and gets back
// the exact messages to post or edit. Only real job states are shown; nothing is invented.

export type JobState = "queued" | "running" | "ready" | "failed";

/** The slice of a workshop job summary the bot reads. */
export type JobView = {
  id: string;
  goalId: string;
  state: JobState;
  createdAt: string;
  parentId?: string;
  correction?: string;
  artifactId?: string;
  result?: { title: string; panels: { image?: string; caption: string }[] };
};

export type GoalView = { id: string; title: string };

/** What the bot has already delivered for one job. Written only after Discord accepted it. */
export type LedgerEntry = {
  /** The one evolving status message, absent for jobs that existed before the bot. */
  messageId?: string;
  stage: JobState;
  /** Completion or failure ping sent. */
  finalSent: boolean;
};

export type Ledger = {
  schemaVersion: 1;
  jobs: Record<string, LedgerEntry>;
};

export type Links = { app: string; artifacts: string };

export type Step =
  | { kind: "postStatus"; jobId: string; stage: JobState; content: string }
  | { kind: "editStatus"; jobId: string; messageId: string; stage: JobState; content: string }
  | { kind: "final"; jobId: string; stage: JobState; content: string; images: string[] };

const STAGE_LABEL: Record<JobState, string> = {
  queued: "queued",
  running: "generating and verifying",
  ready: "ready",
  failed: "failed",
};

const STAGE_MARK: Record<JobState, string> = { queued: "◇", running: "◆", ready: "✓", failed: "✕" };

const MAX_IMAGES = 4;
const MAX_TITLE = 180;

export function emptyLedger(): Ledger {
  return { schemaVersion: 1, jobs: {} };
}

/** First run: every existing job counts as already delivered, so old history is never replayed. */
export function adoptExisting(ledger: Ledger, jobs: JobView[]): Ledger {
  const next: Ledger = { schemaVersion: 1, jobs: { ...ledger.jobs } };
  for (const job of jobs) {
    if (!next.jobs[job.id]) next.jobs[job.id] = { stage: job.state, finalSent: true };
  }
  return next;
}

export function jobLink(links: Links, jobId: string): string {
  return `${links.app}/#job=${jobId}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Strips mention syntax so job text can never ping anyone. */
function quiet(text: string): string {
  return text.replace(/@/g, "@​");
}

function heading(job: JobView, goals: Map<string, string>): string {
  const goal = goals.get(job.goalId) ?? "unknown goal";
  const kind = job.parentId ? "correction" : "creation";
  return `**${quiet(clip(goal, 80))}** · ${kind} \`${job.id.slice(0, 8)}\``;
}

export function statusContent(job: JobView, goals: Map<string, string>, links: Links): string {
  const lines = [heading(job, goals), `${STAGE_MARK[job.state]} ${STAGE_LABEL[job.state]}`];
  if (job.state === "ready" && job.result) lines.push(quiet(clip(job.result.title, MAX_TITLE)));
  if (job.state === "ready" || job.state === "failed") lines.push(`<${jobLink(links, job.id)}>`);
  return lines.join("\n");
}

export function finalContent(job: JobView, goals: Map<string, string>, links: Links, ownerId: string): string {
  const goal = quiet(clip(goals.get(job.goalId) ?? "unknown goal", 80));
  if (job.state === "failed") {
    return `<@${ownerId}> a build for **${goal}** failed. Details stay on hub: <${jobLink(links, job.id)}>`;
  }
  const title = job.result ? quiet(clip(job.result.title, MAX_TITLE)) : "untitled";
  return `<@${ownerId}> dum finished something for **${goal}**: ${title}\nRead it: <${jobLink(links, job.id)}>`;
}

/** Artifact URLs for the first few panel screenshots of a ready job. */
export function panelImages(job: JobView, links: Links): string[] {
  if (job.state !== "ready" || !job.result || !job.artifactId) return [];
  const out: string[] = [];
  for (const panel of job.result.panels) {
    if (!panel.image || !/^[\w./-]+\.png$/.test(panel.image) || panel.image.includes("..")) continue;
    out.push(`${links.artifacts}/artifacts/${job.artifactId}/${panel.image}`);
    if (out.length === MAX_IMAGES) break;
  }
  return out;
}

/** The steps that bring Discord up to date with the workshop, oldest job first. */
export function plan(jobs: JobView[], goals: GoalView[], ledger: Ledger, links: Links, ownerId: string): Step[] {
  const names = new Map(goals.map((g) => [g.id, g.title]));
  const steps: Step[] = [];
  const ordered = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of ordered) {
    const seen = ledger.jobs[job.id];
    const content = statusContent(job, names, links);
    if (!seen) {
      steps.push({ kind: "postStatus", jobId: job.id, stage: job.state, content });
    } else if (seen.stage !== job.state) {
      // Jobs adopted from before the bot have no message yet; they get one on their next change.
      steps.push(seen.messageId
        ? { kind: "editStatus", jobId: job.id, messageId: seen.messageId, stage: job.state, content }
        : { kind: "postStatus", jobId: job.id, stage: job.state, content });
    }
    const terminal = job.state === "ready" || job.state === "failed";
    if (terminal && !(seen?.finalSent && seen.stage === job.state)) {
      steps.push({ kind: "final", jobId: job.id, stage: job.state, content: finalContent(job, names, links, ownerId), images: panelImages(job, links) });
    }
  }
  return steps;
}

/** The ledger after one step succeeded. */
export function record(ledger: Ledger, step: Step, messageId?: string): Ledger {
  const prev = ledger.jobs[step.jobId];
  const jobs = { ...ledger.jobs };
  if (step.kind === "postStatus") jobs[step.jobId] = { messageId, stage: step.stage, finalSent: false };
  else if (step.kind === "editStatus") jobs[step.jobId] = { ...prev!, stage: step.stage };
  else jobs[step.jobId] = { ...prev, stage: step.stage, finalSent: true };
  return { schemaVersion: 1, jobs };
}

/** A stable nonce so a post retried after a crash is deduplicated by Discord. */
export function nonceFor(step: Step): string {
  const tag = (step.kind === "final" ? "f" : "s") + step.stage[0];
  return `${tag}${step.jobId.replace(/-/g, "").slice(0, 22)}`;
}

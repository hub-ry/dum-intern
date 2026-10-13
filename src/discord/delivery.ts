// What Discord should show for each workshop job, decided from records alone. Pure: no network,
// no clock, no files. The bot feeds it the workshop's job list and its own ledger, and gets back
// the exact messages to post or edit. Only real job states are shown; nothing is invented.

import type { GoalView, JobState, JobView } from "../client/workshop.ts";

export type { GoalView, JobState, JobView };

/** What the bot has already delivered for one job. Written only after Discord accepted it. */
export type LedgerEntry = {
  /** The one evolving status message, absent for jobs that existed before the bot. */
  messageId?: string;
  /** Where that message lives. Entries from before goal channels have none: the lobby. */
  channelId?: string;
  stage: JobState;
  /** Completion or failure ping sent. */
  finalSent: boolean;
};

export type Ledger = {
  schemaVersion: 1;
  jobs: Record<string, LedgerEntry>;
};

export type Links = { app: string; artifacts: string };

export type Embed = {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  image?: { url: string };
  thumbnail?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
};

export type Message = { content?: string; embeds: Embed[] };

export type Step =
  | { kind: "postStatus"; jobId: string; channelId: string; stage: JobState; message: Message }
  /** `home` is where a fresh status goes if the old message can no longer be edited. */
  | { kind: "editStatus"; jobId: string; channelId: string; messageId: string; home: string; stage: JobState; message: Message }
  /** `images` are artifact URLs; the embeds refer to them as attachment://panel-N.png. */
  | { kind: "final"; jobId: string; channelId: string; stage: JobState; message: Message; images: string[] };

/** Where a goal's messages go: its own channel, or the lobby until it has one. */
export type Route = { lobbyId: string; channelFor(goalId: string): string | null };

export const COLOR = { queued: 0x8b8f98, running: 0xf0c266, ready: 0x57c785, failed: 0xe5534b } as const;

const MAX_IMAGES = 4;
const MAX_TITLE = 200;

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

/** Opens the goal in the workshop at its progression. */
export function goalLink(links: Links, goalId: string): string {
  return `${links.app}/#goal=${goalId}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Strips mention syntax so job text in message content can never ping anyone. */
export function quiet(text: string): string {
  return text.replace(/@/g, "@​").replace(/<#/g, "<​#");
}

/** The stage track: what's done, what's happening now, what's next. Only real states. */
export function track(state: JobState): string {
  if (state === "failed") return "✕ **failed**";
  const steps: [JobState, string][] = [["queued", "queued"], ["running", "generating & verifying"], ["ready", "ready"]];
  const at = steps.findIndex(([s]) => s === state);
  return steps.map(([, label], n) => (n < at ? `✓ ${label}` : n === at ? `◆ **${label}**` : `○ ${label}`)).join("  ·  ");
}

function goalName(job: JobView, goals: Map<string, string>): string {
  return clip(goals.get(job.goalId) ?? "unknown goal", 80);
}

export function statusMessage(job: JobView, goals: Map<string, string>, links: Links): Message {
  const kind = job.parentId ? `correction of ${job.parentId.slice(0, 8)}` : "creation";
  const lines = [track(job.state)];
  if (job.correction) lines.push(`> ${clip(job.correction, 240)}`);
  if (job.state === "failed") lines.push("The details stay on hub.");
  return {
    embeds: [
      {
        title: job.result ? clip(job.result.title, MAX_TITLE) : job.parentId ? "Dum is reworking a creation" : "Dum is making something",
        ...(job.state === "ready" || job.state === "failed" ? { url: jobLink(links, job.id) } : {}),
        description: lines.join("\n"),
        color: COLOR[job.state],
        footer: { text: `${goalName(job, goals)} · ${kind} ${job.id.slice(0, 8)}` },
      },
    ],
  };
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

export function finalMessage(job: JobView, goals: Map<string, string>, links: Links, ownerId: string): Message {
  const goal = goalName(job, goals);
  const url = jobLink(links, job.id);
  if (job.state === "failed") {
    return {
      content: `<@${ownerId}> a build for **${quiet(goal)}** failed.`,
      embeds: [{ title: "Build failed", url, description: "Nothing was faked: the details stay on hub. Open it to see what happened.", color: COLOR.failed, footer: { text: `${goal} · ${job.id.slice(0, 8)}` } }],
    };
  }
  const panels = job.result?.panels ?? [];
  const images = panelImages(job, links);
  // Embeds that share a url show as one card with an image grid.
  const gallery: Embed[] = images.slice(1).map((_, n) => ({ url, image: { url: `attachment://panel-${n + 2}.png` } }));
  return {
    content: `<@${ownerId}> Dum made something for **${quiet(goal)}**`,
    embeds: [
      {
        title: clip(job.result?.title ?? "Untitled creation", MAX_TITLE),
        url,
        description: `${clip(panels[0]?.caption ?? "", 320)}\n\n**[Read the ${panels.length}-page presentation →](${url})**`,
        color: COLOR.ready,
        ...(images.length ? { image: { url: "attachment://panel-1.png" } } : {}),
        footer: { text: `${goal} · ${job.parentId ? "correction" : "creation"} ${job.id.slice(0, 8)}` },
      },
      ...gallery,
    ],
  };
}

/** The steps that bring Discord up to date with the workshop, oldest job first. */
export function plan(jobs: JobView[], goals: GoalView[], ledger: Ledger, links: Links, ownerId: string, route: Route): Step[] {
  const names = new Map(goals.map((g) => [g.id, g.title]));
  const steps: Step[] = [];
  const ordered = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of ordered) {
    const seen = ledger.jobs[job.id];
    const message = statusMessage(job, names, links);
    const home = route.channelFor(job.goalId) ?? route.lobbyId;
    if (!seen) {
      steps.push({ kind: "postStatus", jobId: job.id, channelId: home, stage: job.state, message });
    } else if (seen.stage !== job.state) {
      // Jobs adopted from before the bot have no message yet; they get one on their next change.
      steps.push(seen.messageId
        ? { kind: "editStatus", jobId: job.id, channelId: seen.channelId ?? route.lobbyId, messageId: seen.messageId, home, stage: job.state, message }
        : { kind: "postStatus", jobId: job.id, channelId: home, stage: job.state, message });
    }
    const terminal = job.state === "ready" || job.state === "failed";
    if (terminal && !(seen?.finalSent && seen.stage === job.state)) {
      steps.push({ kind: "final", jobId: job.id, channelId: home, stage: job.state, message: finalMessage(job, names, links, ownerId), images: panelImages(job, links) });
    }
  }
  return steps;
}

/** The ledger after one step succeeded. An edit that became a fresh post in `home` passes its new id. */
export function record(ledger: Ledger, step: Step, messageId?: string): Ledger {
  const prev = ledger.jobs[step.jobId];
  const jobs = { ...ledger.jobs };
  if (step.kind === "postStatus") jobs[step.jobId] = { messageId, channelId: step.channelId, stage: step.stage, finalSent: false };
  else if (step.kind === "editStatus") jobs[step.jobId] = { ...prev!, ...(messageId ? { messageId, channelId: step.home } : {}), stage: step.stage };
  else jobs[step.jobId] = { ...prev, stage: step.stage, finalSent: true };
  return { schemaVersion: 1, jobs };
}

/** A stable nonce so a post retried after a crash is deduplicated by Discord. */
export function nonceFor(step: Step): string {
  const tag = (step.kind === "final" ? "f" : "s") + step.stage[0];
  return `${tag}${step.jobId.replace(/-/g, "").slice(0, 22)}`;
}

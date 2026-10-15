// Everything that makes Dum feel present in Discord, decided from records alone: approval cards
// for words an agent wants recorded as Ryan's, notices when agents hand each other work, and the
// "right now" board. Pure: the bot posts what these return.

import type { GoalView, JobView } from "../client/workshop.ts";
import type { DumRequest } from "../shared/requests.ts";
import type { Handoff, HandoffStatus } from "../shared/handoff.ts";
import { COLOR, jobLink, quiet, type Embed, type Links, type Message } from "./delivery.ts";

export type Button = { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string };
export type Components = { type: 1; components: Button[] }[];
export type Card = Message & { components: Components };

const AMBER = 0xf0c266;
const DUSK = 0x6e5a9e;

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function blockquote(text: string, max: number): string {
  return clip(text.trim(), max).split("\n").map((l) => `> ${l}`).join("\n");
}

// --- Approvals ------------------------------------------------------------------------------

function approvalEmbed(req: DumRequest, goal: string): Embed {
  const what = req.kind === "teach" ? `Teaching · ${req.concept}` : req.kind === "tried" ? `Attempt · ${req.concept} · ${req.helped ? "needed help" : "no help"}` : req.concept;
  return {
    title: clip(what, 250),
    ...(req.kind === "workday-submit" && req.workday ? { url: req.workday.url } : {}),
    description: blockquote(req.text, 3800),
    color: AMBER,
    ...(req.kind === "workday-submit" && req.workday?.screenshot ? { image: { url: `attachment://${req.workday.screenshot}` } } : {}),
    footer: { text: `${clip(goal, 60)} · asked by ${clip(req.requestedBy, 40)} · ${req.id.slice(0, 8)}` },
  };
}

export function approvalCard(req: DumRequest, goal: string, ownerId: string): Card {
  if (req.kind === "workday-submit") {
    return {
      content: `<@${ownerId}> **${quiet(clip(req.requestedBy, 40))}** prefilled this application and wants to submit it. Check the screenshot (secrets are covered); it goes in only if you press Submit.`,
      embeds: [approvalEmbed(req, goal)],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: "Submit it", custom_id: `req:${req.id}:yes` },
            { type: 2, style: 4, label: "Don't submit", custom_id: `req:${req.id}:no` },
          ],
        },
      ],
    };
  }
  const kind = req.kind === "teach" ? "your teaching" : "your attempt report";
  return {
    content: `<@${ownerId}> **${quiet(clip(req.requestedBy, 40))}** wants to record this as ${kind}. Approve only if these are your own words.`,
    embeds: [approvalEmbed(req, goal)],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Yes, these are my words", custom_id: `req:${req.id}:yes` },
          { type: 2, style: 4, label: "Decline", custom_id: `req:${req.id}:no` },
        ],
      },
    ],
  };
}

function verdictOf(req: DumRequest): string {
  if (req.kind === "workday-submit") {
    if (req.status === "declined") return "✕ Not submitted. You said no.";
    if (req.status === "failed") return `⚠ Not submitted: ${req.outcome ?? "see the hub log"}`;
    if (req.outcome === "Submitted.") return "✓ Submitted.";
    return `⚠ You approved it, but it isn't submitted yet. ${req.outcome ?? ""}`.trim();
  }
  return req.status === "approved" ? "✓ Approved and recorded as yours." : req.status === "declined" ? "✕ Declined. Nothing was recorded." : `⚠ Approved, but recording failed: ${req.outcome ?? "see the hub log"}`;
}

export function decidedCard(req: DumRequest, goal: string): Card {
  const embed = approvalEmbed(req, goal);
  return {
    content: verdictOf(req),
    embeds: [{ ...embed, color: req.status === "approved" ? COLOR.ready : req.status === "declined" ? COLOR.queued : COLOR.failed }],
    components: [],
  };
}

export function parseDecision(customId: string): { id: string; approve: boolean } | null {
  const m = /^req:([0-9a-f-]{36}):(yes|no)$/.exec(customId);
  return m ? { id: m[1]!, approve: m[2] === "yes" } : null;
}

// --- Handoff notices ------------------------------------------------------------------------

export type SeenHandoffs = { schemaVersion: 1; handoffs: Record<string, HandoffStatus> };

export type Notice = { id: string; message: Message; ping: boolean };

const STATUS_MARK: Record<HandoffStatus, string> = { open: "📨", running: "◆", done: "✓", partial: "◐", blocked: "⚠" };
const STATUS_COLOR: Record<HandoffStatus, number> = { open: DUSK, running: AMBER, done: COLOR.ready, partial: AMBER, blocked: COLOR.failed };

export function adoptHandoffs(list: Handoff[]): SeenHandoffs {
  return { schemaVersion: 1, handoffs: Object.fromEntries(list.map((h) => [h.id, h.status])) };
}

/** New handoffs and status changes since last time. Work for the laptop and blockers ping Ryan. */
export function planNotices(list: Handoff[], seen: SeenHandoffs, ownerId: string): { notices: Notice[]; next: SeenHandoffs } {
  const notices: Notice[] = [];
  const next: SeenHandoffs = { schemaVersion: 1, handoffs: { ...seen.handoffs } };
  for (const h of [...list].reverse()) {
    const before = seen.handoffs[h.id];
    if (before === h.status) continue;
    next.handoffs[h.id] = h.status;
    const forLaptop = /laptop/i.test(h.executor);
    const fresh = before === undefined;
    const ping = (fresh && forLaptop && h.status === "open") || h.status === "blocked";
    const headline = fresh && h.status === "open" ? `New handoff for **${quiet(clip(h.executor, 60))}**` : `Handoff **${h.status}**`;
    const how = fresh && forLaptop && h.status === "open" ? "\nClaude on the laptop picks it up on its next check, or tell it: *do the Dum handoffs*." : "";
    notices.push({
      id: h.id,
      ping,
      message: {
        content: `${ping ? `<@${ownerId}> ` : ""}${STATUS_MARK[h.status]} ${headline}`,
        embeds: [{ title: clip(h.title, 250), description: `for ${clip(h.executor, 80)}${h.requester ? ` · from ${clip(h.requester, 60)}` : ""}${how}`, color: STATUS_COLOR[h.status], footer: { text: `~/handoff/${h.id}` } }],
      },
    });
  }
  return { notices, next };
}

// --- The "right now" board ------------------------------------------------------------------

export type BoardGoal = GoalView & { schedule?: { intervalMinutes: number; nextRunAt: string } | null };

export type BoardInput = {
  goals: BoardGoal[];
  jobs: JobView[];
  pending: DumRequest[];
  handoffs: Handoff[];
  links: Links;
  channelFor(goalId: string): string | null;
};

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function boardMessage(input: BoardInput): Message {
  const names = new Map(input.goals.map((g) => [g.id, g.title]));
  const where = (goalId: string) => {
    const ch = input.channelFor(goalId);
    return ch ? `<#${ch}>` : `**${clip(names.get(goalId) ?? "a goal", 40)}**`;
  };
  const running = input.jobs.filter((j) => j.state === "running");
  const queued = input.jobs.filter((j) => j.state === "queued");
  const latest = input.jobs.filter((j) => j.state === "ready").sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))[0];
  const unfinished = input.handoffs.filter((h) => h.status !== "done").slice(0, 5);
  const scheduled = input.goals.filter((g) => g.schedule).slice(0, 5);

  const now = running.length
    ? running.map((j) => `◆ Making something for ${where(j.goalId)}${j.startedAt ? `, started <t:${unix(j.startedAt)}:R>` : ""}`).join("\n")
    : "Idle. Teach it something, then `/dum build`.";

  const fields = [
    { name: "Queue", value: queued.length ? queued.map((j) => `○ ${where(j.goalId)}`).join("\n") : "empty", inline: true },
    { name: "Waiting on you", value: input.pending.length ? input.pending.slice(0, 5).map((r) => `${r.kind === "teach" ? "teaching" : r.kind === "tried" ? "attempt" : "submit"} *${quiet(clip(r.concept, 40))}* in ${where(r.goalId)}`).join("\n") : "nothing", inline: true },
    { name: "Latest creation", value: latest?.result ? `[${clip(latest.result.title, 90)}](${jobLink(input.links, latest.id)})\n${where(latest.goalId)}${latest.finishedAt ? ` · <t:${unix(latest.finishedAt)}:R>` : ""}` : "none yet", inline: false },
    { name: "Handoffs in flight", value: unfinished.length ? unfinished.map((h) => `${STATUS_MARK[h.status]} ${quiet(clip(h.title, 60))} · *${clip(h.executor, 30)}*`).join("\n") : "none", inline: false },
    ...(scheduled.length ? [{ name: "Scheduled", value: scheduled.map((g) => `${where(g.id)} every ${g.schedule!.intervalMinutes} min · next <t:${unix(g.schedule!.nextRunAt)}:R>`).join("\n"), inline: false }] : []),
    { name: "Goals", value: input.goals.length ? input.goals.map((g) => where(g.id)).join(" · ") : "none yet: `/dum goal` in #dum", inline: false },
  ];
  return {
    embeds: [
      {
        title: "Dum, right now",
        description: now,
        color: running.length ? AMBER : DUSK,
        fields,
        footer: { text: "Lives on hub · reach it from Discord, Claude, omp and Codex" },
      },
    ],
  };
}

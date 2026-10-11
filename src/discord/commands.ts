// The /dum slash commands: their registration shape and what each one answers. Pure apart from
// the workshop calls passed in, so the routing and the owner check are testable without Discord.

import type { GoalView, JobView, Links } from "./delivery.ts";
import { jobLink } from "./delivery.ts";

export const COMMANDS = [
  {
    name: "dum",
    description: "Dum's workshop",
    dm_permission: false,
    options: [
      { type: 1, name: "status", description: "Recent creations and where they are" },
      { type: 1, name: "goals", description: "List goals" },
      {
        type: 1,
        name: "build",
        description: "Ask Dum to make something for a goal from what you've taught it",
        options: [{ type: 3, name: "goal", description: "Goal", required: true, autocomplete: true }],
      },
      {
        type: 1,
        name: "correct",
        description: "Ask for a new version of a creation; the original is kept",
        options: [
          { type: 3, name: "creation", description: "Creation to correct", required: true, autocomplete: true },
          { type: 3, name: "correction", description: "What it got wrong", required: true, max_length: 2000 },
        ],
      },
    ],
  },
];

export type Workshop = {
  goals(): Promise<GoalView[]>;
  jobs(): Promise<JobView[]>;
  build(goalId: string): Promise<JobView>;
  correct(jobId: string, correction: string): Promise<JobView>;
};

type Option = { name: string; type: number; value?: string; focused?: boolean; options?: Option[] };

export type Interaction = {
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { name: string; options?: Option[] };
};

export type Reply =
  | { type: 4; data: { content: string; flags?: number; allowed_mentions: { parse: [] } } }
  | { type: 8; data: { choices: { name: string; value: string }[] } };

export type Context = { ownerId: string; guildId: string; channelId: string; links: Links; workshop: Workshop };

const EPHEMERAL = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function say(content: string, ephemeral = false): Reply {
  return { type: 4, data: { content, ...(ephemeral ? { flags: EPHEMERAL } : {}), allowed_mentions: { parse: [] } } };
}

function short(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

export async function handle(i: Interaction, ctx: Context): Promise<Reply | null> {
  const caller = i.member?.user?.id ?? i.user?.id;
  const sub = i.data?.options?.[0];
  if (i.data?.name !== "dum" || !sub) return null;
  const allowed = caller === ctx.ownerId && i.guild_id === ctx.guildId && i.channel_id === ctx.channelId;

  if (i.type === 4) {
    if (!allowed) return { type: 8, data: { choices: [] } };
    return { type: 8, data: { choices: await choices(sub, ctx) } };
  }
  if (i.type !== 2) return null;
  if (!allowed) return say("Dum only takes requests from its owner, in its own channel.", true);

  const arg = (name: string) => sub.options?.find((o) => o.name === name)?.value?.trim() ?? "";
  const names = async () => new Map((await ctx.workshop.goals()).map((g) => [g.id, g.title]));

  switch (sub.name) {
    case "goals": {
      const goals = await ctx.workshop.goals();
      if (goals.length === 0) return say("No goals yet. Make one in the workshop first.", true);
      return say(goals.map((g) => `• ${short(g.title, 90)}`).join("\n"), true);
    }
    case "status": {
      const [jobs, goals] = await Promise.all([ctx.workshop.jobs(), names()]);
      const recent = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
      if (recent.length === 0) return say("Nothing built yet.", true);
      const lines = recent.map((j) => `\`${j.id.slice(0, 8)}\` ${j.state} · ${short(goals.get(j.goalId) ?? "?", 50)}${j.result ? ` · ${short(j.result.title, 70)}` : ""}`);
      return say(lines.join("\n"), true);
    }
    case "build": {
      const goalId = arg("goal");
      if (!UUID.test(goalId)) return say("Pick a goal from the list.", true);
      const job = await ctx.workshop.build(goalId);
      return say(`Queued \`${job.id.slice(0, 8)}\`. Its status message will follow here.`, true);
    }
    case "correct": {
      const jobId = arg("creation");
      const correction = arg("correction");
      if (!UUID.test(jobId)) return say("Pick a creation from the list.", true);
      if (!correction) return say("Say what it got wrong.", true);
      const job = await ctx.workshop.correct(jobId, correction);
      return say(`Queued correction \`${job.id.slice(0, 8)}\`. The original stays as it was: <${jobLink(ctx.links, jobId)}>`, true);
    }
  }
  return say("Unknown command.", true);
}

async function choices(sub: Option, ctx: Context): Promise<{ name: string; value: string }[]> {
  const focused = sub.options?.find((o) => o.focused);
  const q = (focused?.value ?? "").toLowerCase();
  if (sub.name === "build" && focused?.name === "goal") {
    const goals = await ctx.workshop.goals();
    return goals.filter((g) => g.title.toLowerCase().includes(q)).slice(0, 25).map((g) => ({ name: short(g.title, 100), value: g.id }));
  }
  if (sub.name === "correct" && focused?.name === "creation") {
    const jobs = (await ctx.workshop.jobs()).filter((j) => j.state === "ready" && j.result);
    return jobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((j) => j.result!.title.toLowerCase().includes(q) || j.id.startsWith(q))
      .slice(0, 25)
      .map((j) => ({ name: short(`${j.id.slice(0, 8)} ${j.result!.title}`, 100), value: j.id }));
  }
  return [];
}

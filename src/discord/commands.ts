// The /dum slash commands: their registration shape and what each one answers. Pure apart from
// the workshop and channel calls passed in, so routing, the owner check and the goal-per-channel
// rule are testable without Discord. Long text is entered through modals, not one-line options.

import type { GoalView, Workshop } from "../client/workshop.ts";
import type { Links } from "./delivery.ts";
import { goalLink, jobLink } from "./delivery.ts";

export type { Workshop };

const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;

const concept = (description: string) => ({ type: STRING, name: "concept", description, required: true, autocomplete: true, max_length: 160 });

export const COMMANDS = [
  {
    name: "dum",
    description: "Dum's workshop",
    dm_permission: false,
    options: [
      { type: 1, name: "goal", description: "Start a new goal; it gets its own channel" },
      { type: 1, name: "goals", description: "List goals and their channels" },
      { type: 1, name: "status", description: "Recent creations and where they are" },
      { type: 1, name: "progress", description: "What this goal's records say, concept by concept" },
      {
        type: 1,
        name: "study",
        description: "Read one of this goal's study materials",
        options: [{ type: STRING, name: "material", description: "Material", required: true, autocomplete: true }],
      },
      { type: 1, name: "studied", description: "Record that you studied a concept", options: [concept("Concept you studied")] },
      { type: 1, name: "teach", description: "Explain a concept to Dum in your own words", options: [concept("Concept you're teaching")] },
      {
        type: 1,
        name: "tried",
        description: "Report an attempt at a concept",
        options: [concept("Concept you tried"), { type: BOOLEAN, name: "helped", description: "Did you need help?", required: true }],
      },
      {
        type: 1,
        name: "revisit",
        description: "Flag a concept to come back to",
        options: [concept("Concept to revisit"), { type: STRING, name: "note", description: "What's shaky", required: true, max_length: 2000 }],
      },
      { type: 1, name: "context", description: "Edit or add to this goal's context" },
      { type: 1, name: "build", description: "Ask Dum to make something from what you've taught it" },
      {
        type: 1,
        name: "correct",
        description: "Ask for a new version of a creation; the original is kept",
        options: [
          { type: STRING, name: "creation", description: "Creation to correct", required: true, autocomplete: true },
          { type: STRING, name: "correction", description: "What it got wrong", required: true, max_length: 2000 },
        ],
      },
      {
        type: 1,
        name: "schedule",
        description: "Build on a timer; leave minutes empty to turn it off",
        options: [{ type: INTEGER, name: "minutes", description: "Minutes between builds", required: false, min_value: 1, max_value: 525600 }],
      },
    ],
  },
];

export type Channels = {
  /** The goal bound to a channel, or null for the lobby or an unknown channel. */
  goalFor(channelId: string): string | null;
  /** The goal's channel, if it has one yet. */
  channelFor(goalId: string): string | null;
  /** Makes the goal's channel now and returns its id. */
  open(goal: GoalView): Promise<string>;
};

type Option = { name: string; type: number; value?: string | number | boolean; focused?: boolean; options?: Option[] };
type Component = { type: number; custom_id?: string; value?: string; components?: Component[]; component?: Component };

export type Interaction = {
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { name?: string; options?: Option[]; custom_id?: string; components?: Component[] };
};

type Embed = { title: string; description: string; url?: string };
type Message = { content: string; embeds?: Embed[]; flags?: number; allowed_mentions: { parse: [] } };
type TextInput = { custom_id: string; label: string; style: 1 | 2; required: boolean; max_length: number; value?: string; placeholder?: string };

export type Reply =
  | { type: 4; data: Message }
  | { type: 8; data: { choices: { name: string; value: string }[] } }
  | { type: 9; data: { custom_id: string; title: string; components: { type: 1; components: (TextInput & { type: 4 })[] }[] } };

export type Context = { ownerId: string; guildId: string; lobbyId: string; links: Links; workshop: Workshop; channels: Channels };

const EPHEMERAL = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODAL_TEXT = 4000;

/** Commands whose first answer is a form; these must not be deferred. */
const MODAL_COMMANDS = new Set(["goal", "teach", "tried", "context"]);
/** Answers only the owner needs to see; everything else becomes part of the channel's record. */
const PRIVATE_COMMANDS = new Set(["goals", "status", "progress", "study", "build", "correct"]);

function sub(i: Interaction): Option | undefined {
  return i.data?.name === "dum" ? i.data.options?.[0] : undefined;
}

export function opensModal(i: Interaction): boolean {
  return i.type === 2 && MODAL_COMMANDS.has(sub(i)?.name ?? "");
}

export function isPrivate(i: Interaction): boolean {
  if (i.type === 5) return false;
  return PRIVATE_COMMANDS.has(sub(i)?.name ?? "");
}

function say(content: string, opts: { ephemeral?: boolean; embeds?: Embed[] } = {}): Reply {
  return { type: 4, data: { content, ...(opts.embeds ? { embeds: opts.embeds } : {}), ...(opts.ephemeral ? { flags: EPHEMERAL } : {}), allowed_mentions: { parse: [] } } };
}

function modal(custom_id: string, title: string, inputs: TextInput[]): Reply {
  return { type: 9, data: { custom_id, title: short(title, 45), components: inputs.map((input) => ({ type: 1, components: [{ type: 4, ...input }] })) } };
}

function short(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Quotes learner text back into the channel without letting it mention anyone. */
function quote(text: string, max = 1500): string {
  return short(text.trim(), max).replace(/@/g, "@​").split("\n").map((l) => `> ${l}`).join("\n");
}

function fields(components: Component[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (c: Component) => {
    if (c.custom_id && typeof c.value === "string") out.set(c.custom_id, c.value);
    c.components?.forEach(walk);
    if (c.component) walk(c.component);
  };
  components.forEach(walk);
  return out;
}

export async function handle(i: Interaction, ctx: Context): Promise<Reply | null> {
  const caller = i.member?.user?.id ?? i.user?.id;
  const channel = i.channel_id ?? "";
  const goalId = ctx.channels.goalFor(channel);
  const inPlace = channel === ctx.lobbyId || goalId !== null;
  const allowed = caller === ctx.ownerId && i.guild_id === ctx.guildId && inPlace;

  if (i.type === 5) {
    if (!allowed) return say("Dum only takes requests from its owner, in its own channels.", { ephemeral: true });
    return submit(i, ctx, goalId);
  }

  const s = sub(i);
  if (!s) return null;
  if (i.type === 4) return { type: 8, data: { choices: allowed ? await choices(s, ctx, goalId) : [] } };
  if (i.type !== 2) return null;
  if (!allowed) return say("Dum only takes requests from its owner, in its own channels.", { ephemeral: true });

  const opt = (name: string) => s.options?.find((o) => o.name === name)?.value;
  const text = (name: string) => String(opt(name) ?? "").trim();

  switch (s.name) {
    case "goal":
      return modal("goal", "New goal", [
        { custom_id: "title", label: "Title", style: 1, required: true, max_length: 160, placeholder: "CS 180: recursion" },
        { custom_id: "ambition", label: "What should Dum eventually be able to build?", style: 2, required: true, max_length: MODAL_TEXT },
      ]);
    case "goals": {
      const goals = await ctx.workshop.goals();
      if (goals.length === 0) return say("No goals yet. Start one with `/dum goal`.", { ephemeral: true });
      const lines = goals.map((g) => {
        const ch = ctx.channels.channelFor(g.id);
        return `• ${short(g.title, 90)}${ch ? ` <#${ch}>` : " (channel pending)"}`;
      });
      return say(lines.join("\n"), { ephemeral: true });
    }
    case "status": {
      const [jobs, goals] = await Promise.all([ctx.workshop.jobs(), ctx.workshop.goals()]);
      const names = new Map(goals.map((g) => [g.id, g.title]));
      const recent = jobs
        .filter((j) => goalId === null || j.goalId === goalId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8);
      if (recent.length === 0) return say("Nothing built yet.", { ephemeral: true });
      const lines = recent.map((j) => {
        const goal = goalId === null ? ` · ${short(names.get(j.goalId) ?? "?", 50)}` : "";
        return `\`${j.id.slice(0, 8)}\` ${j.state}${goal}${j.result ? ` · ${short(j.result.title, 70)}` : ""}`;
      });
      return say(lines.join("\n"), { ephemeral: true });
    }
  }

  // Everything below works on one goal: the one this channel belongs to.
  if (goalId === null) return say("Run this in a goal's own channel. `/dum goals` lists them.", { ephemeral: true });

  switch (s.name) {
    case "progress": {
      const concepts = await ctx.workshop.progress(goalId);
      const full = `Full progression and everything else for this goal: <${goalLink(ctx.links, goalId)}>`;
      if (concepts.length === 0) return say(`No records for this goal yet.\n${full}`, { ephemeral: true });
      const lines = concepts.map((c) => {
        const counts = Object.entries(c.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
        return `**${short(c.concept, 60)}**: ${counts || "no evidence"}${c.latest ? ` (latest: ${c.latest})` : ""}`;
      });
      return say(`${lines.join("\n")}\n-# These are your records, not a mastery score.\n${full}`, { ephemeral: true });
    }
    case "study": {
      const goal = await ctx.workshop.goal(goalId);
      const material = goal.materials.find((m) => m.id === text("material"));
      if (!material) return say("Pick a material from the list.", { ephemeral: true });
      const body = material.body.length > 4000 ? material.body.slice(0, 3990) + "\n…" : material.body;
      return say(`When you've read it: \`/dum studied concept:${material.concept}\``, { ephemeral: true, embeds: [{ title: short(material.title, 256), description: body, ...(material.url ? { url: material.url } : {}) }] });
    }
    case "studied": {
      const c = text("concept");
      if (!c) return say("Name the concept.", { ephemeral: true });
      await ctx.workshop.studied(goalId, c);
      return say(`Studied **${short(c, 160)}**.`);
    }
    case "teach": {
      const c = text("concept");
      if (!c) return say("Name the concept.", { ephemeral: true });
      // The concept rides in the form, prefilled, so it can be fixed before sending.
      return modal(`teach:${goalId}`, `Teach Dum: ${c}`, [
        { custom_id: "concept", label: "Concept", style: 1, required: true, max_length: 160, value: c },
        { custom_id: "text", label: "Explain it in your own words", style: 2, required: true, max_length: MODAL_TEXT },
      ]);
    }
    case "tried": {
      const c = text("concept");
      if (!c) return say("Name the concept.", { ephemeral: true });
      return modal(`tried:${goalId}:${opt("helped") === true ? "1" : "0"}`, `Attempt: ${c}`, [
        { custom_id: "concept", label: "Concept", style: 1, required: true, max_length: 160, value: c },
        { custom_id: "text", label: "What did you try, and what happened?", style: 2, required: true, max_length: MODAL_TEXT },
      ]);
    }
    case "revisit": {
      const c = text("concept");
      const note = text("note");
      if (!c || !note) return say("Name the concept and what's shaky.", { ephemeral: true });
      await ctx.workshop.revisit(goalId, c, note);
      return say(`Revisit **${short(c, 160)}**:\n${quote(note)}`);
    }
    case "context": {
      const goal = await ctx.workshop.goal(goalId);
      if (goal.baseContext.length <= MODAL_TEXT) {
        return modal(`context:${goalId}:edit`, "Goal context", [
          { custom_id: "context", label: "Notes, course info, anything Dum should know", style: 2, required: false, max_length: MODAL_TEXT, value: goal.baseContext },
        ]);
      }
      // Too long to edit in a Discord form; adding still works, editing stays on the web.
      return modal(`context:${goalId}:add`, "Add to goal context", [
        { custom_id: "context", label: "Added to the end of the existing context", style: 2, required: true, max_length: MODAL_TEXT },
      ]);
    }
    case "build": {
      const job = await ctx.workshop.build(goalId);
      return say(`Queued \`${job.id.slice(0, 8)}\`. Its status message will follow here.`, { ephemeral: true });
    }
    case "correct": {
      const jobId = text("creation");
      const correction = text("correction");
      if (!UUID.test(jobId)) return say("Pick a creation from the list.", { ephemeral: true });
      if (!correction) return say("Say what it got wrong.", { ephemeral: true });
      const parent = (await ctx.workshop.jobs()).find((j) => j.id === jobId);
      if (!parent || parent.goalId !== goalId) return say("That creation belongs to a different goal.", { ephemeral: true });
      const job = await ctx.workshop.correct(jobId, correction);
      return say(`Queued correction \`${job.id.slice(0, 8)}\`. The original stays as it was: <${jobLink(ctx.links, jobId)}>`, { ephemeral: true });
    }
    case "schedule": {
      const minutes = opt("minutes");
      const next = await ctx.workshop.schedule(goalId, typeof minutes === "number" ? minutes : null);
      if (!next) return say("Scheduled builds are off for this goal.");
      const at = Math.floor(Date.parse(next.nextRunAt) / 1000);
      return say(`Dum will build every ${next.intervalMinutes} minutes. Next one <t:${at}:R>.`);
    }
  }
  return say("Unknown command.", { ephemeral: true });
}

async function submit(i: Interaction, ctx: Context, channelGoal: string | null): Promise<Reply> {
  const [kind, goalId, flag] = (i.data?.custom_id ?? "").split(":");
  const f = fields(i.data?.components);
  const val = (name: string) => (f.get(name) ?? "").trim();

  if (kind === "goal") {
    const title = val("title");
    const ambition = val("ambition");
    if (!title || !ambition) return say("A goal needs a title and an ambition.", { ephemeral: true });
    const goal = await ctx.workshop.createGoal(title, ambition);
    const channel = await ctx.channels.open(goal).catch(() => null);
    return say(channel ? `New goal **${short(goal.title, 160)}** lives in <#${channel}>.` : `New goal **${short(goal.title, 160)}** made. Its channel couldn't be created; the reason is in the hub log.`);
  }

  // A form only acts on the goal of the channel it was opened in.
  if (!goalId || goalId !== channelGoal) return say("That form belongs to a different goal's channel.", { ephemeral: true });
  const c = val("concept");
  const text = val("text");

  if (kind === "teach") {
    if (!c || !text) return say("Teaching needs a concept and your explanation.", { ephemeral: true });
    await ctx.workshop.teach(goalId, c, text);
    return say(`Taught **${short(c, 160)}**:\n${quote(text)}`);
  }
  if (kind === "tried") {
    if (!c || !text) return say("An attempt needs a concept and what you tried.", { ephemeral: true });
    const helped = flag === "1";
    await ctx.workshop.tried(goalId, c, text, helped);
    return say(`Tried **${short(c, 160)}** (${helped ? "with help" : "no help"}, your report):\n${quote(text)}`);
  }
  if (kind === "context") {
    const typed = f.get("context") ?? "";
    if (flag === "add") {
      if (!typed.trim()) return say("Nothing to add.", { ephemeral: true });
      const goal = await ctx.workshop.goal(goalId);
      await ctx.workshop.setContext(goalId, `${goal.baseContext.trimEnd()}\n\n${typed.trim()}`);
      return say(`Added ${typed.trim().length} characters to this goal's context.`);
    }
    await ctx.workshop.setContext(goalId, typed);
    return say(`Updated this goal's context (${typed.trim().length} characters).`);
  }
  return say("That form isn't one Dum knows.", { ephemeral: true });
}

async function choices(s: Option, ctx: Context, goalId: string | null): Promise<{ name: string; value: string }[]> {
  const focused = s.options?.find((o) => o.focused);
  const q = String(focused?.value ?? "").toLowerCase().trim();
  if (goalId === null || !focused) return [];

  if (focused.name === "material") {
    const goal = await ctx.workshop.goal(goalId);
    return goal.materials.filter((m) => m.title.toLowerCase().includes(q)).slice(0, 25).map((m) => ({ name: short(m.title, 100), value: m.id }));
  }
  if (focused.name === "concept") {
    // Known concepts first, but anything typed is a valid concept too.
    const [goal, progress] = await Promise.all([ctx.workshop.goal(goalId), ctx.workshop.progress(goalId)]);
    const known = [...new Set([...goal.materials.map((m) => m.concept), ...progress.map((p) => p.concept)])];
    const typed = String(focused.value ?? "").trim();
    const list = known.filter((k) => k.toLowerCase().includes(q));
    if (typed && !list.some((k) => k.toLowerCase() === q)) list.unshift(typed);
    return list.slice(0, 25).map((k) => ({ name: short(k, 100), value: short(k, 100) }));
  }
  if (focused.name === "creation") {
    const jobs = (await ctx.workshop.jobs()).filter((j) => j.goalId === goalId && j.state === "ready" && j.result);
    return jobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((j) => j.result!.title.toLowerCase().includes(q) || j.id.startsWith(q))
      .slice(0, 25)
      .map((j) => ({ name: short(`${j.id.slice(0, 8)} ${j.result!.title}`, 100), value: j.id }));
  }
  return [];
}

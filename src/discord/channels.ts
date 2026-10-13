// One private Discord channel per goal, under one private category. Pure planning: given the
// workshop's goals, what the bot has bound, and (when known) which channels still exist, decide
// what to create or forget. The bot does the Discord calls and records the result.

import type { GoalView } from "./delivery.ts";

export type Bindings = {
  schemaVersion: 1;
  categoryId?: string;
  goals: Record<string, { channelId: string }>;
};

export type ChannelPlan = {
  /** The category is missing and must be made before any channel. */
  category: boolean;
  /** Goals that need a channel, oldest first. */
  create: GoalView[];
  /** Goals whose channel was deleted in Discord; their binding is dropped so it is made again. */
  forget: string[];
  /** Goals that no longer exist in the workshop; unbound, and their channel is left as it is. */
  orphaned: string[];
};

export const VIEW_CHANNEL = 1024n;
/** View, send, embed links, attach files, read history: exactly what the bot was invited with. */
export const BOT_ALLOW = 117760n;

export function emptyBindings(): Bindings {
  return { schemaVersion: 1, goals: {} };
}

/** A Discord text channel name for a goal title. */
export function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/, "");
  return s || "goal";
}

/** `existing` is the guild's current channel ids, or null when this pass didn't fetch them. */
export function planChannels(goals: GoalView[], bindings: Bindings, existing: Set<string> | null): ChannelPlan {
  const forget = existing
    ? Object.entries(bindings.goals).filter(([, b]) => !existing.has(b.channelId)).map(([goalId]) => goalId)
    : [];
  const gone = new Set(forget);
  const live = new Set(goals.map((g) => g.id));
  const orphaned = Object.keys(bindings.goals).filter((goalId) => !live.has(goalId));
  const category = !bindings.categoryId || (existing !== null && !existing.has(bindings.categoryId));
  const create = goals.filter((g) => !bindings.goals[g.id] || gone.has(g.id));
  return { category, create, forget: forget.filter((id) => live.has(id)), orphaned };
}

/** Private to everyone but the owner (who sees all as server owner) and the bot. */
export function overwrites(guildId: string, botId: string) {
  return [
    { id: guildId, type: 0, allow: "0", deny: VIEW_CHANNEL.toString() },
    { id: botId, type: 1, allow: BOT_ALLOW.toString(), deny: "0" },
  ];
}

export function topic(ambition: string, link: string): string {
  const flat = ambition.replace(/\s+/g, " ").trim();
  const room = 1024 - link.length - 3;
  return `${flat.length > room ? flat.slice(0, room - 1) + "…" : flat} · ${link}`;
}

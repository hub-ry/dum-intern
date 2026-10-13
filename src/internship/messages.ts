// The Discord messages the internship watcher posts. Pure: every input, including the date, is
// passed in. Short, warm, a bit goofy; Discord markdown without headers; never an em dash.

import { GOOD, type Fit } from "./fit.ts";
import { SOURCES, type Source } from "./listings.ts";
import { daysBetween, short, type Known, type Loop } from "./tracker.ts";

/** Discord's limit is 2000; leave room for the mention. */
export const LIMIT = 1900;

export type Labeled = Fit & { known: Known | "draft" | null };

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const md = (s: string) => s.replace(/([*_~`|\[\]])/g, "\\$1");

/** One posting on one line: company, linked title, best city, and why it fits. */
export function line(f: Labeled): string {
  const where = `${f.locations[0] ?? "?"}${f.locations.length + f.moreLocations > 1 ? ` +${f.locations.length - 1 + f.moreLocations}` : ""}`;
  const notes = [...f.why];
  if (f.known === "draft") notes.push("you have a draft for them");
  else if (f.known?.kind === "rejected") notes.push(`they passed on ${clip(f.known.application.role || "an earlier app", 30)}, new req though`);
  const flags = f.flags.length ? ` ⚠️ ${f.flags.join(", ")}` : "";
  return `**${md(f.company)}** - [${md(clip(f.title, 70))}](<${f.url}>) - ${md(where)}${notes.length ? ` (${notes.join(", ")})` : ""}${flags}`;
}

/**
 * Packs lines into as few messages as Discord allows, never splitting a line. The first message
 * carries the mention, so it gets a little less room.
 */
export function chunks(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const l of lines) {
    const room = out.length === 0 ? LIMIT - 40 : LIMIT;
    if (cur.length > 0 && len + l.length + 1 > room) {
      out.push(cur.join("\n").trim());
      cur = [];
      len = 0;
    }
    cur.push(l.length > LIMIT ? clip(l, LIMIT) : l);
    len += l.length + 1;
  }
  if (cur.length > 0) out.push(cur.join("\n").trim());
  return out.filter(Boolean);
}

const numbered = (fits: Labeled[]) => fits.map((f, i) => `${i + 1}. ${line(f)}`);
const sourceList = (sources: Source[]) => sources.map((s) => `[${SOURCES[s].label}](<${SOURCES[s].page}>)`).join(" + ");

export function firstRun(o: { top: Labeled[]; good: number; total: number; sources: Source[]; cadence: string }): string[] {
  return chunks([
    `hiii, I'm on internship watch now 👀 I read ${sourceList(o.sources)} ${o.cadence} and ping you here when something new fits. I only read the boards. The applying part is all you.`,
    "",
    `The ${o.top.length} best open ones you haven't applied to yet:`,
    ...numbered(o.top),
    "",
    `That's out of **${o.good}** good fits open right now. I marked all ${o.total.toLocaleString("en-US")} current postings as seen, so from here on you only hear about new ones.`,
    "-# ranked by your cities, logistics / systems / recsys, and the target list in tracker.md. Defense stays filtered out.",
  ]);
}

export function newPostings(o: { fits: Labeled[]; more: number; already: Labeled[]; newCount: number; sources: Source[] }): string[] {
  const n = o.fits.length;
  const lines = [`fresh internship drop 🍞 ${n === 1 ? "one new posting fits" : `${n} new postings fit`} you:`, ...numbered(o.fits)];
  if (o.more > 0) lines.push(`+${o.more} more good ones, they're in tomorrow morning's count`);
  if (o.already.length > 0) {
    const names = o.already.slice(0, 4).map((f) => `${md(f.company)} ([${md(clip(f.title, 40))}](<${f.url}>))`);
    lines.push(`Also new at places you've already applied: ${names.join(", ")}${o.already.length > 4 ? ` and ${o.already.length - 4} more` : ""}.`);
  }
  lines.push(`-# ${o.newCount} new postings on ${sourceList(o.sources)} since my last look, these are the ones that fit. I never apply for you.`);
  return chunks(lines);
}

const OPENERS = [
  "good morning! ☕ internship nag for **{day}**",
  "rise and shine, future intern ☀️ it's **{day}**",
  "morning! your friendly neighborhood nag here 🐸 **{day}** edition",
  "gm! the internship goblin has arrived 👺 **{day}**",
  "**{day}**: a fine day to send some applications 🫖",
  "wakey wakey, Minneapolis is waiting 🌆 **{day}** check-in",
];

const CLOSERS = [
  "Mission: apply to at least **{n}** today, then log each one in tracker.md the minute you hit submit 📝",
  "Today's quest: **{n}** applications. Log them in tracker.md right after, future you will thank you 📝",
  "Goal: **{n}** apps before bed. Thirty seconds each to log them in tracker.md 📝",
];

/** Stable per day, so a re-run on the same morning says the same thing. */
const pick = <T,>(list: T[], day: string) => list[Math.abs([...day].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % list.length]!;

export type NagInput = {
  today: string;
  /** "Tuesday, Oct 13" */
  todayLabel: string;
  weekend: boolean;
  /** Good, open, not yet applied to; undefined when the boards couldn't be read this morning. */
  open?: { good: number; topCities: number; picks: Labeled[] };
  loops: Loop[];
  recent: { lastWeek: number; last?: { company: string; applied?: string } };
};

export function nag(o: NagInput): string[] {
  const lines = [pick(OPENERS, o.today).replace("{day}", o.todayLabel)];
  if (o.open) {
    const cities = o.open.topCities > 0 ? ` (${o.open.topCities} in the Twin Cities or Pittsburgh)` : "";
    lines.push(`**${o.open.good}** good fits are open that you haven't applied to${cities}.`);
  } else {
    lines.push("I couldn't read the job boards this morning, so no counts today. The rest still stands.");
  }
  const { lastWeek, last } = o.recent;
  let tally = `Applications logged in the last 7 days: **${lastWeek}**`;
  if (lastWeek === 0 && last?.applied) {
    const ago = daysBetween(last.applied, o.today);
    tally += `. Last one was ${md(last.company)} on ${short(last.applied)}, ${ago} days ago${ago >= 10 ? ". The tracker misses you 🥺" : ""}`;
  }
  lines.push(tally.endsWith("🥺") ? tally : `${tally}.`);

  if (o.loops.length > 0) {
    lines.push("", "Time-sensitive:");
    for (const l of o.loops.slice(0, 4)) lines.push(`- ${l.text}`);
  }
  const target = o.open ? Math.min(o.weekend ? 1 : 2, o.open.good) : o.weekend ? 1 : 2;
  const closer = target > 0 ? pick(CLOSERS, o.today).replace("{n}", String(target)) : "No good fits open right now, so spend today on a referral ask or a LeetCode problem instead 💪";
  const picks = o.open?.picks ?? [];
  return chunks([...lines, ...(picks.length > 0 ? ["", "Today's picks:", ...numbered(picks)] : []), "", closer]);
}

export function broken(o: { hours: number; error: string }): string {
  return `heads up: I haven't been able to read the internship boards for about ${o.hours} hours, so you're not getting new postings from me right now 😵 An engineer should look at \`journalctl --user -u dum-internship-scan\` on hub. (${clip(o.error, 150)})`;
}

export { GOOD };

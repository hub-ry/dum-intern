// Reads Ryan's application tracker (~/internship/applications/tracker.md) and per-company notes.
// Pure: callers pass the text and today's date. Never writes anything back; the tracker is his.

import { normalizeCompany, sameCompany } from "./listings.ts";

export type Application = {
  company: string;
  /** Extra names the same application is known by, e.g. the parent in "Kensho (S&P Global)". */
  aliases: string[];
  role: string;
  /** ISO date, when the row has a real one. */
  applied?: string;
  referral: string;
  status: string;
  stage: "applied" | "pending" | "rejected" | "offer" | "ghosted";
  notes: string;
};

export type Draft = { company: string; state: string; action: string };

export type Tracker = {
  applications: Application[];
  drafts: Draft[];
  /** Target-list companies with no application yet. */
  targets: string[];
};

/** Strips markdown emphasis, strike-through and decorative emoji from a table cell. */
export function clean(cell: string): string {
  return cell
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
    .replace(/[⭐✅❌⚠️️🔥]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const isSeparator = (line: string) => /^\|?\s*:?-{3,}/.test(line.trim()) && /^[|\s:-]+$/.test(line.trim());

function stageOf(status: string): Application["stage"] {
  const s = status.toLowerCase();
  if (/rejected|declined/.test(s)) return "rejected";
  if (/offer/.test(s)) return "offer";
  if (/ghost/.test(s)) return "ghosted";
  if (/\boa\b|interview|phone|onsite|coffee chat|assessment|screen|take[- ]home|superday/.test(s)) return "pending";
  return "applied";
}

/** Reads the tracker's tables by their headers, so new rows and blank lines between them are fine. */
export function parseTracker(text: string): Tracker {
  const lines = text.split("\n");
  const applications: Application[] = [];
  const drafts: Draft[] = [];
  const targets: string[] = [];
  let header: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) {
      if (line.trim()) header = null; // prose ends a table; a blank line between rows does not
      continue;
    }
    if (isSeparator(line)) continue;
    const row = cells(line);
    if (lines[i + 1] && isSeparator(lines[i + 1]!)) {
      header = row.map((c) => clean(c).toLowerCase());
      continue;
    }
    if (!header) continue;
    const col = (name: string) => {
      const n = header!.findIndex((h) => h.startsWith(name));
      return n >= 0 ? (row[n] ?? "") : "";
    };
    const rawCompany = col("company");
    if (!rawCompany || /^~~/.test(rawCompany.trim())) continue;
    const company = clean(rawCompany).replace(/\s*\(.*?\)\s*/g, " ").trim();
    const aliases = [...clean(rawCompany).matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!.trim()).filter((a) => a.length >= 3 && !/,/.test(a));
    if (header.includes("status") && header.includes("applied")) {
      const status = clean(col("status"));
      applications.push({
        company,
        aliases,
        role: clean(col("role")),
        applied: col("applied").match(/\d{4}-\d{2}-\d{2}/)?.[0],
        referral: clean(col("referral")),
        status,
        stage: stageOf(status),
        notes: clean(col("notes")),
      });
    } else if (header.includes("state") && header.includes("action")) {
      drafts.push({ company, state: clean(col("state")), action: clean(col("action")) });
    } else if (header.includes("city") && header.some((h) => h.startsWith("applied"))) {
      // "Amazon (supply-chain orgs)" targets part of a company; the domain scoring covers that part.
      if (!clean(col("applied")).trim() && !/\(/.test(rawCompany)) targets.push(...company.split(/\s*\/\s*/).filter(Boolean));
    }
  }
  return { applications, drafts, targets: targets.filter((t) => !applications.some((a) => sameCompany(a.company, t))) };
}

export type Known = { kind: "tracked" | "rejected"; application: Application };

/**
 * Whether Ryan already has this company in the tracker. Any live application or draft means skip;
 * if every application there was rejected, the posting is shown but marked.
 */
export function known(company: string, tracker: Tracker, notes: Note[] = []): Known | "draft" | null {
  const apps = tracker.applications.filter((a) => [a.company, ...a.aliases].some((n) => sameCompany(n, company)));
  if (apps.length > 0) {
    const live = apps.find((a) => a.stage !== "rejected");
    return live ? { kind: "tracked", application: live } : { kind: "rejected", application: apps[apps.length - 1]! };
  }
  if (tracker.drafts.some((d) => sameCompany(d.company, company))) return "draft";
  if (unsent(notes).some((n) => sameCompany(n.company, company))) return "draft";
  return null;
}

/** Per-company notes whose status says the application was prepared but never sent. */
export function unsent(notes: Note[]): { company: string; file: string; summer: boolean; text: string }[] {
  const out = [];
  for (const n of notes) {
    if (!/status:\**\s*_?\(?not submitted/i.test(n.text)) continue;
    const h1 = n.text.match(/^#\s+(.+)$/m)?.[1] ?? "";
    const company = h1.split(/\s+[-–]\s+/)[0]!.trim();
    if (company) out.push({ company, file: n.file, summer: !(/winter|spring|fall/i.test(h1) && !/summer/i.test(h1)), text: n.text });
  }
  return out;
}

/** The note file that belongs to an application, by its first heading. */
export function noteFor(company: string, notes: Note[]): Note | undefined {
  return notes.find((n) => sameCompany((n.text.match(/^#\s+(.+)$/m)?.[1] ?? "").split(/\s+[-–]\s+/)[0]!.trim(), company));
}

/** The next future date a note gives for applications closing ("Applications close 2026-10-30"). */
export function closesOn(text: string, today: string): string | undefined {
  const dates = [...text.matchAll(/\bclos(?:e|es|ing)\b[^.|;\n]{0,25}?(\d{4}-\d{2}-\d{2})/gi)].map((m) => m[1]!);
  return dates.filter((d) => d >= today).sort()[0];
}

// --- Dates ----------------------------------------------------------------------------------

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const short = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** Monday of the week containing `today`. */
export function weekStart(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(today, -((dow + 6) % 7));
}

/** A month-day with no year means the occurrence closest to today. */
function resolve(month: number, day: number, today: string): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = Number(today.slice(0, 4));
  const options = [year - 1, year, year + 1].map((y) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  return options.sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)))[0];
}

/** The date a "due / deadline / apply by" phrase names, if the text has one. */
export function dueDate(text: string, today: string): string | undefined {
  const m = text.match(/\b(?:due|deadline|apply[- ]by|closes?|expires?|by)\b[^.|;]{0,25}?(\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2})\b/i);
  if (!m) return undefined;
  const d = m[1]!;
  if (/^\d{4}-/.test(d)) return d;
  const [mm, dd] = d.split(/[-/]/).map(Number);
  return resolve(mm!, dd!, today);
}

// --- What needs doing -----------------------------------------------------------------------

export type Note = { file: string; text: string };

export type Loop = { urgency: number; text: string };

/** Time-sensitive items in the tracker and notes, most urgent first. */
export function openLoops(tracker: Tracker, notes: Note[], today: string): Loop[] {
  const loops: Loop[] = [];
  for (const a of tracker.applications) {
    if (/promised|not delivered|not attached/i.test(a.referral)) {
      const since = a.applied ? ` (${daysBetween(a.applied, today)} days since you applied)` : "";
      loops.push({ urgency: 80, text: `**${a.company}**: the referral follow-up email still isn't sent${since} and the referral isn't attached yet. Send the recruiter the req and your confirmation number today.` });
    }
    if (a.stage === "pending") {
      const due = dueDate(`${a.status} ${a.notes}`, today);
      const left = due ? daysBetween(today, due) : undefined;
      const note = noteFor(a.company, notes);
      const closes = note ? closesOn(note.text, today) : undefined;
      const closing = closes && daysBetween(today, closes) <= 30 ? ` Applications close **${short(closes)}** (${daysBetween(today, closes)}d).` : "";
      if (due && left !== undefined && left >= 0 && left <= 14) loops.push({ urgency: 100 - left, text: `**${a.company}** ${a.status}: due **${short(due)}** (${left === 0 ? "today" : `${left}d`}).${closing}` });
      else if (due && left !== undefined && left < 0) loops.push({ urgency: closing ? 65 : 60, text: `**${a.company}** ${a.status}: was due ${short(due)} and the outcome isn't logged.${closing}` });
      else loops.push({ urgency: closing ? 55 : 50, text: `**${a.company}** ${a.status}: nothing logged since. Where does it stand?${closing}` });
    } else if (a.stage === "applied") {
      const due = dueDate(a.notes, today);
      const left = due ? daysBetween(today, due) : undefined;
      if (due && left !== undefined && left >= 0 && left <= 14) loops.push({ urgency: 90 - left, text: `**${a.company}**: deadline **${short(due)}** (${left}d).` });
    }
  }
  for (const d of tracker.drafts) {
    if (/hard fail|ineligib|do not|don't|not eligible/i.test(`${d.state} ${d.action}`)) continue;
    const action = d.action.split(/(?<=\.)\s/)[0] ?? d.action;
    loops.push({ urgency: 40, text: `**${d.company}**: ${d.state}. ${action}` });
  }
  for (const n of unsent(notes)) {
    if (!n.summer) continue;
    if (tracker.applications.some((a) => sameCompany(a.company, n.company))) continue;
    if (tracker.drafts.some((d) => sameCompany(d.company, n.company))) continue;
    const due = dueDate(n.text, today);
    const left = due ? daysBetween(today, due) : undefined;
    const when = due && left !== undefined && left >= 0 && left <= 14 ? ` Deadline **${short(due)}**.` : "";
    loops.push({ urgency: when ? 85 : 45, text: `**${n.company}**: resume variant built, never submitted (\`${n.file}\`).${when}` });
  }
  return loops.sort((a, b) => b.urgency - a.urgency);
}

/** Companies the tracker knows in any form, normalized, for quick membership checks. */
export function trackedNames(tracker: Tracker): string[] {
  return [...tracker.applications.flatMap((a) => [a.company, ...a.aliases]), ...tracker.drafts.map((d) => d.company)].map(normalizeCompany);
}

/** Applications with a logged date in the 7 days ending today, and the most recent one. */
export function recentApplications(tracker: Tracker, today: string): { lastWeek: number; last?: Application } {
  const dated = tracker.applications.filter((a) => a.applied && a.applied <= today).sort((a, b) => a.applied!.localeCompare(b.applied!));
  return { lastWeek: dated.filter((a) => daysBetween(a.applied!, today) < 7).length, last: dated[dated.length - 1] };
}

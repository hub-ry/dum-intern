// The internship watcher: reads public job boards and Ryan's tracker, then posts to the internship
// goal's Discord channel. Read and notify only. It never opens, fills in or submits an application.
//
//   tsx src/internship/watch.ts scan [--dry-run]   new postings since the last scan (first run: a short top list)
//   tsx src/internship/watch.ts nag  [--dry-run] [--force]   the morning summary and push (once a day)
//
// Runs from systemd user timers (deploy/dum-internship-*.timer). Reads the bot token from the file
// the Discord service already uses (DUM_DISCORD_TOKEN_FILE) and the goal's channel from the bot's
// channels.json, so a recreated channel is followed automatically. State lives in
// DUM_INTERNSHIP_STATE_DIR (default ~/.local/state/dum-internship).

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rest } from "../discord/rest.ts";
import { GOOD, shortlist, spread, type Prefs } from "./fit.ts";
import { merge, parseSimplify, parseSpeedyApply, SOURCES, type Posting, type Source } from "./listings.ts";
import { broken, firstRun, nag, newPostings, type Labeled } from "./messages.ts";
import { known, openLoops, parseTracker, recentApplications, type Note, type Tracker } from "./tracker.ts";

const env = process.env;
const home = homedir();
const STATE_DIR = env.DUM_INTERNSHIP_STATE_DIR ?? join(home, ".local/state/dum-internship");
const WORKSPACE = env.DUM_INTERNSHIP_HOME ?? join(home, "internship");
const GOAL = env.DUM_INTERNSHIP_GOAL ?? "a0930111-617c-4f59-9669-1b0b49019c58";
const DISCORD_STATE = env.DUM_DISCORD_STATE_DIR ?? join(home, ".local/state/dum-discord");
const TZ = "America/Indiana/Indianapolis";
const CADENCE = "every 4 hours from 7am to 11pm";
const FIRST_RUN_TOP = 10;
const NEW_MAX = 8;
const NAG_PICKS = 3;
/** Consecutive failed scans before Ryan is told the watcher is broken (scans are ~4h apart). */
const BROKEN_AFTER = 3;
/** Forget seen postings after a year so the file can't grow without bound. */
const SEEN_TTL = 365 * 86_400;

const log = (msg: string) => console.log(`[internship] ${msg}`);

// --- State ----------------------------------------------------------------------------------

type ScanState = {
  schemaVersion: 1;
  /** Posting key -> unix seconds first seen. */
  seen: Record<string, number>;
  lastScan: number;
  failures: number;
  /** Set once the "watcher is broken" note is posted, cleared by the next good scan. */
  brokenNoticeAt?: number;
};
type NagState = { schemaVersion: 1; picks: { day: string; keys: string[] }[]; /** The last day a nag was posted, so a late or repeated run stays quiet. */ lastDay?: string };

function readJson<T>(name: string): T | undefined {
  const path = join(STATE_DIR, name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(name: string, value: unknown) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = join(STATE_DIR, name);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

// --- Inputs ---------------------------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { "user-agent": "dum-internship-watch (hub)" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
}

type Boards = { postings: Posting[]; sources: Source[] };

/** Simplify is required; speedyapply only adds coverage, so its failure is logged and skipped. */
async function readBoards(now: number): Promise<Boards> {
  const simplify = parseSimplify(await fetchText(SOURCES.simplify.url));
  const sources: Source[] = ["simplify"];
  let speedy: Posting[] = [];
  try {
    speedy = parseSpeedyApply(await fetchText(SOURCES.speedyapply.url), now);
    sources.push("speedyapply");
  } catch (err) {
    log(`speedyapply skipped: ${(err as Error).message}`);
  }
  const postings = merge(simplify, speedy);
  log(`read ${simplify.length} Simplify + ${speedy.length} speedyapply postings, ${postings.length} after merging`);
  return { postings, sources };
}

function readWorkspace(): { tracker: Tracker; notes: Note[] } {
  const dir = join(WORKSPACE, "applications");
  const tracker = parseTracker(readFileSync(join(dir, "tracker.md"), "utf8"));
  const notes = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "tracker.md")
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
  return { tracker, notes };
}

function today(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).formatToParts(now).map((p) => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  const label = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(now);
  return { iso, label, weekend: parts.weekday === "Saturday" || parts.weekday === "Sunday" };
}

// --- Discord --------------------------------------------------------------------------------

function discordTarget() {
  const channels = JSON.parse(readFileSync(join(DISCORD_STATE, "channels.json"), "utf8")) as { goals?: Record<string, { channelId?: string }> };
  const channel = channels.goals?.[GOAL]?.channelId;
  if (!channel) throw new Error(`no Discord channel recorded for goal ${GOAL} in ${DISCORD_STATE}/channels.json`);
  const tokenFile = env.DUM_DISCORD_TOKEN_FILE;
  if (!tokenFile) throw new Error("DUM_DISCORD_TOKEN_FILE is not set (the service reads it from ~/.config/dum-discord/environment)");
  return { channel, token: readFileSync(tokenFile, "utf8").trim(), owner: env.DUM_DISCORD_OWNER_ID };
}

/**
 * Posts the parts in order, Ryan mentioned in the first one and link previews off, then reads each
 * message back to prove it landed.
 */
async function post(parts: string[]): Promise<string[]> {
  const { channel, token, owner } = discordTarget();
  const discord = rest(token);
  const ids: string[] = [];
  for (const [i, part] of parts.entries()) {
    const content = i === 0 && owner ? `<@${owner}> ${part}` : part;
    if (content.length > 2000) throw new Error(`message is ${content.length} characters, over Discord's 2000`);
    const sent = (await discord("POST", `/channels/${channel}/messages`, { content, allowed_mentions: { users: i === 0 && owner ? [owner] : [] }, flags: 4 })) as { id: string };
    const back = (await discord("GET", `/channels/${channel}/messages/${sent.id}`)) as { id: string; content: string };
    if (back.content.trim() !== content.trim()) log(`warning: message ${sent.id} reads back differently than it was sent`);
    log(`posted message ${sent.id} to channel ${channel} (${content.length} chars), confirmed by reading it back`);
    ids.push(sent.id);
  }
  return ids;
}

async function say(parts: string[], dry: boolean) {
  if (dry) {
    for (const part of parts) console.log(`--- would post (${part.length} chars) ---\n${part}`);
    console.log("---");
    return;
  }
  await post(parts);
}

// --- Jobs -----------------------------------------------------------------------------------

function label(fits: ReturnType<typeof shortlist>, tracker: Tracker, notes: Note[]): Labeled[] {
  return fits.map((f) => ({ ...f, known: known(f.company, tracker, notes) }));
}
const applied = (f: Labeled) => f.known !== null && f.known !== "draft" && f.known.kind === "tracked";

async function scan(dry: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const state = readJson<ScanState>("scan.json");
  let boards: Boards;
  try {
    boards = await readBoards(now);
  } catch (err) {
    const failures = (state?.failures ?? 0) + 1;
    log(`scan failed (${failures} in a row): ${(err as Error).message}`);
    if (!dry && state) {
      let brokenNoticeAt = state.brokenNoticeAt;
      if (failures >= BROKEN_AFTER && !brokenNoticeAt) {
        await post([broken({ hours: Math.round((now - state.lastScan) / 3600), error: (err as Error).message })]);
        brokenNoticeAt = now;
      }
      writeJson("scan.json", { ...state, failures, brokenNoticeAt });
    }
    throw err;
  }
  const { tracker, notes } = readWorkspace();
  const prefs: Prefs = { now, targets: tracker.targets };
  const fits = label(shortlist(boards.postings, prefs), tracker, notes);

  if (!state) {
    const open = fits.filter((f) => f.score >= GOOD && !applied(f));
    const top = spread(open, 1).slice(0, FIRST_RUN_TOP);
    log(`first run: ${fits.length} shortlisted, ${open.length} good and not applied to`);
    await say(firstRun({ top, good: open.length, total: boards.postings.length, sources: boards.sources, cadence: CADENCE }), dry);
  } else {
    const fresh = fits.filter((f) => !(f.key in state.seen));
    const newKeys = boards.postings.filter((p) => !(p.key in state.seen)).length;
    const good = fresh.filter((f) => f.score >= GOOD);
    const wanted = spread(good.filter((f) => !applied(f)), 2);
    const push = wanted.slice(0, NEW_MAX);
    const already = good.filter(applied);
    log(`${newKeys} new postings, ${fresh.length} shortlisted, ${push.length} to push, ${already.length} at companies already applied to`);
    if (push.length > 0) await say(newPostings({ fits: push, more: good.filter((f) => !applied(f)).length - push.length, already, newCount: newKeys, sources: boards.sources }), dry);
    else log("nothing new worth a ping");
  }
  if (dry) return;
  const seen: Record<string, number> = {};
  for (const [k, t] of Object.entries(state?.seen ?? {})) if (now - t < SEEN_TTL) seen[k] = t;
  for (const p of boards.postings) seen[p.key] ??= now;
  writeJson("scan.json", { schemaVersion: 1, seen, lastScan: now, failures: 0 } satisfies ScanState);
}

async function morning(dry: boolean) {
  const now = new Date();
  const day = today(now);
  const nagState = readJson<NagState>("nag.json") ?? { schemaVersion: 1, picks: [] };
  if (nagState.lastDay === day.iso && !dry && !flags.includes("--force")) {
    log(`already nagged on ${day.iso}; pass --force to post again`);
    return;
  }
  const { tracker, notes } = readWorkspace();
  let open: { good: number; topCities: number; picks: Labeled[] } | undefined;
  try {
    const boards = await readBoards(Math.floor(now.getTime() / 1000));
    const fits = label(shortlist(boards.postings, { now: Math.floor(now.getTime() / 1000), targets: tracker.targets }), tracker, notes);
    const good = fits.filter((f) => f.score >= GOOD && !applied(f));
    // Don't repeat the same three picks every morning: skip ones picked in the last three nags.
    const recent = new Set(nagState.picks.filter((p) => p.day !== day.iso).slice(-3).flatMap((p) => p.keys));
    const picks = spread([...good.filter((f) => !recent.has(f.key)), ...good.filter((f) => recent.has(f.key))], 1).slice(0, NAG_PICKS);
    open = { good: good.length, topCities: good.filter((f) => f.why.includes("Twin Cities") || f.why.includes("Pittsburgh")).length, picks };
  } catch (err) {
    log(`boards unreadable for the nag: ${(err as Error).message}`);
  }
  const text = nag({
    today: day.iso,
    todayLabel: day.label,
    weekend: day.weekend,
    open,
    loops: openLoops(tracker, notes, day.iso),
    recent: recentApplications(tracker, day.iso),
  });
  await say(text, dry);
  if (dry) return;
  const picks = open ? [...nagState.picks.filter((p) => p.day !== day.iso), { day: day.iso, keys: open.picks.map((p) => p.key) }].slice(-14) : nagState.picks;
  writeJson("nag.json", { schemaVersion: 1, picks, lastDay: day.iso } satisfies NagState);
}

const [command, ...flags] = process.argv.slice(2);
const dry = flags.includes("--dry-run");
const jobs: Record<string, (dry: boolean) => Promise<void>> = { scan, nag: morning };
const job = command ? jobs[command] : undefined;
if (!job) {
  console.error("usage: watch.ts scan|nag [--dry-run] [--force]");
  process.exit(2);
}
job(dry).catch((err) => {
  console.error(`[internship] ${command} failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

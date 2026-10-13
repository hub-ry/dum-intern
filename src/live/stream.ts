// The live view service. Samples hub's virtual screen every two seconds and, while it changes,
// keeps one message in a private #hub-live channel showing it. Ryan watches from Discord on any
// device; the link in the message opens the real screen (noVNC) on his tailnet to take over.
//
//   DUM_DISCORD_TOKEN_FILE, DUM_DISCORD_GUILD_ID, DUM_DISCORD_STATE_DIR (shared with the bot,
//   whose channels.json names the "Dum goals" category), DUM_LIVE_DISPLAY (default :99),
//   DUM_LIVE_VIEWER_URL (the noVNC page), DUM_LIVE_PAUSE_FILE (default as `dum live pause`).

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { overwrites } from "../discord/channels.ts";
import { DiscordError, gone, rest, UNKNOWN_CHANNEL } from "../discord/rest.ts";
import { FRAME_NAME, liveMessage, moved, pausedNow, SAMPLE_MS, step, THUMB_H, THUMB_W, type Action, type Live, type View } from "./live.ts";
import { DEFAULT_PAUSE, readPause } from "./pause.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_PINGS = { parse: [] as string[] };
const SILENT = 4096;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

const config = {
  token: readFileSync(need("DUM_DISCORD_TOKEN_FILE"), "utf8").trim(),
  guildId: need("DUM_DISCORD_GUILD_ID"),
  stateDir: need("DUM_DISCORD_STATE_DIR"),
  display: process.env.DUM_LIVE_DISPLAY?.trim() || ":99",
  viewer: need("DUM_LIVE_VIEWER_URL"),
  pauseFile: process.env.DUM_LIVE_PAUSE_FILE?.trim() || DEFAULT_PAUSE,
};
const discord = rest(config.token);

function log(msg: string): void {
  console.log(`[dum-live] ${msg}`);
}

// --- The screen ---------------------------------------------------------------------------------

const grab = ["-loglevel", "error", "-f", "x11grab"];

/** A tiny grayscale copy of the screen, without the mouse pointer, for change detection. */
async function thumb(): Promise<Uint8Array> {
  const args = [...grab, "-draw_mouse", "0", "-i", config.display, "-frames:v", "1", "-vf", `scale=${THUMB_W}:${THUMB_H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "gray", "-"];
  return (await run("ffmpeg", args, { encoding: "buffer", maxBuffer: 1 << 20, timeout: 10_000 })).stdout;
}

/** The full screen as a JPEG, pointer included, for Discord. */
async function frame(): Promise<Buffer> {
  const args = [...grab, "-i", config.display, "-frames:v", "1", "-q:v", "4", "-f", "mjpeg", "-"];
  return (await run("ffmpeg", args, { encoding: "buffer", maxBuffer: 16 << 20, timeout: 10_000 })).stdout;
}

async function windowTitle(): Promise<string> {
  try {
    const { stdout } = await run("xdotool", ["getactivewindow", "getwindowname"], { env: { ...process.env, DISPLAY: config.display }, timeout: 5_000 });
    return stdout.trim();
  } catch {
    return ""; // nothing focused
  }
}

// --- State, written atomically ------------------------------------------------------------------

type Saved = { schemaVersion: 1; channelId?: string; messageId?: string; startedAt?: number };

function load(): Saved {
  try {
    return JSON.parse(readFileSync(join(config.stateDir, "live.json"), "utf8")) as Saved;
  } catch {
    return { schemaVersion: 1 };
  }
}

function save(s: Saved): void {
  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, "live.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function dumCategory(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(config.stateDir, "channels.json"), "utf8")) as { categoryId?: string }).categoryId;
  } catch {
    return undefined;
  }
}

// --- Discord ------------------------------------------------------------------------------------

let saved = load();
let botId = "";

async function ensureChannel(): Promise<string> {
  if (saved.channelId) return saved.channelId;
  const body = {
    name: "hub-live",
    type: 0,
    topic: "Hub's screen while agents work on it. Paused with `dum live pause` before anything private.",
    permission_overwrites: overwrites(config.guildId, botId),
  };
  const parent = dumCategory();
  let channel: { id: string };
  try {
    channel = await discord("POST", `/guilds/${config.guildId}/channels`, parent ? { ...body, parent_id: parent } : body);
  } catch (err) {
    if (!parent || !(err instanceof DiscordError) || err.status !== 400) throw err;
    channel = await discord("POST", `/guilds/${config.guildId}/channels`, body); // the category is gone
  }
  saved = { schemaVersion: 1, channelId: channel.id };
  save(saved);
  log("made #hub-live");
  return channel.id;
}

function withFrame(view: View, jpeg: Buffer): FormData {
  const form = new FormData();
  form.append("files[0]", new Blob([jpeg], { type: "image/jpeg" }), FRAME_NAME);
  form.append("payload_json", JSON.stringify({ ...liveMessage(view), allowed_mentions: NO_PINGS, attachments: [{ id: 0, filename: FRAME_NAME }] }));
  return form;
}

/** Edits the current message, or posts a new one when there is none or it was deleted. */
async function show(view: View, jpeg: Buffer, postIfMissing: boolean): Promise<void> {
  if (saved.messageId && saved.channelId) {
    try {
      await discord("PATCH", `/channels/${saved.channelId}/messages/${saved.messageId}`, withFrame(view, jpeg));
      return;
    } catch (err) {
      if (!gone(err)) throw err;
      saved = err instanceof DiscordError && err.code === UNKNOWN_CHANNEL ? { schemaVersion: 1 } : { schemaVersion: 1, channelId: saved.channelId };
      save(saved);
    }
  }
  if (!postIfMissing) return;
  const channelId = await ensureChannel();
  const form = withFrame(view, jpeg);
  const payload = JSON.parse(String(form.get("payload_json")));
  form.set("payload_json", JSON.stringify({ ...payload, flags: SILENT }));
  const msg = await discord("POST", `/channels/${channelId}/messages`, form);
  saved = { ...saved, channelId, messageId: msg.id, startedAt: view.startedAt };
  save(saved);
}

/** A message left live by a crash or restart is marked ended, without its frame. */
async function closeLeftover(): Promise<void> {
  if (!saved.messageId || !saved.channelId) return;
  const view: View = { status: "restarted", title: "", startedAt: saved.startedAt ?? Date.now(), now: Date.now(), viewer: config.viewer, image: false };
  try {
    await discord("PATCH", `/channels/${saved.channelId}/messages/${saved.messageId}`, { ...liveMessage(view), attachments: [], allowed_mentions: NO_PINGS });
  } catch (err) {
    if (!gone(err)) throw err;
  }
  saved = { schemaVersion: 1, channelId: saved.channelId };
  save(saved);
}

// --- The loop -----------------------------------------------------------------------------------

let state: Live = { phase: "idle" };
let lastJpeg: Buffer | null = null;
let lastTitle = "";

async function act(action: Action, now: number, startedAt: number): Promise<void> {
  if (action === "start" || action === "frame") {
    [lastJpeg, lastTitle] = await Promise.all([frame(), windowTitle()]);
    await show({ status: "live", title: lastTitle, startedAt, now, viewer: config.viewer, image: true }, lastJpeg, true);
    if (action === "start") log("live");
    return;
  }
  // end or pause: the last frame stays, already seen, and nothing new is captured.
  // Either way the message is let go, so the next stretch never reuses it.
  try {
    if (lastJpeg) await show({ status: action === "end" ? "ended" : "paused", title: lastTitle, startedAt, now, viewer: config.viewer, image: true }, lastJpeg, false);
  } finally {
    saved = { schemaVersion: 1, ...(saved.channelId ? { channelId: saved.channelId } : {}) };
    save(saved);
    lastJpeg = null;
  }
  log(action === "end" ? "ended, screen quiet" : "paused");
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (state.phase === "live") await act("end", Date.now(), state.startedAt).catch((err) => log(`couldn't mark the message ended: ${(err as Error).message}`));
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

botId = ((await discord("GET", "/users/@me")) as { id: string }).id;
await closeLeftover();
log(`watching ${config.display}`);

let prev: Uint8Array | null = null;
let lastTrouble = "";
while (!stopping) {
  const tick = Date.now();
  try {
    const t = await thumb();
    const changed = moved(prev, t);
    prev = t;
    const now = Date.now();
    const before = state;
    const { next, action } = step(state, changed, pausedNow(readPause(config.pauseFile), now), now);
    state = next;
    const startedAt = next.phase === "live" ? next.startedAt : before.phase === "live" ? before.startedAt : now;
    if (action !== "none") await act(action, now, startedAt);
    if (lastTrouble) log("working again");
    lastTrouble = "";
  } catch (err) {
    const msg = (err as Error).message.split("\n")[0]!;
    if (msg !== lastTrouble) log(`trouble: ${msg}`);
    lastTrouble = msg;
  }
  await sleep(Math.max(0, SAMPLE_MS - (Date.now() - tick)));
}

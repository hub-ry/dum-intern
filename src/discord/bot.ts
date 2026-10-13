// Dum's Discord presence. Each goal gets its own private channel, with one status message per
// creation and one ping when it's done. Words an agent wants recorded as Ryan's wait for his
// Approve. Agents handing each other work show up in the lobby, and a "right now" board shows
// what Dum is doing. The workshop on hub stays the record; Discord points back to it.
//
//   DUM_DISCORD_TOKEN_FILE, DUM_DISCORD_APPLICATION_ID, DUM_DISCORD_GUILD_ID,
//   DUM_DISCORD_CHANNEL_ID (the lobby), DUM_DISCORD_OWNER_ID, DUM_DISCORD_STATE_DIR,
//   DUM_DISCORD_PUBLIC_HOST (link host, default the workshop host), plus the workshop's own
//   environment. Requests and handoffs use the same folders as `dum mcp`.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadClientConfig, workshopClient, WorkshopRequestError } from "../client/workshop.ts";
import { DEFAULT_REQUESTS_DIR, listRequests, readRequest, updateRequest, type DumRequest } from "../shared/requests.ts";
import { DEFAULT_HANDOFF_DIR, listHandoffs } from "../shared/handoff.ts";
import { emptyBindings, overwrites, planChannels, slug, topic, type Bindings } from "./channels.ts";
import { COMMANDS, handle, isPrivate, opensModal, type Interaction } from "./commands.ts";
import { adoptExisting, emptyLedger, nonceFor, plan, quiet, record, type Ledger, type Links, type Message, type Step } from "./delivery.ts";
import { approvalCard, adoptHandoffs, boardMessage, decidedCard, parseDecision, planNotices, type BoardGoal, type SeenHandoffs } from "./presence.ts";
import { avatarPng } from "./glyph.ts";
import { DiscordError, gateway, gone, GUILD_MESSAGES, MISSING_PERMISSIONS, rest } from "./rest.ts";
import { audit, chatCommand, prompt, sessionFor, splitReply, stripMentions, teamFooter, turnResult, type Sessions } from "./chat.ts";
import { alive, finished, launch, listTurns, queueTurn, removeTurn, saveTurn, sourceText, startable, turnDir, type Turn } from "./turns.ts";
import { DUM_BIN } from "../cli.ts";

const POLL_MS = 5_000;
/** How often the bot checks Discord for goal channels someone deleted. */
const CHANNEL_CHECK_MS = 60_000;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

const client = loadClientConfig();
const workshopUrl = new URL(client.baseUrl);
const config = {
  token: readFileSync(need("DUM_DISCORD_TOKEN_FILE"), "utf8").trim(),
  appId: need("DUM_DISCORD_APPLICATION_ID"),
  guildId: need("DUM_DISCORD_GUILD_ID"),
  lobbyId: need("DUM_DISCORD_CHANNEL_ID"),
  ownerId: need("DUM_DISCORD_OWNER_ID"),
  stateDir: need("DUM_DISCORD_STATE_DIR"),
  artifacts: `http://${workshopUrl.hostname}:${need("DUM_WORKSHOP_ARTIFACT_PORT")}`,
  requestsDir: process.env.DUM_REQUESTS_DIR?.trim() || DEFAULT_REQUESTS_DIR,
  handoffDir: process.env.DUM_HANDOFF_DIR?.trim() || DEFAULT_HANDOFF_DIR,
};
const linkHost = process.env.DUM_DISCORD_PUBLIC_HOST?.trim() || workshopUrl.hostname;
const links: Links = {
  app: `http://${linkHost}:${workshopUrl.port || "80"}`,
  artifacts: `http://${linkHost}:${need("DUM_WORKSHOP_ARTIFACT_PORT")}`,
};
const reinvite = `https://discord.com/oauth2/authorize?client_id=${config.appId}&scope=bot+applications.commands&permissions=117776`;

const workshop = workshopClient(client);
const discord = rest(config.token);

function log(msg: string): void {
  console.log(`[dum-discord] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- State: what has been delivered and which channel is whose, written atomically -----------

type Board = { schemaVersion: 1; channelId?: string; messageId?: string; hash?: string };
type Profile = { schemaVersion: 1; avatarHash?: string };

function load<T extends { schemaVersion: number }>(name: string): T | null {
  try {
    const parsed = JSON.parse(readFileSync(join(config.stateDir, name), "utf8")) as T;
    if (parsed.schemaVersion !== 1) throw new Error(`${name} has an unknown shape.`);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function save(name: string, value: unknown): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const path = join(config.stateDir, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

let ledger: Ledger = emptyLedger();
let bindings: Bindings = emptyBindings();
let board: Board = { schemaVersion: 1 };
let seenHandoffs: SeenHandoffs | null = null;

function describe(err: unknown): string {
  if (err instanceof DiscordError && err.code === MISSING_PERMISSIONS) return `missing a Discord permission (Manage Channels is needed). Re-authorize: ${reinvite}`;
  return (err as Error).message;
}

/** Logs a recurring problem once, and its recovery once. */
function trouble(area: string) {
  let last = "";
  return {
    fail(err: unknown) {
      const why = describe(err);
      if (why !== last) log(`${area} paused: ${why}`);
      last = why;
    },
    ok() {
      if (last) log(`${area} recovered`);
      last = "";
    },
  };
}

// --- Goal channels --------------------------------------------------------------------------

let botId = config.appId;
let lastChannelCheck = 0;

async function ensureCategory(): Promise<string> {
  if (bindings.categoryId) return bindings.categoryId;
  const category = await discord("POST", `/guilds/${config.guildId}/channels`, { name: "Dum goals", type: 4, permission_overwrites: overwrites(config.guildId, botId) });
  bindings = { ...bindings, categoryId: category.id };
  save("channels.json", bindings);
  log("made the goals category");
  return category.id;
}

async function openChannel(goal: { id: string; title: string }): Promise<string> {
  const existing = bindings.goals[goal.id];
  if (existing) return existing.channelId;
  const parent = await ensureCategory();
  const detail = await workshop.goal(goal.id).catch(() => null);
  const channel = await discord("POST", `/guilds/${config.guildId}/channels`, {
    name: slug(goal.title),
    type: 0,
    parent_id: parent,
    topic: topic(detail?.ambition ?? goal.title, links.app),
    permission_overwrites: overwrites(config.guildId, botId),
  });
  bindings = { ...bindings, goals: { ...bindings.goals, [goal.id]: { channelId: channel.id } } };
  save("channels.json", bindings);
  log(`made #${channel.name} for goal ${goal.id.slice(0, 8)}`);
  return channel.id;
}

/** One serialized path for channel changes, so a command and the loop never both make one. */
let channelWork: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = channelWork.then(fn, fn);
  channelWork = next.catch(() => {});
  return next;
}

async function reconcileChannels(goals: { id: string; title: string }[]): Promise<Set<string> | null> {
  let existing: Set<string> | null = null;
  if (Date.now() - lastChannelCheck >= CHANNEL_CHECK_MS) {
    const list = (await discord("GET", `/guilds/${config.guildId}/channels`)) as { id: string }[];
    existing = new Set(list.map((c) => c.id));
    lastChannelCheck = Date.now();
  }
  const todo = planChannels(goals, bindings, existing);
  const drop = new Set([...todo.forget, ...todo.orphaned]);
  if (drop.size > 0 || (todo.category && bindings.categoryId)) {
    const kept = Object.fromEntries(Object.entries(bindings.goals).filter(([goalId]) => !drop.has(goalId)));
    bindings = { ...bindings, goals: kept, ...(todo.category ? { categoryId: undefined } : {}) };
    save("channels.json", bindings);
    for (const goalId of todo.forget) log(`channel for goal ${goalId.slice(0, 8)} was deleted; making it again`);
    for (const goalId of todo.orphaned) log(`goal ${goalId.slice(0, 8)} no longer exists; its channel is unbound and left as it is`);
  }
  for (const goal of todo.create) await openChannel(goal);
  return existing;
}

const channels = {
  goalFor: (channelId: string) => Object.entries(bindings.goals).find(([, b]) => b.channelId === channelId)?.[0] ?? null,
  channelFor: (goalId: string) => bindings.goals[goalId]?.channelId ?? null,
  open: (goal: { id: string; title: string }) => serial(() => openChannel(goal)),
};

// --- Delivery -------------------------------------------------------------------------------

const NO_PINGS = { parse: [] as string[] };
const OWNER_PING = () => ({ parse: [] as string[], users: [config.ownerId] });
const SILENT = 4096;

async function post(channelId: string, step: Step): Promise<string> {
  const path = `/channels/${channelId}/messages`;
  const payload = {
    ...step.message,
    nonce: nonceFor(step),
    enforce_nonce: true,
    allowed_mentions: step.kind === "final" ? OWNER_PING() : NO_PINGS,
    ...(step.kind !== "final" ? { flags: SILENT } : {}),
  };
  if (step.kind === "final" && step.images.length > 0) {
    const form = new FormData();
    const attachments: { id: number; filename: string }[] = [];
    for (const [n, url] of step.images.entries()) {
      const res = await fetch(url.replace(links.artifacts, config.artifacts), { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!res?.ok) continue;
      const filename = `panel-${n + 1}.png`;
      form.append(`files[${attachments.length}]`, new Blob([await res.arrayBuffer()], { type: "image/png" }), filename);
      attachments.push({ id: attachments.length, filename });
    }
    // An embed whose screenshot couldn't be fetched drops the image rather than showing a hole.
    const have = new Set(attachments.map((a) => `attachment://${a.filename}`));
    const embeds = payload.embeds.map((e) => (e.image && !have.has(e.image.url) ? { ...e, image: undefined } : e)).filter((e) => e.title || e.description || e.image);
    form.append("payload_json", JSON.stringify({ ...payload, embeds, attachments }));
    return (await discord("POST", path, form)).id;
  }
  return (await discord("POST", path, payload)).id;
}

/** Runs one step; returns the id of a message it newly posted, if any. */
async function deliver(step: Step): Promise<string | undefined> {
  if (step.kind !== "editStatus") return post(step.channelId, step);
  try {
    await discord("PATCH", `/channels/${step.channelId}/messages/${step.messageId}`, { ...step.message, allowed_mentions: NO_PINGS });
    return undefined;
  } catch (err) {
    if (!gone(err)) throw err;
    // The old message or its channel was deleted: start a fresh status message where the goal lives now.
    return post(step.home, step);
  }
}

async function deliverJobs(jobs: Awaited<ReturnType<typeof workshop.jobs>>, goals: BoardGoal[]): Promise<void> {
  const route = { lobbyId: config.lobbyId, channelFor: channels.channelFor };
  for (const step of plan(jobs, goals, ledger, links, config.ownerId, route)) {
    let id: string | undefined;
    try {
      id = await deliver(step);
    } catch (err) {
      if (gone(err) && step.kind !== "editStatus") lastChannelCheck = 0; // a goal channel vanished; recheck now
      throw err;
    }
    ledger = record(ledger, step, id);
    save("ledger.json", ledger);
    log(`${step.kind} ${step.jobId.slice(0, 8)} ${step.stage}`);
  }
}

// --- Approvals ------------------------------------------------------------------------------

async function goalTitle(goalId: string): Promise<string> {
  return (await workshop.goals()).find((g) => g.id === goalId)?.title ?? "a deleted goal";
}

/** Asks Ryan about every request that hasn't been asked yet; his exact words from chat need no asking. */
async function askPending(pending: DumRequest[]): Promise<void> {
  for (const req of pending) {
    if (req.verbatim) {
      const done = await decide(req.id, true);
      if (done?.status === "approved") {
        const channelId = channels.channelFor(req.goalId) ?? config.lobbyId;
        const what = req.kind === "teach" ? `Taught **${quiet(req.concept)}**` : `Tried **${quiet(req.concept)}** (${req.helped ? "with help" : "no help"}, your report)`;
        await discord("POST", `/channels/${channelId}/messages`, { content: `${what}, in your words:\n${req.text.trim().slice(0, 1700).split("\n").map((l) => `> ${quiet(l)}`).join("\n")}`, allowed_mentions: NO_PINGS, flags: SILENT });
      }
      continue;
    }
    if (req.messageId) continue;
    const channelId = channels.channelFor(req.goalId) ?? config.lobbyId;
    const card = approvalCard(req, await goalTitle(req.goalId), config.ownerId);
    const msg = await discord("POST", `/channels/${channelId}/messages`, { ...card, nonce: `q${req.id.replace(/-/g, "").slice(0, 22)}`, enforce_nonce: true, allowed_mentions: OWNER_PING() });
    updateRequest(config.requestsDir, req.id, { channelId, messageId: msg.id });
    log(`asked about ${req.kind} ${req.id.slice(0, 8)} from ${req.requestedBy}`);
  }
}

/** Decisions in progress, so a double click can't record the same words twice. */
const deciding = new Map<string, Promise<DumRequest | null>>();

/** Ryan pressed Approve or Decline. Only an approval writes to the workshop, and only once. */
function decide(id: string, approve: boolean): Promise<DumRequest | null> {
  const running = deciding.get(id);
  if (running) return running;
  const work = decideOnce(id, approve).finally(() => deciding.delete(id));
  deciding.set(id, work);
  return work;
}

async function decideOnce(id: string, approve: boolean): Promise<DumRequest | null> {
  const req = readRequest(config.requestsDir, id);
  if (!req) return null;
  if (req.status !== "pending") return req;
  const decidedAt = new Date().toISOString();
  if (!approve) return updateRequest(config.requestsDir, id, { status: "declined", decidedAt });
  try {
    if (req.kind === "teach") await workshop.teach(req.goalId, req.concept, req.text);
    else await workshop.tried(req.goalId, req.concept, req.text, req.helped === true);
    log(`approved ${req.kind} ${id.slice(0, 8)}`);
    return updateRequest(config.requestsDir, id, { status: "approved", decidedAt, outcome: "Recorded." });
  } catch (err) {
    const outcome = err instanceof WorkshopRequestError ? err.shown : "the workshop didn't answer";
    log(`approved ${req.kind} ${id.slice(0, 8)} but recording failed: ${(err as Error).message}`);
    return updateRequest(config.requestsDir, id, { status: "failed", decidedAt, outcome });
  }
}

// --- Handoff notices ------------------------------------------------------------------------

async function noticeHandoffs(list: ReturnType<typeof listHandoffs>): Promise<void> {
  if (!seenHandoffs) {
    seenHandoffs = load<SeenHandoffs>("handoffs.json") ?? adoptHandoffs(list);
    save("handoffs.json", seenHandoffs);
  }
  const { notices, next } = planNotices(list, seenHandoffs, config.ownerId);
  for (const n of notices) {
    await discord("POST", `/channels/${config.lobbyId}/messages`, { ...n.message, allowed_mentions: n.ping ? OWNER_PING() : NO_PINGS, ...(n.ping ? {} : { flags: SILENT }) });
    seenHandoffs = { schemaVersion: 1, handoffs: { ...seenHandoffs.handoffs, [n.id]: next.handoffs[n.id]! } };
    save("handoffs.json", seenHandoffs);
    log(`handoff notice ${n.id}`);
  }
}

// --- The "right now" board ------------------------------------------------------------------

async function ensureBoard(existing: Set<string> | null): Promise<string> {
  if (board.channelId && existing && !existing.has(board.channelId)) board = { schemaVersion: 1 };
  if (board.channelId) return board.channelId;
  const parent = await ensureCategory();
  const channel = await discord("POST", `/guilds/${config.guildId}/channels`, {
    name: "dum-now",
    type: 0,
    parent_id: parent,
    position: 0,
    topic: "What Dum is doing right now. Kept current by the bot.",
    permission_overwrites: overwrites(config.guildId, botId),
  });
  board = { schemaVersion: 1, channelId: channel.id };
  save("board.json", board);
  log("made #dum-now");
  return channel.id;
}

async function updateBoard(message: Message, existing: Set<string> | null): Promise<void> {
  const hash = createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 16);
  if (hash === board.hash && !(existing && board.channelId && !existing.has(board.channelId))) return;
  const channelId = await ensureBoard(existing);
  const stamped = { ...message, embeds: message.embeds.map((e) => ({ ...e, timestamp: new Date().toISOString() })), allowed_mentions: NO_PINGS };
  if (board.messageId) {
    try {
      await discord("PATCH", `/channels/${channelId}/messages/${board.messageId}`, stamped);
      board = { ...board, hash };
      save("board.json", board);
      return;
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }
  const msg = await discord("POST", `/channels/${channelId}/messages`, { ...stamped, flags: SILENT });
  board = { ...board, messageId: msg.id, hash };
  save("board.json", board);
}

// --- The loop -------------------------------------------------------------------------------

const troubles = { channels: trouble("goal channels"), delivery: trouble("delivery"), approvals: trouble("approvals"), handoffs: trouble("handoff notices"), board: trouble("board") };

/** Each part fails on its own: a missing permission or a bad handoff file never stops delivery. */
async function sync(): Promise<void> {
  const [jobs, goals] = await Promise.all([workshop.jobs(), workshop.goals() as Promise<BoardGoal[]>]);
  let existing: Set<string> | null = null;
  const part = async (t: { ok(): void; fail(e: unknown): void }, fn: () => Promise<void>) => {
    try {
      await fn();
      t.ok();
    } catch (err) {
      t.fail(err);
    }
  };
  await part(troubles.channels, async () => {
    existing = await serial(() => reconcileChannels(goals));
  });
  await part(troubles.delivery, () => deliverJobs(jobs, goals));
  const pending = listRequests(config.requestsDir).filter((r) => r.status === "pending");
  await part(troubles.approvals, () => askPending(pending));
  const handoffs = listHandoffs(config.handoffDir);
  await part(troubles.handoffs, () => noticeHandoffs(handoffs));
  await part(troubles.board, () => updateBoard(boardMessage({ goals, jobs, pending, handoffs, links, channelFor: channels.channelFor }), existing));
}

async function loop(): Promise<never> {
  const workshopTrouble = trouble("workshop");
  for (;;) {
    try {
      await sync();
      workshopTrouble.ok();
    } catch (err) {
      workshopTrouble.fail(err);
    }
    await sleep(POLL_MS);
  }
}

// --- Interactions ---------------------------------------------------------------------------

async function answer(i: Interaction & { id: string; token: string; data?: { custom_id?: string } }): Promise<void> {
  const callback = `/interactions/${i.id}/${i.token}/callback`;
  const original = `/webhooks/${config.appId}/${i.token}/messages/@original`;
  const caller = i.member?.user?.id ?? i.user?.id;

  // A button on an approval card: only the owner, only in this server.
  if (i.type === 3) {
    const decision = parseDecision(i.data?.custom_id ?? "");
    if (!decision || caller !== config.ownerId || i.guild_id !== config.guildId) {
      await discord("POST", callback, { type: 4, data: { content: "Only Ryan can answer this.", flags: 64 } }).catch(() => {});
      return;
    }
    try {
      await discord("POST", callback, { type: 6 }); // acknowledge; the card is edited below
      const req = await decide(decision.id, decision.approve);
      if (!req) return;
      const card = decidedCard(req, await goalTitle(req.goalId));
      await discord("PATCH", original, { ...card, allowed_mentions: NO_PINGS });
    } catch (err) {
      log(`approval failed: ${describe(err)}`);
    }
    return;
  }

  const ctx = { ownerId: config.ownerId, guildId: config.guildId, lobbyId: config.lobbyId, links, workshop, channels };
  // In a thread, commands act for the channel the thread belongs to.
  if (i.channel_id && i.type !== 3 && !isDumChannel(i.channel_id)) {
    const c = await infoOf(i.channel_id).catch(() => null);
    if (isThread(c) && c!.parent_id && isDumChannel(c!.parent_id)) i = { ...i, channel_id: c!.parent_id };
  }
  // Autocomplete and form-opening commands answer at once; everything else may take a moment,
  // so it is deferred to stay inside Discord's 3 second window.
  const immediate = i.type === 4 || opensModal(i);
  let deferred = false;
  try {
    if (!immediate) {
      await discord("POST", callback, { type: 5, data: isPrivate(i) ? { flags: 64 } : {} });
      deferred = true;
    }
    const reply = await handle(i, ctx);
    if (!reply) return;
    if (!deferred) await discord("POST", callback, reply);
    else if (reply.type === 4) await discord("PATCH", original, { content: reply.data.content, embeds: reply.data.embeds ?? [], allowed_mentions: NO_PINGS });
  } catch (err) {
    log(`interaction failed: ${describe(err)}`);
    const shown = err instanceof WorkshopRequestError ? err.shown : "That didn't work. The reason is in the hub log.";
    if (deferred) await discord("PATCH", original, { content: shown, allowed_mentions: NO_PINGS }).catch(() => {});
    else if (i.type !== 4) await discord("POST", callback, { type: 4, data: { content: shown, flags: 64, allowed_mentions: NO_PINGS } }).catch(() => {});
  }
}

// --- Talking to Dum: answers in the channel, many at once --------------------------------------

const CHAT_STATE = join(process.env.HOME ?? "", ".local", "state", "dum", "chat");
const TURNS = join(process.env.HOME ?? "", ".local", "state", "dum", "turns");
/** Dum works in its own repository, so it can change itself. */
const DUM_REPO = join(import.meta.dirname, "..", "..");
/** Unset uses Ryan's default model for Claude Code. */
const CHAT_MODEL = process.env.DUM_CHAT_MODEL?.trim() || null;
/** Requests Dum works on at the same time. Each answers its own message. */
const MAX_PARALLEL = Number(process.env.DUM_CHAT_PARALLEL ?? "4") || 4;
const LONG_NOTE_MS = 60_000;
const STUCK_MS = 32 * 60_000;
let sessions: Sessions = { schemaVersion: 1, channels: {} };

type DiscordMessage = { id: string; channel_id: string; guild_id?: string; content: string; author: { id: string; bot?: boolean; global_name?: string; username: string }; mentions?: { id: string }[] };
type ChannelInfo = { type: number; parent_id?: string | null };

const channelInfo = new Map<string, ChannelInfo>();
async function infoOf(id: string): Promise<ChannelInfo | null> {
  if (channelInfo.has(id)) return channelInfo.get(id)!;
  const c = (await discord("GET", `/channels/${id}`).catch(() => null)) as ChannelInfo | null;
  if (c) channelInfo.set(id, { type: c.type, parent_id: c.parent_id ?? null });
  return c;
}

const isThread = (c: ChannelInfo | null) => !!c && (c.type === 11 || c.type === 12);
const isDumChannel = (id: string) => id === config.lobbyId || channels.goalFor(id) !== null;

/** Where a message belongs: an existing thread under one of Dum's channels, or one of the channels. */
async function placeOf(channelId: string): Promise<{ thread: boolean; home: string } | null> {
  if (isDumChannel(channelId)) return { thread: false, home: channelId };
  const c = await infoOf(channelId);
  if (isThread(c) && c!.parent_id && isDumChannel(c!.parent_id)) return { thread: true, home: c!.parent_id };
  return null;
}

async function onMessage(m: DiscordMessage): Promise<void> {
  if (m.author.bot || m.guild_id !== config.guildId) return;
  if (!m.mentions?.some((u) => u.id === botId)) return;
  const place = await placeOf(m.channel_id);
  if (!place) return;
  if (m.author.id !== config.ownerId) {
    await discord("POST", `/channels/${m.channel_id}/messages`, { content: "I only take requests from Ryan.", message_reference: { message_id: m.id }, allowed_mentions: NO_PINGS }).catch(() => {});
    return;
  }
  const text = stripMentions(m.content, botId);
  if (!text) {
    await discord("POST", `/channels/${m.channel_id}/messages`, { content: "hi! I'm here. ask me anything, or teach me something.", message_reference: { message_id: m.id }, allowed_mentions: NO_PINGS }).catch(() => {});
    return;
  }
  // Every request runs on its own right away and answers its message in the channel.
  queueTurn(TURNS, { conversation: m.channel_id, messageId: m.id, replyInline: true, goalId: channels.goalFor(place.home), author: m.author.global_name || m.author.username, text });
  await pump();
}

/** Starts every turn that may run now. */
let pumping: Promise<void> = Promise.resolve();
function pump(): Promise<void> {
  pumping = pumping.then(async () => {
    for (const t of startable(listTurns(TURNS), MAX_PARALLEL)) await start(t).catch((err) => log(`turn ${t.id.slice(0, 8)} didn't start: ${describe(err)}`));
  });
  return pumping;
}

async function start(t: Turn): Promise<void> {
  const resume = t.retried ? null : sessionFor(sessions, t.conversation, new Date());
  const place = t.goalId ? { kind: "goal" as const, goalId: t.goalId, title: await goalTitle(t.goalId) } : { kind: "lobby" as const };
  const command = chatCommand({
    claude: process.env.DUM_CLAUDE_EXECUTABLE?.trim() || "/usr/local/bin/claude",
    dumBin: DUM_BIN,
    repo: DUM_REPO,
    turnDir: turnDir(TURNS, t.id),
    message: prompt({ message: sourceText(TURNS, t.id), author: t.author, place }),
    resume,
    model: CHAT_MODEL,
  });
  saveTurn(TURNS, { ...t, status: "running", startedAt: new Date().toISOString(), resume });
  await launch(TURNS, t, command);
  log(`turn ${t.id.slice(0, 8)} started in ${t.conversation}`);
  void discord("POST", `/channels/${t.conversation}/typing`).catch(() => {});
}

const lastTyping = new Map<string, number>();
const noted = new Set<string>();

/** Watches running turns: keeps Discord's typing dots up, and delivers each answer when it lands. */
async function watchTurns(): Promise<void> {
  for (const t of listTurns(TURNS).filter((x) => x.status === "running")) {
    let done = finished(TURNS, t.id);
    const age = Date.now() - Date.parse(t.startedAt ?? t.createdAt);
    if (!done && age > STUCK_MS && !(await alive(t.id))) done = finished(TURNS, t.id) ?? { code: 1, stdout: "", stderr: "the turn's unit ended without a word" };
    if (!done) {
      if (Date.now() - (lastTyping.get(t.conversation) ?? 0) > 8000) {
        lastTyping.set(t.conversation, Date.now());
        void discord("POST", `/channels/${t.conversation}/typing`).catch(() => {});
      }
      if (age > LONG_NOTE_MS && !noted.has(t.id)) {
        noted.add(t.id);
        void discord("POST", `/channels/${t.conversation}/messages`, { content: "on it. this one takes a bit, I'll report back here.", allowed_mentions: NO_PINGS, flags: SILENT }).catch(() => {});
      }
      continue;
    }
    await complete(t, done);
  }
  await pump();
}

async function complete(t: Turn, done: { code: number; stdout: string; stderr: string }): Promise<void> {
  const result = turnResult(done);
  // A conversation that can't be resumed shouldn't cost Ryan an answer: run it again, fresh.
  if (result.failed && t.resume && !t.retried) {
    log(`turn ${t.id.slice(0, 8)} couldn't resume its conversation; retrying fresh`);
    saveTurn(TURNS, { ...t, status: "queued", retried: true, resume: null });
    return;
  }
  if (result.failed) log(`turn ${t.id.slice(0, 8)} failed (exit ${done.code}): ${done.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  if (result.sessionId) {
    sessions = { schemaVersion: 1, channels: { ...sessions.channels, [t.conversation]: { sessionId: result.sessionId, lastAt: new Date().toISOString() } } };
    save("chat.json", sessions);
  }
  const started = Date.parse(t.startedAt ?? t.createdAt);
  audit(CHAT_STATE, { at: new Date().toISOString(), channel: t.conversation, failed: result.failed, agents: result.agents, tools: result.tools, ms: Date.now() - started });
  log(`turn ${t.id.slice(0, 8)} ${result.failed ? "failed" : "answered"}${result.agents.length ? ` (asked ${result.agents.join(", ")})` : ""}`);
  const parts = result.failed ? ["sorry, my brain hiccuped. the reason is in the hub log. try again?"] : splitReply(result.text + teamFooter(result.agents));
  try {
    for (const [n, part] of parts.entries()) {
      await discord("POST", `/channels/${t.conversation}/messages`, {
        content: part,
        ...(n === 0 && t.replyInline ? { message_reference: { message_id: t.messageId, fail_if_not_exists: false } } : {}),
        allowed_mentions: NO_PINGS,
      });
    }
  } catch (err) {
    log(`turn ${t.id.slice(0, 8)} answer couldn't be posted: ${describe(err)}`);
  }
  noted.delete(t.id);
  removeTurn(TURNS, t.id);
}

async function chatLoop(): Promise<never> {
  const t = trouble("chat");
  for (;;) {
    try {
      await watchTurns();
      t.ok();
    } catch (err) {
      t.fail(err);
    }
    await sleep(2000);
  }
}

// --- Start ----------------------------------------------------------------------------------

async function ensureAvatar(): Promise<void> {
  const png = avatarPng();
  const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
  const profile = load<Profile>("profile.json") ?? { schemaVersion: 1 };
  if (profile.avatarHash === hash) return;
  await discord("PATCH", "/users/@me", { avatar: `data:image/png;base64,${png.toString("base64")}` });
  save("profile.json", { schemaVersion: 1, avatarHash: hash });
  log("set the bot's avatar to Dum's glyph");
}

async function main(): Promise<void> {
  bindings = load<Bindings>("channels.json") ?? emptyBindings();
  board = load<Board>("board.json") ?? { schemaVersion: 1 };
  sessions = load<Sessions>("chat.json") ?? sessions;
  const saved = load<Ledger>("ledger.json");
  if (saved) ledger = saved;
  else {
    // First start: adopt existing jobs so their history is not replayed into the channel.
    ledger = adoptExisting(emptyLedger(), await workshop.jobs());
    save("ledger.json", ledger);
    log(`adopted ${Object.keys(ledger.jobs).length} existing jobs`);
  }
  botId = (await discord("GET", "/users/@me")).id;
  await ensureAvatar().catch((err) => log(`avatar not set: ${describe(err)}`));
  await discord("PUT", `/applications/${config.appId}/guilds/${config.guildId}/commands`, COMMANDS);
  log("commands registered");
  const onEvent = (type: string, data: any) => {
    if (type === "INTERACTION_CREATE") void answer(data);
    else if (type === "MESSAGE_CREATE") void onMessage(data).catch((err) => log(`message failed: ${describe(err)}`));
  };
  await Promise.all([loop(), chatLoop(), gateway(config.token, discord, GUILD_MESSAGES, onEvent, log)]);
}

main().catch((err) => {
  console.error(`[dum-discord] fatal: ${describe(err)}`);
  process.exit(1);
});

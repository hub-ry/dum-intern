// Dum's Discord delivery service. Watches the workshop's jobs and keeps one status message per
// creation in a single private channel, pings the owner on completion or failure, and answers the
// /dum slash commands. The workshop on hub stays the record; Discord only points back to it.
//
//   DUM_DISCORD_TOKEN_FILE, DUM_DISCORD_APPLICATION_ID, DUM_DISCORD_GUILD_ID,
//   DUM_DISCORD_CHANNEL_ID, DUM_DISCORD_OWNER_ID, DUM_DISCORD_STATE_DIR,
//   DUM_DISCORD_PUBLIC_HOST (link host, default the workshop host),
//   DUM_WORKSHOP_HOST, DUM_WORKSHOP_PORT, DUM_WORKSHOP_ARTIFACT_PORT, DUM_WORKSHOP_TOKEN

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, handle, type Interaction, type Workshop } from "./commands.ts";
import { adoptExisting, emptyLedger, nonceFor, plan, record, type GoalView, type JobView, type Ledger, type Links, type Step } from "./delivery.ts";

const API = "https://discord.com/api/v10";
const POLL_MS = 5_000;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

const config = {
  token: readFileSync(need("DUM_DISCORD_TOKEN_FILE"), "utf8").trim(),
  appId: need("DUM_DISCORD_APPLICATION_ID"),
  guildId: need("DUM_DISCORD_GUILD_ID"),
  channelId: need("DUM_DISCORD_CHANNEL_ID"),
  ownerId: need("DUM_DISCORD_OWNER_ID"),
  stateDir: need("DUM_DISCORD_STATE_DIR"),
  workshop: `http://${need("DUM_WORKSHOP_HOST")}:${need("DUM_WORKSHOP_PORT")}`,
  artifacts: `http://${need("DUM_WORKSHOP_HOST")}:${need("DUM_WORKSHOP_ARTIFACT_PORT")}`,
  workshopToken: need("DUM_WORKSHOP_TOKEN"),
};
const linkHost = process.env.DUM_DISCORD_PUBLIC_HOST?.trim() || need("DUM_WORKSHOP_HOST");
const links: Links = {
  app: `http://${linkHost}:${need("DUM_WORKSHOP_PORT")}`,
  artifacts: `http://${linkHost}:${need("DUM_WORKSHOP_ARTIFACT_PORT")}`,
};

function log(msg: string): void {
  console.log(`[dum-discord] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Ledger: what has been delivered, written atomically after each accepted step ----------

const ledgerPath = join(config.stateDir, "ledger.json");

function loadLedger(): Ledger | null {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
    if (parsed.schemaVersion !== 1 || typeof parsed.jobs !== "object") throw new Error("ledger.json has an unknown shape.");
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function saveLedger(ledger: Ledger): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${ledgerPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 1), { mode: 0o600 });
  renameSync(tmp, ledgerPath);
}

// --- Workshop over its own API --------------------------------------------------------------

async function ws<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(config.workshop + path, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${config.workshopToken}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`workshop ${path}: ${res.status} ${json.error ?? ""}`.trim());
  return json;
}

const workshop: Workshop = {
  goals: async () => (await ws<{ goals: GoalView[] }>("/api/goals")).goals,
  jobs: async () => (await ws<{ jobs: JobView[] }>("/api/jobs")).jobs,
  build: async (goalId) => (await ws<{ job: JobView }>(`/api/goals/${goalId}/jobs`, { method: "POST", body: {} })).job,
  correct: async (jobId, correction) => (await ws<{ job: JobView }>(`/api/jobs/${jobId}/correction`, { method: "POST", body: { correction } })).job,
};

// --- Discord REST, honoring rate limits -----------------------------------------------------

async function discord(method: string, path: string, body?: unknown | FormData): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const form = body instanceof FormData;
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bot ${config.token}`, ...(body && !form ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      const wait = Number((await res.json().catch(() => ({})) as { retry_after?: number }).retry_after ?? 1);
      await sleep(Math.ceil(wait * 1000) + 100);
      continue;
    }
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`discord ${method} ${path}: ${res.status} ${JSON.stringify(json)?.slice(0, 300)}`);
    return json;
  }
  throw new Error(`discord ${method} ${path}: still rate limited`);
}

const NO_PINGS = { parse: [] as string[] };
const OWNER_PING = () => ({ parse: [] as string[], users: [config.ownerId] });

async function deliver(step: Step): Promise<string | undefined> {
  const path = `/channels/${config.channelId}/messages`;
  if (step.kind === "editStatus") {
    await discord("PATCH", `${path}/${step.messageId}`, { content: step.content, allowed_mentions: NO_PINGS });
    return step.messageId;
  }
  const payload = {
    content: step.content,
    nonce: nonceFor(step),
    enforce_nonce: true,
    allowed_mentions: step.kind === "final" ? OWNER_PING() : NO_PINGS,
    ...(step.kind === "postStatus" ? { flags: 4096 } : {}), // silent: routine status never notifies
  };
  if (step.kind === "final" && step.images.length > 0) {
    const form = new FormData();
    const attachments: { id: number; filename: string }[] = [];
    for (const [n, url] of step.images.entries()) {
      const res = await fetch(url.replace(links.artifacts, config.artifacts), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const filename = `panel-${n + 1}.png`;
      form.append(`files[${attachments.length}]`, new Blob([await res.arrayBuffer()], { type: "image/png" }), filename);
      attachments.push({ id: attachments.length, filename });
    }
    form.append("payload_json", JSON.stringify({ ...payload, attachments }));
    return (await discord("POST", path, form)).id;
  }
  return (await discord("POST", path, payload)).id;
}

// --- Delivery loop --------------------------------------------------------------------------

let ledger: Ledger = emptyLedger();

async function sync(): Promise<void> {
  const [jobs, goals] = await Promise.all([workshop.jobs(), workshop.goals()]);
  for (const step of plan(jobs, goals, ledger, links, config.ownerId)) {
    const id = await deliver(step);
    ledger = record(ledger, step, id);
    saveLedger(ledger);
    log(`${step.kind} ${step.jobId.slice(0, 8)}${"stage" in step ? ` ${step.stage}` : ""}`);
  }
}

async function deliveryLoop(): Promise<never> {
  let failing = false;
  for (;;) {
    try {
      await sync();
      if (failing) log("delivery recovered");
      failing = false;
    } catch (err) {
      if (!failing) log(`delivery paused: ${(err as Error).message}`);
      failing = true;
    }
    await sleep(POLL_MS);
  }
}

// --- Gateway: only for interactions, so no privileged intents -------------------------------

type Session = { id: string; resumeUrl: string; seq: number | null };

async function gateway(): Promise<never> {
  const state = { session: null as Session | null };
  let backoff = 1_000;
  for (;;) {
    const url: string = state.session?.resumeUrl ?? (await discord("GET", "/gateway/bot")).url;
    const closed = await new Promise<{ code: number; resumable: boolean }>((resolve) => {
      const sock = new WebSocket(`${url}/?v=10&encoding=json`);
      let beat: ReturnType<typeof setInterval> | undefined;
      let acked = true;
      let seq = state.session?.seq ?? null;
      const send = (op: number, d: unknown) => sock.send(JSON.stringify({ op, d }));
      const finish = (code: number, resumable: boolean) => {
        clearInterval(beat);
        try { sock.close(4000); } catch {}
        resolve({ code, resumable });
      };
      sock.onmessage = async (ev) => {
        const msg = JSON.parse(String(ev.data)) as { op: number; d: any; s: number | null; t: string | null };
        if (msg.s !== null) { seq = msg.s; if (state.session) state.session.seq = seq; }
        if (msg.op === 10) {
          beat = setInterval(() => {
            if (!acked) return finish(4009, true); // zombie connection
            acked = false;
            send(1, seq);
          }, msg.d.heartbeat_interval);
          if (state.session) send(6, { token: config.token, session_id: state.session.id, seq: state.session.seq });
          else send(2, { token: config.token, intents: 0, properties: { os: "linux", browser: "dum", device: "dum" } });
        } else if (msg.op === 11) acked = true;
        else if (msg.op === 1) send(1, seq);
        else if (msg.op === 7) finish(4000, true);
        else if (msg.op === 9) finish(4000, msg.d === true);
        else if (msg.op === 0 && msg.t === "READY") {
          state.session = { id: msg.d.session_id, resumeUrl: msg.d.resume_gateway_url, seq };
          backoff = 1_000;
          log("gateway ready");
        } else if (msg.op === 0 && msg.t === "RESUMED") {
          backoff = 1_000;
          log("gateway resumed");
        } else if (msg.op === 0 && msg.t === "INTERACTION_CREATE") {
          void answer(msg.d);
        }
      };
      sock.onclose = (ev) => finish(ev.code, ![4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code));
      sock.onerror = () => {};
    });
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(closed.code)) throw new Error(`gateway closed for good: ${closed.code}`);
    if (!closed.resumable) state.session = null;
    await sleep(backoff + Math.random() * 1000);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

async function answer(i: Interaction & { id: string; token: string }): Promise<void> {
  const path = `/interactions/${i.id}/${i.token}/callback`;
  try {
    // Building or correcting can take a moment; defer so Discord's 3s window never expires.
    if (i.type === 2) await discord("POST", path, { type: 5, data: { flags: 64 } });
    const reply = await handle(i, { ownerId: config.ownerId, guildId: config.guildId, channelId: config.channelId, links, workshop });
    if (!reply) return;
    if (reply.type === 8) await discord("POST", path, reply);
    else await discord("PATCH", `/webhooks/${config.appId}/${i.token}/messages/@original`, { content: reply.data.content, allowed_mentions: NO_PINGS });
  } catch (err) {
    log(`interaction failed: ${(err as Error).message}`);
    if (i.type === 2) {
      await discord("PATCH", `/webhooks/${config.appId}/${i.token}/messages/@original`, {
        content: "That didn't work. The reason is in the hub log.",
        allowed_mentions: NO_PINGS,
      }).catch(() => {});
    }
  }
}

// --- Start ----------------------------------------------------------------------------------

async function main(): Promise<void> {
  const saved = loadLedger();
  if (saved) ledger = saved;
  else {
    // First start: adopt existing jobs so their history is not replayed into the channel.
    ledger = adoptExisting(emptyLedger(), await workshop.jobs());
    saveLedger(ledger);
    log(`adopted ${Object.keys(ledger.jobs).length} existing jobs`);
  }
  await discord("PUT", `/applications/${config.appId}/guilds/${config.guildId}/commands`, COMMANDS);
  log("commands registered");
  await Promise.all([deliveryLoop(), gateway()]);
}

main().catch((err) => {
  console.error(`[dum-discord] fatal: ${(err as Error).message}`);
  process.exit(1);
});

// Discord's REST API with rate limits honored, and its gateway. No privileged intents: the only
// message text the bot ever sees is in messages that mention it.

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(readonly status: number, readonly code: number | undefined, message: string) {
    super(message);
    this.name = "DiscordError";
  }
}

export const UNKNOWN_CHANNEL = 10003;
export const UNKNOWN_MESSAGE = 10008;
export const MISSING_PERMISSIONS = 50013;

export const gone = (err: unknown) => err instanceof DiscordError && (err.code === UNKNOWN_CHANNEL || err.code === UNKNOWN_MESSAGE);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Rest = (method: string, path: string, body?: unknown) => Promise<any>;

export function rest(token: string): Rest {
  return async function discord(method, path, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const form = body instanceof FormData;
      const res = await fetch(API + path, {
        method,
        headers: { authorization: `Bot ${token}`, ...(body !== undefined && !form ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
        await sleep(Math.ceil(wait * 1000) + 100);
        continue;
      }
      if (res.status === 204) return null;
      const json = (await res.json().catch(() => null)) as { code?: number } | null;
      if (!res.ok) throw new DiscordError(res.status, json?.code, `discord ${method} ${path}: ${res.status} ${JSON.stringify(json)?.slice(0, 300)}`);
      return json;
    }
    throw new Error(`discord ${method} ${path}: still rate limited`);
  };
}

type Session = { id: string; resumeUrl: string; seq: number | null };
const FATAL_CLOSE = [4004, 4010, 4011, 4012, 4013, 4014];

/** Gateway intent for messages in servers. Content arrives only for messages that mention the bot. */
export const GUILD_MESSAGES = 1 << 9;

/** Keeps a gateway session alive forever, resuming when it can, and hands over dispatched events. */
export async function gateway(token: string, discord: Rest, intents: number, onEvent: (type: string, data: any) => void, log: (msg: string) => void): Promise<never> {
  const state = { session: null as Session | null };
  let backoff = 1_000;
  for (;;) {
    const url: string = state.session?.resumeUrl ?? (await discord("GET", "/gateway/bot")).url;
    const closed = await new Promise<{ code: number; resumable: boolean }>((resolve) => {
      const sock = new WebSocket(`${url}/?v=10&encoding=json`);
      let beat: ReturnType<typeof setInterval> | undefined;
      let acked = true;
      let seq = state.session?.seq ?? null;
      let done = false;
      const send = (op: number, d: unknown) => sock.send(JSON.stringify({ op, d }));
      const finish = (code: number, resumable: boolean) => {
        if (done) return;
        done = true;
        clearInterval(beat);
        try {
          sock.close(4000);
        } catch {}
        resolve({ code, resumable });
      };
      sock.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { op: number; d: any; s: number | null; t: string | null };
        if (msg.s !== null) {
          seq = msg.s;
          if (state.session) state.session.seq = seq;
        }
        if (msg.op === 10) {
          beat = setInterval(() => {
            if (!acked) return finish(4009, true); // zombie connection
            acked = false;
            send(1, seq);
          }, msg.d.heartbeat_interval);
          if (state.session) send(6, { token, session_id: state.session.id, seq: state.session.seq });
          else send(2, { token, intents, properties: { os: "linux", browser: "dum", device: "dum" } });
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
        } else if (msg.op === 0 && msg.t) onEvent(msg.t, msg.d);
      };
      sock.onclose = (ev) => finish(ev.code, !FATAL_CLOSE.includes(ev.code));
      sock.onerror = () => {};
    });
    if (FATAL_CLOSE.includes(closed.code)) throw new Error(`gateway closed for good: ${closed.code}`);
    if (!closed.resumable) state.session = null;
    await sleep(backoff + Math.random() * 1000);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

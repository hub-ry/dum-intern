// One long-lived model session: send a message, get one reply back.

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { debug } from "./debug.ts";

export type Reply = {
  /** What the model said last. "" when it said nothing. */
  text: string;
  /** Whether it called a tool on the way there - a search, for the voices that have one. */
  searched: boolean;
};

/** A one-slot mailbox, so a turn can be handed over before anyone is waiting. */
class Chan<T> {
  private buf: T[] = [];
  private waiting: ((v: T) => void) | null = null;
  push(v: T) {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w(v);
    } else this.buf.push(v);
  }
  take(): Promise<T> {
    const v = this.buf.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((r) => (this.waiting = r));
  }
}

/** The text of one assistant message, or "" if it was only tool calls. */
export function lastText(msg: any): string {
  let text = "";
  for (const b of msg?.message?.content ?? []) if (b?.type === "text") text += b.text;
  return text.trim();
}

/** The model and effort a live session is actually using, or null if the SDK can't say. */
export async function applied(session: unknown): Promise<{ model: string; effort: string } | null> {
  try {
    const s = await (session as { getSettings?: () => Promise<any> }).getSettings?.();
    const a = s?.applied;
    if (!a) return null;
    return { model: typeof a.model === "string" ? a.model : "", effort: typeof a.effort === "string" ? a.effort : "" };
  } catch {
    return null;
  }
}

export class Channel {
  private turns = new Chan<string>();
  private replies = new Chan<Reply | null>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private label: string;
  private options: Options;
  /** Called with the model and effort the session actually runs at, once it starts. */
  onModel: ((model: string, effort: string) => void) | null = null;

  // Written out rather than as parameter properties: Node strips types, it does not compile
  // them, and `constructor(private x: T)` needs compiling.
  constructor(label: string, options: Options) {
    this.label = label;
    this.options = options;
  }

  get alive(): boolean {
    return !this.closed;
  }

  /** Spawns the session. Call it early, so the process start overlaps other work. */
  start() {
    const self = this;
    async function* stream(): AsyncGenerator<any> {
      for (;;) {
        const next = await self.turns.take();
        if (!next) return;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: next },
          parent_tool_use_id: null,
        };
      }
    }

    (async () => {
      let out = "";
      let searched = false;
      try {
        const session = query({ prompt: stream(), options: this.options });
        for await (const msg of session as AsyncIterable<any>) {
          if (msg.type === "system" && msg.subtype === "init" && typeof msg.model === "string") {
            this.onModel?.(msg.model, "");
            void applied(session).then((a) => a && this.onModel?.(a.model || msg.model, a.effort));
            continue;
          }
          if (msg.type === "assistant") {
            // Only the last message counts: text before a tool call isn't the answer.
            const text = lastText(msg);
            if (text) out = text;
            if (msg.message?.content?.some((b: any) => b?.type === "tool_use")) searched = true;
            continue;
          }
          if (msg.type === "result") {
            this.replies.push({ text: out.trim(), searched });
            out = "";
            searched = false;
          }
        }
      } catch (err) {
        debug(`${this.label} died:`, (err as Error)?.message ?? err);
      } finally {
        // Whoever is waiting gets nothing, rather than waiting forever.
        this.closed = true;
        this.replies.push(null);
      }
    })();
  }

  /** Null when the session is gone. */
  send(body: string): Promise<Reply | null> {
    if (this.closed) return Promise.resolve(null);
    const run = this.tail.then(() => {
      if (this.closed) return null;
      this.turns.push(body);
      return this.replies.take();
    });
    // Keep the chain alive even if one request blows up.
    this.tail = run.catch(() => null);
    return run;
  }

  close() {
    this.closed = true;
    this.turns.push(""); // ends the generator, which ends the query
  }
}

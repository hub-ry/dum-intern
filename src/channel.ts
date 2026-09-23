// One long-lived model session: send a message, get one reply back.
//
// The wizard, the reference, and the checker are all this shape. Each keeps a
// session open for the life of the run rather than starting one per message -
// measured before the wizard was written, a fresh `query` per exchange cost
// 13-50 seconds, almost none of it generation. It is the CLI process starting
// up, and at that latency a margin note lands two exchanges after the thing it
// is about.
//
// Replies come back in order, one at a time. A message sent while another is in
// flight waits its turn. Whether waiting is right (a `?` question you are
// sitting there for) or wrong (a margin note that would be stale by the time it
// printed) is the caller's decision, which is why nothing is dropped here.

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

export class Channel {
  private turns = new Chan<string>();
  private replies = new Chan<Reply | null>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private label: string;
  private options: Options;

  // Written out rather than as parameter properties: Node strips types, it
  // does not compile them, and `constructor(private x: T)` needs compiling.
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
          if (msg.type === "assistant") {
            // Only the last message counts. With a tool in play the model can
            // say "let me check" before the call, and that must never be glued
            // onto the front of what it says afterwards.
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

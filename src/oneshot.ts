// One prompt, one reply, no conversation, no tools.

import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { assertSubscription, closed, start } from "./runtime.ts";

export type Opts = {
  /** One of runtime.MODELS; anything else is refused rather than tried. */
  model: string;
  effort: EffortLevel;
  cwd?: string;
};

export type Query = typeof query;

const SYSTEM = "Answer the prompt you're given directly. You have no tools, files or web access in this conversation.";

/**
 * The final text. Route, login and model failures throw with a readable reason - a caller that
 * would rather stay quiet catches them; nothing here falls back to another model.
 */
export async function oneShot(prompt: string, o: Opts, runQuery: Query = query): Promise<string> {
  const session = await start(prompt, {
      ...closed({ cwd: o.cwd ?? process.cwd(), systemPrompt: SYSTEM, model: o.model, effort: o.effort, maxTurns: 1 }),
      persistSession: false,
  }, runQuery);
  let out = "";
  let started = false;
  try {
    for await (const msg of session) {
      if (msg.type === "system" && msg.subtype === "init") {
        assertSubscription(msg, []);
        started = true;
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content) if (block.type === "text" && block.text) out = block.text;
      }
      if (msg.type === "result") {
        if (!started) throw new Error("Claude answered without reporting its session setup");
        if (msg.subtype !== "success") throw new Error(msg.errors.join("\n") || msg.subtype);
        if (msg.is_error) throw new Error(msg.result || "Claude reported an error");
        return msg.result || out;
      }
    }
  } catch (err) {
    throw new Error(`${o.model} couldn't answer: ${(err as Error).message}`);
  } finally {
    session.close();
  }
  throw new Error(`${o.model} ended without an answer`);
}

/**
 * The first JSON value of the given shape in a reply, tolerating a fence or a sentence around
 * it.
 */
export function json(text: string, open: "[" | "{"): unknown {
  const close = open === "[" ? "]" : "}";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

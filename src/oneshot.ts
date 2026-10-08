// One prompt, one reply, no conversation, no actions: every bounded call on the user's helper or look model.

import type { Registry } from "./agent/registry.ts";
import type { Picture, Role } from "./agent/types.ts";

export type Opts = {
  agent: Registry;
  /** Whose model answers: the helper, or the look's model for live looks. */
  role: Exclude<Role, "intern">;
  /** An empty runtime directory. Never the process's own working directory. */
  cwd: string;
  /** Pictures that go with the prompt. Refused when the role's model can't be sent pictures. */
  images?: readonly Picture[];
  /** Stops the call wherever it is: opening the session or waiting on the reply. */
  signal?: AbortSignal;
};

const SYSTEM = "Answer the prompt you're given directly. You have no tools, files or web access in this conversation.";

/**
 * The reply's text, from the registry's selector for `role`. Choice, login and model failures throw
 * with a readable reason; nothing here falls back to another backend or model. Stopped: "stopped".
 */
export async function oneShot(prompt: string, o: Opts): Promise<string> {
  if (o.signal?.aborted) throw new Error("stopped");
  const choice = o.agent.chosen();
  const selector = choice[o.role];
  const backend = o.agent.backend(selector.backend);
  if (o.images?.length) {
    const caps = await backend.capabilities(selector, choice.login, o.signal ?? AbortSignal.timeout(60_000));
    if (!caps.images) throw new Error(`${caps.noImages} - choose a ${o.role} model that can see pictures`);
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  o.signal?.addEventListener("abort", stop, { once: true });
  try {
    const session = await backend.open({
      cwd: o.cwd,
      systemPrompt: SYSTEM,
      selector,
      login: choice.login,
      actions: [],
      signal: abort.signal,
      maxTurns: 1,
    });
    try {
      const said: string[] = [];
      for await (const event of session.turn({ text: prompt, ...(o.images?.length ? { images: o.images } : {}) })) {
        if (event.type === "text") said.push(event.text);
        else if (event.type === "action") throw new Error(`it tried to use ${event.name}, and a one-shot call has no actions`);
        else if (event.type === "end") {
          if (event.interrupted || abort.signal.aborted) throw new Error("stopped");
          if (event.error) throw new Error(event.error);
          const out = said.join("\n\n").trim();
          if (!out) throw new Error("it ended without an answer");
          return out;
        }
      }
      throw new Error("it ended without an answer");
    } finally {
      session.close();
    }
  } catch (err) {
    if (abort.signal.aborted) throw new Error("stopped");
    throw new Error(`${selector.model} couldn't answer: ${(err as Error).message}`);
  } finally {
    o.signal?.removeEventListener("abort", stop);
  }
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

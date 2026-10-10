// Dum's own action loop over a stateless ModelClient (the ChatGPT backend). The session keeps the
// history, sends only Dum's actions, and ends for good on any call outside that closed set.

import type { AgentEvent, AgentSession, ModelClient, OpenOptions, WireMessage } from "./types.ts";
import { toWireActions } from "./wire.ts";

const MAX_TURNS = 24;

export function loopSession(client: ModelClient, o: OpenOptions): AgentSession {
  const actions = toWireActions(o.actions);
  const byName = new Map(o.actions.map((a) => [a.name, a]));
  const maxTurns = o.maxTurns ?? MAX_TURNS;
  const history: WireMessage[] = [];
  let ended: string | null = null;
  let running: AbortController | null = null;
  let closed = false;

  /** Yields text and action events; returns the error that ends the turn, or null. */
  async function* steps(signal: AbortSignal): AsyncGenerator<AgentEvent, string | null> {
    for (let step = 0; step < maxTurns; step++) {
      const result = await client.step({ system: o.systemPrompt, history, actions, model: o.selector.model, effort: o.selector.effort, signal });
      signal.throwIfAborted();
      if (result.error) return result.error;
      history.push({ role: "assistant", text: result.text, calls: result.calls });
      if (result.text) yield { type: "text", text: result.text };
      if (!result.calls.length) return null;
      for (const [i, call] of result.calls.entries()) {
        const action = byName.get(call.name);
        if (!action) return `The model called ${JSON.stringify(call.name)}, which isn't one of Dum's actions`;
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          return `The model sent unreadable arguments for ${call.name}`;
        }
        yield { type: "action", name: call.name };
        try {
          const out = await action.call(args, signal);
          history.push({ role: "tool", callId: call.id, text: out.text, isError: out.isError === true });
        } catch (e) {
          // Keep the history replayable after an interrupt: every call gets a result.
          for (const rest of result.calls.slice(i)) history.push({ role: "tool", callId: rest.id, text: "Interrupted", isError: true });
          throw e;
        }
      }
    }
    return `Dum stopped after ${maxTurns} model steps without finishing`;
  }

  return {
    async *turn(input) {
      if (closed) throw new Error("This session is closed");
      if (running) throw new Error("A turn is already running");
      if (ended) {
        yield { type: "end", error: ended, interrupted: false };
        return;
      }
      const controller = new AbortController();
      running = controller;
      const signal = AbortSignal.any([o.signal, controller.signal]);
      history.push({ role: "user", text: input.text, ...(input.images?.length ? { images: input.images } : {}) });
      yield { type: "model", model: o.selector.model, effort: o.selector.effort };
      let error: string | null = null;
      try {
        error = yield* steps(signal);
      } catch (e) {
        if (!signal.aborted) error = e instanceof Error ? e.message : String(e);
      } finally {
        running = null;
      }
      if (signal.aborted) {
        yield { type: "end", error: null, interrupted: true };
        return;
      }
      if (error) ended = error;
      yield { type: "end", error, interrupted: false };
    },
    async interrupt() {
      running?.abort();
    },
    close() {
      closed = true;
      running?.abort();
    },
  };
}

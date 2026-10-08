// One streamed `/v1/chat/completions` request per step. Dum keeps the history and resends it; no
// other route is ever called, and redirects are refused rather than followed.

import type { ModelClient, ModelStep, WireCall, WireMessage } from "./types.ts";

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

type Delta = {
  content?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

export function chatMessages(system: string, history: readonly WireMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") {
      out.push(m.images?.length
        ? { role: "user", content: [{ type: "text", text: m.text }, ...m.images.map((p) => ({ type: "image_url" as const, image_url: { url: `data:${p.mimeType};base64,${p.data}` } }))] }
        : { role: "user", content: m.text });
    } else if (m.role === "assistant") {
      out.push(m.calls.length
        ? { role: "assistant", content: m.text || null, tool_calls: m.calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
        : { role: "assistant", content: m.text });
    } else {
      out.push({ role: "tool", tool_call_id: m.callId, content: m.isError ? `Error: ${m.text}` : m.text });
    }
  }
  return out;
}

/** `baseUrl` is the server root, e.g. `http://127.0.0.1:11434`. */
export function chatCompletionsClient(baseUrl: string): ModelClient {
  const url = new URL("/v1/chat/completions", baseUrl).href;
  return {
    async step(req) {
      const body: Record<string, unknown> = { model: req.model, stream: true, messages: chatMessages(req.system, req.history) };
      if (req.actions.length) body.tools = req.actions.map((a) => ({ type: "function", function: { name: a.name, description: a.description, parameters: a.parameters } }));
      if (req.effort) body.reasoning_effort = req.effort;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: req.signal,
      });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel();
        return failed("Local endpoint could not be verified: it tried to redirect");
      }
      if (!res.ok) return failed(`The model server answered ${res.status}: ${(await res.text()).slice(0, 300).trim()}`);
      if (!res.body) return failed("The model server sent no stream");
      return read(res.body, req.signal);
    },
  };
}

function failed(error: string): ModelStep {
  return { text: "", calls: [], error };
}

async function read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<ModelStep> {
  let text = "";
  const calls: { id: string; name: string; arguments: string }[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const reader = body.getReader();
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        let event: { error?: unknown; choices?: { delta?: Delta }[] };
        try {
          event = JSON.parse(data);
        } catch {
          return { text, calls: [], error: "The model server sent a malformed stream" };
        }
        if (event.error) return { text, calls: [], error: `The model server reported an error: ${describe(event.error)}` };
        const delta = event.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) text += delta.content;
        for (const part of delta.tool_calls ?? []) {
          const index = part.index ?? calls.length;
          const call = (calls[index] ??= { id: "", name: "", arguments: "" });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
        }
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => undefined);
  }
  signal.throwIfAborted();
  const out: WireCall[] = [];
  for (const [i, call] of calls.entries()) {
    if (!call || !call.name) return { text, calls: [], error: "The model sent an action call without a name" };
    out.push({ id: call.id || `call_${i}`, name: call.name, arguments: call.arguments || "{}" });
  }
  return { text, calls: out, error: null };
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return JSON.stringify(error).slice(0, 300);
}

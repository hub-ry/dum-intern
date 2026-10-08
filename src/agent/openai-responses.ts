// ChatGPT through Sign in with ChatGPT, in the desktop host: the account's model catalog and one
// streamed `POST /v1/responses` per loop step. Every request has `store:false` and `stream:true`,
// replays the whole history (no `previous_response_id`), sends the system prompt as
// `instructions`, and carries only Dum's actions as function tools in one `dum` namespace; no
// hosted tool is ever sent. Access tokens come from main on demand and never enter env or logs.
// Sources: developers.openai.com/siwc/token-sharing-open-source (models-and-inference,
// preview-limitations, errors-and-recovery) and the Responses types `NamespaceTool`,
// `ResponseFunctionToolCall.namespace` and `ResponseReasoningItem.encrypted_content`.

import timers from "node:timers/promises";
import { z } from "zod";
import { loopSession } from "./loop.ts";
import type { AgentBackend, Capabilities, CredentialSource, ModelClient, ModelOption, ModelStep, Selector, WireCall, WireMessage } from "./types.ts";

const API = "https://api.openai.com/v1";
const NAMESPACE = "dum";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const USAGE_URL = "https://chatgpt.com/settings/usage";
/** Waits before retrying a 503 that arrived before any stream opened; bounded. */
const BACKOFF_MS = [1000, 3000];
const SIGN_IN_AGAIN = "Sign in to ChatGPT again in Settings → Agent";
const CANNOT_USE = "This ChatGPT login cannot be used by Dum";

/** Readable copy for the codes SIWC documents; anything else shows its own code and message. */
const ERROR_COPY: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `You've reached the ChatGPT usage limit for Dum. Your draft and conversation are kept here; check ${USAGE_URL} and try again later.`,
  subscription_sharing_usage_unavailable: "ChatGPT couldn't check your plan's usage right now. Try again in a little while.",
  subscription_sharing_user_not_eligible: "ChatGPT plan use isn't available for this account or workspace.",
  subscription_sharing_unsupported_capability: "ChatGPT rejected part of Dum's request as unsupported. This model can't be used until Dum is updated; choose another model.",
  subscription_sharing_route_not_supported: "ChatGPT doesn't allow this request route for Dum.",
  subscription_sharing_invalid_user: `ChatGPT couldn't validate this account. ${SIGN_IN_AGAIN}.`,
  chatpass_v2_scope_not_authorized: `${CANNOT_USE}: it isn't authorized for this request.`,
  chatpass_v2_invalid_authorization_context: `${CANNOT_USE}: it isn't authorized for this request.`,
  subscription_sharing_user_unavailable: "ChatGPT couldn't load your account right now. Try again in a little while.",
};

const Catalog = z.object({
  models: z.array(z.looseObject({
    slug: z.string().min(1).max(200),
    display_name: z.string().max(200).optional(),
    visibility: z.string().optional(),
    input_modalities: z.array(z.string()).optional(),
    supported_reasoning_levels: z.array(z.looseObject({ effort: z.string().min(1).max(40) })).optional(),
  })),
});

const AccessClaims = z.looseObject({ scope: z.string(), aud: z.union([z.string(), z.array(z.string())]) });

export function chatgptBackend(o: { credential: CredentialSource }): AgentBackend {
  const known = new Map<string, ModelOption>();
  const backend: AgentBackend = {
    id: "chatgpt",
    label: "ChatGPT",
    async models(login, signal) {
      if (login !== "chatgpt") throw new Error(`ChatGPT doesn't sign in with ${login}`);
      const options = await catalog(await token(o.credential, signal), signal);
      known.clear();
      for (const m of options) known.set(m.id, m);
      return options;
    },
    async capabilities(selector, login, signal): Promise<Capabilities> {
      const option = known.get(selector.model) ?? (await backend.models(login, signal)).find((m) => m.id === selector.model);
      const images = option?.images ?? false;
      return {
        model: selector.model, images, noImages: images ? "" : `${selector.model} can't see pictures`, interrupt: true, runtimeActionCheck: false,
      };
    },
    async open(session) {
      if (session.login !== "chatgpt") throw new Error(`ChatGPT doesn't sign in with ${session.login}`);
      if (session.selector.backend !== "chatgpt") throw new Error(`${session.selector.backend} isn't the ChatGPT backend`);
      const access = await token(o.credential, session.signal);
      grantAllowsPlanUse(access);
      const options = await catalog(access, session.signal);
      for (const m of options) known.set(m.id, m);
      const option = options.find((m) => m.id === session.selector.model);
      if (!option) throw new Error(`${session.selector.model} isn't in your ChatGPT catalog any more. Choose a current ChatGPT model.`);
      if (session.actions.length && !option.actions) throw new Error(`${option.label} can't call actions, so it can only be a helper`);
      if (session.selector.effort !== null && !option.efforts.includes(session.selector.effort)) throw new Error(`${option.label} doesn't offer effort ${session.selector.effort}`);
      const loop = loopSession(responsesClient(o.credential, option), session);
      return {
        async *turn(input) {
          if (input.images?.length && !option.images) {
            yield { type: "end", error: `${option.label} can't see pictures`, interrupted: false };
            return;
          }
          yield* loop.turn(input);
        },
        interrupt: () => loop.interrupt(),
        close: () => loop.close(),
      };
    },
  };
  return backend;
}

/**
 * One streamed Responses request per step. Reasoning items from a step that called actions are
 * replayed, with their encrypted content, in front of those calls on the following requests,
 * because `store:false` keeps nothing server-side.
 */
export function responsesClient(credential: CredentialSource, option: ModelOption): ModelClient {
  const reasoning = new Map<string, Item[]>();
  return {
    async step(req) {
      if (!option.images && req.history.some((m) => m.role === "user" && m.images?.length)) return failed(`${option.label} can't see pictures`);
      const body: Record<string, unknown> = {
        model: req.model,
        instructions: req.system,
        input: responsesInput(req.history, reasoning),
        store: false,
        stream: true,
      };
      if (req.actions.length) {
        body.tools = [{
          type: "namespace",
          name: NAMESPACE,
          description: "Dum's actions. These are the only functions available.",
          tools: req.actions.map((a) => ({ type: "function", name: a.name, description: a.description, parameters: a.parameters, strict: false })),
        }];
      }
      if (option.efforts.length) body.include = ["reasoning.encrypted_content"];
      if (req.effort !== null) body.reasoning = { effort: req.effort };
      const payload = JSON.stringify(body);

      for (let attempt = 0; ; attempt++) {
        const access = await token(credential, req.signal);
        const res = await fetch(`${API}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "text/event-stream" },
          body: payload,
          redirect: "error",
          signal: req.signal,
        });
        if (res.ok && res.body) {
          const step = await read(res.body, req.signal);
          if (step.calls.length && step.reasoning.length) reasoning.set(step.calls[0]!.id, step.reasoning);
          return { text: step.text, calls: step.calls, error: step.error };
        }
        const problem = await refusal(res);
        // Admission failed before any stream: the body was refused, so a temporary 503 may be retried.
        if (res.status === 503 && attempt < BACKOFF_MS.length) {
          await timers.setTimeout(BACKOFF_MS[attempt], undefined, { signal: req.signal });
          continue;
        }
        return failed(problem);
      }
    },
  };
}

type Item = Record<string, unknown>;

function responsesInput(history: readonly WireMessage[], reasoning: ReadonlyMap<string, Item[]>): Item[] {
  const items: Item[] = [];
  for (const m of history) {
    if (m.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: m.text },
          ...(m.images ?? []).map((p) => ({ type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}`, detail: "auto" })),
        ],
      });
    } else if (m.role === "assistant") {
      const first = m.calls[0];
      if (first) items.push(...(reasoning.get(first.id) ?? []));
      if (m.text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
      for (const c of m.calls) items.push({ type: "function_call", call_id: c.id, namespace: NAMESPACE, name: c.name, arguments: c.arguments });
    } else {
      items.push({ type: "function_call_output", call_id: m.callId, output: m.isError ? `Error: ${m.text}` : m.text });
    }
  }
  return items;
}

const ItemType = z.looseObject({ type: z.string() });
const MessageItem = z.looseObject({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() })) });
const CallItem = z.looseObject({ call_id: z.string().min(1), name: z.string().min(1), namespace: z.string().optional(), arguments: z.string() });
const ReasoningItem = z.looseObject({ summary: z.array(z.unknown()).optional(), encrypted_content: z.string().nullish() });
const ErrorShape = z.looseObject({ code: z.string().nullish(), message: z.string().nullish() });
const StreamEvent = z.looseObject({
  type: z.string(),
  item: z.unknown().optional(),
  code: z.string().nullish(),
  message: z.string().nullish(),
  response: z.looseObject({ error: ErrorShape.nullish(), incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish() }).optional(),
});

type Read = { text: string; calls: WireCall[]; reasoning: Item[]; error: string | null };

/** `response.output_item.done` items are authoritative; success only after `response.completed`. */
async function read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Read> {
  let text = "";
  const calls: WireCall[] = [];
  const reasoning: Item[] = [];
  const stop = (error: string): Read => ({ text, calls: [], reasoning: [], error });
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
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
        if (!data || data === "[DONE]") continue;
        let event: z.infer<typeof StreamEvent>;
        try {
          event = StreamEvent.parse(JSON.parse(data));
        } catch {
          return stop("ChatGPT sent a stream Dum couldn't read");
        }
        if (event.type === "response.completed") {
          signal.throwIfAborted();
          return { text, calls, reasoning, error: null };
        }
        if (event.type === "response.failed") return stop(described(event.response?.error?.code, event.response?.error?.message));
        if (event.type === "error") return stop(described(event.code, event.message));
        if (event.type === "response.incomplete") return stop(`ChatGPT stopped before finishing (${event.response?.incomplete_details?.reason ?? "no reason given"})`);
        if (event.type !== "response.output_item.done") continue;
        const kind = ItemType.safeParse(event.item);
        if (!kind.success) return stop("ChatGPT sent an output item Dum couldn't read");
        if (kind.data.type === "message") {
          const item = MessageItem.safeParse(event.item);
          if (!item.success) return stop("ChatGPT sent a message Dum couldn't read");
          for (const part of item.data.content) text += part.type === "output_text" ? part.text ?? "" : part.type === "refusal" ? part.refusal ?? "" : "";
        } else if (kind.data.type === "function_call") {
          const item = CallItem.safeParse(event.item);
          if (!item.success) return stop("ChatGPT sent an action call Dum couldn't read");
          const { call_id, name, namespace, arguments: args } = item.data;
          // Dum only offers its own namespace; a call anywhere else ends the session.
          if (namespace !== NAMESPACE) return stop(`ChatGPT called ${JSON.stringify(namespace ? `${namespace}.${name}` : name)}, which isn't one of Dum's actions`);
          calls.push({ id: call_id, name, arguments: args || "{}" });
        } else if (kind.data.type === "reasoning") {
          const item = ReasoningItem.safeParse(event.item);
          if (!item.success) return stop("ChatGPT sent reasoning Dum couldn't read");
          if (item.data.encrypted_content) reasoning.push({ type: "reasoning", summary: item.data.summary ?? [], encrypted_content: item.data.encrypted_content });
        }
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => undefined);
  }
  signal.throwIfAborted();
  return stop("The ChatGPT stream ended before the answer was complete");
}

/** Reads a refused response: a Responses `error` object, an admission `{detail}`, or nothing. */
async function refusal(res: Response): Promise<string> {
  const request = res.headers.get("x-request-id");
  const raw = await res.text().catch(() => "");
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = z.looseObject({ error: ErrorShape.nullish(), detail: z.string().nullish() }).parse(JSON.parse(raw));
    code = parsed.error?.code ?? null;
    message = parsed.error?.message ?? parsed.detail ?? null;
  } catch {
    message = raw.slice(0, 300).trim() || null;
  }
  const suffix = request ? ` (request ${request})` : "";
  if (code) return `${described(code, message)}${suffix}`;
  if (res.status === 401) return `ChatGPT didn't accept this sign-in. ${SIGN_IN_AGAIN}.${suffix}`;
  if (res.status === 403) return `ChatGPT refused the request: ${message ?? "a policy or permission check failed"}${suffix}`;
  if (res.status === 503) return `ChatGPT plan use is unavailable right now. Try again in a little while.${suffix}`;
  return `ChatGPT answered ${res.status}${message ? `: ${message}` : ""}${suffix}`;
}

function described(code: string | null | undefined, message: string | null | undefined): string {
  if (code && Object.hasOwn(ERROR_COPY, code)) return ERROR_COPY[code]!;
  if (code) return `ChatGPT reported ${code}${message ? `: ${message}` : ""}`;
  return `ChatGPT reported an error${message ? `: ${message}` : ""}`;
}

function failed(error: string): ModelStep {
  return { text: "", calls: [], error };
}

/** The account's catalog: listed models only, in the server's order; the slug is what's sent. */
async function catalog(access: string, signal: AbortSignal): Promise<ModelOption[]> {
  const res = await fetch(`${API}/models`, { headers: { authorization: `Bearer ${access}`, accept: "application/json" }, redirect: "error", signal });
  if (!res.ok) throw new Error(await refusal(res));
  const parsed = Catalog.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error("ChatGPT sent a model list Dum couldn't read");
  return parsed.data.models
    .filter((m) => m.visibility === "list")
    .map((m) => ({
      id: m.slug,
      resolved: m.slug,
      label: m.display_name || m.slug,
      efforts: m.supported_reasoning_levels?.map((l) => l.effort) ?? [],
      images: m.input_modalities?.includes("image") ?? false,
      // Every listed model takes function tools on this route; none is proven until the release gate.
      actions: true,
      verified: false,
    }));
}

/** Asks main for a current token; an expired answer is asked for once more, then refused. */
async function token(credential: CredentialSource, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await credential("chatgpt-access", signal);
    if (!got) throw new Error(`Not signed in to ChatGPT. ${SIGN_IN_AGAIN}.`);
    if (got.expiresAt === null || got.expiresAt > Date.now()) return got.value;
  }
  throw new Error(`Your ChatGPT sign-in has expired. ${SIGN_IN_AGAIN}.`);
}

/** The access token's own claims must carry ChatGPT plan use for the API resource. */
function grantAllowsPlanUse(access: string): void {
  const payload = access.split(".")[1];
  let claims: z.infer<typeof AccessClaims>;
  try {
    claims = AccessClaims.parse(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")));
  } catch {
    throw new Error(`${CANNOT_USE}: its access token can't be checked`);
  }
  const scopes = claims.scope.split(" ");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!scopes.includes(PLAN_SCOPE) || !scopes.includes("resource.invoke")) throw new Error(`${CANNOT_USE}: ChatGPT plan use isn't allowed`);
  if (!audience.includes(API)) throw new Error(`${CANNOT_USE}: its access token isn't for the OpenAI API`);
}

import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { chatgptBackend, responsesClient } from "../src/agent/openai-responses.ts";
import type { AgentEvent, CredentialSource, DumAction, ModelClient, ModelOption, OpenOptions, WireAction, WireMessage } from "../src/agent/types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-chatgpt-"));
process.env.DUM_CONTEXT = "off";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null; signal: AbortSignal | null };

/** Routes every fetch to `handler`; the test fails on any request it doesn't expect. */
function serve(handler: (req: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    init?.signal?.throwIfAborted();
    const req: Seen = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : null, signal: init?.signal ?? null };
    seen.push(req);
    return handler(req);
  };
  return seen;
}

function sse(...events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const done = (item: Record<string, unknown>) => ({ type: "response.output_item.done", output_index: 0, item });
const message = (text: string) => done({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const call = (callId: string, name: string, args: object, namespace: string | null = "dum") =>
  done({ type: "function_call", id: `fc_${callId}`, call_id: callId, name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), status: "completed" });
const completed = { type: "response.completed", response: { id: "resp_1", status: "completed" } };

const credential = (value = accessToken()): CredentialSource => async () => ({ value, expiresAt: Date.now() + 3_600_000 });

function accessToken(scope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke", aud = "https://api.openai.com/v1"): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ sub: "user", aud, scope, iss: "https://auth.openai.com", exp: 9_999_999_999 })}.sig`;
}

const option = (o: Partial<ModelOption> = {}): ModelOption => ({ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high"], images: true, actions: true, verified: false, ...o });
const actions: WireAction[] = [{ name: "remember", description: "Save a note", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
const step = (history: readonly WireMessage[], o: { effort?: string | null; signal?: AbortSignal; client?: ModelClient } = {}) =>
  (o.client ?? responsesClient(credential(), option())).step({ system: "You are Dum.", history, actions, model: "gpt-6.1-sol", effort: o.effort === undefined ? "high" : o.effort, signal: o.signal ?? new AbortController().signal });

test("contract: the request is store:false, stream:true, instructions, and only a `dum` namespace of function tools", async () => {
  const seen = serve(() => sse(message("hi"), completed));
  await step([{ role: "user", text: "hello" }]);
  assert.equal(seen.length, 1);
  const [req] = seen;
  assert.equal(req!.url, "https://api.openai.com/v1/responses");
  assert.equal(req!.method, "POST");
  assert.equal(req!.headers.get("authorization"), `Bearer ${accessToken()}`);
  const body = req!.body!;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "You are Dum.");
  assert.equal(body.model, "gpt-6.1-sol");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.tools, [{
    type: "namespace",
    name: "dum",
    description: "Dum's actions. These are the only functions available.",
    tools: [{ type: "function", name: "remember", description: "Save a note", parameters: actions[0]!.parameters, strict: false }],
  }]);
  for (const forbidden of ["previous_response_id", "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "prompt", "safety_identifier", "temperature", "top_p", "truncation", "user", "tool_choice"]) {
    assert.equal(forbidden in body, false, `${forbidden} must not be sent`);
  }
  assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  assert.doesNotMatch(JSON.stringify(body.input), /"role":"system"/);
});

test("contract: effort is sent only when chosen, and reasoning is requested only from reasoning models", async () => {
  const seen = serve(() => sse(message("ok"), completed));
  await step([{ role: "user", text: "hi" }], { effort: null });
  await step([{ role: "user", text: "hi" }], { effort: null, client: responsesClient(credential(), option({ efforts: [] })) });
  assert.equal("reasoning" in seen[0]!.body!, false);
  assert.deepEqual(seen[0]!.body!.include, ["reasoning.encrypted_content"]);
  assert.equal("include" in seen[1]!.body!, false);
});

test("text: the completed message item is the step's text", async () => {
  serve(() => sse({ type: "response.created", response: {} }, { type: "response.output_text.delta", delta: "Hel" }, message("Hello"), completed));
  assert.deepEqual(await step([{ role: "user", text: "hi" }]), { text: "Hello", calls: [], error: null });
});

test("contract: an action call comes back bare, then replays namespaced with its result and its encrypted reasoning", async () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "gAAAA-opaque" };
  const seen = serve((req) => (Array.isArray(req.body!.input) && req.body!.input.length > 1 ? sse(message("Saved."), completed) : sse(done(reasoning), call("call_1", "remember", { text: "x" }), completed)));
  const client = responsesClient(credential(), option());
  const first = await step([{ role: "user", text: "remember x" }], { client });
  assert.deepEqual(first, { text: "", calls: [{ id: "call_1", name: "remember", arguments: '{"text":"x"}' }], error: null });
  const second = await step([
    { role: "user", text: "remember x" },
    { role: "assistant", text: "", calls: first.calls },
    { role: "tool", callId: "call_1", text: "noted", isError: false },
  ], { client });
  assert.equal(second.text, "Saved.");
  assert.deepEqual(seen[1]!.body!.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "remember x" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "gAAAA-opaque" },
    { type: "function_call", call_id: "call_1", namespace: "dum", name: "remember", arguments: '{"text":"x"}' },
    { type: "function_call_output", call_id: "call_1", output: "noted" },
  ]);
});

test("a failed action result replays as an error output", async () => {
  const seen = serve(() => sse(message("ok"), completed));
  await step([
    { role: "user", text: "go" },
    { role: "assistant", text: "Trying.", calls: [{ id: "c", name: "remember", arguments: "{}" }] },
    { role: "tool", callId: "c", text: "refused", isError: true },
  ]);
  const input = seen[0]!.body!.input as unknown[];
  assert.deepEqual(input[1], { type: "message", role: "assistant", content: [{ type: "output_text", text: "Trying." }] });
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "c", output: "Error: refused" });
});

test("unknown action: a call outside the `dum` namespace ends the step with an error", async () => {
  serve(() => sse(call("call_9", "shell", { cmd: "ls" }, "functions"), completed));
  const out = await step([{ role: "user", text: "hi" }]);
  assert.deepEqual(out.calls, []);
  assert.match(out.error ?? "", /"functions\.shell", which isn't one of Dum's actions/);
  serve(() => sse(call("call_9", "remember", { text: "x" }, null), completed));
  assert.match((await step([{ role: "user", text: "hi" }])).error ?? "", /isn't one of Dum's actions/);
});

test("usage limit: a mid-stream response.failed becomes readable text", async () => {
  serve(() => sse(message("partial"), { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }));
  const out = await step([{ role: "user", text: "hi" }]);
  assert.match(out.error ?? "", /usage limit for Dum/);
  assert.match(out.error ?? "", /chatgpt\.com\/settings\/usage/);
  assert.deepEqual(out.calls, []);
});

test("usage limit before the stream opens keeps the request id and is not retried", async () => {
  const seen = serve(() => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "x", param: null } }), { status: 429, headers: { "x-request-id": "req_42" } }));
  const out = await step([{ role: "user", text: "hi" }]);
  assert.equal(seen.length, 1);
  assert.match(out.error ?? "", /usage limit for Dum.*\(request req_42\)/);
});

/** Advances mocked timers until `count` requests have been made; the backoff never waits in real time. */
async function untilRequests(seen: Seen[], count: number): Promise<void> {
  while (seen.length < count) {
    await new Promise(setImmediate);
    mock.timers.tick(1000);
  }
}

test("retry: a 503 before any stream is retried with backoff, then the answer streams", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const seen = serve(() => (n++ === 0 ? new Response(JSON.stringify({ detail: "Direct routing is unavailable" }), { status: 503 }) : sse(message("back"), completed)));
  const pending = step([{ role: "user", text: "hi" }]);
  await untilRequests(seen, 2);
  const out = await pending;
  assert.equal(seen.length, 2);
  assert.deepEqual(out, { text: "back", calls: [], error: null });
  assert.deepEqual(seen[0]!.body, seen[1]!.body);
});

test("retry is bounded: repeated 503s end with a readable error", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout"] });
  const seen = serve(() => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_unavailable", message: "later" } }), { status: 503 }));
  const pending = step([{ role: "user", text: "hi" }]);
  await untilRequests(seen, 3);
  const out = await pending;
  assert.equal(seen.length, 3);
  assert.match(out.error ?? "", /couldn't check your plan's usage/);
});

test("401 admission, unsupported capability and a truncated stream are errors, never retried", async () => {
  const seen = serve(() => new Response(JSON.stringify({ detail: "bad identity" }), { status: 401 }));
  assert.match((await step([{ role: "user", text: "hi" }])).error ?? "", /didn't accept this sign-in/);
  assert.equal(seen.length, 1);
  serve(() => new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "tools" } }), { status: 400 }));
  assert.match((await step([{ role: "user", text: "hi" }])).error ?? "", /unsupported/);
  serve(() => sse(message("half")));
  assert.match((await step([{ role: "user", text: "hi" }])).error ?? "", /ended before the answer was complete/);
  serve(() => sse(message("half"), { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }));
  assert.match((await step([{ role: "user", text: "hi" }])).error ?? "", /stopped before finishing \(max_output_tokens\)/);
});

test("pictures go as input_image data URLs, and a text-only model refuses them before sending", async () => {
  const seen = serve(() => sse(message("a cat"), completed));
  await step([{ role: "user", text: "what is this", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] }]);
  assert.deepEqual((seen[0]!.body!.input as { content: unknown[] }[])[0]!.content[1], { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" });
  const out = await step([{ role: "user", text: "what is this", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] }], { client: responsesClient(credential(), option({ images: false })) });
  assert.match(out.error ?? "", /can't see pictures/);
  assert.equal(seen.length, 1);
});

test("an expired or missing credential stops before anything is sent", async () => {
  const seen = serve(() => sse(message("no"), completed));
  let asked = 0;
  const expired: CredentialSource = async () => (asked++, { value: accessToken(), expiresAt: Date.now() - 1 });
  await assert.rejects(step([{ role: "user", text: "hi" }], { client: responsesClient(expired, option()) }), /sign-in has expired/);
  assert.equal(asked, 2, "asks main once more before giving up");
  await assert.rejects(step([{ role: "user", text: "hi" }], { client: responsesClient(async () => null, option()) }), /Not signed in to ChatGPT/);
  assert.equal(seen.length, 0);
});

test("abort mid-stream rejects the step", async () => {
  const controller = new AbortController();
  serve((req) => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // A real fetch errors its body when the request's signal aborts.
        req.signal?.addEventListener("abort", () => c.error(req.signal?.reason));
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message("partial"))}\n\n`));
      },
      pull() {
        controller.abort();
        return new Promise(() => undefined);
      },
    });
    return new Response(stream, { status: 200 });
  });
  await assert.rejects(step([{ role: "user", text: "hi" }], { signal: controller.signal }), { name: "AbortError" });
});

const catalogBody = {
  models: [
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
    { slug: "gpt-text", display_name: "Text Only", visibility: "list", input_modalities: ["text"] },
  ],
};

test("models: the account catalog, listed models only, in server order", async () => {
  const seen = serve(() => Response.json(catalogBody));
  const backend = chatgptBackend({ credential: credential() });
  const models = await backend.models("chatgpt", new AbortController().signal);
  assert.equal(seen[0]!.url, "https://api.openai.com/v1/models");
  assert.equal(seen[0]!.method, "GET");
  assert.deepEqual(models, [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "high"], images: true, actions: true, verified: false },
    { id: "gpt-text", label: "Text Only", efforts: [], images: false, actions: true, verified: false },
  ]);
  assert.equal(backend.capabilities({ backend: "chatgpt", model: "gpt-6.1-sol", effort: null }).images, true);
  assert.equal(backend.capabilities({ backend: "chatgpt", model: "gpt-text", effort: null }).images, false);
  await assert.rejects(backend.models("anthropic-key", new AbortController().signal), /doesn't sign in with anthropic-key/);
});

const zone: ZoneContext = { id: "z1", revision: 1, breadcrumb: [{ id: "z1", name: "Zone" }], goal: "", ancestorGoals: [], language: "", focusSkills: [], notes: [] };

function openOptions(o: Partial<OpenOptions> = {}): OpenOptions {
  return {
    cwd: tmpdir(),
    zone,
    binding: { zoneId: "z1", zoneEpoch: "e", inputToken: "t", requestId: "r" },
    systemPrompt: "You are Dum.",
    selector: { backend: "chatgpt", model: "gpt-6.1-sol", effort: "high" },
    login: "chatgpt",
    actions: [],
    signal: new AbortController().signal,
    ...o,
  };
}

test("open refuses a grant without ChatGPT plan use, a gone model and an unoffered effort, before any inference", async () => {
  const seen = serve((req) => (req.url.endsWith("/models") ? Response.json(catalogBody) : sse(completed)));
  await assert.rejects(chatgptBackend({ credential: credential(accessToken("openid email resource.invoke")) }).open(openOptions()), /cannot be used by Dum: ChatGPT plan use isn't allowed/);
  await assert.rejects(chatgptBackend({ credential: credential(accessToken(undefined, "https://example.com")) }).open(openOptions()), /isn't for the OpenAI API/);
  await assert.rejects(chatgptBackend({ credential: credential("opaque") }).open(openOptions()), /can't be checked/);
  const backend = chatgptBackend({ credential: credential() });
  await assert.rejects(backend.open(openOptions({ selector: { backend: "chatgpt", model: "gpt-gone", effort: null } })), /Choose a current ChatGPT model/);
  await assert.rejects(backend.open(openOptions({ selector: { backend: "chatgpt", model: "gpt-6.1-sol", effort: "max" } })), /doesn't offer effort max/);
  await assert.rejects(backend.open(openOptions({ login: "anthropic-key" })), /doesn't sign in/);
  assert.ok(seen.every((r) => !r.url.endsWith("/responses")));
});

test("a session runs Dum's action through the loop and ends on the model's answer", async () => {
  const calls: unknown[] = [];
  const remember: DumAction = {
    name: "remember",
    description: "Save a note",
    schema: { text: z.string() },
    async call(args) {
      calls.push(args);
      return { text: "noted" };
    },
  };
  let n = 0;
  const seen = serve((req) => {
    if (req.url.endsWith("/models")) return Response.json(catalogBody);
    return n++ === 0 ? sse(call("call_1", "remember", { text: "x" }), completed) : sse(message("Saved it."), completed);
  });
  const session = await chatgptBackend({ credential: credential() }).open(openOptions({ actions: [remember] }));
  const events: AgentEvent[] = [];
  for await (const e of session.turn({ text: "remember x" })) events.push(e);
  assert.deepEqual(calls, [{ text: "x" }]);
  assert.deepEqual(events, [
    { type: "model", model: "gpt-6.1-sol", effort: "high" },
    { type: "action", name: "remember" },
    { type: "text", text: "Saved it." },
    { type: "end", error: null, interrupted: false },
  ]);
  const posts = seen.filter((r) => r.url.endsWith("/responses"));
  assert.equal(posts.length, 2);
  assert.deepEqual((posts[0]!.body!.tools as { tools: { name: string }[] }[])[0]!.tools.map((t) => t.name), ["remember"]);
});

test("a session refuses pictures for a text-only model without calling ChatGPT", async () => {
  const seen = serve((req) => (req.url.endsWith("/models") ? Response.json(catalogBody) : sse(completed)));
  const session = await chatgptBackend({ credential: credential() }).open(openOptions({ selector: { backend: "chatgpt", model: "gpt-text", effort: null } }));
  const events: AgentEvent[] = [];
  for await (const e of session.turn({ text: "look", images: [{ mimeType: "image/png", data: "AA==" }] })) events.push(e);
  assert.deepEqual(events, [{ type: "end", error: "Text Only can't see pictures", interrupted: false }]);
  assert.ok(seen.every((r) => !r.url.endsWith("/responses")));
});

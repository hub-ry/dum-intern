import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { loopSession } from "../src/agent/loop.ts";
import { chatCompletionsClient } from "../src/agent/openai-compatible.ts";
import { bareName, toWireActions } from "../src/agent/wire.ts";
import type { AgentEvent, DumAction, OpenOptions } from "../src/agent/types.ts";

process.env.DUM_CONTEXT = "off";

type ChatBody = {
  stream: boolean;
  tools?: { function: { name: string; parameters: { required?: string[] } } }[];
  messages: { role: string; content?: unknown }[];
};
type Reply = (req: { body: ChatBody }, res: ServerResponse) => void;

async function server(replies: Reply[]) {
  const bodies: ChatBody[] = [];
  const paths: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    paths.push(req.url ?? "");
    const body = JSON.parse(raw) as ChatBody;
    bodies.push(body);
    const reply = replies.shift();
    if (!reply) { res.statusCode = 500; res.end("no more replies"); return; }
    reply({ body }, res);
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as AddressInfo;
  const close = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    srv.closeAllConnections();
    srv.close(() => resolve());
    return promise;
  };
  return { base: `http://127.0.0.1:${port}`, bodies, paths, close };
}

function endError(events: AgentEvent[]): string | null {
  const end = events.at(-1);
  assert.equal(end?.type, "end");
  return end?.type === "end" ? end.error : null;
}

function sse(chunks: unknown[], done = true): Reply {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    if (done) res.write("data: [DONE]\n\n");
    res.end();
  };
}

const delta = (d: unknown) => ({ choices: [{ index: 0, delta: d }] });

function options(actions: DumAction[], extra: Partial<OpenOptions> = {}): OpenOptions {
  return {
    cwd: "/tmp",
    zone: { id: "z1", revision: 1, breadcrumb: [], goal: "", ancestorGoals: [], language: "", focusSkills: [], notes: [] },
    binding: { zoneId: "z1", zoneEpoch: "e", inputToken: "t", requestId: "r" },
    systemPrompt: "You are Dum.",
    selector: { backend: "local", model: "m", effort: null },
    login: "none",
    actions,
    signal: new AbortController().signal,
    ...extra,
  } as OpenOptions;
}

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function recorder(name = "read_file") {
  const calls: unknown[] = [];
  const action: DumAction = {
    name,
    description: "Read a shared file",
    schema: { path: z.string() },
    async call(args) {
      calls.push(args);
      return { text: "file text" };
    },
  };
  return { action, calls };
}

test("streams text and sends the system prompt and history", async () => {
  const s = await server([sse([delta({ role: "assistant" }), delta({ content: "Hel" }), delta({ content: "lo" })])]);
  try {
    const session = loopSession(chatCompletionsClient(s.base), options([]));
    const events = await collect(session.turn({ text: "hi" }));
    assert.deepEqual(events, [
      { type: "model", model: "m", effort: null },
      { type: "text", text: "Hello" },
      { type: "end", error: null, interrupted: false },
    ]);
    assert.deepEqual(s.paths, ["/v1/chat/completions"]);
    assert.equal(s.bodies[0].stream, true);
    assert.equal(s.bodies[0].tools, undefined);
    assert.deepEqual(s.bodies[0].messages, [{ role: "system", content: "You are Dum." }, { role: "user", content: "hi" }]);
  } finally {
    await s.close();
  }
});

test("joins split tool-call deltas, runs the action and continues with its result", async () => {
  const { action, calls } = recorder();
  const s = await server([
    sse([
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: "file", arguments: "{\"pa" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: "th\":\"a/b.ts\"}" } }] }),
    ]),
    sse([delta({ content: "Done." })]),
  ]);
  try {
    const session = loopSession(chatCompletionsClient(s.base), options([action]));
    const events = await collect(session.turn({ text: "read it" }));
    assert.deepEqual(events.map((e) => e.type), ["model", "action", "text", "end"]);
    assert.deepEqual(calls, [{ path: "a/b.ts" }]);
    assert.equal(s.bodies[0].tools?.[0]?.function.name, "read_file");
    assert.deepEqual(s.bodies[0].tools?.[0]?.function.parameters.required, ["path"]);
    const second = s.bodies[1].messages;
    assert.deepEqual(second.at(-2), {
      role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a/b.ts\"}" } }],
    });
    assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "call_1", content: "file text" });
  } finally {
    await s.close();
  }
});

test("an unknown action ends the session and runs nothing", async () => {
  const { action, calls } = recorder();
  const s = await server([sse([delta({ tool_calls: [{ index: 0, id: "c", function: { name: "Bash", arguments: "{}" } }] })])]);
  try {
    const session = loopSession(chatCompletionsClient(s.base), options([action]));
    const events = await collect(session.turn({ text: "go" }));
    const end = events.at(-1) as Extract<AgentEvent, { type: "end" }>;
    assert.match(end.error ?? "", /Bash.*isn't one of Dum's actions/);
    assert.equal(calls.length, 0);
    const again = await collect(session.turn({ text: "again" }));
    assert.deepEqual(again, [end]);
    assert.equal(s.bodies.length, 1);
  } finally {
    await s.close();
  }
});

test("interrupt mid-stream ends as interrupted", async () => {
  const streaming = Promise.withResolvers<void>();
  const s = await server([(_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(delta({ content: "partial" }))}\n\n`, () => streaming.resolve());
  }]);
  try {
    const session = loopSession(chatCompletionsClient(s.base), options([]));
    const it = session.turn({ text: "go" })[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.type, "model");
    const next = it.next();
    await streaming.promise;
    await session.interrupt();
    assert.deepEqual((await next).value, { type: "end", error: null, interrupted: true });
    assert.equal((await it.next()).done, true);
  } finally {
    await s.close();
  }
});

test("maxTurns stops a model that keeps calling actions", async () => {
  const { action, calls } = recorder();
  const call = sse([delta({ tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } }] })]);
  const s = await server([call, call, call]);
  try {
    const session = loopSession(chatCompletionsClient(s.base), options([action], { maxTurns: 2 }));
    const events = await collect(session.turn({ text: "go" }));
    assert.match(endError(events) ?? "", /after 2 model steps/);
    assert.equal(calls.length, 2);
    assert.equal(s.bodies.length, 2);
  } finally {
    await s.close();
  }
});

test("server errors and malformed streams end with a readable error", async () => {
  const s = await server([
    (_req, res) => { res.statusCode = 404; res.end("model not found"); },
    (_req, res) => { res.writeHead(200); res.end("data: {nope\n\n"); },
  ]);
  try {
    const a = await collect(loopSession(chatCompletionsClient(s.base), options([])).turn({ text: "x" }));
    assert.match(endError(a) ?? "", /404: model not found/);
    const b = await collect(loopSession(chatCompletionsClient(s.base), options([])).turn({ text: "x" }));
    assert.match(endError(b) ?? "", /malformed stream/);
  } finally {
    await s.close();
  }
});

test("redirects are refused, not followed", async () => {
  const s = await server([(_req, res) => { res.writeHead(307, { location: "https://example.com/v1/chat/completions" }); res.end(); }]);
  try {
    const events = await collect(loopSession(chatCompletionsClient(s.base), options([])).turn({ text: "x" }));
    assert.match(endError(events) ?? "", /redirect/);
    assert.equal(s.paths.length, 1);
  } finally {
    await s.close();
  }
});

test("images go as base64 data URLs", async () => {
  const s = await server([sse([delta({ content: "a cat" })])]);
  try {
    await collect(loopSession(chatCompletionsClient(s.base), options([])).turn({ text: "what", images: [{ mimeType: "image/png", data: "QUJD" }] }));
    assert.deepEqual(s.bodies[0].messages[1].content, [
      { type: "text", text: "what" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  } finally {
    await s.close();
  }
});

test("wire helpers validate names and strip prefixes", () => {
  const { action } = recorder();
  assert.throws(() => toWireActions([action, action]), /twice/);
  assert.throws(() => toWireActions([{ ...action, name: "bad name" }]), /valid function name/);
  assert.equal("$schema" in toWireActions([action])[0]!.parameters, false);
  assert.equal(bareName("dum__read_file", "dum__"), "read_file");
  assert.equal(bareName("read_file", "dum__"), null);
});

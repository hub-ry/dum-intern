import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { loopSession } from "../src/agent/loop.ts";
import { bareName, toWireActions } from "../src/agent/wire.ts";
import type { AgentEvent, DumAction, ModelClient, ModelStep, OpenOptions, WireAction, WireMessage } from "../src/agent/types.ts";

process.env.DUM_CONTEXT = "off";

type Request = { system: string; history: WireMessage[]; actions: WireAction[]; model: string; effort: string | null };
type Reply = ModelStep | ((signal: AbortSignal) => Promise<ModelStep>);

/** A scripted ModelClient: each step answers with the next reply and records what it was sent. */
function scripted(replies: Reply[]) {
  const requests: Request[] = [];
  const client: ModelClient = {
    async step(req) {
      requests.push({ system: req.system, history: structuredClone([...req.history]), actions: [...req.actions], model: req.model, effort: req.effort });
      const reply = replies.shift();
      if (!reply) return { text: "", calls: [], error: "no more replies" };
      return typeof reply === "function" ? reply(req.signal) : reply;
    },
  };
  return { client, requests };
}

const says = (text: string): ModelStep => ({ text, calls: [], error: null });
const calls = (name: string, args: unknown, id = "c"): ModelStep => ({ text: "", calls: [{ id, name, arguments: JSON.stringify(args) }], error: null });

function endError(events: AgentEvent[]): string | null {
  const end = events.at(-1);
  assert.equal(end?.type, "end");
  return end?.type === "end" ? end.error : null;
}

function options(actions: DumAction[], extra: Partial<OpenOptions> = {}): OpenOptions {
  return {
    cwd: "/tmp",
    systemPrompt: "You are Dum.",
    selector: { backend: "chatgpt", model: "m", effort: null },
    login: "chatgpt",
    actions,
    signal: new AbortController().signal,
    ...extra,
  };
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

test("streams text and sends the system prompt, the selector and the history", async () => {
  const s = scripted([says("Hello")]);
  const events = await collect(loopSession(s.client, options([])).turn({ text: "hi" }));
  assert.deepEqual(events, [
    { type: "model", model: "m", effort: null },
    { type: "text", text: "Hello" },
    { type: "end", error: null, interrupted: false },
  ]);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0], { system: "You are Dum.", history: [{ role: "user", text: "hi" }], actions: [], model: "m", effort: null });
});

test("runs the called action and continues with its result", async () => {
  const { action, calls: ran } = recorder();
  const s = scripted([calls("read_file", { path: "a/b.ts" }, "call_1"), says("Done.")]);
  const events = await collect(loopSession(s.client, options([action])).turn({ text: "read it" }));
  assert.deepEqual(events.map((e) => e.type), ["model", "action", "text", "end"]);
  assert.deepEqual(ran, [{ path: "a/b.ts" }]);
  assert.equal(s.requests[0]!.actions[0]?.name, "read_file");
  const params = s.requests[0]!.actions[0]!.parameters;
  assert.ok("required" in params);
  assert.deepEqual(params.required, ["path"]);
  assert.deepEqual(s.requests[1]!.history.slice(-2), [
    { role: "assistant", text: "", calls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"a/b.ts\"}" }] },
    { role: "tool", callId: "call_1", text: "file text", isError: false },
  ]);
});

test("an unknown action ends the session and runs nothing", async () => {
  const { action, calls: ran } = recorder();
  const s = scripted([calls("Bash", {})]);
  const session = loopSession(s.client, options([action]));
  const events = await collect(session.turn({ text: "go" }));
  const end = events.at(-1) as Extract<AgentEvent, { type: "end" }>;
  assert.match(end.error ?? "", /Bash.*isn't one of Dum's actions/);
  assert.equal(ran.length, 0);
  const again = await collect(session.turn({ text: "again" }));
  assert.deepEqual(again, [end]);
  assert.equal(s.requests.length, 1);
});

test("interrupt mid-step ends as interrupted", async () => {
  const stepping = Promise.withResolvers<void>();
  const s = scripted([(signal) => {
    stepping.resolve();
    const hung = Promise.withResolvers<ModelStep>();
    signal.addEventListener("abort", () => hung.reject(signal.reason), { once: true });
    return hung.promise;
  }]);
  const session = loopSession(s.client, options([]));
  const it = session.turn({ text: "go" })[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.type, "model");
  const next = it.next();
  await stepping.promise;
  await session.interrupt();
  assert.deepEqual((await next).value, { type: "end", error: null, interrupted: true });
  assert.equal((await it.next()).done, true);
});

test("maxTurns stops a model that keeps calling actions", async () => {
  const { action, calls: ran } = recorder();
  const call = calls("read_file", { path: "x" });
  const s = scripted([call, call, call]);
  const events = await collect(loopSession(s.client, options([action], { maxTurns: 2 })).turn({ text: "go" }));
  assert.match(endError(events) ?? "", /after 2 model steps/);
  assert.equal(ran.length, 2);
  assert.equal(s.requests.length, 2);
});

test("a step's error and unreadable arguments end with a readable error", async () => {
  const a = await collect(loopSession(scripted([{ text: "", calls: [], error: "The model server answered 404: model not found" }]).client, options([])).turn({ text: "x" }));
  assert.match(endError(a) ?? "", /404: model not found/);
  const { action } = recorder();
  const garbled = scripted([{ text: "", calls: [{ id: "c", name: "read_file", arguments: "{nope" }], error: null }]);
  const b = await collect(loopSession(garbled.client, options([action])).turn({ text: "x" }));
  assert.match(endError(b) ?? "", /unreadable arguments for read_file/);
});

test("pictures travel in the user's history entry", async () => {
  const s = scripted([says("a cat")]);
  const images = [{ mimeType: "image/png" as const, data: "QUJD" }];
  await collect(loopSession(s.client, options([])).turn({ text: "what", images }));
  assert.deepEqual(s.requests[0]!.history, [{ role: "user", text: "what", images }]);
});

test("wire helpers validate names and strip prefixes", () => {
  const { action } = recorder();
  assert.throws(() => toWireActions([action, action]), /twice/);
  assert.throws(() => toWireActions([{ ...action, name: "bad name" }]), /valid function name/);
  assert.equal("$schema" in toWireActions([action])[0]!.parameters, false);
  assert.equal(bareName("dum__read_file", "dum__"), "read_file");
  assert.equal(bareName("read_file", "dum__"), null);
});

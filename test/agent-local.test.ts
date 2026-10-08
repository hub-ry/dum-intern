import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { cloudTagged, localBackend, localSetup, loopbackBase } from "../src/agent/local.ts";
import type { AgentEvent, OpenOptions } from "../src/agent/types.ts";

process.env.DUM_CONTEXT = "off";

type Route = (body: { model?: string } | null, res: ServerResponse) => void;

async function fake(routes: Record<string, Route>) {
  const paths: string[] = [];
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    paths.push(`${req.method} ${req.url}`);
    const route = routes[req.url ?? ""];
    if (!route) { res.statusCode = 404; res.end(); return; }
    route(raw ? JSON.parse(raw) as { model?: string } : null, res);
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const close = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    srv.closeAllConnections();
    srv.close(() => resolve());
    return promise;
  };
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, paths, close };
}

const json = (data: unknown): Route => (_b, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };

const SHOW: Record<string, string[]> = {
  "qwen3:8b": ["completion", "tools", "thinking"],
  "llava:7b": ["completion", "vision"],
};

function ollamaRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/api/tags": json({ models: [
      { name: "qwen3:8b" }, { name: "llava:7b" }, { name: "gpt-oss:120b-cloud" }, { name: "gemma4:cloud" },
      { name: "sneaky:latest", remote_host: "https://ollama.com" },
    ] }),
    "/api/show": (body, res) => json({ capabilities: SHOW[body?.model ?? ""] ?? ["completion"] })(body, res),
    ...extra,
  };
}

const lmRoutes: Record<string, Route> = {
  "/api/v0/models": json({ data: [
    { id: "qwen/qwen3-vl", type: "vlm", capabilities: ["tool_use"] },
    { id: "plain-llm", type: "llm" },
    { id: "nomic-embed", type: "embeddings" },
  ] }),
};

// A port nothing listens on.
async function deadBase() {
  const s = await fake({});
  await s.close();
  return s.base;
}

function options(model: string, extra: Partial<OpenOptions> = {}): OpenOptions {
  return {
    cwd: "/tmp",
    zone: { id: "z1", revision: 1, breadcrumb: [], goal: "", ancestorGoals: [], language: "", focusSkills: [], notes: [] },
    binding: { zoneId: "z1", zoneEpoch: "e", inputToken: "t", requestId: "r" },
    systemPrompt: "sys",
    selector: { backend: "local", model, effort: null },
    login: "none",
    actions: [],
    signal: new AbortController().signal,
    ...extra,
  } as OpenOptions;
}

test("only loopback endpoints are accepted", () => {
  assert.throws(() => loopbackBase("http://192.168.1.4:11434"), /could not be verified/);
  assert.throws(() => loopbackBase("http://localhost:11434"), /could not be verified/);
  assert.throws(() => loopbackBase("https://127.0.0.1:1234"), /could not be verified/);
  assert.equal(loopbackBase("http://[::1]:1234").port, "1234");
  assert.throws(() => localBackend({ ollama: "http://ollama.example.com", lmstudio: "http://127.0.0.1:1234" }), /loopback/);
  assert.throws(() => localSetup({ ollama: "http://127.0.0.1:11434", lmstudio: "http://10.0.0.1:1234" }), /loopback/);
});

test("cloud tags are recognized", () => {
  assert.equal(cloudTagged("gemma4:cloud"), true);
  assert.equal(cloudTagged("gpt-oss:120b-cloud"), true);
  assert.equal(cloudTagged("qwen3:8b"), false);
  assert.equal(cloudTagged("cloudy:latest"), false);
});

test("catalog reports capabilities, drops cloud models, and keeps LM Studio text-only", async () => {
  const o = await fake(ollamaRoutes());
  const l = await fake(lmRoutes);
  try {
    const backend = localBackend({ ollama: o.base, lmstudio: l.base });
    const models = await backend.models("none", new AbortController().signal);
    assert.deepEqual(models.map((m) => [m.id, m.actions, m.images, m.efforts]), [
      ["ollama/qwen3:8b", true, false, ["low", "medium", "high"]],
      ["ollama/llava:7b", false, true, []],
      ["lmstudio/qwen/qwen3-vl", true, false, []],
      ["lmstudio/plain-llm", false, false, []],
    ]);
    assert.equal(backend.capabilities({ backend: "local", model: "ollama/llava:7b", effort: null }).images, true);
    assert.equal(backend.capabilities({ backend: "local", model: "lmstudio/qwen/qwen3-vl", effort: null }).images, false);
    assert.equal(o.paths.some((p) => p.includes("cloud") || p.includes("sneaky")), false);
    await assert.rejects(backend.models("chatgpt", new AbortController().signal), /no sign-in/);
  } finally {
    await o.close();
    await l.close();
  }
});

test("open refuses cloud, missing, action-less and wrong-effort models", async () => {
  const o = await fake(ollamaRoutes());
  try {
    const backend = localBackend({ ollama: o.base, lmstudio: await deadBase() });
    const action = { name: "a", description: "", schema: {}, call: async () => ({ text: "" }) };
    await assert.rejects(backend.open(options("ollama/gemma4:cloud")), /stays on this Mac/);
    await assert.rejects(backend.open(options("ollama/sneaky:latest")), /stays on this Mac/);
    await assert.rejects(backend.open(options("ollama/llava:7b", { actions: [action] })), /only be a helper/);
    await assert.rejects(backend.open(options("ollama/qwen3:8b", { selector: { backend: "local", model: "ollama/qwen3:8b", effort: "max" } })), /effort max/);
    await assert.rejects(backend.open(options("ollama/qwen3:8b", { login: "chatgpt" })), /no sign-in/);
    await assert.rejects(backend.open(options("lmstudio/plain-llm")), /LM Studio isn't running/);
    assert.equal(o.paths.some((p) => p.includes("/v1/")), false);
  } finally {
    await o.close();
  }
});

test("a redirecting endpoint is refused without following it", async () => {
  let followed = false;
  const target = await fake({ "/api/tags": (_b, res) => { followed = true; json({ models: [] })(_b, res); } });
  const o = await fake({ "/api/tags": (_b, res) => { res.writeHead(302, { location: `${target.base}/api/tags` }); res.end(); } });
  try {
    const backend = localBackend({ ollama: o.base, lmstudio: await deadBase() });
    await assert.rejects(backend.models("none", new AbortController().signal), /could not be verified: it tried to redirect/);
    assert.equal(followed, false);
    const status = await localSetup({ ollama: o.base, lmstudio: await deadBase() }).status();
    assert.equal(status.ready, null);
    assert.match(status.message, /could not be verified/);
  } finally {
    await o.close();
    await target.close();
  }
});

test("sessions talk only to /v1/chat/completions; LM Studio refuses pictures", async () => {
  const sse: Route = (_b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`);
  };
  const l = await fake({ ...lmRoutes, "/v1/chat/completions": sse });
  try {
    const backend = localBackend({ ollama: await deadBase(), lmstudio: l.base });
    const session = await backend.open(options("lmstudio/qwen/qwen3-vl"));
    const events: AgentEvent[] = [];
    for await (const e of session.turn({ text: "hello" })) events.push(e);
    assert.deepEqual(events.at(-1), { type: "end", error: null, interrupted: false });
    assert.ok(events.some((e) => e.type === "text" && e.text === "hi"));
    const pictured: AgentEvent[] = [];
    for await (const e of session.turn({ text: "look", images: [{ mimeType: "image/png", data: "QQ==" }] })) pictured.push(e);
    assert.deepEqual(pictured, [{ type: "end", error: "The selected local model cannot see pictures", interrupted: false }]);
    session.close();
    assert.deepEqual(l.paths, ["GET /api/v0/models", "POST /v1/chat/completions"]);
    assert.equal(l.paths.some((p) => p.includes("/v1/responses") || p.includes("/api/v1/chat")), false);
  } finally {
    await l.close();
  }
});

test("setup status counts models per server and needs no sign-in", async () => {
  const o = await fake(ollamaRoutes());
  try {
    const setup = localSetup({ ollama: o.base, lmstudio: await deadBase() });
    const status = await setup.status();
    assert.deepEqual([status.installed, status.ready, status.message], [true, "none", "Ollama · 2 models"]);
    const stopped = await localSetup({ ollama: await deadBase(), lmstudio: await deadBase() }).status();
    assert.deepEqual([stopped.installed, stopped.ready], [false, null]);
    assert.match(stopped.message, /Not running/);
    let changed = 0;
    await setup.login("none", { openUrl: async () => undefined, changed: () => { changed++; } });
    assert.equal(changed, 1);
    await assert.rejects(setup.login("anthropic-key", { openUrl: async () => undefined, changed: () => undefined }), /no sign-in/);
  } finally {
    await o.close();
  }
});

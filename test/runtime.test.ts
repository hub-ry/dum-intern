import { test } from "node:test";
import assert from "node:assert/strict";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { MODELS, assertProvider, assertSubscription, closed, start, subscriptionEnv } from "../src/runtime.ts";
import { oneShot, type Query } from "../src/oneshot.ts";

const signal = new AbortController().signal;
const PUBLIC_OPTIONS = closed({ cwd: "/tmp", systemPrompt: "fixed public contract", ...MODELS.helper });

test("an unverified model selector is refused instead of falling back", () => {
  assert.throws(() => closed({ cwd: "/tmp", systemPrompt: "", model: "claude-sonnet-5-5", effort: "medium" }), /verified/);
  assert.throws(() => closed({ cwd: "/tmp", systemPrompt: "", model: "gemini-3-pro", effort: "high" }), /verified/);
});

test("the subscription environment drops paid keys, provider routes and model overrides", () => {
  const env = subscriptionEnv({
    PATH: "/bin",
    HOME: "/home/u",
    CLAUDE_CONFIG_DIR: "/home/u/.claude",
    ANTHROPIC_API_KEY: "sk-paid",
    ANTHROPIC_AUTH_TOKEN: "t",
    ANTHROPIC_BASE_URL: "https://proxy",
    ANTHROPIC_MODEL: "other",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    GEMINI_API_KEY: "g",
    GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
    OPENAI_API_KEY: "o",
    CLOUD_ML_REGION: "us",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
});

test("only tools served by dum's registered in-process servers are allowed", async () => {
  const fakeServer = {} as NonNullable<Options["mcpServers"]>[string];
  const o = closed({ cwd: "/tmp", systemPrompt: "", ...MODELS.dum, mcp: { dum: fakeServer as never } });
  const ask = o.canUseTool!;
  assert.equal((await ask("mcp__dum__read_file", { path: "a" }, { signal, mcpServer: { name: "dum", source: "sdk" } }))?.behavior, "allow");
  assert.equal((await ask("Bash", { command: "cat ~/.ssh/id_rsa" }, { signal }))?.behavior, "deny");
  assert.equal((await ask("WebFetch", { url: "https://x" }, { signal }))?.behavior, "deny");
  assert.equal((await ask("mcp__dum__read_file", {}, { signal, mcpServer: { name: "dum", source: "user" } }))?.behavior, "deny", "a configured server can't pose as dum");
  assert.equal((await ask("mcp__pencil__draw", {}, { signal, mcpServer: { name: "pencil", source: "sdk" } }))?.behavior, "deny");
});

test("a session that isn't the subscription login or has extra tools is refused", async () => {
  const good = { apiKeySource: "none" as const, tools: ["mcp__dum__ask"], mcp_servers: [{ name: "dum", status: "connected", source: "sdk" }], plugins: [] };
  assertSubscription(good);
  assert.throws(() => assertSubscription({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }), /API key/);
  assert.throws(() => assertSubscription({ ...good, tools: [...good.tools, "Bash"] }), /Bash/);
  assert.throws(() => assertSubscription({ ...good, mcp_servers: [...good.mcp_servers, { name: "pencil", status: "connected", source: "user" }] }), /pencil/);
  assert.throws(() => assertSubscription({ ...good, plugins: [{ name: "lsp" }] }), /plugins/);
  assert.throws(() => assertSubscription(good, []), /mcp__dum__ask/);

  await assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none", email: "private@example.com" }) });
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "vertex" }) }), /vertex/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({}) }), /unknown/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }) }), /API key/);
  const err = await assertProvider({ accountInfo: async () => ({ apiProvider: "bedrock", email: "private@example.com" }) }).catch((e: Error) => e);
  assert.doesNotMatch(String(err), /private@example\.com/, "account details are never printed");
  await assert.rejects(assertProvider({ accountInfo: () => new Promise(() => {}) }, 20), /in time/);
});

type Msg = Record<string, unknown>;

function fake(messages: Msg[]) {
  return (() => {
    async function* run() { for (const m of messages) yield m; }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) });
  }) as unknown as Query;
}

const init = { type: "system", subtype: "init", apiKeySource: "none", tools: [], mcp_servers: [], plugins: [] };

test("oneShot refuses unexpected access and surfaces route and model failures", async () => {
  await assert.rejects(oneShot("hi", MODELS.helper, fake([{ ...init, apiKeySource: "ANTHROPIC_API_KEY" }, { type: "result", subtype: "success", is_error: false, result: "x" }])), /API key/);
  await assert.rejects(oneShot("hi", MODELS.helper, fake([{ ...init, tools: ["WebSearch"] }])), /WebSearch/);
  await assert.rejects(oneShot("hi", MODELS.helper, fake([init, { type: "result", subtype: "success", is_error: true, result: "model not found" }])), /model not found/);
  await assert.rejects(oneShot("hi", MODELS.helper, fake([init])), /without an answer/);
  await assert.rejects(oneShot("hi", { model: "claude-sonnet-5-5", effort: "medium" }, fake([])), /verified/);
});

test("an incomplete SDK handshake needs positive OAuth provenance, never a paid or unknown login", async () => {
  const q = { accountInfo: async () => ({ apiProvider: "firstParty" }) };
  await assertProvider(q, 20, () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
  for (const login of [
    {},
    { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "gateway" },
  ]) {
    await assert.rejects(assertProvider(q, 20, () => login), /subscription/);
  }
});

test("private user input is withheld until login checks pass, and discarded when they fail", async () => {
  for (const allowed of [false, true]) {
    let forward = 0;
    let closed = false;
    const { promise: account, resolve: finish } = Promise.withResolvers<{ apiProvider: string; apiKeySource: string }>();
    let delivery!: Promise<IteratorResult<unknown>>;
    const run = (({ prompt }: Parameters<Query>[0]) => {
      delivery = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      async function* replies() {}
      return Object.assign(replies(), { close() { closed = true; }, accountInfo: () => account });
    }) as unknown as Query;
    async function* personal() {
      forward++;
      yield { type: "user" as const, message: { role: "user" as const, content: "private context" }, parent_tool_use_id: null, session_id: "" };
    }
    const opening = start(personal(), PUBLIC_OPTIONS, run, async () => ({ effective: {}, provenance: {}, sources: [] }));
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    assert.equal(forward, 0, "the SDK cannot consume personal context while auth is pending");
    finish({ apiProvider: allowed ? "firstParty" : "bedrock", apiKeySource: "none" });
    if (allowed) {
      const session = await opening;
      assert.equal((await delivery).done, false);
      assert.equal(forward, 1);
      session.close();
    } else {
      await assert.rejects(opening, /bedrock/);
      assert.equal((await delivery).done, true);
      assert.equal(forward, 0);
      assert.equal(closed, true);
    }
  }
});

test("managed hooks or routing are refused before starting a Claude process", async () => {
  let started = false;
  const run = (() => { started = true; throw new Error("should not start"); }) as Query;
  await assert.rejects(start("private context", PUBLIC_OPTIONS, run, async () => ({
    effective: { hooks: {} }, provenance: {}, sources: [{ source: "managed", settings: { hooks: {} } }],
  })), /managed policy/);
  assert.equal(started, false);
});

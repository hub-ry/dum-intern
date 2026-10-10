import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32, inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { z } from "zod";
import { setImmediate } from "node:timers/promises";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_DEFAULTS } from "../src/agent/schema.ts";
import {
  CLAUDE_VERIFIED,
  PROBE_PNG,
  PROBE_TEXT,
  VERIFIED_FILE,
  assertInit,
  assertProvider,
  catalog,
  claudeBackend,
  claudeEnv,
  closed,
  failure,
  noImages,
  readVerified,
  retryStatus,
  start,
  verified,
  type Sdk,
} from "../src/agent/claude.ts";
import { FLAGS, authStatus, cliArgs, providerFreeEnv } from "../src/agent/claude-cli.ts";
import type { AgentEvent, DumAction, OpenOptions } from "../src/agent/types.ts";

process.env.DUM_CONTEXT = "off";
const signal = new AbortController().signal;
const noAuth = async () => { throw new Error("auth status should not run"); };

function options(over: Partial<Parameters<typeof closed>[0]> = {}): Options {
  return closed({
    executable: "/opt/claude", cwd: "/tmp", systemPrompt: "fixed", selector: CLAUDE_DEFAULTS.helper,
    env: {}, actions: [], abortController: new AbortController(), ...over,
  });
}

const action: DumAction = {
  name: "ask",
  description: "ask them",
  schema: { question: z.string() },
  async call() { return { text: "ok" }; },
};

test("closed sessions have no built-in tools, no setting files, safe mode and auto-memory off", () => {
  const o = options();
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.skills, []);
  assert.deepEqual(o.plugins, []);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.extraArgs, { "safe-mode": null });
  assert.equal(o.settings, FLAGS);
  assert.equal((o.settings as typeof FLAGS).autoMemoryEnabled, false);
  assert.equal((o.settings as typeof FLAGS).disableAllHooks, true);
  assert.equal(o.pathToClaudeCodeExecutable, "/opt/claude");
  assert.equal(o.model, "fable");
  assert.equal(o.effort, "high");
  assert.deepEqual(JSON.parse(cliArgs("auth", "status")[4]), FLAGS);
  assert.deepEqual(cliArgs("auth", "status").slice(0, 3), ["--safe-mode", "--setting-sources", ""]);
  assert.throws(() => options({ actions: [action, action] }), /twice/);
  assert.deepEqual(Object.keys(options({ actions: [action] }).mcpServers ?? {}), ["dum"]);
});

test("only Dum's own actions from Dum's in-process server are allowed", async () => {
  const ask = options({ actions: [action] }).canUseTool!;
  assert.equal((await ask("mcp__dum__ask", {}, { signal, toolUseID: "1", mcpServer: { name: "dum", source: "sdk" } } as never))?.behavior, "allow");
  assert.equal((await ask("mcp__dum__read_file", {}, { signal, toolUseID: "1", mcpServer: { name: "dum", source: "sdk" } } as never))?.behavior, "deny", "an action not listed for this session");
  assert.equal((await ask("Bash", { command: "cat ~/.ssh/id_rsa" }, { signal, toolUseID: "1" } as never))?.behavior, "deny");
  assert.equal((await ask("mcp__dum__ask", {}, { signal, toolUseID: "1", mcpServer: { name: "dum", source: "user" } } as never))?.behavior, "deny", "a configured server can't pose as Dum");
});

test("the Claude env drops inherited routes and keys, turns auto-memory off, and carries only Dum's stored key", () => {
  const inherited = {
    PATH: "/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/home/u/.claude",
    ANTHROPIC_API_KEY: "sk-shell", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy", ANTHROPIC_MODEL: "other",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_BEDROCK: "1", GEMINI_API_KEY: "g", GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
    OPENAI_API_KEY: "o", CLOUD_ML_REGION: "us",
  };
  assert.deepEqual(Object.keys(providerFreeEnv(inherited)).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  const key = claudeEnv(inherited, "sk-dum");
  assert.deepEqual(Object.keys(key).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  assert.equal(key.ANTHROPIC_API_KEY, "sk-dum", "Dum's stored key, never the shell's");
  assert.equal(key.ANTHROPIC_BASE_URL, undefined);
  assert.equal(key.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(inherited.ANTHROPIC_API_KEY, "sk-shell", "the base env is not changed");
});

test("init must report the user's API key and nothing beyond Dum's actions", () => {
  const good = { tools: ["mcp__dum__ask"], mcp_servers: [{ name: "dum", status: "connected", source: "sdk" }], plugins: [] };
  assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }, ["ask"]);
  assertInit({ apiKeySource: "ANTHROPIC_API_KEY", tools: [], mcp_servers: [], plugins: [] }, []);
  assert.throws(() => assertInit({ ...good, apiKeySource: "none" }, ["ask"]), /API key/, "a subscription login is refused");
  assert.throws(() => assertInit({ ...good, apiKeySource: "/login managed key" }, ["ask"]), /API key/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", tools: [...good.tools, "Bash"] }, ["ask"]), /Bash/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", tools: ["mcp__dum__write"] }, ["ask"]), /mcp__dum__write/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", mcp_servers: [...good.mcp_servers, { name: "pencil", status: "connected", source: "user" }] }, ["ask"]), /pencil/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", mcp_servers: [{ name: "dum", status: "connected", source: "user" }] }, ["ask"]), /dum/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", plugins: [{ name: "lsp" }] }, ["ask"]), /plugins/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }, []), /mcp__dum__ask/);
});

test("the handshake proves the user's API key on the first-party route, never a subscription login", async () => {
  await assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }) }, noAuth);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) }, noAuth), /API key/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "vertex" }) }, noAuth), /vertex/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({}) }, noAuth), /unknown/);
  const err = await assertProvider({ accountInfo: async () => ({ apiProvider: "bedrock", email: "private@example.com" }) }, noAuth).catch((e: Error) => e);
  assert.doesNotMatch(String(err), /private@example\.com/, "account details are never printed");
  await assert.rejects(assertProvider({ accountInfo: () => new Promise(() => {}) }, noAuth, 20), /in time/);

  // Before auth resolves, the SDK reports only the route; the CLI's status must say API key.
  const early = { accountInfo: async () => ({ apiProvider: "firstParty" as const }) };
  await assertProvider(early, async () => ({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }));
  for (const login of [{}, { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, { loggedIn: false, authMethod: "api_key", apiProvider: "firstParty" }, { loggedIn: true, authMethod: "api_key", apiProvider: "gateway" }]) {
    await assert.rejects(assertProvider(early, async () => login), /API key/);
  }
  await assert.rejects(assertProvider(early, () => Promise.reject(new Error("Claude couldn't report how it's signed in"))), /couldn't report/);
  await assert.rejects(assertProvider(early, () => new Promise(() => {}), 20), /in time/, "a hung status check fails closed");
});

type Efforts = ("low" | "medium" | "high" | "xhigh" | "max")[];
const ALL: Efforts = ["low", "medium", "high", "xhigh", "max"];
/** Shaped like Claude's real catalog: aliases that resolve to full ids, plus a full id listed as itself. */
const MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "claude-opus-4-1", displayName: "Opus 4.1", description: "", supportsEffort: false },
];

test("Dum's defaults are ids a catalog shaped like the real one lists, at efforts it advertises", () => {
  const listed = catalog(MODELS);
  for (const role of ["intern", "helper", "look"] as const) {
    const selector = CLAUDE_DEFAULTS[role];
    const row = listed.find((m) => m.id === selector.model);
    assert.ok(row, `${role}: ${selector.model} is listed`);
    assert.ok(row.efforts.includes(selector.effort), `${role}: ${selector.effort} is advertised`);
  }
  assert.equal(listed.find((m) => m.id === CLAUDE_DEFAULTS.intern.model)?.resolved, "claude-opus-5-5");
  assert.equal(listed.find((m) => m.id === CLAUDE_DEFAULTS.helper.model)?.resolved, "claude-fable-5-1");
  assert.equal(listed.find((m) => m.id === CLAUDE_DEFAULTS.look.model)?.resolved, "claude-haiku-5-5");
});

test("the catalog keeps each row's resolved model and marks verified by it, never by alias", () => {
  const listed = catalog(MODELS);
  assert.deepEqual(listed.map((m) => [m.id, m.resolved, m.efforts.length, m.images]), [
    ["default", "claude-opus-5-5", 5, true],
    ["opus", "claude-opus-5-5", 5, true],
    ["fable", "claude-fable-5-1", 5, true],
    ["sonnet", "claude-sonnet-5-5", 5, true],
    ["haiku", "claude-haiku-5-5", 5, true],
    ["claude-opus-4-1", "claude-opus-4-1", 0, true],
  ]);
  for (const m of listed) assert.equal(m.verified, Object.hasOwn(CLAUDE_VERIFIED, m.resolved), m.id);
  assert.equal(Object.hasOwn(CLAUDE_VERIFIED, "opus"), false, "verification is never keyed on an alias");
  assert.equal(noImages(CLAUDE_DEFAULTS.intern, "claude-opus-5-5"), "");
  assert.equal(noImages(CLAUDE_DEFAULTS.intern, "claude-opus-9-9"), "opus changed to claude-opus-9-9, which isn't verified for pictures yet");
  assert.equal(noImages({ backend: "claude", model: "claude-opus-4-1", effort: null }, "claude-opus-4-1"), "claude-opus-4-1 isn't verified for pictures yet");
});

type Msg = Record<string, unknown>;

/** A fake SDK: records options and prompt delivery, replays `replies` once input arrives. */
function fakeSdk(o: { account?: Record<string, unknown>; replies?: (input: SDKUserMessage) => Msg[]; managed?: boolean; models?: () => readonly Record<string, unknown>[] }) {
  const seen = { options: [] as Options[], inputs: [] as SDKUserMessage[], closed: 0, started: 0 };
  const sdk: Sdk = {
    resolveSettings: (async () => ({ effective: {}, provenance: {}, sources: o.managed ? [{ source: "managed", settings: { hooks: {} } }] : [] })) as unknown as Sdk["resolveSettings"],
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      seen.started++;
      seen.options.push(options);
      async function* replies() {
        for await (const input of prompt) {
          seen.inputs.push(input);
          for (const m of o.replies?.(input) ?? []) yield m;
        }
      }
      return Object.assign(replies(), {
        close() { seen.closed++; },
        async interrupt() {},
        accountInfo: async () => o.account ?? { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" },
        supportedModels: async () => o.models?.() ?? MODELS,
      });
    }) as unknown as Sdk["query"],
  };
  return { sdk, seen };
}

test("private input is withheld until provenance passes, and discarded when it fails", async () => {
  for (const allowed of [false, true]) {
    let forward = 0;
    const { promise: account, resolve: finish } = Promise.withResolvers<{ apiProvider: string; apiKeySource: string }>();
    let delivery!: Promise<IteratorResult<unknown>>;
    let closedCount = 0;
    const sdk: Sdk = {
      resolveSettings: (async () => ({ effective: {}, provenance: {}, sources: [] })) as unknown as Sdk["resolveSettings"],
      query: (({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        delivery = prompt[Symbol.asyncIterator]().next();
        async function* replies() {}
        return Object.assign(replies(), { close() { closedCount++; }, accountInfo: () => account, supportedModels: async () => MODELS });
      }) as unknown as Sdk["query"],
    };
    async function* personal(): AsyncGenerator<SDKUserMessage> {
      forward++;
      yield { type: "user", message: { role: "user", content: "private context" }, parent_tool_use_id: null };
    }
    const opening = start(personal(), options(), { login: "anthropic-key", selector: CLAUDE_DEFAULTS.helper, auth: noAuth, sdk });
    await setImmediate();
    assert.equal(forward, 0, "the SDK cannot consume personal context while provenance is pending");
    finish({ apiProvider: allowed ? "firstParty" : "bedrock", apiKeySource: "ANTHROPIC_API_KEY" });
    if (allowed) {
      const session = await opening;
      assert.equal((await delivery).done, false);
      assert.equal(forward, 1);
      session.close();
    } else {
      await assert.rejects(opening, /bedrock/);
      assert.equal((await delivery).done, true);
      assert.equal(forward, 0);
      assert.equal(closedCount, 1);
    }
  }
});

test("a selector missing from the live catalog or without its effort is refused before input", async () => {
  async function* none(): AsyncGenerator<SDKUserMessage> {}
  for (const selector of [{ ...CLAUDE_DEFAULTS.helper, model: "claude-gone-1" }, { ...CLAUDE_DEFAULTS.helper, effort: "turbo" }, { ...CLAUDE_DEFAULTS.helper, effort: null }]) {
    const { sdk, seen } = fakeSdk({});
    await assert.rejects(start(none(), options(), { login: "anthropic-key", selector, auth: noAuth, sdk }), /doesn't/);
    assert.equal(seen.closed, 1);
  }
});

test("managed policy is refused before a Claude process starts", async () => {
  const { sdk, seen } = fakeSdk({ managed: true });
  async function* none(): AsyncGenerator<SDKUserMessage> {}
  await assert.rejects(start(none(), options(), { login: "anthropic-key", selector: null, auth: noAuth, sdk }), /managed policy/);
  assert.equal(seen.started, 0);
});

test("aborting while Claude starts closes it and releases nothing", async () => {
  const abortController = new AbortController();
  let closedCount = 0;
  let delivery!: Promise<IteratorResult<unknown>>;
  const sdk: Sdk = {
    resolveSettings: (async () => ({ effective: {}, provenance: {}, sources: [] })) as unknown as Sdk["resolveSettings"],
    query: (({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      delivery = prompt[Symbol.asyncIterator]().next();
      async function* replies() {}
      return Object.assign(replies(), { close() { closedCount++; }, accountInfo: () => new Promise(() => {}), supportedModels: async () => MODELS });
    }) as unknown as Sdk["query"],
  };
  async function* personal(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: "private" }, parent_tool_use_id: null };
  }
  const opening = start(personal(), options({ abortController }), { login: "anthropic-key", selector: null, auth: noAuth, sdk });
  await setImmediate();
  abortController.abort();
  await assert.rejects(opening, /stopped before Claude finished starting/);
  assert.equal(closedCount, 1);
  assert.equal((await delivery).done, true);
});

function openOptions(over: Partial<OpenOptions> = {}): OpenOptions {
  return {
    cwd: "/tmp", systemPrompt: "fixed", selector: CLAUDE_DEFAULTS.intern,
    login: "anthropic-key", actions: [action], signal, ...over,
  };
}
const init = { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY", model: "claude-opus-5-5", tools: ["mcp__dum__ask"], mcp_servers: [{ name: "dum", status: "connected", source: "sdk" }], plugins: [] };

async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("a key-mode session gets the key in its own env only and maps SDK events to agent events", async () => {
  const { sdk, seen } = fakeSdk({
    replies: () => [
      init,
      { type: "system", subtype: "api_retry", error_status: 529, error: "overloaded", retry_delay_ms: 1500 },
      { type: "assistant", message: { content: [{ type: "text", text: " hello " }, { type: "tool_use", name: "mcp__dum__ask", id: "t", input: {} }] } },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ],
  });
  const asked: string[] = [];
  const backend = claudeBackend({
    executable: "/opt/claude", sdk,
    credential: async (need) => { asked.push(need); return { value: "sk-dum", expiresAt: null }; },
  });
  const before = process.env.ANTHROPIC_API_KEY;
  const session = await backend.open(openOptions());
  assert.deepEqual(asked, ["anthropic-key"]);
  assert.equal(seen.options[0].env?.ANTHROPIC_API_KEY, "sk-dum");
  assert.equal(seen.options[0].env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(process.env.ANTHROPIC_API_KEY, before, "the key never enters the host's own env");
  assert.deepEqual(await drain(session.turn({ text: "hi" })), [
    { type: "model", model: "claude-opus-5-5", effort: "high" },
    { type: "retry", message: "Claude API 529 (overloaded) - retrying in 2s" },
    { type: "text", text: "hello" },
    { type: "action", name: "ask" },
    { type: "end", error: null, interrupted: false },
  ]);
  assert.equal(seen.inputs.length, 1);
  session.close();
  assert.equal(seen.closed, 1);
});

test("a foreign action or a mismatched init ends the session and the turn", async () => {
  for (const reply of [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "t", input: {} }] } },
    { ...init, apiKeySource: "none" },
    { ...init, tools: ["mcp__dum__ask", "WebFetch"] },
    { ...init, plugins: [{ name: "lsp", path: "/x" }] },
  ]) {
    const { sdk, seen } = fakeSdk({ replies: () => [reply.type === "assistant" ? init : reply, reply, { type: "result", subtype: "success" }] });
    const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
    const session = await backend.open(openOptions());
    await assert.rejects(drain(session.turn({ text: "hi" })), /Bash|API key|WebFetch|plugins/);
    assert.equal(seen.closed, 1);
    await assert.rejects(drain(session.turn({ text: "again" })), /closed/);
  }
});

test("Claude takes only the user's API key: any other login, or no key, is refused before starting", async () => {
  const { sdk, seen } = fakeSdk({});
  const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => null });
  await assert.rejects(backend.open(openOptions({ login: "chatgpt" })), /doesn't sign in with chatgpt/);
  await assert.rejects(backend.models("none", signal), /doesn't sign in with none/);
  await assert.rejects(backend.open(openOptions({ login: "claude-subscription" as never })), /doesn't sign in with claude-subscription/);
  await assert.rejects(backend.open(openOptions()), /Add your Anthropic API key/);
  assert.equal(seen.started, 0);
});

const picture = { mimeType: "image/png" as const, data: "AAAA" };
const lookInit = { ...init, tools: [], mcp_servers: [], model: "claude-haiku-5-5" };

test("models reads the live catalog after provenance; pictures go only to a verified resolved model", async () => {
  const { sdk, seen } = fakeSdk({});
  const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
  const models = await backend.models("anthropic-key", signal);
  assert.deepEqual(models.map((m) => m.id), ["default", "opus", "fable", "sonnet", "haiku", "claude-opus-4-1"]);
  assert.equal(seen.inputs.length, 0, "a catalog query sends no turn");
  assert.equal(seen.closed, 1);
  const intern = await backend.capabilities(CLAUDE_DEFAULTS.intern, "anthropic-key", signal);
  assert.deepEqual([intern.model, intern.images, intern.noImages, intern.runtimeActionCheck], ["claude-opus-5-5", true, "", true]);
  const sonnet = await backend.capabilities({ backend: "claude", model: "sonnet", effort: "low" }, "anthropic-key", signal);
  assert.deepEqual([sonnet.model, sonnet.images, sonnet.noImages], ["claude-sonnet-5-5", false, "sonnet changed to claude-sonnet-5-5, which isn't verified for pictures yet"]);
  const gone = await backend.capabilities({ backend: "claude", model: "claude-gone-1", effort: null }, "anthropic-key", signal);
  assert.equal(gone.images, false);
  assert.equal(seen.started, 1, "capabilities reuse the catalog Claude last listed");

  const session = await backend.open(openOptions({ selector: { backend: "claude", model: "sonnet", effort: "low" } }));
  await assert.rejects(drain(session.turn({ text: "look", images: [picture] })), /claude-sonnet-5-5, which isn't verified for pictures yet/);
  assert.equal(seen.inputs.length, 0, "the picture never reached Claude");
  session.close();
});

test("an alias that moves to an unverified model keeps running but gets no pictures, and says so", async () => {
  // The alias first resolves to a verified model, then moves to one that isn't.
  let target = "claude-opus-5-5";
  const models = () => MODELS.map((m) => (m.value === "haiku" ? { ...m, resolvedModel: target } : m));
  const { sdk, seen } = fakeSdk({
    models,
    replies: () => [{ ...lookInit, model: target }, { type: "assistant", message: { content: [{ type: "text", text: "{}" }] } }, { type: "result", subtype: "success" }],
  });
  const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
  const look = { ...openOptions({ selector: CLAUDE_DEFAULTS.look, actions: [] }) };

  const before = await backend.open(look);
  const events = await drain(before.turn({ text: "look", images: [picture] }));
  assert.deepEqual(events[0], { type: "model", model: target, effort: "low" }, "the session reports the model it resolved to");
  assert.equal(seen.inputs.length, 1, "a verified resolved model gets the picture");
  before.close();

  target = "claude-haiku-9-9";
  const caps = await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal);
  assert.equal(caps.images, true, "until a handshake sees the move, the last listing stands");
  const moved = await backend.open(look);
  await assert.rejects(drain(moved.turn({ text: "look", images: [picture] })), /haiku changed to claude-haiku-9-9, which isn't verified for pictures yet/);
  assert.equal(seen.inputs.length, 1, "no picture went to the unverified model");
  const after = await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal);
  assert.deepEqual([after.model, after.images, after.noImages], ["claude-haiku-9-9", false, "haiku changed to claude-haiku-9-9, which isn't verified for pictures yet"]);
  const text = await backend.open(look);
  assert.deepEqual((await drain(text.turn({ text: "look" }))).at(-1), { type: "end", error: null, interrupted: false }, "the session still runs on text");
  text.close();
});

test("pictures sent for one resolved model never reach another: a mismatched init stops the turn", async () => {
  const { sdk } = fakeSdk({ replies: () => [{ ...lookInit, model: "claude-opus-9-9" }, { type: "result", subtype: "success" }] });
  const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
  const session = await backend.open(openOptions({ selector: CLAUDE_DEFAULTS.intern, actions: [] }));
  await assert.rejects(drain(session.turn({ text: "look", images: [picture] })), /Claude ran claude-opus-9-9, not claude-opus-5-5/);
});

/** A throwaway H for the verified-models record. */
function home(): string {
  return mkdtempSync(`${tmpdir()}/dum-verified-`);
}

test("an id this install verified is read from verified-models.json: the catalog marks it and pictures are allowed", async () => {
  const proven = new Set(["claude-haiku-5-5"]);
  assert.equal(verified("claude-haiku-5-5", proven), true);
  assert.equal(verified("claude-haiku-5-5"), false);
  assert.equal(catalog(MODELS, proven).find((m) => m.id === "haiku")?.verified, true);
  assert.equal(noImages(CLAUDE_DEFAULTS.look, "claude-haiku-5-5", proven), "");
  const h = home();
  try {
    writeFileSync(`${h}/${VERIFIED_FILE}`, JSON.stringify({ claude: ["claude-haiku-5-5"] }));
    const { sdk } = fakeSdk({});
    const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }), home: h });
    const models = await backend.models("anthropic-key", signal);
    assert.deepEqual(models.filter((m) => m.verified).map((m) => m.id), ["default", "opus", "fable", "haiku"]);
    const caps = await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal);
    assert.deepEqual([caps.model, caps.images, caps.noImages], ["claude-haiku-5-5", true, ""]);
    writeFileSync(`${h}/${VERIFIED_FILE}`, "{ not json");
    assert.deepEqual(readVerified(h), new Set(), "a malformed record proves nothing");
    writeFileSync(`${h}/${VERIFIED_FILE}`, JSON.stringify({ claude: ["haiku"], extra: true }));
    assert.deepEqual(readVerified(h), new Set(), "an unexpected shape proves nothing");
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("Verify for pictures sends one tiny picture, records the model the session ran, and the catalog follows", async () => {
  const h = home();
  try {
    const { sdk, seen } = fakeSdk({ replies: () => [lookInit, { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } }, { type: "result", subtype: "success" }] });
    const make = () => claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }), home: h });
    const backend = make();
    assert.equal((await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal)).images, false);
    assert.deepEqual(await backend.verifyImages!(CLAUDE_DEFAULTS.look, "anthropic-key", signal), { resolved: "claude-haiku-5-5" });
    const sent = seen.inputs[0]!.message.content;
    assert.ok(Array.isArray(sent));
    assert.deepEqual(sent, [{ type: "image", source: { type: "base64", media_type: "image/png", data: PROBE_PNG } }, { type: "text", text: PROBE_TEXT }]);
    const image = sent[0];
    assert.equal(image.type, "image");
    if (image.type !== "image" || image.source.type !== "base64") throw new Error("expected a base64 image");
    const png = Buffer.from(image.source.data, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [2, 2, 8, 6]);
    const pixels: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      assert.equal(crc32(png.subarray(at + 4, at + 8 + length)), png.readUInt32BE(at + 8 + length));
      if (png.toString("ascii", at + 4, at + 8) === "IDAT") pixels.push(png.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    const rows = inflateSync(Buffer.concat(pixels));
    assert.equal(rows.length, 18);
    assert.ok(rows[0]! <= 4 && rows[9]! <= 4);
    assert.deepEqual(seen.options.at(-1)!.model, "haiku");
    assert.deepEqual(seen.options.at(-1)!.mcpServers, {}, "a verify call has no actions");
    assert.equal(seen.closed, 2);
    assert.deepEqual(JSON.parse(readFileSync(`${h}/${VERIFIED_FILE}`, "utf8")), { claude: ["claude-haiku-5-5"] });
    const caps = await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal);
    assert.deepEqual([caps.images, caps.noImages], [true, ""]);
    assert.equal(seen.started, 2, "the last listing is updated in place");
    assert.equal((await make().models("anthropic-key", signal)).find((m) => m.id === "haiku")?.verified, true, "a new host reads the record");
    const session = await backend.open(openOptions({ selector: CLAUDE_DEFAULTS.look, actions: [] }));
    assert.deepEqual((await drain(session.turn({ text: "look", images: [picture] })))[0], { type: "model", model: "claude-haiku-5-5", effort: "low" });
    session.close();
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("a verify persistence failure leaves pictures disabled in memory and later catalogs", async () => {
  const h = home();
  try {
    const { sdk } = fakeSdk({ replies: () => [lookInit, { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } }, { type: "result", subtype: "success" }] });
    const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }), home: h });
    mkdirSync(`${h}/${VERIFIED_FILE}`);
    await assert.rejects(backend.verifyImages!(CLAUDE_DEFAULTS.look, "anthropic-key", signal));
    assert.equal((await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal)).images, false);
    assert.equal((await backend.models("anthropic-key", signal)).find((m) => m.id === "haiku")?.verified, false);
    assert.deepEqual(readVerified(h), new Set());
    rmSync(`${h}/${VERIFIED_FILE}`, { recursive: true });
    await backend.verifyImages!(CLAUDE_DEFAULTS.look, "anthropic-key", signal);
    assert.equal((await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal)).images, true);
    assert.deepEqual(readVerified(h), new Set(["claude-haiku-5-5"]));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("a verify the model refuses, answers without text, or that has nowhere to record changes nothing", async () => {
  const cases: [Msg[], RegExp][] = [
    [[lookInit, { type: "result", subtype: "error_during_execution", is_error: true, result: "image input is not supported" }], /image input is not supported/],
    [[lookInit, { type: "result", subtype: "success" }], /sent no text back/],
    [[{ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } }, { type: "result", subtype: "success" }], /never reported which model ran/],
  ];
  for (const [replies, why] of cases) {
    const h = home();
    try {
      const { sdk, seen } = fakeSdk({ replies: () => replies });
      const backend = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }), home: h });
      await assert.rejects(backend.verifyImages!(CLAUDE_DEFAULTS.look, "anthropic-key", signal), why);
      assert.equal(seen.closed, 1, "the probe session is closed");
      assert.equal(existsSync(`${h}/${VERIFIED_FILE}`), false, "nothing is recorded");
      assert.equal((await backend.capabilities(CLAUDE_DEFAULTS.look, "anthropic-key", signal)).images, false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  }
  const { sdk, seen } = fakeSdk({});
  const homeless = claudeBackend({ executable: "/opt/claude", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
  await assert.rejects(homeless.verifyImages!(CLAUDE_DEFAULTS.look, "anthropic-key", signal), /nowhere to record/);
  assert.equal(seen.started, 0, "refused before any call");
});

test("retry and failure copy", () => {
  assert.equal(retryStatus({ error_status: null }), "Claude connection failed - retrying");
  assert.equal(failure({ is_error: false, subtype: "success" }), null);
  assert.equal(failure({ is_error: true, subtype: "success", result: "model not found" }), "that failed - model not found");
  assert.equal(failure({ subtype: "error_max_turns", errors: ["too long", 3] }), "that failed - too long");
  assert.match(failure({ is_error: true, result: "API Error: this version does not support this model" })!, /newer build/);
});

test("a signed-out CLI that prints its status and exits 1 is an answer; a broken one is not", async () => {
  const dir = mkdtempSync(`${tmpdir()}/dum-auth-`);
  const cli = (name: string, body: string) => {
    const path = `${dir}/${name}`;
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  try {
    const out = cli("signed-out", `echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","email":"x@example.com"}'\nexit 1`);
    assert.deepEqual(await authStatus(out), { loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    const env = cli("env", `echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"$CLAUDE_CODE_DISABLE_AUTO_MEMORY\\",\\"apiProvider\\":\\"\${ANTHROPIC_API_KEY:-none}\\"}"`);
    process.env.ANTHROPIC_API_KEY = "sk-shell";
    try {
      assert.deepEqual(await authStatus(env), { loggedIn: true, authMethod: "1", apiProvider: "none" }, "default env: auto-memory off, no inherited key");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    for (const bad of [cli("crash", "exit 1"), cli("noise", "echo not json\nexit 1"), cli("shapeless", "echo '{}'"), cli("hung-up", `echo '{"loggedIn":true}' >&2\nkill -9 $$`)]) {
      await assert.rejects(authStatus(bad), /couldn't report/, bad);
    }
    await assert.rejects(authStatus(`${dir}/missing`), /couldn't report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

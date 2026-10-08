import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { setImmediate } from "node:timers/promises";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_DEFAULTS,
  assertInit,
  assertProvider,
  catalog,
  claudeBackend,
  claudeEnv,
  closed,
  failure,
  retryStatus,
  start,
  type Sdk,
} from "../src/agent/claude.ts";
import { FLAGS, authStatus, cliArgs, providerFreeEnv } from "../src/agent/claude-cli.ts";
import type { AgentEvent, DumAction, OpenOptions } from "../src/agent/types.ts";
import type { ZoneContext } from "../src/zone-types.ts";
import type { RequestBinding } from "../src/share-types.ts";

process.env.DUM_CONTEXT = "off";
const signal = new AbortController().signal;
const KEY = { login: "anthropic-key", flavor: "public" } as const;
const SUB = { login: "claude-subscription", flavor: "local" } as const;
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
  assert.equal(o.model, "claude-fable-5-1");
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

test("the Claude env drops inherited routes and keys, turns auto-memory off, and carries a key only in key mode", () => {
  const inherited = {
    PATH: "/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/home/u/.claude",
    ANTHROPIC_API_KEY: "sk-shell", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy", ANTHROPIC_MODEL: "other",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_BEDROCK: "1", GEMINI_API_KEY: "g", GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
    OPENAI_API_KEY: "o", CLOUD_ML_REGION: "us",
  };
  assert.deepEqual(Object.keys(providerFreeEnv(inherited)).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  const sub = claudeEnv(inherited, null);
  assert.deepEqual(Object.keys(sub).sort(), ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  assert.equal(sub.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  const key = claudeEnv(inherited, "sk-dum");
  assert.equal(key.ANTHROPIC_API_KEY, "sk-dum", "Dum's stored key, never the shell's");
  assert.equal(key.ANTHROPIC_BASE_URL, undefined);
  assert.equal(key.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(inherited.ANTHROPIC_API_KEY, "sk-shell", "the base env is not changed");
});

test("init must report the chosen sign-in, the build's flavor, and nothing beyond Dum's actions", () => {
  const good = { tools: ["mcp__dum__ask"], mcp_servers: [{ name: "dum", status: "connected", source: "sdk" }], plugins: [] };
  assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }, KEY, ["ask"]);
  assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }, { ...KEY, flavor: "local" }, ["ask"]);
  assertInit({ ...good, apiKeySource: "none" }, SUB, ["ask"]);
  assertInit({ apiKeySource: "none", tools: [], mcp_servers: [], plugins: [] }, SUB, []);
  assert.throws(() => assertInit({ ...good, apiKeySource: "none" }, KEY, ["ask"]), /API key/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "/login managed key" }, KEY, ["ask"]), /API key/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }, SUB, ["ask"]), /instead of your subscription/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "none" }, { ...SUB, flavor: "public" }, ["ask"]), /doesn't use a Claude subscription/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", tools: [...good.tools, "Bash"] }, KEY, ["ask"]), /Bash/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", tools: ["mcp__dum__write"] }, KEY, ["ask"]), /mcp__dum__write/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", mcp_servers: [...good.mcp_servers, { name: "pencil", status: "connected", source: "user" }] }, KEY, ["ask"]), /pencil/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", mcp_servers: [{ name: "dum", status: "connected", source: "user" }] }, KEY, ["ask"]), /dum/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY", plugins: [{ name: "lsp" }] }, KEY, ["ask"]), /plugins/);
  assert.throws(() => assertInit({ ...good, apiKeySource: "ANTHROPIC_API_KEY" }, KEY, []), /mcp__dum__ask/);
});

test("the handshake proves the chosen method on the first-party route, never an unknown login", async () => {
  await assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }) }, KEY, noAuth);
  await assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none", email: "private@example.com" }) }, SUB, noAuth);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) }, KEY, noAuth), /API key/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }) }, SUB, noAuth), /subscription/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) }, { ...SUB, flavor: "public" }, noAuth), /doesn't use a Claude subscription/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({ apiProvider: "vertex" }) }, KEY, noAuth), /vertex/);
  await assert.rejects(assertProvider({ accountInfo: async () => ({}) }, SUB, noAuth), /unknown/);
  const err = await assertProvider({ accountInfo: async () => ({ apiProvider: "bedrock", email: "private@example.com" }) }, SUB, noAuth).catch((e: Error) => e);
  assert.doesNotMatch(String(err), /private@example\.com/, "account details are never printed");
  await assert.rejects(assertProvider({ accountInfo: () => new Promise(() => {}) }, KEY, noAuth, 20), /in time/);

  // Before auth resolves, the SDK reports only the route; the CLI's status must match the method.
  const early = { accountInfo: async () => ({ apiProvider: "firstParty" as const }) };
  await assertProvider(early, SUB, async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
  await assertProvider(early, KEY, async () => ({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }));
  await assert.rejects(assertProvider(early, KEY, async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })), /API key/);
  await assert.rejects(assertProvider(early, SUB, () => Promise.reject(new Error("Claude couldn't report how it's signed in"))), /couldn't report/);
  for (const login of [{}, { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" }, { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }, { loggedIn: true, authMethod: "claude.ai", apiProvider: "gateway" }]) {
    await assert.rejects(assertProvider(early, SUB, async () => login), /subscription/);
  }
  await assert.rejects(assertProvider(early, SUB, () => new Promise(() => {}), 20), /in time/, "a hung status check fails closed");
});

const MODELS = [
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] as ("low" | "medium" | "high")[] },
  { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "", supportsEffort: true, supportedEffortLevels: ["high"] as "high"[] },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsEffort: false, supportedEffortLevels: ["high"] as "high"[] },
];

test("the catalog maps efforts and marks only verified selectors image-capable", () => {
  assert.deepEqual(catalog(MODELS), [
    { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high"], images: true, actions: true, verified: true },
    { id: "claude-fable-5-1", label: "Fable 5.1", efforts: ["high"], images: true, actions: true, verified: true },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: [], images: false, actions: true, verified: false },
  ]);
});

type Msg = Record<string, unknown>;

/** A fake SDK: records options and prompt delivery, replays `replies` once input arrives. */
function fakeSdk(o: { account?: Record<string, unknown>; replies?: (input: SDKUserMessage) => Msg[]; managed?: boolean }) {
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
        supportedModels: async () => MODELS,
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
    const opening = start(personal(), options(), { route: KEY, selector: CLAUDE_DEFAULTS.helper, auth: noAuth, sdk });
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
  for (const selector of [{ ...CLAUDE_DEFAULTS.helper, model: "claude-gone-1" }, { ...CLAUDE_DEFAULTS.helper, effort: "max" }, { ...CLAUDE_DEFAULTS.helper, effort: null }]) {
    const { sdk, seen } = fakeSdk({});
    await assert.rejects(start(none(), options(), { route: KEY, selector, auth: noAuth, sdk }), /doesn't/);
    assert.equal(seen.closed, 1);
  }
});

test("managed policy is refused before a Claude process starts", async () => {
  const { sdk, seen } = fakeSdk({ managed: true });
  async function* none(): AsyncGenerator<SDKUserMessage> {}
  await assert.rejects(start(none(), options(), { route: KEY, selector: null, auth: noAuth, sdk }), /managed policy/);
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
  const opening = start(personal(), options({ abortController }), { route: KEY, selector: null, auth: noAuth, sdk });
  await setImmediate();
  abortController.abort();
  await assert.rejects(opening, /stopped before Claude finished starting/);
  assert.equal(closedCount, 1);
  assert.equal((await delivery).done, true);
});

const zone = { id: "zone" } as unknown as ZoneContext;
const binding = {} as unknown as RequestBinding;
function openOptions(over: Partial<OpenOptions> = {}): OpenOptions {
  return {
    cwd: "/tmp", zone, binding, systemPrompt: "fixed", selector: CLAUDE_DEFAULTS.intern,
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
    executable: "/opt/claude", flavor: "public", sdk,
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
    const backend = claudeBackend({ executable: "/opt/claude", flavor: "public", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
    const session = await backend.open(openOptions());
    await assert.rejects(drain(session.turn({ text: "hi" })), /Bash|API key|WebFetch|plugins/);
    assert.equal(seen.closed, 1);
    await assert.rejects(drain(session.turn({ text: "again" })), /closed/);
  }
});

test("public builds refuse a subscription session before starting; missing keys refuse too", async () => {
  const { sdk, seen } = fakeSdk({ account: { apiProvider: "firstParty", apiKeySource: "none" } });
  const pub = claudeBackend({ executable: "/opt/claude", flavor: "public", sdk, credential: async () => null });
  await assert.rejects(pub.open(openOptions({ login: "claude-subscription" })), /doesn't use a Claude subscription/);
  await assert.rejects(pub.models("claude-subscription", signal), /doesn't use a Claude subscription/);
  await assert.rejects(pub.open(openOptions()), /Add your Anthropic API key/);
  assert.equal(seen.started, 0);

  const local = claudeBackend({ executable: "/opt/claude", flavor: "local", sdk, credential: async () => { throw new Error("no key in subscription mode"); } });
  const session = await local.open(openOptions({ login: "claude-subscription" }));
  assert.equal(seen.options[0].env?.ANTHROPIC_API_KEY, undefined);
  session.close();
});

test("models reads the live catalog after provenance, and only verified selectors take pictures", async () => {
  const { sdk, seen } = fakeSdk({});
  const backend = claudeBackend({ executable: "/opt/claude", flavor: "public", sdk, credential: async () => ({ value: "sk", expiresAt: null }) });
  const models = await backend.models("anthropic-key", signal);
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
  assert.equal(seen.inputs.length, 0, "a catalog query sends no turn");
  assert.equal(seen.closed, 1);
  assert.equal(backend.capabilities(CLAUDE_DEFAULTS.intern).images, true);
  assert.equal(backend.capabilities({ backend: "claude", model: "claude-sonnet-5-5", effort: null }).images, false);
  assert.equal(backend.capabilities(CLAUDE_DEFAULTS.intern).runtimeActionCheck, true);
  const session = await backend.open(openOptions({ selector: { ...CLAUDE_DEFAULTS.intern, effort: "low" } }));
  await assert.rejects(drain(session.turn({ text: "look", images: [{ mimeType: "image/png", data: "AAAA" }] })), /pictures/);
  session.close();
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

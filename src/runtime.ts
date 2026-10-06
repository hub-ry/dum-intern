// The only way dum talks to Claude: the subscription login, explicit verified selectors, and
// no tools except the in-process MCP servers dum registers itself.

import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { query, resolveSettings, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  McpSdkServerConfigWithInstance,
  Options,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type Selector = { readonly model: string; readonly effort: EffortLevel };

/** Selectors verified with real subscription calls. Nothing else is used, and nothing falls back. */
export const MODELS = {
  dum: { model: "claude-opus-5-5", effort: "high" },
  helper: { model: "claude-fable-5-1", effort: "high" },
} as const satisfies Record<string, Selector>;

/** Refuse a selector that isn't one of the verified ones rather than silently trying it. */
export function verified(model: string, effort: string): Selector {
  const hit = Object.values(MODELS).find((s) => s.model === model && s.effort === effort);
  if (!hit) throw new Error(`${model} at ${effort} effort isn't a verified dum selector`);
  return hit;
}

/**
 * Variables that would route Claude away from the subscription login: paid API keys, gateways,
 * third-party clouds (including every Google route) and model overrides.
 */
const EXACT: Record<string, true> = {
  CLOUD_ML_REGION: true,
  AWS_BEARER_TOKEN_BEDROCK: true,
  CLAUDE_CODE_EFFORT_LEVEL: true,
  CLAUDE_CODE_SUBAGENT_MODEL: true,
  CLAUDE_CODE_API_KEY_HELPER_TTL_MS: true,
  MAX_THINKING_TOKENS: true,
};
const PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_SKIP_", "GEMINI_", "GOOGLE_", "VERTEX_", "ANTIGRAVITY_"];

function dropped(name: string): boolean {
  const upper = name.toUpperCase();
  return EXACT[upper] === true || PREFIXES.some((p) => upper.startsWith(p)) || /(?:^|_)API_KEY$/.test(upper);
}

/** The environment Claude runs with: everything except provider routes and paid credentials. */
export function subscriptionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !dropped(name)) env[name] = value;
  return env;
}

function deny(message: string) {
  return { behavior: "deny" as const, message };
}

/** Only tools served by the given in-process servers; any other tool is denied. */
export function onlyServers(servers: string[]): CanUseTool {
  return async (name, input, opts) => {
    const owner = servers.find((s) => name.startsWith(`mcp__${s}__`));
    if (!owner) return deny(`${name} isn't available in dum`);
    if (opts.mcpServer && (opts.mcpServer.source !== "sdk" || opts.mcpServer.name !== owner)) return deny(`${name} doesn't come from dum`);
    return { behavior: "allow" as const, updatedInput: input };
  };
}

export type ClosedInput = {
  cwd: string;
  systemPrompt: string;
  model: string;
  effort: EffortLevel;
  mcp?: Record<string, McpSdkServerConfigWithInstance>;
  resume?: string;
  maxTurns?: number;
};

const FLAGS = {
  disableAllHooks: true,
  enabledPlugins: {
    "agents-md@builtin": false,
    "telemetry@builtin": false,
    "cc-plugin-plugin-authoring@builtin": false,
  },
};

type Login = { loggedIn?: boolean; authMethod?: string; apiProvider?: string };

/**
 * The Claude executable. The terminal edition uses `claude` from PATH; the desktop app runs its
 * bundled native binary and names it by absolute path in DUM_CLAUDE_BIN, since a Finder-launched
 * app has no user PATH. A set value that isn't an executable file is refused, never looked up.
 */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.DUM_CLAUDE_BIN;
  if (!path) return "claude";
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error("DUM_CLAUDE_BIN must be an absolute path to the claude executable");
  }
  return path;
}

/** CLI arguments that keep a direct `claude` command as isolated as an SDK session: safe mode, no setting files, no hooks or plugins. */
export function cliArgs(...command: string[]): string[] {
  return ["--safe-mode", "--setting-sources", "", "--settings", JSON.stringify(FLAGS), ...command];
}

/**
 * Read provenance only; auth status's account fields are never returned, logged or sent.
 * Asynchronous, so a desktop main process keeps drawing while the CLI answers.
 */
export async function login(executable?: string): Promise<Login> {
  let stdout: string;
  try {
    const status = promisify(execFile)(executable ?? claudeExecutable(), cliArgs("auth", "status"), {
      env: subscriptionEnv(), encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
    });
    // Nothing is typed into it: stdin closes now, as the synchronous call's "ignore" did.
    status.child.stdin?.end();
    stdout = (await status).stdout;
  } catch (err) {
    // Signed out, the CLI still prints its status as JSON but exits 1: that is an answer, not a failure.
    const failed = err as { code?: unknown; killed?: boolean; stdout?: unknown };
    if (typeof failed.code !== "number" || failed.killed || typeof failed.stdout !== "string") throw unverified();
    stdout = failed.stdout;
  }
  let parsed: Login;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw unverified();
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.loggedIn !== "boolean") throw unverified();
  return { loggedIn: parsed.loggedIn, authMethod: parsed.authMethod, apiProvider: parsed.apiProvider };
}

const unverified = () => new Error("couldn't verify the Claude CLI login - install a current `claude`, then run it and /login");

/**
 * SDK options with no built-in tools, no filesystem settings (so no CLAUDE.md, hooks, plugins,
 * permission rules or MCP config), no skills, a custom prompt that isn't snapshotted into the
 * session, and only dum's own in-process MCP servers.
 */
export function closed(o: ClosedInput): Options {
  const selector = verified(o.model, o.effort);
  const mcp = o.mcp ?? {};
  return {
    cwd: o.cwd,
    model: selector.model,
    effort: selector.effort,
    systemPrompt: { type: "custom", prompt: o.systemPrompt, snapshot: false },
    tools: [],
    settingSources: [],
    skills: [],
    plugins: [],
    // An empty plugins list means "no additional plugins", not "disable installed plugins".
    // Safe mode keeps the existing OAuth login while excluding user hooks and customizations.
    extraArgs: { "safe-mode": null },
    settings: FLAGS,
    pathToClaudeCodeExecutable: claudeExecutable(),
    strictMcpConfig: true,
    mcpServers: mcp,
    permissionMode: "default",
    env: subscriptionEnv(),
    canUseTool: onlyServers(Object.keys(mcp)),
    ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
  };
}

type Init = Pick<SDKSystemMessage, "apiKeySource" | "tools" | "mcp_servers"> & { plugins?: { name: string }[] };

/**
 * Fail closed when the started session isn't the subscription login or has anything beyond dum's
 * own tools. Names only: no account or credential contents are ever put in the message.
 */
export function assertSubscription(init: Init, servers: string[] = ["dum"]): void {
  if (init.apiKeySource !== "none") {
    throw new Error(`Claude started with an API key (${init.apiKeySource}) instead of your subscription login - dum doesn't use paid API credentials. Unset it, or run \`claude\` and /login`);
  }
  const extra = (init.tools ?? []).filter((t) => !servers.some((s) => t.startsWith(`mcp__${s}__`)));
  if (extra.length) throw new Error(`Claude started with tools dum doesn't allow: ${extra.slice(0, 8).join(", ")}`);
  const foreign = (init.mcp_servers ?? []).filter((m) => !servers.includes(m.name) || (m.source !== undefined && m.source !== "sdk"));
  if (foreign.length) throw new Error(`Claude started with MCP servers dum didn't register: ${foreign.map((m) => m.name).slice(0, 8).join(", ")}`);
  if (init.plugins?.length) throw new Error("Claude started with plugins - dum runs without them");
}

/**
 * The account must be on Anthropic's own route (not a cloud provider or gateway). Prints nothing,
 * and fails closed if Claude can't say within `ms`.
 */
export async function assertProvider(q: { accountInfo(): Promise<AccountInfo> }, ms = 15_000, auth: () => Login | Promise<Login> = login): Promise<void> {
  const stop = new AbortController();
  const late = sleep(ms, undefined, { signal: stop.signal }).then(
    () => { throw new Error("Claude didn't confirm its login route in time"); },
    () => undefined,
  );
  try {
    const info = await Promise.race([q.accountInfo(), late]);
    const provider = info?.apiProvider;
    if (provider !== "firstParty") {
      throw new Error(`Claude didn't confirm the first-party subscription route (${provider ?? "unknown"}) - dum only uses your Claude subscription login`);
    }
    if (info?.apiKeySource === undefined) {
      // During initialization this SDK reports only the backend, before resolving auth.
      // Confirm OAuth with the same installed CLI, without sending a model prompt.
      const status = await auth();
      if (!status.loggedIn || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
        throw new Error("Claude isn't logged in through its first-party subscription - run `claude` and /login");
      }
    } else if (info.apiKeySource !== "none") {
      throw new Error("Claude didn't confirm a subscription login without an API key - run `claude` and /login");
    }
  } finally {
    stop.abort();
  }
}

/**
 * Hold every user message until the SDK's initialization handshake confirms the login.
 * Policy can override flag settings and run hooks even in safe mode, so it is not supported.
 * Fixed system prompts and tool schemas contain no personal context; that waits here too.
 * Aborting `options.abortController` while this waits closes the Claude process at once.
 */
export async function start(
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options,
  runQuery: typeof query = query,
  settings: typeof resolveSettings = resolveSettings,
): Promise<Query> {
  const signal = options.abortController?.signal;
  const stopped = () => new Error("stopped before Claude finished starting");
  const policy = await settings({ cwd: options.cwd, settingSources: [] });
  if (signal?.aborted) throw stopped();
  if (policy.sources.some((s) => s.source === "managed" && Object.keys(s.settings).length)) {
    throw new Error("dum can't isolate Claude's hooks and routing while managed policy is active; an unmanaged first-party subscription login is required");
  }
  const { promise: cleared, resolve: release } = Promise.withResolvers<boolean>();
  async function* input(): AsyncGenerator<SDKUserMessage> {
    if (!(await cleared)) return;
    if (typeof prompt === "string") {
      yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
    } else {
      yield* prompt;
    }
  }
  const session = runQuery({ prompt: input(), options });
  const { promise: aborted, reject: abort } = Promise.withResolvers<never>();
  aborted.catch(() => {});
  const onAbort = () => abort(stopped());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw stopped();
    await Promise.race([assertProvider(session), aborted]);
    release(true);
    return session;
  } catch (err) {
    release(false);
    session.close();
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

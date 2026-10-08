// Claude behind the agent contract: the bundled CLI through the Agent SDK, with no built-in
// tools, no setting files, no auto-memory and only Dum's own actions. Every session proves its
// sign-in method before any user content reaches Claude, and nothing falls back.

import { setTimeout as sleep } from "node:timers/promises";
import { createSdkMcpServer, query, resolveSettings, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
  Query,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { offeredLogins } from "./schema.ts";
import { AUTO_MEMORY_OFF, FLAGS, authStatus, providerFreeEnv, type AuthStatus } from "./claude-cli.ts";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  Capabilities,
  CredentialSource,
  DumAction,
  Flavor,
  LoginMethod,
  ModelOption,
  OpenOptions,
  Selector,
  UserTurn,
} from "./types.ts";

/** The selectors used before anything else is picked: the intern and the helper. */
export const CLAUDE_DEFAULTS = {
  intern: { backend: "claude", model: "claude-opus-5-5", effort: "high" },
  helper: { backend: "claude", model: "claude-fable-5-1", effort: "high" },
} as const satisfies { intern: Selector; helper: Selector };

/** Selectors proven with real calls. Only these are offered with pictures. */
export const CLAUDE_VERIFIED: readonly Selector[] = [CLAUDE_DEFAULTS.intern, CLAUDE_DEFAULTS.helper];

/** The one Claude child's environment: no inherited routes or keys, auto-memory off, and Dum's key only in key mode. */
export function claudeEnv(base: NodeJS.ProcessEnv, key: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...providerFreeEnv(base), ...AUTO_MEMORY_OFF };
  if (key !== null) env.ANTHROPIC_API_KEY = key;
  return env;
}

/** Dum's single in-process MCP server; its tools are Dum's actions. */
const SERVER = "dum";
const PREFIX = `mcp__${SERVER}__`;

/** The sign-in a session must prove, and the build it runs in. */
export type Route = { login: LoginMethod; flavor: Flavor };

/** Refuse a sign-in this build doesn't offer for Claude, before anything starts. */
function assertRoute(route: Route): void {
  if (!offeredLogins(route.flavor, "claude").includes(route.login)) {
    throw new Error(route.login === "claude-subscription"
      ? "This build of Dum doesn't use a Claude subscription. Use an Anthropic API key."
      : `Claude doesn't sign in with ${route.login}`);
  }
}

/** Only the given wire names, served by Dum's own in-process server; anything else is denied. */
export function onlyActions(names: ReadonlySet<string>): CanUseTool {
  return async (name, input, opts) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    if (!names.has(name)) return deny(`${name} isn't available in Dum`);
    if (opts.mcpServer && (opts.mcpServer.source !== "sdk" || opts.mcpServer.name !== SERVER)) return deny(`${name} doesn't come from Dum`);
    return { behavior: "allow" as const, updatedInput: input };
  };
}

export type ClosedInput = {
  executable: string;
  cwd: string;
  systemPrompt: string;
  /** null for a catalog query that never sends a turn. */
  selector: Selector | null;
  env: NodeJS.ProcessEnv;
  actions: readonly DumAction[];
  abortController: AbortController;
  maxTurns?: number;
};

/**
 * SDK options with no built-in tools, no filesystem settings (so no CLAUDE.md, hooks, plugins,
 * permission rules or MCP config), no skills, no auto-memory, a custom prompt that isn't
 * snapshotted, and only Dum's actions on Dum's in-process server.
 */
export function closed(o: ClosedInput): Options {
  const wire = new Set<string>();
  for (const a of o.actions) {
    if (wire.has(PREFIX + a.name)) throw new Error(`Dum's action ${a.name} is listed twice`);
    wire.add(PREFIX + a.name);
  }
  const signal = o.abortController.signal;
  const mcp: Record<string, McpSdkServerConfigWithInstance> = o.actions.length
    ? {
      [SERVER]: createSdkMcpServer({
        name: SERVER,
        version: "3.0.0",
        timeout: 900_000,
        alwaysLoad: true,
        tools: o.actions.map((a) =>
          tool(a.name, a.description, a.schema, async (args: unknown) => {
            try {
              const r = await a.call(args, signal);
              return { content: [{ type: "text" as const, text: r.text }], isError: r.isError === true };
            } catch (err) {
              return { content: [{ type: "text" as const, text: `That didn't work: ${(err as Error).message}` }], isError: true };
            }
          }),
        ),
      }),
    }
    : {};
  return {
    cwd: o.cwd,
    ...(o.selector ? { model: o.selector.model } : {}),
    ...(o.selector?.effort ? { effort: o.selector.effort as EffortLevel } : {}),
    systemPrompt: { type: "custom", prompt: o.systemPrompt, snapshot: false },
    tools: [],
    settingSources: [],
    skills: [],
    plugins: [],
    // An empty plugins list means "no additional plugins", not "disable installed plugins".
    // Safe mode excludes user hooks and customizations.
    extraArgs: { "safe-mode": null },
    settings: FLAGS,
    pathToClaudeCodeExecutable: o.executable,
    strictMcpConfig: true,
    mcpServers: mcp,
    permissionMode: "default",
    env: o.env,
    canUseTool: onlyActions(wire),
    abortController: o.abortController,
    persistSession: false,
    ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
  };
}

export type Init = Pick<SDKSystemMessage, "apiKeySource" | "tools" | "mcp_servers"> & { plugins?: { name: string }[] };

/**
 * Fail closed when a started session isn't on the chosen sign-in or reports anything beyond
 * Dum's actions. Names only: no account or credential contents go in the message.
 */
export function assertInit(init: Init, route: Route, actions: readonly string[]): void {
  assertRoute(route);
  if (route.login === "anthropic-key" && init.apiKeySource !== "ANTHROPIC_API_KEY") {
    throw new Error(`Claude didn't start with your API key (${init.apiKeySource})`);
  }
  if (route.login === "claude-subscription" && init.apiKeySource !== "none") {
    throw new Error(`Claude started with an API key (${init.apiKeySource}) instead of your subscription login`);
  }
  const wire = new Set(actions.map((a) => PREFIX + a));
  const extra = (init.tools ?? []).filter((t) => !wire.has(t));
  if (extra.length) throw new Error(`Claude started with actions Dum doesn't allow: ${extra.slice(0, 8).join(", ")}`);
  const foreign = (init.mcp_servers ?? []).filter((m) => !actions.length || m.name !== SERVER || (m.source !== undefined && m.source !== "sdk"));
  if (foreign.length) throw new Error(`Claude started with MCP servers Dum didn't register: ${foreign.map((m) => m.name).slice(0, 8).join(", ")}`);
  if (init.plugins?.length) throw new Error("Claude started with plugins; Dum runs without them");
}

/**
 * The account must be on Anthropic's own route and on the chosen sign-in. When the handshake
 * hasn't resolved the credential yet, `auth` asks the same bundled CLI with the same env.
 * Fails closed if Claude can't say within `ms`.
 */
export async function assertProvider(
  q: { accountInfo(): Promise<AccountInfo> },
  route: Route,
  auth: () => Promise<AuthStatus>,
  ms = 15_000,
): Promise<void> {
  assertRoute(route);
  const stop = new AbortController();
  // Unref'd: a start that was aborted mid-check doesn't hold the process open.
  const late = sleep(ms, undefined, { signal: stop.signal, ref: false }).then(
    () => { throw new Error("Claude didn't confirm its sign-in in time"); },
    () => undefined,
  );
  try {
    const info = await Promise.race([q.accountInfo(), late]);
    if (info?.apiProvider !== "firstParty") throw new Error(`Claude isn't on Anthropic's own route (${info?.apiProvider ?? "unknown"})`);
    const key = route.login === "anthropic-key";
    if (info.apiKeySource === undefined) {
      const status = await Promise.race([auth(), late]);
      const method = key ? "api_key" : "claude.ai";
      if (!status?.loggedIn || status.authMethod !== method || status.apiProvider !== "firstParty") {
        throw new Error(key ? "Claude didn't start with your API key" : "Claude isn't signed in with your subscription");
      }
    } else if (info.apiKeySource !== (key ? "ANTHROPIC_API_KEY" : "none")) {
      throw new Error(key ? "Claude didn't start with your API key" : "Claude didn't confirm a subscription login without an API key");
    }
  } finally {
    stop.abort();
  }
}

/** The live catalog as the picker shows it. Only verified selectors take pictures. */
export function catalog(models: readonly ModelInfo[]): ModelOption[] {
  return models.map((m) => ({
    id: m.value,
    label: m.displayName || m.value,
    efforts: m.supportsEffort ? [...(m.supportedEffortLevels ?? [])] : [],
    images: CLAUDE_VERIFIED.some((s) => s.model === m.value),
    actions: true,
    verified: CLAUDE_VERIFIED.some((s) => s.model === m.value),
  }));
}

/** The selector must be in the live catalog with an advertised effort. */
function assertListed(options: readonly ModelOption[], selector: Selector): void {
  const hit = options.find((m) => m.id === selector.model);
  if (!hit) throw new Error(`Claude doesn't offer ${selector.model} on this sign-in`);
  if (selector.effort === null ? hit.efforts.length > 0 : !hit.efforts.includes(selector.effort)) {
    throw new Error(`${selector.model} doesn't take ${selector.effort ?? "no"} effort`);
  }
}

export type Sdk = { query: typeof query; resolveSettings: typeof resolveSettings };
const SDK: Sdk = { query, resolveSettings };

/**
 * Hold every user message until the handshake proves the sign-in and, for a turn-taking
 * session, the selector. Managed policy can override flags and run hooks even in safe mode, so
 * it is refused. Aborting `options.abortController` while this waits closes Claude at once.
 */
export async function start(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
  o: { route: Route; selector: Selector | null; auth: () => Promise<AuthStatus>; sdk?: Sdk },
): Promise<Query> {
  const sdk = o.sdk ?? SDK;
  assertRoute(o.route);
  const signal = options.abortController?.signal;
  const stopped = () => new Error("stopped before Claude finished starting");
  const policy = await sdk.resolveSettings({ cwd: options.cwd, settingSources: [] });
  if (signal?.aborted) throw stopped();
  if (policy.sources.some((s) => s.source === "managed" && Object.keys(s.settings).length)) {
    throw new Error("Dum can't isolate Claude while managed policy is active");
  }
  const { promise: cleared, resolve: release } = Promise.withResolvers<boolean>();
  async function* input(): AsyncGenerator<SDKUserMessage> {
    if (await cleared) yield* prompt;
  }
  const session = sdk.query({ prompt: input(), options });
  const { promise: aborted, reject: abort } = Promise.withResolvers<never>();
  aborted.catch(() => {});
  const onAbort = () => abort(stopped());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw stopped();
    await Promise.race([assertProvider(session, o.route, o.auth), aborted]);
    if (o.selector) assertListed(catalog(await Promise.race([session.supportedModels(), aborted])), o.selector);
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

/** API retries are progress too: a connection failure must not look like thinking. */
export function retryStatus(msg: { error_status?: number | null; error?: string; retry_delay_ms?: number }): string {
  const why = msg.error_status == null ? "connection failed" : `API ${msg.error_status}${msg.error ? ` (${msg.error})` : ""}`;
  const seconds = Math.ceil(Math.max(0, msg.retry_delay_ms ?? 0) / 1000);
  return `Claude ${why} - retrying${seconds ? ` in ${seconds}s` : ""}`;
}

/** What to tell them when a turn ended on an error, or null if it did not. */
export function failure(msg: { is_error?: boolean; subtype?: string; result?: unknown; errors?: unknown }): string | null {
  if (!msg.is_error && (!msg.subtype || msg.subtype === "success")) return null;
  const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === "string" && !!e.trim()).join("; ") : "";
  const text = typeof msg.result === "string" && msg.result.trim() ? msg.result.trim() : errors || `the turn stopped (${msg.subtype})`;
  if (/does not support this model|or newer is required/i.test(text)) {
    return "this model needs a newer build of Dum.";
  }
  return `that failed - ${text}`;
}

/** Turns queued by `turn()` and handed to the SDK one at a time. */
class Inbox {
  private readonly waiting: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(m: SDKUserMessage): void {
    this.waiting.push(m);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.wake = resolve;
      await promise;
      this.wake = null;
    }
  }
}

function userMessage(input: UserTurn): SDKUserMessage {
  const images = (input.images ?? []).map((p) => ({ type: "image" as const, source: { type: "base64" as const, media_type: p.mimeType, data: p.data } }));
  return {
    type: "user",
    message: { role: "user", content: images.length ? [...images, { type: "text" as const, text: input.text }] : input.text },
    parent_tool_use_id: null,
  };
}

export function claudeBackend(o: { executable: string; flavor: Flavor; credential: CredentialSource; sdk?: Sdk }): AgentBackend {
  /** The key for key mode (fetched from main for this one query), or null for the subscription. */
  async function keyFor(login: LoginMethod, signal: AbortSignal): Promise<string | null> {
    assertRoute({ login, flavor: o.flavor });
    if (login !== "anthropic-key") return null;
    const key = await o.credential("anthropic-key", signal);
    if (!key) throw new Error("Add your Anthropic API key to use Claude");
    return key.value;
  }

  function capabilities(selector: Selector): Capabilities {
    return {
      images: CLAUDE_VERIFIED.some((s) => s.model === selector.model && s.effort === selector.effort),
      interrupt: true,
      runtimeActionCheck: true,
    };
  }

  return {
    id: "claude",
    label: "Claude",
    capabilities,

    async models(login, signal) {
      const env = claudeEnv(process.env, await keyFor(login, signal));
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const inbox = new Inbox();
      inbox.end();
      try {
        const options = closed({ executable: o.executable, cwd: process.cwd(), systemPrompt: "", selector: null, env, actions: [], abortController });
        const session = await start(inbox.messages(), options, {
          route: { login, flavor: o.flavor }, selector: null, auth: () => authStatus(o.executable, env), sdk: o.sdk,
        });
        try {
          return catalog(await session.supportedModels());
        } finally {
          session.close();
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        abortController.abort();
      }
    },

    async open(open: OpenOptions): Promise<AgentSession> {
      if (open.selector.backend !== "claude") throw new Error(`${open.selector.backend} isn't a Claude model`);
      const route: Route = { login: open.login, flavor: o.flavor };
      const env = claudeEnv(process.env, await keyFor(open.login, open.signal));
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      open.signal.addEventListener("abort", onAbort, { once: true });
      if (open.signal.aborted) abortController.abort();
      const inbox = new Inbox();
      const names = open.actions.map((a) => a.name);
      const options = closed({
        executable: o.executable, cwd: open.cwd, systemPrompt: open.systemPrompt, selector: open.selector,
        env, actions: open.actions, abortController, maxTurns: open.maxTurns,
      });
      let session: Query;
      try {
        session = await start(inbox.messages(), options, { route, selector: open.selector, auth: () => authStatus(o.executable, env), sdk: o.sdk });
      } catch (err) {
        open.signal.removeEventListener("abort", onAbort);
        throw err;
      }
      const replies = session[Symbol.asyncIterator]();
      const images = capabilities(open.selector).images;
      let shut = false;
      let busy = false;
      let interrupted = false;
      const close = () => {
        if (shut) return;
        shut = true;
        inbox.end();
        open.signal.removeEventListener("abort", onAbort);
        abortController.abort();
        session.close();
      };

      async function* turn(input: UserTurn): AsyncGenerator<AgentEvent> {
        if (shut) throw new Error("this Claude session is closed");
        if (busy) throw new Error("Claude is still answering the last turn");
        if (input.images?.length && !images) throw new Error(`${open.selector.model} isn't set up to read pictures in Dum`);
        busy = true;
        interrupted = false;
        try {
          inbox.push(userMessage(input));
          for (;;) {
            const next = await replies.next();
            if (next.done) throw new Error("Claude stopped without finishing the turn");
            const msg = next.value;
            if (msg.type === "system" && msg.subtype === "api_retry") {
              yield { type: "retry", message: retryStatus(msg) };
            } else if (msg.type === "system" && msg.subtype === "init") {
              assertInit(msg, route, names);
              yield { type: "model", model: msg.model, effort: open.selector.effort };
            } else if (msg.type === "assistant") {
              for (const b of msg.message.content) {
                if ("name" in b && b.type.endsWith("tool_use")) {
                  // Only Dum's actions: anything else, built-in or server-side, ends the session.
                  const bare = b.name.startsWith(PREFIX) ? b.name.slice(PREFIX.length) : "";
                  if (!names.includes(bare)) throw new Error(`Claude tried to use ${b.name}, which Dum doesn't allow - stopped`);
                  yield { type: "action", name: bare };
                } else if (b.type === "text" && b.text.trim()) {
                  yield { type: "text", text: b.text.trim() };
                }
              }
            } else if (msg.type === "result") {
              yield { type: "end", error: interrupted ? null : failure(msg), interrupted };
              return;
            }
          }
        } catch (err) {
          close();
          throw err;
        } finally {
          busy = false;
        }
      }

      return {
        turn,
        async interrupt() {
          if (shut || !busy) return;
          interrupted = true;
          await session.interrupt();
        },
        close,
      };
    },
  };
}

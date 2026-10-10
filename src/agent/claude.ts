// Claude behind the agent contract: the bundled CLI through the Agent SDK, with no built-in
// tools, no setting files, no auto-memory and only Dum's own actions. Claude connects only with
// the user's own Anthropic API key; every session proves it before any user content reaches
// Claude, and nothing falls back.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSdkMcpServer, query, resolveSettings, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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
import { AUTO_MEMORY_OFF, FLAGS, authStatus, providerFreeEnv, type AuthStatus } from "./claude-cli.ts";
import { ModelOptionSchema } from "./schema.ts";
import { readState, writeState } from "../state-files.ts";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  Capabilities,
  CredentialSource,
  DumAction,
  LoginMethod,
  ModelOption,
  OpenOptions,
  Selector,
  UserTurn,
} from "./types.ts";

/**
 * Models proven with real calls through Dum's own Claude backend, by the id a catalog row resolves
 * to and the session reports at `system/init`; never by alias. Only these, and the ids this install
 * proved itself (`VERIFIED_FILE`), are sent pictures.
 */
export const CLAUDE_VERIFIED: Readonly<Record<string, true>> = { "claude-opus-5-5": true, "claude-fable-5-1": true };

const NONE: ReadonlySet<string> = new Set();

/** `resolved` is proven for pictures: shipped in `CLAUDE_VERIFIED` or proven on this install. */
export function verified(resolved: string, proven: ReadonlySet<string> = NONE): boolean {
  return Object.hasOwn(CLAUDE_VERIFIED, resolved) || proven.has(resolved);
}

/** Why `selector`, running `resolved` today, may not be sent pictures; "" when it may. */
export function noImages(selector: Selector, resolved: string, proven: ReadonlySet<string> = NONE): string {
  if (verified(resolved, proven)) return "";
  return selector.model === resolved
    ? `${resolved} isn't verified for pictures yet`
    : `${selector.model} changed to ${resolved}, which isn't verified for pictures yet`;
}

/** Host-owned record of resolved ids this install proved with "Verify for pictures". */
export const VERIFIED_FILE = "verified-models.json";
const VerifiedFileSchema = z.object({ claude: z.array(ModelOptionSchema.shape.resolved).max(256) }).strict();

/** The ids recorded in `<home>/verified-models.json`; an unreadable or malformed file counts as none. */
export function readVerified(home: string): Set<string> {
  try {
    const raw = readState(home, VERIFIED_FILE, 64 * 1024);
    if (raw === null) return new Set();
    const parsed = VerifiedFileSchema.safeParse(JSON.parse(raw));
    return new Set(parsed.success ? parsed.data.claude : []);
  } catch {
    return new Set();
  }
}

/** Atomically replace the record with `proven`, sorted so the file is stable. */
export function writeVerified(home: string, proven: ReadonlySet<string>): void {
  writeState(home, VERIFIED_FILE, `${JSON.stringify({ claude: [...proven].sort() }, null, 2)}\n`);
}

/** The picture a verify call sends: a 2×2 solid-colour PNG, small enough to cost almost nothing. */
export const PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
export const PROBE_TEXT = "Reply with the single word OK.";
const PROBE_MS = 60_000;

/** The one Claude child's environment: no inherited routes or keys, auto-memory off, and the user's key. */
export function claudeEnv(base: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  return { ...providerFreeEnv(base), ...AUTO_MEMORY_OFF, ANTHROPIC_API_KEY: key };
}

/** Dum's single in-process MCP server; its tools are Dum's actions. */
const SERVER = "dum";
const PREFIX = `mcp__${SERVER}__`;

/** Claude connects only with the user's Anthropic API key; refuse anything else before it starts. */
function assertKey(login: LoginMethod): void {
  if (login !== "anthropic-key") throw new Error(`Claude doesn't sign in with ${login}; it uses your Anthropic API key`);
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
 * Fail closed when a started session isn't on the user's API key or reports anything beyond Dum's
 * actions. Names only: no account or credential contents go in the message.
 */
export function assertInit(init: Init, actions: readonly string[]): void {
  if (init.apiKeySource !== "ANTHROPIC_API_KEY") throw new Error(`Claude didn't start with your API key (${init.apiKeySource})`);
  const wire = new Set(actions.map((a) => PREFIX + a));
  const extra = (init.tools ?? []).filter((t) => !wire.has(t));
  if (extra.length) throw new Error(`Claude started with actions Dum doesn't allow: ${extra.slice(0, 8).join(", ")}`);
  const foreign = (init.mcp_servers ?? []).filter((m) => !actions.length || m.name !== SERVER || (m.source !== undefined && m.source !== "sdk"));
  if (foreign.length) throw new Error(`Claude started with MCP servers Dum didn't register: ${foreign.map((m) => m.name).slice(0, 8).join(", ")}`);
  if (init.plugins?.length) throw new Error("Claude started with plugins; Dum runs without them");
}

/**
 * The account must be on Anthropic's own route with the user's API key. When the handshake hasn't
 * resolved the credential yet, `auth` asks the same bundled CLI with the same env. Fails closed if
 * Claude can't say within `ms`.
 */
export async function assertProvider(q: { accountInfo(): Promise<AccountInfo> }, auth: () => Promise<AuthStatus>, ms = 15_000): Promise<void> {
  const stop = new AbortController();
  // Unref'd: a start that was aborted mid-check doesn't hold the process open.
  const late = sleep(ms, undefined, { signal: stop.signal, ref: false }).then(
    () => { throw new Error("Claude didn't confirm your API key in time"); },
    () => undefined,
  );
  try {
    const info = await Promise.race([q.accountInfo(), late]);
    if (info?.apiProvider !== "firstParty") throw new Error(`Claude isn't on Anthropic's own route (${info?.apiProvider ?? "unknown"})`);
    if (info.apiKeySource === undefined) {
      const status = await Promise.race([auth(), late]);
      if (!status?.loggedIn || status.authMethod !== "api_key" || status.apiProvider !== "firstParty") throw new Error("Claude didn't start with your API key");
    } else if (info.apiKeySource !== "ANTHROPIC_API_KEY") {
      throw new Error("Claude didn't start with your API key");
    }
  } finally {
    stop.abort();
  }
}

/**
 * The live catalog as the picker shows it. Every Claude model takes pictures; Dum sends them only to
 * a row whose resolved model is verified (shipped or proven on this install), and `verified` says which rows those are.
 */
export function catalog(models: readonly ModelInfo[], proven: ReadonlySet<string> = NONE): ModelOption[] {
  return models.map((m) => {
    const resolved = m.resolvedModel || m.value;
    return {
      id: m.value,
      resolved,
      label: m.displayName || m.value,
      efforts: m.supportsEffort ? [...(m.supportedEffortLevels ?? [])] : [],
      images: true,
      actions: true,
      verified: verified(resolved, proven),
    };
  });
}

/** The selector must be in the live catalog with an advertised effort. */
function assertListed(options: readonly ModelOption[], selector: Selector): void {
  const hit = options.find((m) => m.id === selector.model);
  if (!hit) throw new Error(`Claude doesn't list ${selector.model} for your key - choose again in Settings › Agent`);
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
  o: {
    login: LoginMethod; selector: Selector | null; auth: () => Promise<AuthStatus>; sdk?: Sdk;
    /** The catalog this handshake read, before the selector is checked against it. */
    seen?: (options: ModelOption[]) => void;
    /** Resolved ids this install proved for pictures. */
    proven?: ReadonlySet<string>;
  },
): Promise<Query> {
  const sdk = o.sdk ?? SDK;
  assertKey(o.login);
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
    await Promise.race([assertProvider(session, o.auth), aborted]);
    if (o.selector) {
      const options = catalog(await Promise.race([session.supportedModels(), aborted]), o.proven);
      o.seen?.(options);
      assertListed(options, o.selector);
    }
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

/** `home` is H, where this install's proven ids live; without it nothing is persisted and verifying is refused. */
export function claudeBackend(o: { executable: string; credential: CredentialSource; sdk?: Sdk; home?: string }): AgentBackend {
  /** The user's key, fetched from main for this one query. */
  async function keyFor(login: LoginMethod, signal: AbortSignal): Promise<string> {
    assertKey(login);
    const key = await o.credential("anthropic-key", signal);
    if (!key) throw new Error("Add your Anthropic API key to use Claude");
    return key.value;
  }

  /** The last catalog Claude listed for the key: every catalog read and session handshake refreshes it. */
  let listed: readonly ModelOption[] | null = null;
  /** Resolved ids this install proved; the host is the only writer, so the file is read once. */
  const proven = o.home ? readVerified(o.home) : new Set<string>();

  function judge(selector: Selector, options: readonly ModelOption[]): Capabilities {
    const row = options.find((m) => m.id === selector.model);
    const model = row?.resolved ?? selector.model;
    const why = row ? noImages(selector, model, proven) : `${selector.model} isn't in Claude's model list for your key`;
    return { model, images: why === "", noImages: why, interrupt: true, runtimeActionCheck: true };
  }

  /**
   * A session on `open.selector`. `probe` is the verify call: it carries a picture to a model that
   * isn't verified yet and records the model `system/init` reports instead of checking it.
   */
  async function connect(open: OpenOptions, probe: boolean): Promise<AgentSession> {
    if (open.selector.backend !== "claude") throw new Error(`${open.selector.backend} isn't a Claude model`);
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
    // Pictures are judged on the model the selector resolves to in this very handshake's catalog.
    let caps: Capabilities | null = null;
    try {
      session = await start(inbox.messages(), options, {
        login: open.login, selector: open.selector, auth: () => authStatus(o.executable, env), sdk: o.sdk, proven,
        seen: (options) => {
          listed = options;
          caps = judge(open.selector, options);
        },
      });
    } catch (err) {
      open.signal.removeEventListener("abort", onAbort);
      throw err;
    }
    const replies = session[Symbol.asyncIterator]();
    const { model, images, noImages: why } = caps ?? judge(open.selector, []);
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
      if (input.images?.length && !images && !probe) throw new Error(why);
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
            assertInit(msg, names);
            // Verification is by the model the session runs; pictures sent for one model must not reach another.
            if (input.images?.length && !probe && msg.model !== model) throw new Error(`Claude ran ${msg.model}, not ${model} - stopped`);
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
  }

  const backend: AgentBackend = {
    id: "claude",
    label: "Claude",

    async capabilities(selector, login, signal) {
      return judge(selector, listed ?? await backend.models(login, signal));
    },

    async models(login, signal) {
      const env = claudeEnv(process.env, await keyFor(login, signal));
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const inbox = new Inbox();
      inbox.end();
      try {
        const options = closed({ executable: o.executable, cwd: process.cwd(), systemPrompt: "", selector: null, env, actions: [], abortController });
        const session = await start(inbox.messages(), options, { login, selector: null, auth: () => authStatus(o.executable, env), sdk: o.sdk });
        try {
          const options = catalog(await session.supportedModels(), proven);
          listed = options;
          return options;
        } finally {
          session.close();
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        abortController.abort();
      }
    },

    open(open) {
      return connect(open, false);
    },

    async verifyImages(selector, login, signal) {
      if (!o.home) throw new Error("this Dum has nowhere to record a verified model");
      const home = o.home;
      const cwd = join(home, "verify", "runtime");
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const late = AbortSignal.timeout(PROBE_MS);
      const session = await connect({
        cwd, systemPrompt: "Answer the prompt you're given directly. You have no tools, files or web access in this conversation.",
        selector, login, actions: [], signal: AbortSignal.any([signal, late]), maxTurns: 1,
      }, true);
      let resolved = "";
      let answered = false;
      try {
        for await (const event of session.turn({ text: PROBE_TEXT, images: [{ mimeType: "image/png", data: PROBE_PNG }] })) {
          if (event.type === "model") resolved = event.model;
          else if (event.type === "text") answered = true;
          else if (event.type === "action") throw new Error(`it tried to use ${event.name}, and a verify call has no actions`);
          else if (event.type === "end") {
            if (event.interrupted || signal.aborted) throw new Error("stopped");
            if (event.error) throw new Error(event.error);
          }
        }
      } catch (err) {
        if (late.aborted) throw new Error(`${selector.model} didn't answer the picture within ${PROBE_MS / 1000} s`);
        throw err;
      } finally {
        session.close();
      }
      if (!resolved) throw new Error(`${selector.model} never reported which model ran`);
      if (!answered) throw new Error(`${resolved} saw the picture but sent no text back`);
      // The record is by the id the session ran, exactly what `noImages` is asked about later.
      writeVerified(home, new Set([...proven, resolved]));
      proven.add(resolved);
      if (listed) listed = listed.map((m) => (m.resolved === resolved ? { ...m, verified: true } : m));
      return { resolved };
    },
  };
  return backend;
}

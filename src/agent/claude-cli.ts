// What both Electron main and the desktop host need to run the bundled Claude CLI in isolation.
// No runtime SDK import, so main can load it without the Agent SDK.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Settings passed to every session and CLI call: no hooks, no built-in plugins, and no
 * auto-memory (it loads regardless of setting sources).
 */
export const FLAGS = {
  disableAllHooks: true,
  autoMemoryEnabled: false,
  enabledPlugins: {
    "agents-md@builtin": false,
    "telemetry@builtin": false,
    "cc-plugin-plugin-authoring@builtin": false,
  },
} as const satisfies Settings;

/** The child-env switch that keeps auto-memory off even where settings don't reach. */
export const AUTO_MEMORY_OFF = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as const;

/** CLI arguments that keep a direct command as isolated as an SDK session: safe mode, no setting files, no hooks or plugins. */
export function cliArgs(...command: string[]): string[] {
  return ["--safe-mode", "--setting-sources", "", "--settings", JSON.stringify(FLAGS), ...command];
}

/**
 * Variables that would route Claude somewhere Dum didn't choose: inherited API keys, gateways,
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

/** Everything except provider routes and inherited credentials. */
export function providerFreeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    const route = EXACT[upper] === true || PREFIXES.some((p) => upper.startsWith(p)) || /(?:^|_)API_KEY$/.test(upper);
    if (value !== undefined && !route) env[name] = value;
  }
  return env;
}

export type AuthStatus = { loggedIn?: boolean; authMethod?: string; apiProvider?: string };

const unverified = () => new Error("Claude couldn't report how it's signed in");

/**
 * Read provenance only; account fields are never returned, logged or sent. Asynchronous, so
 * main keeps drawing while the CLI answers.
 */
export async function authStatus(
  executable: string,
  env: NodeJS.ProcessEnv = { ...providerFreeEnv(process.env), ...AUTO_MEMORY_OFF },
): Promise<AuthStatus> {
  let stdout: string;
  try {
    const status = promisify(execFile)(executable, cliArgs("auth", "status"), {
      env, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
    });
    // Nothing is typed into it.
    status.child.stdin?.end();
    stdout = (await status).stdout;
  } catch (err) {
    // Signed out, the CLI still prints its status as JSON but exits 1: that is an answer, not a failure.
    const failed = err as { code?: unknown; killed?: boolean; stdout?: unknown };
    if (typeof failed.code !== "number" || failed.killed || typeof failed.stdout !== "string") throw unverified();
    stdout = failed.stdout;
  }
  let parsed: AuthStatus;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw unverified();
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.loggedIn !== "boolean") throw unverified();
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { loggedIn: parsed.loggedIn, authMethod: text(parsed.authMethod), apiProvider: text(parsed.apiProvider) };
}

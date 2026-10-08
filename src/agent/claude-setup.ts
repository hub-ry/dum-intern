// Claude setup in Electron main: the bundled executable and the user's own Anthropic API key, the
// only way Dum connects to Claude. Never opens a model session. Status carries booleans and a
// sentence; no key or CLI output is kept, logged or shown.

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { promisify } from "node:util";
import { BACKEND_LOGINS } from "./schema.ts";
import { AUTO_MEMORY_OFF, providerFreeEnv } from "./claude-cli.ts";
import type { BackendSetup, BackendStatus, LoginMethod } from "./types.ts";
import type { Credentials } from "../desktop/credentials.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The SDK's native binary packages for a platform, in the order the SDK itself tries them. */
export function bundledCandidates(platform: string, arch: string, musl: boolean): string[] {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const linux = [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`];
  const packages = platform === "linux" ? (musl ? linux.reverse() : linux) : [`${SDK_PACKAGE}-${platform}-${arch}`];
  return packages.map((p) => `${p}/${exe}`);
}

/**
 * The bundled binary's absolute path, or null when this build lacks it. There is no PATH
 * fallback. Inside a packaged app the module resolves into app.asar, which can't be executed;
 * the builder unpacks the binary beside it into app.asar.unpacked.
 */
export function bundledExecutable(
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = platform === "linux" && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime,
): string | null {
  for (const id of bundledCandidates(platform, arch, musl)) {
    try {
      const unpacked = resolve(id).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
      if (!isAbsolute(unpacked) || !statSync(unpacked).isFile()) continue;
      accessSync(unpacked, constants.X_OK);
      return unpacked;
    } catch {
      continue;
    }
  }
  return null;
}

/** An Anthropic API key's shape: printable ASCII, no whitespace, at most 256 characters. */
const KEY = /^[\x21-\x7e]{1,256}$/;

export type Probe = {
  /** True when the executable runs and answers --version. */
  version(executable: string, env: NodeJS.ProcessEnv): Promise<boolean>;
};

const run = promisify(execFile);

const systemProbe: Probe = {
  async version(executable, env) {
    try {
      await run(executable, ["--version"], { env, timeout: 15_000, maxBuffer: 16 * 1024 });
      return true;
    } catch {
      return false;
    }
  },
};

export class ClaudeSetup implements BackendSetup {
  readonly id = "claude";

  constructor(
    private readonly executable: string | null,
    private readonly credentials: Credentials,
    private readonly probe: Probe = systemProbe,
  ) {}

  async status(): Promise<BackendStatus> {
    const base = { id: "claude" as const, label: "Claude", methods: BACKEND_LOGINS.claude, loginRunning: false };
    if (this.executable === null) {
      return { ...base, installed: false, ready: null, message: "This build of Dum doesn't include Claude's runtime. Download a complete build of Dum, then Check again." };
    }
    // The CLI's env: no inherited routes or keys, auto-memory off. Main never hands it a key.
    const env = { ...providerFreeEnv(process.env), ...AUTO_MEMORY_OFF };
    if (!(await this.probe.version(this.executable, env))) {
      return { ...base, installed: false, ready: null, message: "Claude's bundled runtime is present but wouldn't start on this computer. Download a complete build of Dum, then Check again." };
    }
    return (await this.credentials.has("anthropic-key"))
      ? { ...base, installed: true, ready: "anthropic-key", message: "Using your Anthropic API key." }
      : { ...base, installed: true, ready: null, message: "Use an Anthropic API key to start." };
  }

  /** Claude has no sign-in: it connects only with the user's own Anthropic API key. */
  async login(method: LoginMethod): Promise<void> {
    if (method === "anthropic-key") throw new Error("Paste your Anthropic API key instead of signing in");
    throw new Error(`Claude doesn't sign in with ${method}`);
  }

  /** Store the key, write-only: nothing reads it back here and no message repeats it. */
  async setKey(key: string): Promise<void> {
    if (!KEY.test(key)) throw new Error("That doesn't look like an Anthropic API key");
    await this.credentials.set("anthropic-key", key);
  }

  /** No sign-in ever runs, so there is nothing to stop. */
  cancelLogin(): void {}

  /** Remove the stored key. */
  async signOut(method: LoginMethod): Promise<void> {
    if (method !== "anthropic-key") throw new Error(`Claude doesn't sign in with ${method}`);
    await this.credentials.delete("anthropic-key");
  }
}

export function claudeSetup(o: { executable: string | null; credentials: Credentials; probe?: Probe }): ClaudeSetup {
  return new ClaudeSetup(o.executable, o.credentials, o.probe);
}

// Claude setup in Electron main: the bundled executable, the Anthropic API key, and (local
// builds only) the subscription sign-in the bundled CLI offers. Never opens a model session.
// Status carries booleans and a sentence; no account field, token, key or CLI output is kept,
// logged or shown.

import { createRequire } from "node:module";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { promisify } from "node:util";
import { offeredLogins } from "./schema.ts";
import { AUTO_MEMORY_OFF, authStatus, cliArgs, providerFreeEnv, type AuthStatus } from "./claude-cli.ts";
import type { BackendSetup, BackendStatus, Flavor, LoginMethod, LoginUi } from "./types.ts";
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

/** Only an official sign-in page the CLI printed may be opened, and only on these hosts. */
const AUTH_HOSTS: Record<string, true> = { "claude.com": true, "claude.ai": true };
/** The OAuth code the sign-in page shows for pasting: URL-safe characters and `#`. */
const CODE = /^[A-Za-z0-9._~#-]{8,2048}$/;
/** An Anthropic API key's shape: printable ASCII, no whitespace, at most 256 characters. */
const KEY = /^[\x21-\x7e]{1,256}$/;
/** A sign-in nobody finishes stops on its own. */
const LOGIN_LIMIT_MS = 15 * 60_000;
/** Only enough output to find the page address and the paste prompt. */
const OUTPUT_LIMIT = 8192;

export type Probe = {
  /** True when the executable runs and answers --version. */
  version(executable: string, env: NodeJS.ProcessEnv): Promise<boolean>;
  auth(executable: string, env: NodeJS.ProcessEnv): Promise<AuthStatus>;
  /** `auth logout`; resolves when the CLI exits 0. */
  logout(executable: string, env: NodeJS.ProcessEnv): Promise<void>;
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
  auth: authStatus,
  async logout(executable, env) {
    await run(executable, cliArgs("auth", "logout"), { env, timeout: 15_000, maxBuffer: 64 * 1024 });
  },
};

export type Spawn = (executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
const spawnLogin: Spawn = (executable, args, env) => spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

export class ClaudeSetup implements BackendSetup {
  readonly id = "claude";
  private child: ChildProcess | null = null;
  private ui: LoginUi | null = null;
  private authUrl: string | null = null;
  private cancelled = false;
  private needsCode = false;
  private message = "";

  constructor(
    private readonly flavor: Flavor,
    private readonly executable: string | null,
    private readonly credentials: Credentials,
    private readonly probe: Probe = systemProbe,
    private readonly spawner: Spawn = spawnLogin,
  ) {}

  /** The CLI's env: no inherited routes or keys, auto-memory off. Main never hands it a key. */
  private env(): NodeJS.ProcessEnv {
    return { ...providerFreeEnv(process.env), ...AUTO_MEMORY_OFF };
  }

  private offers(method: LoginMethod): boolean {
    return offeredLogins(this.flavor, "claude").includes(method);
  }

  async status(): Promise<BackendStatus> {
    const methods = offeredLogins(this.flavor, "claude");
    const base = { id: "claude" as const, label: "Claude", methods, loginRunning: this.child !== null, loginNeedsCode: this.needsCode };
    // A running or stopped sign-in speaks for itself until the next one starts.
    const say = (text: string) => this.message || text;
    if (this.executable === null) {
      return { ...base, installed: false, ready: null, message: "This build of Dum doesn't include Claude's runtime. Download a complete build of Dum, then Check again." };
    }
    const env = this.env();
    if (!(await this.probe.version(this.executable, env))) {
      return { ...base, installed: false, ready: null, message: "Claude's bundled runtime is present but wouldn't start on this computer. Download a complete build of Dum, then Check again." };
    }
    const key = await this.credentials.has("anthropic-key");
    if (this.offers("claude-subscription")) {
      let auth: AuthStatus;
      try {
        auth = await this.probe.auth(this.executable, env);
      } catch {
        return { ...base, installed: true, ready: key ? "anthropic-key" : null, message: say("Claude couldn't report whether you're signed in. Check again.") };
      }
      if (auth.loggedIn === true && auth.authMethod === "claude.ai" && auth.apiProvider === "firstParty") {
        return { ...base, installed: true, ready: "claude-subscription", message: say("Signed in with your Claude subscription.") };
      }
      if (!key) {
        const other = auth.loggedIn
          ? `Claude is signed in another way (${auth.apiProvider === "firstParty" ? auth.authMethod ?? "unknown" : auth.apiProvider ?? "unknown route"}), not with a Claude subscription. `
          : "";
        return { ...base, installed: true, ready: null, message: say(`${other}Sign in with Claude, or use an Anthropic API key.`) };
      }
    }
    return key
      ? { ...base, installed: true, ready: "anthropic-key", message: say("Using your Anthropic API key.") }
      : { ...base, installed: true, ready: null, message: say("Use an Anthropic API key to start.") };
  }

  /** Start the official subscription sign-in with the bundled CLI (local builds only). */
  async login(method: LoginMethod, ui: LoginUi): Promise<void> {
    if (method === "claude-subscription" && !this.offers(method)) throw new Error("This build of Dum doesn't sign in with a Claude subscription. Use an Anthropic API key.");
    if (method === "anthropic-key") throw new Error("Paste your Anthropic API key instead of signing in");
    if (method !== "claude-subscription") throw new Error(`Claude doesn't sign in with ${method}`);
    if (this.executable === null) throw new Error("This build of Dum doesn't include Claude's runtime");
    if (this.child) throw new Error("Sign-in is already running - finish it in your browser, or cancel it");
    const child = this.spawner(this.executable, cliArgs("auth", "login", "--claudeai"), this.env());
    this.child = child;
    this.ui = ui;
    this.cancelled = false;
    this.needsCode = false;
    this.authUrl = null;
    let seen = "";
    const limit = setTimeout(() => this.cancelLogin(), LOGIN_LIMIT_MS);
    limit.unref();
    const read = (chunk: Buffer) => {
      if (this.child !== child) return;
      // Never stored beyond this window or logged.
      seen = (seen + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
      if (!this.authUrl) {
        for (const match of seen.matchAll(/https:\/\/[^\s"'<>]+/g)) {
          try {
            const url = new URL(match[0]);
            if (url.protocol === "https:" && AUTH_HOSTS[url.hostname] && !url.username && !url.password && !url.port) {
              this.authUrl = url.href;
              break;
            }
          } catch {
            // not a URL
          }
        }
      }
      if (!this.needsCode && /paste code/i.test(seen)) {
        this.needsCode = true;
        ui.changed();
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.stdin?.on("error", () => {});
    const finish = (code: number | null, failed: boolean) => {
      if (this.child !== child) return;
      clearTimeout(limit);
      this.child = null;
      this.ui = null;
      this.authUrl = null;
      this.needsCode = false;
      seen = "";
      // A finished browser flow isn't a sign-in: status() checks it again with the CLI.
      this.message = this.cancelled
        ? "Sign-in cancelled."
        : failed || code !== 0
          ? "Sign-in didn't finish. Try again; if your browser didn't open, use Open sign-in page."
          : "";
      ui.changed();
    };
    child.once("error", () => finish(null, true));
    child.once("exit", (code) => finish(code, false));
    this.message = "Finish signing in to Claude in your browser. Dum continues when Claude confirms it.";
    ui.changed();
  }

  /** Open the sign-in page the running CLI printed, for a person whose browser didn't open. */
  async openPage(): Promise<void> {
    if (!this.child || !this.ui) throw new Error("Sign-in isn't running");
    if (!this.authUrl) throw new Error("Claude hasn't shown a sign-in page yet - wait a moment and try again");
    await this.ui.openUrl(this.authUrl);
  }

  /** Hand a code from the sign-in page to the waiting CLI. It goes to the CLI's input only. */
  code(code: string): void {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) throw new Error("Sign-in isn't waiting for a code");
    const trimmed = code.trim();
    if (!CODE.test(trimmed)) throw new Error("That doesn't look like a sign-in code - copy the whole code from the sign-in page");
    child.stdin.write(`${trimmed}\n`);
    this.message = "Code sent to Claude. Waiting for it to confirm…";
    this.ui?.changed();
  }

  /** Store the key, write-only: nothing reads it back here and no message repeats it. */
  async setKey(key: string): Promise<void> {
    if (!KEY.test(key)) throw new Error("That doesn't look like an Anthropic API key");
    await this.credentials.set("anthropic-key", key);
  }

  /** Stop a running sign-in; nothing changes and the CLI ends: SIGTERM, then SIGKILL after 3 seconds. */
  cancelLogin(): void {
    const child = this.child;
    if (!child) return;
    this.cancelled = true;
    child.kill("SIGTERM");
    const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
    hard.unref();
  }

  /** Remove only this method's credential. */
  async signOut(method: LoginMethod): Promise<void> {
    if (!this.offers(method)) throw new Error(`Claude doesn't sign in with ${method} in this build`);
    if (method === "anthropic-key") {
      await this.credentials.delete("anthropic-key");
      return;
    }
    if (this.executable === null) throw new Error("This build of Dum doesn't include Claude's runtime");
    try {
      await this.probe.logout(this.executable, this.env());
    } catch {
      throw new Error("Claude didn't sign out. Check again.");
    }
  }
}

export function claudeSetup(o: { flavor: Flavor; executable: string | null; credentials: Credentials; probe?: Probe; spawn?: Spawn }): ClaudeSetup {
  return new ClaudeSetup(o.flavor, o.executable, o.credentials, o.probe, o.spawn);
}

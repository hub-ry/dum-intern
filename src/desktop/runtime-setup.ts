// First-launch setup without a terminal: the Claude executable bundled in the app, the
// subscription sign-in it offers, and the Git that project tools need. Status carries booleans
// and a sentence; no account field, token, email or CLI output is kept, logged or shown.

import { createRequire } from "node:module";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { promisify } from "node:util";
import { cliArgs, login, subscriptionEnv } from "../runtime.ts";
import type { RuntimeStatus } from "./protocol.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The SDK's native binary packages for a platform, in the order the SDK itself tries them. */
export function bundledCandidates(platform: string, arch: string, musl: boolean): string[] {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const linux = [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`];
  const packages = platform === "linux" ? (musl ? linux.reverse() : linux) : [`${SDK_PACKAGE}-${platform}-${arch}`];
  return packages.map((p) => `${p}/${exe}`);
}

/**
 * The bundled binary's absolute path. Inside a packaged app the module resolves into app.asar,
 * which can't be executed; the builder unpacks the binary beside it into app.asar.unpacked.
 */
export function resolveBundled(
  resolve: (id: string) => string,
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = platform === "linux" && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime,
): string {
  for (const id of bundledCandidates(platform, arch, musl)) {
    let path: string;
    try {
      path = resolve(id);
    } catch {
      continue;
    }
    const unpacked = path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
    try {
      if (!isAbsolute(unpacked) || !statSync(unpacked).isFile()) continue;
      accessSync(unpacked, constants.X_OK);
      return unpacked;
    } catch {
      continue;
    }
  }
  throw new Error(`this build of dum doesn't include Claude's runtime for ${platform}-${arch}`);
}

let resolved: { path: string } | { error: string } | null = null;

/** The trusted bundled Claude executable, resolved once. Throws when the build lacks it; there is no PATH fallback. */
export function runtimeExecutable(): string {
  if (!resolved) {
    try {
      resolved = { path: resolveBundled(createRequire(import.meta.url).resolve) };
    } catch (err) {
      resolved = { error: (err as Error).message };
    }
  }
  if ("error" in resolved) throw new Error(resolved.error);
  return resolved.path;
}

/** Only an official sign-in page the CLI printed may be opened, and only on these hosts. */
const AUTH_HOSTS: Record<string, true> = { "claude.com": true, "claude.ai": true };
/** The OAuth code the sign-in page shows for pasting: URL-safe characters and `#`. */
const CODE = /^[A-Za-z0-9._~#-]{8,2048}$/;
/** A sign-in nobody finishes stops on its own. */
const LOGIN_LIMIT_MS = 15 * 60_000;
const MAC_TOOLS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export type Probe = {
  /** True when the executable runs and answers --version. */
  version(executable: string): Promise<boolean>;
  auth(executable: string): Promise<{ loggedIn?: boolean; authMethod?: string; apiProvider?: string }>;
  git(): Promise<boolean>;
};

const run = promisify(execFile);

/**
 * Git that works without prompting. On macOS /usr/bin/git is a shim that pops Apple's installer
 * when the Command Line Tools are missing, so `xcode-select -p` must succeed before it is run.
 */
async function gitWorks(platform: string): Promise<boolean> {
  try {
    if (platform === "darwin") {
      await run("/usr/bin/xcode-select", ["-p"], { timeout: 10_000 });
      await run("/usr/bin/git", ["--version"], { timeout: 10_000, env: { ...process.env, PATH: MAC_TOOLS_PATH } });
    } else {
      await run("git", ["--version"], { timeout: 10_000 });
    }
    return true;
  } catch {
    return false;
  }
}

export function systemProbe(platform: string = process.platform): Probe {
  return {
    async version(executable) {
      try {
        await run(executable, ["--version"], { env: subscriptionEnv(), timeout: 15_000, maxBuffer: 16 * 1024 });
        return true;
      } catch {
        return false;
      }
    },
    auth: (executable) => login(executable),
    git: () => gitWorks(platform),
  };
}

export type Spawn = (executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
const spawnLogin: Spawn = (executable, args, env) => spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

export class RuntimeSetup {
  status: RuntimeStatus;
  private child: ChildProcess | null = null;
  private authUrl: string | null = null;
  private cancelled = false;
  private checking: Promise<void> | null = null;

  /** `executable` is the resolved bundled binary, or the reason it couldn't be found. */
  constructor(
    private readonly executable: { path: string } | { error: string },
    private readonly onChange: () => void,
    private readonly probe: Probe = systemProbe(),
    private readonly platform: string = process.platform,
    private readonly spawner: Spawn = spawnLogin,
  ) {
    this.status = { available: false, authenticated: false, loginRunning: false, loginNeedsCode: false, gitAvailable: false, message: "Checking Claude and Git…" };
  }

  private set(patch: Partial<RuntimeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange();
  }

  /** Re-read what's installed and whether the subscription is signed in. Concurrent checks share one run. */
  check(): Promise<void> {
    this.checking ??= this.inspect().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async inspect(): Promise<void> {
    const gitAvailable = await this.probe.git();
    if ("error" in this.executable) {
      this.set({ available: false, authenticated: false, gitAvailable, message: `${this.executable.error}. Download a complete build of dum; it doesn't use a separately installed claude.` });
      return;
    }
    const path = this.executable.path;
    if (!(await this.probe.version(path))) {
      this.set({ available: false, authenticated: false, gitAvailable, message: "Claude's bundled runtime is present but wouldn't start on this computer." });
      return;
    }
    let auth: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    try {
      auth = await this.probe.auth(path);
    } catch {
      this.set({ available: true, authenticated: false, gitAvailable, message: "Claude couldn't report whether you're signed in. Try Check again." });
      return;
    }
    const authenticated = auth.loggedIn === true && auth.authMethod === "claude.ai" && auth.apiProvider === "firstParty";
    const tools = gitAvailable ? "" : this.platform === "darwin"
      ? " Project tools need Git: install Apple's Command Line Tools."
      : " Project tools need Git: install it with your system's package manager.";
    const message = authenticated
      ? `Signed in with your Claude subscription.${tools}`
      : auth.loggedIn
        ? `Claude is signed in another way (${auth.apiProvider === "firstParty" ? auth.authMethod ?? "unknown" : auth.apiProvider ?? "unknown route"}), not with a Claude subscription. Sign in with your subscription to use dum.${tools}`
        : `Sign in with your Claude subscription to start. dum never uses API keys or paid usage.${tools}`;
    if (!this.child) this.set({ available: true, authenticated, gitAvailable, message });
    else this.set({ available: true, authenticated, gitAvailable });
  }

  /** Start the official subscription sign-in with the bundled CLI. It opens the browser itself. */
  login(): void {
    if ("error" in this.executable) throw new Error(this.executable.error);
    if (this.child) throw new Error("Sign-in is already running - finish it in your browser, or cancel it");
    const child = this.spawner(this.executable.path, cliArgs("auth", "login", "--claudeai"), subscriptionEnv());
    this.child = child;
    this.cancelled = false;
    this.authUrl = null;
    let seen = "";
    const limit = setTimeout(() => this.cancel(), LOGIN_LIMIT_MS);
    limit.unref();
    const read = (chunk: Buffer) => {
      if (this.child !== child) return;
      // Only enough to find the page address and the paste prompt; never stored beyond that or logged.
      seen = (seen + chunk.toString("utf8")).slice(-8192);
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
      if (!this.status.loginNeedsCode && /paste code/i.test(seen)) this.set({ loginNeedsCode: true });
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.stdin?.on("error", () => {});
    const finish = (code: number | null, failed: boolean) => {
      if (this.child !== child) return;
      clearTimeout(limit);
      this.child = null;
      this.authUrl = null;
      seen = "";
      const message = this.cancelled
        ? "Sign-in cancelled."
        : failed || code !== 0
          ? "Sign-in didn't finish. Try again; if your browser didn't open, use Open sign-in page."
          : "Sign-in finished. Checking it with Claude…";
      this.set({ loginRunning: false, loginNeedsCode: false, message });
      if (!this.cancelled && !failed && code === 0) void this.check();
    };
    child.once("error", () => finish(null, true));
    child.once("exit", (code) => finish(code, false));
    this.set({ loginRunning: true, loginNeedsCode: false, message: "Finish signing in to Claude in your browser. dum continues when Claude confirms it." });
  }

  /** The sign-in page the running CLI printed, for a person whose browser didn't open. */
  loginPage(): string {
    if (!this.child) throw new Error("Sign-in isn't running");
    if (!this.authUrl) throw new Error("Claude hasn't shown a sign-in page yet - wait a moment and try again");
    return this.authUrl;
  }

  /** Hand a code from the sign-in page to the waiting CLI. It goes to the CLI's input only. */
  code(code: string): void {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) throw new Error("Sign-in isn't waiting for a code");
    const trimmed = code.trim();
    if (!CODE.test(trimmed)) throw new Error("That doesn't look like a sign-in code - copy the whole code from the sign-in page");
    child.stdin.write(`${trimmed}\n`);
    this.set({ message: "Code sent to Claude. Waiting for it to confirm…" });
  }

  /** Stop a running sign-in; nothing is changed and the CLI process ends. */
  cancel(): void {
    const child = this.child;
    if (!child) return;
    this.cancelled = true;
    child.kill("SIGTERM");
    const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
    hard.unref();
  }

  /** macOS only, and only when asked: show Apple's own Command Line Tools installer. Never a shell. */
  async gitSetup(): Promise<void> {
    if (this.platform !== "darwin") throw new Error("Install Git with your system's package manager; dum doesn't install system tools here.");
    if (this.status.gitAvailable) {
      this.set({ message: "Git is already available." });
      return;
    }
    try {
      await run("/usr/bin/xcode-select", ["--install"], { timeout: 30_000 });
      this.set({ message: "Apple's installer is open. When it finishes, choose Check again." });
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      if (!/already installed/i.test(stderr)) throw new Error("Apple's Command Line Tools installer didn't open. Try again, or install them from developer.apple.com.");
      this.set({ message: "Command Line Tools are already installed. Choose Check again." });
    }
  }
}

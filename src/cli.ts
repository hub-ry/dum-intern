// The `dum` command on hub.
//
//   dum status                 goals, recent creations, approvals and handoffs at a glance
//   dum mcp                    serve Dum's MCP tools on stdin/stdout (what agents launch)
//   dum mcp install            register Dum with every agent on hub: Codex, omp, Claude Code
//   dum mcp laptop             print the one-time setup for Claude on the laptop
//   dum codex-mcp              serve a `codex` tool that hands tasks to the Codex agent (for omp)
//   dum live pause|resume      stop or restart hub's screen streaming into Discord
//
// Agents run `dum mcp` themselves; nothing listens on the network.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadClientConfig, workshopClient } from "./client/workshop.ts";
import { createMcp, serveLines, serveStdio, type Deps } from "./mcp/server.ts";
import { createCodexMcp } from "./mcp/codex.ts";
import { DEFAULT_REQUESTS_DIR } from "./shared/requests.ts";
import { DEFAULT_HANDOFF_DIR } from "./shared/handoff.ts";
import { DEFAULT_POSTS_DIR } from "./shared/file-posts.ts";
import { DEFAULT_LOCK, holder, release, tryTake } from "./shared/lock.ts";
import { ship } from "./shared/ship.ts";
import { clearPause, DEFAULT_PAUSE, readPause, writePause } from "./live/pause.ts";
import { pausedNow } from "./live/live.ts";

const HOME = homedir();
/** The stable path agents launch, a symlink to bin/dum in this checkout. */
export const DUM_BIN = join(HOME, ".local", "bin", "dum");

function deps(): Deps {
  const config = loadClientConfig();
  return {
    workshop: workshopClient(config),
    requestsDir: process.env.DUM_REQUESTS_DIR?.trim() || DEFAULT_REQUESTS_DIR,
    handoffDir: process.env.DUM_HANDOFF_DIR?.trim() || DEFAULT_HANDOFF_DIR,
    appUrl: process.env.DUM_PUBLIC_URL?.trim() || config.baseUrl,
    postsDir: process.env.DUM_POSTS_DIR?.trim() || DEFAULT_POSTS_DIR,
    ...(chatSource() !== undefined ? { chatSource: chatSource() } : {}),
    ...(process.env.DUM_CHAT_FILES_DIR?.trim() ? { chat: { filesDir: process.env.DUM_CHAT_FILES_DIR.trim(), goalId: process.env.DUM_CHAT_GOAL_ID?.trim() || null } } : {}),
  };
}

/** Dum's Discord chat passes Ryan's message in a private file so teaching can be checked against it. */
function chatSource(): string | undefined {
  const path = process.env.DUM_CHAT_SOURCE_FILE?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// --- Registering with agents ----------------------------------------------------------------

type Target = { name: string; found: boolean; install(): string };

function findCodex(): string | null {
  const candidates = [join(HOME, ".local", "bin", "codex"), "/usr/local/bin/codex"];
  try {
    for (const v of execFileSync("bash", ["-c", "ls -d ~/.nvm/versions/node/*/bin/codex 2>/dev/null || true"], { encoding: "utf8" }).split("\n")) if (v.trim()) candidates.unshift(v.trim());
  } catch {}
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Adds or replaces entries in an mcpServers JSON file, keeping everything else. */
export function mergeMcpJson(text: string | null, entries: Record<string, { command: string; args: string[] }>): string {
  const doc = text?.trim() ? (JSON.parse(text) as { mcpServers?: Record<string, unknown> }) : {};
  doc.mcpServers = { ...(doc.mcpServers ?? {}), ...entries };
  return JSON.stringify(doc, null, 2) + "\n";
}

function writeJsonFile(path: string, text: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function targets(): Target[] {
  const codex = findCodex();
  const ompDir = join(HOME, ".omp", "agent");
  const claude = ["/usr/local/bin/claude", join(HOME, ".local", "bin", "claude")].find((c) => existsSync(c)) ?? null;
  return [
    {
      name: "Codex",
      found: !!codex,
      install() {
        const env = { ...process.env, PATH: `${resolve(codex!, "..")}:${process.env.PATH ?? ""}` };
        try {
          execFileSync(codex!, ["mcp", "remove", "dum"], { env, stdio: "ignore" });
        } catch {}
        execFileSync(codex!, ["mcp", "add", "dum", "--", DUM_BIN, "mcp"], { env, stdio: "ignore" });
        return "codex mcp add dum";
      },
    },
    {
      name: "omp",
      found: existsSync(ompDir),
      install() {
        const path = join(ompDir, "mcp.json");
        // omp also gets Codex as a tool, so it can hand tasks to the Codex agent.
        const entries = { dum: { command: DUM_BIN, args: ["mcp"] }, ...(codex ? { codex: { command: DUM_BIN, args: ["codex-mcp"] } } : {}) };
        writeJsonFile(path, mergeMcpJson(existsSync(path) ? readFileSync(path, "utf8") : null, entries));
        return `${path.replace(HOME, "~")}: ${Object.keys(entries).join(" and ")}`;
      },
    },
    {
      name: "Claude Code",
      found: !!claude,
      install() {
        try {
          execFileSync(claude!, ["mcp", "remove", "--scope", "user", "dum"], { stdio: "ignore" });
        } catch {}
        execFileSync(claude!, ["mcp", "add", "--scope", "user", "dum", "--", DUM_BIN, "mcp"], { stdio: "ignore" });
        return "claude mcp add --scope user dum";
      },
    },
  ];
}

function laptopSetup(): string {
  const ssh = `ssh -o BatchMode=yes hub ${DUM_BIN} mcp`;
  return [
    "Claude on the laptop reaches Dum through ssh, so nothing new listens on the network.",
    "",
    "Claude Code (terminal or the desktop app's Code tab):",
    `  claude mcp add --scope user dum -- ${ssh}`,
    "",
    "Claude desktop app (chat): add this under mcpServers in",
    "~/Library/Application Support/Claude/claude_desktop_config.json, then restart the app:",
    JSON.stringify({ dum: { command: "/usr/bin/ssh", args: ["-o", "BatchMode=yes", "hub", DUM_BIN, "mcp"] } }, null, 2),
  ].join("\n");
}

// --- Entry ----------------------------------------------------------------------------------

const HELP = `dum: Dum's command line on hub

  dum status            goals, recent creations, approvals and handoffs
  dum mcp               serve Dum's MCP tools on stdio (agents launch this)
  dum mcp install       register Dum with Codex, omp and Claude Code on hub
  dum mcp laptop        print the setup for Claude on the laptop
  dum codex-mcp         serve one tool, codex, that hands a task to the Codex agent (omp uses it)
  dum lock take NAME    wait for and take the lock on Dum's own code (the engineer uses it)
  dum lock release NAME let it go
  dum ship "MESSAGE"    typecheck, test, commit as Ryan and push Dum's own code to GitHub main
  dum live pause [MIN]  stop streaming hub's screen to #hub-live for MIN minutes (60; 0 until resumed)
                        before anything private (an address, a birthday, personal answers) is on screen
  dum live resume       stream again
  dum live status       whether it's paused`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub] = argv;
  if (cmd === "mcp" && !sub) {
    await serveStdio(deps());
    return 0;
  }
  if (cmd === "mcp" && sub === "install") {
    if (!existsSync(DUM_BIN)) throw new Error(`${DUM_BIN} is missing. Link it first: ln -s ${resolve(import.meta.dirname, "..", "bin", "dum")} ${DUM_BIN}`);
    for (const t of targets()) {
      if (!t.found) {
        console.log(`- ${t.name}: not installed here, skipped`);
        continue;
      }
      try {
        console.log(`- ${t.name}: registered (${t.install()})`);
      } catch (err) {
        console.log(`- ${t.name}: failed: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    console.log(`\nAll of them launch ${DUM_BIN.replace(HOME, "~")} mcp. For the laptop: dum mcp laptop`);
    return 0;
  }
  if (cmd === "ship") {
    console.log(ship(resolve(import.meta.dirname, ".."), argv.slice(1).join(" ")));
    return 0;
  }
  if (cmd === "lock") {
    const who = (argv[2] ?? "").trim();
    if (sub === "status") {
      const h = holder(DEFAULT_LOCK);
      console.log(h ? `held by ${h.who} since ${h.at}` : "free");
      return 0;
    }
    if (!who) throw new Error("Name the lock holder: dum lock take <name>");
    if (sub === "release") {
      console.log(release(DEFAULT_LOCK, who) ? "released" : "not held by you");
      return 0;
    }
    if (sub === "take") {
      const deadline = Date.now() + 25 * 60_000;
      for (let waited = false; ; waited = true) {
        const r = tryTake(DEFAULT_LOCK, who);
        if (r.ok) {
          console.log(waited ? "locked (after waiting)" : "locked");
          return 0;
        }
        if (Date.now() > deadline) {
          console.log(`still held by ${r.holder.who} since ${r.holder.at}; gave up waiting`);
          return 1;
        }
        if (!waited) console.log(`waiting: ${r.holder.who} is changing Dum's code`);
        await new Promise((ok) => setTimeout(ok, 5000));
      }
    }
  }
  if (cmd === "live") {
    if (sub === "pause") {
      const minutes = argv[2] === undefined ? 60 : Number(argv[2]);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error("Minutes must be a number, 0 for until resumed: dum live pause 30");
      const p = writePause(DEFAULT_PAUSE, minutes);
      console.log(p.until ? `paused until ${new Date(p.until).toLocaleTimeString()}` : "paused until dum live resume");
      return 0;
    }
    if (sub === "resume") {
      clearPause(DEFAULT_PAUSE);
      console.log("streaming again");
      return 0;
    }
    if (sub === "status" || !sub) {
      const p = readPause(DEFAULT_PAUSE);
      console.log(!pausedNow(p, Date.now()) ? "streaming (when the screen changes)" : p!.until ? `paused until ${new Date(p!.until).toLocaleTimeString()}` : "paused until dum live resume");
      return 0;
    }
  }
  if (cmd === "codex-mcp") {
    await serveLines(createCodexMcp());
    return 0;
  }
  if (cmd === "mcp" && sub === "laptop") {
    console.log(laptopSetup());
    return 0;
  }
  if (cmd === "status") {
    const result = await createMcp(deps()).call("dum_overview", {});
    console.log(result.content[0]!.text);
    return result.isError ? 1 : 0;
  }
  console.log(HELP);
  return cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`dum: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}

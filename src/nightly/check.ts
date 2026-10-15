// `node --import tsx src/nightly/check.ts`: the nightly health check (deploy/dum-nightly.timer).
//
// Takes a fresh copy of GitHub main into its own clone, runs `npm ci`, the typecheck, the tests
// and a build of the verifier image, then posts one line to the Discord lobby. Read-only toward
// everything that matters: it never touches the deployed checkout, the workshop home, or the
// `dum-workshop-browser:1` tag the service runs (the image is built under its own tag). Nothing
// here calls a model.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rest } from "../discord/rest.ts";
import { HOME_TZ } from "../shared/clock.ts";

export type Step = { name: string; ok: boolean; ms: number; tail: string };

export const NIGHTLY_IMAGE = "dum-workshop-browser:nightly";
const STEP_TIMEOUT_MS = 20 * 60_000;

/** The one Discord line. Mentions the owner only when something failed. */
export function summarize(input: { sha: string; steps: Step[]; log: string; owner?: string }): { content: string; failed: boolean } {
  const failed = input.steps.find((s) => !s.ok);
  const total = Math.round(input.steps.reduce((n, s) => n + s.ms, 0) / 1000);
  const parts = input.steps.map((s) => `${s.name} ${s.ok ? "ok" : "FAILED"}`);
  if (failed) {
    const head = input.owner ? `<@${input.owner}> ` : "";
    return { failed: true, content: `${head}nightly ${input.sha}: ${parts.join(" · ")} (${total}s). Log: ${input.log}` };
  }
  return { failed: false, content: `nightly ${input.sha}: ${parts.join(" · ")} (${total}s)` };
}

type Run = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => { ok: boolean; out: string };

const run: Run = (cmd, args, cwd, env) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { ok: r.status === 0 && !r.error, out };
};

/** Brings `dir` to a clean copy of origin/main. Clones on first use. Returns the short sha. */
export function freshMain(dir: string, remote: string, exec: Run = run): string {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(resolve(dir, ".."), { recursive: true });
    const c = exec("git", ["clone", "--quiet", "--branch", "main", remote, dir], resolve(dir, ".."));
    if (!c.ok) throw new Error(`clone failed: ${c.out.slice(-800)}`);
  }
  for (const args of [["fetch", "--quiet", "origin", "main"], ["checkout", "--quiet", "--detach", "origin/main"], ["clean", "-fdxq", "-e", "node_modules"]]) {
    const r = exec("git", args, dir);
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.out.slice(-800)}`);
  }
  return exec("git", ["rev-parse", "--short", "HEAD"], dir).out.trim();
}

/** Runs the steps in order and stops at the first failure. */
export function runSteps(dir: string, exec: Run = run): Step[] {
  const plan: [string, string, string[]][] = [
    ["npm ci", "npm", ["ci", "--silent", "--no-audit", "--no-fund"]],
    ["typecheck", "npm", ["run", "typecheck", "--silent"]],
    ["tests", "npm", ["test", "--silent"]],
    ["docker", "docker", ["build", "--quiet", "-f", "src/workshop/publisher.Dockerfile", "-t", NIGHTLY_IMAGE, "."]],
  ];
  const steps: Step[] = [];
  for (const [name, cmd, args] of plan) {
    const t0 = Date.now();
    const r = exec(cmd, args, dir);
    steps.push({ name, ok: r.ok, ms: Date.now() - t0, tail: r.out.slice(-4000) });
    if (!r.ok) break;
  }
  return steps;
}

async function main(): Promise<number> {
  const env = process.env;
  const base = env.DUM_NIGHTLY_DIR?.trim() || join(homedir(), ".local/state/dum-nightly");
  const deployed = resolve(import.meta.dirname, "..", "..");
  const remote = env.DUM_NIGHTLY_REMOTE?.trim() || run("git", ["remote", "get-url", "origin"], deployed).out.trim();
  const repo = join(base, "repo");
  const logs = join(base, "logs");
  mkdirSync(logs, { recursive: true });
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: HOME_TZ });
  const log = join(logs, `${day}.log`);

  let sha = "?";
  let steps: Step[];
  try {
    sha = freshMain(repo, remote);
    steps = runSteps(repo);
  } catch (err) {
    steps = [{ name: "checkout", ok: false, ms: 0, tail: String(err) }];
  }
  writeFileSync(log, steps.map((s) => `== ${s.name}: ${s.ok ? "ok" : "FAILED"} (${Math.round(s.ms / 1000)}s)\n${s.tail}\n`).join("\n"), { mode: 0o600 });

  const owner = env.DUM_DISCORD_OWNER_ID;
  const { content, failed } = summarize({ sha, steps, log, ...(owner ? { owner } : {}) });
  console.log(content);
  const tokenFile = env.DUM_DISCORD_TOKEN_FILE;
  const channel = env.DUM_DISCORD_CHANNEL_ID;
  if (tokenFile && channel) {
    await rest(readFileSync(tokenFile, "utf8").trim())("POST", `/channels/${channel}/messages`, { content, allowed_mentions: { users: owner ? [owner] : [] } });
  } else {
    console.error("not posted: DUM_DISCORD_TOKEN_FILE or DUM_DISCORD_CHANNEL_ID is unset");
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(2);
  });
}

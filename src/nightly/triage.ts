// `node --import tsx src/nightly/triage.ts`: the weekly issue triage (deploy/dum-triage.timer).
//
// A read-only model pass over the open GitHub issues, run inside the nightly clone of main (never
// the deployed checkout). It writes one Markdown draft per week under the nightly state dir and
// posts the path to the lobby. It files nothing, edits nothing, and comments nowhere: Ryan reads
// the draft and decides. Cheap model, low effort: this is bookkeeping, not design.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rest } from "../discord/rest.ts";
import { HOME_TZ } from "../shared/clock.ts";

const TIMEOUT_MS = 25 * 60_000;

export const TRIAGE_PROMPT = `You are triaging the open GitHub issues of this repository (the checkout you are in is a fresh copy of main). Read CLAUDE.md first.

Do, in this order:
1. \`gh issue list --state open --json number,title,body,updatedAt\` to get every open issue.
2. For each issue: list the files, symbols and tests it names, and check each one exists in this checkout (Glob/Grep). If the issue names a test file or test title as its acceptance, run only that file with \`node --import tsx --import ./src/shared/test-isolation.ts --test <file>\` and report pass/fail. Classify the issue as one of: ready (spec matches the code, acceptance is mechanical), stale (names files or behaviour that no longer exist), vague (no mechanical acceptance), done (its acceptance already passes on main).
3. Grep src/ for TODO, FIXME and XXX. For each, draft an issue: title, the file:line, one paragraph of what is missing, and an acceptance criterion an agent can check (a named test, a typecheck, an observed command output). Skip anything that is a note rather than missing work.

Write the result as Markdown with three sections: "## Open issues" (one bullet per issue: number, title, classification, the stale references or the test result, one line on what would make it ready), "## Draft issues" (the drafts from step 3), "## Notes" (anything odd you saw, or "nothing"). Keep it under 150 lines. Plain words.

You must not: create, edit, close or comment on issues; edit any file; run the full test suite; restart anything. Reading and the single-file test runs above are the whole job.`;

/** Builds the `claude -p` argv. Read-only: the agent can read, search, run gh reads and single test files, nothing else. */
export function triageArgs(model: string | null): string[] {
  return [
    "-p",
    TRIAGE_PROMPT,
    "--output-format",
    "text",
    "--effort",
    "low",
    "--tools",
    "Read,Grep,Glob,Bash",
    "--allowedTools",
    ["Read", "Grep", "Glob", "Bash(gh issue list:*)", "Bash(gh issue view:*)", "Bash(node --import tsx --import ./src/shared/test-isolation.ts --test *)", "Bash(git log:*)", "Bash(git rev-parse:*)"].join(","),
    "--disallowedTools",
    ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(gh issue create:*)", "Bash(gh issue edit:*)", "Bash(gh issue close:*)", "Bash(gh issue comment:*)", "Bash(gh pr:*)", "Bash(git push:*)", "Bash(git commit:*)", "Bash(systemctl:*)", "Bash(systemd-run:*)", "Bash(npm:*)", "Bash(npx:*)"].join(","),
    "--strict-mcp-config",
    "--setting-sources",
    "user",
    "--disable-slash-commands",
    ...(model ? ["--model", model] : []),
  ];
}

async function main(): Promise<number> {
  const env = process.env;
  const base = env.DUM_NIGHTLY_DIR?.trim() || join(homedir(), ".local/state/dum-nightly");
  const repo = join(base, "repo");
  const out = join(base, "triage");
  mkdirSync(out, { recursive: true });
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: HOME_TZ });
  const file = join(out, `${day}.md`);
  const claude = env.DUM_CLAUDE_EXECUTABLE?.trim() || "/usr/local/bin/claude";
  const model = env.DUM_TRIAGE_MODEL?.trim() || null;

  const r = spawnSync(claude, triageArgs(model), { cwd: repo, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const ok = r.status === 0 && !r.error && r.stdout.trim().length > 0;
  const body = ok ? r.stdout : `# Triage failed\n\n${r.stderr}\n${r.error?.message ?? ""}`;
  writeFileSync(file, `# Issue triage ${day} (main ${sha})\n\nDraft only. Nothing was filed, edited or commented.\n\n${body}\n`, { mode: 0o600 });

  const content = ok ? `weekly triage ${sha}: draft at ${file}` : `${env.DUM_DISCORD_OWNER_ID ? `<@${env.DUM_DISCORD_OWNER_ID}> ` : ""}weekly triage ${sha}: FAILED, see ${file}`;
  console.log(content);
  const tokenFile = env.DUM_DISCORD_TOKEN_FILE;
  const channel = env.DUM_DISCORD_CHANNEL_ID;
  if (tokenFile && channel) {
    await rest(readFileSync(tokenFile, "utf8").trim())("POST", `/channels/${channel}/messages`, { content, allowed_mentions: { users: env.DUM_DISCORD_OWNER_ID ? [env.DUM_DISCORD_OWNER_ID] : [] } });
  } else {
    console.error("not posted: DUM_DISCORD_TOKEN_FILE or DUM_DISCORD_CHANNEL_ID is unset");
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(2);
  });
}

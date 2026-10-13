// `dum ship "message"`: put Dum's own working changes on GitHub. Checks first (typecheck, tests,
// nothing credential-shaped in what's being added), then one commit as Ryan and a fast-forward
// push to main. Never forces, never rewrites history, and never lists an AI as an author or
// co-author: Ryan's rule is that Claude must not show up as a contributor.

import { execFileSync } from "node:child_process";

export const AUTHOR = { name: "hub-ry", email: "rhubbart@purdue.edu" };
export const REMOTE = "origin";
export const BRANCH = "main";

const AI_TRAILER = /^\s*co-authored-by:.*\b(claude|anthropic|openai|codex|gpt|copilot|gemini|cursor|ai\b|bot\b)/i;
const AI_NOREPLY = /^\s*co-authored-by:.*noreply@(anthropic|openai)\.com/i;

/** The commit message without any AI co-author trailer, trimmed. */
export function cleanMessage(message: string): string {
  return message
    .split("\n")
    .filter((l) => !AI_TRAILER.test(l) && !AI_NOREPLY.test(l))
    .join("\n")
    .trim();
}

/** Shapes that are secrets wherever they appear, tests included. */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/, // Discord bot token
];

/** In real code (not tests): a secret-named thing given a quoted literal that looks like a real value. */
const SECRET_LITERAL = /(?:token|secret|password|passwd|api[_-]?key)\w*["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/i;

/** Credential-shaped lines a diff adds. Variables and expressions are fine; values aren't. */
export function credentialLines(diff: string): string[] {
  const out: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (!line.startsWith("+")) continue;
    const text = line.slice(1);
    const isTest = /\.test\.[cm]?[jt]s$/.test(file);
    const literal = SECRET_LITERAL.exec(text)?.[1] ?? "";
    const placeholder = /^(\.\.\.|<.*>|x+|changeme|example.*|your[-_].*)$/i.test(literal);
    if (SECRET_SHAPES.some((re) => re.test(text)) || (!isTest && literal && !placeholder)) out.push(`${file}: ${text.trim().slice(0, 120)}`);
  }
  return out;
}

export type Decision = { ok: true; push: boolean; commit: boolean } | { ok: false; why: string };

/** What to do, given how HEAD relates to GitHub's main and whether there's anything to commit. */
export function decide(input: { behind: number; ahead: number; staged: boolean }): Decision {
  if (input.behind > 0) return { ok: false, why: `GitHub's ${BRANCH} has ${input.behind} commit(s) this checkout doesn't. Pull them in first (git pull --ff-only ${REMOTE} ${BRANCH}); nothing was shipped.` };
  if (!input.staged && input.ahead === 0) return { ok: true, commit: false, push: false };
  return { ok: true, commit: input.staged, push: true };
}

type Run = (cmd: string, args: string[], cwd: string) => string;

const run: Run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });

/** Ships the repo at `cwd`. Returns a short report; throws with a clear reason when it won't. */
export function ship(cwd: string, message: string, exec: Run = run): string {
  const git = (...args: string[]) => exec("git", args, cwd).trim();
  const msg = cleanMessage(message);
  if (!msg) throw new Error('Say what changed: dum ship "one line about the change"');

  // Checks first: nothing broken goes out.
  try {
    exec("npx", ["tsc", "--noEmit"], cwd);
  } catch (err) {
    throw new Error(`Typecheck failed; nothing was shipped.\n${String((err as { stdout?: string }).stdout ?? "").slice(-1500)}`);
  }
  try {
    exec("npm", ["test", "--silent"], cwd);
  } catch (err) {
    throw new Error(`Tests failed; nothing was shipped.\n${String((err as { stdout?: string }).stdout ?? "").slice(-1500)}`);
  }

  git("fetch", "--quiet", REMOTE, BRANCH);
  git("add", "-A");
  const leaks = credentialLines(git("diff", "--cached"));
  if (leaks.length) {
    git("reset", "--quiet");
    throw new Error(`Refused: ${leaks.length} added line(s) look like credentials. Nothing was committed or pushed.`);
  }
  const staged = git("diff", "--cached", "--name-only").length > 0;
  const [behind, ahead] = git("rev-list", "--left-right", "--count", `${REMOTE}/${BRANCH}...HEAD`).split(/\s+/).map(Number);
  const d = decide({ behind: behind ?? 0, ahead: ahead ?? 0, staged });
  if (!d.ok) {
    git("reset", "--quiet");
    throw new Error(d.why);
  }
  if (!d.push) return "Nothing to ship: the working tree matches GitHub.";
  if (d.commit) git("-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, "commit", "--quiet", "-m", msg);
  const sha = git("rev-parse", "--short", "HEAD");
  // Fast-forward only: no force, ever.
  git("push", "--quiet", REMOTE, `HEAD:${BRANCH}`);
  const changed = git("diff", "--name-only", `${sha}~1`, sha).split("\n").filter(Boolean).length;
  return `Shipped ${sha} to ${REMOTE}/${BRANCH} as ${AUTHOR.name} (${changed} file(s) in the last commit): ${msg.split("\n")[0]}`;
}

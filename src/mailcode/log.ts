// Ryan's record of every code the mail side finds: one row per code in
// ~/internship/applications/codes.md, next to his application notes. Both ways a code gets found
// write here: the watcher (`dum codes watch`, for code_request) and the mailcode agent in Discord
// (through the log_code mail tool). Rows only ever get appended; Ryan can edit "Used for" by hand.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localDay, localTime } from "../shared/clock.ts";
import type { Folder } from "./outlook.ts";

export const DEFAULT_CODE_LOG = join(homedir(), "internship", "applications", "codes.md");

/** Where codes are logged: DUM_CODE_LOG, or the internship folder. */
export const codeLogPath = () => process.env.DUM_CODE_LOG?.trim() || DEFAULT_CODE_LOG;

export type CodeLogEntry = {
  /** When the email arrived (ISO), or when the code was found if that's unknown. */
  at: string;
  company: string;
  code: string;
  sender: string;
  folder: Folder | "";
  usedFor: string;
};

const HEADER = `# Verification codes

Every code Dum's mail tools find, so there's a record. One-time codes: once used or expired they're only history.
Written by the code watcher and the mailcode agent; "Used for" can be edited by hand.

| When (Indiana time) | Company / role | Code | Sender | Folder (inbox/junk) | Used for |
|---|---|---|---|---|---|
`;

/** One table-safe cell: no pipes, backticks or line breaks, bounded length. */
const cell = (s: string, max = 120) => s.replace(/[|`\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "Greenhouse (no-reply@us.greenhouse-mail.io)": no angle brackets, which markdown would eat. */
export function senderOf(name: string, address: string): string {
  const n = cell(name, 60);
  const a = cell(address, 80);
  return n && a && n.toLowerCase() !== a.toLowerCase() ? `${n} (${a})` : n || a;
}

/** "2026-10-14 9:19 PM EDT", or the raw value if it isn't a time. */
function when(at: string): string {
  const t = Date.parse(at);
  return Number.isFinite(t) ? `${localDay(t)} ${localTime(t)}` : cell(at, 40);
}

export function codeRow(e: CodeLogEntry): string {
  return `| ${when(e.at)} | ${cell(e.company) || "?"} | \`${cell(e.code, 64)}\` | ${cell(e.sender, 100) || "?"} | ${e.folder || "?"} | ${cell(e.usedFor, 160)} |`;
}

/** The [code, sender] of each row already in the log. */
function logged(file: string): [string, string][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| When"))
    .map((l) => l.split("|").map((f) => f.trim()))
    .map((f) => [(f[3] ?? "").replace(/`/g, ""), f[4] ?? ""]);
}

/**
 * Appends a row for a found code. The same code from the same sender is logged once, however many
 * times it's looked up. Returns false when it was already there.
 */
export function logCode(file: string, e: CodeLogEntry): boolean {
  const code = cell(e.code, 64);
  if (!code) throw new Error("No code to log.");
  if (logged(file).some(([c, s]) => c === code && s === (cell(e.sender, 100) || "?"))) return false;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const lead = existing === null ? HEADER : existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${lead}${codeRow(e)}\n`, { mode: 0o600 });
  return true;
}

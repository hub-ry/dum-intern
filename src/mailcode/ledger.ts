// Experimental: two markdown files between the internship side and the mail side, so neither has to
// know how the other works. The internship side appends a request (which application, and the email
// to watch for in plain words) to requests.md. The mail side (`dum codes watch` and its mail agent)
// reads that, finds the value in Purdue Outlook and appends it to codes.md. Each side writes only its own file.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_CODES_DIR = join(homedir(), "internship", "applications", "codes");
/** A request the mail side hasn't answered by then is closed as not found. */
export const REQUEST_TTL_MS = 30 * 60_000;

export type CodeRequest = { id: string; requestedAt: string; internship: string; email: string };
export type CodeAnswer = { id: string; internship: string; code: string | null; note: string };

const REQUESTS_HEADER = "# Code requests\n\nWritten by the internship side: one line per application waiting on an emailed code.\n`- id | requested at | internship | the email to watch for, in plain words`\n\n";
const CODES_HEADER = "# Codes\n\nWritten by the mail side: the code for each request, or why there isn't one.\n`- id | internship | code | from`\n\n";

/** One table-safe field: no pipes or line breaks, bounded length. */
const field = (s: string, max = 120) => s.replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The `- a | b | c | d` lines of a ledger file, split into fields. */
function rows(file: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).split("|").map((f) => f.trim()));
}

function append(dir: string, name: string, header: string, line: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  appendFileSync(file, `${existsSync(file) ? "" : header}${line}\n`, { mode: 0o600 });
}

/** Internship side: ask for the code for an application. Returns the request. */
export function addRequest(dir: string, input: { internship: string; email: string }, now: Date): CodeRequest {
  const internship = field(input.internship);
  const email = field(input.email, 240);
  if (!internship || !email) throw new Error("internship and email are both required.");
  const id = `c-${now.toISOString().slice(0, 19).replace(/\D/g, "")}-${randomBytes(2).toString("hex")}`;
  const request = { id, requestedAt: now.toISOString(), internship, email };
  append(dir, "requests.md", REQUESTS_HEADER, `- ${id} | ${request.requestedAt} | ${internship} | ${email}`);
  return request;
}

export function readRequests(dir: string): CodeRequest[] {
  return rows(join(dir, "requests.md"))
    .filter((f) => f.length >= 4 && f[0]!.startsWith("c-"))
    .map(([id, requestedAt, internship, email]) => ({ id: id!, requestedAt: requestedAt!, internship: internship!, email: email! }));
}

/** Mail side: record the answer for a request. A null code means none was found. */
export function addAnswer(dir: string, answer: CodeAnswer): void {
  append(dir, "codes.md", CODES_HEADER, `- ${answer.id} | ${field(answer.internship)} | ${answer.code ? field(answer.code, 20) : "none"} | ${field(answer.note, 160)}`);
}

export function readAnswers(dir: string): CodeAnswer[] {
  return rows(join(dir, "codes.md"))
    .filter((f) => f.length >= 4 && f[0]!.startsWith("c-"))
    .map(([id, internship, code, note]) => ({ id: id!, internship: internship!, code: code === "none" ? null : code!, note: note! }));
}

/** Requests with no answer yet, oldest first. */
export function pending(dir: string): CodeRequest[] {
  const answered = new Set(readAnswers(dir).map((a) => a.id));
  return readRequests(dir).filter((r) => !answered.has(r.id));
}

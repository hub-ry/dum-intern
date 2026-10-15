// Requests that need Ryan's yes before they happen. An agent can't record something as Ryan's own
// words: teaching and attempt reports from MCP land here, the Discord bot asks with Approve and
// Decline buttons, and only an approval writes them to the workshop. The Workday worker's
// "submit this application" lands here too; only Ryan's approval gets it signed (src/workday/approval.ts).
// One JSON file per request; the agent side only creates, the bot side only decides, and every
// write is atomic.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_REQUESTS_DIR = join(homedir(), ".local", "state", "dum", "requests");

export type RequestKind = "teach" | "tried" | "workday-submit";
export type RequestStatus = "pending" | "approved" | "declined" | "failed";

/** What a Workday submit request is about: the worker's pending submit, bound by its nonce. */
export type WorkdaySubmit = {
  nonce: string;
  /** The worker's fingerprint of the review page Ryan is approving. */
  fingerprint: string;
  url: string;
  /** The masked review-page screenshot, a file name next to the request. */
  screenshot?: string;
};

export type DumRequest = {
  schemaVersion: 1;
  id: string;
  kind: RequestKind;
  goalId: string;
  concept: string;
  text: string;
  /** Only for attempts: the learner's own report of needing help. */
  helped?: boolean;
  /** Which client asked, from its MCP handshake. Shown to Ryan, never trusted for anything. */
  requestedBy: string;
  /**
   * The text appears word for word in the Discord message Ryan just sent Dum. Only the bot's own
   * chat sets this up, and only then is a request recorded without asking him again.
   */
  verbatim?: boolean;
  createdAt: string;
  status: RequestStatus;
  decidedAt?: string;
  /** A short outcome line, shown back to the agent. */
  outcome?: string;
  /** Where the bot asked, so it can update the message. */
  channelId?: string;
  messageId?: string;
  workday?: WorkdaySubmit;
  /** For workday-submit: the signed approval, made only when Ryan presses Submit. */
  approval?: string;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRequestId(id: string): boolean {
  return ID.test(id);
}

function write(dir: string, req: DumRequest): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${req.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(req, null, 1), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function createRequest(
  dir: string,
  input: { kind: RequestKind; goalId: string; concept: string; text: string; helped?: boolean; requestedBy: string; verbatim?: boolean; workday?: WorkdaySubmit },
  now = new Date(),
): DumRequest {
  const req: DumRequest = {
    schemaVersion: 1,
    id: randomUUID(),
    kind: input.kind,
    goalId: input.goalId,
    concept: input.concept,
    text: input.text,
    ...(input.kind === "tried" ? { helped: input.helped === true } : {}),
    requestedBy: input.requestedBy.slice(0, 80) || "an MCP client",
    // Only Ryan's words can skip the asking; a submit always waits for his button.
    ...(input.verbatim && input.kind !== "workday-submit" ? { verbatim: true } : {}),
    ...(input.kind === "workday-submit" && input.workday ? { workday: input.workday } : {}),
    createdAt: now.toISOString(),
    status: "pending",
  };
  write(dir, req);
  return req;
}

/** Whether `text` is in `source` word for word, ignoring only how whitespace is laid out. */
export function isVerbatim(text: string, source: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const t = norm(text);
  return t.length > 0 && norm(source).includes(t);
}

export function readRequest(dir: string, id: string): DumRequest | null {
  if (!isRequestId(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as DumRequest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function listRequests(dir: string): DumRequest[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: DumRequest[] = [];
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m || !isRequestId(m[1]!)) continue;
    const req = readRequest(dir, m[1]!);
    if (req && req.schemaVersion === 1) out.push(req);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The bot's side: record where it asked, or the decision. A decided request never changes again. */
export function updateRequest(dir: string, id: string, patch: Partial<Pick<DumRequest, "status" | "decidedAt" | "outcome" | "channelId" | "messageId" | "approval">>): DumRequest {
  const req = readRequest(dir, id);
  if (!req) throw new Error(`no request ${id}`);
  if (req.status !== "pending" && patch.status && patch.status !== req.status) throw new Error(`request ${id} was already ${req.status}`);
  const next = { ...req, ...patch };
  write(dir, next);
  return next;
}

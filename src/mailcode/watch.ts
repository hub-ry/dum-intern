// Mail side of the code ledger (experimental): `dum codes watch`. Every 20 seconds it reads
// requests.md. For each open request it checks whether new mail has arrived since the request
// (a cheap listing, no model), and only then asks the mail agent to interpret the request and find
// the value. The answer goes into codes.md as one line: the value and who sent it. Each code found
// is also logged for Ryan in ~/internship/applications/codes.md (see log.ts).

import { setTimeout as sleep } from "node:timers/promises";
import { askMailAgent, type Answer } from "./agent.ts";
import { addAnswer, pending, REQUEST_TTL_MS, type CodeRequest } from "./ledger.ts";
import { codeLogPath, logCode, senderOf, type CodeLogEntry } from "./log.ts";
import { openMailbox, type MailSummary } from "./outlook.ts";
import { SCAN } from "./mcp.ts";

export const POLL_MS = 20_000;
/** Mail can be stamped slightly before the request is written. */
export const EARLY_MS = 60_000;

export type SweepDeps = {
  /** How many emails have arrived at or after `since` (ms). */
  arrivedSince(since: number): Promise<number>;
  ask(request: CodeRequest, since: number): Promise<Answer>;
  /** The email an answer points at, for the code log; null when it can't be found. */
  email(id: string): Promise<MailSummary | null>;
  /** Records a found code in Ryan's code log. */
  log(entry: CodeLogEntry): void;
  now(): number;
};

/** What the agent is asked: the application and the email Ryan's side described, in its words. */
export function requestText(r: CodeRequest): string {
  return `Application: ${r.internship}\nThe email to find, as described: ${r.email}`;
}

/**
 * One pass over the open requests. `seen` remembers how much mail each request has already been
 * checked against, so the agent only runs again when something new arrives. Returns how many got an answer.
 */
export async function sweep(dir: string, deps: SweepDeps, seen: Map<string, number>): Promise<number> {
  let answered = 0;
  for (const r of pending(dir)) {
    const at = Date.parse(r.requestedAt);
    const since = (Number.isFinite(at) ? at : deps.now()) - EARLY_MS;
    const expired = !Number.isFinite(at) || deps.now() - at > REQUEST_TTL_MS;
    const arrived = await deps.arrivedSince(since);
    let answer: Answer | null = null;
    if (arrived > (seen.get(r.id) ?? 0)) {
      answer = await deps.ask(r, since);
      seen.set(r.id, arrived);
    }
    if (answer?.found && answer.value) {
      addAnswer(dir, { id: r.id, internship: r.internship, code: answer.value, note: `from ${answer.from || "unknown sender"}` });
      await logFound(deps, r, answer);
    } else if (expired) {
      addAnswer(dir, { id: r.id, internship: r.internship, code: null, note: `gave up after ${REQUEST_TTL_MS / 60_000} min${answer?.note ? `: ${answer.note}` : ""}` });
    } else continue;
    seen.delete(r.id);
    answered++;
  }
  return answered;
}

/** One of the newest emails by id, for the code log; null when it's not among them. */
export async function emailById(id: string): Promise<MailSummary | null> {
  const box = await openMailbox();
  try {
    return (await box.recent(SCAN)).find((m) => m.id === id) ?? null;
  } finally {
    await box.close();
  }
}

/** Logs a found code with the email's own sender, folder and arrival time. Never blocks the answer. */
async function logFound(deps: SweepDeps, r: CodeRequest, a: Answer): Promise<void> {
  try {
    const mail = a.email_id ? await deps.email(a.email_id).catch(() => null) : null;
    deps.log({
      at: mail?.receivedAt || new Date(deps.now()).toISOString(),
      company: r.internship,
      code: a.value,
      sender: mail ? senderOf(mail.from, mail.address) : a.from,
      folder: mail?.folder ?? "",
      usedFor: a.purpose || r.email,
    });
  } catch (err) {
    console.log(`couldn't log the code for ${r.id}: ${(err as Error).message}`);
  }
}

export async function watch(dir: string): Promise<never> {
  console.log(`watching ${dir}/requests.md every ${POLL_MS / 1000}s, logging codes to ${codeLogPath()}`);
  const seen = new Map<string, number>();
  const deps: SweepDeps = {
    async arrivedSince(since) {
      const box = await openMailbox();
      try {
        return (await box.recent(SCAN)).filter((m) => Date.parse(m.receivedAt) >= since).length;
      } finally {
        await box.close();
      }
    },
    ask: (r, since) => askMailAgent(requestText(r), since),
    email: emailById,
    log: (entry) => void logCode(codeLogPath(), entry),
    now: () => Date.now(),
  };
  for (;;) {
    try {
      if (pending(dir).length) {
        const n = await sweep(dir, deps, seen);
        if (n) console.log(`answered ${n} request${n === 1 ? "" : "s"}`);
      }
    } catch (err) {
      console.log(`sweep failed: ${(err as Error).message}`);
    }
    await sleep(POLL_MS);
  }
}

// Hub's side of the worker: the same WorkerApi over HTTP to the `workday` VM. Hub never holds
// vault values; everything that comes back was redacted in the VM.
//
//   DUM_WORKDAY_URL         the worker, e.g. http://10.77.0.10:8790; otherwise the one line in
//                           ~/.config/dum-workday/worker-url (provision.sh writes it), so every
//                           hub process finds it without environment plumbing
//   DUM_WORKDAY_TOKEN_FILE  its bearer token (default ~/.config/dum-workday/worker-token)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WorkerError, type PreparedSubmit, type ToolResult, type WorkerApi } from "./api.ts";

const Tool = z.object({ text: z.string(), isError: z.boolean() });
const Prepared = z.object({ nonce: z.string(), fingerprint: z.string(), url: z.string(), title: z.string(), summary: z.string(), screenshotPng: z.string() });
const Failure = z.object({ error: z.string() });

export function httpWorker(baseUrl: string, token: string, opts: { timeoutMs?: number } = {}): WorkerApi {
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
    } catch (err) {
      throw new WorkerError(`The Workday worker didn't answer (${(err as Error).message}). Is the workday VM running?`);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const f = Failure.safeParse(json);
      throw new WorkerError(f.success ? f.data.error : `The Workday worker answered ${res.status}.`);
    }
    return schema.parse(json);
  }
  return {
    call: (name, args): Promise<ToolResult> => post("/call", { name, args }, Tool),
    prepareSubmit: (): Promise<PreparedSubmit> => post("/prepare-submit", {}, Prepared),
    submit: (approval): Promise<ToolResult> => post("/submit", { token: approval }, Tool),
  };
}

/** Where hub reaches the worker, or null when there's no worker set up. */
export function workdayUrl(): string | null {
  const fromEnv = process.env.DUM_WORKDAY_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), ".config", "dum-workday", "worker-url"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The worker hub is set up for, or null when there isn't one. */
export function workerFromEnv(): WorkerApi | null {
  const url = workdayUrl();
  if (!url) return null;
  const tokenFile = process.env.DUM_WORKDAY_TOKEN_FILE?.trim() || join(homedir(), ".config", "dum-workday", "worker-token");
  return httpWorker(url, readFileSync(tokenFile, "utf8").trim());
}

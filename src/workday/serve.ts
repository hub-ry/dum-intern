// The worker's HTTP face, run inside the `workday` VM:
//
//   node --import tsx src/workday/serve.ts
//
//   DUM_WORKDAY_HOME             the worker's folder: config.json, profile.json, vault.json,
//                                approval.pub, worker-token, resume/, browser-profile/, state/
//   DUM_WORKDAY_LISTEN           host:port (default 127.0.0.1:8790)
//   DUM_WORKDAY_UPSTREAM_PROXY   the HTTP proxy the VM reaches the internet through (optional)
//   DUM_WORKDAY_HEADLESS=1       no window (tests and CI); the VM runs headed on DISPLAY for noVNC
//
// Hub calls it with the bearer token in worker-token. Three routes: POST /call (a tool),
// POST /prepare-submit, POST /submit. Answers are already redacted by the worker.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { z } from "zod";
import { allowlist, WORKDAY_HOSTS } from "./allowlist.ts";
import { loadPublicKey } from "./approval.ts";
import { loadProfile } from "./profile.ts";
import { loadVault } from "./vault.ts";
import { WorkerError, type WorkerApi } from "./api.ts";
import { WorkdayWorker } from "./worker.ts";

const MAX_BODY = 256 * 1024;

/** config.json: extra allowlisted hosts, http for a local fixture only, and which request paths send an application. */
const Config = z.object({ allow: z.array(z.string()).default([]), allowHttp: z.boolean().default(false), submitPath: z.string().max(200).optional() });

const CallBody = z.object({ name: z.string().max(40), args: z.record(z.string(), z.unknown()).default({}) });
const SubmitBody = z.object({ token: z.string().max(10_000) });

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > MAX_BODY) throw new WorkerError("Request too large.");
    chunks.push(b);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The HTTP server around a worker. Not listening yet. */
export function workerServer(worker: WorkerApi, token: string): Server {
  if (token.length < 32) throw new Error("The worker token must be at least 32 characters.");
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 401, { error: "Not authorized." });
    if (req.method !== "POST") return send(res, 405, { error: "POST only." });
    try {
      const body = await readBody(req);
      if (req.url === "/call") {
        const { name, args } = CallBody.parse(body);
        return send(res, 200, await worker.call(name, args));
      }
      if (req.url === "/prepare-submit") return send(res, 200, await worker.prepareSubmit());
      if (req.url === "/submit") return send(res, 200, await worker.submit(SubmitBody.parse(body).token));
      return send(res, 404, { error: "No such route." });
    } catch (err) {
      if (err instanceof WorkerError) return send(res, 409, { error: err.message });
      if (err instanceof z.ZodError || err instanceof SyntaxError) return send(res, 400, { error: "Bad request body." });
      console.error(`[dum-workday] ${(err as Error).message}`);
      return send(res, 500, { error: "The worker hit an error; see its log in the VM." });
    }
  });
}

async function main(): Promise<void> {
  const home = resolve(process.env.DUM_WORKDAY_HOME?.trim() || "");
  if (!process.env.DUM_WORKDAY_HOME?.trim()) throw new Error("DUM_WORKDAY_HOME is not set.");
  const config = Config.parse(JSON.parse(readFileSync(join(home, "config.json"), "utf8")));
  const [host, port] = (process.env.DUM_WORKDAY_LISTEN?.trim() || "127.0.0.1:8790").split(/:(?=\d+$)/);
  const worker = await WorkdayWorker.start({
    home,
    allow: allowlist([...WORKDAY_HOSTS, ...config.allow], { allowHttp: config.allowHttp }),
    profile: loadProfile(join(home, "profile.json")),
    vault: loadVault(join(home, "vault.json")),
    approvalKey: loadPublicKey(join(home, "approval.pub")),
    headless: process.env.DUM_WORKDAY_HEADLESS === "1",
    sandbox: process.env.DUM_WORKDAY_SANDBOX !== "0",
    ...(config.submitPath ? { submitPath: new RegExp(config.submitPath, "i") } : {}),
    upstreamProxy: process.env.DUM_WORKDAY_UPSTREAM_PROXY?.trim() || null,
  });
  const server = workerServer(worker, readFileSync(join(home, "worker-token"), "utf8").trim());
  server.listen(Number(port), host, () => console.log(`[dum-workday] worker on ${host}:${port}`));
  const stop = () => {
    server.close();
    void worker.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`[dum-workday] ${(err as Error).message}`);
    process.exit(1);
  });
}

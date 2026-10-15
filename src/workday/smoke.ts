// A smoke run against the local fixture site, never a real Workday site:
//
//   node --import tsx src/workday/smoke.ts          scripted tool sequence
//   node --import tsx src/workday/smoke.ts --agent  the real Workday agent (claude -p) drives it
//
// Everything lives in a temp dir: the fixture, the worker (headless), its HTTP API, hub's MCP,
// a throwaway approval key pair and requests folder (so the live Discord bot never sees it).
// It prints what the agent sees, then shows Submit refused before approval and done after a
// simulated press of Ryan's Submit button (the same decideSubmit the bot calls).

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { allowlist } from "./allowlist.ts";
import { decideSubmit, generateApprovalKeys, handApprovalToWorker, loadPublicKey } from "./approval.ts";
import { httpWorker } from "./client.ts";
import { startFixture } from "./fixture.ts";
import { createWorkdayMcp } from "./mcp.ts";
import { Profile } from "./profile.ts";
import { workerServer } from "./serve.ts";
import { WorkdayWorker } from "./worker.ts";
import { askWorkdayAgent } from "./agent.ts";
import { createJob, readJob } from "./jobs.ts";
import { listRequests, readRequest } from "../shared/requests.ts";

const useAgent = process.argv.includes("--agent");
const SSN = "123-45-6789";
const log = (head: string, body = "") => console.log(`\n=== ${head}${body ? `\n${body}` : ""}`);
const clip = (s: string, n = 900) => (s.length > n ? `${s.slice(0, n)}\n[... ${s.length - n} more chars]` : s);

const root = mkdtempSync(join(tmpdir(), "dum-workday-smoke-"));
const home = join(root, "worker");
mkdirSync(join(home, "resume"), { recursive: true });
writeFileSync(join(home, "resume", "example_resume.pdf"), "%PDF-1.4 fake resume for the smoke run");
const keys = generateApprovalKeys(join(root, "keys"));
const requestsDir = join(root, "requests");
const jobsDir = join(root, "jobs");

const fx = await startFixture();
const profile = Profile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "profile.example.json"), "utf8")));
const worker = await WorkdayWorker.start({
  home,
  allow: allowlist([fx.host], { allowHttp: true }),
  profile,
  vault: { SSN: { value: SSN, fields: "social security|ssn" }, DOB: { value: "2004-05-17", fields: "date of birth" } },
  approvalKey: loadPublicKey(keys.publicPath),
  headless: true,
});
const token = randomBytes(24).toString("hex");
const server = workerServer(worker, token);
const listening = Promise.withResolvers<void>();
server.listen(0, "127.0.0.1", () => listening.resolve());
await listening.promise;
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const base = `http://127.0.0.1:${address.port}`;
const hubWorker = httpWorker(base, token);
const seen: string[] = [];

try {
  log("fixture", `${fx.url}/job/intern-2027 (allowlist: ${fx.host}; off-allowlist host: localhost)`);
  let requestId: string;
  if (useAgent) {
    // The real agent, with the real `dum workday-mcp` from this checkout, against the local worker.
    writeFileSync(join(root, "worker-token"), token, { mode: 0o600 });
    process.env.DUM_WORKDAY_URL = base;
    process.env.DUM_WORKDAY_TOKEN_FILE = join(root, "worker-token");
    const job = createJob(jobsDir, { url: `${fx.url}/job/intern-2027`, note: "", goalId: "", requestedBy: "smoke" });
    const answer = await askWorkdayAgent(job, { jobsDir, requestsDir, dumBin: resolve(import.meta.dirname, "..", "..", "bin", "dum") });
    log("agent answered", JSON.stringify(answer));
    const linked = readJob(jobsDir, job.id)!;
    log("job record (hub)", JSON.stringify({ status: linked.status, requestId: linked.requestId }));
    if (!linked.requestId) throw new Error("the agent didn't reach request_submit");
    requestId = linked.requestId;
  } else {
    const mcp = createWorkdayMcp({ worker: hubWorker, requestsDir, requestedBy: "smoke script", goalId: "" });
    let n = 0;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await mcp({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } };
      const text = res.result.content[0]!.text;
      seen.push(text);
      log(`${name}(${JSON.stringify(args)}) -> ${res.result.isError ? "ERROR" : "ok"}`, clip(text));
      return text;
    };
    const keyOf = (text: string, label: RegExp) => /\[(f\d+)\]/.exec(text.split("\n").find((l) => l.startsWith("- [f") && label.test(l)) ?? "")?.[1] ?? "?";
    await call("open_application", { url: `http://localhost:${new URL(fx.url).port}/job/intern-2027` });
    await call("open_application", { url: `${fx.url}/out` });
    await call("open_application", { url: `${fx.url}/job/intern-2027` });
    let p = await call("next_step", { button: "Apply Manually" });
    p = await call("fill_from_profile", { fields: [{ field: keyOf(p, /First Name/), value: "{{profile.name.first}}" }, { field: keyOf(p, /Last Name/), value: "{{profile.name.last}}" }, { field: keyOf(p, /Email/), value: "{{profile.email}}" }, { field: keyOf(p, /Hear About/), value: "LinkedIn" }] });
    p = await call("next_step");
    await call("next_step", { button: "Save draft" });
    p = await call("fill_from_profile", { fields: [{ field: keyOf(p, /authorized.*Yes/), value: "check" }, { field: keyOf(p, /Social Security/), value: "{{SSN}}" }, { field: keyOf(p, /Date of Birth/), value: "{{DOB}}" }, { field: keyOf(p, /Why do you want/), value: "{{SSN}}" }] });
    await call("fill_from_profile", { fields: [{ field: keyOf(p, /Why do you want/), value: "{{profile.answers.why_company}}" }] });
    await call("next_step");
    await call("upload_resume");
    await call("next_step");
    await call("screenshot");
    await call("next_step", { button: "Submit" });
    await call("request_submit");
    requestId = listRequests(requestsDir)[0]!.id;
  }

  const req = readRequest(requestsDir, requestId)!;
  log("approval request on hub", JSON.stringify({ id: req.id, kind: req.kind, status: req.status, concept: req.concept, url: req.workday?.url, screenshot: req.workday?.screenshot }));
  log("submissions at the fixture so far", String(fx.submissions.length));

  log("before approval: hand the request to the worker");
  await handApprovalToWorker(requestsDir, requestId, hubWorker).then(
    (r) => console.log(`unexpected: ${r.outcome}`),
    (err: Error) => console.log(`refused: ${err.message}`),
  );
  log("before approval: forged token straight to the worker");
  console.log(JSON.stringify(await hubWorker.submit(`${Buffer.from(JSON.stringify({ v: 1, typ: "dum-workday-submit", rid: requestId, nonce: req.workday!.nonce, fp: req.workday!.fingerprint, url: req.workday!.url, iat: Date.now(), exp: Date.now() + 60_000 })).toString("base64url")}.${"A".repeat(86)}`)));
  log("submissions at the fixture", String(fx.submissions.length));

  log("Ryan presses Submit (simulated: the bot's decideSubmit with hub's key)");
  const done = await decideSubmit(requestsDir, requestId, true, { keyPath: keys.privatePath, worker: hubWorker });
  console.log(JSON.stringify({ status: done?.status, outcome: done?.outcome }));
  log("submissions at the fixture", JSON.stringify(fx.submissions.map((s) => ({ ...s, ssn: s.ssn ? `${s.ssn.slice(0, 3)}-••-•••• (real value typed)` : "", dob: s.dob ? "(real value typed)" : "" }))));

  log("the same approval again");
  console.log(JSON.stringify(await hubWorker.submit(readRequest(requestsDir, requestId)!.approval!)));
  log("submissions at the fixture", String(fx.submissions.length));

  const leaks = [...seen, JSON.stringify(readRequest(requestsDir, requestId))].filter((t) => /123\D{0,3}45\D{0,3}6789|2004\D{0,3}05\D{0,3}17/.test(t));
  log("vault values in anything the agent or hub saw", leaks.length ? `LEAK x${leaks.length}` : "none");
  log("requests reaching the off-allowlist host", JSON.stringify(fx.offsite));
  log("files", `screenshot for Ryan: ${join(requestsDir, req.workday!.screenshot!)}`);
} finally {
  server.close();
  await worker.close();
  await fx.close();
}

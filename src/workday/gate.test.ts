// The Workday worker's boundary pieces without a browser: the allowlist, the egress proxy every
// browser request goes through, vault substitution and redaction, and the signed approval.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlist, WORKDAY_HOSTS } from "./allowlist.ts";
import { startEgress } from "./egress.ts";
import { FillError, redactor, resolveFill, type Vault } from "./vault.ts";
import { Profile } from "./profile.ts";
import { APPROVAL_TTL_MS, ApprovalError, approveSubmitRequest, decideSubmit, signApproval, UsedNonces, verifyApproval, generateApprovalKeys } from "./approval.ts";
import { createRequest, readRequest } from "../shared/requests.ts";
import { startFixture } from "./fixture.ts";
import { createJob, updateJob } from "./jobs.ts";
import { runJob } from "./agent.ts";
import { workerServer } from "./serve.ts";

const profile = Profile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "profile.example.json"), "utf8")));
const vault: Vault = { SSN: { value: "123-45-6789", fields: "social security|ssn" }, DOB: { value: "2004-05-17", fields: "date of birth" } };
const field = (label: string) => ({ label, name: "", automationId: "" });

test("the allowlist takes Workday tenants and pinned hosts, nothing else", () => {
  const a = allowlist([...WORKDAY_HOSTS, "careers.acme.com", "127.0.0.1:8123"]);
  assert.ok(a.allowsUrl("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123"));
  assert.ok(a.allowsUrl("https://careers.acme.com/apply"));
  assert.ok(!a.allowsUrl("https://myworkdayjobs.com.evil.example/"), "suffix trick");
  assert.ok(!a.allowsUrl("https://evilmyworkdayjobs.com/"), "no dot boundary");
  assert.ok(!a.allowsUrl("http://acme.wd1.myworkdayjobs.com/"), "http refused unless allowed");
  assert.ok(!a.allowsUrl("https://user:pw@acme.wd1.myworkdayjobs.com/"), "credentials in the URL");
  assert.ok(!a.allowsUrl("javascript:alert(1)"));
  assert.ok(!a.allowsUrl("file:///etc/passwd"));
  assert.ok(allowlist(["127.0.0.1:8123"], { allowHttp: true }).allowsUrl("http://127.0.0.1:8123/x"));
  assert.ok(!allowlist(["127.0.0.1:8123"], { allowHttp: true }).allowsUrl("http://127.0.0.1:9999/x"), "port pinned");
  assert.ok(!allowlist(["127.0.0.1:8123"], { allowHttp: true }).allowsUrl("http://localhost:8123/x"));
});

test("the egress proxy forwards allowlisted requests and refuses the rest, plain or tunnelled", async () => {
  const fx = await startFixture();
  const egress = await startEgress(allowlist([fx.host], { allowHttp: true }));
  const proxy = new URL(egress.server);
  const viaProxy = (url: string) => {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const r = request({ host: proxy.hostname, port: Number(proxy.port), path: url, headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
    return promise;
  };
  const tunnel = (target: string) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const s = connect(Number(proxy.port), proxy.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0]!);
      s.destroy();
    });
    return promise;
  };
  try {
    assert.equal(await viaProxy(`${fx.url}/job/intern-2027`), 200);
    assert.equal(await viaProxy(`http://localhost:${new URL(fx.url).port}/steal`), 403);
    assert.match(await tunnel(fx.host), / 200 /);
    assert.match(await tunnel("example.com:443"), / 403 /);
    assert.deepEqual(fx.offsite, [], "nothing reached the off-allowlist host");
    assert.deepEqual(egress.takeBlocked(), [`localhost:${new URL(fx.url).port}`, "example.com:443"]);
  } finally {
    await egress.close();
    await fx.close();
  }
});

test("vault placeholders resolve only as a whole value, only into their own fields", () => {
  assert.deepEqual(resolveFill("{{SSN}}", field("Social Security Number"), profile, vault), { value: "123-45-6789", secret: "SSN" });
  assert.deepEqual(resolveFill("{{ profile.name.first }} {{profile.name.last}}", field("Full name"), profile, vault), { value: "Pat Example", secret: null });
  assert.throws(() => resolveFill("{{SSN}}", field("Why do you want to work here?"), profile, vault), FillError);
  assert.throws(() => resolveFill("my ssn is {{SSN}}", field("Social Security Number"), profile, vault), FillError);
  assert.throws(() => resolveFill("{{PASSWORD}}", field("Password"), profile, vault), /No vault value/);
  assert.throws(() => resolveFill("{{profile.nope}}", field("x"), profile, vault), /No profile value/);
  // The refusal never carries the value.
  try {
    resolveFill("{{SSN}}", field("Cover letter"), profile, vault);
  } catch (err) {
    assert.doesNotMatch((err as Error).message, /6789/);
  }
});

test("redaction catches a vault value however the page spells it", () => {
  const redact = redactor(vault);
  const page = "SSN 123-45-6789 / 123 45 6789 / 123456789 / born 2004-05-17 or 20040517";
  const out = redact(page);
  assert.doesNotMatch(out, /6789|0517/);
  assert.equal(out, "SSN {{SSN}} / {{SSN}} / {{SSN}} / born {{DOB}} or {{DOB}}");
  // Spellings a page (or a hostile one) might use instead.
  for (const spelled of ["SSN ending in 6789", "１２３-４５-６７８９", "123\u200B-45-6789", "123%2D45%2D6789", "born 05/17/2004", "born 5-17-2004", "born May 17, 2004", "born 17 May 2004", "born may 17th 2004"]) {
    assert.doesNotMatch(redact(spelled), /6789|６７８９|17|2004/, spelled);
  }
  assert.equal(redact("call 555-010-0199 about job 67890"), "call 555-010-0199 about job 67890", "other numbers stay");
});

test("the worker's HTTP face refuses a short bearer token", () => {
  const none = { call: async () => ({ text: "", isError: false }), prepareSubmit: async () => assert.fail(), submit: async () => ({ text: "", isError: true }) };
  assert.throws(() => workerServer(none, ""), /at least 32/);
  assert.throws(() => workerServer(none, "short"), /at least 32/);
  workerServer(none, "x".repeat(32)).close();
});

test("an approval verifies only with hub's key, before it expires", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const payload = { v: 1 as const, typ: "dum-workday-submit" as const, rid: "r", nonce: "n".repeat(24), fp: "a".repeat(64), url: "https://x.myworkdayjobs.com/r", iat: 1000, exp: 1000 + APPROVAL_TTL_MS };
  const token = signApproval(privateKey, payload);
  assert.deepEqual(verifyApproval(token, publicKey, 2000), payload);
  assert.throws(() => verifyApproval(signApproval(other.privateKey, payload), publicKey, 2000), /signature/);
  assert.throws(() => verifyApproval(token, publicKey, payload.exp), /expired/);
  // Changing the payload breaks the signature.
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...payload, nonce: "m".repeat(24) })).toString("base64url");
  assert.notEqual(forged, body);
  assert.throws(() => verifyApproval(`${forged}.${sig}`, publicKey, 2000), ApprovalError);
  assert.throws(() => verifyApproval("not-a-token", publicKey, 2000), ApprovalError);
});

test("a used approval nonce stays used, across instances", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dum-nonces-")), "used.json");
  new UsedNonces(path).use("abc");
  assert.ok(new UsedNonces(path).has("abc"));
  assert.throws(() => new UsedNonces(path).use("abc"), /already used/);
});

test("a submit request is never 'Ryan's exact words', and only a pending one gets signed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dum-req-"));
  const keys = generateApprovalKeys(mkdtempSync(join(tmpdir(), "dum-keys-")));
  const workday = { nonce: "N".repeat(24), fingerprint: "f".repeat(64), url: "https://acme.wd1.myworkdayjobs.com/review" };
  const req = createRequest(dir, { kind: "workday-submit", goalId: "", concept: "Submit: Acme", text: "review", requestedBy: "the Workday agent", verbatim: true, workday });
  assert.equal(req.verbatim, undefined);

  const submitted: string[] = [];
  const worker = { call: async () => ({ text: "", isError: false }), prepareSubmit: async () => assert.fail("not called"), submit: async (t: string) => (submitted.push(t), { text: "Submitted.", isError: false }) };
  const declined = createRequest(dir, { kind: "workday-submit", goalId: "", concept: "Submit: B", text: "r", requestedBy: "x", workday });
  assert.equal((await decideSubmit(dir, declined.id, false, { keyPath: keys.privatePath, worker }))!.status, "declined");
  assert.equal(readRequest(dir, declined.id)!.approval, undefined, "a no is never signed");

  const noKey = createRequest(dir, { kind: "workday-submit", goalId: "", concept: "Submit: C", text: "r", requestedBy: "x", workday });
  const failed = await decideSubmit(dir, noKey.id, true, { keyPath: join(dir, "missing.key"), worker });
  assert.equal(failed!.status, "failed");
  assert.equal(submitted.length, 0);

  const done = await decideSubmit(dir, req.id, true, { keyPath: keys.privatePath, worker });
  assert.equal(done!.status, "approved");
  assert.equal(done!.outcome, "Submitted.");
  assert.equal(submitted.length, 1);
  assert.throws(() => approveSubmitRequest(dir, "00000000-0000-4000-8000-000000000000", generateKeyPairSync("ed25519").privateKey), ApprovalError);
  // Pressing again changes nothing and signs nothing new.
  assert.equal((await decideSubmit(dir, req.id, true, { keyPath: keys.privatePath, worker }))!.approval, done!.approval);
  assert.equal(submitted.length, 1);
});

test("a job waits on Ryan only when hub linked a real submit request, whatever the agent claims", async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), "dum-jobs-"));
  const opts = { jobsDir, requestsDir: join(jobsDir, "requests") };
  const job = () => createJob(jobsDir, { url: "https://acme.wd1.myworkdayjobs.com/job/1", note: "", goalId: "", requestedBy: "test" });

  const claimed = await runJob(job().id, { ...opts, ask: async () => ({ outcome: "asked_ryan", note: "Submitted it, all done!" }) });
  assert.equal(claimed.status, "failed", "the agent's word isn't a request");

  const linked = await runJob(job().id, {
    ...opts,
    ask: async (j) => {
      updateJob(jobsDir, j.id, { status: "awaiting_approval", requestId: "11111111-1111-4111-8111-111111111111" });
      return { outcome: "asked_ryan", note: "Asked Ryan." };
    },
  });
  assert.equal(linked.status, "awaiting_approval");

  assert.equal((await runJob(job().id, { ...opts, ask: async () => ({ outcome: "needs_ryan", note: "Sign in to Acme first." }) })).status, "needs_ryan");
  const crashed = await runJob(job().id, { ...opts, ask: async () => { throw new Error("workday agent failed (exit 1)"); } });
  assert.equal(crashed.status, "failed");
  assert.match(crashed.agentNote!, /exit 1/);
  assert.equal((await runJob(crashed.id, { ...opts, ask: async () => assert.fail("a finished job doesn't run again") })).status, "failed");
});

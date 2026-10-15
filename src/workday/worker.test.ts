// The Workday worker driving a real headless Chromium against the local fixture site
// (fixture.ts; never a real Workday site): the allowlist holds across redirects and form posts,
// vault values reach the form but never anything the agent sees, and Submit needs Ryan's valid,
// unused approval of the exact page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { allowlist } from "./allowlist.ts";
import { APPROVAL_TTL_MS, approveSubmitRequest, decideSubmit, generateApprovalKeys, loadPrivateKey, loadPublicKey, signApproval } from "./approval.ts";
import { httpWorker } from "./client.ts";
import { startFixture, type Fixture } from "./fixture.ts";
import { createWorkdayMcp } from "./mcp.ts";
import { Profile } from "./profile.ts";
import { workerServer } from "./serve.ts";
import type { Vault } from "./vault.ts";
import { WorkdayWorker } from "./worker.ts";
import { WorkerError, type ToolResult, type WorkerApi } from "./api.ts";
import { createRequest, listRequests, readRequest } from "../shared/requests.ts";

const profile = Profile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "profile.example.json"), "utf8")));
const vault: Vault = { SSN: { value: "123-45-6789", fields: "social security|ssn" }, DOB: { value: "2004-05-17", fields: "date of birth" } };
/** The SSN or the date of birth, however it's spelled. */
const SECRET = /1\D{0,3}2\D{0,3}3\D{0,3}4\D{0,3}5\D{0,3}6\D{0,3}7\D{0,3}8\D{0,3}9|2004\D{0,3}0?5\D{0,3}17/;

type Setup = { fx: Fixture; worker: WorkdayWorker; tool: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>; seen: string[]; keyDir: string; home: string; close(): Promise<void> };

async function setup(fixture: { disguisedSubmit?: boolean } = {}): Promise<Setup> {
  const fx = await startFixture(fixture);
  const home = mkdtempSync(join(tmpdir(), "dum-workday-"));
  mkdirSync(join(home, "resume"));
  writeFileSync(join(home, "resume", "example_resume.pdf"), "%PDF-1.4 fake resume");
  const keyDir = join(home, "keys");
  const keys = generateApprovalKeys(keyDir);
  const worker = await WorkdayWorker.start({ home, allow: allowlist([fx.host], { allowHttp: true }), profile, vault, approvalKey: loadPublicKey(keys.publicPath), headless: true });
  const seen: string[] = [];
  return {
    fx,
    worker,
    keyDir,
    home,
    seen,
    async tool(name, args = {}) {
      const r = await worker.call(name, args);
      seen.push(r.text);
      return r;
    },
    async close() {
      await worker.close();
      await fx.close();
    },
  };
}

/** Field key by label, from the latest listing the agent saw. */
function key(text: string, label: RegExp): string {
  const line = text.split("\n").find((l) => /^- \[f\d+\]/.test(l) && label.test(l));
  assert.ok(line, `no field like ${label} in:\n${text}`);
  return /\[(f\d+)\]/.exec(line)![1]!;
}

async function ok(r: Promise<ToolResult>): Promise<string> {
  const { text, isError } = await r;
  assert.equal(isError, false, text);
  return text;
}

/** The whole agent path to the review page, secrets by placeholder only. */
async function toReview(s: Setup): Promise<string> {
  await ok(s.tool("open_application", { url: `${s.fx.url}/job/intern-2027` }));
  let page = await ok(s.tool("next_step", { button: "Apply Manually" }));
  page = await ok(
    s.tool("fill_from_profile", {
      fields: [
        { field: key(page, /First Name/), value: "{{profile.name.first}}" },
        { field: key(page, /Last Name/), value: "{{profile.name.last}}" },
        { field: key(page, /Email/), value: "{{profile.email}}" },
        { field: key(page, /Hear About/), value: "{{profile.answers.how_did_you_hear}}" },
      ],
    }),
  );
  page = await ok(s.tool("next_step"));
  page = await ok(
    s.tool("fill_from_profile", {
      fields: [
        { field: key(page, /authorized.*Yes/), value: "check" },
        { field: key(page, /Social Security/), value: "{{SSN}}" },
        { field: key(page, /Date of Birth/), value: "{{DOB}}" },
        { field: key(page, /Why do you want/), value: "{{profile.answers.why_company}}" },
      ],
    }),
  );
  assert.match(page, /Social Security Number \(text\) = \{\{SSN\}\}/);
  await ok(s.tool("next_step"));
  await ok(s.tool("upload_resume"));
  return ok(s.tool("next_step"));
}

/** How many pure magenta (mask colour) pixels a PNG has, decoded in a separate browser. */
async function maskPixels(pngBase64: string): Promise<number> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const n = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${pngBase64}";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) n++;
      return n;
    })()`);
    return Number(n);
  } finally {
    await browser.close();
  }
}

test("navigation, redirects and form posts off the allowlist are refused, and nothing reaches the other host", async () => {
  const s = await setup();
  try {
    const port = new URL(s.fx.url).port;
    const direct = await s.tool("open_application", { url: `http://localhost:${port}/job/intern-2027` });
    assert.equal(direct.isError, true);
    assert.match(direct.text, /Refused/);

    const redirect = await s.tool("open_application", { url: `${s.fx.url}/out` });
    assert.equal(redirect.isError, true);
    assert.match(redirect.text, new RegExp(`Refused: the page went to localhost:${port}`));

    await ok(s.tool("open_application", { url: `${s.fx.url}/job/intern-2027` }));
    await ok(s.tool("next_step", { button: "Apply Manually" }));
    const step1 = await ok(s.tool("screenshot"));
    await ok(s.tool("fill_from_profile", { fields: [{ field: key(step1, /First Name/), value: "x" }, { field: key(step1, /Last Name/), value: "y" }, { field: key(step1, /Email/), value: "a@b.co" }] }));
    await ok(s.tool("next_step"));
    const post = await s.tool("next_step", { button: "Save draft" });
    assert.equal(post.isError, true);
    assert.match(post.text, /Refused/);
    // The worker steps back to the last allowed page.
    assert.match(await ok(s.tool("screenshot")), /Page: Application Questions \(http:\/\/127\.0\.0\.1/);

    assert.deepEqual(s.fx.offsite, [], "no request reached the off-allowlist host");
  } finally {
    await s.close();
  }
});

test("a vault value is typed into the form but never appears in anything the agent or the card gets", async () => {
  const s = await setup();
  try {
    const review = await toReview(s);
    // The review page echoes the SSN; the agent sees only the placeholder.
    assert.match(review, /ssn \{\{SSN\}\}/);
    assert.match(review, /dob \{\{DOB\}\}/);
    const wrong = await s.tool("fill_from_profile", { fields: [{ field: "f1", value: "{{SSN}}" }] });
    assert.match(wrong.text, /Couldn't fill f1|No field f1/);

    const prep = await s.worker.prepareSubmit();
    for (const text of [...s.seen, prep.summary, prep.title, prep.url, JSON.stringify({ ...prep, screenshotPng: "" })]) assert.doesNotMatch(text, SECRET);
    assert.ok((await maskPixels(prep.screenshotPng)) > 200, "the echoed SSN and DOB are covered in the screenshot");

    // ...and the real value was what went into the form.
    const req = createRequest(join(s.home, "requests"), { kind: "workday-submit", goalId: "", concept: "Submit", text: prep.summary, requestedBy: "test", workday: { nonce: prep.nonce, fingerprint: prep.fingerprint, url: prep.url } });
    const approved = approveSubmitRequest(join(s.home, "requests"), req.id, loadPrivateKey(join(s.keyDir, "approval.key")));
    const done = await s.worker.submit(approved.approval!);
    assert.equal(done.isError, false, done.text);
    assert.doesNotMatch(done.text, SECRET);
    assert.equal(s.fx.submissions.length, 1);
    assert.equal(s.fx.submissions[0]!.ssn, "123-45-6789");
    assert.equal(s.fx.submissions[0]!.dob, "2004-05-17");
    assert.equal(s.fx.submissions[0]!.resume, "example_resume.pdf");
  } finally {
    await s.close();
  }
});

test("Submit happens only with Ryan's valid approval of this page, and only once", async () => {
  const s = await setup();
  try {
    const review = await toReview(s);
    assert.match(review, /Submit \(submit: only through request_submit\)/);
    const pressed = await s.tool("next_step", { button: "Submit" });
    assert.equal(pressed.isError, true);
    assert.match(pressed.text, /Refused: that button submits/);

    const prep = await s.worker.prepareSubmit();
    const key = loadPrivateKey(join(s.keyDir, "approval.key"));
    const t = Date.now();
    const good = { v: 1 as const, typ: "dum-workday-submit" as const, rid: "r1", nonce: prep.nonce, fp: prep.fingerprint, url: prep.url, iat: t, exp: t + APPROVAL_TTL_MS };

    const refusals = [
      await s.worker.submit(""),
      await s.worker.submit("forged.by-the-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      await s.worker.submit(signApproval(generateKeyPairSync("ed25519").privateKey, good)),
      await s.worker.submit(signApproval(key, { ...good, nonce: randomBytes(18).toString("base64url") })),
      await s.worker.submit(signApproval(key, { ...good, fp: "0".repeat(64) })),
      await s.worker.submit(signApproval(key, { ...good, iat: t - 2 * APPROVAL_TTL_MS, exp: t - APPROVAL_TTL_MS })),
    ];
    for (const r of refusals) {
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /approval|signature|expired/i);
    }
    assert.equal(s.fx.submissions.length, 0, "nothing was submitted without a valid approval");

    const token = signApproval(key, good);
    const done = await s.worker.submit(token);
    assert.equal(done.isError, false, done.text);
    assert.match(done.text, /Application submitted/);
    assert.equal(s.fx.submissions.length, 1);

    const again = await s.worker.submit(token);
    assert.equal(again.isError, true);
    assert.match(again.text, /already used/);
    assert.equal(s.fx.submissions.length, 1, "a reused approval submits nothing");
  } finally {
    await s.close();
  }
});

test("a Submit disguised as Continue, or a page script that submits when typed into, sends nothing", async () => {
  const s = await setup({ disguisedSubmit: true });
  try {
    const review = await toReview(s);
    const pressed = await s.tool("next_step");
    assert.match(pressed.text, /Pressed "Continue"/);
    assert.match(pressed.text, /Blocked 1 submission request/);
    assert.match(pressed.text, /\/apply\/review\)\nFields:\n- \[f1\] Comments/, "still on the review page");
    const typed = await s.tool("fill_from_profile", { fields: [{ field: key(review, /Comments/), value: "thanks" }] });
    assert.match(typed.text, /Blocked 1 submission request/);
    assert.equal(s.fx.submissions.length, 0, "the application never left the browser");
  } finally {
    await s.close();
  }
});

test("an approval is void once the page it was for has changed", async () => {
  const s = await setup();
  try {
    await toReview(s);
    const prep = await s.worker.prepareSubmit();
    const key = loadPrivateKey(join(s.keyDir, "approval.key"));
    const t = Date.now();
    const token = signApproval(key, { v: 1, typ: "dum-workday-submit", rid: "r", nonce: prep.nonce, fp: prep.fingerprint, url: prep.url, iat: t, exp: t + APPROVAL_TTL_MS });
    await ok(s.tool("next_step", { button: "Back" }));
    const r = await s.worker.submit(token);
    assert.equal(r.isError, true);
    assert.match(r.text, /page changed/);
    assert.equal(s.fx.submissions.length, 0);
  } finally {
    await s.close();
  }
});

test("over HTTP, request_submit only asks Ryan; his Submit (and nothing else) submits", async () => {
  const s = await setup();
  const token = randomBytes(24).toString("hex");
  const server = workerServer(s.worker, token);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(httpWorker(base, "wrong").call("screenshot", {}), (err: unknown) => err instanceof WorkerError && /Not authorized/.test(err.message));

    const worker: WorkerApi = httpWorker(base, token);
    const requestsDir = join(s.home, "requests");
    const mcp = createWorkdayMcp({ worker, requestsDir, requestedBy: "the Workday agent", goalId: "" });
    let id = 0;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await mcp({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
      const result = (res as { result: { content: { text: string }[]; isError?: boolean } }).result;
      const text = result.content[0]!.text;
      assert.doesNotMatch(text, SECRET);
      return { text, isError: result.isError === true };
    };

    // The same agent path, through hub's MCP and the worker's HTTP API.
    const s2: Setup = { ...s, tool: (name, args) => call(name, args) };
    await toReview(s2);
    const early = await call("request_submit");
    assert.equal(early.isError, false);
    assert.match(early.text, /Asked Ryan in Discord/);
    assert.match((await call("request_submit")).text, /Already waiting/, "asking twice makes one card");

    const [req] = listRequests(requestsDir);
    assert.equal(req!.kind, "workday-submit");
    assert.equal(req!.status, "pending");
    assert.ok(existsSync(join(requestsDir, req!.workday!.screenshot!)), "the card's screenshot is on hub");
    assert.doesNotMatch(JSON.stringify(req), SECRET);
    assert.equal(s.fx.submissions.length, 0, "asking submits nothing");

    const keyPath = join(s.keyDir, "approval.key");
    const done = await decideSubmit(requestsDir, req!.id, true, { keyPath, worker });
    assert.equal(done!.outcome, "Submitted.");
    assert.equal(s.fx.submissions.length, 1);
    assert.match(readRequest(requestsDir, req!.id)!.approval!, /\./);
  } finally {
    server.close();
    await s.close();
  }
});

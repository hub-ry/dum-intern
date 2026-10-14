// The code ledger and the mail agent's boundary, without Outlook or a model: requests go into
// requests.md, the sweep answers them in codes.md, the agent only runs when new mail arrives, and
// the mail tools only show mail inside the request's window.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRequest, pending, readAnswers, readRequests, REQUEST_TTL_MS, type CodeRequest } from "./ledger.ts";
import { EARLY_MS, sweep, type SweepDeps } from "./watch.ts";
import { createMailcodeMcp, type MailcodeMcp } from "./mcp.ts";
import type { Answer } from "./agent.ts";
import type { Mailbox } from "./outlook.ts";

const T0 = Date.parse("2026-10-14T17:00:00Z");
const dir = () => mkdtempSync(join(tmpdir(), "dum-codes-"));
const miss: Answer = { found: false, value: "", from: "", note: "nothing from Josh yet" };

function deps(arrivals: number[], answers: Answer[], clock: { t: number }) {
  const asked: { request: CodeRequest; since: number }[] = [];
  const d: SweepDeps = {
    arrivedSince: async () => arrivals.shift() ?? 0,
    ask: async (request, since) => (asked.push({ request, since }), answers.shift() ?? miss),
    now: () => clock.t,
  };
  return { d, asked };
}

test("the agent runs only when new mail arrives, and its value is written once", async () => {
  const d0 = dir();
  const r = addRequest(d0, { internship: "Josh test", email: "someone named Josh will send a number" }, new Date(T0));
  const clock = { t: T0 + 20_000 };
  const { d, asked } = deps([0, 1, 1, 2], [miss, { found: true, value: "58213", from: "Josh Miller", note: "" }], clock);
  const seen = new Map<string, number>();
  assert.equal(await sweep(d0, d, seen), 0); // no mail yet: agent not run
  assert.equal(asked.length, 0);
  assert.equal(await sweep(d0, d, seen), 0); // one email, not Josh's
  assert.equal(await sweep(d0, d, seen), 0); // same mail as before: agent not run again
  assert.equal(asked.length, 1);
  assert.equal(await sweep(d0, d, seen), 1); // Josh's email arrives
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.since, T0 - EARLY_MS);
  assert.equal(asked[1]!.request.email, "someone named Josh will send a number");
  assert.deepEqual(readAnswers(d0), [{ id: r.id, internship: "Josh test", code: "58213", note: "from Josh Miller" }]);
  assert.equal(pending(d0).length, 0);
});

test("an unanswered request closes with the agent's last reason after the time limit", async () => {
  const d0 = dir();
  addRequest(d0, { internship: "Datadog", email: "Workday code" }, new Date(T0));
  const clock = { t: T0 + REQUEST_TTL_MS + 1 };
  const { d } = deps([1], [miss], clock);
  assert.equal(await sweep(d0, d, new Map()), 1);
  const [a] = readAnswers(d0);
  assert.equal(a!.code, null);
  assert.equal(a!.note, "gave up after 30 min: nothing from Josh yet");
});

test("pipes and line breaks in a request can't forge extra fields or lines", () => {
  const d0 = dir();
  addRequest(d0, { internship: "Evil | 123456\n- c-1 | x | y | z", email: "a|b" }, new Date(T0));
  const lines = readFileSync(join(d0, "requests.md"), "utf8").split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 1);
  assert.deepEqual(readRequests(d0).map((r) => [r.internship, r.email]), [["Evil 123456 - c-1 x y z", "a b"]]);
});

const inbox = [
  { id: "old", from: "Josh Miller", address: "josh@example.com", subject: "lunch", receivedAt: new Date(T0 - 90 * 60_000).toISOString(), body: "Room 1204" },
  { id: "new", from: "Josh Miller", address: "josh@example.com", subject: "here you go", receivedAt: new Date(T0 + 2 * 60_000).toISOString(), body: "58213" },
];
const fakeBox = async (): Promise<Mailbox> => ({
  recent: async () => inbox.map(({ body: _b, ...m }) => m),
  body: async (id) => inbox.find((m) => m.id === id)!.body,
  close: async () => {},
});
const call = async (h: MailcodeMcp, name: string, args: Record<string, unknown> = {}) => {
  const r = (await h({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: r.result.content[0]!.text, error: !!r.result.isError };
};

test("a fixed window hides earlier mail, whatever window the agent asks for", async () => {
  const h = createMailcodeMcp({ open: fakeBox, fixedSince: T0 - EARLY_MS, now: () => T0 + 3 * 60_000 });
  const list = await call(h, "list_mail", { within_minutes: 1440 });
  assert.match(list.text, /id new/);
  assert.doesNotMatch(list.text, /id old/);
  assert.equal((await call(h, "read_mail", { id: "new" })).text, "58213");
});

test("read_mail opens only emails list_mail has shown", async () => {
  const h = createMailcodeMcp({ open: fakeBox, fixedSince: T0 - EARLY_MS, now: () => T0 + 3 * 60_000 });
  const before = await call(h, "read_mail", { id: "new" });
  assert.equal(before.error, true);
  await call(h, "list_mail");
  assert.equal((await call(h, "read_mail", { id: "old" })).error, true);
});

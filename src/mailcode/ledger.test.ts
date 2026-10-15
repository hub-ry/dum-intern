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
import { mergeFolders, type Mailbox, type MailSummary } from "./outlook.ts";
import { logCode, type CodeLogEntry } from "./log.ts";

const T0 = Date.parse("2026-10-14T17:00:00Z");
const dir = () => mkdtempSync(join(tmpdir(), "dum-codes-"));
const miss: Answer = { found: false, value: "", from: "", note: "nothing from Josh yet", email_id: "", purpose: "" };

function deps(arrivals: number[], answers: Answer[], clock: { t: number }, emails: MailSummary[] = []) {
  const asked: { request: CodeRequest; since: number }[] = [];
  const logged: CodeLogEntry[] = [];
  const d: SweepDeps = {
    arrivedSince: async () => arrivals.shift() ?? 0,
    ask: async (request, since) => (asked.push({ request, since }), answers.shift() ?? miss),
    email: async (id) => emails.find((m) => m.id === id) ?? null,
    log: (e) => void logged.push(e),
    now: () => clock.t,
  };
  return { d, asked, logged };
}

test("the agent runs only when new mail arrives, and its value is written once", async () => {
  const d0 = dir();
  const r = addRequest(d0, { internship: "Josh test", email: "someone named Josh will send a number" }, new Date(T0));
  const clock = { t: T0 + 20_000 };
  const { d, asked } = deps([0, 1, 1, 2], [miss, { found: true, value: "58213", from: "Josh Miller", note: "", email_id: "", purpose: "" }], clock);
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
  { id: "old", folder: "inbox" as const, from: "Josh Miller", address: "josh@example.com", subject: "lunch", receivedAt: new Date(T0 - 90 * 60_000).toISOString(), body: "Room 1204" },
  { id: "new", folder: "junk" as const, from: "Josh Miller", address: "josh@example.com", subject: "here you go", receivedAt: new Date(T0 + 2 * 60_000).toISOString(), body: "58213" },
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
  assert.match(list.text, /id new\n  folder: junk/);
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

test("Inbox and Junk come back as one list, newest first, each email marked with its folder", () => {
  const item = (id: string, at: string) => ({ ItemId: { Id: id }, Subject: id, DateTimeReceived: at, From: { Mailbox: { Name: "Greenhouse", EmailAddress: "no-reply@greenhouse.io" } } });
  const folder = (...items: ReturnType<typeof item>[]) => ({ ResponseClass: "Success", RootFolder: { Items: items } });
  const inboxMsg = folder(item("i2", "2026-10-15T00:40:00Z"), item("i1", "2026-10-15T00:10:00Z"));
  const junkMsg = folder(item("j1", "2026-10-15T00:54:14Z"), item("j0", "2026-10-14T23:00:00Z"));
  const merged = mergeFolders([inboxMsg, junkMsg], ["inbox", "junk"], 3);
  assert.deepEqual(merged.map((m) => [m.id, m.folder]), [["j1", "junk"], ["i2", "inbox"], ["i1", "inbox"]]);
  assert.throws(() => mergeFolders([inboxMsg], ["inbox", "junk"], 3), /1 folders, not 2/);
});

test("a code the watcher finds is logged with the email's own sender, folder and time", async () => {
  const d0 = dir();
  addRequest(d0, { internship: "Wing, SWE Intern Summer 2027", email: "Greenhouse security code" }, new Date(T0));
  const email: MailSummary = { id: "g1", folder: "junk", from: "Greenhouse", address: "no-reply@us.greenhouse-mail.io", subject: "Security code", receivedAt: "2026-10-15T01:19:54Z" };
  const found: Answer = { found: true, value: "MP930OO0", from: "Greenhouse", note: "", email_id: "g1", purpose: "Greenhouse application security code" };
  const { d, logged } = deps([1], [found], { t: T0 + 20_000 }, [email]);
  assert.equal(await sweep(d0, d, new Map()), 1);
  assert.deepEqual(logged, [{ at: "2026-10-15T01:19:54Z", company: "Wing, SWE Intern Summer 2027", code: "MP930OO0", sender: "Greenhouse (no-reply@us.greenhouse-mail.io)", folder: "junk", usedFor: "Greenhouse application security code" }]);
});

test("a failing code log never blocks the answer", async () => {
  const d0 = dir();
  addRequest(d0, { internship: "Josh test", email: "a number from Josh" }, new Date(T0));
  const found: Answer = { found: true, value: "58213", from: "Josh Miller", note: "", email_id: "", purpose: "" };
  const { d } = deps([1], [found], { t: T0 + 20_000 });
  d.log = () => { throw new Error("disk full"); };
  assert.equal(await sweep(d0, d, new Map()), 1);
  assert.equal(readAnswers(d0)[0]!.code, "58213");
});

test("the code log is one markdown table in Indiana time, each code once, nothing forged", () => {
  const file = join(dir(), "codes.md");
  const e: CodeLogEntry = { at: "2026-10-15T00:54:14Z", company: "Wing | x", code: "vNSVK8Pd", sender: "Greenhouse (no-reply@us.greenhouse-mail.io)", folder: "junk", usedFor: "security code\n| forged | row |" };
  assert.equal(logCode(file, e), true);
  assert.equal(logCode(file, { ...e, usedFor: "again" }), false);
  assert.equal(logCode(file, { ...e, code: "MP930OO0", at: "2026-10-15T01:19:54Z", folder: "" }), true);
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("| 2026"));
  assert.deepEqual(rows, [
    "| 2026-10-14 8:54 PM EDT | Wing x | `vNSVK8Pd` | Greenhouse (no-reply@us.greenhouse-mail.io) | junk | security code forged row |",
    "| 2026-10-14 9:19 PM EDT | Wing x | `MP930OO0` | Greenhouse (no-reply@us.greenhouse-mail.io) | ? | security code forged row |",
  ]);
  assert.match(readFileSync(file, "utf8"), /^# Verification codes\n[\s\S]*\| When \(Indiana time\) \| Company \/ role \| Code \| Sender \| Folder \(inbox\/junk\) \| Used for \|\n\|---/);
});

test("log_code is only offered with a log file, and only logs a code that is in an email list_mail showed", async () => {
  const fixed = createMailcodeMcp({ open: fakeBox, fixedSince: T0 - EARLY_MS, now: () => T0 + 3 * 60_000 });
  const names = async (h: MailcodeMcp) => ((await h({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.deepEqual(await names(fixed), ["list_mail", "read_mail"]);
  assert.equal((await call(fixed, "log_code", { id: "new", code: "58213", company_role: "x", used_for: "y" })).error, true);

  const file = join(dir(), "codes.md");
  const h = createMailcodeMcp({ open: fakeBox, now: () => T0 + 3 * 60_000, logFile: file });
  assert.deepEqual(await names(h), ["list_mail", "read_mail", "log_code"]);
  const args = { id: "new", code: "58213", company_role: "Josh test", used_for: "a number" };
  assert.equal((await call(h, "log_code", args)).error, true); // not listed yet
  await call(h, "list_mail", { within_minutes: 1440 });
  assert.equal((await call(h, "log_code", { ...args, code: "99999" })).text, "That code isn't in that email; nothing logged.");
  assert.equal((await call(h, "log_code", args)).text, "Logged.");
  assert.equal((await call(h, "log_code", args)).text, "Already logged.");
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("| 2026"));
  assert.deepEqual(rows, ["| 2026-10-14 1:02 PM EDT | Josh test | `58213` | Josh Miller (josh@example.com) | junk | a number |"]);
});

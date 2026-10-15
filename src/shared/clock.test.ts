import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_TZ, localDay, localNow, localStamp, localTime } from "./clock.ts";
import { createHandoff, writeResult } from "./handoff.ts";
import { chatCommand, prompt } from "../discord/chat.ts";

// The evening the bug was caught: Wednesday 8:11pm in Indiana, already Thursday in UTC.
const WED_EVENING = new Date("2026-10-15T00:11:24Z");

test("after 8pm in Indiana it's still today there, though UTC has moved on", () => {
  assert.equal(WED_EVENING.toISOString().slice(0, 10), "2026-10-15");
  assert.equal(localDay(WED_EVENING), "2026-10-14");
  assert.equal(localNow(WED_EVENING), "Wednesday, October 14, 2026, 8:11 PM EDT");
  assert.equal(localTime(WED_EVENING), "8:11 PM EDT");
  assert.equal(localStamp(WED_EVENING), "2026-10-14 20:11 EDT");
});

test("midnight, winter time and the DST switch read the way a clock on his wall would", () => {
  assert.equal(localStamp(new Date("2026-10-15T04:00:00Z")), "2026-10-15 00:00 EDT");
  assert.equal(localNow(new Date("2026-12-01T04:59:00Z")), "Monday, November 30, 2026, 11:59 PM EST");
  // Clocks fall back at 2am EDT on Nov 1, 2026: 05:30Z is 1:30am EDT, 06:30Z is 1:30am EST.
  assert.equal(localStamp(new Date("2026-11-01T05:30:00Z")), "2026-11-01 01:30 EDT");
  assert.equal(localStamp(new Date("2026-11-01T06:30:00Z")), "2026-11-01 01:30 EST");
});

test("each turn's message opens with Ryan's local date and time", () => {
  const text = prompt({ message: "what's due tonight?", author: "Ryan", place: { kind: "lobby" }, now: WED_EVENING });
  assert.match(text.split("\n")[0]!, /^It's Wednesday, October 14, 2026, 8:11 PM EDT for Ryan \(Indiana time\)/);
  assert.match(text, /Ryan says:\nwhat's due tonight\?/);
});

test("a turn's Claude Code runs on Indiana time even when the bot's own clock is UTC", () => {
  const before = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const dir = mkdtempSync(join(tmpdir(), "dum-clock-"));
    const command = chatCommand({ claude: "claude", dumBin: "dum", repo: "/repo", turnDir: dir, goalId: null, message: "hi", resume: null, model: null });
    assert.equal(command.env.TZ, HOME_TZ);
    // A process started with that environment (as Claude Code is) dates the evening as Wednesday.
    const seen = execFileSync(process.execPath, ["-e", `const d = new Date(${WED_EVENING.getTime()}); console.log(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getDay())`], { env: command.env, encoding: "utf8" }).trim();
    assert.equal(seen, "2026 10 14 3");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("handoffs are dated by Ryan's day, and updates stamped in his time", () => {
  const root = mkdtempSync(join(tmpdir(), "dum-handoff-clock-"));
  const h = createHandoff(root, { title: "Check the clock", executor: "hub", requester: "dum", body: "Nothing secret." }, WED_EVENING);
  assert.match(h.id, /^2026-10-14-check-the-clock$/);
  assert.match(readFileSync(join(root, h.id, "task.md"), "utf8"), /- Date: 2026-10-14\n/);
  writeResult(root, { id: h.id, executor: "hub", status: "running", body: "Started." }, WED_EVENING);
  writeResult(root, { id: h.id, executor: "hub", status: "done", body: "Done." }, new Date("2026-10-15T01:30:00Z"));
  const result = readFileSync(join(root, h.id, "result.md"), "utf8");
  assert.match(result, /- Date: 2026-10-14\n/);
  assert.match(result, /## Update 2026-10-14 21:30 EDT\n/);
});

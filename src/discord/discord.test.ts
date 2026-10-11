// Delivery planning and command routing, without Discord or the workshop: one status message per
// job, edits on real state changes, exactly one ping per finished job, no replayed history, and
// nobody but the owner in the bound channel gets anything done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptExisting, emptyLedger, nonceFor, panelImages, plan, record, type JobView, type Ledger, type Step } from "./delivery.ts";
import { handle, type Context, type Interaction } from "./commands.ts";

const links = { app: "http://hub:8770", artifacts: "http://hub:8771" };
const OWNER = "111";
const goals = [{ id: "g1", title: "CS 180 loops" }];
const JOB = "1c4314d2-276d-4b63-afbf-23436a2d7a2a";

function job(state: JobView["state"], extra: Partial<JobView> = {}): JobView {
  return { id: JOB, goalId: "g1", state, createdAt: "2026-10-11T00:00:00Z", ...extra };
}

const ready = (extra: Partial<JobView> = {}) =>
  job("ready", {
    artifactId: JOB,
    result: { title: "Creature shelter", panels: [{ image: "captures/panel-1.png", caption: "a" }, { caption: "no image" }, { image: "../etc/passwd.png", caption: "b" }] },
    ...extra,
  });

/** Runs the planner to a fixed point the way the bot does, returning every step taken. */
function drive(jobs: JobView[], start: Ledger): { steps: Step[]; ledger: Ledger } {
  let ledger = start;
  const steps: Step[] = [];
  for (const step of plan(jobs, goals, ledger, links, OWNER)) {
    steps.push(step);
    ledger = record(ledger, step, step.kind === "postStatus" ? "m1" : undefined);
  }
  return { steps, ledger };
}

test("a job's life is one status post, edits per real stage, and one ping when it finishes", () => {
  let l = emptyLedger();
  let r = drive([job("queued")], l);
  assert.deepEqual(r.steps.map((s) => s.kind), ["postStatus"]);
  l = r.ledger;
  assert.deepEqual(drive([job("queued")], l).steps, [], "no change, no message");

  r = drive([job("running")], l);
  assert.deepEqual(r.steps.map((s) => s.kind), ["editStatus"]);
  assert.equal((r.steps[0] as { messageId: string }).messageId, "m1");
  l = r.ledger;

  r = drive([ready()], l);
  assert.deepEqual(r.steps.map((s) => s.kind), ["editStatus", "final"]);
  l = r.ledger;
  assert.deepEqual(drive([ready()], l).steps, [], "finished jobs never ping twice");
});

test("status messages never ping; the final message pings only the owner and points back to hub", () => {
  const { steps } = drive([ready()], emptyLedger());
  const status = steps.find((s) => s.kind === "postStatus")!;
  const final = steps.find((s) => s.kind === "final")!;
  assert.doesNotMatch(status.content, /<@/);
  assert.match(final.content, new RegExp(`^<@${OWNER}>`));
  assert.match(final.content, new RegExp(`http://hub:8770/#job=${JOB}`));
});

test("job text cannot mention anyone", () => {
  const { steps } = drive([ready({ result: { title: "hi @everyone <@222>", panels: [] } })], emptyLedger());
  for (const s of steps) assert.doesNotMatch(s.content.replace(`<@${OWNER}>`, ""), /@everyone|<@222>/);
});

test("failures ping without dumping the error text", () => {
  const { steps } = drive([job("failed", { error: "secret path /home/x/.config token=abc" } as Partial<JobView>)], emptyLedger());
  const final = steps.find((s) => s.kind === "final")!;
  assert.doesNotMatch(final.content, /secret|token/);
  assert.match(final.content, /failed/);
});

test("existing jobs are adopted silently, and one that later changes gets a fresh message and a single ping", () => {
  const adopted = adoptExisting(emptyLedger(), [job("running"), { ...ready(), id: "other" }]);
  assert.deepEqual(drive([job("running"), { ...ready(), id: "other" }], adopted).steps, []);
  let r = drive([ready()], adopted);
  assert.deepEqual(r.steps.map((s) => s.kind), ["postStatus", "final"]);
  assert.deepEqual(drive([ready()], r.ledger).steps, []);
});

test("only safe png panel paths become screenshot URLs, at most four", () => {
  assert.deepEqual(panelImages(ready(), links), [`http://hub:8771/artifacts/${JOB}/captures/panel-1.png`]);
  const many = ready({ result: { title: "t", panels: Array.from({ length: 6 }, (_, n) => ({ image: `c/p${n}.png`, caption: "" })) } });
  assert.equal(panelImages(many, links).length, 4);
  assert.deepEqual(panelImages(job("running"), links), []);
});

test("nonces are stable per job and step, and short enough for Discord", () => {
  const a = plan([ready()], goals, emptyLedger(), links, OWNER);
  const b = plan([ready()], goals, emptyLedger(), links, OWNER);
  assert.deepEqual(a.map(nonceFor), b.map(nonceFor));
  assert.notEqual(nonceFor(a[0]), nonceFor(a[1]));
  for (const s of a) assert.ok(nonceFor(s).length <= 25);
});

// --- commands ---

function ctx(calls: string[] = []): Context {
  return {
    ownerId: OWNER,
    guildId: "G",
    channelId: "C",
    links,
    workshop: {
      goals: async () => [{ id: "a4388d77-30f9-4900-a531-e6004a8fcb01", title: "CS 180 loops" }],
      jobs: async () => [ready()],
      build: async (g) => (calls.push(`build ${g}`), job("queued", { id: "22222222-2222-2222-2222-222222222222" })),
      correct: async (j, c) => (calls.push(`correct ${j} ${c}`), job("queued", { id: "33333333-3333-3333-3333-333333333333" })),
    },
  };
}

function cmd(sub: string, options: { name: string; value: string; focused?: boolean }[] = [], who = OWNER, type = 2, channel = "C"): Interaction {
  return { type, guild_id: "G", channel_id: channel, member: { user: { id: who } }, data: { name: "dum", options: [{ name: sub, type: 1, options: options.map((o) => ({ type: 3, ...o })) }] } };
}

test("only the owner, in the bound channel, can build", async () => {
  const calls: string[] = [];
  const goal = "a4388d77-30f9-4900-a531-e6004a8fcb01";
  const stranger = await handle(cmd("build", [{ name: "goal", value: goal }], "999"), ctx(calls));
  const elsewhere = await handle(cmd("build", [{ name: "goal", value: goal }], OWNER, 2, "other"), ctx(calls));
  assert.deepEqual(calls, []);
  assert.equal(stranger?.type, 4);
  assert.equal(elsewhere?.type, 4);
  const ok = await handle(cmd("build", [{ name: "goal", value: goal }]), ctx(calls));
  assert.deepEqual(calls, [`build ${goal}`]);
  assert.match((ok as { data: { content: string } }).data.content, /Queued `22222222`/);
});

test("correct queues a new version and links the untouched original", async () => {
  const calls: string[] = [];
  const r = await handle(cmd("correct", [{ name: "creation", value: JOB }, { name: "correction", value: "Pip should be fed at 5" }]), ctx(calls));
  assert.deepEqual(calls, [`correct ${JOB} Pip should be fed at 5`]);
  assert.match((r as { data: { content: string } }).data.content, new RegExp(`#job=${JOB}`));
});

test("free text that isn't a picked id is refused before reaching the workshop", async () => {
  const calls: string[] = [];
  await handle(cmd("build", [{ name: "goal", value: "rm -rf /" }]), ctx(calls));
  await handle(cmd("correct", [{ name: "creation", value: "nope" }, { name: "correction", value: "x" }]), ctx(calls));
  assert.deepEqual(calls, []);
});

test("autocomplete offers goals and ready creations, and nothing to strangers", async () => {
  const goalsOut = await handle(cmd("build", [{ name: "goal", value: "loop", focused: true }], OWNER, 4), ctx());
  assert.deepEqual(goalsOut, { type: 8, data: { choices: [{ name: "CS 180 loops", value: "a4388d77-30f9-4900-a531-e6004a8fcb01" }] } });
  const creations = await handle(cmd("correct", [{ name: "creation", value: "", focused: true }], OWNER, 4), ctx());
  assert.equal((creations as { data: { choices: unknown[] } }).data.choices.length, 1);
  assert.deepEqual(await handle(cmd("build", [{ name: "goal", value: "", focused: true }], "999", 4), ctx()), { type: 8, data: { choices: [] } });
});

test("replies never allow mentions", async () => {
  const r = await handle(cmd("status"), ctx());
  assert.deepEqual((r as { data: { allowed_mentions: unknown } }).data.allowed_mentions, { parse: [] });
});

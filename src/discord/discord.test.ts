// Delivery planning, goal channels and command routing, without Discord or the workshop: one
// status message per job in its goal's channel, exactly one ping per finished job, no replayed
// history, one channel per goal, and nobody but the owner in Dum's own channels gets anything done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptExisting, emptyLedger, nonceFor, panelImages, plan, record, type JobView, type Ledger, type Route, type Step } from "./delivery.ts";
import { emptyBindings, overwrites, planChannels, slug, topic } from "./channels.ts";
import { handle, isPrivate, opensModal, type Context, type Interaction } from "./commands.ts";
import type { GoalDetail } from "../client/workshop.ts";
import { approvalCard, adoptHandoffs, boardMessage, decidedCard, parseDecision, planNotices } from "./presence.ts";
import { parseSprite, renderPng, avatarPng } from "./glyph.ts";
import type { DumRequest } from "../shared/requests.ts";
import type { Handoff } from "../shared/handoff.ts";
import { linkLines, pickUploads, postContent } from "./files.ts";
import type { FilePost } from "../shared/file-posts.ts";

/** Everything a message would show, to check what it says. */
const shown = (s: Step) => JSON.stringify(s.message);

const links = { app: "http://hub:8770", artifacts: "http://hub:8771" };
const OWNER = "111";
const LOBBY = "C";
const GOAL = "a4388d77-30f9-4900-a531-e6004a8fcb01";
const OTHER_GOAL = "42d5b97a-5728-46b3-b7b2-6b0eab5ed0a3";
const goals = [{ id: GOAL, title: "CS 180 loops" }];
const JOB = "1c4314d2-276d-4b63-afbf-23436a2d7a2a";
const route: Route = { lobbyId: LOBBY, channelFor: (g) => (g === GOAL ? "GC" : null) };

function job(state: JobView["state"], extra: Partial<JobView> = {}): JobView {
  return { id: JOB, goalId: GOAL, state, createdAt: "2026-10-11T00:00:00Z", ...extra };
}

const ready = (extra: Partial<JobView> = {}) =>
  job("ready", {
    artifactId: JOB,
    result: { title: "Creature shelter", panels: [{ image: "captures/panel-1.png", caption: "a" }, { caption: "no image" }, { image: "../etc/passwd.png", caption: "b" }] },
    ...extra,
  });

/** Runs the planner the way the bot does, returning every step taken. */
function drive(jobs: JobView[], start: Ledger, r: Route = route, posted = "m1"): { steps: Step[]; ledger: Ledger } {
  let ledger = start;
  const steps: Step[] = [];
  for (const step of plan(jobs, goals, ledger, links, OWNER, r)) {
    steps.push(step);
    ledger = record(ledger, step, step.kind === "postStatus" ? posted : undefined);
  }
  return { steps, ledger };
}

test("a job's life is one status post in its goal's channel, edits per real stage, and one ping", () => {
  let r = drive([job("queued")], emptyLedger());
  assert.deepEqual(r.steps.map((s) => [s.kind, s.channelId]), [["postStatus", "GC"]]);
  let l = r.ledger;
  assert.deepEqual(drive([job("queued")], l).steps, [], "no change, no message");

  r = drive([job("running")], l);
  assert.deepEqual(r.steps.map((s) => s.kind), ["editStatus"]);
  assert.equal((r.steps[0] as { messageId: string }).messageId, "m1");
  l = r.ledger;

  r = drive([ready()], l);
  assert.deepEqual(r.steps.map((s) => [s.kind, s.channelId]), [["editStatus", "GC"], ["final", "GC"]]);
  assert.deepEqual(drive([ready()], r.ledger).steps, [], "finished jobs never ping twice");
});

test("a goal without a channel yet uses the lobby, and its message is edited there afterwards", () => {
  const none: Route = { lobbyId: LOBBY, channelFor: () => null };
  const r = drive([job("queued")], emptyLedger(), none);
  assert.equal(r.steps[0].channelId, LOBBY);
  // The goal gets its channel later: the existing message is still edited where it lives.
  const next = drive([job("running")], r.ledger);
  assert.deepEqual(next.steps.map((s) => [s.kind, s.channelId]), [["editStatus", LOBBY]]);
  assert.equal((next.steps[0] as { home: string }).home, "GC");
});

test("entries from before goal channels are edited in the lobby", () => {
  const old: Ledger = { schemaVersion: 1, jobs: { [JOB]: { messageId: "m0", stage: "queued", finalSent: false } } };
  const r = drive([job("running")], old);
  assert.deepEqual(r.steps.map((s) => [s.kind, s.channelId]), [["editStatus", LOBBY]]);
});

test("an edit that had to become a fresh post moves the ledger to the new message and channel", () => {
  const l: Ledger = { schemaVersion: 1, jobs: { [JOB]: { messageId: "m0", channelId: "deleted", stage: "queued", finalSent: false } } };
  const [edit] = plan([job("running")], goals, l, links, OWNER, route);
  assert.equal(edit.kind, "editStatus");
  const after = record(l, edit, "m2");
  assert.deepEqual(after.jobs[JOB], { messageId: "m2", channelId: "GC", stage: "running", finalSent: false });
  assert.deepEqual(record(l, edit).jobs[JOB].messageId, "m0", "a plain edit keeps the message");
});

test("status messages never ping; the final message pings only the owner and points back to hub", () => {
  const { steps } = drive([ready()], emptyLedger());
  const status = steps.find((s) => s.kind === "postStatus")!;
  const final = steps.find((s) => s.kind === "final")!;
  assert.doesNotMatch(shown(status), /<@/);
  assert.match(final.message.content!, new RegExp(`^<@${OWNER}>`));
  assert.match(shown(final), new RegExp(`http://hub:8770/#job=${JOB}`));
});

test("job text cannot mention anyone", () => {
  const { steps } = drive([ready({ result: { title: "hi @everyone <@222>", panels: [] } })], emptyLedger());
  for (const s of steps) assert.doesNotMatch((s.message.content ?? "").replace(`<@${OWNER}>`, ""), /@everyone|<@222>/);
});

test("failures ping without dumping the error text", () => {
  const { steps } = drive([job("failed", { error: "secret path /home/x/.config token=abc" } as Partial<JobView>)], emptyLedger());
  const final = steps.find((s) => s.kind === "final")!;
  assert.doesNotMatch(shown(final), /secret|token/);
  assert.match(shown(final), /failed/);
});

test("existing jobs are adopted silently, and one that later changes gets a fresh message and a single ping", () => {
  const adopted = adoptExisting(emptyLedger(), [job("running"), { ...ready(), id: "other" }]);
  assert.deepEqual(drive([job("running"), { ...ready(), id: "other" }], adopted).steps, []);
  const r = drive([ready()], adopted);
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
  const a = plan([ready()], goals, emptyLedger(), links, OWNER, route);
  const b = plan([ready()], goals, emptyLedger(), links, OWNER, route);
  assert.deepEqual(a.map(nonceFor), b.map(nonceFor));
  assert.notEqual(nonceFor(a[0]), nonceFor(a[1]));
  for (const s of a) assert.ok(nonceFor(s).length <= 25);
});

// --- goal channels ---

test("goal titles become valid channel names", () => {
  assert.equal(slug("CS 180: Recursion!"), "cs-180-recursion");
  assert.equal(slug("Workshop verification: creature shelter"), "workshop-verification-creature-shelter");
  assert.equal(slug("Évaluer   les  données"), "evaluer-les-donnees");
  assert.equal(slug("!!!"), "goal");
  assert.ok(slug("x".repeat(300)).length <= 90);
});

test("every goal gets exactly one channel, and a deleted one is made again", () => {
  const two = [...goals, { id: OTHER_GOAL, title: "CS 180: recursion" }];
  let plan1 = planChannels(two, emptyBindings(), null);
  assert.deepEqual(plan1.orphaned, []);
  assert.equal(plan1.category, true);
  assert.deepEqual(plan1.create.map((g) => g.id), [GOAL, OTHER_GOAL]);

  const bound = { schemaVersion: 1 as const, categoryId: "cat", goals: { [GOAL]: { channelId: "c1" }, [OTHER_GOAL]: { channelId: "c2" } } };
  assert.deepEqual(planChannels(two, bound, null), { category: false, create: [], forget: [], orphaned: [] });
  assert.deepEqual(planChannels(two, bound, new Set(["cat", "c1", "c2"])), { category: false, create: [], forget: [], orphaned: [] });

  plan1 = planChannels(two, bound, new Set(["cat", "c1"]));
  assert.deepEqual(plan1.forget, [OTHER_GOAL]);
  assert.deepEqual(plan1.create.map((g) => g.id), [OTHER_GOAL]);
  assert.equal(planChannels(two, bound, new Set(["c1", "c2"])).category, true, "a deleted category is made again");
});

test("a goal deleted from the workshop is unbound, never remade, even if its channel is gone too", () => {
  const bound = { schemaVersion: 1 as const, categoryId: "cat", goals: { [GOAL]: { channelId: "c1" }, [OTHER_GOAL]: { channelId: "c2" } } };
  const p = planChannels(goals, bound, new Set(["cat", "c1"]));
  assert.deepEqual(p.orphaned, [OTHER_GOAL]);
  assert.deepEqual(p.forget, [], "a missing channel for a deleted goal is not remade");
  assert.deepEqual(p.create, []);
});

test("goal channels are private: everyone denied, the bot allowed only what it was invited with", () => {
  const [everyone, bot] = overwrites("G", "B");
  assert.deepEqual(everyone, { id: "G", type: 0, allow: "0", deny: "1024" });
  assert.deepEqual(bot, { id: "B", type: 1, allow: "117760", deny: "0" });
});

test("channel topics fit Discord's limit and keep the link", () => {
  const t = topic("a ".repeat(2000), "http://hub:8770");
  assert.ok(t.length <= 1024);
  assert.ok(t.endsWith("http://hub:8770"));
});

// --- commands ---

function detail(extra: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: GOAL,
    title: "CS 180 loops",
    ambition: "a shelter",
    baseContext: "week 6",
    materials: [{ id: "m-loops", concept: "loops", title: "Visiting every item", body: "# Loops" }],
    schedule: null,
    ...extra,
  };
}

function ctx(calls: string[] = [], over: Partial<GoalDetail> = {}): Context {
  return {
    ownerId: OWNER,
    guildId: "G",
    lobbyId: LOBBY,
    links,
    channels: {
      goalFor: (c) => (c === "GC" ? GOAL : c === "OC" ? OTHER_GOAL : null),
      channelFor: (g) => (g === GOAL ? "GC" : null),
      open: async (g) => (calls.push(`open ${g.title}`), "NEWC"),
    },
    workshop: {
      goals: async () => [{ id: GOAL, title: "CS 180 loops" }],
      goal: async () => detail(over),
      jobs: async () => [ready()],
      job: async () => ready(),
      teachings: async () => [],
      createGoal: async (title) => (calls.push(`create ${title}`), { id: OTHER_GOAL, title }),
      teach: async (g, c, t) => void calls.push(`teach ${g} ${c} ${t}`),
      setContext: async (g, c) => void calls.push(`context ${g} ${c}`),
      studied: async (g, c) => void calls.push(`studied ${g} ${c}`),
      tried: async (g, c, t, h) => void calls.push(`tried ${g} ${c} ${t} ${h}`),
      revisit: async (g, c, n) => void calls.push(`revisit ${g} ${c} ${n}`),
      progress: async () => [{ concept: "loops", counts: { introduced: 1, needsRevisiting: 0 }, latest: "introduced", latestAt: "2026-10-12T00:00:00Z" }],
      schedule: async (g, m) => (calls.push(`schedule ${g} ${m}`), m === null ? null : { intervalMinutes: m, nextRunAt: "2026-10-12T00:00:00Z" }),
      build: async (g) => (calls.push(`build ${g}`), job("queued", { id: "22222222-2222-2222-2222-222222222222" })),
      correct: async (j, c) => (calls.push(`correct ${j} ${c}`), job("queued", { id: "33333333-3333-3333-3333-333333333333" })),
      share: async () => assert.fail("commands never share files"),
      shares: async () => [],
      unshare: async () => assert.fail("commands never unshare files"),
      sharedContexts: async () => [],
      setShared: async () => assert.fail("commands never set shared context"),
      deleteShared: async () => assert.fail("commands never delete shared context"),
      file: async () => null,
    },
  };
}

type Opt = { name: string; value: string | number | boolean; focused?: boolean };
function cmd(sub: string, options: Opt[] = [], { who = OWNER, type = 2, channel = "GC" } = {}): Interaction {
  return { type, guild_id: "G", channel_id: channel, member: { user: { id: who } }, data: { name: "dum", options: [{ name: sub, type: 1, options: options.map((o) => ({ type: 3, ...o })) }] } };
}
function form(custom_id: string, values: Record<string, string>, { who = OWNER, channel = "GC" } = {}): Interaction {
  const components = Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] }));
  return { type: 5, guild_id: "G", channel_id: channel, member: { user: { id: who } }, data: { custom_id, components } };
}
const content = (r: unknown) => (r as { data: { content: string } }).data.content;

test("only the owner, in the lobby or a goal channel, can do anything", async () => {
  const calls: string[] = [];
  for (const i of [cmd("build", [], { who: "999" }), cmd("build", [], { channel: "general" }), form(`teach:${GOAL}`, { concept: "x", text: "y" }, { who: "999" })]) {
    const r = await handle(i, ctx(calls));
    assert.equal(r?.type, 4);
    assert.match(content(r), /only takes requests from its owner/);
  }
  assert.deepEqual(calls, []);
});

test("goal commands act on the channel's goal and are refused in the lobby", async () => {
  const calls: string[] = [];
  await handle(cmd("build"), ctx(calls));
  await handle(cmd("build", [], { channel: "OC" }), ctx(calls));
  assert.deepEqual(calls, [`build ${GOAL}`, `build ${OTHER_GOAL}`]);
  const lobby = await handle(cmd("build", [], { channel: LOBBY }), ctx(calls));
  assert.match(content(lobby), /goal's own channel/);
  assert.equal(calls.length, 2);
});

test("a new goal is made from a form and gets its channel", async () => {
  const calls: string[] = [];
  const open = await handle(cmd("goal", [], { channel: LOBBY }), ctx(calls));
  assert.equal(open?.type, 9);
  const r = await handle(form("goal", { title: "CS 180: recursion", ambition: "a puzzle solver" }, { channel: LOBBY }), ctx(calls));
  assert.deepEqual(calls, ["create CS 180: recursion", "open CS 180: recursion"]);
  assert.match(content(r), /<#NEWC>/);
});

test("teaching goes through a form and is recorded in the learner's own words", async () => {
  const calls: string[] = [];
  const open = await handle(cmd("teach", [{ name: "concept", value: "recursion" }]), ctx(calls));
  assert.equal(open?.type, 9);
  assert.equal((open as { data: { custom_id: string } }).data.custom_id, `teach:${GOAL}`);
  const r = await handle(form(`teach:${GOAL}`, { concept: "recursion", text: "It calls itself on a smaller case @everyone" }), ctx(calls));
  assert.deepEqual(calls, [`teach ${GOAL} recursion It calls itself on a smaller case @everyone`]);
  assert.doesNotMatch(content(r), /@everyone/);
  assert.match(content(r), /> It calls itself/);
});

test("a form only acts on the goal of the channel it was opened in", async () => {
  const calls: string[] = [];
  const r = await handle(form(`teach:${OTHER_GOAL}`, { concept: "c", text: "t" }), ctx(calls));
  assert.deepEqual(calls, []);
  assert.match(content(r), /different goal/);
});

test("attempts are recorded as the learner's own report, with the help flag carried through the form", async () => {
  const calls: string[] = [];
  const open = await handle(cmd("tried", [{ name: "concept", value: "loops" }, { name: "helped", value: true }]), ctx(calls));
  assert.equal((open as { data: { custom_id: string } }).data.custom_id, `tried:${GOAL}:1`);
  const r = await handle(form(`tried:${GOAL}:1`, { concept: "loops", text: "summed a list" }), ctx(calls));
  assert.deepEqual(calls, [`tried ${GOAL} loops summed a list true`]);
  assert.match(content(r), /with help, your report/);
});

test("context is edited in a form when it fits and added to when it doesn't", async () => {
  const calls: string[] = [];
  const small = await handle(cmd("context"), ctx(calls));
  assert.equal((small as { data: { custom_id: string } }).data.custom_id, `context:${GOAL}:edit`);
  await handle(form(`context:${GOAL}:edit`, { context: "week 7" }), ctx(calls));
  const big = await handle(cmd("context"), ctx(calls, { baseContext: "x".repeat(5000) }));
  assert.equal((big as { data: { custom_id: string } }).data.custom_id, `context:${GOAL}:add`);
  await handle(form(`context:${GOAL}:add`, { context: "more" }), ctx(calls, { baseContext: "old" }));
  assert.deepEqual(calls, [`context ${GOAL} week 7`, `context ${GOAL} old\n\nmore`]);
});

test("correct only takes this goal's creations and links the untouched original", async () => {
  const calls: string[] = [];
  const r = await handle(cmd("correct", [{ name: "creation", value: JOB }, { name: "correction", value: "Pip should be fed at 5" }]), ctx(calls));
  assert.deepEqual(calls, [`correct ${JOB} Pip should be fed at 5`]);
  assert.match(content(r), new RegExp(`#job=${JOB}`));
  const elsewhere = await handle(cmd("correct", [{ name: "creation", value: JOB }, { name: "correction", value: "x" }], { channel: "OC" }), ctx(calls));
  assert.match(content(elsewhere), /different goal/);
  assert.equal(calls.length, 1);
});

test("free text that isn't a picked id is refused before reaching the workshop", async () => {
  const calls: string[] = [];
  await handle(cmd("correct", [{ name: "creation", value: "nope" }, { name: "correction", value: "x" }]), ctx(calls));
  const r = await handle(cmd("study", [{ name: "material", value: "../../etc" }]), ctx(calls));
  assert.match(content(r), /Pick a material/);
  assert.deepEqual(calls, []);
});

test("schedule turns on with minutes and off without", async () => {
  const calls: string[] = [];
  assert.match(content(await handle(cmd("schedule", [{ name: "minutes", value: 1440 }]), ctx(calls))), /every 1440 minutes/);
  assert.match(content(await handle(cmd("schedule"), ctx(calls))), /off/);
  assert.deepEqual(calls, [`schedule ${GOAL} 1440`, `schedule ${GOAL} null`]);
});

test("study shows the material privately; studied and revisit record it in the channel", async () => {
  const calls: string[] = [];
  const s = await handle(cmd("study", [{ name: "material", value: "m-loops" }]), ctx(calls));
  assert.equal((s as { data: { flags?: number } }).data.flags, 64);
  assert.equal((s as { data: { embeds: { description: string }[] } }).data.embeds[0].description, "# Loops");
  await handle(cmd("studied", [{ name: "concept", value: "loops" }]), ctx(calls));
  await handle(cmd("revisit", [{ name: "concept", value: "loops" }, { name: "note", value: "off by one" }]), ctx(calls));
  assert.deepEqual(calls, [`studied ${GOAL} loops`, `revisit ${GOAL} loops off by one`]);
});

test("autocomplete offers this goal's concepts, materials and creations, accepts new concepts, and gives strangers nothing", async () => {
  const concepts = await handle(cmd("teach", [{ name: "concept", value: "recur", focused: true }], { type: 4 }), ctx());
  assert.deepEqual(concepts, { type: 8, data: { choices: [{ name: "recur", value: "recur" }] } });
  const known = await handle(cmd("teach", [{ name: "concept", value: "loo", focused: true }], { type: 4 }), ctx());
  assert.deepEqual((known as { data: { choices: { value: string }[] } }).data.choices.map((c) => c.value), ["loo", "loops"]);
  const creations = await handle(cmd("correct", [{ name: "creation", value: "", focused: true }], { type: 4 }), ctx());
  assert.equal((creations as { data: { choices: unknown[] } }).data.choices.length, 1);
  assert.deepEqual(await handle(cmd("teach", [{ name: "concept", value: "", focused: true }], { type: 4, who: "999" }), ctx()), { type: 8, data: { choices: [] } });
});

test("forms open immediately; reads are private; changes are part of the channel's record", () => {
  assert.equal(opensModal(cmd("teach", [{ name: "concept", value: "x" }])), true);
  assert.equal(opensModal(cmd("build")), false);
  assert.equal(isPrivate(cmd("status")), true);
  assert.equal(isPrivate(cmd("build")), true, "the status message is the build's public record");
  assert.equal(isPrivate(cmd("studied", [{ name: "concept", value: "x" }])), false);
  assert.equal(isPrivate(form(`teach:${GOAL}`, {})), false);
});

test("replies never allow mentions", async () => {
  const r = await handle(cmd("status"), ctx());
  assert.deepEqual((r as { data: { allowed_mentions: unknown } }).data.allowed_mentions, { parse: [] });
});

// --- embeds ---

test("status embeds show the real stage track and change color with it", () => {
  const r = drive([job("running")], emptyLedger());
  const e = r.steps[0]!.message.embeds[0]!;
  assert.match(e.description!, /✓ queued {2}· {2}◆ \*\*generating & verifying\*\* {2}· {2}○ ready/);
  assert.equal(e.color, 0xf0c266);
  assert.equal(e.url, undefined, "no link until there is something to read");
  const done = drive([ready()], emptyLedger()).steps;
  assert.equal(done[0]!.message.embeds[0]!.url, `http://hub:8770/#job=${JOB}`);
});

test("a finished creation shows its first screenshot and a gallery of the rest, all linking to it", () => {
  const four = ready({ result: { title: "Shelter", panels: Array.from({ length: 4 }, (_, n) => ({ image: `c/p${n}.png`, caption: `Page ${n}` })) } });
  const final = drive([four], emptyLedger()).steps.find((s) => s.kind === "final")!;
  assert.equal(final.kind === "final" && final.images.length, 4);
  const [main, ...gallery] = final.message.embeds;
  assert.equal(main!.image!.url, "attachment://panel-1.png");
  assert.match(main!.description!, /Page 0[\s\S]*Read the 4-page presentation/);
  assert.deepEqual(gallery.map((e) => e.image!.url), ["attachment://panel-2.png", "attachment://panel-3.png", "attachment://panel-4.png"]);
  for (const e of final.message.embeds) assert.equal(e.url, `http://hub:8770/#job=${JOB}`);
});

// --- approvals, notices, board ---

const REQ: DumRequest = { schemaVersion: 1, id: "0b8f7c1e-1111-4222-8333-944445555666", kind: "teach", goalId: GOAL, concept: "recursion", text: "It calls itself\non a smaller case", requestedBy: "claude-ai", createdAt: "2026-10-11T09:00:00Z", status: "pending" };

test("an approval card pings Ryan, quotes the exact words, and offers yes or no", () => {
  const card = approvalCard(REQ, "software", OWNER);
  assert.match(card.content!, new RegExp(`^<@${OWNER}> \\*\\*claude-ai\\*\\* wants to record this as your teaching`));
  assert.equal(card.embeds[0]!.description, "> It calls itself\n> on a smaller case");
  assert.deepEqual(card.components[0]!.components.map((b) => b.custom_id), [`req:${REQ.id}:yes`, `req:${REQ.id}:no`]);
  assert.deepEqual(parseDecision(`req:${REQ.id}:yes`), { id: REQ.id, approve: true });
  assert.equal(parseDecision("req:../x:yes"), null);
  const decided = decidedCard({ ...REQ, status: "declined" }, "software");
  assert.deepEqual(decided.components, [], "buttons go away once decided");
  assert.match(decided.content!, /Nothing was recorded/);
});

const H = (id: string, status: Handoff["status"], executor = "laptop"): Handoff => ({ id, title: `Task ${id}`, executor, requester: "omp", status, updatedAt: "2026-10-11T09:00:00Z" });

test("handoff notices: silent adoption, a ping for new laptop work and blockers, quiet otherwise", () => {
  const seen = adoptHandoffs([H("2026-10-11-old", "done")]);
  assert.deepEqual(planNotices([H("2026-10-11-old", "done")], seen, OWNER).notices, []);
  const r = planNotices([H("2026-10-11-new", "open"), H("2026-10-11-hubwork", "open", "hub"), H("2026-10-11-old", "done")], seen, OWNER);
  const byId = Object.fromEntries(r.notices.map((n) => [n.id, n]));
  assert.equal(byId["2026-10-11-new"]!.ping, true);
  assert.equal(byId["2026-10-11-hubwork"]!.ping, false);
  const later = planNotices([H("2026-10-11-new", "blocked")], r.next, OWNER);
  assert.equal(later.notices[0]!.ping, true);
  assert.match(later.notices[0]!.message.content!, /blocked/);
  assert.deepEqual(planNotices([H("2026-10-11-new", "blocked")], later.next, OWNER).notices, [], "each change is told once");
});

test("the board says what Dum is doing, what's waiting on Ryan, and where", () => {
  const msg = boardMessage({
    goals: [{ id: GOAL, title: "CS 180 loops", schedule: { intervalMinutes: 1440, nextRunAt: "2026-10-12T00:00:00Z" } }],
    jobs: [job("running", { startedAt: "2026-10-11T09:00:00Z" }), { ...ready(), id: "x", finishedAt: "2026-10-11T08:00:00Z" }],
    pending: [REQ],
    handoffs: [H("2026-10-11-new", "open")],
    links,
    channelFor: (g) => (g === GOAL ? "GC" : null),
  });
  const e = msg.embeds[0]!;
  assert.match(e.description!, /Making something for <#GC>, started <t:\d+:R>/);
  const field = (name: string) => e.fields!.find((f) => f.name === name)!.value;
  assert.match(field("Waiting on you"), /teaching \*recursion\* in <#GC>/);
  assert.match(field("Latest creation"), /\[Creature shelter\]\(http:\/\/hub:8770\/#job=x\)/);
  assert.match(field("Handoffs in flight"), /Task 2026-10-11-new/);
  assert.match(field("Scheduled"), /every 1440 min/);
  const idle = boardMessage({ goals: [], jobs: [], pending: [], handoffs: [], links, channelFor: () => null });
  assert.match(idle.embeds[0]!.description!, /Idle/);
});

test("Dum's glyph renders as a real PNG from the authored sprite", () => {
  const png = avatarPng(64);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 64);
  const sprite = parseSprite("palette\n. none\no 000000\nend\n\nframe a\no.\n.o\n");
  assert.deepEqual(sprite.frames.get("a"), ["o.", ".o"]);
  assert.ok(renderPng(sprite, "a", 16, [255, 255, 255]).length > 50);
});

// --- talking to Dum ---

import { prompt, sessionFor, splitReply, stripMentions, SESSION_IDLE_MS } from "./chat.ts";

test("mentions of the bot are stripped, other text kept", () => {
  assert.equal(stripMentions("<@123> teach you: a loop <@!123>  repeats", "123"), "teach you: a loop repeats");
  assert.equal(stripMentions("<@123>", "123"), "");
});

test("long replies split on paragraph, line or word boundaries under Discord's limit", () => {
  const text = Array.from({ length: 40 }, (_, n) => `paragraph ${n} ${"word ".repeat(20)}`).join("\n\n");
  const parts = splitReply(text, 500);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 500);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " ").trim());
});

test("a channel's conversation continues while active and starts fresh after a quiet stretch", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const s = { schemaVersion: 1 as const, channels: { a: { sessionId: "s1", lastAt: "2026-10-11T11:00:00Z" }, b: { sessionId: "s2", lastAt: new Date(now.getTime() - SESSION_IDLE_MS - 1).toISOString() } } };
  assert.equal(sessionFor(s, "a", now), "s1");
  assert.equal(sessionFor(s, "b", now), null);
  assert.equal(sessionFor(s, "c", now), null);
});

test("the prompt tells Dum which goal the channel is", () => {
  assert.match(prompt({ message: "build it", author: "Ryan", place: { kind: "goal", goalId: GOAL, title: "CS 180 loops" } }), /goal "CS 180 loops" \(goal id a4388d77/);
  assert.match(prompt({ message: "hi", author: "Ryan", place: { kind: "lobby" } }), /lobby/);
});

test("progress points to the goal's full page in the workshop", async () => {
  const r = await handle(cmd("progress"), ctx());
  assert.match(content(r), new RegExp(`<http://hub:8770/#goal=${GOAL}>`));
});

// --- Dum's team: who can do what ---

import { AGENTS, CODEX_TOOL, DENIED_AGENTS } from "./agents.ts";
import { brightspaceServer, readStream, teamFooter } from "./chat.ts";
import { TOOLS } from "../mcp/server.ts";

const SHELL = ["Bash", "Edit", "Write"];
const OWN_WORDS = ["mcp__dum__dum_teach", "mcp__dum__dum_report_attempt"];

test("the Dum you talk to has no shell; only the engineer runs commands or edits code", () => {
  for (const t of SHELL) assert.equal(AGENTS.dum!.tools.includes(t), false, `dum must not have ${t}`);
  assert.ok(AGENTS.engineer!.tools.includes("Bash"));
  assert.equal(AGENTS.tutor!.tools.some((t) => SHELL.includes(t)), false, "the tutor only reads");
  assert.ok(AGENTS.engineer!.tools.includes(CODEX_TOOL), "the engineer can hand work to Codex");
  assert.ok(DENIED_AGENTS.includes("general-purpose"), "Claude Code's catch-all agent would carry the shell");
});

test("only Dum itself can record Ryan's words; no specialist can", () => {
  for (const name of ["tutor", "engineer", "librarian"]) for (const t of OWN_WORDS) assert.equal(AGENTS[name]!.tools.includes(t), false, `${name} must not have ${t}`);
  for (const t of OWN_WORDS) assert.ok(AGENTS.dum!.tools.includes(t));
});

test("every Dum tool an agent names exists, and Dum can reach all of them plus its team", () => {
  const real = new Set(TOOLS.map((t) => `mcp__dum__${t.name}`));
  for (const [name, a] of Object.entries(AGENTS)) for (const t of a.tools.filter((x) => x.startsWith("mcp__dum__"))) assert.ok(real.has(t), `${name} names ${t}, which doesn't exist`);
  for (const t of real) assert.ok(AGENTS.dum!.tools.includes(t), `dum is missing ${t}`);
  assert.ok(AGENTS.dum!.tools.includes("Agent"));
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The 26 tools brightspace-mcp-server 3.13.15 lists over MCP, as pinned in ~/opt/brightspace-mcp.
const BRIGHTSPACE_SERVER = ["get_my_courses", "get_upcoming_due_dates", "get_calendar_events", "get_my_grades", "get_announcements", "get_assignments", "get_assignment_rubric", "get_assignment_files", "get_announcement_files", "get_course_content", "download_file", "get_classlist_emails", "get_roster", "get_my_groups", "get_syllabus", "get_discussions", "get_video_transcript", "get_server_info", "search_course", "sign_out", "get_dropbox_folders", "get_dropbox_submissions", "get_dropbox_user_submissions", "get_dropbox_feedback", "get_rubrics_for_object", "download_dropbox_submission_file"];

test("Brightspace is read-only for the team: no sign-out, no classmates' details, downloads only for the librarian", () => {
  const real = new Set(BRIGHTSPACE_SERVER.map((t) => `mcp__brightspace__${t}`));
  for (const [name, a] of Object.entries(AGENTS)) {
    const named = a.tools.filter((t) => t.startsWith("mcp__brightspace__"));
    for (const t of named) assert.ok(real.has(t), `${name} names ${t}, which the server doesn't have`);
    for (const t of ["sign_out", "get_roster", "get_classlist_emails"]) assert.equal(named.includes(`mcp__brightspace__${t}`), false, `${name} must not have ${t}`);
    if (name !== "librarian") assert.equal(named.some((t) => /download/.test(t)), false, `${name} must not save Brightspace files`);
  }
  for (const name of ["dum", "tutor", "librarian"]) assert.ok(AGENTS[name]!.tools.includes("mcp__brightspace__get_upcoming_due_dates"), `${name} can see what's due`);
  assert.ok(AGENTS.librarian!.tools.includes("mcp__brightspace__download_file"));
});

test("turns get Brightspace only once its launcher is installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "dum-bs-"));
  try {
    const launcher = join(dir, "brightspace");
    assert.deepEqual(brightspaceServer(launcher), {}, "missing launcher: no server");
    writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o644 });
    assert.deepEqual(brightspaceServer(launcher), {}, "not executable: no server");
    chmodSync(launcher, 0o755);
    assert.deepEqual(brightspaceServer(launcher), { brightspace: { command: launcher, args: [] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn's event stream gives the answer, the session, and who used what", () => {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "engineer" } }] } },
    { type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "tool_use", name: "mcp__dum__dum_overview" }] } },
    "not json",
    { type: "result", result: "done!", session_id: "s1", is_error: false },
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  const r = readStream(lines.join("\n"));
  assert.deepEqual(r, { ok: true, text: "done!", sessionId: "s1", agents: ["engineer"], tools: ["Bash", "dum_overview"] });
  assert.equal(readStream(JSON.stringify({ type: "result", is_error: true, result: "boom" })).ok, false);
  assert.equal(teamFooter(["engineer", "tutor"]), "\n-# asked the engineer and the tutor");
  assert.equal(teamFooter([]), "");
  assert.equal(teamFooter(["general-purpose", "librarian"]), "\n-# asked the librarian", "a denied built-in agent isn't named as help");
});

// --- threads: many conversations at once, each in order ---

import { mkdtempSync as mkd, rmSync as rmd } from "node:fs";
import { tmpdir as tmpd } from "node:os";
import { join as pj } from "node:path";
import { listTurns, queueTurn, saveTurn, sourceText, startable, threadName, type Turn } from "./turns.ts";
import { release, tryTake, STALE_MS } from "../shared/lock.ts";

const T = (id: string, conversation: string, status: Turn["status"], createdAt: string): Turn => ({ schemaVersion: 1, id, conversation, messageId: "m", replyInline: false, goalId: null, author: "Ryan", createdAt, status, retried: false, resume: null });

test("requests run side by side, even in the same channel, oldest first, up to the cap", () => {
  const turns = [T("1", "a", "running", "1"), T("2", "a", "queued", "2"), T("3", "a", "queued", "3"), T("4", "b", "queued", "4"), T("5", "c", "queued", "5")];
  assert.deepEqual(startable(turns, 4).map((t) => t.id), ["2", "3", "4"], "a second and third request in channel a don't wait for the first");
  assert.deepEqual(startable(turns, 2).map((t) => t.id), ["2"]);
  assert.deepEqual(startable(turns, 1), []);
});

test("turns persist on disk with Ryan's words kept privately beside them", () => {
  const root = mkd(pj(tmpd(), "dum-turns-"));
  try {
    const a = queueTurn(root, { conversation: "th1", messageId: "m1", replyInline: false, goalId: GOAL, author: "Ryan", text: "build it" }, new Date("2026-10-12T00:00:01Z"));
    const b = queueTurn(root, { conversation: "th2", messageId: "m2", replyInline: true, goalId: null, author: "Ryan", text: "hi" }, new Date("2026-10-12T00:00:02Z"));
    saveTurn(root, { ...a, status: "running" });
    assert.deepEqual(listTurns(root).map((t) => [t.id, t.status]), [[a.id, "running"], [b.id, "queued"]]);
    assert.equal(sourceText(root, a.id), "build it");
  } finally {
    rmd(root, { recursive: true, force: true });
  }
});

test("thread names come from the message, short and without mentions", () => {
  assert.equal(threadName("<@123> make me a  flashcard thing for linear algebra"), "make me a flashcard thing for linear algebra");
  assert.ok(threadName("word ".repeat(60)).length <= 90);
  assert.equal(threadName("<@123>"), "chat with dum");
});

test("the self-edit lock: one holder at a time, re-entrant for its holder, and stale locks expire", () => {
  const root = mkd(pj(tmpd(), "dum-lock-"));
  const path = pj(root, "repo.lock");
  try {
    const t0 = new Date("2026-10-12T00:00:00Z");
    assert.deepEqual(tryTake(path, "add-timer", t0), { ok: true });
    assert.deepEqual(tryTake(path, "add-timer", t0), { ok: true });
    const blocked = tryTake(path, "fix-bot", t0);
    assert.equal(blocked.ok, false);
    assert.equal(release(path, "fix-bot"), false, "only the holder can release");
    assert.equal(release(path, "add-timer"), true);
    assert.deepEqual(tryTake(path, "fix-bot", t0), { ok: true });
    assert.deepEqual(tryTake(path, "late", new Date(t0.getTime() + STALE_MS + 1)), { ok: true }, "a holder that died lets go eventually");
  } finally {
    rmd(root, { recursive: true, force: true });
  }
});

test("shared files upload while they fit one message, and their links are always in the text", () => {
  const post = (name: string, size: number, attach = true): FilePost => ({
    schemaVersion: 1,
    id: "0b1c2d3e-0000-4000-8000-000000000000",
    createdAt: "2026-10-13T00:00:00Z",
    shareId: "7b0c4f7e-2a51-4d1e-9a3c-55e0d1c2b3a4",
    name,
    size,
    urlPath: `/files/7b0c4f7e-2a51-4d1e-9a3c-55e0d1c2b3a4/${name}`,
    link: `http://hub:8770/files/7b0c4f7e-2a51-4d1e-9a3c-55e0d1c2b3a4/${name}`,
    attach,
    requestedBy: "claude-code",
  });
  const MB = 1024 * 1024;
  const resume = post("resume.pdf", 34_711);
  const video = post("demo.mp4", 11 * MB);
  const half = post("a.zip", 6 * MB);
  const other = post("b.zip", 6 * MB);
  const linkOnly = post("c.pdf", 100, false);
  assert.deepEqual(pickUploads([resume, video, half, other, linkOnly]).map((p) => p.name), ["resume.pdf", "a.zip"], "over the limit, past the total, or link-only stays a link");
  assert.equal(pickUploads(Array.from({ length: 12 }, () => resume)).length, 10, "at most ten files on one message");

  const lines = linkLines(`here's your resume: ${resume.link}`, [resume, linkOnly]);
  assert.equal(lines, `\n-# c.pdf (100 B): <${linkOnly.link}>`, "a link Dum already wrote isn't repeated");
  assert.equal(linkLines("done", []), "");
  const content = postContent({ ...resume, note: "for @everyone" });
  assert.match(content, /^for @​everyone\n\*\*resume\.pdf\*\* \(34 KB\)\n-# on your tailnet: <http:\/\/hub:8770\/files\//);
});

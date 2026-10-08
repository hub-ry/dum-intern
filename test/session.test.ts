// The zone conversation on a fake agent backend: what reaches the model, which actions it gets,
// what a change may write, and what Stop and close withdraw. The gate and the ledger decide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepare, run, systemPrompt, type Ctx, type SessionHooks } from "../src/session.ts";
import { Store } from "../src/store.ts";
import { Evidence } from "../src/evidence.ts";
import { SharedFiles } from "../src/shared-files.ts";
import { listChanges } from "../src/changes.ts";
import { createRegistry } from "../src/agent/registry.ts";
import * as skills from "../src/skills.ts";
import type { AgentBackend, AgentEvent, AgentSession, OpenOptions, UserTurn } from "../src/agent/types.ts";
import type { RequestBinding } from "../src/share-types.ts";
import type { ChangeReceipt, SkillRef, ZoneContext } from "../src/zone-types.ts";

process.env.DUM_CONTEXT = "off";

const tick = () => new Promise((r) => setImmediate(r));

/** What one request's model does: events it yields, actions it calls through `act`. */
type Script = (input: UserTurn, act: (name: string, args: unknown) => Promise<{ text: string; isError?: boolean }>, o: OpenOptions) => AsyncGenerator<AgentEvent>;

/** A backend whose session plays a script, recording what it was opened with and whether it closed. */
function fakeBackend() {
  const opened: OpenOptions[] = [];
  const inputs: UserTurn[] = [];
  let closed = 0;
  let script: Script = async function* () { yield { type: "end", error: null, interrupted: false }; };
  const backend: AgentBackend = {
    id: "local",
    label: "Fake",
    models: async () => [],
    capabilities: async (selector) => ({ model: selector.model, images: false, noImages: "it can't see pictures", interrupt: true, runtimeActionCheck: true }),
    async open(o) {
      opened.push(o);
      const session: AgentSession = {
        turn(input) {
          inputs.push(input);
          const act = (name: string, args: unknown) => o.actions.find((a) => a.name === name)!.call(args, o.signal);
          return script(input, act, o);
        },
        interrupt: async () => {},
        close: () => void closed++,
      };
      return session;
    },
  };
  const agent = createRegistry([backend], new Set(["local"]));
  agent.set({
    backend: "local",
    login: "none",
    intern: { backend: "local", model: "fake-intern", effort: null },
    helper: { backend: "local", model: "fake-helper", effort: null },
    look: { backend: "local", model: "fake-look", effort: null },
  });
  return { agent, opened, inputs, closes: () => closed, play: (s: Script) => { script = s; } };
}

/** A fresh home, a zone, a shared folder of files, a store, the evidence service and a fake backend. */
async function setup(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "dum-session-home-"));
  process.env.DUM_HOME = home;
  const root = mkdtempSync(join(tmpdir(), "dum-session-files-"));
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  const id = randomUUID();
  const zone: ZoneContext = {
    id, revision: 1, breadcrumb: [{ id, name: "Data Structures" }], goal: "Learn hash maps in python",
    ancestorGoals: [], language: "python", focusSkills: [{ name: "hash maps", lang: "python" }],
    notes: [{ id, name: "Data Structures", text: "they like small examples" }],
  };
  const store = new Store({ id, name: "Data Structures" }, "understand");
  const evidence = new Evidence(home);
  const fake = fakeBackend();
  const personal = { path: "", text: "", warning: "" };
  /** What the request told the host's trail: every hook call, in order. */
  const told = { reports: [] as unknown[], changes: [] as { receipt: ChangeReceipt; skills: readonly SkillRef[] }[], proofs: [] as SkillRef[], decided: [] as string[][] };
  /** One request: a fresh binding and share of the folder, prepared the way the host does it. */
  const request = async (decide: SessionHooks["decide"] = null) => {
    const binding: RequestBinding = { zoneId: id, zoneEpoch: "epoch-1", inputToken: "token-1", requestId: randomUUID() };
    const shares = new SharedFiles(binding, null);
    const grant = await shares.grant(root, "folder");
    shares.activate();
    const hooks: SessionHooks = {
      report: (topics) => {
        told.reports.push(topics);
        return "noted on their trail";
      },
      changed: (receipt, named) => void told.changes.push({ receipt, skills: named }),
      proved: (skill) => void told.proofs.push(skill),
      decide,
    };
    const ctx = prepare(zone, "understand", store, personal, evidence, shares, fake.agent, binding, hooks);
    return { ctx, shares, grant, file: (rel: string) => `${grant.id}/${rel}` };
  };
  const done = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { home, root, zone, store, evidence, fake, request, done, told };
}

function built(name: string, lang: string) {
  skills.write(skills.unlock(skills.read(), { name, lang, how: "typed", why: "test" }));
}

const sha = (text: string) => /sha256 ([0-9a-f]{64})/.exec(text)![1]!;

async function until(ok: () => boolean) {
  for (let i = 0; i < 500 && !ok(); i++) await tick();
  assert.ok(ok(), "never happened");
}

test("the zone's context and the request's shares reach the system prompt, and only Dum's actions are offered", async () => {
  const s = await setup({ "main.py": "print('hi')\n" });
  try {
    const { ctx, grant } = await s.request();
    assert.equal(await run("what should I build next?", ctx), "ok");
    const o = s.fake.opened[0]!;
    assert.match(o.systemPrompt, /Learn hash maps in python/);
    assert.match(o.systemPrompt, /they like small examples/);
    assert.ok(o.systemPrompt.includes(basename(s.root)), "the shared folder is in the boundary");
    assert.ok(o.systemPrompt.startsWith(systemPrompt(s.zone, "understand")));
    assert.doesNotMatch(o.systemPrompt, /propose_plan|propose_change|create_file|run_command|course|wizard_aside/);
    assert.equal(o.actions.some((a) => a.name === "wizard_aside"), false, "no unprompted Wizard action");
    assert.equal(o.actions.some((a) => a.name === "decision_help"), false, "decision help only in a decision turn the user opened");
    assert.deepEqual(o.selector, { backend: "local", model: "fake-intern", effort: null });
    assert.equal(o.login, "none");
    assert.equal(o.cwd, join(s.home, "zones", s.zone.id, "runtime"));
    assert.ok(existsSync(o.cwd), "the zone's empty runtime directory is the session's cwd");
    assert.equal("binding" in o || "zone" in o, false, "the backend gets transport options only");
    assert.match(s.fake.inputs[0]!.text, /THE SKILLS YOU MAY REPORT[\s\S]*hash maps \(python\)/);
    assert.match(s.fake.inputs[0]!.text, /THEIR REQUEST:\nwhat should I build next\?$/);
    assert.equal(s.fake.closes(), 1, "one session per request, closed when it ends");
    assert.ok(grant.files.length === 1);
    assert.deepEqual(s.store.getSnapshot().models.intern, { backend: "local", model: "fake-intern", effort: null });
  } finally { s.done(); }
});

test("an action outside Dum's set stops the request", async () => {
  const s = await setup();
  try {
    const { ctx } = await s.request();
    s.fake.play(async function* () {
      yield { type: "action", name: "Bash" };
      yield { type: "text", text: "ran it anyway" };
      yield { type: "end", error: null, interrupted: false };
    });
    await run("clean up the build folder", ctx);
    const t = s.store.getSnapshot().transcript;
    assert.ok(t.some((e) => e.kind === "note" && /Bash, which dum doesn't allow - stopped/.test(e.text)));
    assert.ok(!t.some((e) => e.kind === "say"), "nothing after it is shown");
    assert.equal(s.fake.closes(), 1);
  } finally { s.done(); }
});

test("a locked concept is refused and nothing is written", async () => {
  const s = await setup({ "walk.py": "def walk(n):\n    return n\n" });
  try {
    const { ctx, file } = await s.request();
    let reply = "";
    s.fake.play(async function* (_input, act) {
      const read = await act("read_file", { path: file("walk.py") });
      reply = (await act("change", {
        path: file("walk.py"), base_sha: sha(read.text),
        edits: [{ old_text: "return n", new_text: "return walk(n - 1) if n else 0" }],
        skills: [{ name: "recursion", lang: "python" }],
      })).text;
      yield { type: "end", error: null, interrupted: false };
    });
    await run("make walk recursive", ctx);
    assert.match(reply, /^Refused: .*recursion.*nothing written/);
    assert.equal(readFileSync(join(s.root, "walk.py"), "utf8"), "def walk(n):\n    return n\n");
    assert.deepEqual(listChanges(s.home, s.zone.id), []);
    assert.equal(ctx.refused.length, 1, "the refusal is kept for whoever commanded it");
    assert.deepEqual(s.told.changes, []);
    assert.ok(s.store.getSnapshot().transcript.some((e) => e.kind === "tool" && e.name === "change" && e.outcome === "refused"));
    assert.ok(!s.store.getSnapshot().transcript.some((e) => e.kind === "diff"));
  } finally { s.done(); }
});

test("a held skill writes the change directly and returns the diff and receipt; a new file needs a shared folder and null base", async () => {
  const s = await setup({ "main.py": "print('hi')\n" });
  try {
    built("printing", "python");
    const { ctx, file } = await s.request();
    const replies: string[] = [];
    s.fake.play(async function* (_input, act) {
      const read = await act("read_file", { path: file("main.py") });
      replies.push((await act("change", {
        path: file("main.py"), base_sha: sha(read.text), edits: [{ old_text: "hi", new_text: "hello" }], skills: [{ name: "printing" }],
      })).text);
      replies.push((await act("change", {
        path: file("extra.py"), base_sha: null, content: "print('extra')\n", skills: [{ name: "printing", lang: "python" }],
      })).text);
      replies.push((await act("change", {
        path: file("main.py"), base_sha: null, content: "x", edits: [{ old_text: "a", new_text: "b" }], skills: [{ name: "printing" }],
      })).text);
      yield { type: "text", text: "Changed the greeting." };
      yield { type: "end", error: null, interrupted: false };
    });
    await run("say hello instead", ctx);
    assert.match(replies[0]!, /^Written to .*main\.py; its sha256 is now [0-9a-f]{64}/);
    assert.match(replies[1]!, /^Written to .*extra\.py/);
    assert.match(replies[2]!, /^Refused: send exactly one of edits/);
    assert.equal(readFileSync(join(s.root, "main.py"), "utf8"), "print('hello')\n");
    assert.equal(readFileSync(join(s.root, "extra.py"), "utf8"), "print('extra')\n");
    const diffs = s.store.getSnapshot().transcript.filter((e) => e.kind === "diff");
    assert.equal(diffs.length, 2);
    const kept = listChanges(s.home, s.zone.id);
    assert.equal(kept.length, 2);
    assert.deepEqual(s.told.changes.map((c) => c.receipt.id).sort(), kept.map((c) => c.id).sort(), "each landed change reaches the trail");
    assert.deepEqual(s.told.changes[0]!.skills, [{ name: "printing", lang: "" }]);
    for (const d of diffs) {
      assert.ok(d.kind === "diff" && d.outcome === "applied" && kept.some((c) => c.id === d.changeId), "each diff carries the change to revert");
    }
    assert.ok(diffs[0]!.kind === "diff" && /-print\('hi'\)\n\+print\('hello'\)/.test(diffs[0]!.diff));
    assert.ok(s.store.getSnapshot().transcript.some((e) => e.kind === "say" && e.text === "Changed the greeting."));
  } finally { s.done(); }
});

test("a change is refused when the file changed since dum read it, or dum never read it this request", async () => {
  const s = await setup({ "main.py": "print('hi')\n" });
  try {
    built("printing", "python");
    const first = await s.request();
    const replies: string[] = [];
    s.fake.play(async function* (_input, act) {
      const read = await act("read_file", { path: first.file("main.py") });
      writeFileSync(join(s.root, "main.py"), "print('mine')\n");
      replies.push((await act("change", {
        path: first.file("main.py"), base_sha: sha(read.text), edits: [{ old_text: "print(", new_text: "print(1, " }], skills: [{ name: "printing" }],
      })).text);
      replies.push((await act("change", {
        path: first.file("main.py"), base_sha: sha(read.text), content: "print('whole')\n", skills: [{ name: "printing" }],
      })).text);
      yield { type: "end", error: null, interrupted: false };
    });
    await run("tweak it", first.ctx);
    assert.match(replies[0]!, /^Refused: .*changed since you read it/);
    assert.match(replies[1]!, /^Refused: .*changed since Dum read it - nothing written/);
    assert.equal(readFileSync(join(s.root, "main.py"), "utf8"), "print('mine')\n", "their save wins");

    // A SHA from an earlier request isn't a read in this one.
    const stale = (await first.shares.file(first.file("main.py"))).sha;
    const second = await s.request();
    let reply = "";
    s.fake.play(async function* (_input, act) {
      reply = (await act("change", { path: second.file("main.py"), base_sha: stale, content: "print('x')\n", skills: [{ name: "printing" }] })).text;
      yield { type: "end", error: null, interrupted: false };
    });
    await run("again", second.ctx);
    assert.match(reply, /^Refused: base_sha must be the sha256 read_file gave you/);
    assert.deepEqual(listChanges(s.home, s.zone.id), []);
  } finally { s.done(); }
});

test("Stop withdraws dum's question without answering it, and close ends the request", async () => {
  const s = await setup();
  try {
    const stopped = await s.request();
    let answer = "";
    s.fake.play(async function* (_input, act) {
      answer = (await act("ask", { question: "which approach?", why_it_matters: "" })).text;
      yield { type: "end", error: null, interrupted: true };
    });
    const going = run("help me pick", stopped.ctx);
    await until(() => s.store.getSnapshot().prompt?.type === "question");
    s.store.onInterrupt!();
    assert.equal(await going, "stopped");
    assert.match(answer, /Stopped by them - nothing was answered/);
    assert.ok(s.store.getSnapshot().transcript.some((e) => e.kind === "question" && e.answer === null));
    assert.ok(s.store.getSnapshot().transcript.some((e) => e.kind === "note" && /stopped - say what to do instead/.test(e.text)));
    assert.equal(s.store.onInterrupt, null);
    s.store.submit("a late yes");
    assert.ok(!s.store.getSnapshot().transcript.some((e) => e.kind === "question" && e.answer !== null), "a late line answers nothing");

    const closing = await s.request();
    const abort = new AbortController();
    s.fake.play(async function* (_input, act, o) {
      answer = (await act("ask", { question: "and now?", why_it_matters: "" })).text;
      if (o.signal.aborted) return;
      yield { type: "end", error: null, interrupted: false };
    });
    const ending = run("one more", closing.ctx, { signal: abort.signal });
    await until(() => s.store.getSnapshot().prompt?.type === "question");
    abort.abort();
    s.store.close();
    assert.equal(await ending, "closed");
    assert.match(answer, /Stopped by them/);
    assert.equal(s.fake.closes(), 2);
  } finally { s.done(); }
});

test("an explanation counts only when quoted from this request, and only as recognition", async () => {
  const s = await setup();
  try {
    const quote = "print puts text on the screen so you can see what the program did";
    const verdicts: string[] = [];
    const explain: Script = async function* (_input, act) {
      verdicts.push((await act("check_answer", { skill: "printing", lang: "python", quote, holds: true, feedback: "that's what it's for" })).text);
      yield { type: "end", error: null, interrupted: false };
    };
    s.fake.play(async function* () { yield { type: "end", error: null, interrupted: false }; });
    await run(`I think ${quote}.`, (await s.request()).ctx);
    s.fake.play(explain);
    await run("anyway, what next?", (await s.request()).ctx);
    assert.match(verdicts[0]!, /^Not recorded/, "an earlier request's words aren't this request's");
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), null);
    await run(`so: ${quote}`, (await s.request()).ctx);
    assert.doesNotMatch(verdicts[1]!, /Not recorded/);
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), "recognize", "an explanation is never a build");
    assert.deepEqual(s.told.proofs, [{ name: "printing", lang: "python" }], "only the accepted explanation is linked");
    s.store.submit("not yet");
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), null);
  } finally { s.done(); }
});

test("a reviewed submission builds only on their own unaided yes, given by the attest button", async () => {
  const s = await setup({ "hello.py": "print('hello')\n" });
  try {
    const { ctx, file } = await s.request();
    const replies: string[] = [];
    s.fake.play(async function* (_input, act) {
      for (let i = 0; i < 2; i++) {
        replies.push((await act("review_submission", { skill: "printing", lang: "python", paths: [file("hello.py")], passed: true, feedback: "prints the greeting it should" })).text);
      }
      yield { type: "end", error: null, interrupted: false };
    });
    const going = run("I wrote hello.py, review it", ctx);
    await until(() => s.store.getSnapshot().prompt?.type === "question");
    assert.throws(() => s.store.respond({ kind: "share", value: true }), /nothing is waiting/);
    s.store.respond({ kind: "attest", value: false });
    await until(() => replies.length === 1 && s.store.getSnapshot().prompt?.type === "question");
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), null);
    s.store.respond({ kind: "attest", value: true });
    await going;
    assert.match(replies[0]!, /^Not recorded/);
    assert.match(replies[1]!, /^Recorded/);
    assert.equal(skills.levelIn(skills.read(), "printing", "python"), "build");
    assert.deepEqual(s.told.proofs, [{ name: "printing", lang: "python" }]);
  } finally { s.done(); }
});

test("what they share with :inspect reaches dum with its next turn, once, and counts as read", async () => {
  const s = await setup({ "main.py": "a = 1\nb = 2\n" });
  try {
    built("printing", "python");
    const { ctx } = await s.request();
    await s.store.command("inspect", "main.py:2");
    assert.ok(s.store.getSnapshot().transcript.some((e) => e.kind === "excerpt" && e.by === "you" && e.from === 2 && e.text === "b = 2"));
    let replied: Ctx["reads"] | null = null;
    s.fake.play(async function* () {
      replied = new Map(ctx.reads);
      yield { type: "end", error: null, interrupted: false };
    });
    await run("look at line 2", ctx);
    assert.match(s.fake.inputs[0]!.text, /They shared .*main\.py with :inspect/);
    assert.match(s.fake.inputs[0]!.text, /2  b = 2/);
    assert.deepEqual(ctx.shared, [], "shared once, not every turn");
    assert.equal(replied!.size, 1);
  } finally { s.done(); }
});

test("report_context hands the model's topics to the host and grants nothing", async () => {
  const s = await setup();
  try {
    const { ctx } = await s.request();
    const replies: string[] = [];
    s.fake.play(async function* (_input, act) {
      replies.push((await act("report_context", { topics: [{ topic: "hash maps", skill: { name: "hash maps", lang: "python" }, confidence: 0.9, reason: "they asked about buckets" }] })).text);
      replies.push((await act("report_context", { topics: "not a list" })).text);
      yield { type: "end", error: null, interrupted: false };
    });
    await run("how do buckets work?", ctx);
    assert.equal(replies[0], "noted on their trail");
    assert.match(replies[1]!, /^That didn't work/);
    assert.equal(s.told.reports.length, 1);
    assert.deepEqual(skills.read().skills, [], "a report is never evidence");
  } finally { s.done(); }
});

test("decision_help is offered only in a decision turn, and recomposes with what they said", async () => {
  const s = await setup();
  try {
    const { ctx } = await s.request(async (said) => {
      s.told.decided.push([...said]);
      return "two options are on their card";
    });
    let reply = "";
    s.fake.play(async function* (_input, act, o) {
      assert.ok(o.actions.some((a) => a.name === "decision_help"));
      reply = (await act("decision_help", {})).text;
      yield { type: "end", error: null, interrupted: false };
    });
    await run("the CSV has a header row", ctx);
    assert.equal(reply, "two options are on their card");
    assert.deepEqual(s.told.decided, [["the CSV has a header row"]]);
  } finally { s.done(); }
});

test("a failed turn says so to whoever commanded it", async () => {
  const s = await setup();
  try {
    const { ctx } = await s.request();
    s.fake.play(async function* () { yield { type: "end", error: "provider unavailable", interrupted: false }; });
    assert.equal(await run("do it", ctx), "failed");
  } finally { s.done(); }
});

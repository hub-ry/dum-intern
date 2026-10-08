// The utility host end to end: a real child process running the real controller, with fake agent
// backends defined below. Forked with DUM_FAKE_HOST=1, this file serves the host instead of testing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { serve } from "../src/desktop/controller.ts";
import { HostEventSchema, type HostEvent, type HostResult } from "../src/desktop/host-protocol.ts";
import { DEFAULT_PREFERENCES } from "../src/desktop/protocol.ts";
import { LOOK } from "../src/observe-types.ts";
import * as skills from "../src/skills.ts";
import type { AgentBackend, AgentChoice, AgentEvent, BackendId, CredentialSource } from "../src/agent/types.ts";
import type { DecisionView, DirectionView } from "../src/delegation-types.ts";
import type { RequestBinding } from "../src/share-types.ts";
import type { Zone } from "../src/zone-types.ts";

const NOTE = "working on a counter loop in counter.py";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ID = /"id":"([0-9a-f-]{36})"/;

/** The look's scripted replies, one per call: a note with a topic, then a null note with a new topic. */
const LOOKS = [
  { note: NOTE, topics: [{ topic: "a for loop", skill: { name: "for loops", lang: "python" }, confidence: 1, reason: "range(3) is visible" }] },
  { note: null, topics: [{ topic: "a while loop", skill: { name: "while loops", lang: "python" }, confidence: 0.9, reason: "while count < 3 is visible" }] },
];

/** The Wizard's scripted decision cards: the goal is the first context ref, so options cite it. */
function wizardReply(prompt: string): string {
  const goal = ID.exec(prompt.slice(prompt.indexOf("CONTEXT")))?.[1];
  if (prompt.includes("THE MOMENT: goal alignment")) {
    const answered = prompt.includes("ANSWERED QUESTIONS");
    return JSON.stringify({
      reflection: "Here's what I think you want to become able to do: write small Python programs on your own.",
      questions: answered ? [] : [
        { text: "Have you printed output before?", changesPlan: "It decides whether to start from printing or variables." },
        // A goal that needs two answers, so one answer leaves the attempt still clarifying.
        ...(prompt.includes("GOAL: learn Two") ? [{ text: "Do you want a script or a library?", changesPlan: "It decides what the first project produces." }] : []),
      ],
      options: [
        { kind: "project", title: "Build a greeting script", builds: [{ name: "variables", lang: "python" }], advancesGoal: "It exercises the basics the goal names.", contextIds: goal ? [goal] : [], tradeoff: "It is small, so it covers little.", anchor: null },
        { kind: "decision", title: "Pick a first data structure", builds: [{ name: "lists", lang: "python" }], advancesGoal: "It sets what you practice next.", contextIds: [], tradeoff: "It delays writing a whole program.", anchor: null },
      ],
    });
  }
  const race = /OUTCOME: .*RACE/.test(prompt);
  return JSON.stringify({
    reflection: "You want hello.py to greet people properly.",
    questions: [],
    options: [
      { task: `Change the greeting in hello.py to hello${race ? " RACE" : ""}`, expectedResult: "hello.py prints hello", review: "Run hello.py and read what it prints", skills: [{ name: "variables", lang: "python" }], advancesOutcome: "It is the greeting you asked for.", contextIds: goal ? [goal] : [], tradeoff: "It only changes one line.", needs: null, anchor: null },
      { task: "Make the greeting recursive", expectedResult: "hello.py greets three times", review: "Count the greetings", skills: [{ name: "recursion", lang: "python" }], advancesOutcome: "It repeats the greeting.", contextIds: [], tradeoff: "It is more than the outcome needs.", needs: null, anchor: null },
      { task: "Move the greeting into a module", expectedResult: "A module holds the greeting", review: "Import it and call it", skills: [{ name: "variables", lang: "python" }], advancesOutcome: "It keeps the greeting reusable.", contextIds: [], tradeoff: "It adds a file.", needs: "Which folder the module goes in.", anchor: null },
      { task: "Cite something made up", expectedResult: "Nothing", review: "Nothing", skills: [], advancesOutcome: "It cites a ref nobody gave it.", contextIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"], tradeoff: "It is invented.", needs: null, anchor: null },
    ],
  });
}

/** A backend that answers from the turn's text. Only "claude" may ever open a session here. */
function fakeBackend(id: BackendId, credential: CredentialSource): AgentBackend {
  const end: AgentEvent = { type: "end", error: null, interrupted: false };
  let looks = 0;
  return {
    id,
    label: `Fake ${id}`,
    async models(_login, signal) {
      const key = await credential("anthropic-key", signal);
      const id = key?.value ?? "no-key";
      return [{ id, resolved: id, label: "fake", efforts: [], images: true, actions: true, verified: false }];
    },
    capabilities: async (selector) => ({ model: selector.model, images: true, noImages: "", interrupt: true, runtimeActionCheck: false }),
    async open(o) {
      if (id !== "claude") throw new Error(`the ${id} backend was never chosen`);
      return {
        async *turn(input) {
          if (!o.actions.length) {
            // A look asks "what changed"; a decision names its moment; a shared picture asks for a description.
            if (input.text.includes("THE MOMENT:")) yield { type: "text", text: wizardReply(input.text) };
            else if (input.text.includes("what changed:")) yield { type: "text", text: JSON.stringify(LOOKS[Math.min(looks++, LOOKS.length - 1)]) };
            else yield { type: "text", text: "a code editor showing a counter loop" };
            yield end;
            return;
          }
          const act = async (name: string, args: unknown) => (await o.actions.find((a) => a.name === name)!.call(args, o.signal)).text;
          if (input.text.includes("THEIR REQUEST:\nHANDOFF")) {
            const path = (await act("list_files", {})).split("\n").find((p) => p.endsWith("/hello.py"))!;
            const read = await act("read_file", { path });
            const sha = /sha256 ([0-9a-f]{64})/.exec(read)![1];
            // Someone saves the file between Dum's read and its write.
            if (input.text.includes("RACE")) writeFileSync(join(process.env.DUM_TEST_WORK!, "hello.py"), "print('mine')\n");
            yield { type: "text", text: await act("change", { path, base_sha: sha, edits: [{ old_text: "'hi'", new_text: "'hello'" }], skills: [{ name: "variables", lang: "python" }] }) };
            yield end;
            return;
          }
          if (input.text.includes("SLOW")) {
            const { promise, resolve } = Promise.withResolvers<void>();
            if (o.signal.aborted) resolve();
            else o.signal.addEventListener("abort", () => resolve(), { once: true });
            await promise;
            yield { type: "text", text: "late words from a closed zone" };
            yield end;
            return;
          }
          const write = /WRITE ([0-9a-f-]{36}\/hello\.py)/.exec(input.text);
          if (write) {
            yield { type: "text", text: await act("change", { path: write[1], base_sha: null, content: "print('hi')\n", skills: [{ name: "variables", lang: "python" }] }) };
            yield end;
            return;
          }
          yield { type: "text", text: `from ${id}` };
          yield end;
        },
        async interrupt() {},
        close() {},
      };
    },
  };
}

type State = Extract<HostEvent, { type: "state" }>;
type Reply = Extract<HostEvent, { type: "reply" }>;
type Fixture = { dir: string; home: string; bin: string; work: string };

const CHOICE: AgentChoice = {
  backend: "claude", login: "anthropic-key",
  intern: { backend: "claude", model: "fake-intern", effort: null },
  helper: { backend: "claude", model: "fake-helper", effort: null },
  look: { backend: "claude", model: "fake-look", effort: null },
};
const PERSONAL = { path: "", text: "", warning: "" };
const MAIN = {
  version: "0.0.0-test", platform: "linux", backends: [], screenPermission: "not-required", lookPaused: false,
  voice: { supported: false, available: false, bridge: false }, shortcuts: { open: null, voice: null, sendDraft: null },
};

/** One isolated Dum home and a work folder; the child's PATH is an empty folder, so no Git is reachable. */
function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dum-desktop-controller-")));
  const bin = join(dir, "empty-bin");
  mkdirSync(bin);
  const work = join(dir, "work");
  mkdirSync(work);
  return { dir, home: join(dir, "home"), bin, work };
}

/** Every file under a folder and its digest: what "nothing was written" is checked against. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path.slice(root.length)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

class Host {
  readonly epoch = randomUUID();
  readonly events: HostEvent[] = [];
  readonly child: ChildProcess;
  private stderr = "";
  private sequence = 0;
  private readonly listeners = new Set<() => void>();

  constructor(f: Fixture) {
    this.child = fork(fileURLToPath(import.meta.url), [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env, PATH: f.bin, DUM_FAKE_HOST: "1", DUM_HOST_EPOCH: this.epoch, DUM_HOME: f.home, DUM_CONTEXT: "off",
        DUM_TEST_CREDENTIAL_MS: "400", DUM_TEST_WORK: f.work,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.stderr!.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("message", (message) => {
      const parsed = HostEventSchema.safeParse(message);
      assert.ok(parsed.success, `the host sent an invalid event: ${JSON.stringify(message).slice(0, 300)}`);
      this.events.push(parsed.data);
      for (const l of this.listeners) l();
    });
  }

  /** The first event (kept or still to come) that matches, removed from the log. */
  take<T extends HostEvent>(predicate: (e: HostEvent) => e is T, ms = 15_000): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const look = () => {
      const i = this.events.findIndex(predicate);
      if (i < 0) return;
      this.listeners.delete(look);
      clearTimeout(timer);
      resolve(this.events.splice(i, 1)[0] as T);
    };
    const timer = setTimeout(() => {
      this.listeners.delete(look);
      reject(new Error(`timed out waiting for the host\n${this.stderr}`));
    }, ms);
    this.listeners.add(look);
    look();
    return promise;
  }

  /** The newest state that satisfies `predicate`, waiting for one if none came yet. States stay in the log. */
  until(predicate: (s: State) => boolean, ms = 15_000): Promise<State> {
    const match = () => this.events.findLast((e): e is State => e.type === "state" && predicate(e));
    const seen = match();
    if (seen) return Promise.resolve(seen);
    const { promise, resolve, reject } = Promise.withResolvers<State>();
    const look = () => {
      const found = match();
      if (!found) return;
      this.listeners.delete(look);
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => {
      this.listeners.delete(look);
      reject(new Error(`timed out waiting for the host\n${this.stderr}`));
    }, ms);
    this.listeners.add(look);
    return promise;
  }

  /** The newest state, whatever it says. */
  latest(): State {
    return this.events.findLast((e): e is State => e.type === "state")!;
  }

  send(fields: object, id = `r${++this.sequence}`): string {
    this.child.send({ epoch: this.epoch, id, ...fields });
    return id;
  }

  reply(id: string): Promise<Reply> {
    return this.take((e): e is Reply => e.type === "reply" && e.id === id, 30_000);
  }

  call(fields: object): Promise<Reply> {
    return this.reply(this.send(fields));
  }

  async ok(fields: object): Promise<HostResult> {
    const reply = await this.call(fields);
    assert.equal(reply.ok, true, `${JSON.stringify(fields).slice(0, 200)} failed: ${reply.error}`);
    return reply.result ?? {};
  }

  async refused(fields: object, why: RegExp): Promise<void> {
    const reply = await this.call(fields);
    assert.equal(reply.ok, false, `${JSON.stringify(fields).slice(0, 200)} should have been refused`);
    assert.match(reply.error!, why);
  }

  async start(f: Fixture, agent: AgentChoice | null = CHOICE): Promise<void> {
    await this.take((e): e is Extract<HostEvent, { type: "ready" }> => e.type === "ready");
    await this.ok({ op: "initialize", home: f.home, claudeExecutable: null, personal: PERSONAL, settings: { ...DEFAULT_PREFERENCES, agent }, main: MAIN });
  }

  async zone(name: string, parentId: string | null, enter = true): Promise<Zone> {
    return (await this.create(name, parentId, enter)).zone!;
  }

  create(name: string, parentId: string | null, enter = true): Promise<HostResult> {
    return this.ok({ op: "zone-create", zone: { name, goal: `learn ${name}`, parentId, language: "python", focusSkills: [] }, enter });
  }

  /** The zone is open and waiting at "what next", with a session. */
  ready(zoneId: string): Promise<State> {
    return this.until((s) => s.activeZone?.id === zoneId && s.state?.prompt?.type === "next" && s.zoneEpoch !== null && s.session !== null);
  }
}

function binding(s: State, requestId: string = randomUUID()): RequestBinding {
  return { zoneId: s.activeZone!.id, zoneEpoch: s.zoneEpoch!, inputToken: s.inputToken, requestId };
}

function built(f: Fixture, names: string[]): void {
  let tree: skills.Tree = { skills: [] };
  for (const name of names) tree = skills.unlock(tree, { name, lang: "python", how: "typed", level: "build", why: "fixture" });
  skills.write(tree, f.home);
}

async function withHosts(run: (f: Fixture, launch: () => Host) => Promise<void>): Promise<void> {
  const f = fixture();
  const hosts: Host[] = [];
  try {
    await run(f, () => {
      const host = new Host(f);
      hosts.push(host);
      return host;
    });
  } finally {
    for (const { child } of hosts) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill();
      await once(child, "exit");
    }
    rmSync(f.dir, { recursive: true, force: true });
  }
}

/** A zone with variables and printing built, a followed folder holding hello.py, and an open decision card. */
async function deciding(f: Fixture, host: Host, outcome = "make hello.py say hello"): Promise<{ s: State; card: DecisionView }> {
  writeFileSync(join(f.work, "hello.py"), "print('hi')\n");
  await host.start(f);
  const z = await host.zone("Python", null);
  await host.ready(z.id);
  await host.ok({ op: "follow-add", path: f.work });
  const s = await host.until((e) => e.follows.length === 1 && e.state?.prompt?.type === "next");
  const card = (await host.ok({ op: "decision-help", binding: binding(s), outcome })).decision!;
  return { s: await host.until((e) => e.decision?.id === card.id), card };
}

if (process.env.DUM_FAKE_HOST === "1") {
  serve({
    epoch: process.env.DUM_HOST_EPOCH!,
    credentialMs: Number(process.env.DUM_TEST_CREDENTIAL_MS),
    frameMs: 500,
    backends: ({ credential }) => [fakeBackend("claude", credential), fakeBackend("local", credential)],
  });
} else {
  test("the tree and settings work before any backend, and nested zones open with no Git on PATH", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f, null);
    await host.ok({ op: "view", view: "tree" });
    const tree = await host.until((s) => s.tree !== null);
    assert.equal(tree.activeZone, null);
    assert.equal(tree.zoneEpoch, null);
    await host.ok({ op: "settings", settings: { ...DEFAULT_PREFERENCES, mode: "anti-vibe" } });

    const root = await host.zone("Programming", null);
    const child = await host.zone("Data Structures", root.id);
    const opened = await host.ready(child.id);
    assert.deepEqual(opened.activeZone!.breadcrumb.map((b) => b.name), ["Programming", "Data Structures"]);
    assert.deepEqual(opened.activeZone!.ancestorGoals.map((a) => a.goal), ["learn Programming"]);
    assert.equal(opened.state!.mode, "anti-vibe");
    assert.equal(opened.registry.activeZoneId, child.id);

    const refused = await host.call({ op: "send", binding: binding(opened), text: "hello", shares: [] });
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /Choose who powers Dum/);
    await host.refused({ op: "decision-help", binding: binding(opened), outcome: "what next" }, /decision help is unavailable/);

    // Typed commands that call no model work unpowered too; the ones that do are refused.
    const help = await host.call({ op: "send", binding: binding(opened), text: ":help", shares: [] });
    assert.equal(help.ok, true, help.error);
    const shown = await host.until((s) => s.state?.stage.kind === "info" && /:projects/.test(s.state.stage.body) && s.canAttach);
    const projects = await host.call({ op: "send", binding: binding(shown), text: ":projects recursion", shares: [] });
    assert.equal(projects.ok, false);
    assert.match(projects.error!, /Choose who powers Dum/);
  }));

  test("only the selected backend runs, a shared picture is looked at once by the helper, and stale bindings are refused", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f, null);
    await host.zone("Python", null);
    await host.ok({ op: "agent-select", choice: CHOICE });
    let s = await host.until((e) => e.state?.models.intern?.model === "fake-intern" && e.state.prompt?.type === "next");
    await host.ok({ op: "send", binding: binding(s), text: "hello", shares: [] });
    s = await host.until((e) => !!e.state?.transcript.some((x) => x.kind === "say" && x.text === "from claude") && e.state.prompt?.type === "next");
    assert.equal(s.state!.transcript.some((x) => x.kind === "note" && /never chosen/.test(x.text)), false);

    const stale = await host.call({ op: "send", binding: { ...binding(s), zoneEpoch: randomUUID() }, text: "again", shares: [] });
    assert.equal(stale.ok, false);
    const oldToken = await host.call({ op: "send", binding: { ...binding(s), inputToken: "not-the-prompt" }, text: "again", shares: [] });
    assert.equal(oldToken.ok, false);
    assert.match(oldToken.error!, /prompt closed/);

    await host.ok({ op: "send", binding: binding(s), text: "what is this?", shares: [], image: { data: PNG, mimeType: "image/png", label: "Editor" } });
    s = await host.until((e) => !!e.state?.transcript.some((x) => x.kind === "shot") && e.state.prompt?.type === "next");
    const shot = s.state!.transcript.find((x) => x.kind === "shot");
    assert.equal(shot?.kind === "shot" && shot.observation, "a code editor showing a counter loop");
    assert.equal(JSON.stringify(s.state!.transcript).includes(PNG), false);
  }));

  test("switching zones drops the old zone's late events and answers; a crashed host's epoch is dead", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f);
    const a = await host.zone("Alpha", null);
    const b = await host.zone("Beta", null, false);
    let s = await host.ready(a.id);
    const old = binding(s);
    const alphaSession = s.session!.id;
    await host.ok({ op: "send", binding: old, text: "SLOW please", shares: [] });
    s = await host.until((e) => e.activeZone?.id === a.id && !!e.state?.busy);
    await host.ok({ op: "zone-enter", zoneId: b.id, expectedRevision: s.registry.revision });
    // Everything the host posted after it replied to the switch.
    const mark = host.events.length;
    const switched = await host.ready(b.id);
    assert.notEqual(switched.zoneEpoch, old.zoneEpoch);
    // A round trip after the switch: everything the old run did late has been processed by now.
    await host.ok({ op: "view", view: "tree" });
    const after = host.events.slice(mark);
    assert.equal(after.some((e) => e.type === "state" && e.state?.zoneId === a.id), false);
    assert.equal(host.events.some((e) => e.type === "state" && JSON.stringify(e.state).includes("late words")), false);
    const late = await host.call({ op: "send", binding: old, text: "an answer for Alpha", shares: [] });
    assert.equal(late.ok, false);
    // Leaving ended Alpha's session.
    const alpha = (await host.ok({ op: "trail-read", zoneId: a.id, sessionId: alphaSession, cursor: null })).trail!;
    assert.equal(alpha.session.endReason, "leave");

    host.child.kill("SIGKILL");
    await once(host.child, "exit");
    const next = launch();
    await next.start(f);
    next.send({ op: "view", view: "tree" }, "own-epoch");
    next.child.send({ epoch: host.epoch, id: "dead-epoch", op: "view", view: "tree" });
    await next.reply("own-epoch");
    const reopened = await next.ready(b.id);
    assert.notEqual(reopened.zoneEpoch, switched.zoneEpoch);
    assert.notEqual(reopened.session!.id, switched.session!.id);
    assert.equal(next.events.some((e) => e.type === "reply" && e.id === "dead-epoch"), false);
    const transcript = readFileSync(join(f.home, "zones", a.id, "transcript.json"), "utf8");
    assert.equal(transcript.includes("late words"), false);
    // The crashed session was closed on restart as interrupted, never resumed.
    const crashed = (await next.ok({ op: "trail-read", zoneId: b.id, sessionId: switched.session!.id, cursor: null })).trail!;
    assert.equal(crashed.session.endReason, "interrupted");
  }));

  test("credential requests round-trip to main by request ID and time out when main doesn't answer", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f);
    const asked = host.send({ op: "agent-models", backend: "claude", login: "anthropic-key" });
    const ask = await host.take((e): e is Extract<HostEvent, { type: "credential-request" }> => e.type === "credential-request");
    assert.equal(ask.need, "anthropic-key");
    await host.ok({ op: "credential", requestId: ask.requestId, value: { value: "sk-test-model", expiresAt: null } });
    const reply = await host.reply(asked);
    assert.equal(reply.ok, true);
    assert.equal(reply.result?.models?.[0]?.id, "sk-test-model");

    const silent = host.send({ op: "agent-models", backend: "claude", login: "anthropic-key" });
    const unanswered = await host.take((e): e is Extract<HostEvent, { type: "credential-request" }> => e.type === "credential-request");
    assert.notEqual(unanswered.requestId, ask.requestId);
    const timedOut = await host.reply(silent);
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error!, /didn't answer the credential request/);
    const tooLate = await host.call({ op: "credential", requestId: unanswered.requestId, value: { value: "sk-late", expiresAt: null } });
    assert.equal(tooLate.ok, false);
  }));

  test("an ambient tick on followed code reaches the look model, lands as a memory note and a trail visit, and never advises", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    writeFileSync(join(f.work, "counter.py"), "count = 0\n");
    const host = launch();
    await host.start(f);
    const z = await host.zone("Loops", null);
    await host.ready(z.id);
    const follow = (await host.ok({ op: "follow-add", path: f.work })).follow!;
    assert.equal(follow.files, 1);
    writeFileSync(join(f.work, "counter.py"), "count = 0\nfor i in range(3):\n    count += i\n");
    const s = await host.until((e) => e.follows.length === 1);
    for (let i = 0; i < 4; i++) {
      await host.ok({ op: "observe-tick", tick: { zoneId: z.id, epoch: s.zoneEpoch, at: Date.now(), app: null, screen: null } });
    }
    // The note is written by the host after its helper call; no event names that write, so poll the file.
    const memory = join(f.home, "zones", z.id, "memory.md");
    for (let i = 0; i < 200 && !(existsSync(memory) && readFileSync(memory, "utf8").includes(NOTE)); i++) await sleep(25);
    assert.ok(readFileSync(memory, "utf8").includes(NOTE));
    const seen = await host.until((e) => e.look.seen?.text === NOTE && !!e.trail?.visits.length);
    assert.deepEqual(seen.trail!.visits.map((v) => [v.skill.name, v.origin]), [["for loops", "look"]]);
    assert.equal(seen.session!.latestObservation?.text, NOTE);
    // The look never speaks in the conversation, never makes a card and never touches the tree.
    assert.equal(seen.state!.transcript.some((e) => e.kind === "quip" || e.kind === "say"), false);
    assert.equal(seen.decision, null);
    assert.deepEqual(skills.read(f.home).skills, []);

    // A tick from another epoch is blocked: the look says why and asks nothing.
    await host.ok({ op: "observe-tick", tick: { zoneId: z.id, epoch: randomUUID(), at: Date.now(), app: null, screen: null } });
    await host.until((e) => e.look.status === "blocked" && e.look.reason === "stale-epoch");
  }));

  test("the live look: a changed screen asks main for one frame; a throttled null note with a new topic still reaches the trail", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f);
    const z = await host.zone("Loops", null);
    const s = await host.ready(z.id);
    const tick = (changedCells: number) => ({ op: "observe-tick", tick: { zoneId: z.id, epoch: s.zoneEpoch, at: Date.now(), app: null, screen: { changedCells } } });
    await host.ok(tick(0));
    assert.equal(host.events.some((e) => e.type === "frame-request"), false, "a still screen asks for nothing");
    const look = async () => {
      // The tick waits on main's frame, so it is answered before the tick returns.
      const changed = host.send(tick(LOOK.activeCells));
      const ask = await host.take((e): e is Extract<HostEvent, { type: "frame-request" }> => e.type === "frame-request");
      await host.ok({ op: "observe-frame", checkId: ask.checkId, image: { mimeType: "image/png", data: `${PNG.slice(0, -4)}${randomUUID().slice(0, 2)}==` } });
      assert.equal((await host.reply(changed)).ok, true);
    };
    await look();
    const seen = await host.until((e) => e.look.seen?.text === NOTE && e.look.status === "watching");
    assert.ok(seen.look.lastSuccess && seen.look.lastAttempt);
    // The host is a separate process on the real clock: its one-call-per-tick limit can't be faked from here.
    await sleep(LOOK.minMs.any);
    await look();
    const both = await host.until((e) => (e.trail?.visits.length ?? 0) >= 2);
    assert.deepEqual(both.trail!.visits.map((v) => [v.skill.name, v.mapping]), [["for loops", "exact"], ["while loops", "inferred"]]);
    const memory = readFileSync(join(f.home, "zones", z.id, "memory.md"), "utf8");
    assert.equal(memory.split(NOTE).length - 1, 1, "only the first look left a memory note");

    // Ignore this observation: it leaves Current context and the next decision's inputs.
    const latest = both.look.seen!;
    assert.equal(latest.text, "a while loop", "with no note, what the look saw is its topics");
    await host.refused({ op: "context-ignore-observation", binding: binding(both), sourceId: randomUUID(), expectedCorrectionRevision: 0 }, /isn't the latest observation/);
    await host.ok({ op: "context-ignore-observation", binding: binding(both), sourceId: latest.sourceId, expectedCorrectionRevision: both.contextUse.correctionRevision });
    const ignored = await host.until((e) => e.contextUse.correctionRevision === 1 && e.state?.prompt?.type === "next");
    assert.equal(ignored.look.seen, null);
    const card = (await host.ok({ op: "decision-help", binding: binding(ignored), outcome: "make hello.py say hello" })).decision!;
    assert.equal(card.context.some((r) => r.kind === "look"), false, "an ignored observation never feeds a decision");
  }));

  test("with no backend the look still notices followed-file changes, says it has no backend, and calls nothing", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    writeFileSync(join(f.work, "counter.py"), "count = 0\n");
    const host = launch();
    await host.start(f, null);
    const z = await host.zone("Loops", null);
    await host.ready(z.id);
    await host.ok({ op: "follow-add", path: f.work });
    writeFileSync(join(f.work, "counter.py"), "count = 0\nfor i in range(3):\n    count += i\n");
    const s = await host.until((e) => e.follows.length === 1);
    for (let i = 0; i < 4; i++) {
      await host.ok({ op: "observe-tick", tick: { zoneId: z.id, epoch: s.zoneEpoch, at: Date.now(), app: null, screen: null } });
    }
    const seen = await host.until((e) => e.look.status === "no-backend" && e.look.lastTick !== null);
    assert.equal(seen.look.seen, null);
    assert.equal(host.events.some((e) => e.type === "frame-request"), false, "no frame was asked for");
    const memory = join(f.home, "zones", z.id, "memory.md");
    assert.ok(!existsSync(memory) || !readFileSync(memory, "utf8").includes(NOTE), "no helper call wrote a note");
  }));

  test("a permitted change is written directly with its diff, and revert puts the file back", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    built(f, ["printing", "variables"]);
    const host = launch();
    await host.start(f);
    const z = await host.zone("Python", null);
    let s = await host.ready(z.id);
    const request = binding(s);
    const share = (await host.ok({ op: "share-add", path: f.work, kind: "folder", binding: request })).share!;
    s = await host.until((e) => e.shares.length === 1);
    assert.equal(s.shares[0]!.id, share.id);
    await host.ok({ op: "send", binding: request, text: `WRITE ${share.id}/hello.py`, shares: [share] });
    s = await host.until((e) => e.changes.length === 1 && e.state?.prompt?.type === "next");
    assert.equal(readFileSync(join(f.work, "hello.py"), "utf8"), "print('hi')\n");
    const made = s.changes[0]!;
    assert.equal(made.revertible, true);
    assert.equal(s.shares.length, 0);
    assert.ok(s.state!.transcript.some((e) => e.kind === "diff" && e.outcome === "applied" && e.changeId === made.id));
    // The change is linked on the trail as an exact, artifact-backed visit.
    s = await host.until((e) => !!e.trail?.visits.some((v) => v.skill.name === "variables" && v.origin === "artifact"));

    const reverted = (await host.ok({ op: "change-revert", changeId: made.id, binding: binding(s) })).change!;
    assert.equal(reverted.revertible, false);
    assert.equal(existsSync(join(f.work, "hello.py")), false);
    s = await host.until((e) => e.changes[0]?.revertible === false);
    assert.ok(s.state!.transcript.some((e) => e.kind === "diff" && e.outcome === "reverted"));
    const again = await host.call({ op: "change-revert", changeId: made.id, binding: binding(s) });
    assert.equal(again.ok, false);
  }));

  test("goal-start alignment: target zone only, consequential questions, options from supplied context; choosing writes nothing", { timeout: 90_000 }, () => withHosts(async (f, launch) => {
    built(f, ["printing"]);
    const host = launch();
    await host.start(f);
    const created = await host.create("Python", null);
    const zone = created.zone!;
    const opened = await host.ready(zone.id);
    let direction: DirectionView = created.direction!;
    assert.equal(direction.attempt!.phase, "reflect");
    assert.equal(opened.direction!.zoneId, zone.id);
    const before = { home: snapshot(join(f.home, "skills")), work: snapshot(f.work), tree: JSON.stringify(skills.read(f.home)) };

    direction = (await host.ok({ op: "alignment-step", binding: direction.binding, action: "start" })).direction!;
    assert.equal(direction.status, "aligning");
    assert.equal(direction.attempt!.phase, "clarify");
    assert.match(direction.attempt!.reflection, /^Here's what I think you want to become able to do/);
    assert.equal(direction.attempt!.questions.length, 1);
    const goalRef = direction.attempt!.context.find((r) => r.kind === "goal")!;
    assert.equal(goalRef.excerpt, "learn Python");
    assert.deepEqual(direction.attempt!.options[0]!.contextIds, [goalRef.id], "options cite only supplied context");
    // A step bound to an older revision is refused.
    await host.refused({ op: "alignment-step", binding: created.direction!.binding, action: "start" }, /moved on/);

    const question = direction.attempt!.questions[0]!;
    direction = (await host.ok({ op: "alignment-step", binding: direction.binding, action: "answer", questionId: question.id, text: "yes, print is fine" })).direction!;
    assert.equal(direction.attempt!.phase, "choose");
    assert.equal(direction.attempt!.questions[0]!.answer, "yes, print is fine");
    const choice = direction.attempt!.options[0]!;
    direction = (await host.ok({
      op: "alignment-accept", binding: direction.binding, choiceId: choice.id, ability: "write small Python programs alone",
      reviewCriterion: "a script I wrote runs", assumptions: ["print works"],
    })).direction!;
    assert.equal(direction.status, "aligned");
    assert.equal(direction.current!.choice.id, choice.id);
    assert.equal(direction.current!.goal, "learn Python");
    // Use this direction writes no source file, no skill and no evidence.
    assert.deepEqual(snapshot(f.work), before.work);
    assert.equal(JSON.stringify(skills.read(f.home)), before.tree);
    assert.equal(existsSync(join(f.home, "evidence.json")), false);
    // The active zone's session closed with a direction marker and a new one runs under it.
    const aligned = await host.until((e) => e.session?.directionId === direction.current!.id);
    const firstSession = opened.session!.id;
    const markers = (await host.ok({ op: "trail-read", zoneId: zone.id, sessionId: firstSession, cursor: null })).trail!;
    assert.ok(markers.events.some((e) => e.kind === "direction" && e.directionId === direction.current!.id));
    assert.equal(markers.session.endReason, "reconfigure");

    // A rename doesn't realign; a changed goal makes the old direction non-current and starts again.
    const renamed = (await host.ok({ op: "zone-update", zoneId: zone.id, patch: { name: "Py" }, expectedRevision: aligned.registry.revision })).direction!;
    assert.equal(renamed.status, "aligned");
    const s = await host.until((e) => e.activeZone?.breadcrumb.at(-1)?.name === "Py");
    const regoaled = (await host.ok({ op: "zone-update", zoneId: zone.id, patch: { goal: "learn Python classes" }, expectedRevision: s.registry.revision })).direction!;
    assert.equal(regoaled.current, null);
    assert.equal(regoaled.status, "aligning");
    assert.notEqual(regoaled.binding.goalHash, direction.binding.goalHash);
    await host.refused({ op: "alignment-accept", binding: direction.binding, choiceId: choice.id, ability: "x", reviewCriterion: "y", assumptions: [] }, /goal changed/);

    // An inactive zone's alignment names that zone and never borrows or replaces the active one.
    const other = await host.create("Rust", null, false);
    const otherStart = (await host.ok({ op: "alignment-step", binding: other.direction!.binding, action: "start" })).direction!;
    assert.equal(otherStart.zoneId, other.zone!.id);
    await host.ok({ op: "view", view: "tree" });
    const still = host.latest();
    assert.equal(still.activeZone!.id, zone.id);
    assert.equal(still.direction!.zoneId, zone.id);
    // Deferring leaves alignment needed, without an agreement.
    const deferred = (await host.ok({ op: "alignment-step", binding: otherStart.binding, action: "defer" })).direction!;
    assert.equal(deferred.status, "deferred");
    assert.equal(deferred.current, null);
  }));

  test("decision cards: host-computed eligibility, Learn first, Needs, unsupported refs dropped; selection and edit write nothing", { timeout: 90_000 }, () => withHosts(async (f, launch) => {
    built(f, ["printing", "variables"]);
    const host = launch();
    const { s, card } = await deciding(f, host);
    assert.equal(card.options.length, 3, "the option citing context it wasn't given is dropped");
    const [now, learn, needs] = card.options as [typeof card.options[0], typeof card.options[0], typeof card.options[0]];
    assert.equal(now.eligibility, "can-delegate");
    assert.equal(learn.eligibility, "learn-first");
    assert.match(learn.blockers.join(" "), /Learn first: .*:projects/);
    assert.equal(needs.eligibility, "needs-detail");
    assert.match(needs.blockers[0]!, /Which folder/);
    assert.ok(s.contextUse.counts.used > 0, "Using names what the decision used");
    const using = (await host.ok({ op: "context-use-read", binding: binding(s), cursor: s.contextUse.cursor })).contextUse!;
    assert.ok(using.items.some((i) => i.ref.kind === "goal"));

    const before = { work: snapshot(f.work), tree: JSON.stringify(skills.read(f.home)) };
    await host.refused({ op: "handoff-select", binding: binding(s), decisionId: card.id, revision: card.revision, optionId: learn.id }, /can't be handed off now: Learn first/);
    await host.refused({ op: "handoff-select", binding: binding(s), decisionId: card.id, revision: card.revision, optionId: needs.id }, /answer what's missing first/);
    let handoff = (await host.ok({ op: "handoff-select", binding: binding(s), decisionId: card.id, revision: card.revision, optionId: now.id })).handoff!;
    assert.equal(handoff.head.state, "ready");
    assert.equal(handoff.handoff.task, now.task);
    assert.equal(handoff.needsRefresh, false);
    handoff = (await host.ok({ op: "handoff-edit", binding: binding(s), handoffId: handoff.handoff.id, revision: 1, patch: { review: "Run it and check it says hello" } })).handoff!;
    assert.equal(handoff.head.revision, 2);
    assert.deepEqual(snapshot(f.work), before.work, "selection and edit write no file");
    assert.equal(JSON.stringify(skills.read(f.home)), before.tree);

    // Dismiss removes the card and nothing brings it back unasked.
    await host.ok({ op: "decision-dismiss", binding: binding(s), decisionId: card.id, revision: card.revision });
    await host.until((e) => e.decision === null);
    await host.refused({ op: "decision-dismiss", binding: binding(s), decisionId: card.id, revision: card.revision }, /already gone/);
  }));

  test("Do this runs once through the direct change path, records receipts and markers, and review grants nothing", { timeout: 90_000 }, () => withHosts(async (f, launch) => {
    built(f, ["printing", "variables"]);
    const host = launch();
    const { s: opened, card } = await deciding(f, host);
    let s = opened;
    const ready = (await host.ok({ op: "handoff-select", binding: binding(s), decisionId: card.id, revision: card.revision, optionId: card.options[0]!.id })).handoff!;
    s = await host.until((e) => e.handoff?.head.state === "ready" && e.state?.prompt?.type === "next");
    await host.refused({ op: "handoff-run", binding: binding(s), handoffId: ready.handoff.id, revision: 7, shares: [] }, /Refresh handoff/);
    const command = binding(s);
    await host.ok({ op: "handoff-run", binding: command, handoffId: ready.handoff.id, revision: 1, shares: [] });
    s = await host.until((e) => e.handoff?.head.state === "done" && e.state?.prompt?.type === "next");
    assert.equal(readFileSync(join(f.work, "hello.py"), "utf8"), "print('hello')\n");
    const done = s.handoff!;
    assert.equal(done.head.changeIds.length, 1);
    assert.deepEqual(done.head.changeIds, s.changes.map((c) => c.id));
    assert.match(done.head.result, /1 change applied: hello\.py/);
    assert.match(done.head.result, /yours to review/);
    // A repeated command for the consumed version writes nothing more.
    await host.refused({ op: "handoff-run", binding: binding(s), handoffId: ready.handoff.id, revision: 1, shares: [] }, /Do this runs a ready handoff once/);
    assert.equal(s.changes.length, 1);

    const reviewed = (await host.ok({ op: "handoff-review", binding: binding(s), handoffId: ready.handoff.id, revision: 1, verdict: "It did not advance the goal" })).handoff!;
    assert.equal(reviewed.head.reviewed!.verdict, "It did not advance the goal");
    assert.equal(existsSync(join(f.home, "evidence.json")), false, "a review is never competency evidence");
    const trail = (await host.ok({ op: "trail-read", zoneId: s.activeZone!.id, sessionId: s.session!.id, cursor: null })).trail!;
    const phases = trail.events.flatMap((e) => (e.kind === "handoff" ? [e.phase] : []));
    assert.deepEqual(phases, ["commanded", "done", "reviewed"]);
    assert.ok(trail.events.some((e) => e.kind === "visit" && e.step.origin === "artifact" && e.step.skill.name === "variables"));
  }));

  test("changed skills, context or bytes after selection still block, and nothing is written", { timeout: 90_000 }, () => withHosts(async (f, launch) => {
    built(f, ["printing", "variables"]);
    const host = launch();
    const { card } = await deciding(f, host, "make hello.py say hello RACE");
    let s = host.latest();
    assert.equal(s.decision?.id, card.id);
    const raced = (await host.ok({ op: "handoff-select", binding: binding(s), decisionId: card.id, revision: card.revision, optionId: card.options[0]!.id })).handoff!;
    s = await host.until((e) => e.handoff?.head.state === "ready" && e.state?.prompt?.type === "next");
    // The file changes between Dum's read and its write: the hash check refuses, and the handoff is blocked.
    await host.ok({ op: "handoff-run", binding: binding(s), handoffId: raced.handoff.id, revision: 1, shares: [] });
    s = await host.until((e) => e.handoff?.head.state === "blocked" && e.state?.prompt?.type === "next");
    assert.equal(readFileSync(join(f.work, "hello.py"), "utf8"), "print('mine')\n", "their save wins");
    assert.match(s.handoff!.head.result, /No file changed\. Refused: .*changed since you read it/);
    assert.equal(s.changes.length, 0);

    // A skill taken back after selection: the live gate refuses Do this before anything runs.
    writeFileSync(join(f.work, "hello.py"), "print('hi')\n");
    const card2 = (await host.ok({ op: "decision-help", binding: binding(s), outcome: "make hello.py say hello" })).decision!;
    s = await host.until((e) => e.decision?.id === card2.id);
    const fresh = (await host.ok({ op: "handoff-select", binding: binding(s), decisionId: card2.id, revision: card2.revision, optionId: card2.options[0]!.id })).handoff!;
    await host.ok({ op: "skill-edit", edit: "remove", skill: { name: "variables", lang: "python" } });
    s = await host.until((e) => e.handoff?.handoff.id === fresh.handoff.id && e.handoff.blockers.length > 0 && e.state?.prompt?.type === "next");
    await host.refused({ op: "handoff-run", binding: binding(s), handoffId: fresh.handoff.id, revision: 1, shares: [] }, /Learn first.*nothing ran/);
    assert.equal(readFileSync(join(f.work, "hello.py"), "utf8"), "print('hi')\n");
    assert.equal(s.handoff!.head.state, "ready", "a refused command consumes nothing");

    // Changed zone notes: the old card is stale and can't be selected; the ready handoff needs a refresh.
    built(f, ["printing", "variables"]);
    const card3 = (await host.ok({ op: "decision-help", binding: binding(s), outcome: "make hello.py say hello" })).decision!;
    s = await host.until((e) => e.decision?.id === card3.id);
    await host.ok({ op: "zone-context", zoneId: s.activeZone!.id, text: "they like tiny examples", expectedRevision: s.registry.revision });
    s = await host.until((e) => e.activeZone?.notes.some((n) => n.text.includes("tiny")) === true && e.state?.prompt?.type === "next");
    await host.refused({ op: "handoff-select", binding: binding(s), decisionId: card3.id, revision: card3.revision, optionId: card3.options[0]!.id }, /Context changed/);
    s = await host.until((e) => e.handoff?.needsRefresh === true && e.state?.prompt?.type === "next");
    await host.refused({ op: "handoff-run", binding: binding(s), handoffId: fresh.handoff.id, revision: 1, shares: [] }, /Refresh handoff/);
    // Editing a stale handoff refreshes it into the current session and context.
    const refreshed = (await host.ok({ op: "handoff-edit", binding: binding(s), handoffId: fresh.handoff.id, revision: 1, patch: { task: "Change the greeting in hello.py to hello" } })).handoff!;
    assert.notEqual(refreshed.handoff.id, fresh.handoff.id);
    assert.equal(refreshed.needsRefresh, false);
    assert.equal(readFileSync(join(f.work, "hello.py"), "utf8"), "print('hi')\n");
  }));

  test("every alignment step publishes the active zone's alignment: a partial answer, Not now and no backend", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f);
    const created = await host.create("Two", null);
    const zone = created.zone!;
    await host.ready(zone.id);
    let direction = (await host.ok({ op: "alignment-step", binding: created.direction!.binding, action: "start" })).direction!;
    assert.equal(direction.attempt!.questions.length, 2);
    // One of two answers: the attempt keeps clarifying, and the window sees the answer without another event.
    const first = direction.attempt!.questions[0]!;
    direction = (await host.ok({ op: "alignment-step", binding: direction.binding, action: "answer", questionId: first.id, text: "yes" })).direction!;
    assert.equal(direction.attempt!.phase, "clarify");
    let s = await host.until((e) => e.direction?.attempt?.questions[0]?.answer === "yes");
    assert.equal(s.direction!.binding.directionRevision, direction.binding.directionRevision);
    // Not now: deferred is published.
    direction = (await host.ok({ op: "alignment-step", binding: direction.binding, action: "defer" })).direction!;
    s = await host.until((e) => e.direction?.status === "deferred");
    assert.equal(s.direction!.current, null);
    // No backend: starting again keeps a pending attempt that waits for a model, and the state says so.
    await host.ok({ op: "agent-select", choice: null });
    direction = (await host.ok({ op: "alignment-step", binding: direction.binding, action: "start" })).direction!;
    assert.equal(direction.status, "needs-backend");
    s = await host.until((e) => e.direction?.status === "needs-backend");
    assert.equal(s.direction!.attempt!.phase, "needs-backend");
  }));

  test("New session keeps the agreed direction, starts an empty trail and rotates the epoch; debug and diagnostics bypass the queue", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const host = launch();
    await host.start(f);
    const z = await host.zone("Python", null);
    const s = await host.ready(z.id);
    await host.ok({ op: "session-new", binding: binding(s) });
    const next = await host.until((e) => e.session !== null && e.session.id !== s.session!.id);
    assert.notEqual(next.zoneEpoch, s.zoneEpoch);
    assert.equal(next.trail!.visits.length, 0);
    const old = (await host.ok({ op: "trail-read", zoneId: z.id, sessionId: s.session!.id, cursor: null })).trail!;
    assert.equal(old.session.endReason, "new-session");
    await host.refused({ op: "session-new", binding: binding(s) }, /isn't open any more/);
    const story = (await host.ok({ op: "story-read", zoneId: z.id, skill: null, from: null, to: null, cursor: null })).story!;
    assert.ok(story.rows.some((r) => r.sessionId === s.session!.id));

    const debug = (await host.ok({ op: "debug-open" })).debug!;
    assert.equal(debug.state, "idle");
    await host.ok({ op: "diagnostic-main", events: [], status: null });
    assert.equal((await host.ok({ op: "debug-reset" })).debug!.entries.length, 0);
  }));
}

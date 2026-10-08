// The utility host end to end: a real child process running the real controller, with fake agent
// backends defined below. Forked with DUM_FAKE_HOST=1, this file serves the host instead of testing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { serve } from "../src/desktop/controller.ts";
import { HostEventSchema, type HostEvent, type HostResult } from "../src/desktop/host-protocol.ts";
import { DEFAULT_PREFERENCES } from "../src/desktop/protocol.ts";
import * as skills from "../src/skills.ts";
import type { AgentBackend, AgentChoice, AgentEvent, BackendId, CredentialSource } from "../src/agent/types.ts";
import type { RequestBinding } from "../src/share-types.ts";
import type { Zone } from "../src/zone-types.ts";

const NOTE = "working on a counter loop in counter.py";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A backend that answers from the turn's text. Only "claude" may ever open a session here. */
function fakeBackend(id: BackendId, credential: CredentialSource): AgentBackend {
  const end: AgentEvent = { type: "end", error: null, interrupted: false };
  return {
    id,
    label: `Fake ${id}`,
    async models(_login, signal) {
      const key = await credential("anthropic-key", signal);
      return [{ id: key?.value ?? "no-key", label: "fake", efforts: [], images: true, actions: true, verified: false }];
    },
    capabilities: () => ({ images: true, interrupt: true, runtimeActionCheck: false }),
    async open(o) {
      if (id !== "claude") throw new Error(`the ${id} backend was never chosen`);
      return {
        async *turn(input) {
          if (!o.actions.length) {
            yield { type: "text", text: input.images?.length ? "a code editor showing a counter loop" : JSON.stringify({ anchor: null, say: "", note: NOTE }) };
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
            const change = o.actions.find((a) => a.name === "change")!;
            const out = await change.call({ path: write[1], base_sha: null, content: "print('hi')\n", skills: [{ name: "variables", lang: "python" }] }, o.signal);
            yield { type: "text", text: out.text };
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
type Fixture = { dir: string; home: string; bin: string };

const CHOICE: AgentChoice = {
  backend: "claude", login: "anthropic-key",
  intern: { backend: "claude", model: "fake-intern", effort: null },
  helper: { backend: "claude", model: "fake-helper", effort: null },
};
const PERSONAL = { path: "", text: "", warning: "" };

/** One isolated Dum home; the child's PATH is an empty folder, so no Git is reachable. */
function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dum-desktop-controller-")));
  const bin = join(dir, "empty-bin");
  mkdirSync(bin);
  return { dir, home: join(dir, "home"), bin };
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
      env: { ...process.env, PATH: f.bin, DUM_FAKE_HOST: "1", DUM_HOST_EPOCH: this.epoch, DUM_HOME: f.home, DUM_CONTEXT: "off", DUM_TEST_CREDENTIAL_MS: "400" },
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

  /** The newest state that satisfies `predicate`, waiting for one if none came yet. */
  async until(predicate: (s: State) => boolean): Promise<State> {
    const seen = this.events.findLast((e): e is State => e.type === "state" && predicate(e));
    return seen ?? this.take((e): e is State => e.type === "state" && predicate(e));
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

  async start(f: Fixture, agent: AgentChoice | null = CHOICE): Promise<void> {
    await this.take((e): e is Extract<HostEvent, { type: "ready" }> => e.type === "ready");
    await this.ok({ op: "initialize", home: f.home, flavor: "local", claudeExecutable: null, personal: PERSONAL, settings: { ...DEFAULT_PREFERENCES, agent } });
  }

  async zone(name: string, parentId: string | null, enter = true): Promise<Zone> {
    const result = await this.ok({ op: "zone-create", zone: { name, goal: `learn ${name}`, parentId, language: "python", focusSkills: [] }, enter });
    return result.zone!;
  }

  /** The zone is open and waiting at "what next". */
  ready(zoneId: string): Promise<State> {
    return this.until((s) => s.activeZone?.id === zoneId && s.state?.prompt?.type === "next" && s.zoneEpoch !== null);
  }
}

function binding(s: State, requestId: string = randomUUID()): RequestBinding {
  return { zoneId: s.activeZone!.id, zoneEpoch: s.zoneEpoch!, inputToken: s.inputToken, requestId };
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
    await host.ok({ op: "panel", panel: "tree" });
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
    await host.ok({ op: "send", binding: old, text: "SLOW please", shares: [] });
    s = await host.until((e) => e.activeZone?.id === a.id && !!e.state?.busy);
    await host.ok({ op: "zone-enter", zoneId: b.id, expectedRevision: s.registry.revision });
    // Everything the host posted after it replied to the switch.
    const mark = host.events.length;
    const switched = await host.ready(b.id);
    assert.notEqual(switched.zoneEpoch, old.zoneEpoch);
    // A round trip after the switch: everything the old run did late has been processed by now.
    await host.ok({ op: "panel", panel: "tree" });
    const after = host.events.slice(mark);
    assert.equal(after.some((e) => e.type === "state" && e.state?.zoneId === a.id), false);
    assert.equal(host.events.some((e) => e.type === "state" && JSON.stringify(e.state).includes("late words")), false);
    const late = await host.call({ op: "send", binding: old, text: "an answer for Alpha", shares: [] });
    assert.equal(late.ok, false);

    host.child.kill("SIGKILL");
    await once(host.child, "exit");
    const next = launch();
    await next.start(f);
    next.send({ op: "panel", panel: "tree" }, "own-epoch");
    next.child.send({ epoch: host.epoch, id: "dead-epoch", op: "panel", panel: "tree" });
    await next.reply("own-epoch");
    const reopened = await next.ready(b.id);
    assert.notEqual(reopened.zoneEpoch, switched.zoneEpoch);
    assert.equal(next.events.some((e) => e.type === "reply" && e.id === "dead-epoch"), false);
    const alpha = readFileSync(join(f.home, "zones", a.id, "transcript.json"), "utf8");
    assert.equal(alpha.includes("late words"), false);
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

  test("an ambient tick on followed code reaches the helper and lands as a zone memory note", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    const work = join(f.dir, "work");
    mkdirSync(work);
    writeFileSync(join(work, "counter.py"), "count = 0\n");
    const host = launch();
    await host.start(f);
    const z = await host.zone("Loops", null);
    await host.ready(z.id);
    const follow = (await host.ok({ op: "follow-add", path: work })).follow!;
    assert.equal(follow.files, 1);
    writeFileSync(join(work, "counter.py"), "count = 0\nfor i in range(3):\n    count += i\n");
    const s = await host.until((e) => e.follows.length === 1);
    for (let i = 0; i < 4; i++) {
      await host.ok({ op: "observe-tick", tick: { zoneId: z.id, epoch: s.zoneEpoch, at: Date.now(), app: null, screen: null } });
    }
    // The note is written by the host after its helper call; no event names that write, so poll the file.
    const memory = join(f.home, "zones", z.id, "memory.md");
    for (let i = 0; i < 200 && !(existsSync(memory) && readFileSync(memory, "utf8").includes(NOTE)); i++) await sleep(25);
    assert.ok(readFileSync(memory, "utf8").includes(NOTE));

    // A tick from another epoch is blocked: the look says it's paused and asks nothing.
    await host.ok({ op: "observe-tick", tick: { zoneId: z.id, epoch: randomUUID(), at: Date.now(), app: null, screen: null } });
    await host.until((e) => /paused/.test(e.look.status));
  }));

  test("a permitted change is written directly with its diff, and revert puts the file back", { timeout: 60_000 }, () => withHosts(async (f, launch) => {
    let tree: skills.Tree = { skills: [] };
    for (const name of ["printing", "variables"]) tree = skills.unlock(tree, { name, lang: "python", how: "typed", level: "build", why: "fixture" });
    skills.write(tree, f.home);
    const work = join(f.dir, "work");
    mkdirSync(work);
    const host = launch();
    await host.start(f);
    const z = await host.zone("Python", null);
    let s = await host.ready(z.id);
    const request = binding(s);
    const share = (await host.ok({ op: "share-add", path: work, kind: "folder", binding: request })).share!;
    s = await host.until((e) => e.shares.length === 1);
    assert.equal(s.shares[0]!.id, share.id);
    await host.ok({ op: "send", binding: request, text: `WRITE ${share.id}/hello.py`, shares: [share] });
    s = await host.until((e) => e.changes.length === 1 && e.state?.prompt?.type === "next");
    assert.equal(readFileSync(join(work, "hello.py"), "utf8"), "print('hi')\n");
    const made = s.changes[0]!;
    assert.equal(made.revertible, true);
    assert.equal(s.shares.length, 0);
    assert.ok(s.state!.transcript.some((e) => e.kind === "diff" && e.outcome === "applied" && e.changeId === made.id));

    const reverted = (await host.ok({ op: "change-revert", changeId: made.id, binding: binding(s) })).change!;
    assert.equal(reverted.revertible, false);
    assert.equal(existsSync(join(work, "hello.py")), false);
    s = await host.until((e) => e.changes[0]?.revertible === false);
    assert.ok(s.state!.transcript.some((e) => e.kind === "diff" && e.outcome === "reverted"));
    const again = await host.call({ op: "change-revert", changeId: made.id, binding: binding(s) });
    assert.equal(again.ok, false);
  }));
}

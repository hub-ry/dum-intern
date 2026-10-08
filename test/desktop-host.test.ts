// The shipped host entry (src/desktop/host.ts) as a real child: strict requests and events, the H
// writer lock, and history that survives a restart into a fresh zone epoch. No backend is chosen,
// so no model is ever called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEventSchema, type HostEvent, type HostResult } from "../src/desktop/host-protocol.ts";
import { DEFAULT_PREFERENCES } from "../src/desktop/protocol.ts";
import type { AgentChoice } from "../src/agent/types.ts";

type State = Extract<HostEvent, { type: "state" }>;
type Reply = Extract<HostEvent, { type: "reply" }>;

const PERSONAL = { path: "", text: "", warning: "" };
const SUBSCRIPTION: AgentChoice = {
  backend: "claude", login: "claude-subscription",
  intern: { backend: "claude", model: "claude-sonnet-4-5", effort: null },
  helper: { backend: "claude", model: "claude-haiku-4-5", effort: null },
};

class Host {
  readonly epoch = randomUUID();
  readonly events: HostEvent[] = [];
  readonly child: ChildProcess;
  private stderr = "";
  private sequence = 0;
  private readonly listeners = new Set<() => void>();

  constructor(home: string, bin: string) {
    this.child = fork(new URL("../src/desktop/host.ts", import.meta.url), [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, PATH: bin, DUM_HOST_EPOCH: this.epoch, DUM_HOME: home, DUM_CONTEXT: "off" },
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

  take<T extends HostEvent>(predicate: (e: HostEvent) => e is T): Promise<T> {
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
    }, 15_000);
    this.listeners.add(look);
    look();
    return promise;
  }

  async until(predicate: (s: State) => boolean): Promise<State> {
    const seen = this.events.findLast((e): e is State => e.type === "state" && predicate(e));
    return seen ?? this.take((e): e is State => e.type === "state" && predicate(e));
  }

  send(fields: object, id = `r${++this.sequence}`, epoch = this.epoch): string {
    this.child.send({ epoch, id, ...fields });
    return id;
  }

  reply(id: string): Promise<Reply> {
    return this.take((e): e is Reply => e.type === "reply" && e.id === id);
  }

  call(fields: object): Promise<Reply> {
    return this.reply(this.send(fields));
  }

  async ok(fields: object): Promise<HostResult> {
    const reply = await this.call(fields);
    assert.equal(reply.ok, true, `${JSON.stringify(fields).slice(0, 200)} failed: ${reply.error}`);
    return reply.result ?? {};
  }

  ready(): Promise<unknown> {
    return this.take((e): e is Extract<HostEvent, { type: "ready" }> => e.type === "ready");
  }

  initialize(home: string): Promise<Reply> {
    return this.call({ op: "initialize", home, flavor: "public", claudeExecutable: null, personal: PERSONAL, settings: DEFAULT_PREFERENCES });
  }
}

test("the real host takes only strict requests, holds H for one writer, and reopens history with a fresh zone epoch", { timeout: 60_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dum-desktop-host-")));
  const home = join(dir, "home");
  const bin = join(dir, "empty-bin");
  mkdirSync(bin);
  const hosts: Host[] = [];
  const launch = () => {
    const host = new Host(home, bin);
    hosts.push(host);
    return host;
  };
  try {
    const first = launch();
    await first.ready();
    const early = await first.call({ op: "zone-create", zone: { name: "Early", goal: "too soon", parentId: null, language: null, focusSkills: [] }, enter: true });
    assert.equal(early.ok, false);
    assert.match(early.error!, /isn't set up/);

    // Malformed, foreign-epoch, legacy and flavor-refused requests get no reply at all.
    first.send({ op: "panel", panel: "tree", extra: true }, "extra-field");
    first.send({ op: "panel", panel: "tree" }, "foreign", randomUUID());
    first.send({ op: "open", root: dir, personal: PERSONAL }, "legacy-open");
    first.send({ op: "initialize", home, flavor: "public", claudeExecutable: null, personal: PERSONAL, settings: { ...DEFAULT_PREFERENCES, agent: SUBSCRIPTION } }, "public-subscription");
    assert.equal((await first.initialize(home)).ok, true);
    for (const id of ["extra-field", "foreign", "legacy-open", "public-subscription"]) {
      assert.equal(first.events.some((e) => e.type === "reply" && e.id === id), false, id);
    }
    const again = await first.initialize(home);
    assert.equal(again.ok, false);

    // The tree and settings need no zone and no backend; this build has neither Claude nor a released ChatGPT.
    await first.ok({ op: "panel", panel: "tree" });
    assert.notEqual((await first.until((s) => s.tree !== null)).tree, null);
    await first.ok({ op: "settings", settings: { ...DEFAULT_PREFERENCES, personalContext: true } });
    const noClaude = await first.call({ op: "agent-select", choice: { ...SUBSCRIPTION, login: "anthropic-key" } });
    assert.equal(noClaude.ok, false);
    assert.match(noClaude.error!, /isn't available/);
    const subscription = await first.call({ op: "agent-select", choice: SUBSCRIPTION });
    assert.equal(subscription.ok, false);
    assert.match(subscription.error!, /public build/);

    const zone = (await first.ok({ op: "zone-create", zone: { name: "Rust", goal: "learn ownership", parentId: null, language: "rust", focusSkills: [] }, enter: true })).zone!;
    const opened = await first.until((s) => s.activeZone?.id === zone.id && s.state?.prompt?.type === "next");
    assert.ok(opened.zoneEpoch);
    const binding = { zoneId: zone.id, zoneEpoch: opened.zoneEpoch, inputToken: opened.inputToken, requestId: randomUUID() };
    const noAgent = await first.call({ op: "send", binding, text: "explain borrowing", shares: [] });
    assert.equal(noAgent.ok, false);
    assert.match(noAgent.error!, /Choose who powers Dum/);
    await first.ok({ op: "command", name: "remember", argument: "Use integer cents for money.", binding });
    await first.until((s) => !!s.state?.transcript.some((e) => e.kind === "note" && e.text.includes("integer cents")) && s.state.prompt?.type === "next");
    assert.match(readFileSync(join(home, "zones", zone.id, "memory.md"), "utf8"), /integer cents/);
    const record = (await first.ok({ op: "open-record", record: "memory" })).path!;
    assert.equal(record, join(home, "zones", zone.id, "memory.md"));

    // A second host on the same H is refused before it touches anything.
    const second = launch();
    await second.ready();
    const collision = await second.initialize(home);
    assert.equal(collision.ok, false);
    assert.match(collision.error!, /already open/);

    await first.ok({ op: "close" });
    await once(first.child, "exit");
    assert.equal(existsSync(join(home, "session.lock")), false);

    assert.equal((await second.initialize(home)).ok, true);
    const restored = await second.until((s) => s.activeZone?.id === zone.id && s.state?.prompt?.type === "next");
    assert.ok(restored.state!.transcript.some((e) => e.kind === "note" && e.text.includes("integer cents")));
    assert.notEqual(restored.zoneEpoch, opened.zoneEpoch);
    const stale = await second.call({ op: "command", name: "remember", argument: "from the old epoch", binding });
    assert.equal(stale.ok, false);
    await second.ok({ op: "close" });
  } finally {
    for (const { child } of hosts) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill();
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

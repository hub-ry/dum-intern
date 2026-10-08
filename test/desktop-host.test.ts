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
const MAIN = {
  version: "0.0.0-test", platform: "linux", backends: [], screenPermission: "not-required", lookPaused: false,
  voice: { supported: false, available: false, bridge: false }, shortcuts: { open: null, voice: null, sendDraft: null },
};
const CLAUDE: AgentChoice = {
  backend: "claude", login: "anthropic-key",
  intern: { backend: "claude", model: "opus", effort: "high" },
  helper: { backend: "claude", model: "fable", effort: "high" },
  look: { backend: "claude", model: "haiku", effort: "low" },
};
/** The Claude subscription login Dum removed: it no longer parses as a login method. */
const SUBSCRIPTION = { ...CLAUDE, login: "claude-subscription" };

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
    return this.call({ op: "initialize", home, claudeExecutable: null, personal: PERSONAL, settings: DEFAULT_PREFERENCES, main: MAIN });
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

    // Malformed, foreign-epoch, legacy and unknown-login requests get no reply at all.
    first.send({ op: "view", view: "tree", extra: true }, "extra-field");
    first.send({ op: "view", view: "tree" }, "foreign", randomUUID());
    first.send({ op: "panel", panel: "tree" }, "legacy-panel");
    first.send({ op: "open", root: dir, personal: PERSONAL }, "legacy-open");
    first.send({ op: "initialize", home, claudeExecutable: null, personal: PERSONAL, settings: { ...DEFAULT_PREFERENCES, agent: SUBSCRIPTION }, main: MAIN }, "init-subscription");
    first.send({ op: "initialize", home, claudeExecutable: null, personal: PERSONAL, settings: DEFAULT_PREFERENCES }, "init-no-main");
    assert.equal((await first.initialize(home)).ok, true);
    first.send({ op: "agent-select", choice: SUBSCRIPTION }, "select-subscription");
    const again = await first.initialize(home);
    assert.equal(again.ok, false);

    // The tree and settings need no zone and no backend; this build has neither Claude nor a released ChatGPT.
    await first.ok({ op: "view", view: "tree" });
    assert.notEqual((await first.until((s) => s.tree !== null)).tree, null);
    await first.ok({ op: "settings", settings: { ...DEFAULT_PREFERENCES, personalContext: true } });
    const noClaude = await first.call({ op: "agent-select", choice: CLAUDE });
    assert.equal(noClaude.ok, false);
    assert.match(noClaude.error!, /isn't available/);
    for (const id of ["extra-field", "foreign", "legacy-panel", "legacy-open", "init-subscription", "init-no-main", "select-subscription"]) {
      assert.equal(first.events.some((e) => e.type === "reply" && e.id === id), false, id);
    }

    const created = await first.ok({ op: "zone-create", zone: { name: "Rust", goal: "learn ownership", parentId: null, language: "rust", focusSkills: [] }, enter: true });
    const zone = created.zone!;
    // Goal-start alignment begins for the new zone, locally; nothing calls a model and nothing is agreed.
    assert.equal(created.direction!.zoneId, zone.id);
    assert.equal(created.direction!.current, null);
    assert.equal(created.direction!.attempt!.phase, "reflect");
    const opened = await first.until((s) => s.activeZone?.id === zone.id && s.state?.prompt?.type === "next" && s.session !== null);
    assert.ok(opened.zoneEpoch);
    assert.equal(opened.look.status, "no-backend");
    // With no backend, starting alignment keeps a pending attempt that waits for setup, never a fabricated agreement.
    const waiting = (await first.ok({ op: "alignment-step", binding: created.direction!.binding, action: "start" })).direction!;
    assert.equal(waiting.status, "needs-backend");
    assert.equal(waiting.current, null);
    const firstSession = opened.session!.id;
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
    const restored = await second.until((s) => s.activeZone?.id === zone.id && s.state?.prompt?.type === "next" && s.session !== null);
    assert.ok(restored.state!.transcript.some((e) => e.kind === "note" && e.text.includes("integer cents")));
    assert.notEqual(restored.zoneEpoch, opened.zoneEpoch);
    // The goal-start attempt survived the restart; the old session was closed and a fresh one started.
    assert.equal((await second.ok({ op: "alignment-read", zoneId: zone.id })).direction!.status, "needs-backend");
    assert.notEqual(restored.session!.id, firstSession);
    const earlier = (await second.ok({ op: "trail-read", zoneId: zone.id, sessionId: firstSession, cursor: null })).trail!;
    assert.notEqual(earlier.session.endedAt, null);
    assert.equal(earlier.session.endReason, "quit");
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

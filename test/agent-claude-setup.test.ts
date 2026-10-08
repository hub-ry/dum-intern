import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { bundledCandidates, bundledExecutable, claudeSetup, type Probe, type Spawn } from "../src/agent/claude-setup.ts";
import type { AuthStatus } from "../src/agent/claude-cli.ts";
import type { Credentials } from "../src/desktop/credentials.ts";
import type { Flavor, LoginUi } from "../src/agent/types.ts";

process.env.DUM_CONTEXT = "off";

function store(initial: string | null = null) {
  let key = initial;
  const fake = {
    async has(kind: string) { assert.equal(kind, "anthropic-key"); return key !== null; },
    async get(kind: string) { assert.equal(kind, "anthropic-key"); return key; },
    async set(kind: string, value: string) { assert.equal(kind, "anthropic-key"); key = value; },
    async delete(kind: string) { assert.equal(kind, "anthropic-key"); key = null; },
  };
  return { credentials: fake as unknown as Credentials, read: () => key };
}

function probe(o: { runs?: boolean; auth?: AuthStatus | Error } = {}) {
  const calls = { auth: 0, logout: 0, envs: [] as NodeJS.ProcessEnv[] };
  const p: Probe = {
    async version(_e, env) { calls.envs.push(env); return o.runs ?? true; },
    async auth(_e, env) {
      calls.auth++;
      calls.envs.push(env);
      if (o.auth instanceof Error) throw o.auth;
      return o.auth ?? { loggedIn: false };
    },
    async logout() { calls.logout++; },
  };
  return { probe: p, calls };
}

const ui = () => {
  const opened: string[] = [];
  let changes = 0;
  const value: LoginUi = { async openUrl(url) { opened.push(url); }, changed() { changes++; } };
  return { value, opened, changes: () => changes };
};

type FakeChild = ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; signals: string[]; written: string[] };
function fakeSpawn() {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
  const spawn: Spawn = (_exe, args, env) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      signals: [] as string[], written: [] as string[], exitCode: null, signalCode: null,
      kill(signal: string) { child.signals.push(signal); return true; },
    }) as unknown as FakeChild;
    child.stdin.on("data", (d: Buffer) => child.written.push(d.toString()));
    spawned.push({ args, env, child });
    return child;
  };
  return { spawn, spawned };
}

test("bundled binary resolution finds the platform package, unpacks asar paths, and never falls back to PATH", () => {
  assert.deepEqual(bundledCandidates("darwin", "arm64", false), ["@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"]);
  assert.deepEqual(bundledCandidates("linux", "x64", true), ["@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude", "@anthropic-ai/claude-agent-sdk-linux-x64/claude"]);
  assert.deepEqual(bundledCandidates("win32", "x64", false), ["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"]);
  const dir = mkdtempSync(join(tmpdir(), "dum-bundle-"));
  try {
    const unpacked = join(dir, "app.asar.unpacked", "pkg");
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(unpacked, "claude"), "#!/bin/sh\n");
    chmodSync(join(unpacked, "claude"), 0o755);
    const packed = join(dir, "app.asar", "pkg", "claude");
    assert.equal(bundledExecutable(() => packed, "darwin", "arm64", false), join(unpacked, "claude"));
    writeFileSync(join(dir, "plain"), "x");
    chmodSync(join(dir, "plain"), 0o644);
    assert.equal(bundledExecutable(() => join(dir, "plain"), "darwin", "arm64", false), null, "not executable");
    assert.equal(bundledExecutable(() => { throw new Error("missing"); }, "darwin", "arm64", false), null, "no PATH lookup");
    assert.equal(bundledExecutable(() => "claude", "darwin", "arm64", false), null, "relative names are refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status per method and flavor", async () => {
  const cases: { flavor: Flavor; key: string | null; auth?: AuthStatus | Error; ready: string | null; methods: string[]; authCalls: number }[] = [
    { flavor: "public", key: null, ready: null, methods: ["anthropic-key"], authCalls: 0 },
    { flavor: "public", key: "sk", ready: "anthropic-key", methods: ["anthropic-key"], authCalls: 0 },
    { flavor: "public", key: null, auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, ready: null, methods: ["anthropic-key"], authCalls: 0 },
    { flavor: "local", key: null, auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, ready: "claude-subscription", methods: ["anthropic-key", "claude-subscription"], authCalls: 1 },
    { flavor: "local", key: null, auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "vertex" }, ready: null, methods: ["anthropic-key", "claude-subscription"], authCalls: 1 },
    { flavor: "local", key: "sk", auth: { loggedIn: false }, ready: "anthropic-key", methods: ["anthropic-key", "claude-subscription"], authCalls: 1 },
    { flavor: "local", key: null, auth: new Error("broken"), ready: null, methods: ["anthropic-key", "claude-subscription"], authCalls: 1 },
  ];
  for (const c of cases) {
    const { probe: p, calls } = probe({ auth: c.auth });
    const s = await claudeSetup({ flavor: c.flavor, executable: "/opt/claude", credentials: store(c.key).credentials, probe: p }).status();
    assert.equal(s.ready, c.ready, JSON.stringify(c));
    assert.deepEqual(s.methods, c.methods);
    assert.equal(s.installed, true);
    assert.equal(calls.auth, c.authCalls, "public builds never ask about the subscription");
    assert.doesNotMatch(s.message, /sk/);
    for (const env of calls.envs) {
      assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
    }
  }
  const missing = await claudeSetup({ flavor: "local", executable: null, credentials: store().credentials, probe: probe().probe }).status();
  assert.equal(missing.installed, false);
  assert.match(missing.message, /complete build/);
  const broken = await claudeSetup({ flavor: "local", executable: "/opt/claude", credentials: store().credentials, probe: probe({ runs: false }).probe }).status();
  assert.equal(broken.installed, false);
});

test("the key is shape-checked and write-only; sign-out removes only it", async () => {
  const s = store();
  const setup = claudeSetup({ flavor: "public", executable: "/opt/claude", credentials: s.credentials, probe: probe().probe });
  for (const bad of ["", "sk ant", "sk\nant", "x".repeat(257), "sk-é"]) await assert.rejects(setup.setKey(bad), /doesn't look like/);
  assert.equal(s.read(), null);
  await setup.setKey("sk-ant-123");
  assert.equal(s.read(), "sk-ant-123");
  const status = await setup.status();
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-123/);
  await setup.signOut("anthropic-key");
  assert.equal(s.read(), null);
  await assert.rejects(setup.signOut("claude-subscription"), /in this build/);
});

test("public builds refuse the subscription sign-in", async () => {
  const { spawn, spawned } = fakeSpawn();
  const setup = claudeSetup({ flavor: "public", executable: "/opt/claude", credentials: store().credentials, probe: probe().probe, spawn });
  await assert.rejects(setup.login("claude-subscription", ui().value), /doesn't sign in with a Claude subscription/);
  await assert.rejects(setup.login("anthropic-key", ui().value), /API key/);
  await assert.rejects(setup.login("chatgpt", ui().value), /chatgpt/);
  assert.equal(spawned.length, 0);
});

test("paste-code flow: isolated CLI, bounded output, allowlisted page, code to stdin only, recheck after exit", async () => {
  const { spawn, spawned } = fakeSpawn();
  const { probe: p, calls } = probe({ auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" } });
  const setup = claudeSetup({ flavor: "local", executable: "/opt/claude", credentials: store().credentials, probe: p, spawn });
  const u = ui();
  await setup.login("claude-subscription", u.value);
  await assert.rejects(setup.login("claude-subscription", u.value), /already running/);
  const { args, env, child } = spawned[0];
  assert.deepEqual(args.slice(0, 3), ["--safe-mode", "--setting-sources", ""]);
  assert.deepEqual(args.slice(-3), ["auth", "login", "--claudeai"]);
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal((await setup.status()).loginRunning, true);

  await assert.rejects(setup.openPage(), /hasn't shown/);
  child.stdout.write("Visit https://evil.example/login or https://user:pw@claude.ai/x or https://claude.ai:8443/x\n");
  await tick();
  await assert.rejects(setup.openPage(), /hasn't shown/, "only allowlisted hosts without credentials or ports");
  child.stdout.write(`${"x".repeat(9000)}https://claude.ai/oauth/authorize?code=1\nPaste code here: `);
  await tick();
  await setup.openPage();
  assert.deepEqual(u.opened, ["https://claude.ai/oauth/authorize?code=1"]);
  assert.equal((await setup.status()).loginNeedsCode, true);

  assert.throws(() => setup.code("short"), /doesn't look like/);
  assert.throws(() => setup.code("abc def ghi"), /doesn't look like/);
  setup.code("  abcDEF123#xyz  ");
  assert.deepEqual(child.written, ["abcDEF123#xyz\n"]);

  child.emit("exit", 0);
  const after = await setup.status();
  assert.equal(after.loginRunning, false);
  assert.equal(after.loginNeedsCode, false);
  assert.equal(after.ready, "claude-subscription", "confirmed by a live check, not by the exit");
  assert.ok(calls.auth >= 2);
  assert.throws(() => setup.code("abcdefgh"), /isn't waiting/);
  await assert.rejects(setup.openPage(), /isn't running/);
});

test("cancel stops the CLI with SIGTERM then SIGKILL; a failed exit keeps no prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { spawn, spawned } = fakeSpawn();
  const setup = claudeSetup({ flavor: "local", executable: "/opt/claude", credentials: store().credentials, probe: probe().probe, spawn });
  await setup.login("claude-subscription", ui().value);
  setup.cancelLogin();
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  t.mock.timers.tick(3000);
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM", "SIGKILL"]);
  spawned[0].child.emit("exit", null);
  const s = await setup.status();
  assert.equal(s.loginRunning, false);
  assert.match(s.message, /cancelled/);

  await setup.login("claude-subscription", ui().value);
  spawned[1].child.emit("exit", 1);
  assert.match((await setup.status()).message, /didn't finish/);

  await setup.login("claude-subscription", ui().value);
  t.mock.timers.tick(15 * 60_000);
  assert.deepEqual(spawned[2].child.signals, ["SIGTERM"], "the 15-minute limit cancels");
  spawned[2].child.emit("exit", null);
  assert.match((await setup.status()).message, /cancelled/);
});

test("subscription sign-out runs the bundled CLI's logout in local builds", async () => {
  const { probe: p, calls } = probe();
  const setup = claudeSetup({ flavor: "local", executable: "/opt/claude", credentials: store().credentials, probe: p });
  await setup.signOut("claude-subscription");
  assert.equal(calls.logout, 1);
});

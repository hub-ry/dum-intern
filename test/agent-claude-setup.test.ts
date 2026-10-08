import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledCandidates, bundledExecutable, claudeSetup, type Probe } from "../src/agent/claude-setup.ts";
import type { Credentials } from "../src/desktop/credentials.ts";
import type { LoginMethod } from "../src/agent/types.ts";

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

function probe(o: { runs?: boolean } = {}) {
  const calls = { envs: [] as NodeJS.ProcessEnv[] };
  const p: Probe = { async version(_e, env) { calls.envs.push(env); return o.runs ?? true; } };
  return { probe: p, calls };
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

test("status: installed and whether a key is stored; Claude takes only an API key", async () => {
  for (const key of [null, "sk-ant-123"]) {
    const { probe: p, calls } = probe();
    const s = await claudeSetup({ executable: "/opt/claude", credentials: store(key).credentials, probe: p }).status();
    assert.equal(s.ready, key ? "anthropic-key" : null);
    assert.deepEqual(s.methods, ["anthropic-key"]);
    assert.equal(s.installed, true);
    assert.equal(s.loginRunning, false);
    assert.doesNotMatch(JSON.stringify(s), /sk-ant/);
    for (const env of calls.envs) {
      assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
    }
  }
  const missing = await claudeSetup({ executable: null, credentials: store().credentials, probe: probe().probe }).status();
  assert.equal(missing.installed, false);
  assert.match(missing.message, /complete build/);
  const broken = await claudeSetup({ executable: "/opt/claude", credentials: store().credentials, probe: probe({ runs: false }).probe }).status();
  assert.equal(broken.installed, false);
});

test("the key is shape-checked and write-only; sign-out removes only it", async () => {
  const s = store();
  const setup = claudeSetup({ executable: "/opt/claude", credentials: s.credentials, probe: probe().probe });
  for (const bad of ["", "sk ant", "sk\nant", "x".repeat(257), "sk-é"]) await assert.rejects(setup.setKey(bad), /doesn't look like/);
  assert.equal(s.read(), null);
  await setup.setKey("sk-ant-123");
  assert.equal(s.read(), "sk-ant-123");
  const status = await setup.status();
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-123/);
  await setup.signOut("anthropic-key");
  assert.equal(s.read(), null);
  await assert.rejects(setup.signOut("chatgpt"), /doesn't sign in with chatgpt/);
});

test("Claude has no sign-in: every login request is refused and nothing runs", async () => {
  const s = store("sk-ant-123");
  const setup = claudeSetup({ executable: "/opt/claude", credentials: s.credentials, probe: probe().probe });
  await assert.rejects(setup.login("anthropic-key"), /API key/);
  await assert.rejects(setup.login("chatgpt"), /doesn't sign in with chatgpt/);
  await assert.rejects(setup.login("claude-subscription" as LoginMethod), /doesn't sign in with claude-subscription/);
  await assert.rejects(setup.signOut("claude-subscription" as LoginMethod), /doesn't sign in with claude-subscription/);
  assert.equal(s.read(), "sk-ant-123", "a refused request changes no credential");
});

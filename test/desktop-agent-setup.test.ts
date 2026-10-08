import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSetup } from "../src/agent/claude-setup.ts";
import { AgentSetup, credentialSource, type PageSetup } from "../src/desktop/agent-setup.ts";
import { Credentials, type Cipher } from "../src/desktop/credentials.ts";
import { DesktopSettings } from "../src/desktop/settings.ts";
import type { AgentChoice, BackendId, BackendStatus, Flavor, LoginMethod, LoginUi, ModelOption } from "../src/agent/types.ts";
import type { DesktopPreferences } from "../src/desktop/protocol.ts";

const temp = () => mkdtempSync(join(tmpdir(), "dum-agent-setup-"));
/** Reversible, not secret: enough to prove the file never holds the plain value. */
const cipher: Cipher = {
  encrypt: async (text) => Buffer.from([...Buffer.from(text, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: async (data) => Buffer.from([...data].map((b) => b ^ 0x5a)).toString("utf8"),
};
const ALL = new Set<BackendId>(["claude", "chatgpt", "local", "copilot"]);
const ui: LoginUi = { openUrl: async () => {}, changed: () => {} };

function fake(id: BackendId, methods: readonly LoginMethod[], o: Partial<PageSetup> & { ready?: LoginMethod | null } = {}) {
  const calls: string[] = [];
  const setup: PageSetup = {
    id,
    status: async (): Promise<BackendStatus> => ({
      id, label: id, installed: true, methods, ready: o.ready ?? null, loginRunning: false, loginNeedsCode: false, message: "ok",
    }),
    login: async (method) => void calls.push(`login ${method}`),
    cancelLogin: () => void calls.push("cancel"),
    signOut: async (method) => void calls.push(`signout ${method}`),
    ...o,
  };
  return { setup, calls };
}

test("every released backend's status runs in parallel, and only released ones are shown", async () => {
  const started: BackendId[] = [];
  const finish: (() => void)[] = [];
  const slow = (id: BackendId, methods: LoginMethod[]) => fake(id, methods, {
    status: () => {
      started.push(id);
      const { promise, resolve } = Promise.withResolvers<BackendStatus>();
      finish.push(() => resolve({ id, label: id, installed: true, methods, ready: methods[0]!, loginRunning: false, loginNeedsCode: false, message: "ready" }));
      return promise;
    },
  }).setup;
  const agent = new AgentSetup([slow("claude", ["anthropic-key"]), slow("local", ["none"]), slow("chatgpt", ["chatgpt"])], "public", new Set(["claude", "local"]));
  const checking = agent.check();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["claude", "local"], "both started before either finished; chatgpt isn't released");
  for (const f of finish) f();
  await checking;
  assert.deepEqual(agent.backends.map((b) => [b.id, b.ready]), [["claude", "anthropic-key"], ["local", "none"]]);
});

test("a status that fails or lies reads as unchecked, and the flavor decides the methods", async () => {
  const broken = fake("local", ["none"], { status: async () => { throw new Error("secret detail"); } }).setup;
  const liar = fake("claude", ["anthropic-key", "claude-subscription"], { ready: "claude-subscription" }).setup;
  const agent = new AgentSetup([broken, liar], "public", ALL);
  await agent.check();
  const [claude, local] = [agent.backends.find((b) => b.id === "claude")!, agent.backends.find((b) => b.id === "local")!];
  assert.deepEqual(claude.methods, ["anthropic-key"]);
  assert.equal(claude.ready, null, "a public build never reports a subscription sign-in as ready");
  assert.equal(local.ready, null);
  assert.ok(!local.message.includes("secret"));
});

test("a public build refuses Claude subscription sign-in and sign-out; a local build routes it", async () => {
  const pub = fake("claude", ["anthropic-key"]);
  const publicSetup = new AgentSetup([pub.setup], "public", ALL);
  assert.throws(() => publicSetup.login("claude", "claude-subscription", ui), /doesn't sign in with a Claude subscription/);
  await assert.rejects(publicSetup.signOut("claude", "claude-subscription"), /Claude subscription/);
  assert.throws(() => publicSetup.login("claude", "anthropic-key", ui), /Paste your Anthropic API key/);
  assert.throws(() => publicSetup.login("copilot", "github", ui), /isn't available|isn't released/);
  assert.deepEqual(pub.calls, [], "nothing reached the backend");

  const loc = fake("claude", ["anthropic-key", "claude-subscription"]);
  const localSetup = new AgentSetup([loc.setup], "local", ALL);
  await localSetup.login("claude", "claude-subscription", ui);
  localSetup.cancel();
  assert.deepEqual(loc.calls, ["login claude-subscription", "cancel"]);

  // The real Claude setup refuses on its own too.
  const real = claudeSetup({ flavor: "public", executable: null, credentials: new Credentials(join(temp(), "c.json"), cipher) });
  await assert.rejects(real.login("claude-subscription", ui), /doesn't sign in with a Claude subscription/);
});

test("the Anthropic key is write-only: stored encrypted, never in a status, a snapshot or an error", async () => {
  const dir = temp();
  const credentials = new Credentials(join(dir, "credentials.json"), cipher);
  const key = "sk-ant-api03-SECRETSECRETSECRET";
  const agent = new AgentSetup([claudeSetup({ flavor: "public", executable: null, credentials })], "public", ALL);
  await agent.setKey("claude", key);
  assert.equal(await credentials.get("anthropic-key"), key);
  assert.ok(!readFileSync(join(dir, "credentials.json"), "utf8").includes(key), "the file holds ciphertext only");
  await agent.check();
  assert.ok(!JSON.stringify(agent.backends).includes(key));
  assert.ok(!JSON.stringify(agent).includes(key));

  const echo = fake("claude", ["anthropic-key"], { setKey: async (k) => { throw new Error(`bad key ${k}`); } }).setup;
  const careless = new AgentSetup([echo], "public", ALL);
  await assert.rejects(careless.setKey("claude", key), (err: Error) => !err.message.includes(key) && /wasn't saved/.test(err.message));

  await agent.signOut("claude", "anthropic-key");
  assert.equal(await credentials.get("anthropic-key"), null);
});

const CATALOG: ModelOption[] = [
  { id: "big", label: "Big", efforts: ["low", "high"], images: true, actions: true, verified: true },
  { id: "small", label: "Small", efforts: [], images: true, actions: false, verified: false },
];
const choice = (patch: Partial<AgentChoice> = {}): AgentChoice => ({
  backend: "claude", login: "anthropic-key",
  intern: { backend: "claude", model: "big", effort: "high" },
  helper: { backend: "claude", model: "small", effort: null },
  ...patch,
});

function selecting(flavor: Flavor) {
  const settings = DesktopSettings.load(temp(), flavor);
  const order: string[] = [];
  const ports = {
    models: async (backend: BackendId, login: LoginMethod) => { order.push(`models ${backend} ${login}`); return CATALOG; },
    settings: { get: () => settings.get(), set: (p: DesktopPreferences) => { order.push("persist"); settings.set(p); } },
    send: async (c: AgentChoice) => { order.push(`send ${c.intern.model}`); },
  };
  return { settings, order, ports, agent: new AgentSetup([fake("claude", ["anthropic-key", "claude-subscription"]).setup, fake("local", ["none"]).setup], flavor, ALL) };
}

test("a selection is checked against the flavor and the host's catalog, persisted, then forwarded", async () => {
  const s = selecting("public");
  await s.agent.select(choice(), s.ports);
  assert.deepEqual(s.order, ["models claude anthropic-key", "persist", "send big"]);
  assert.deepEqual(s.settings.get().agent, choice());
  assert.deepEqual(DesktopSettings.load(s.settings.dir, "public").get().agent, choice(), "it survives a restart");
});

test("a selection the flavor or catalog doesn't allow changes nothing", async () => {
  const s = selecting("public");
  const bad: AgentChoice[] = [
    choice({ login: "claude-subscription" }),
    choice({ intern: { backend: "claude", model: "small", effort: null } }),
    choice({ intern: { backend: "claude", model: "big", effort: "max" } }),
    choice({ intern: { backend: "claude", model: "big", effort: null } }),
    choice({ helper: { backend: "claude", model: "small", effort: "high" } }),
    choice({ helper: { backend: "claude", model: "missing", effort: null } }),
    choice({ helper: { backend: "local", model: "small", effort: null } }),
  ];
  for (const c of bad) await assert.rejects(s.agent.select(c, s.ports), Error, JSON.stringify(c));
  assert.ok(!s.order.includes("persist"));
  assert.equal(s.settings.get().agent, null);

  const local = selecting("local");
  await local.agent.select(choice({ login: "claude-subscription" }), local.ports);
  assert.equal(local.settings.get().agent?.login, "claude-subscription", "a local build may choose the subscription");
});

test("a failed forward keeps the persisted choice for the host's next start", async () => {
  const s = selecting("local");
  s.ports.send = async () => { throw new Error("host down"); };
  await assert.rejects(s.agent.select(choice(), s.ports), /host down/);
  assert.deepEqual(s.settings.get().agent, choice());
});

test("credential answers come from the right store and never fail loudly", async () => {
  const credentials = new Credentials(join(temp(), "credentials.json"), cipher);
  const asked: string[] = [];
  const answer = credentialSource(credentials, async (_c, signal) => {
    asked.push("chatgpt");
    signal.throwIfAborted();
    return { value: "access-1", expiresAt: 42 };
  });
  const signal = new AbortController().signal;
  assert.equal(await answer("anthropic-key", signal), null, "no key stored");
  await credentials.set("anthropic-key", "sk-ant-x");
  assert.deepEqual(await answer("anthropic-key", signal), { value: "sk-ant-x", expiresAt: null });
  assert.deepEqual(await answer("chatgpt-access", signal), { value: "access-1", expiresAt: 42 });
  assert.equal(await answer("chatgpt-access", AbortSignal.abort()), null, "an aborted request answers null");
  const failing = credentialSource(credentials, async () => { throw new Error("Sign in to ChatGPT again"); });
  assert.equal(await failing("chatgpt-access", signal), null);
  assert.deepEqual(asked, ["chatgpt", "chatgpt"]);
});

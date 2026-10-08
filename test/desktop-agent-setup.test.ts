import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSetup } from "../src/agent/claude-setup.ts";
import { AgentSetup, credentialSource } from "../src/desktop/agent-setup.ts";
import { Credentials, type Cipher } from "../src/desktop/credentials.ts";
import { DesktopSettings } from "../src/desktop/settings.ts";
import type { AgentChoice, BackendId, BackendSetup, BackendStatus, LoginMethod, LoginUi, ModelOption } from "../src/agent/types.ts";
import type { DesktopPreferences } from "../src/desktop/protocol.ts";

const temp = () => mkdtempSync(join(tmpdir(), "dum-agent-setup-"));
/** Reversible, not secret: enough to prove the file never holds the plain value. */
const cipher: Cipher = {
  encrypt: async (text) => Buffer.from([...Buffer.from(text, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: async (data) => Buffer.from([...data].map((b) => b ^ 0x5a)).toString("utf8"),
};
const ALL = new Set<BackendId>(["claude", "chatgpt", "local", "copilot"]);
const ui: LoginUi = { openUrl: async () => {}, changed: () => {} };
/** The Claude subscription login Dum removed: it is no longer a LoginMethod. */
const SUBSCRIPTION = "claude-subscription" as LoginMethod;

function fake(id: BackendId, methods: readonly LoginMethod[], o: Partial<BackendSetup> & { ready?: LoginMethod | null } = {}) {
  const calls: string[] = [];
  const setup: BackendSetup = {
    id,
    status: async (): Promise<BackendStatus> => ({
      id, label: id, installed: true, methods, ready: o.ready ?? null, loginRunning: false, message: "ok",
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
      finish.push(() => resolve({ id, label: id, installed: true, methods, ready: methods[0]!, loginRunning: false, message: "ready" }));
      return promise;
    },
  }).setup;
  const agent = new AgentSetup([slow("claude", ["anthropic-key"]), slow("local", ["none"]), slow("chatgpt", ["chatgpt"])], new Set(["claude", "local"]));
  const checking = agent.check();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["claude", "local"], "both started before either finished; chatgpt isn't released");
  for (const f of finish) f();
  await checking;
  assert.deepEqual(agent.backends.map((b) => [b.id, b.ready]), [["claude", "anthropic-key"], ["local", "none"]]);
});

test("a status that fails or lies reads as unchecked, and each backend's own sign-in list decides the methods", async () => {
  const broken = fake("local", ["none"], { status: async () => { throw new Error("secret detail"); } }).setup;
  const liar = fake("claude", ["anthropic-key", "chatgpt"], { ready: "chatgpt" }).setup;
  const agent = new AgentSetup([broken, liar], ALL);
  await agent.check();
  const [claude, local] = [agent.backends.find((b) => b.id === "claude")!, agent.backends.find((b) => b.id === "local")!];
  assert.deepEqual(claude.methods, ["anthropic-key"]);
  assert.equal(claude.ready, null, "Claude is never ready by a method it doesn't take");
  assert.equal(local.ready, null);
  assert.ok(!local.message.includes("secret"));
});

test("Claude takes only an API key: a subscription sign-in or sign-out is refused as an unknown method", async () => {
  const claude = fake("claude", ["anthropic-key"]);
  const agent = new AgentSetup([claude.setup], ALL);
  assert.throws(() => agent.login("claude", SUBSCRIPTION, ui), /Claude doesn't sign in with claude-subscription/);
  await assert.rejects(agent.signOut("claude", SUBSCRIPTION), /Claude doesn't sign in with claude-subscription/);
  assert.throws(() => agent.login("claude", "anthropic-key", ui), /Paste your Anthropic API key/);
  assert.throws(() => agent.login("copilot", "github", ui), /isn't available|isn't released/);
  assert.deepEqual(claude.calls, [], "nothing reached the backend");

  // The real Claude setup refuses on its own too.
  const real = claudeSetup({ executable: null, credentials: new Credentials(join(temp(), "c.json"), cipher) });
  await assert.rejects(real.login(SUBSCRIPTION), /doesn't sign in with claude-subscription/);
});

test("the Anthropic key is write-only: stored encrypted, never in a status, a snapshot or an error", async () => {
  const dir = temp();
  const credentials = new Credentials(join(dir, "credentials.json"), cipher);
  const key = "sk-ant-api03-SECRETSECRETSECRET";
  const agent = new AgentSetup([claudeSetup({ executable: null, credentials })], ALL);
  await agent.setKey("claude", key);
  assert.equal(await credentials.get("anthropic-key"), key);
  assert.ok(!readFileSync(join(dir, "credentials.json"), "utf8").includes(key), "the file holds ciphertext only");
  await agent.check();
  assert.ok(!JSON.stringify(agent.backends).includes(key));
  assert.ok(!JSON.stringify(agent).includes(key));

  const echo = fake("claude", ["anthropic-key"], { setKey: async (k) => { throw new Error(`bad key ${k}`); } }).setup;
  const careless = new AgentSetup([echo], ALL);
  await assert.rejects(careless.setKey("claude", key), (err: Error) => !err.message.includes(key) && /wasn't saved/.test(err.message));

  await agent.signOut("claude", "anthropic-key");
  assert.equal(await credentials.get("anthropic-key"), null);
});

const CATALOG: ModelOption[] = [
  { id: "big", resolved: "big-1", label: "Big", efforts: ["low", "high"], images: true, actions: true, verified: true },
  { id: "small", resolved: "small-1", label: "Small", efforts: [], images: true, actions: false, verified: false },
  { id: "blind", resolved: "blind-1", label: "Blind", efforts: [], images: false, actions: true, verified: true },
];
const choice = (patch: Partial<AgentChoice> = {}): AgentChoice => ({
  backend: "claude", login: "anthropic-key",
  intern: { backend: "claude", model: "big", effort: "high" },
  helper: { backend: "claude", model: "small", effort: null },
  look: { backend: "claude", model: "small", effort: null },
  ...patch,
});

function selecting(catalog: ModelOption[] = CATALOG) {
  const settings = DesktopSettings.load(temp());
  const order: string[] = [];
  const sent: AgentChoice[] = [];
  const ports = {
    models: async (backend: BackendId, login: LoginMethod) => { order.push(`models ${backend} ${login}`); return catalog; },
    settings: { get: () => settings.get(), set: (p: DesktopPreferences) => { order.push("persist"); settings.set(p); } },
    send: async (c: AgentChoice) => { order.push(`send ${c.intern.model}`); sent.push(c); },
  };
  return { settings, order, sent, ports, agent: new AgentSetup([fake("claude", ["anthropic-key"]).setup, fake("local", ["none"]).setup], ALL) };
}

test("a selection is checked for every role against the host's catalog, persisted, then forwarded", async () => {
  const s = selecting();
  await s.agent.select(choice(), s.ports);
  assert.deepEqual(s.order, ["models claude anthropic-key", "persist", "send big"]);
  assert.deepEqual(s.settings.get().agent, choice());
  assert.deepEqual(DesktopSettings.load(s.settings.dir).get().agent, choice(), "it survives a restart");
});

test("a selection the catalog doesn't allow changes nothing", async () => {
  const s = selecting();
  const bad: { c: AgentChoice; why: RegExp }[] = [
    { c: choice({ login: SUBSCRIPTION }), why: /./ },
    { c: choice({ intern: { backend: "claude", model: "small", effort: null } }), why: /can't be the intern/ },
    { c: choice({ intern: { backend: "claude", model: "big", effort: "max" } }), why: /doesn't offer max effort/ },
    { c: choice({ intern: { backend: "claude", model: "big", effort: null } }), why: /doesn't offer the default effort/ },
    { c: choice({ helper: { backend: "claude", model: "small", effort: "high" } }), why: /doesn't offer high effort/ },
    { c: choice({ helper: { backend: "claude", model: "missing", effort: null } }), why: /isn't in claude's model list/ },
    { c: choice({ helper: { backend: "local", model: "small", effort: null } }), why: /must be on claude/ },
    { c: choice({ look: { backend: "claude", model: "blind", effort: null } }), why: /can't look at pictures, so it can't be the look/ },
    { c: choice({ look: { backend: "claude", model: "missing", effort: null } }), why: /isn't in claude's model list/ },
    { c: choice({ look: { backend: "claude", model: "big", effort: "max" } }), why: /doesn't offer max effort/ },
  ];
  for (const { c, why } of bad) await assert.rejects(s.agent.select(c, s.ports), why, JSON.stringify(c));
  const noLook: Partial<AgentChoice> = choice();
  delete noLook.look;
  await assert.rejects(s.agent.select(noLook as AgentChoice, s.ports), Error, "the look is required");
  assert.ok(!s.order.includes("persist"));
  assert.equal(s.settings.get().agent, null);
});

test("a failed forward keeps the persisted choice for the host's next start", async () => {
  const s = selecting();
  s.ports.send = async () => { throw new Error("host down"); };
  await assert.rejects(s.agent.select(choice(), s.ports), /host down/);
  assert.deepEqual(s.settings.get().agent, choice());
});

/** Claude's catalog as it reads today: aliases that resolve to full model ids. */
const CLAUDE_CATALOG: ModelOption[] = [
  { id: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", efforts: ["low", "medium", "high"], images: true, actions: true, verified: true },
  { id: "opus", resolved: "claude-opus-5-5", label: "Opus", efforts: ["low", "medium", "high"], images: true, actions: true, verified: true },
  { id: "fable", resolved: "claude-fable-5-1", label: "Fable", efforts: ["low", "medium", "high"], images: true, actions: true, verified: true },
  { id: "sonnet", resolved: "claude-sonnet-5-0", label: "Sonnet", efforts: ["low", "medium", "high"], images: true, actions: true, verified: false },
  { id: "haiku", resolved: "claude-haiku-5-5", label: "Haiku", efforts: ["low", "medium", "high"], images: true, actions: true, verified: true },
];
/** Dum's old defaults: full ids the catalog no longer lists. */
const SAVED: AgentChoice = {
  backend: "claude", login: "anthropic-key",
  intern: { backend: "claude", model: "claude-opus-5-5", effort: "high" },
  helper: { backend: "claude", model: "claude-fable-5-1", effort: "high" },
  look: { backend: "claude", model: "haiku", effort: "low" },
};
function saved(agent: AgentChoice, catalog: ModelOption[] | Error = CLAUDE_CATALOG) {
  const s = selecting();
  s.settings.set({ ...s.settings.get(), agent });
  s.order.length = 0;
  s.ports.models = async (backend, login) => {
    s.order.push(`models ${backend} ${login}`);
    if (catalog instanceof Error) throw catalog;
    return catalog;
  };
  return s;
}

test("reconcile moves saved full ids to the listed names that run the same model, preferring Dum's defaults", async () => {
  const s = saved(SAVED);
  const said = await s.agent.reconcile(s.ports);
  assert.equal(said, "Dum's saved models now use the names Claude lists: claude-opus-5-5 → opus, claude-fable-5-1 → fable.");
  const expected: AgentChoice = {
    ...SAVED,
    intern: { backend: "claude", model: "opus", effort: "high" },
    helper: { backend: "claude", model: "fable", effort: "high" },
  };
  assert.deepEqual(s.settings.get().agent, expected, "opus, not default: Dum's default id wins among same-model rows");
  assert.deepEqual(s.sent, [expected]);
  assert.deepEqual(DesktopSettings.load(s.settings.dir).get().agent, expected, "it survives a restart");

  // Nothing left to move: no sentence, no write.
  s.order.length = 0;
  assert.equal(await s.agent.reconcile(s.ports), null);
  assert.deepEqual(s.order, ["models claude anthropic-key"]);
});

test("without a default among them, the first listed row that runs the saved model is used", async () => {
  const s = saved({ ...SAVED, helper: { backend: "claude", model: "claude-opus-5-5", effort: "low" } });
  await s.agent.reconcile(s.ports);
  assert.equal(s.settings.get().agent?.helper.model, "default");
});

test("reconcile never swaps to a different model: an unadvertised effort or an unknown model changes nothing", async () => {
  for (const agent of [
    { ...SAVED, intern: { backend: "claude" as const, model: "claude-opus-5-5", effort: "max" } },
    { ...SAVED, intern: { backend: "claude" as const, model: "claude-opus-4-1", effort: "high" } },
  ]) {
    const s = saved(agent);
    const said = await s.agent.reconcile(s.ports);
    assert.equal(said, "Claude no longer lists Dum's saved intern model. Choose the intern model again in Settings › Agent.");
    assert.ok(!s.order.includes("persist"));
    assert.deepEqual(s.sent, []);
    assert.deepEqual(s.settings.get().agent, agent, "the helper that could map stays as saved too");
  }
  const both = saved({ ...SAVED, helper: { backend: "claude", model: "claude-fable-4-0", effort: "high" }, look: { backend: "claude", model: "claude-haiku-4-5", effort: null } });
  assert.equal(await both.agent.reconcile(both.ports), "Claude no longer lists Dum's saved helper and look models. Choose the helper and look models again in Settings › Agent.");
});

test("reconcile changes nothing and says nothing when the catalog can't be read or nothing is chosen", async () => {
  const s = saved(SAVED, new Error("Paste your Anthropic API key first"));
  assert.equal(await s.agent.reconcile(s.ports), null);
  assert.deepEqual(s.settings.get().agent, SAVED);
  assert.deepEqual(s.sent, []);
  const none = selecting();
  assert.equal(await none.agent.reconcile(none.ports), null);
  assert.deepEqual(none.order, [], "no catalog read without a saved choice");
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, RELEASED } from "../src/agent/registry.ts";
import { agentChoiceSchema, BuildInfoSchema } from "../src/agent/schema.ts";
import type { AgentBackend, AgentChoice, BackendId } from "../src/agent/types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-registry-"));
process.env.DUM_CONTEXT = "off";

const fake = (id: BackendId): AgentBackend => ({
  id,
  label: id,
  models: async () => [],
  capabilities: () => ({ images: false, interrupt: true, runtimeActionCheck: true }),
  open: async () => { throw new Error("fake backends open no sessions"); },
});
const choice = (backend: BackendId, login: AgentChoice["login"]): AgentChoice => ({
  backend,
  login,
  intern: { backend, model: "big", effort: "high" },
  helper: { backend, model: "small", effort: null },
});
const released = new Set<BackendId>(["claude", "local"]);

test("RELEASED keeps ChatGPT and Copilot hidden until their gates", () => {
  assert.deepEqual({ ...RELEASED }, { claude: true, local: true, chatgpt: false, copilot: false });
});

test("chosen() throws until a choice is set, and clears with null", () => {
  const r = createRegistry([fake("claude"), fake("local")], released);
  assert.throws(() => r.chosen(), /Choose who powers Dum/);
  assert.throws(() => r.selector("intern"), /Choose who powers Dum/);
  r.set(choice("local", "none"));
  assert.equal(r.chosen().backend, "local");
  r.set(null);
  assert.throws(() => r.chosen(), /Choose who powers Dum/);
});

test("selector() returns the chosen role's selector", () => {
  const r = createRegistry([fake("claude"), fake("local")], released);
  r.set(choice("claude", "anthropic-key"));
  assert.deepEqual(r.selector("intern"), { backend: "claude", model: "big", effort: "high" });
  assert.deepEqual(r.selector("helper"), { backend: "claude", model: "small", effort: null });
});

test("unreleased and unregistered backends throw, and are never chosen", () => {
  const r = createRegistry([fake("claude"), fake("chatgpt")], released);
  assert.equal(r.backend("claude").id, "claude");
  assert.throws(() => r.backend("chatgpt"), /released/);
  assert.throws(() => r.backend("local"));
  assert.throws(() => r.set(choice("chatgpt", "chatgpt")));
  assert.throws(() => r.set(choice("local", "none")));
  assert.throws(() => r.chosen(), /Choose who powers Dum/);
  assert.throws(() => createRegistry([fake("claude"), fake("claude")], released));
});

test("agentChoiceSchema gates the Claude subscription by flavor", () => {
  assert.equal(agentChoiceSchema("public").safeParse(choice("claude", "claude-subscription")).success, false);
  assert.equal(agentChoiceSchema("local").safeParse(choice("claude", "claude-subscription")).success, true);
  assert.equal(agentChoiceSchema("public").safeParse(choice("claude", "anthropic-key")).success, true);
});

test("agentChoiceSchema rejects backend and login mismatches", () => {
  for (const flavor of ["public", "local"] as const) {
    const s = agentChoiceSchema(flavor);
    assert.equal(s.safeParse(choice("local", "none")).success, true);
    assert.equal(s.safeParse(choice("chatgpt", "chatgpt")).success, true);
    assert.equal(s.safeParse(choice("claude", "chatgpt")).success, false);
    assert.equal(s.safeParse(choice("local", "anthropic-key")).success, false);
    assert.equal(s.safeParse(choice("chatgpt", "none")).success, false);
    assert.equal(s.safeParse(choice("copilot", "anthropic-key")).success, false);
    assert.equal(s.safeParse({ ...choice("claude", "anthropic-key"), helper: { backend: "local", model: "small", effort: null } }).success, false);
    assert.equal(s.safeParse({ ...choice("local", "none"), backend: "ollama" }).success, false);
    assert.equal(s.safeParse({ ...choice("local", "none"), fallback: "claude" }).success, false);
  }
});

test("BuildInfoSchema accepts only the two flavors", () => {
  assert.deepEqual(BuildInfoSchema.parse({ flavor: "public" }), { flavor: "public" });
  assert.deepEqual(BuildInfoSchema.parse({ flavor: "local" }), { flavor: "local" });
  for (const v of [{ flavor: "dev" }, { flavor: "" }, {}, { flavor: "local", extra: true }, null, "local"]) {
    assert.equal(BuildInfoSchema.safeParse(v).success, false, JSON.stringify(v));
  }
});

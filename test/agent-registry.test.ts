import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, RELEASED } from "../src/agent/registry.ts";
import { AgentChoiceSchema } from "../src/agent/schema.ts";
import type { AgentBackend, AgentChoice, BackendId } from "../src/agent/types.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-registry-"));
process.env.DUM_CONTEXT = "off";

const fake = (id: BackendId): AgentBackend => ({
  id,
  label: id,
  models: async () => [],
  capabilities: async (selector) => ({ model: selector.model, images: false, noImages: "fake", interrupt: true, runtimeActionCheck: true }),
  open: async () => { throw new Error("fake backends open no sessions"); },
});
const choice = (backend: BackendId, login: AgentChoice["login"]): AgentChoice => ({
  backend,
  login,
  intern: { backend, model: "big", effort: "high" },
  helper: { backend, model: "small", effort: null },
  look: { backend, model: "eyes", effort: "low" },
});
const released = new Set<BackendId>(["claude"]);

test("RELEASED offers only Claude and keeps ChatGPT and Copilot hidden until their gates", () => {
  assert.deepEqual({ ...RELEASED }, { claude: true, chatgpt: false, copilot: false });
});

test("chosen() throws until a choice is set, and clears with null", () => {
  const r = createRegistry([fake("claude")], released);
  assert.throws(() => r.chosen(), /Choose who powers Dum/);
  assert.throws(() => r.selector("intern"), /Choose who powers Dum/);
  r.set(choice("claude", "anthropic-key"));
  assert.equal(r.chosen().backend, "claude");
  r.set(null);
  assert.throws(() => r.chosen(), /Choose who powers Dum/);
});

test("selector() returns the chosen role's selector", () => {
  const r = createRegistry([fake("claude")], released);
  r.set(choice("claude", "anthropic-key"));
  assert.deepEqual(r.selector("intern"), { backend: "claude", model: "big", effort: "high" });
  assert.deepEqual(r.selector("helper"), { backend: "claude", model: "small", effort: null });
  assert.deepEqual(r.selector("look"), { backend: "claude", model: "eyes", effort: "low" });
});

test("unreleased and unregistered backends throw, and are never chosen", () => {
  const r = createRegistry([fake("claude"), fake("chatgpt")], released);
  assert.equal(r.backend("claude").id, "claude");
  assert.throws(() => r.backend("chatgpt"), /released/);
  assert.throws(() => r.backend("copilot"));
  assert.throws(() => r.set(choice("chatgpt", "chatgpt")));
  assert.throws(() => r.set(choice("copilot", "github")));
  assert.throws(() => r.chosen(), /Choose who powers Dum/);
  assert.throws(() => createRegistry([fake("claude"), fake("claude")], released));
});

test("AgentChoiceSchema takes Claude only with an API key: a subscription login no longer parses", () => {
  assert.equal(AgentChoiceSchema.safeParse(choice("claude", "anthropic-key")).success, true);
  assert.equal(AgentChoiceSchema.safeParse({ ...choice("claude", "anthropic-key"), login: "claude-subscription" }).success, false);
});

test("AgentChoiceSchema rejects backend and login mismatches, and needs every role on the backend", () => {
  const s = AgentChoiceSchema;
  assert.equal(s.safeParse(choice("chatgpt", "chatgpt")).success, true);
  assert.equal(s.safeParse(choice("claude", "chatgpt")).success, false);
  assert.equal(s.safeParse(choice("chatgpt", "anthropic-key")).success, false);
  assert.equal(s.safeParse(choice("chatgpt", "github")).success, false);
  assert.equal(s.safeParse(choice("copilot", "anthropic-key")).success, false);
  assert.equal(s.safeParse({ ...choice("claude", "anthropic-key"), helper: { backend: "chatgpt", model: "small", effort: null } }).success, false);
  assert.equal(s.safeParse({ ...choice("claude", "anthropic-key"), look: { backend: "chatgpt", model: "eyes", effort: null } }).success, false);
  const { look: _look, ...noLook } = choice("claude", "anthropic-key");
  assert.equal(s.safeParse(noLook).success, false, "the look role is required");
  assert.equal(s.safeParse({ ...choice("claude", "anthropic-key"), backend: "gemini" }).success, false);
  assert.equal(s.safeParse({ ...choice("claude", "anthropic-key"), fallback: "chatgpt" }).success, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backendRows, buildChoice, helperWarning, modelText, pickEffort, preselectedBackend, preselectedLogin, preselectedSelector, roleModels, UNTESTED,
} from "../src/desktop/ui/agent-picker.ts";
import type { AgentChoice, BackendStatus, ModelOption } from "../src/agent/types.ts";

const status = (over: Partial<BackendStatus> & Pick<BackendStatus, "id">): BackendStatus => ({
  label: over.id, installed: true, methods: [], ready: null, loginRunning: false, loginNeedsCode: false, message: "", ...over,
});
const claude = (over: Partial<BackendStatus> = {}) => status({ id: "claude", methods: ["anthropic-key", "claude-subscription"], ...over });
const local = (over: Partial<BackendStatus> = {}) => status({ id: "local", methods: ["none"], ...over });
const model = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({ id, label: id, efforts: [], images: true, actions: true, verified: false, ...over });

const CLAUDE_MODELS = [
  model("claude-fable-5-1", { efforts: ["low", "medium", "high"], verified: true }),
  model("claude-opus-5-5", { efforts: ["low", "medium", "high"], verified: true }),
  model("claude-other-1", { efforts: ["low"], images: false }),
  model("claude-text-only", { actions: false }),
];

test("public builds never list or treat the Claude subscription as ready", () => {
  const rows = backendRows("public", [claude({ ready: "claude-subscription" })]);
  assert.deepEqual(rows[0]!.methods, ["anthropic-key"]);
  assert.equal(rows[0]!.ready, null);
  assert.equal(preselectedBackend(rows, null), null);
  assert.equal(preselectedLogin(rows[0]!, null), "anthropic-key");
  const subscriptionOnly = backendRows("public", [status({ id: "claude", methods: ["claude-subscription"] })]);
  assert.equal(subscriptionOnly.length, 0);
});

test("local builds offer both Claude methods", () => {
  const rows = backendRows("local", [claude({ ready: "claude-subscription" })]);
  assert.deepEqual(rows[0]!.methods, ["anthropic-key", "claude-subscription"]);
  assert.equal(preselectedLogin(rows[0]!, null), "claude-subscription");
});

test("ready rows sort first and a single ready row is preselected", () => {
  const rows = backendRows("local", [claude(), local({ ready: "none" })]);
  assert.deepEqual(rows.map((r) => r.id), ["local", "claude"]);
  assert.equal(preselectedBackend(rows, null), "local");
});

test("two ready rows preselect nothing unless one was chosen before", () => {
  const rows = backendRows("local", [claude({ ready: "anthropic-key" }), local({ ready: "none" })]);
  assert.equal(preselectedBackend(rows, null), null);
  const chosen: AgentChoice = {
    backend: "local", login: "none",
    intern: { backend: "local", model: "m", effort: null }, helper: { backend: "local", model: "m", effort: null },
  };
  assert.equal(preselectedBackend(rows, chosen), "local");
  assert.equal(preselectedBackend(backendRows("local", [claude()]), null), null);
});

test("the intern list holds only models with function calling; the helper list holds all", () => {
  assert.deepEqual(roleModels(CLAUDE_MODELS, "intern").map((m) => m.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-other-1"]);
  assert.equal(roleModels(CLAUDE_MODELS, "helper").length, CLAUDE_MODELS.length);
});

test("unverified models are labeled untested and verified ones are not", () => {
  assert.equal(modelText(CLAUDE_MODELS[0]!), "claude-fable-5-1");
  assert.equal(modelText(CLAUDE_MODELS[2]!), `claude-other-1 · ${UNTESTED}`);
});

test("a helper without image input carries a warning", () => {
  assert.equal(helperWarning(CLAUDE_MODELS[0]!), "");
  assert.match(helperWarning(CLAUDE_MODELS[2]!), /can't see pictures/);
  assert.equal(helperWarning(null), "");
});

test("efforts come only from what the model advertises", () => {
  assert.equal(pickEffort(CLAUDE_MODELS[0]!, "high"), "high");
  assert.equal(pickEffort(CLAUDE_MODELS[2]!, "high"), "low");
  assert.equal(pickEffort(model("plain"), "high"), null);
});

test("Claude preselects its default intern and helper", () => {
  assert.deepEqual(preselectedSelector("claude", "intern", CLAUDE_MODELS, null), { backend: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(preselectedSelector("claude", "helper", CLAUDE_MODELS, null), { backend: "claude", model: "claude-fable-5-1", effort: "high" });
});

test("a default missing from the live catalog is not preselected", () => {
  assert.equal(preselectedSelector("claude", "intern", [model("claude-other-1")], null), null);
});

test("other backends preselect nothing until chosen, then keep the saved selector", () => {
  const models = [model("qwen", { efforts: ["low", "high"] }), model("llava", { actions: false })];
  assert.equal(preselectedSelector("local", "intern", models, null), null);
  const chosen: AgentChoice = {
    backend: "local", login: "none",
    intern: { backend: "local", model: "qwen", effort: "high" }, helper: { backend: "local", model: "llava", effort: null },
  };
  assert.deepEqual(preselectedSelector("local", "intern", models, chosen), chosen.intern);
  assert.deepEqual(preselectedSelector("local", "helper", models, chosen), chosen.helper);
  // A saved intern that lost function calling isn't offered as the intern.
  assert.equal(preselectedSelector("local", "intern", models, { ...chosen, intern: chosen.helper }), null);
});

test("a choice is complete only with both selectors on the chosen backend", () => {
  const s = { backend: "claude" as const, model: "claude-opus-5-5", effort: "high" };
  assert.equal(buildChoice("claude", null, s, s), null);
  assert.equal(buildChoice("local", "none", s, s), null);
  assert.deepEqual(buildChoice("claude", "anthropic-key", s, s), { backend: "claude", login: "anthropic-key", intern: s, helper: s });
});

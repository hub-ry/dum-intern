import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backendRows, buildChoice, helperWarning, lookWarning, modelText, pickEffort, preselectedBackend, preselectedLogin, preselectedSelector, roleModels, UNTESTED,
} from "../src/desktop/ui/agent-picker.ts";
import type { AgentChoice, BackendStatus, ModelOption } from "../src/agent/types.ts";

const status = (over: Partial<BackendStatus> & Pick<BackendStatus, "id">): BackendStatus => ({
  label: over.id, installed: true, methods: [], ready: null, loginRunning: false, message: "", ...over,
});
const claude = (over: Partial<BackendStatus> = {}) => status({ id: "claude", methods: ["anthropic-key"], ...over });
const model = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({ id, label: id, resolved: id, efforts: [], images: true, actions: true, verified: false, ...over });

const CLAUDE_MODELS = [
  model("claude-fable-5-1", { efforts: ["low", "medium", "high"], verified: true }),
  model("claude-opus-5-5", { efforts: ["low", "medium", "high"], verified: true }),
  model("claude-other-1", { efforts: ["low"], images: false }),
  model("claude-text-only", { actions: false }),
];

test("Claude lists only the API key, and a method the backend doesn't take is never listed or ready", () => {
  const rows = backendRows([status({ id: "claude", methods: ["anthropic-key", "github"], ready: "github" })]);
  assert.deepEqual(rows[0]!.methods, ["anthropic-key"]);
  assert.equal(rows[0]!.ready, null);
  assert.equal(preselectedLogin(rows[0]!, null), "anthropic-key");
  assert.equal(backendRows([status({ id: "claude", methods: ["github"] })]).length, 0);
});

test("an unreleased backend is never offered, even signed in", () => {
  const rows = backendRows([status({ id: "chatgpt", methods: ["chatgpt"], ready: "chatgpt" }), status({ id: "copilot", methods: ["github"] }), claude()]);
  assert.deepEqual(rows.map((r) => r.id), ["claude"]);
});

test("a single ready row is preselected, and a saved backend still listed wins", () => {
  assert.equal(preselectedBackend(backendRows([claude({ ready: "anthropic-key" })]), null), "claude");
  assert.equal(preselectedBackend(backendRows([claude()]), null), null);
  const s = { backend: "claude" as const, model: "opus", effort: "high" };
  const chosen: AgentChoice = { backend: "claude", login: "anthropic-key", intern: s, helper: s, look: s };
  assert.equal(preselectedBackend(backendRows([claude()]), chosen), "claude");
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

test("a default missing from the live catalog is not preselected", () => {
  assert.equal(preselectedSelector("claude", "intern", [model("claude-other-1")], null), null);
});

test("other backends preselect nothing until chosen, then keep the saved selector", () => {
  const models = [model("gpt-a", { efforts: ["low", "high"] }), model("gpt-eyes", { actions: false })];
  assert.equal(preselectedSelector("chatgpt", "intern", models, null), null);
  const chosen: AgentChoice = {
    backend: "chatgpt", login: "chatgpt",
    intern: { backend: "chatgpt", model: "gpt-a", effort: "high" }, helper: { backend: "chatgpt", model: "gpt-eyes", effort: null }, look: { backend: "chatgpt", model: "gpt-eyes", effort: null },
  };
  assert.deepEqual(preselectedSelector("chatgpt", "intern", models, chosen), chosen.intern);
  assert.deepEqual(preselectedSelector("chatgpt", "helper", models, chosen), chosen.helper);
  assert.deepEqual(preselectedSelector("chatgpt", "look", models, chosen), chosen.look);
  // A saved intern that lost function calling isn't offered as the intern.
  assert.equal(preselectedSelector("chatgpt", "intern", models, { ...chosen, intern: chosen.helper }), null);
});

test("the look list holds only image-capable models and labels untested ones", () => {
  const looks = roleModels(CLAUDE_MODELS, "look");
  assert.deepEqual(looks.map((m) => m.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-text-only"]);
  assert.deepEqual(looks.map(modelText), ["claude-fable-5-1", "claude-opus-5-5", `claude-text-only · ${UNTESTED}`]);
});

test("an unverified look model carries a text-only warning", () => {
  assert.match(lookWarning(CLAUDE_MODELS[3]!), /text alone/);
  assert.equal(lookWarning(CLAUDE_MODELS[0]!), "");
  assert.equal(lookWarning(null), "");
});

test("a fresh Claude choice on a catalog shaped like Claude's puts haiku on the look at low effort", () => {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const alias = (id: string, resolved: string) => model(id, { resolved, efforts, verified: true });
  const catalog = [
    alias("default", "claude-opus-5-5"), alias("opus", "claude-opus-5-5"), alias("fable", "claude-fable-5-1"),
    alias("sonnet", "claude-sonnet-5-5"), alias("haiku", "claude-haiku-5-5"),
  ];
  assert.deepEqual(preselectedSelector("claude", "look", catalog, null), { backend: "claude", model: "haiku", effort: "low" });
  assert.deepEqual(preselectedSelector("claude", "intern", catalog, null), { backend: "claude", model: "opus", effort: "high" });
  assert.deepEqual(preselectedSelector("claude", "helper", catalog, null), { backend: "claude", model: "fable", effort: "high" });
  const picks = { intern: preselectedSelector("claude", "intern", catalog, null), helper: preselectedSelector("claude", "helper", catalog, null), look: preselectedSelector("claude", "look", catalog, null) };
  const fresh = buildChoice("claude", preselectedLogin(backendRows([claude()])[0]!, null), picks);
  assert.equal(fresh?.look.model, "haiku");
});

test("a choice is complete only with all three roles on the chosen backend", () => {
  const s = { backend: "claude" as const, model: "claude-opus-5-5", effort: "high" };
  const all = { intern: s, helper: s, look: s };
  assert.equal(buildChoice("claude", null, all), null);
  assert.equal(buildChoice("chatgpt", "chatgpt", all), null);
  assert.equal(buildChoice("claude", "anthropic-key", { ...all, look: null }), null);
  assert.equal(buildChoice("claude", "anthropic-key", { ...all, look: { ...s, backend: "chatgpt" } }), null);
  assert.deepEqual(buildChoice("claude", "anthropic-key", all), { backend: "claude", login: "anthropic-key", intern: s, helper: s, look: s });
});

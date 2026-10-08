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
const local = (over: Partial<BackendStatus> = {}) => status({ id: "local", methods: ["none"], ...over });
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

test("ready rows sort first and a single ready row is preselected", () => {
  const rows = backendRows([claude(), local({ ready: "none" })]);
  assert.deepEqual(rows.map((r) => r.id), ["local", "claude"]);
  assert.equal(preselectedBackend(rows, null), "local");
});

test("two ready rows preselect nothing unless one was chosen before", () => {
  const rows = backendRows([claude({ ready: "anthropic-key" }), local({ ready: "none" })]);
  assert.equal(preselectedBackend(rows, null), null);
  const chosen: AgentChoice = {
    backend: "local", login: "none",
    intern: { backend: "local", model: "m", effort: null }, helper: { backend: "local", model: "m", effort: null }, look: { backend: "local", model: "m", effort: null },
  };
  assert.equal(preselectedBackend(rows, chosen), "local");
  assert.equal(preselectedBackend(backendRows([claude()]), null), null);
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
  const models = [model("qwen", { efforts: ["low", "high"] }), model("llava", { actions: false })];
  assert.equal(preselectedSelector("local", "intern", models, null), null);
  const chosen: AgentChoice = {
    backend: "local", login: "none",
    intern: { backend: "local", model: "qwen", effort: "high" }, helper: { backend: "local", model: "llava", effort: null }, look: { backend: "local", model: "llava", effort: null },
  };
  assert.deepEqual(preselectedSelector("local", "intern", models, chosen), chosen.intern);
  assert.deepEqual(preselectedSelector("local", "helper", models, chosen), chosen.helper);
  assert.deepEqual(preselectedSelector("local", "look", models, chosen), chosen.look);
  // A saved intern that lost function calling isn't offered as the intern.
  assert.equal(preselectedSelector("local", "intern", models, { ...chosen, intern: chosen.helper }), null);
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

test("on a catalog shaped like Claude's, the look preselects haiku at low effort", () => {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const alias = (id: string, resolved: string) => model(id, { resolved, efforts, verified: true });
  const catalog = [
    alias("default", "claude-opus-5-5"), alias("opus", "claude-opus-5-5"), alias("fable", "claude-fable-5-1"),
    alias("sonnet", "claude-sonnet-5-5"), alias("haiku", "claude-haiku-5-5"),
  ];
  assert.deepEqual(preselectedSelector("claude", "look", catalog, null), { backend: "claude", model: "haiku", effort: "low" });
  assert.deepEqual(preselectedSelector("claude", "intern", catalog, null), { backend: "claude", model: "opus", effort: "high" });
  assert.deepEqual(preselectedSelector("claude", "helper", catalog, null), { backend: "claude", model: "fable", effort: "high" });
});

test("a choice is complete only with all three roles on the chosen backend", () => {
  const s = { backend: "claude" as const, model: "claude-opus-5-5", effort: "high" };
  const all = { intern: s, helper: s, look: s };
  assert.equal(buildChoice("claude", null, all), null);
  assert.equal(buildChoice("local", "none", all), null);
  assert.equal(buildChoice("claude", "anthropic-key", { ...all, look: null }), null);
  assert.equal(buildChoice("claude", "anthropic-key", { ...all, look: { ...s, backend: "local" } }), null);
  assert.deepEqual(buildChoice("claude", "anthropic-key", all), { backend: "claude", login: "anthropic-key", intern: s, helper: s, look: s });
});

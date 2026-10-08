// A one-shot call: the user's helper or look model, no actions, one turn, an empty runtime cwd.

import { test } from "node:test";
import assert from "node:assert/strict";
import { oneShot, json } from "../src/oneshot.ts";
import { createRegistry } from "../src/agent/registry.ts";
import type { AgentBackend, AgentEvent, OpenOptions, UserTurn } from "../src/agent/types.ts";

process.env.DUM_CONTEXT = "off";

const PNG = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };

/** A backend that answers with `reply`, recording what it was opened and asked with. */
function fake(reply: (input: UserTurn, o: OpenOptions) => AsyncGenerator<AgentEvent>, images = true) {
  const opened: OpenOptions[] = [];
  const inputs: UserTurn[] = [];
  let closed = 0;
  const backend: AgentBackend = {
    id: "local",
    label: "Fake",
    models: async () => [],
    capabilities: async (selector) => ({
      model: selector.model, images, noImages: images ? "" : `${selector.model} can't see pictures`, interrupt: true, runtimeActionCheck: true,
    }),
    async open(o) {
      opened.push(o);
      return {
        turn: (input) => {
          inputs.push(input);
          return reply(input, o);
        },
        interrupt: async () => {},
        close: () => void closed++,
      };
    },
  };
  const agent = createRegistry([backend], new Set(["local"]));
  agent.set({
    backend: "local",
    login: "none",
    intern: { backend: "local", model: "big-intern", effort: "high" },
    helper: { backend: "local", model: "small-helper", effort: null },
    look: { backend: "local", model: "eyes", effort: null },
  });
  return { agent, opened, inputs, closes: () => closed };
}

test("a one-shot runs on the helper selector with no actions, one turn and the caller's cwd, and nothing else", async () => {
  const f = fake(async function* () {
    yield { type: "model", model: "small-helper", effort: null };
    yield { type: "text", text: "the answer" };
    yield { type: "end", error: null, interrupted: false };
  });
  assert.equal(await oneShot("what is 2 + 2?", { agent: f.agent, role: "helper", cwd: "/tmp/dum/zones/z/runtime" }), "the answer");
  const o = f.opened[0]!;
  assert.deepEqual(o.selector, { backend: "local", model: "small-helper", effort: null });
  assert.deepEqual(o.actions, []);
  assert.equal(o.maxTurns, 1);
  assert.equal(o.cwd, "/tmp/dum/zones/z/runtime");
  assert.deepEqual(Object.keys(o).sort(), ["actions", "cwd", "login", "maxTurns", "selector", "signal", "systemPrompt"], "transport options only");
  assert.equal(o.login, "none");
  assert.match(o.systemPrompt, /no tools, files or web access/);
  assert.deepEqual(f.inputs, [{ text: "what is 2 + 2?" }]);
  assert.equal(f.closes(), 1);
});

test("a one-shot with no choice, a failed turn or an action never falls back", async () => {
  const none = createRegistry([], new Set());
  await assert.rejects(oneShot("x", { agent: none, role: "helper", cwd: "/tmp" }), /Choose who powers Dum/);
  const failed = fake(async function* () { yield { type: "end", error: "rate limited", interrupted: false }; });
  await assert.rejects(oneShot("x", { agent: failed.agent, role: "helper", cwd: "/tmp" }), /^Error: small-helper couldn't answer: rate limited$/);
  assert.equal(failed.closes(), 1);
  const acting = fake(async function* () { yield { type: "action", name: "read_file" }; });
  await assert.rejects(oneShot("x", { agent: acting.agent, role: "helper", cwd: "/tmp" }), /a one-shot call has no actions/);
  const silent = fake(async function* () { yield { type: "end", error: null, interrupted: false }; });
  await assert.rejects(oneShot("x", { agent: silent.agent, role: "helper", cwd: "/tmp" }), /ended without an answer/);
});

test("pictures go only to a helper that can read them", async () => {
  const blind = fake(async function* () { yield { type: "text", text: "never" }; }, false);
  await assert.rejects(oneShot("describe", { agent: blind.agent, role: "helper", cwd: "/tmp", images: [PNG] }), /small-helper can't see pictures - choose a helper model that can see pictures/);
  assert.equal(blind.opened.length, 0, "nothing was opened, so nothing was sent");
  const sighted = fake(async function* () {
    yield { type: "text", text: "a terminal" };
    yield { type: "end", error: null, interrupted: false };
  });
  assert.equal(await oneShot("describe", { agent: sighted.agent, role: "helper", cwd: "/tmp", images: [PNG] }), "a terminal");
  assert.deepEqual(sighted.inputs[0]!.images, [PNG]);
});

test("a live look runs on the look selector, never the helper's", async () => {
  const f = fake(async function* () {
    yield { type: "text", text: "{}" };
    yield { type: "end", error: null, interrupted: false };
  });
  assert.equal(await oneShot("look", { agent: f.agent, role: "look", cwd: "/tmp", images: [PNG] }), "{}");
  assert.deepEqual(f.opened[0]!.selector, { backend: "local", model: "eyes", effort: null });
  const blind = fake(async function* () { yield { type: "text", text: "never" }; }, false);
  await assert.rejects(oneShot("look", { agent: blind.agent, role: "look", cwd: "/tmp", images: [PNG] }), /eyes can't see pictures - choose a look model/);
  assert.equal(blind.opened.length, 0);
});

test("aborting stops the call before it opens and while it waits", async () => {
  const before = new AbortController();
  before.abort();
  const idle = fake(async function* () { yield { type: "text", text: "never" }; });
  await assert.rejects(oneShot("x", { agent: idle.agent, role: "helper", cwd: "/tmp", signal: before.signal }), /^Error: stopped$/);
  assert.equal(idle.opened.length, 0);

  const during = new AbortController();
  const slow = fake(async function* (_input, o) {
    const { promise, resolve } = Promise.withResolvers<void>();
    o.signal.addEventListener("abort", () => resolve(), { once: true });
    during.abort();
    await promise;
    yield { type: "end", error: null, interrupted: true };
  });
  await assert.rejects(oneShot("x", { agent: slow.agent, role: "helper", cwd: "/tmp", signal: during.signal }), /^Error: stopped$/);
  assert.equal(slow.closes(), 1);
});

test("json finds the first value of the asked shape around a fence or a sentence", () => {
  assert.deepEqual(json('Sure:\n```json\n{"a": [1]}\n```', "{"), { a: [1] });
  assert.deepEqual(json("here [1, 2] done", "["), [1, 2]);
  assert.equal(json("no json here", "{"), undefined);
  assert.equal(json("{broken", "{"), undefined);
});

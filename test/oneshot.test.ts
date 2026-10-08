// A one-shot helper call: the user's helper model, no actions, one turn, the zone's runtime cwd.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { oneShot, json } from "../src/oneshot.ts";
import { createRegistry } from "../src/agent/registry.ts";
import type { AgentBackend, AgentEvent, OpenOptions, UserTurn } from "../src/agent/types.ts";
import type { RequestBinding } from "../src/share-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

process.env.DUM_CONTEXT = "off";

const id = randomUUID();
const zone: ZoneContext = { id, revision: 3, breadcrumb: [{ id, name: "Rust" }], goal: "Learn ownership", ancestorGoals: [], language: "rust", focusSkills: [], notes: [] };
const binding: RequestBinding = { zoneId: id, zoneEpoch: "epoch-1", inputToken: "token-1", requestId: "request-1" };
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
    capabilities: () => ({ images, interrupt: true, runtimeActionCheck: true }),
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
  });
  return { agent, opened, inputs, closes: () => closed };
}

test("a one-shot runs on the helper selector with no actions, one turn and the caller's cwd, zone and binding", async () => {
  const f = fake(async function* () {
    yield { type: "model", model: "small-helper", effort: null };
    yield { type: "text", text: "the answer" };
    yield { type: "end", error: null, interrupted: false };
  });
  assert.equal(await oneShot("what is 2 + 2?", { agent: f.agent, cwd: "/tmp/dum/zones/z/runtime", zone, binding }), "the answer");
  const o = f.opened[0]!;
  assert.deepEqual(o.selector, { backend: "local", model: "small-helper", effort: null });
  assert.deepEqual(o.actions, []);
  assert.equal(o.maxTurns, 1);
  assert.equal(o.cwd, "/tmp/dum/zones/z/runtime");
  assert.equal(o.zone, zone);
  assert.equal(o.binding, binding);
  assert.equal(o.login, "none");
  assert.match(o.systemPrompt, /no tools, files or web access/);
  assert.deepEqual(f.inputs, [{ text: "what is 2 + 2?" }]);
  assert.equal(f.closes(), 1);
});

test("a one-shot with no choice, a failed turn or an action never falls back", async () => {
  const none = createRegistry([], new Set());
  await assert.rejects(oneShot("x", { agent: none, cwd: "/tmp", zone, binding }), /Choose who powers Dum/);
  const failed = fake(async function* () { yield { type: "end", error: "rate limited", interrupted: false }; });
  await assert.rejects(oneShot("x", { agent: failed.agent, cwd: "/tmp", zone, binding }), /^Error: small-helper couldn't answer: rate limited$/);
  assert.equal(failed.closes(), 1);
  const acting = fake(async function* () { yield { type: "action", name: "read_file" }; });
  await assert.rejects(oneShot("x", { agent: acting.agent, cwd: "/tmp", zone, binding }), /a one-shot call has no actions/);
  const silent = fake(async function* () { yield { type: "end", error: null, interrupted: false }; });
  await assert.rejects(oneShot("x", { agent: silent.agent, cwd: "/tmp", zone, binding }), /ended without an answer/);
});

test("pictures go only to a helper that can read them", async () => {
  const blind = fake(async function* () { yield { type: "text", text: "never" }; }, false);
  await assert.rejects(oneShot("describe", { agent: blind.agent, cwd: "/tmp", zone, binding, images: [PNG] }), /small-helper can't look at pictures/);
  assert.equal(blind.opened.length, 0, "nothing was opened, so nothing was sent");
  const sighted = fake(async function* () {
    yield { type: "text", text: "a terminal" };
    yield { type: "end", error: null, interrupted: false };
  });
  assert.equal(await oneShot("describe", { agent: sighted.agent, cwd: "/tmp", zone, binding, images: [PNG] }), "a terminal");
  assert.deepEqual(sighted.inputs[0]!.images, [PNG]);
});

test("aborting stops the call before it opens and while it waits", async () => {
  const before = new AbortController();
  before.abort();
  const idle = fake(async function* () { yield { type: "text", text: "never" }; });
  await assert.rejects(oneShot("x", { agent: idle.agent, cwd: "/tmp", zone, binding, signal: before.signal }), /^Error: stopped$/);
  assert.equal(idle.opened.length, 0);

  const during = new AbortController();
  const slow = fake(async function* (_input, o) {
    const { promise, resolve } = Promise.withResolvers<void>();
    o.signal.addEventListener("abort", () => resolve(), { once: true });
    during.abort();
    await promise;
    yield { type: "end", error: null, interrupted: true };
  });
  await assert.rejects(oneShot("x", { agent: slow.agent, cwd: "/tmp", zone, binding, signal: during.signal }), /^Error: stopped$/);
  assert.equal(slow.closes(), 1);
});

test("json finds the first value of the asked shape around a fence or a sentence", () => {
  assert.deepEqual(json('Sure:\n```json\n{"a": [1]}\n```', "{"), { a: [1] });
  assert.deepEqual(json("here [1, 2] done", "["), [1, 2]);
  assert.equal(json("no json here", "{"), undefined);
  assert.equal(json("{broken", "{"), undefined);
});

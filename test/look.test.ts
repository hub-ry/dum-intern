// One look at a picture they chose to share: a real PNG only, the helper model only if it can see,
// a bounded description, and a failed look is a note, never a guess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { decode, look, MAX_IMAGE_BYTES, MAX_OBSERVATION } from "../src/look.ts";
import { Store } from "../src/store.ts";
import { createRegistry } from "../src/agent/registry.ts";
import type { AgentBackend, AgentEvent, UserTurn } from "../src/agent/types.ts";
import type { RequestBinding } from "../src/share-types.ts";
import type { SharedImage } from "../src/store-types.ts";
import type { ZoneContext } from "../src/zone-types.ts";

process.env.DUM_CONTEXT = "off";

const id = randomUUID();
const zone: ZoneContext = { id, revision: 1, breadcrumb: [{ id, name: "Web" }], goal: "Learn CSS grid", ancestorGoals: [], language: "", focusSkills: [], notes: [] };
const binding: RequestBinding = { zoneId: id, zoneEpoch: "epoch-1", inputToken: "token-1", requestId: "request-1" };
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a picture")]);
const picture: SharedImage = { mimeType: "image/png", data: PNG_BYTES.toString("base64"), label: "Terminal - zsh" };

function helper(reply: (input: UserTurn) => AsyncGenerator<AgentEvent>, images = true) {
  const inputs: UserTurn[] = [];
  const backend: AgentBackend = {
    id: "local",
    label: "Fake",
    models: async () => [],
    capabilities: async (selector) => ({
      model: selector.model, images, noImages: images ? "" : `${selector.model} can't see pictures`, interrupt: true, runtimeActionCheck: true,
    }),
    async open() {
      return { turn: (input) => (inputs.push(input), reply(input)), interrupt: async () => {}, close: () => {} };
    },
  };
  const agent = createRegistry([backend], new Set(["local"]));
  agent.set({ backend: "local", login: "none", intern: { backend: "local", model: "m", effort: null }, helper: { backend: "local", model: "eyes", effort: null }, look: { backend: "local", model: "live", effort: null } });
  return { agent, inputs };
}

const says = (text: string) => async function* (): AsyncGenerator<AgentEvent> {
  yield { type: "text", text };
  yield { type: "end", error: null, interrupted: false };
};

test("only a real, bounded PNG is looked at", () => {
  assert.deepEqual(decode(picture), PNG_BYTES);
  assert.throws(() => decode({ ...picture, mimeType: "image/jpeg" as "image/png" }), /only a PNG/);
  assert.throws(() => decode({ ...picture, data: "not base64!" }), /isn't valid base64/);
  assert.throws(() => decode({ ...picture, data: Buffer.from("GIF89a....").toString("base64") }), /isn't a PNG/);
  assert.throws(() => decode({ ...picture, data: Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89).toString("base64") }), /must be under 3 MB/);
});

test("the look sends the picture once to the helper model and returns a bounded description and its digest", async () => {
  const h = helper(says(`a terminal — ${"x".repeat(MAX_OBSERVATION + 50)}`));
  const seen = await look(picture, "why does this fail?", { agent: h.agent, cwd: "/tmp", zone, binding });
  assert.equal(seen.sha, createHash("sha256").update(PNG_BYTES).digest("hex"));
  assert.equal(seen.observation.length, MAX_OBSERVATION + 1);
  assert.ok(seen.observation.startsWith("a terminal - x"), "dashes are plain");
  assert.ok(seen.observation.endsWith("…"));
  assert.deepEqual(h.inputs[0]!.images, [{ mimeType: "image/png", data: picture.data }]);
  assert.match(h.inputs[0]!.text, /"Terminal - zsh"/);
  assert.match(h.inputs[0]!.text, /"why does this fail\?"/);
});

test("a helper that can't read pictures refuses the look", async () => {
  const h = helper(says("never"), false);
  await assert.rejects(look(picture, "", { agent: h.agent, cwd: "/tmp", zone, binding }), /eyes can't see pictures - choose a helper model that can see pictures/);
  assert.equal(h.inputs.length, 0);
});

test("a failed look becomes a note, and nothing it might have seen is kept", async () => {
  const h = helper(async function* () { yield { type: "end", error: "the model is overloaded", interrupted: false }; });
  const s = new Store({ id, name: "Web" }, "understand");
  s.onAttach = async (image, note) => {
    const seen = await look(image, note, { agent: h.agent, cwd: "/tmp", zone, binding });
    s.shot(image.label, seen.observation, seen.sha);
  };
  const next = s.askNext();
  assert.equal(await s.attach(picture, "what's wrong?"), false);
  const t = s.getSnapshot().transcript;
  assert.ok(t.some((e) => e.kind === "note" && /:look didn't work: eyes couldn't answer: the model is overloaded/.test(e.text)));
  assert.ok(!t.some((e) => e.kind === "shot"));
  s.close();
  await assert.rejects(next);
});

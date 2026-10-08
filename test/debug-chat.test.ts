import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { join, relative } from "node:path";
import { createRegistry } from "../src/agent/registry.ts";
import { loopSession } from "../src/agent/loop.ts";
import type { AgentBackend, AgentChoice, ModelClient, OpenOptions, WireMessage } from "../src/agent/types.ts";
import { DebugChat, redact } from "../src/debug-chat.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { DIAGNOSTIC_LIMITS, DebugViewSchema, type DebugView, type DiagnosticSettings, type MainStatus } from "../src/diagnostic-types.ts";

const home = mkdtempSync(join(tmpdir(), "dum-debug-"));
process.env.DUM_HOME = home;
process.env.DUM_CONTEXT = "off";

const main: MainStatus = {
  version: "1.2.3", platform: "darwin", backends: [{ id: "local", installed: true, ready: "none" }], screenPermission: "granted",
  lookPaused: false, voice: { supported: true, available: true, bridge: true }, shortcuts: { open: null, voice: null, sendDraft: null },
};
const settings: DiagnosticSettings = {
  launchAtLogin: false, personalContext: false, look: { apps: true, screen: true }, mode: "understand",
  hotkey: "Alt+Space", voiceHotkey: "Alt+V", sendDraftHotkey: "Alt+Enter",
};
const selector = { backend: "local", model: "m", effort: null } as const;
const choice: AgentChoice = { backend: "local", login: "none", intern: selector, helper: selector, look: selector };

type Step = { text?: string; call?: { name: string; args: unknown } } | "hang";

/** A scripted model behind the real action loop: Dum's real name checks and dispatch run. */
function harness(script: () => Step[]) {
  const seen = { opens: [] as OpenOptions[], requests: [] as { system: string; history: WireMessage[]; actions: string[] }[] };
  const backend: AgentBackend = {
    id: "local",
    label: "Scripted",
    async models() { return []; },
    async capabilities() { throw new Error("unused"); },
    async open(o) {
      seen.opens.push(o);
      const steps = script();
      let n = 0;
      const client: ModelClient = {
        async step(req) {
          seen.requests.push({ system: req.system, history: structuredClone([...req.history]), actions: req.actions.map((a) => a.name) });
          const s = steps[n++] ?? { text: "done" };
          if (s === "hang") {
            const hung = Promise.withResolvers<never>();
            req.signal.addEventListener("abort", () => hung.reject(req.signal.reason), { once: true });
            return hung.promise;
          }
          return { text: s.text ?? "", calls: s.call ? [{ id: `c${n}`, name: s.call.name, arguments: JSON.stringify(s.call.args) }] : [], error: null };
        },
      };
      return loopSession(client, o);
    },
  };
  const agent = createRegistry([backend], new Set(["local"]));
  agent.set(choice);
  const diagnostics = new Diagnostics(Date.now, main, settings);
  const runtime = join(home, "debug", "runtime");
  mkdirSync(runtime, { recursive: true });
  let changes = 0;
  const chat = new DebugChat(agent, diagnostics, runtime, () => { changes++; });
  return { chat, agent, diagnostics, seen, runtime, changes: () => changes };
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        out[`${relative(dir, p)}/`] = "dir";
        walk(p);
      } else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function fixture(): void {
  const files: Record<string, string> = {
    "zones/z1/zone.json": '{"id":"z1","name":"Zone"}',
    "zones/z1/draft.json": '{"text":"canonical zone draft","request":"r-zone"}',
    "zones/z1/directions/d1.json": '{"direction":"x"}',
    "zones/z1/handoffs/h1.json": '{"handoff":"y","version":1}',
    "zones/z1/corrections.json": "[]",
    "zones/z1/memory.json": '{"notes":["n"]}',
    "zones/z1/transcript.jsonl": '{"from":"you","text":"hi"}\n',
    "evidence/e1.json": '{"skill":"s"}',
    "skills/tree.json": '{"skills":[]}',
    "settings.json": '{"mode":"understand"}',
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(home, p, ".."), { recursive: true });
    writeFileSync(join(home, p), text);
  }
}

const last = (v: DebugView) => v.entries.at(-1)!;

test("legit no-zone status and reference reads answer through the intern selector, transport-only, with only three actions", async () => {
  const h = harness(() => [
    { call: { name: "diagnostic_status", args: {} } },
    { call: { name: "diagnostic_events", args: { limit: 10 } } },
    { call: { name: "diagnostic_reference", args: { topic: "models" } } },
    { text: "The look model is m on local." },
  ]);
  const view = h.chat.open();
  DebugViewSchema.parse(view);
  assert.equal(view.state, "idle");
  await h.chat.send(view.binding, "which look model is running?");
  const after = h.chat.view();
  assert.deepEqual(after.entries.map((e) => e.from), ["you", "dum"]);
  assert.equal(last(after).text, "The look model is m on local.");
  assert.notDeepEqual(after.binding.requestId, view.binding.requestId);
  assert.equal(after.binding.debugSessionId, view.binding.debugSessionId);
  const o = h.seen.opens[0]!;
  assert.deepEqual(Object.keys(o).sort(), ["actions", "cwd", "login", "maxTurns", "selector", "signal", "systemPrompt"]);
  assert.equal(o.cwd, h.runtime);
  assert.deepEqual(o.selector, choice.intern);
  assert.equal(o.maxTurns, DIAGNOSTIC_LIMITS.debugRounds);
  assert.deepEqual(h.seen.requests[0]!.actions, ["diagnostic_status", "diagnostic_events", "diagnostic_reference"]);
  const statusResult = h.seen.requests[1]!.history.at(-1) as Extract<WireMessage, { role: "tool" }>;
  assert.equal(JSON.parse(statusResult.text).main.version, "1.2.3");
  assert.equal(statusResult.isError, false);
});

test("read-only regression: every write or foreign action is refused, and no state changes", async () => {
  fixture();
  const forbidden = [
    "change", "remember", "skill-edit", "skill_edit", "settings", "follow-add", "follow_add", "read_file", "decision_help",
    "alignment_accept", "alignment-step", "handoff_run", "handoff_review", "handoff_edit", "shell", "Bash", "report_context", "unknown_thing",
  ];
  let next = "";
  const h = harness(() => [{ call: { name: next, args: { text: "x", path: "../../settings.json", command: "rm -rf ~" } } }]);
  const before = hashTree(home);
  for (const name of forbidden) {
    next = name;
    const view = h.chat.view();
    await h.chat.send(view.binding, `please run ${name}`);
    const reply = last(h.chat.view());
    assert.equal(reply.from, "notice", name);
    assert.match(reply.text, /refused an action outside its three diagnostic reads/, name);
  }
  assert.deepEqual(hashTree(home), before, "zones, directions, handoffs, corrections, memory, transcript, evidence, skills and settings unchanged");
  assert.deepEqual(readdirSync(h.runtime), [], "nothing written even in the debug runtime");
  assert.equal(readFileSync(join(home, "zones/z1/draft.json"), "utf8"), '{"text":"canonical zone draft","request":"r-zone"}');
  for (const o of h.seen.opens) assert.deepEqual(o.actions.map((a) => a.name), ["diagnostic_status", "diagnostic_events", "diagnostic_reference"]);
});

test("redaction: a pasted key never reaches the model, the view or the reply; provider text never surfaces", async () => {
  const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx";
  const h = harness(() => [{ text: `Your key is ${key} and Authorization: Bearer abcdefghijklmnop1234` }]);
  assert.throws(() => h.diagnostics.record({ kind: "call-end", role: "debug", requestId: null, checkId: null, outcome: "failed", reason: "provider", latencyMs: null, httpStatus: null, body: `{"error":"${key}"}` } as never));
  await h.chat.send(h.chat.view().binding, `my key is ${key}, and password=hunter2hunter2 — why does Claude fail?`);
  const sent = JSON.stringify(h.seen.requests);
  const shown = JSON.stringify(h.chat.view());
  for (const out of [sent, shown]) {
    assert.doesNotMatch(out, /AbCdEfGh|hunter2|abcdefghijklmnop1234/);
  }
  assert.match(shown, /\[redacted\]/);
  assert.equal(redact("ghp_0123456789abcdefghijABCDEFGHIJ"), "[redacted]");
  assert.equal(redact("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig"), "token: [redacted]");

  const failing = harness(() => []);
  const backend = failing.agent.backend("local");
  backend.open = async () => { throw new Error(`401 {"error":{"message":"invalid x-api-key ${key}"}}`); };
  await failing.chat.send(failing.chat.view().binding, "hi");
  assert.doesNotMatch(JSON.stringify(failing.chat.view()), /401|x-api-key|AbCdEf/);
  assert.match(last(failing.chat.view()).text, /couldn't start a verified session/);
});

test("stale, reset and foreign bindings are refused; Stop aborts only its own flight", async () => {
  const h = harness(() => ["hang"]);
  const first = h.chat.view();
  const reset = h.chat.reset();
  assert.notEqual(reset.binding.debugSessionId, first.binding.debugSessionId);
  await assert.rejects(h.chat.send(first.binding, "hi"), /stale/);
  await assert.rejects(h.chat.send({ zoneId: "z1", zoneEpoch: "e", inputToken: "t", requestId: "r" } as never, "hi"));
  const sending = h.chat.send(reset.binding, "hang please");
  const busy = h.chat.view();
  assert.equal(busy.state, "busy");
  assert.deepEqual(busy.binding, reset.binding);
  await assert.rejects(h.chat.send(busy.binding, "again"), /stale|already/);
  await assert.rejects(h.chat.stop({ ...busy.binding, requestId: "other" }), /isn't running/);
  assert.equal(h.chat.view().state, "busy", "a wrong binding cancels nothing");
  await h.chat.stop(busy.binding);
  await sending;
  const stopped = h.chat.view();
  assert.equal(stopped.state, "idle");
  assert.equal(last(stopped).text, "Stopped.");
  await assert.rejects(h.chat.stop(busy.binding), /isn't running/);
});

test("a debug flight times out after 45 seconds", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const h = harness(() => ["hang"]);
  const sending = h.chat.send(h.chat.view().binding, "hang");
  await setImmediate();
  mock.timers.tick(DIAGNOSTIC_LIMITS.debugMs);
  await sending;
  assert.match(last(h.chat.view()).text, /timed out after 45 seconds/);
});

test("idle 30 minutes expires the session; New starts a fresh one", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const h = harness(() => []);
  const view = h.chat.open();
  const before = h.changes();
  mock.timers.tick(DIAGNOSTIC_LIMITS.debugIdleMs);
  assert.ok(h.changes() > before, "expiry is published");
  const expired = h.chat.view();
  assert.equal(expired.state, "expired");
  assert.equal(h.chat.open().state, "expired");
  await assert.rejects(h.chat.send(view.binding, "hi"), /expired/);
  const fresh = h.chat.reset();
  assert.equal(fresh.state, "idle");
  assert.notEqual(fresh.binding.debugSessionId, view.binding.debugSessionId);
});

test("missing backend asks for Agent setup without sending or recording the draft", async () => {
  const h = harness(() => []);
  h.agent.set(null);
  const view = h.chat.view();
  await h.chat.send(view.binding, "why?");
  const after = h.chat.view();
  assert.equal(after.state, "needs-backend");
  assert.deepEqual(after.entries, []);
  assert.equal(h.seen.opens.length, 0);
});

test("history is bounded with a dropped count, and close invalidates the binding", async () => {
  const big = "x ".repeat(3000);
  const h = harness(() => [{ text: big }]);
  for (let i = 0; i < 60; i++) await h.chat.send(h.chat.view().binding, `q${i} ${big}`);
  const view = h.chat.view();
  DebugViewSchema.parse(view);
  assert.ok(view.entries.length <= DIAGNOSTIC_LIMITS.debugEntries);
  assert.ok(view.dropped > 0);
  await h.chat.close();
  await assert.rejects(h.chat.send(view.binding, "hi"), /stale/);
  assert.deepEqual(h.chat.view().entries, []);
});

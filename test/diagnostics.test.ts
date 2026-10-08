import { test } from "node:test";
import assert from "node:assert/strict";
import { Diagnostics, diagnosticActions } from "../src/diagnostics.ts";
import { DIAGNOSTIC_LIMITS, DiagnosticStatusSchema, type DiagnosticSettings, type MainStatus } from "../src/diagnostic-types.ts";

process.env.DUM_CONTEXT = "off";

const main: MainStatus = {
  version: "1.2.3",
  platform: "darwin",
  backends: [{ id: "claude", installed: true, ready: "anthropic-key" }],
  screenPermission: "granted",
  lookPaused: false,
  voice: { supported: true, available: true, bridge: true },
  shortcuts: { open: null, voice: "conflict", sendDraft: null },
};
const settings: DiagnosticSettings = {
  launchAtLogin: false, personalContext: true, look: { apps: true, screen: false }, mode: "understand",
  hotkey: "Alt+Space", voiceHotkey: "Alt+V", sendDraftHotkey: "Alt+Enter",
};
const call = { role: "intern", requestId: "r1", checkId: null, latencyMs: null, httpStatus: null } as const;

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("status is sanitized, schema-valid and counts calls per role", () => {
  const c = clock();
  const d = new Diagnostics(c.now, main, settings);
  d.record({ kind: "call-start", ...call, outcome: "started", reason: "none" });
  d.record({ kind: "call-end", ...call, outcome: "ok", reason: "none", latencyMs: 820 });
  d.record({ kind: "call-start", ...call, outcome: "started", reason: "none" });
  d.record({ kind: "call-end", ...call, outcome: "failed", reason: "timeout", latencyMs: 45000 });
  d.record({ kind: "call-end", ...call, role: "look", outcome: "failed", reason: "network", httpStatus: 503 });
  const s = d.status();
  DiagnosticStatusSchema.parse(s);
  assert.deepEqual(s.calls.intern, { started: 2, ok: 1, failed: 0, timedOut: 1, lastLatencyMs: 45000, inputTokens: null, outputTokens: null });
  assert.equal(s.calls.look.failed, 1);
  assert.deepEqual([s.ring.events, s.ring.oldestSeq, s.ring.newestSeq], [5, 1, 5]);
  assert.equal(s.main.shortcuts.voice, "conflict");
  s.main.version = "mutated";
  assert.equal(d.status().main.version, "1.2.3", "status is a copy");
});

test("the ring keeps the newest 500 events and 30 minutes, with monotonic sequence and explicit expiry", () => {
  const c = clock();
  const d = new Diagnostics(c.now, main, settings);
  for (let i = 0; i < 520; i++) d.record({ kind: "host", role: null, requestId: null, checkId: null, outcome: "ok", reason: "host-start", latencyMs: null, httpStatus: null });
  let s = d.status();
  assert.deepEqual([s.ring.events, s.ring.oldestSeq, s.ring.newestSeq], [500, 21, 520]);
  assert.ok(s.ring.bytes <= DIAGNOSTIC_LIMITS.ringBytes);
  assert.equal(d.events({ limit: 1 }).expiredBefore, 21);
  c.t += DIAGNOSTIC_LIMITS.ringMs + 1;
  s = d.status();
  assert.equal(s.ring.events, 0);
  d.record({ kind: "host", role: null, requestId: null, checkId: null, outcome: "ok", reason: "none", latencyMs: null, httpStatus: null });
  const page = d.events({ limit: 50 });
  assert.deepEqual(page.events.map((e) => e.seq), [521], "sequence never restarts");
  assert.equal(page.expiredBefore, 521);
});

test("events page newest first under a cursor, filtered by kind, at most 50", () => {
  const d = new Diagnostics(clock().now, main, settings);
  for (let i = 0; i < 120; i++) d.record({ kind: i % 2 ? "call-start" : "look-decision", role: i % 2 ? "intern" : "look", requestId: null, checkId: null, outcome: i % 2 ? "started" : "skipped", reason: i % 2 ? "none" : "unchanged", latencyMs: null, httpStatus: null });
  const first = d.events({ limit: 50 });
  assert.equal(first.events.length, 50);
  assert.equal(first.events[0]!.seq, 120);
  assert.equal(first.nextBeforeSeq, 71);
  const next = d.events({ limit: 50, beforeSeq: first.nextBeforeSeq! });
  assert.equal(next.events[0]!.seq, 70);
  const looks = d.events({ limit: 50, kinds: ["look-decision"] });
  assert.ok(looks.events.every((e) => e.kind === "look-decision"));
  assert.equal(d.events({ limit: 50, beforeSeq: 2 }).nextBeforeSeq, null);
  assert.throws(() => d.events({ limit: 51 }));
});

test("redaction by structure: free-form fields can't enter the ring or status", () => {
  const d = new Diagnostics(clock().now, main, settings);
  const key = "sk-ant-api03-SECRETSECRETSECRET";
  const leaky = { kind: "call-end", ...call, outcome: "failed", reason: "provider", detail: `401 {"error":"bad key ${key}"}` };
  assert.throws(() => d.record(leaky as never));
  assert.throws(() => d.record({ ...call, kind: "call-end", outcome: "failed", reason: key as never }));
  assert.throws(() => d.record({ ...call, kind: "call-end", outcome: "failed", reason: "provider", requestId: `Bearer ${key}` }));
  assert.throws(() => d.main([{ kind: "backend", role: null, requestId: "r", checkId: null, outcome: "ok", reason: "none", latencyMs: null, httpStatus: null }], null), "main reports no requests");
  assert.throws(() => d.main([], { ...main, email: "me@example.com" } as never));
  assert.throws(() => d.settings({ ...settings, apiKey: key } as never));
  assert.throws(() => d.settings({ ...settings, hotkey: "/Users/me/.ssh/id_rsa key" }));
  assert.throws(() => d.models({ intern: { chosen: null, resolved: key + " with spaces" }, helper: { chosen: null, resolved: null }, look: { chosen: null, resolved: null } }));
  d.main([{ kind: "settings", role: null, requestId: null, checkId: null, outcome: "ok", reason: "settings-change", latencyMs: null, httpStatus: null }], { ...main, lookPaused: true });
  const out = JSON.stringify([d.status(), d.events({ limit: 50 })]);
  assert.doesNotMatch(out, /SECRET|example\.com|\.ssh/);
  assert.equal(d.status().main.lookPaused, true);
});

test("actions are exactly the three reads, strict, bounded", async () => {
  const d = new Diagnostics(clock().now, main, settings);
  const actions = diagnosticActions(d);
  assert.deepEqual(actions.map((a) => a.name), ["diagnostic_status", "diagnostic_events", "diagnostic_reference"]);
  const [status, events, reference] = actions;
  const signal = new AbortController().signal;
  assert.equal(JSON.parse((await status!.call({}, signal)).text).main.version, "1.2.3");
  assert.equal((await status!.call({ path: "/etc/passwd" }, signal)).isError, true);
  assert.deepEqual(JSON.parse((await events!.call({ limit: 5 }, signal)).text), { events: [], nextBeforeSeq: null, expiredBefore: null });
  assert.equal((await events!.call({ limit: 500 }, signal)).isError, true);
  assert.equal((await reference!.call({ topic: "../../etc" }, signal)).isError, true);
  assert.equal((await reference!.call({ topic: "look", url: "https://x" }, signal)).isError, true);
  for (const topic of ["look", "models", "status", "voice", "storage", "shortcuts"] as const) {
    const text = (await reference!.call({ topic }, signal)).text;
    assert.ok(text.length > 0 && new TextEncoder().encode(text).length <= DIAGNOSTIC_LIMITS.referenceBytes);
    assert.doesNotMatch(text, /https?:|\/Users\//);
  }
});

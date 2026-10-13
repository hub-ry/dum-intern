// Context caps: a goal's own context holds MAX_GOAL_CONTEXT characters, the root context the smaller
// MAX_GLOBAL_CONTEXT, through the store, across a restart and over HTTP the way dum_set_context and
// /dum context reach it. A refusal says how long the text was so the writer knows how much to cut.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkshopError, WorkshopStore } from "./runtime.ts";
import { startWorkshopServer } from "./server.ts";
import { MAX_GLOBAL_CONTEXT, MAX_GOAL_CONTEXT } from "./validate.ts";

const AMBITION = "Pass every class this semester.";

function refusedFor(length: number, max: number): (err: unknown) => boolean {
  return (err) =>
    err instanceof WorkshopError &&
    err.status === 400 &&
    err.message.includes(length.toLocaleString("en-US")) &&
    err.message.includes(max.toLocaleString("en-US"));
}

test("the goal cap is larger than the root cap", () => {
  assert.equal(MAX_GOAL_CONTEXT, 48_000);
  assert.equal(MAX_GLOBAL_CONTEXT, 24_000);
});

test("a goal context fills to its cap, survives a restart, and one more character is refused with both sizes", () => {
  const home = mkdtempSync(join(tmpdir(), "dum-context-limits-"));
  try {
    const store = new WorkshopStore(home);
    const goal = store.createGoal({ title: "gpa", ambition: AMBITION });
    const full = "g".repeat(MAX_GOAL_CONTEXT);
    store.updateGoal(goal.id, { context: full });
    assert.throws(() => store.updateGoal(goal.id, { context: `${full}!` }), refusedFor(MAX_GOAL_CONTEXT + 1, MAX_GOAL_CONTEXT));
    assert.equal(store.getGoal(goal.id).baseContext, full);

    store.updateGlobalContext("r".repeat(MAX_GLOBAL_CONTEXT));
    assert.throws(() => store.updateGlobalContext("r".repeat(MAX_GLOBAL_CONTEXT + 1)), refusedFor(MAX_GLOBAL_CONTEXT + 1, MAX_GLOBAL_CONTEXT));
    store.close();

    // Persisted state is validated on load with the same caps.
    const again = new WorkshopStore(home);
    assert.equal(again.getGoal(goal.id).baseContext.length, MAX_GOAL_CONTEXT);
    assert.equal(again.getGlobalContext().baseContext.length, MAX_GLOBAL_CONTEXT);
    again.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => createServer());
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok))));
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
  return ports;
}

test("over HTTP, as Dum's client calls it, a goal context of the full cap is accepted and a longer one gets a 400 that says why, not a 413", async () => {
  const home = mkdtempSync(join(tmpdir(), "dum-context-limits-http-"));
  const [port, artifactPort] = await freePorts(2);
  const token = "context-limits-test-token";
  const ws = await startWorkshopServer({ host: "127.0.0.1", port: port!, artifactPort: artifactPort!, home, token });
  const api = async (method: string, path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const created = await api("POST", "/api/goals", { title: "gpa", ambition: AMBITION });
    assert.equal(created.status, 201);
    const id = (created.json.goal as { id: string }).id;

    // Multi-byte text, so the body limit is checked against characters and not bytes.
    const full = "é".repeat(MAX_GOAL_CONTEXT);
    const saved = await api("PUT", `/api/goals/${id}/context`, { context: full });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.baseContext, full);

    const over = await api("PUT", `/api/goals/${id}/context`, { context: `${full}é` });
    assert.equal(over.status, 400);
    assert.match(String(over.json.error), /goal context is 48,001 characters; the limit is 48,000/);

    const root = await api("PUT", "/api/context", { context: "r".repeat(MAX_GLOBAL_CONTEXT + 1) });
    assert.equal(root.status, 400);
    assert.match(String(root.json.error), /root context is 24,001 characters; the limit is 24,000/);
  } finally {
    await ws.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

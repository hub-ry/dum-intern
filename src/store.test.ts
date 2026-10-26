import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderSkill, zipStore } from "./skilldoc.ts";
import { Store } from "./store.ts";
import type { Teaching } from "./types.ts";

async function tempStore(): Promise<{ store: Store; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dum-intern-"));
  return { store: new Store(dir), dir };
}

test("unlock persists and mirrors a markdown file", async () => {
  const { store, dir } = await tempStore();
  const node = store.node("terminal-basics");
  assert.ok(node);
  const teaching: Teaching = {
    nodeId: node.id,
    phase: "ready",
    explanation: "I type pwd to see the folder, then ls to list files.",
    questionsAsked: 1,
    pendingQuestion: null,
    organized: null,
    transcript: [
      { role: "intern", text: "What do you type?" },
      { role: "user", text: "I type pwd." },
    ],
  };
  const notes = renderSkill(node, teaching, new Date("2026-10-25T00:00:00Z"));
  assert.match(notes, /I type pwd to see the folder/);
  assert.match(notes, /I type pwd\./);
  store.unlock(node.id, notes);
  store.close();

  const again = new Store(dir);
  assert.equal(again.node("terminal-basics")?.status, "unlocked");
  assert.match(again.skillFile("terminal-basics") ?? "", /I type pwd to see the folder/);
  const zip = zipStore(again.exportZipFiles());
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  assert.ok(zip.includes(Buffer.from("terminal-basics.md")));
  assert.ok(zip.includes(Buffer.from("I type pwd to see the folder")));
  again.close();
  await rm(dir, { recursive: true, force: true });
});

test("proposed nodes can be dismissed and seed nodes cannot", async () => {
  const { store, dir } = await tempStore();
  const proposed = store.propose({
    id: "virtual-environments",
    title: "Virtual environments",
    summary: "One project, one set of packages.",
    reason: "I won't create a venv until you teach it.",
    prereqs: ["python-scripts"],
    keywords: ["venv"],
  });
  assert.equal(proposed.status, "proposed");
  assert.equal(store.propose({
    id: proposed.id,
    title: proposed.title,
    summary: proposed.summary,
    reason: proposed.reason ?? "",
    prereqs: proposed.prereqs,
    keywords: ["venv"],
  }).id, "virtual-environments");
  assert.equal(store.dismiss("terminal-basics"), false);
  assert.equal(store.dismiss("virtual-environments"), true);
  assert.equal(store.node("virtual-environments"), null);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

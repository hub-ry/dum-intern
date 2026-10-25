import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { Intern } from "./intern.ts";
import { startServer, type Running } from "./server.ts";
import { Store } from "./store.ts";

const EXPLAIN = "A terminal is a text window where I type commands. I use it to see files and move around the computer before I open an editor.";
const ANSWER = "I type pwd and it prints the folder I am in, like /home/desk.";

async function boot(): Promise<{ running: Running; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dum-intern-http-"));
  const running = await startServer(loadConfig({
    DUM_STATE: dir,
    DUM_PACE_MS: "0",
    PORT: "0",
    HOST: "127.0.0.1",
  }));
  return { running, dir };
}

test("mock mode teaches a node, refuses a locked skill, and runs an allowed task", async () => {
  const { running, dir } = await boot();
  try {
    const health = await fetch(`${running.url}/api/health`);
    assert.equal((await health.json()).mode, "mock");
    const state = await (await fetch(`${running.url}/api/state`)).json();
    assert.equal(state.mode, "mock");
    assert.ok(state.nodes.length >= 10 && state.nodes.length <= 15);
    assert.ok(state.nodes.every((node: { status: string }) => node.status === "locked"));

    const started = await postJson(running.url, "/api/teach", { nodeId: "terminal-basics" });
    assert.equal(started.teaching.phase, "explain");
    assert.match(started.messages.at(-1).text, /Explain it in your own words/);

    const explained = await postSse(running.url, "/api/chat", { text: EXPLAIN });
    assert.ok(explained.teaching);
    assert.equal(explained.teaching.phase, "clarify");
    assert.match(explained.messages.map((message) => message.text).join("\n"), /folder/);

    const answered = await postSse(running.url, "/api/chat", { text: ANSWER });
    assert.ok(answered.teaching);
    assert.equal(answered.teaching.phase, "ready");

    const saved = await postJson(running.url, "/api/teach/save", {});
    assert.equal(saved.teaching, null);
    assert.equal(saved.nodes.find((node: { id: string }) => node.id === "terminal-basics").status, "unlocked");
    const notes = await (await fetch(`${running.url}/api/skills/terminal-basics.md`)).text();
    assert.match(notes, /text window where I type commands/);
    assert.match(notes, /I type pwd/);

    const blocked = await postSse(running.url, "/api/chat", { text: "create a git branch called feature" });
    const blockedText = blocked.messages.map((message) => message.text).join("\n");
    assert.match(blockedText, /The missing node is Git branching/);
    assert.ok(blocked.desktop);
    assert.equal(blocked.desktop.terminal.some((line: { stream: string; text: string }) => line.stream === "in" && /git/.test(line.text)), false);

    const allowed = await postSse(running.url, "/api/chat", { text: "list the files in the home directory" });
    const allowedText = allowed.messages.map((message) => message.text).join("\n");
    assert.match(allowedText, /Terminal basics/);
    assert.doesNotMatch(allowedText, /missing node/i);
    assert.ok(allowed.desktop);
    assert.ok(allowed.desktop.terminal.some((line: { stream: string; text: string }) => line.stream === "in" && line.text.includes("ls -la")));

    const zip = Buffer.from(await (await fetch(`${running.url}/api/export.zip`)).arrayBuffer());
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    assert.ok(zip.includes("terminal-basics.md"));
  } finally {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a taught python task proposes a new node and will not use it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dum-intern-propose-"));
  const store = new Store(dir);
  try {
    for (const id of ["terminal-basics", "files-and-paths", "python-scripts"]) {
      store.unlock(id, `# ${id}\n\nI taught this with enough of my own words to count.`);
    }
    const intern = new Intern(store, loadConfig({ DUM_PACE_MS: "0" }), null, null);
    const first = await collect(intern, "write a python script that prints hello");
    assert.match(first.text, /python3 task\.py|Python scripts/);
    assert.match(first.text, /Virtual environments/);
    assert.equal(store.node("virtual-environments")?.status, "proposed");
    assert.equal(first.commands.some((command) => /venv|pip install/.test(command)), false);

    const second = await collect(intern, "create a venv for this project");
    assert.match(second.text, /The missing node is Virtual environments \(proposed\)/);
    assert.equal(second.commands.some((command) => /venv/.test(command)), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function collect(intern: Intern, text: string) {
  const messages: string[] = [];
  let commands: string[] = [];
  await intern.chat(text, (event, data) => {
    const payload = data as { message?: { text: string }; desktop?: { terminal: { stream: string; text: string }[] } };
    if (event === "message" && payload.message) messages.push(payload.message.text);
    if (event === "desktop" && payload.desktop) {
      commands = payload.desktop.terminal.filter((line) => line.stream === "in").map((line) => line.text);
    }
  });
  return { text: messages.join("\n"), commands };
}

async function postJson(url: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function postSse(url: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, true, await response.clone().text());
  const events = parseSse(await response.text());
  const messages: { text: string }[] = [];
  let teaching: { phase?: string } | null = null;
  let desktop: { terminal: { stream: string; text: string }[] } | null = null;
  for (const event of events) {
    if (event.event === "message") messages.push(event.data.message);
    if (event.event === "teaching") teaching = event.data.teaching;
    if (event.event === "desktop") desktop = event.data.desktop;
  }
  return { messages, teaching, desktop };
}

function parseSse(text: string): { event: string; data: any }[] {
  const out = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

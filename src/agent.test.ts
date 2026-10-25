import assert from "node:assert/strict";
import { test } from "node:test";
import { runTask } from "./agent.ts";
import { chatCompletionsUrl } from "./config.ts";
import { createLlm, type Llm, type LlmTurn } from "./llm.ts";
import { assertDeskPath, createMaritime, OPEN_DESKTOP, visibleCommand } from "./maritime.ts";
import { seedNodes } from "./seed.ts";
import type { Computer, SkillNode } from "./types.ts";

class RecordingComputer implements Computer {
  runs: string[] = [];
  async run(command: string) {
    this.runs.push(command);
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }
  async writeFile() {}
  async readFile() { return ""; }
  async listDir() { return []; }
}

function scripted(turns: LlmTurn[]): Llm {
  const queue = [...turns];
  return {
    async chat() {
      const next = queue.shift();
      if (!next) return { content: "done", toolCalls: [] };
      return next;
    },
  };
}

function unlock(ids: string[]): SkillNode[] {
  return seedNodes().map((node) => ids.includes(node.id)
    ? { ...node, status: "unlocked" as const, notes: `Use ${node.title} the way I taught you.` }
    : node);
}

test("a plan that needs a locked skill never touches the computer", async () => {
  const computer = new RecordingComputer();
  const said: string[] = [];
  await runTask({
    userText: "create a git branch called feature",
    history: [],
    nodes: unlock(["terminal-basics"]),
    allowedIds: [],
    llm: scripted([{
      content: null,
      toolCalls: [
        { id: "run", name: "run_shell", arguments: { command: "git switch -c feature" } },
        { id: "plan", name: "plan", arguments: { steps: ["make a branch"], skillIds: ["git-branching"], missing: ["git-branching"] } },
      ],
    }]),
    computer,
    onEvent: (event) => { if (event.type === "say") said.push(event.text); },
  });
  assert.deepEqual(computer.runs, []);
  assert.match(said.join("\n"), /The missing node is Git branching/);
});

test("the intern plans, then runs only an unlocked command", async () => {
  const computer = new RecordingComputer();
  const said: string[] = [];
  await runTask({
    userText: "list the files",
    history: [],
    nodes: unlock(["terminal-basics"]),
    allowedIds: ["terminal-basics"],
    llm: scripted([
      { content: null, toolCalls: [{ id: "a", name: "run_shell", arguments: { command: "ls" } }] },
      { content: null, toolCalls: [{ id: "b", name: "plan", arguments: { steps: ["list the directory"], skillIds: ["terminal-basics"], missing: [] } }] },
      { content: null, toolCalls: [{ id: "c", name: "run_shell", arguments: { command: "ls -la" } }] },
      { content: "Done.", toolCalls: [] },
    ]),
    computer,
    onEvent: (event) => { if (event.type === "say") said.push(event.text); },
  });
  assert.deepEqual(computer.runs, ["ls -la"]);
  assert.match(said.join("\n"), /Plan:/);
});

test("docker is refused even after a harmless plan", async () => {
  const computer = new RecordingComputer();
  const said: string[] = [];
  await runTask({
    userText: "show containers",
    history: [],
    nodes: unlock(["terminal-basics"]),
    allowedIds: ["terminal-basics"],
    llm: scripted([{
      content: null,
      toolCalls: [
        { id: "p", name: "plan", arguments: { steps: ["look around"], skillIds: ["terminal-basics"], missing: [] } },
        { id: "d", name: "run_shell", arguments: { command: "docker ps" } },
      ],
    }]),
    computer,
    onEvent: (event) => { if (event.type === "say") said.push(event.text); },
  });
  assert.deepEqual(computer.runs, []);
  assert.match(said.join("\n"), /Docker basics/);
});

test("the chat client posts to an OpenAI-compatible completions URL", async () => {
  assert.equal(chatCompletionsUrl("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
  const seen = { url: "", auth: "", model: "" };
  const llm = createLlm({
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    model: "deepseek-chat",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { model: string };
      seen.url = String(url);
      seen.auth = headers.get("authorization") ?? "";
      seen.model = body.model;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
    },
  });
  const turn = await llm.chat([{ role: "user", content: "hi" }]);
  assert.equal(turn.content, "hello");
  assert.equal(seen.url, "https://api.deepseek.com/chat/completions");
  assert.equal(seen.auth, "Bearer sk-test");
  assert.equal(seen.model, "deepseek-chat");
});

test("the maritime client uses the computers REST API", async () => {
  const calls: { url: string; method: string; auth: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization") ?? "",
      body: typeof init?.body === "string" ? init.body : "",
    });
    const path = String(url);
    if (path.endsWith("/api/v1/computers") && (init?.method ?? "GET") === "POST") {
      return Response.json({ id: "cmp_1", status: "asleep", externalUserId: "dum-intern", name: "dum-intern" }, { status: 201 });
    }
    if (path.endsWith("/exec")) return Response.json({ exitCode: 0, stdout: "ready\n", stderr: "" });
    if (path.includes("/files?")) return new Response(null, { status: 204 });
    if (path.endsWith("/viewer")) {
      return Response.json({ url: "https://view.example/watch", expiresAt: "2026-10-25T12:00:00Z", mode: "watch" });
    }
    return Response.json({ status: "running" });
  };
  const client = createMaritime({ baseUrl: "https://api.maritime.sh", apiKey: "mk_test", fetch: fetchImpl });
  const computer = await client.getOrCreate("dum-intern", "dum-intern");
  assert.equal(computer.id, "cmp_1");
  const exec = await client.exec("cmp_1", "ls", 30);
  assert.equal(exec.stdout, "ready\n");
  await client.writeFile("cmp_1", "/home/desk/work/task.py", "print('hi')\n");
  const viewer = await client.viewer("cmp_1", "watch", 3600);
  assert.equal(viewer.url, "https://view.example/watch");
  assert.equal(calls[0].auth, "Bearer mk_test");
  assert.match(calls[0].url, /https:\/\/api\.maritime\.sh\/api\/v1\/computers$/);
  assert.match(calls[1].url, /\/api\/v1\/computers\/cmp_1\/exec$/);
  assert.equal(JSON.parse(calls[1].body).command, "ls");
  assert.match(calls[2].url, /\/files\?path=%2Fhome%2Fdesk%2Fwork%2Ftask\.py$/);
  assert.equal(JSON.parse(calls[3].body).mode, "watch");
  assert.match(visibleCommand("ls -la"), new RegExp(Buffer.from("ls -la").toString("base64")));
  assert.match(OPEN_DESKTOP, /session\.log/);
  assert.throws(() => assertDeskPath("/etc/passwd"), /not allowed|under \/home\/desk/);
  assert.equal(assertDeskPath("/home/desk/work/task.py"), "/home/desk/work/task.py");
});

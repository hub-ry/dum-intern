// The MCP server against a fake workshop and temporary request and handoff folders: the protocol
// handshake, Ryan's-words-need-approval, id and title lookups, handoffs both ways, and secrets
// refused before they reach disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcp, PROTOCOL_VERSIONS, TOOLS, type Deps } from "./server.ts";
import { listRequests, updateRequest } from "../shared/requests.ts";
import { listHandoffs, parseStatus, isTaskId } from "../shared/handoff.ts";
import { listPosts } from "../shared/file-posts.ts";
import { mergeMcpJson } from "../cli.ts";
import type { JobView, Workshop } from "../client/workshop.ts";

const GOAL = "f57e2d4b-56c3-46eb-b854-69fda9522bda";
const JOB = "60d885e9-16e2-46bb-87cf-ee62cd7c45d9";
const SHARE = { id: "7b0c4f7e-2a51-4d1e-9a3c-55e0d1c2b3a4", path: "/home/r/internship/resume/hubbart_resume.pdf", name: "hubbart_resume.pdf", createdAt: "2026-10-11T00:00:00Z", size: 34711, urlPath: "/files/7b0c4f7e-2a51-4d1e-9a3c-55e0d1c2b3a4/hubbart_resume.pdf" };

function setup(over: Partial<Workshop> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dum-mcp-"));
  const calls: string[] = [];
  const job = (state: JobView["state"]): JobView => ({ id: JOB, goalId: GOAL, state, createdAt: "2026-10-11T00:00:00Z", ...(state === "ready" ? { result: { title: "Shelter", panels: [{ caption: "Page one", code: "for (x of y) {}" }] } } : {}) });
  let jobState: JobView["state"] = "running";
  const workshop: Workshop = {
    goals: async () => [{ id: GOAL, title: "software" }],
    goal: async () => ({ id: GOAL, title: "software", ambition: "full stack", baseContext: "old", materials: [{ id: "m1", concept: "loops", title: "Loops", body: "# Loops" }], schedule: null }),
    jobs: async () => [job(jobState)],
    job: async () => job(jobState),
    teachings: async () => [],
    createGoal: async (t) => (calls.push(`create ${t}`), { id: GOAL, title: t }),
    teach: async () => void calls.push("teach"),
    setContext: async (g, c) => void calls.push(`context ${c}`),
    studied: async () => void calls.push("studied"),
    tried: async () => void calls.push("tried"),
    revisit: async () => void calls.push("revisit"),
    progress: async () => [],
    schedule: async () => null,
    build: async (g) => (calls.push(`build ${g}`), job("queued")),
    correct: async (j, c) => (calls.push(`correct ${j} ${c}`), job("queued")),
    share: async (path) => (calls.push(`share ${path}`), { ...SHARE, path }),
    shares: async () => [SHARE],
    unshare: async (id) => (calls.push(`unshare ${id}`), SHARE),
    file: async () => null,
    ...over,
  };
  let clock = Date.parse("2026-10-11T09:00:00Z");
  const deps: Deps = {
    workshop,
    requestsDir: join(root, "requests"),
    handoffDir: join(root, "handoff"),
    postsDir: join(root, "posts"),
    appUrl: "http://hub:8770",
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
      if (clock > Date.parse("2026-10-11T09:00:05Z")) jobState = "ready";
    },
  };
  const mcp = createMcp(deps);
  const text = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.call(name, args);
    return { text: r.content[0]!.text, error: !!r.isError };
  };
  return { root, deps, mcp, calls, text, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the handshake negotiates a version, names the server, and lists tools with schemas", async () => {
  const { mcp, cleanup } = setup();
  try {
    const init = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "codex" } } })) as any;
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "dum");
    assert.match(init.result.instructions, /own words/);
    const odd = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any;
    assert.equal(odd.result.protocolVersion, PROTOCOL_VERSIONS[0]);
    assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    const list = (await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as any;
    assert.equal(list.result.tools.length, TOOLS.length);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, "object");
    const missing = (await mcp.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" })) as any;
    assert.equal(missing.error.code, -32601);
  } finally {
    cleanup();
  }
});

test("teaching from an agent waits for Ryan's approval and is never recorded directly", async () => {
  const { mcp, deps, calls, text, cleanup } = setup();
  try {
    await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-ai" } } });
    const pending = await text("dum_teach", { goal: "software", concept: "recursion", text: "it calls itself", wait_seconds: 0 });
    assert.match(pending.text, /Waiting for Ryan/);
    assert.deepEqual(calls, [], "nothing reaches the workshop without approval");
    const [req] = listRequests(deps.requestsDir);
    assert.equal(req!.requestedBy, "claude-ai");
    assert.equal(req!.text, "it calls itself");
    updateRequest(deps.requestsDir, req!.id, { status: "approved", decidedAt: "2026-10-11T09:01:00Z" });
    assert.match((await text("dum_request_status", { request_id: req!.id })).text, /approved/);
    assert.throws(() => updateRequest(deps.requestsDir, req!.id, { status: "declined" }), /already approved/);
  } finally {
    cleanup();
  }
});

test("attempt reports carry the help flag into the request", async () => {
  const { deps, text, cleanup } = setup();
  try {
    await text("dum_report_attempt", { goal: GOAL, concept: "loops", text: "summed a list", needed_help: true, wait_seconds: 0 });
    assert.equal(listRequests(deps.requestsDir)[0]!.helped, true);
  } finally {
    cleanup();
  }
});

test("goals resolve by id or exact title, creations by id or prefix, with helpful errors", async () => {
  const { text, calls, cleanup } = setup();
  try {
    assert.match((await text("dum_build", { goal: "Software" })).text, /Queued creation/);
    assert.match((await text("dum_build", { goal: GOAL })).text, /Queued creation/);
    const bad = await text("dum_build", { goal: "nope" });
    assert.equal(bad.error, true);
    assert.match(bad.text, /software \(f57e2d4b/);
    assert.match((await text("dum_correct", { creation: "60d885e9", correction: "feed at 5" })).text, /original stays/);
    assert.deepEqual(calls, [`build ${GOAL}`, `build ${GOAL}`, `correct ${JOB} feed at 5`]);
  } finally {
    cleanup();
  }
});

test("a creation can be waited on until it's ready, and shows its pages and link", async () => {
  const { text, cleanup } = setup();
  try {
    const r = await text("dum_creation", { creation: JOB, wait_seconds: 30 });
    assert.match(r.text, /ready · Shelter/);
    assert.match(r.text, /Page 1: Page one/);
    assert.match(r.text, /http:\/\/hub:8770\/#job=60d885e9/);
  } finally {
    cleanup();
  }
});

test("context appends by default and replaces on request", async () => {
  const { text, calls, cleanup } = setup();
  try {
    await text("dum_set_context", { goal: GOAL, context: "new" });
    await text("dum_set_context", { goal: GOAL, context: "only", mode: "replace" });
    assert.deepEqual(calls, ["context old\n\nnew", "context only"]);
  } finally {
    cleanup();
  }
});

test("handoffs go both ways in the README format and secrets are refused", async () => {
  const { mcp, deps, text, cleanup } = setup();
  try {
    await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "omp" } } });
    const created = await text("handoff_create", { title: "Screenshot the demo", executor: "laptop", body: "Open the presentation and capture page 3." });
    const id = /handoff (\S+) for/.exec(created.text)![1]!;
    assert.ok(isTaskId(id));
    const task = readFileSync(join(deps.handoffDir, id, "task.md"), "utf8");
    assert.match(task, /^# Screenshot the demo/m);
    assert.match(task, /^- Requester: omp$/m);
    assert.match(task, /^- Assigned executor: laptop$/m);
    assert.match((await text("handoff_list", { executor: "laptop", status: "open" })).text, new RegExp(id));

    assert.match((await text("handoff_wait", { task_id: id, wait_seconds: 3 })).text, /still open/);
    await text("handoff_result", { task_id: id, status: "running", body: "Started." });
    await text("handoff_result", { task_id: id, status: "done", body: "Captured page 3." });
    const result = readFileSync(join(deps.handoffDir, id, "result.md"), "utf8");
    assert.match(result, /^- Status: done$/m);
    assert.match(result, /Started\.[\s\S]*## Update[\s\S]*Captured page 3\./, "earlier results are kept");
    assert.match((await text("handoff_wait", { task_id: id })).text, /is done/);

    const secret = await text("handoff_create", { title: "x", executor: "hub", body: "DISCORD_TOKEN=" + ["MTU1ODc0MDY0Nzg4MjY2MTk0OA", "Gabcde", "abcdefghijklmnopqrstuvwxyz0123"].join(".") });
    assert.equal(secret.error, true);
    assert.match(secret.text, /credential/);
    assert.equal(listHandoffs(deps.handoffDir).length, 1);

    for (const bad of ["../etc", "2026-10-11-..", "notes"]) assert.equal((await text("handoff_read", { task_id: bad })).error, true);
  } finally {
    cleanup();
  }
});

test("existing hand-written handoffs are read as they are", () => {
  const root = mkdtempSync(join(tmpdir(), "dum-handoff-"));
  try {
    mkdirSync(join(root, "2026-10-11-discord-setup"));
    writeFileSync(join(root, "2026-10-11-discord-setup", "result.md"), "# Handoff: Discord setup\n\nFrom: laptop session\nStatus: done and running. Nothing is committed.\n");
    mkdirSync(join(root, "2026-10-11-dum-intern-vision"));
    writeFileSync(join(root, "2026-10-11-dum-intern-vision", "task.md"), "# Dum-intern vision\n\n- Assigned executor: hub agent for consolidating this record.\n");
    const list = listHandoffs(root);
    assert.deepEqual(list.map((h) => [h.id, h.status]).sort(), [["2026-10-11-discord-setup", "done"], ["2026-10-11-dum-intern-vision", "open"]]);
    assert.equal(parseStatus("- Status: running (see below)"), "running");
    const setup = list.find((h) => h.id === "2026-10-11-discord-setup")!;
    assert.equal(setup.title, "Discord setup");
    assert.equal(setup.executor, "laptop session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registering with omp keeps its other MCP servers", () => {
  const merged = JSON.parse(mergeMcpJson(JSON.stringify({ mcpServers: { other: { command: "x" } } }), { dum: { command: "/home/r/.local/bin/dum", args: ["mcp"] }, codex: { command: "/home/r/.local/bin/dum", args: ["codex-mcp"] } }));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["codex", "dum", "other"]);
  assert.deepEqual(JSON.parse(mergeMcpJson(null, { dum: { command: "d", args: ["mcp"] } })), { mcpServers: { dum: { command: "d", args: ["mcp"] } } });
});

import { isVerbatim } from "../shared/requests.ts";

test("teaching through Dum's chat is marked verbatim only when it's Ryan's exact words", async () => {
  const { deps, cleanup } = setup();
  try {
    const source = "ok dum, teach this:\nrecursion is when a function   calls itself on a smaller input";
    const mcp = createMcp({ ...deps, chatSource: source });
    await mcp.call("dum_teach", { goal: GOAL, concept: "recursion", text: "recursion is when a function calls itself on a smaller input", wait_seconds: 0 });
    await mcp.call("dum_teach", { goal: GOAL, concept: "recursion", text: "Recursion: a function calling itself on smaller inputs.", wait_seconds: 0 });
    const byText = (t: string) => listRequests(deps.requestsDir).find((r) => r.text === t)!;
    const exact = byText("recursion is when a function calls itself on a smaller input");
    const rephrased = byText("Recursion: a function calling itself on smaller inputs.");
    assert.equal(exact.verbatim, true);
    assert.equal(rephrased.verbatim, undefined, "a rephrase still needs Ryan's approval");
    const outside = createMcp(deps);
    await outside.call("dum_teach", { goal: GOAL, concept: "x", text: "recursion is when", wait_seconds: 0 });
    assert.equal(byText("recursion is when").verbatim, undefined, "only Dum's own chat can mark verbatim");
    assert.equal(isVerbatim("", "anything"), false);
  } finally {
    cleanup();
  }
});

import { codexArgs, createCodexMcp, workFolder } from "./codex.ts";

test("Codex runs in the given folder, sandboxed, never bypassing approvals, with the task after --", () => {
  const args = codexArgs({ task: "--dangerously-bypass-approvals-and-sandbox fix it", cwd: "/home/r/p", sandbox: "workspace-write", outFile: "/tmp/o" });
  assert.deepEqual(args.slice(0, 5), ["exec", "--cd", "/home/r/p", "--sandbox", "workspace-write"]);
  assert.equal(args.at(-2), "--", "the task can't be read as a flag");
  assert.equal(args.filter((a) => a.startsWith("--dangerously")).length, 1, "only inside the task text itself");
  assert.equal(args.indexOf("--dangerously-bypass-approvals-and-sandbox"), -1);
  assert.throws(() => workFolder("/definitely/not/here"), /No folder/);
});

test("the codex MCP server lists one tool and refuses a missing folder without running anything", async () => {
  const handle = createCodexMcp("/bin/false");
  const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["codex"]);
  const r = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex", arguments: { task: "x", cwd: "/definitely/not/here" } } })) as any;
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /No folder/);
});

test("a shared file rides with the chat reply, goes to a named goal's channel, or just returns its link", async () => {
  const { root, deps, calls, cleanup } = setup();
  try {
    const link = `http://hub:8770${SHARE.urlPath}`;
    // Outside chat with no goal: a link and nothing queued.
    const bare = await createMcp(deps).call("dum_share_file", { path: "~/internship/resume/hubbart_resume.pdf" });
    assert.match(bare.content[0]!.text, new RegExp(`${link.replace(/[.]/g, "\\.")}[\\s\\S]*Not posted to Discord`));
    assert.deepEqual(calls, ["share ~/internship/resume/hubbart_resume.pdf"]);
    assert.equal(listPosts(deps.postsDir).length, 0);

    // In chat: the file is queued in the turn's folder, to upload with the reply.
    const filesDir = join(root, "turn", "files");
    const chat = createMcp({ ...deps, chat: { filesDir, goalId: GOAL } });
    const inChat = await chat.call("dum_share_file", { path: SHARE.path });
    assert.match(inChat.content[0]!.text, /uploaded with your reply/);
    const [queued] = listPosts(filesDir);
    assert.equal(queued!.link, link);
    assert.equal(queued!.attach, true);
    assert.equal(queued!.goalId, undefined);
    // Naming the chat's own goal is the same thing.
    await chat.call("dum_share_file", { path: SHARE.path, goal: "software" });
    assert.equal(listPosts(filesDir).length, 2);
    assert.equal(listPosts(deps.postsDir).length, 0);

    // A goal from outside chat: posted in that goal's channel, with the note.
    const posted = await createMcp(deps).call("dum_share_file", { path: SHARE.path, goal: "software", note: "updated resume" });
    assert.match(posted.content[0]!.text, /Posting it in the channel for "software"/);
    const [post] = listPosts(deps.postsDir);
    assert.equal(post!.goalId, GOAL);
    assert.equal(post!.note, "updated resume");

    const secret = await createMcp(deps).call("dum_share_file", { path: SHARE.path, goal: "software", note: "password: hunter2hunter2" });
    assert.equal(secret.isError, true);
    assert.match(secret.content[0]!.text, /credential/);
  } finally {
    cleanup();
  }
});

test("a file over Discord's upload limit goes as a link, and unsharing finds the share by its prefix", async () => {
  const big = { ...SHARE, size: 11 * 1024 * 1024 };
  const { root, text, deps, calls, cleanup } = setup({ share: async () => big, shares: async () => [big] });
  try {
    const filesDir = join(root, "turn", "files");
    const r = await createMcp({ ...deps, chat: { filesDir, goalId: null } }).call("dum_share_file", { path: SHARE.path });
    assert.match(r.content[0]!.text, /over Discord's 10 MB upload limit/);
    assert.equal(listPosts(filesDir)[0]!.attach, false);
    assert.match((await text("dum_shared_files")).text, /hubbart_resume\.pdf · 11\.0 MB · http:\/\/hub:8770\/files\/7b0c4f7e/);
    assert.match((await text("dum_unshare_file", { share: "7b0c4f7e" })).text, /Stopped sharing hubbart_resume\.pdf/);
    assert.ok(calls.includes(`unshare ${SHARE.id}`));
    assert.equal((await text("dum_unshare_file", { share: "ffffffff" })).error, true);
  } finally {
    cleanup();
  }
});

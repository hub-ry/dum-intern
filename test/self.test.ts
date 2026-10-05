import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import { maintain, readSource, fileInCheckout, listSources, type Query } from "../src/self.ts";

test("self paths stay in the checkout's own source and refuse generated, internal and escaping files", () => {
  const root = mkdtempSync(join(tmpdir(), "dum-self-"));
  const outside = mkdtempSync(join(tmpdir(), "dum-outside-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), "// user's change\nconst greeting = 'hello';\n");
    assert.match(readSource(root, "src/main.ts"), /user's change/);
    assert.throws(() => fileInCheckout(root, "../escape.ts", true), /outside/);
    assert.throws(() => fileInCheckout(root, "node_modules/example.js", true), /source file/);
    assert.throws(() => fileInCheckout(root, ".dum/developer-claude-session", true), /source file/);
    assert.throws(() => fileInCheckout(root, "CHANGELOG.md", true), /changelogs/);
    assert.throws(() => fileInCheckout(root, "secrets/x.ts", true), /belong in dum's source/);
    writeFileSync(join(root, "src/generated.ts"), "// auto-generated, do not edit\nconst n = 1;");
    assert.throws(() => fileInCheckout(root, "src/generated.ts", true), /generated/);
    symlinkSync(outside, join(root, "src/linked"));
    assert.throws(() => fileInCheckout(root, "src/linked/new.ts", true), /symlink/);
    assert.deepEqual(listSources(root).sort(), ["src/generated.ts", "src/main.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/** A Claude stand-in that runs the given steps against the self MCP server. */
function developer(steps: (client: Client) => Promise<void>, seen: { tools?: string[]; called: boolean }) {
  return (({ options }: Parameters<Query>[0]) => {
    seen.called = true;
    async function* messages() {
      yield { type: "system", subtype: "init", apiKeySource: "none", tools: ["mcp__self__read"], mcp_servers: [{ name: "self", status: "connected", source: "sdk" }], plugins: [], session_id: "dev-1" };
      const server = options!.mcpServers!.self as unknown as { instance: { connect: (transport: unknown) => Promise<void> } };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "developer-test", version: "1.0.0" });
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        seen.tools = (await client.listTools()).tools.map((t) => t.name);
        await steps(client);
      } finally { await client.close(); }
      yield { type: "result", subtype: "success", is_error: false, result: "Proposed a new greeting." };
    }
    return Object.assign(messages(), { close() {}, accountInfo: async () => ({ apiProvider: "firstParty", apiKeySource: "none" }) });
  }) as unknown as Query;
}

function text(r: { content?: unknown }): string {
  return (r.content as { text: string }[])[0]!.text;
}

test("self maintenance proposes changes to existing files, creates only new ones and runs nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "dum-self-e2e-"));
  const learning = mkdtempSync(join(tmpdir(), "dum-learning-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.js"), "export const greeting = 'hello';\n");
    const marker = join(root, "tested");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: `touch ${marker}`, typecheck: `touch ${marker}` } }));
    const seen: { tools?: string[]; called: boolean } = { called: false };
    const run = developer(async (client) => {
      const read = text(await client.callTool({ name: "read", arguments: { path: "src/main.js" } }));
      const digest = read.match(/^sha256 ([0-9a-f]{64})/)![1]!;
      // Stale baseline: you saved in your editor after the developer read the file.
      const stale = await client.callTool({ name: "propose", arguments: { path: "src/main.js", expected_sha: "0".repeat(64), old_text: "'hello'", new_text: "'hi'" } });
      assert.equal(stale.isError, true);
      const proposed = await client.callTool({ name: "propose", arguments: { path: "src/main.js", expected_sha: digest, old_text: "'hello'", new_text: "'hi'" } });
      assert.equal(proposed.isError, undefined, text(proposed));
      const created = await client.callTool({ name: "create", arguments: { path: "src/extra.js", content: "export const n = 1;\n" } });
      assert.equal(created.isError, undefined, text(created));
      const clobber = await client.callTool({ name: "create", arguments: { path: "src/main.js", content: "overwritten" } });
      assert.equal(clobber.isError, true);
    }, seen);
    const store = new Store("learning-project", "understand", learning);
    store.onSelfChange = (request) => maintain(root, request, store, run);
    const question = store.askQuestion("what next?", "");
    const finished = await store.changeSelf("change dum's greeting");
    assert.ok(seen.called);
    assert.ok(!seen.tools!.includes("check") && !seen.tools!.includes("edit"), "no edit-in-place or command tools");
    assert.match(finished, /not applied/);
    assert.match(finished, /\.dum\/proposals\/.+\.patch/);
    assert.match(finished, /:restart/);
    assert.equal(readFileSync(join(root, "src/main.js"), "utf8"), "export const greeting = 'hello';\n", "existing source is never overwritten");
    assert.equal(readFileSync(join(root, "src/extra.js"), "utf8"), "export const n = 1;\n");
    assert.equal(existsSync(marker), false, "no npm scripts ran");
    assert.equal(readFileSync(join(root, ".dum/developer-claude-session"), "utf8"), "dev-1");
    assert.equal(store.getSnapshot().prompt?.type, "question");
    store.submit("keep learning");
    assert.equal(await question, "keep learning");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(learning, { recursive: true, force: true });
  }
});

test("self refuses to maintain the checkout you're learning in", async () => {
  const root = mkdtempSync(join(tmpdir(), "dum-self-same-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.js"), "export const greeting = 'hello';\n");
    const seen = { called: false };
    const store = new Store("dum-intern", "understand", join(root, "src"));
    await assert.rejects(maintain(root, "unlock everything", store, developer(async () => {}, seen)), /learning in/);
    assert.equal(seen.called, false, "Claude is never started");
    store.onSelfChange = (request) => maintain(root, request, store, developer(async () => {}, seen));
    assert.match(await store.changeSelf("make the gate pass"), /learning in/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

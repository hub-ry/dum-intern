// Codex as a tool for other agents. `dum codex-mcp` is a small MCP server with one tool, `codex`,
// that hands a task to the Codex CLI (`codex exec`) in a folder and returns Codex's final answer.
// omp uses it to delegate work to Codex mid-conversation. Codex runs with its own config, rules
// and sandbox; by default it may only write inside the folder it was given.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PROTOCOL_VERSIONS } from "./server.ts";

type Json = Record<string, unknown>;

export const CODEX_TOOL = {
  name: "codex",
  title: "Ask Codex",
  description:
    "Hand a self-contained task to the Codex coding agent (OpenAI) on hub and get its final answer. Codex works in the given folder with its own tools. Say exactly what to do, where, and how to check it. Takes as long as Codex takes, usually a few minutes.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "What Codex should do, with the context it needs. It can't see this conversation." },
      cwd: { type: "string", description: "Folder to work in: absolute, or relative to the home folder." },
      sandbox: { type: "string", enum: ["read-only", "workspace-write"], description: "read-only to investigate, workspace-write (default) to change files inside cwd." },
      model: { type: "string", description: "Optional model override; leave out for Ryan's Codex default." },
    },
    required: ["task", "cwd"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

export type CodexRun = { task: string; cwd: string; sandbox: "read-only" | "workspace-write"; model?: string; outFile: string };

/** The exact `codex exec` arguments for a run. Never bypasses the sandbox or approvals. */
export function codexArgs(run: CodexRun): string[] {
  return [
    "exec",
    "--cd",
    run.cwd,
    "--sandbox",
    run.sandbox,
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    run.outFile,
    ...(run.model ? ["--model", run.model] : []),
    "--",
    run.task,
  ];
}

/** Resolves and checks the folder Codex may work in. */
export function workFolder(raw: string, home = homedir()): string {
  const dir = resolve(isAbsolute(raw) ? raw : join(home, raw));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No folder ${dir}.`);
  return dir;
}

export function findCodex(): string {
  const env = process.env.DUM_CODEX_EXECUTABLE?.trim();
  if (env) return env;
  const nvm = join(homedir(), ".nvm", "versions", "node");
  const fromNvm = existsSync(nvm) ? readdirSync(nvm).map((v) => join(nvm, v, "bin", "codex")).find((p) => existsSync(p)) : undefined;
  return fromNvm ?? "codex";
}

async function runCodex(bin: string, args: Json): Promise<{ text: string; isError: boolean }> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return { text: '"task" is required.', isError: true };
  let cwd: string;
  try {
    cwd = workFolder(typeof args.cwd === "string" ? args.cwd : "");
  } catch (err) {
    return { text: (err as Error).message, isError: true };
  }
  const sandbox = args.sandbox === "read-only" ? "read-only" : "workspace-write";
  const tmp = mkdtempSync(join(tmpdir(), "dum-codex-"));
  const outFile = join(tmp, "last.txt");
  try {
    const argv = codexArgs({ task, cwd, sandbox, outFile, ...(typeof args.model === "string" && args.model.trim() ? { model: args.model.trim() } : {}) });
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((done) => {
      // Codex needs node from the same nvm install on PATH; ssh and agents don't load nvm.
      const env = { ...process.env, PATH: `${resolve(bin, "..")}:${process.env.PATH ?? ""}` };
      const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
      child.on("close", (code) => done({ code, stderr }));
      child.on("error", (err) => done({ code: -1, stderr: String(err) }));
    });
    const last = existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "";
    if (code !== 0) return { text: `Codex stopped (exit ${code}).${last ? `\n\nIts last message:\n${last}` : ""}\n\n${stderr.trim().split("\n").slice(-8).join("\n")}`, isError: true };
    return { text: last || "Codex finished without a final message.", isError: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** One JSON-RPC message in, its response out. */
export function createCodexMcp(bin = findCodex()) {
  return async function handle(msg: unknown): Promise<Json | null> {
    const m = (msg ?? {}) as { id?: string | number | null; method?: string; params?: Json };
    const isRequest = m.id !== undefined && m.id !== null;
    const reply = (result: Json) => (isRequest ? { jsonrpc: "2.0", id: m.id, result } : null);
    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "codex", title: "Codex (via dum)", version: "1.0.0" },
          instructions: "One tool, codex: delegate a self-contained coding task to the Codex agent in a folder on hub. Codex can't see your conversation, so include everything it needs.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [CODEX_TOOL] });
      case "tools/call": {
        if (m.params?.name !== "codex") return reply({ content: [{ type: "text", text: `Unknown tool ${String(m.params?.name)}.` }], isError: true });
        const r = await runCodex(bin, (m.params?.arguments ?? {}) as Json);
        return reply({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
      }
      default:
        if (typeof m.method === "string" && m.method.startsWith("notifications/")) return null;
        return isRequest ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${String(m.method)}` } } : null;
    }
  };
}

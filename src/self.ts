// The development edition maintains its own checkout through a small set of tools. Existing files
// only ever get proposals (patches under .dum/proposals for you to apply in your editor); new
// files are created exclusively. Nothing the developer writes is executed here.
import { query, tool, createSdkMcpServer, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Store } from "./store.ts";
import * as memory from "./memory.ts";
import { MODELS, assertSubscription, closed, start } from "./runtime.ts";
import { Workspace, gitSync, readState, writeState } from "./workspace.ts";

export const checkout = fileURLToPath(new URL("..", import.meta.url));
const generated = /(?:^|\n)\s*(?:\/\/|#|\/\*|\*|<!--)[^\n]*(?:auto[- ]generated|automatically generated|do not edit)/i;
/** A new name, so a session recorded under the old edit-and-test prompt is never resumed. */
const SESSION = "developer-claude-session";

/** Check existing ancestors too: a symlink inside src mustn't reach outside the checkout. */
export function fileInCheckout(root: string, path: string, writing = false): string {
  const base = realpathSync(root);
  const file = resolve(base, path);
  const rel = relative(base, file);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("that path is outside dum's checkout");
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => [".git", ".dum", "node_modules"].includes(p) || p.startsWith(".env"))) throw new Error("that path isn't a dum source file");
  let ancestor = file;
  for (;;) {
    try {
      const actual = realpathSync(ancestor);
      const outside = relative(base, actual);
      if (outside === ".." || outside.startsWith("../") || isAbsolute(outside)) throw new Error("that symlink leaves dum's checkout");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      ancestor = dirname(ancestor);
    }
  }
  if (writing) {
    if (/^(?:changelog\.md|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(parts.at(-1)!)) throw new Error("generated files and changelogs aren't edited by hand");
    if (parts.some((p) => p.startsWith(".")) || /^(?:AGENTS|CLAUDE)\.md$/i.test(parts.at(-1)!)) {
      throw new Error("agent instructions and hidden configuration aren't source files for self maintenance");
    }
    const top = parts[0]!;
    if (!["src", "test", "tools", "bin", "docs"].includes(top) && !(parts.length === 1 && /\.(?:md|json)$/.test(top))) throw new Error("changes belong in dum's source, tests, tools, docs or package configuration");
    try {
      const body = readSource(base, rel);
      if (generated.test(body.slice(0, 2000))) throw new Error("this file is marked as generated");
    } catch (err) {
      if (!/doesn't exist$/.test((err as Error).message)) throw err;
    }
  }
  return file;
}

/** A checkout file through the same bounded, symlink-safe read the learning workspace uses. */
export function readSource(root: string, path: string): string {
  fileInCheckout(root, path);
  return new Workspace(root).file(path).text;
}

export function listSources(root: string): string[] {
  return new Workspace(root).list().filter((path) => {
    try { fileInCheckout(root, path); return true; } catch { return false; }
  });
}

/** Existing changes in the checkout, through the read-only Git catalog's hardened invocation. */
export function status(root: string): string {
  const short = gitSync(root, ["status", "--short"]);
  const stat = gitSync(root, ["diff", "--stat", "--no-color", "--no-ext-diff", "--no-textconv"]);
  return `${short.stdout}${stat.stdout}`.slice(0, 16000);
}

/** The developer would be maintaining the very project you're learning in - refused. */
export function overlaps(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = realpathSync(a);
  const y = realpathSync(b);
  const inside = (outer: string, inner: string) => {
    const rel = relative(outer, inner);
    return rel === "" || !(rel === ".." || rel.startsWith("../") || isAbsolute(rel));
  };
  return inside(x, y) || inside(y, x);
}

export type Query = typeof query;

export async function maintain(root: string, request: string, store: Store, runQuery: Query = query): Promise<string> {
  const learning = store.getSnapshot();
  if (overlaps(root, learning.root)) {
    throw new Error("dum's checkout is the project you're learning in - :self won't change it, so your skill gates still hold. Run dum-dev from another project to maintain dum");
  }
  const ws = new Workspace(root, store);
  const proposed: string[] = [];
  const created: string[] = [];
  const result = (body: string, isError = false) => ({ content: [{ type: "text" as const, text: body }], ...(isError ? { isError } : {}) });
  const attempt = async (fn: () => string | Promise<string>) => {
    try { return result(await fn()); } catch (err) { return result((err as Error).message, true); }
  };
  const server = createSdkMcpServer({
    name: "self", version: "1.0.0", alwaysLoad: true, timeout: 180000,
    tools: [
      tool("list", "List dum's tracked and untracked source files.", {}, async () => attempt(() => listSources(root).join("\n"))),
      tool("read", "Read a whole source file in dum's checkout, with the sha256 a proposal needs.", { path: z.string() }, async ({ path }) => attempt(() => {
        fileInCheckout(root, path);
        const art = ws.file(path);
        return `sha256 ${art.sha}\n${art.text}`;
      })),
      tool(
        "propose",
        "Propose replacing one exact occurrence in an existing file. expected_sha is from read; nothing is applied - the engineer applies the patch in their editor.",
        { path: z.string(), expected_sha: z.string().regex(/^[0-9a-f]{64}$/), old_text: z.string().min(1), new_text: z.string() },
        async (a) => attempt(() => {
          fileInCheckout(root, a.path, true);
          const art = ws.file(a.path);
          if (art.sha !== a.expected_sha) throw new Error(`${a.path} changed since you read it - read it again`);
          const at = art.text.indexOf(a.old_text);
          if (at < 0 || at !== art.text.lastIndexOf(a.old_text)) throw new Error("old_text needs to match exactly once - read the current file again");
          const next = art.text.slice(0, at) + a.new_text + art.text.slice(at + a.old_text.length);
          const { diff, artifact } = ws.propose(a.path, a.expected_sha, next);
          proposed.push(artifact);
          return `proposed, not applied: ${artifact}\n${diff}`;
        }),
      ),
      tool("create", "Create a new file that doesn't exist yet. Never replaces anything.", { path: z.string(), content: z.string() }, async (a) => attempt(() => {
        fileInCheckout(root, a.path, true);
        ws.create(a.path, a.content);
        created.push(a.path);
        return `created ${a.path}`;
      })),
      tool("status", "Show the checkout's existing changes. Preserve other work.", {}, async () => attempt(() => status(root))),
    ],
  });
  store.note(`self: working in ${root}`);
  let out = "";
  let completed = false;
  let started = false;
  let resume: string | undefined;
  try {
    const id = readState(root, SESSION, 256)?.trim();
    if (id && (await getSessionMessages(id, { dir: root, limit: 1 })).length) resume = id;
  } catch { /* a first maintenance request starts its own developer session */ }
  store.working("self: waiting for Claude");
  const session = await start(
    `Change dum-intern itself for this request:\n${request}\n\nExisting checkout changes:\n${status(root)}\n\n${memory.prompt(learning.root || root, learning.transcript)}`,
    closed({
      cwd: root,
      model: MODELS.dum.model,
      effort: MODELS.dum.effort,
      mcp: { self: server },
      maxTurns: 40,
      ...(resume ? { resume } : {}),
      systemPrompt: `You're dum's developer, working on its own checkout. Complete the requested change.\nUse the self tools to inspect code, propose changes to existing files and create new ones.\nYou can't edit existing files: each change is a proposal saved as a patch that the engineer reviews and applies in their editor. Keep proposals focused.\nYou can't run commands, typecheck or tests. Say which checks the engineer should run after applying.\nFor a bug, trace it through the user-facing path before proposing a fix.\nPreserve existing changes. Never propose overwriting whole files to undo unrelated work.\nRead applicable AGENTS.md files first. Never change generated files or CHANGELOG.md.\nDon't commit, push or add AI attribution. Never use an em dash.\nThe learning skill tree doesn't gate maintenance of dum itself, but dum's checkout is never the learning project.\nExplain what you proposed and created. You're speaking to the engineer at their desk. Be brief and concrete.`,
    }),
    runQuery,
  );
  try {
    for await (const msg of session) {
      if (msg.type === "system" && msg.subtype === "init") {
        assertSubscription(msg, ["self"]);
        started = true;
        try { writeState(root, SESSION, msg.session_id); } catch { store.note("couldn't save the developer session ID"); }
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") out = block.text;
          if (block.type === "tool_use") store.working(`self: ${block.name.replace(/^mcp__self__/, "")}`);
        }
      }
      if (msg.type === "result") {
        if (!started) throw new Error("Claude answered without reporting its session setup");
        if (msg.subtype === "success") {
          if (msg.is_error) throw new Error(msg.result || "self-change failed");
          completed = true;
          out = msg.result || out;
        } else throw new Error(msg.errors.join("\n") || msg.subtype);
      }
    }
  } finally {
    session.close();
  }
  if (!completed) throw new Error("the developer session ended before it reported a result");
  const lines = [out || "self-change finished", ""];
  if (proposed.length) lines.push(`Proposed, not applied (in ${root}):`, ...proposed.map((p) => `  ${p}`), "Apply them in your editor or with git apply, then run typecheck and tests yourself.");
  if (created.length) lines.push(`New files created: ${created.join(", ")}`);
  if (!proposed.length && !created.length) lines.push("No files were proposed or created.");
  lines.push(":restart loads whatever you've saved in the checkout and restores your session.");
  return lines.join("\n");
}

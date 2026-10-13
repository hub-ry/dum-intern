// Talking to Dum: @mention the bot in #dum or a goal's channel and Dum does what you ask. Each
// message runs Claude Code on hub as Dum's team (src/discord/agents.ts): the Dum you talk to has
// no shell and delegates to a tutor, an engineer and a librarian, each with only its own tools.
// Ryan's user settings load too, so his standing rules (no commits, no pushes) still hold.

import { accessSync, appendFileSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, DENIED_AGENTS } from "./agents.ts";
import { attachmentNotes, turnInput, type SavedAttachment } from "./attachments.ts";

export function prompt(input: { message: string; author: string; place: { kind: "lobby" } | { kind: "goal"; goalId: string; title: string }; attachments?: SavedAttachment[] }): string {
  const where =
    input.place.kind === "goal"
      ? `This is the Discord channel for the goal "${input.place.title}" (goal id ${input.place.goalId}). Unless Ryan names another goal, he means this one.`
      : "This is #dum, the lobby: not tied to one goal. Ask which goal if it matters and isn't clear.";
  const notes = attachmentNotes(input.attachments ?? []);
  const said = input.message.trim() ? `${input.author} says:\n${input.message}` : `${input.author} sent this with no text.`;
  return `${where}\n\n${said}${notes ? `\n\n${notes}` : ""}`;
}

/** The message text without the mentions of the bot itself. */
export function stripMentions(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), " ").replace(/\s+/g, " ").trim();
}

/** Splits a reply into Discord-sized messages, preferring paragraph, then line, then word breaks. */
export function splitReply(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max * 0.5 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : ["…"];
}

/** One Claude session per conversation (a thread, or a channel), keyed by its Discord id. */
export type Sessions = { schemaVersion: 1; channels: Record<string, { sessionId: string; lastAt: string }> };

/** A channel's conversation continues while it's active; after a quiet stretch it starts fresh. */
export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;

export function sessionFor(sessions: Sessions, channelId: string, now: Date): string | null {
  const s = sessions.channels[channelId];
  return s && now.getTime() - Date.parse(s.lastAt) < SESSION_IDLE_MS ? s.sessionId : null;
}

export type RunResult = { text: string; sessionId: string | null; failed: boolean; agents: string[]; tools: string[] };

/** The answer and who did what, from a finished turn. */
export function turnResult(done: { code: number; stdout: string }): RunResult {
  const read = readStream(done.stdout);
  return { ...read, failed: done.code !== 0 || !read.ok };
}

type StreamEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  message?: { content?: { type?: string; name?: string; input?: { subagent_type?: string } }[] };
};

/** What a turn did, read from Claude Code's event stream: the answer, and who used which tools. */
export function readStream(stdout: string): Omit<RunResult, "failed"> & { ok: boolean } {
  let result: StreamEvent | null = null;
  const agents = new Set<string>();
  const tools = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let e: StreamEvent;
    try {
      e = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (e.type === "result") result = e;
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c.type !== "tool_use" || !c.name) continue;
      if ((c.name === "Agent" || c.name === "Task") && c.input?.subagent_type) agents.add(c.input.subagent_type);
      else tools.add(c.name.replace(/^mcp__\w+__/, ""));
    }
  }
  const ok = !!result && !result.is_error && typeof result.result === "string";
  return { ok, text: ok ? result!.result! : "", sessionId: result?.session_id ?? null, agents: [...agents], tools: [...tools] };
}

/** Where a chat turn's shared files wait for its reply. */
export function chatFilesDir(turnDir: string): string {
  return join(turnDir, "files");
}

/**
 * Ryan's Purdue Brightspace (courses, due dates, grades, announcements, syllabus) through
 * brightspace-mcp-server, pinned on hub with its own launcher (see deploy/brightspace). Turns
 * simply go without it until the launcher is installed.
 */
export function brightspaceServer(launcher = process.env.DUM_BRIGHTSPACE_MCP?.trim() || join(homedir(), "opt/brightspace-mcp/bin/brightspace")): Record<string, { command: string; args: string[] }> {
  try {
    accessSync(launcher, constants.X_OK);
  } catch {
    return {};
  }
  return { brightspace: { command: launcher, args: [] } };
}

/**
 * The command for one turn of Dum's team, working in its own repository. Files live in the turn's
 * folder: Ryan's words (for the verbatim check), the team's definitions, and the turn's input
 * (the prompt plus any images Ryan attached), which the command reads on stdin.
 */
export function chatCommand(opts: { claude: string; dumBin: string; repo: string; turnDir: string; goalId: string | null; message: string; attachments?: SavedAttachment[]; resume: string | null; model: string | null }): { bin: string; args: string[]; cwd: string; env: Record<string, string>; stdin: string } {
  const sourceFile = join(opts.turnDir, "source.txt");
  const agentsFile = join(opts.turnDir, "agents.json");
  const inputFile = join(opts.turnDir, "input.jsonl");
  writeFileSync(inputFile, turnInput(opts.message, opts.attachments ?? []), { mode: 0o600 });
  writeFileSync(agentsFile, JSON.stringify(Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { ...a, ...(opts.model ? { model: opts.model } : {}) }]))), { mode: 0o600 });
  const mcp = JSON.stringify({
    mcpServers: {
      // Files Dum shares during the turn wait in its folder and go out with the reply.
      dum: { command: opts.dumBin, args: ["mcp"], env: { DUM_CHAT_SOURCE_FILE: sourceFile, DUM_CHAT_FILES_DIR: chatFilesDir(opts.turnDir), DUM_CHAT_GOAL_ID: opts.goalId ?? "" } },
      codex: { command: opts.dumBin, args: ["codex-mcp"] },
      ...brightspaceServer(),
    },
  });
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(opts.model ? ["--model", opts.model] : []),
    "--agents",
    agentsFile,
    "--agent",
    "dum",
    "--mcp-config",
    mcp,
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    // Only Dum's own team: Claude Code's general-purpose agents would carry the shell to anyone.
    "--disallowedTools",
    DENIED_AGENTS.flatMap((a) => [`Agent(${a})`, `Task(${a})`]).join(","),
    // Ryan's user settings carry his standing rules (the no-commit hook and deny rules).
    "--setting-sources",
    "user,project",
    "--add-dir",
    process.env.HOME ?? "/",
    // Branch from the channel's conversation, so turns running at the same time never share a session.
    ...(opts.resume ? ["--resume", opts.resume, "--fork-session"] : []),
  ];
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "USER"]) if (process.env[k]) env[k] = process.env[k]!;
  return { bin: opts.claude, args, cwd: opts.repo, env, stdin: inputFile };
}

/** One line per turn: who did what. No message text and no tool inputs, so nothing private lands here. */
export function audit(stateDir: string, entry: { at: string; channel: string; failed: boolean; agents: string[]; tools: string[]; ms: number }): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(stateDir, "audit.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
}

/** A quiet footer naming the specialists Dum asked, so Ryan can see who did the work. Denied outsiders don't count. */
export function teamFooter(agents: string[]): string {
  const team = agents.filter((a) => a !== "dum" && a in AGENTS);
  return team.length ? `\n-# asked the ${team.join(" and the ")}` : "";
}

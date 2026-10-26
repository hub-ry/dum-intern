import { commandGap, refusal } from "./match.ts";
import { chatSystem, taskSystem, teachSystem } from "./prompt.ts";
import { words } from "./skilldoc.ts";
import type { Computer, SkillNode } from "./types.ts";
import { obj, str, strList, type Llm, type LlmMessage, type LlmTool, type ToolCall } from "./llm.ts";
import { assertDeskPath, MaritimeError } from "./maritime.ts";

export type AgentEvent =
  | { type: "say"; text: string }
  | { type: "run"; command: string; output: string; error?: boolean }
  | { type: "edit"; path: string; content: string }
  | { type: "propose"; title: string; summary: string; reason: string; prereqs: string[] };

const PLAN: LlmTool = {
  name: "plan",
  description: "Call this before any other tool. List the unlocked skill ids you will follow. If you need a locked, proposed, or missing skill, put it in missing and do not call any other tool.",
  parameters: {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "string" } },
      skillIds: { type: "array", items: { type: "string" } },
      missing: { type: "array", items: { type: "string" } },
    },
    required: ["steps", "skillIds", "missing"],
  },
};

const RUN: LlmTool = {
  name: "run_shell",
  description: "Run a shell command as the desktop user. The working directory is /home/desk/work. Prefer this over clicking.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

const WRITE: LlmTool = {
  name: "write_file",
  description: "Write a UTF-8 text file under /home/desk or /data.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

const READ: LlmTool = {
  name: "read_file",
  description: "Read a UTF-8 text file under /home/desk or /data.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const LIST: LlmTool = {
  name: "list_dir",
  description: "List a directory under /home/desk or /data.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const PROPOSE: LlmTool = {
  name: "propose_skill",
  description: "Propose one skill that is not already on the tree: a better approach or a natural next skill you noticed while working. It stays unused until the teacher explains it. Do not call this for a skill that is already locked or proposed.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      reason: { type: "string" },
      prereqs: { type: "array", items: { type: "string" } },
    },
    required: ["title", "summary", "reason"],
  },
};

const ASK: LlmTool = {
  name: "ask",
  description: "Ask one short clarifying question. Do not teach the topic.",
  parameters: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
};

const READY: LlmTool = {
  name: "ready",
  description: "You can follow the teacher's words. Quote and organize them. Do not add knowledge they did not say.",
  parameters: {
    type: "object",
    properties: {
      recap: { type: "string" },
      markdown: { type: "string" },
    },
    required: ["recap", "markdown"],
  },
};

const TASK_TOOLS = [PLAN, RUN, WRITE, READ, LIST, PROPOSE];

type Stop = { stop: true } | { stop: false; body: unknown };

export async function runTask(options: {
  userText: string;
  history: { role: "user" | "intern"; text: string }[];
  nodes: SkillNode[];
  allowedIds: string[];
  llm: Llm;
  computer: Computer;
  onEvent: (event: AgentEvent) => Promise<void> | void;
}): Promise<void> {
  const messages: LlmMessage[] = [
    { role: "system", content: taskSystem(options.nodes, options.allowedIds) },
    ...options.history.slice(-12).map((item) => ({
      role: item.role === "intern" ? "assistant" as const : "user" as const,
      content: item.text,
    })),
    { role: "user", content: options.userText },
  ];
  let planned = false;
  try {
    for (let round = 0; round < 6; round++) {
      const turn = await options.llm.chat(messages, TASK_TOOLS);
      if (turn.toolCalls.length === 0) {
        await options.onEvent({
          type: "say",
          text: turn.content?.trim() || (planned
            ? "That's as far as I got."
            : "I didn't make a plan, so I didn't touch the computer."),
        });
        return;
      }
      messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls });
      const ordered = [...turn.toolCalls].sort((a, b) => Number(b.name === "plan") - Number(a.name === "plan"));
      let halted = false;
      for (const call of ordered) {
        const result = await dispatch(call, {
          planned,
          nodes: options.nodes,
          computer: options.computer,
          onEvent: options.onEvent,
        });
        if (call.name === "plan" && !result.stop) planned = true;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result.stop ? { error: "stopped" } : result.body).slice(0, 8000),
        });
        if (result.stop) {
          halted = true;
          break;
        }
      }
      if (halted) return;
    }
    await options.onEvent({ type: "say", text: "I stopped after several steps so I wouldn't wander." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model call failed.";
    await options.onEvent({ type: "say", text: `I couldn't finish. ${message} I didn't keep going.` });
  }
}

export async function runTeach(options: {
  node: SkillNode;
  transcript: { role: "user" | "intern"; text: string }[];
  questionsAsked: number;
  llm: Llm;
}): Promise<{ type: "ask"; question: string } | { type: "ready"; recap: string; organized: string }> {
  const turn = await options.llm.chat([
    { role: "system", content: teachSystem(options.node, options.questionsAsked) },
    ...options.transcript.map((item) => ({
      role: item.role === "intern" ? "assistant" as const : "user" as const,
      content: item.text,
    })),
  ], [ASK, READY]);
  const ask = turn.toolCalls.find((call) => call.name === "ask");
  const ready = turn.toolCalls.find((call) => call.name === "ready");
  const question = str(obj(ask?.arguments).question).trim();
  const teacherWords = options.transcript.filter((item) => item.role === "user").map((item) => item.text).join("\n\n");
  if (ask && question && options.questionsAsked < 2 && words(teacherWords).length < 40) {
    return { type: "ask", question: question.slice(0, 400) };
  }
  if (ready || options.questionsAsked >= 2) {
    const recap = str(obj(ready?.arguments).recap).trim() || turn.content?.trim() || "I can follow what you wrote.";
    const organized = str(obj(ready?.arguments).markdown).trim();
    return { type: "ready", recap: recap.slice(0, 600), organized: organized.slice(0, 4000) };
  }
  if (question || turn.content) return { type: "ask", question: (question || turn.content || "Can you say that another way?").slice(0, 400) };
  return { type: "ready", recap: "I can follow what you wrote.", organized: "" };
}

export async function runChat(options: {
  userText: string;
  history: { role: "user" | "intern"; text: string }[];
  nodes: SkillNode[];
  llm: Llm;
}): Promise<string> {
  const turn = await options.llm.chat([
    { role: "system", content: chatSystem(options.nodes) },
    ...options.history.slice(-12).map((item) => ({
      role: item.role === "intern" ? "assistant" as const : "user" as const,
      content: item.text,
    })),
    { role: "user", content: options.userText },
  ]);
  return turn.content?.trim() || "Teach a locked node, or give me a task you've already taught.";
}

async function dispatch(
  call: ToolCall,
  ctx: {
    planned: boolean;
    nodes: SkillNode[];
    computer: Computer;
    onEvent: (event: AgentEvent) => Promise<void> | void;
  },
): Promise<Stop> {
  const args = obj(call.arguments);
  if (call.name !== "plan" && !ctx.planned) {
    return { stop: false, body: { error: "Call plan first. Do not use the computer yet." } };
  }
  if (call.name === "plan") return plan(args, ctx);
  if (call.name === "run_shell") return runShell(str(args.command), ctx);
  if (call.name === "write_file") return writeFile(str(args.path), str(args.content), ctx);
  if (call.name === "read_file") return readFile(str(args.path), ctx);
  if (call.name === "list_dir") return listDir(str(args.path), ctx);
  if (call.name === "propose_skill") return propose(args, ctx);
  return { stop: false, body: { error: `Unknown tool ${call.name}.` } };
}

async function plan(args: Record<string, unknown>, ctx: { nodes: SkillNode[]; onEvent: (event: AgentEvent) => Promise<void> | void }): Promise<Stop> {
  const skillIds = strList(args.skillIds);
  const missing = strList(args.missing);
  const steps = strList(args.steps);
  const bad = [...missing, ...skillIds.map((id) => {
    const node = resolve(id, ctx.nodes);
    return node && node.status !== "unlocked" ? node.title : !node && skillIds.includes(id) ? id : "";
  })].map((item) => item.trim()).filter(Boolean);
  const unique = [...new Set(bad)];
  if (unique.length > 0) {
    const token = unique[0];
    const node = resolve(token, ctx.nodes);
    const title = node?.title ?? token;
    await ctx.onEvent({
      type: "say",
      text: `Plan:\n${formatPlan(steps, "I looked at the task.")}\nThis needs ${title}. I'm stopping before I touch the computer.`,
    });
    await ctx.onEvent({
      type: "say",
      text: node
        ? refusal(node, ctx.nodes)
        : `I can't do that yet. The missing node is ${title} (not taught). Teach it to me and I'll follow your explanation.`,
    });
    return { stop: true };
  }
  const titles = skillIds.map((id) => resolve(id, ctx.nodes)?.title ?? id);
  await ctx.onEvent({
    type: "say",
    text: `Plan:\n${formatPlan(steps, "I'll follow the skills you've taught me.")}\nUsing ${titles.join(", ") || "what you've taught me"}.`,
  });
  return { stop: false, body: { ok: true, skills: skillIds } };
}

async function runShell(
  command: string,
  ctx: { nodes: SkillNode[]; computer: Computer; onEvent: (event: AgentEvent) => Promise<void> | void },
): Promise<Stop> {
  const trimmed = command.trim();
  if (!trimmed) return { stop: false, body: { error: "command is empty" } };
  if (trimmed.length > 4000) return { stop: false, body: { error: "command is too long" } };
  const gap = commandGap(trimmed, ctx.nodes);
  if (gap) {
    const node = ctx.nodes.find((item) => item.title === gap.title);
    await ctx.onEvent({ type: "say", text: `Plan: that command needs ${gap.title}. I'm stopping before I touch the computer.` });
    await ctx.onEvent({
      type: "say",
      text: node
        ? refusal(node, ctx.nodes)
        : `I can't do that yet. The missing node is ${gap.title} (not taught). I won't run that.`,
    });
    if (!node) {
      await ctx.onEvent({
        type: "propose",
        title: gap.title,
        summary: `${gap.title} came up while working, and it is not on the tree.`,
        reason: "I won't use it until you teach it.",
        prereqs: [],
      });
    }
    return { stop: true };
  }
  try {
    const result = await ctx.computer.run(trimmed);
    const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
    await ctx.onEvent({ type: "run", command: trimmed, output, error: result.exitCode !== 0 && result.exitCode !== null });
    return {
      stop: false,
      body: { exitCode: result.exitCode, stdout: clip(result.stdout), stderr: clip(result.stderr) },
    };
  } catch (error) {
    const message = error instanceof MaritimeError ? error.message : error instanceof Error ? error.message : "command failed";
    await ctx.onEvent({ type: "say", text: `The desktop rejected that command. ${message}` });
    return { stop: true };
  }
}

async function writeFile(
  path: string,
  content: string,
  ctx: { nodes: SkillNode[]; computer: Computer; onEvent: (event: AgentEvent) => Promise<void> | void },
): Promise<Stop> {
  if (content.length > 100_000) return { stop: false, body: { error: "content is too long" } };
  if (/dockerfile/i.test(path) && ctx.nodes.find((node) => node.id === "docker-basics")?.status !== "unlocked") {
    await ctx.onEvent({ type: "say", text: "I can't do that yet. The missing node is Docker basics (locked). Teach it to me and I'll follow your explanation." });
    return { stop: true };
  }
  try {
    const safe = assertDeskPath(path);
    await ctx.computer.writeFile(safe, content);
    await ctx.onEvent({ type: "edit", path: safe, content });
    return { stop: false, body: { ok: true, path: safe } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "write failed";
    return { stop: false, body: { error: message } };
  }
}

async function readFile(
  path: string,
  ctx: { computer: Computer },
): Promise<Stop> {
  try {
    const safe = assertDeskPath(path);
    const text = await ctx.computer.readFile(safe);
    return { stop: false, body: { path: safe, content: clip(text) } };
  } catch (error) {
    return { stop: false, body: { error: error instanceof Error ? error.message : "read failed" } };
  }
}

async function listDir(path: string, ctx: { computer: Computer }): Promise<Stop> {
  try {
    const safe = assertDeskPath(path);
    const entries = await ctx.computer.listDir(safe);
    return { stop: false, body: { path: safe, entries } };
  } catch (error) {
    return { stop: false, body: { error: error instanceof Error ? error.message : "list failed" } };
  }
}

async function propose(
  args: Record<string, unknown>,
  ctx: { onEvent: (event: AgentEvent) => Promise<void> | void },
): Promise<Stop> {
  const title = str(args.title).trim();
  const summary = str(args.summary).trim();
  const reason = str(args.reason).trim();
  if (title.length < 3 || summary.length < 3 || reason.length < 3) {
    return { stop: false, body: { error: "title, summary, and reason are required" } };
  }
  await ctx.onEvent({
    type: "propose",
    title: title.slice(0, 80),
    summary: summary.slice(0, 240),
    reason: reason.slice(0, 400),
    prereqs: strList(args.prereqs).slice(0, 6),
  });
  await ctx.onEvent({
    type: "say",
    text: `I added ${title} as a proposed node. ${reason} I won't use it unless you teach it.`,
  });
  return { stop: false, body: { status: "proposed", title } };
}

function formatPlan(steps: string[], empty: string): string {
  if (steps.length === 0) return empty;
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

function resolve(token: string, nodes: SkillNode[]): SkillNode | undefined {
  const needle = token.trim().toLowerCase();
  return nodes.find((node) => node.id === token || node.title.toLowerCase() === needle);
}

function clip(text: string): string {
  return text.length <= 6000 ? text : `${text.slice(0, 6000)}\n[truncated]`;
}

// One prompt, one reply, no conversation.

import { query } from "@anthropic-ai/claude-agent-sdk";

export type Opts = {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  cwd?: string;
  tools?: string[];
  /** Called with a short line whenever a tool is used, for a progress line. */
  onStatus?: (s: string) => void;
};

/** The final text, or "" on any failure - none of these jobs is worth a crash. */
export async function oneShot(prompt: string, o: Opts): Promise<string> {
  let out = "";
  try {
    const session = query({
      prompt,
      options: {
        model: o.model,
        effort: o.effort,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        tools: o.tools ?? [],
        allowedTools: o.tools ?? [],
        // Its whole job is this prompt. Their CLAUDE.md has no business here.
        settingSources: [],
        thinking: { type: "disabled" },
      },
    });
    for await (const msg of session as AsyncIterable<any>) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) {
          if (b.type === "text" && b.text) out = b.text;
          if (b.type === "tool_use") {
            const p = b.input?.file_path ?? b.input?.pattern ?? b.input?.query ?? "";
            if (p) o.onStatus?.(`${String(b.name).toLowerCase()} ${String(p).replace((o.cwd ?? "") + "/", "")}`);
          }
        }
      }
      if (msg.type === "result" && typeof msg.result === "string" && msg.result) out = msg.result;
    }
  } catch {
    return "";
  }
  return out;
}

/**
 * The first JSON value of the given shape in a reply, tolerating a fence or a sentence around
 * it.
 */
export function json(text: string, open: "[" | "{"): unknown {
  const close = open === "[" ? "]" : "}";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

import { chatCompletionsUrl } from "./config.ts";

export type LlmTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type LlmTurn = {
  content: string | null;
  toolCalls: ToolCall[];
};

export interface Llm {
  chat(messages: LlmMessage[], tools?: LlmTool[]): Promise<LlmTurn>;
}

type WireToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
};

export function createLlm(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}): Llm {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async chat(messages, tools = []) {
      const body: Record<string, unknown> = {
        model: options.model,
        temperature: 0.3,
        messages: messages.map(toWire),
      };
      if (tools.length > 0) {
        body.tools = tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        body.tool_choice = "auto";
      }
      const response = await fetchImpl(chatCompletionsUrl(options.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Model request failed (${response.status}): ${text.slice(0, 500)}`);
      }
      const parsed = JSON.parse(text) as {
        choices?: { message?: { content?: unknown; tool_calls?: WireToolCall[] } }[];
      };
      const message = parsed.choices?.[0]?.message;
      if (!message) throw new Error("The model returned no choices.");
      return {
        content: typeof message.content === "string" ? message.content : null,
        toolCalls: (message.tool_calls ?? []).map(readToolCall).filter((call): call is ToolCall => call !== null),
      };
    },
  };
}

function toWire(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.tool_call_id, content: message.content ?? "" };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

function readToolCall(call: WireToolCall): ToolCall | null {
  const name = call.function?.name;
  if (!name) return null;
  return {
    id: call.id || `call_${name}`,
    name,
    arguments: parseArgs(call.function?.arguments),
  };
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { _raw: value };
  }
}

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

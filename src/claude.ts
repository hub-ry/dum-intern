// The model wrapper.
//
// Shells out to the `claude` CLI in headless mode rather than calling the API
// directly. No API key to manage - it reuses the auth you already have - and it
// keeps dum-intern one kind of thing: a program that drives an agent CLI.

import { execFileSync } from "node:child_process";

const MODEL = "claude-opus-5";

/** Run the CLI headlessly and return the assistant's text. */
export function ask(prompt: string): string {
  let raw: string;
  try {
    raw = execFileSync("claude", ["-p", "--output-format", "json", "--model", MODEL], {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`claude CLI failed: ${e.stderr?.trim() || e.message}`);
  }

  const envelope = JSON.parse(raw) as { is_error: boolean; result?: string };
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`claude returned an error envelope: ${raw.slice(0, 400)}`);
  }
  return envelope.result;
}

/**
 * Models like to wrap JSON in prose or a ```json fence even when told not to.
 * Rather than fight that, take the outermost bracketed span and parse it.
 */
export function extractJson<T>(text: string): T {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (start === -1 || end <= start) {
    throw new Error(`no JSON found in response:\n${text.slice(0, 400)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

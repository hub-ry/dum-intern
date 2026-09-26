// Fill the tree from code you wrote yourself.
//
// An empty tree means dum asks about everything, and the first sessions pay for
// every skill you already had before dum existed. So you can point it at
// projects you say you wrote without AI, and it reads them for the concepts
// the code actually rests on.
//
// What it finds is a claim, not proof. You say you wrote it; nobody watched.
// So nothing lands as known: each one is claimed, and the first build that
// leans on it gets one short check. And nothing lands at all until you have
// read the list and dropped what you don't actually own - a scan that reads a
// vendored library or a file a friend wrote would otherwise hand you their
// skills.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as skills from "./skills.ts";

const MODEL = "claude-sonnet-5";
const TOOLS = ["Read", "Glob", "Grep"];

export type Found = skills.Claim & {
  /** Where it shows, as `path:line - what`, so you can judge the claim. */
  evidence: string;
};

const Found = z.object({
  name: z.string().min(1),
  breadth: z.enum(["general", "niche"]).catch("general"),
  requires: z.array(z.string()).catch([]),
  evidence: z.string().catch(""),
});

function prompt(tree: skills.Tree): string {
  const names = tree.skills.map((s) => s.name);
  return `The engineer says they wrote the project in this directory themselves, by hand.
Read it and list the concepts the code shows they hold.

- Start with the file list, then read the files that carry the logic. Skip
  vendored code, generated files, lockfiles, and config boilerplate.
- A concept counts only if the code USES it in a way you'd have to understand
  to write: a context manager they defined, not one import line; a join with a
  real condition, not a connection string.
- Name the CONCEPT, not what this code does with it. Two to four words, the
  way an engineer says it out loud and would search for it: "python context
  managers", "sql joins", "rust ownership", "floating point comparison". Not
  "manual thousands-separator formatting" or "hand-derived test oracles" -
  those describe one file, and nobody else's tree would ever reuse them.${
    names.length
      ? `\n- These are already on their tree. Reuse the exact name when it's the same idea:\n  ${names.join(", ")}`
      : ""
  }
- breadth: general if it carries across projects, niche if it's one library's
  quirk or a one-off format.
- requires: up to three concepts it builds on directly, by name.
- evidence: ONE place it shows, as "path:line - what the code does there".
- Fewer is better. Only concepts that would take a real explanation - the ones
  you'd expect an interviewer to ask about. A small project usually shows
  three to eight. Never more than 20.

Reply with ONLY a JSON array, no prose and no code fence:
[{"name": "...", "breadth": "general", "requires": ["..."], "evidence": "src/x.py:12 - ..."}]`;
}

/** The first JSON array in a reply, tolerating a fence or a sentence around it. */
export function parse(text: string): Found[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Found[] = [];
  for (const r of raw) {
    const f = Found.safeParse(r);
    if (!f.success || !skills.key(f.data.name)) continue;
    if (out.some((o) => skills.key(o.name) === skills.key(f.data.name))) continue;
    out.push({
      name: f.data.name.trim(),
      breadth: f.data.breadth,
      requires: f.data.requires.map((x) => x.trim()).filter(Boolean).slice(0, 3),
      evidence: f.data.evidence.trim(),
      why: "",
    });
  }
  return out;
}

/** A folder that exists and is a directory, resolved, or why not. */
export function checkDir(dir: string): { path: string } | { error: string } {
  const path = resolve(dir);
  if (!existsSync(path)) return { error: `${dir} doesn't exist` };
  if (!statSync(path).isDirectory()) return { error: `${dir} isn't a folder` };
  return { path };
}

/** Read one project and return what it shows. Empty on any failure - a scan is never worth a crash. */
export async function scan(dir: string, tree: skills.Tree, onStatus?: (s: string) => void): Promise<Found[]> {
  let out = "";
  try {
    const session = query({
      prompt: prompt(tree),
      options: {
        model: MODEL,
        cwd: dir,
        tools: TOOLS,
        allowedTools: TOOLS,
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
            const p = b.input?.file_path ?? b.input?.pattern ?? "";
            if (p) onStatus?.(`${b.name.toLowerCase()} ${String(p).replace(dir + "/", "")}`);
          }
        }
      }
      if (msg.type === "result" && typeof msg.result === "string" && msg.result) out = msg.result;
    }
  } catch {
    return [];
  }
  return parse(out);
}

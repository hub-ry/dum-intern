// Scoring a scripted session: what the transcript and the files say about it.
// Pure, so the checks are testable without spending a real session.

import { z } from "zod";
import * as todos from "./todos.ts";
import type { Entry } from "./store.ts";

export const Scenario = z.object({
  name: z.string(),
  why: z.string().default(""),
  request: z.string(),
  mode: z.enum(["understand", "anti-vibe"]).default("understand"),
  tree: z
    .array(
      z.object({
        name: z.string(),
        state: z.enum(["solid", "shaky", "claimed"]).default("solid"),
        lang: z.string().optional(),
        shownIn: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  files: z.record(z.string(), z.string()).default({}),
  /** What to say to every question. */
  answer: z.string().default("idk"),
  /** Type this into the first hole and say done. */
  type: z.string().optional(),
  expect: z
    .object({
      noBuild: z.boolean().optional(),
      maxQuestions: z.number().optional(),
      maxReplyLines: z.number().optional(),
      minHoles: z.number().optional(),
      maxHoles: z.number().optional(),
      maxFills: z.number().optional(),
      minCodeLines: z.number().optional(),
      maxCodeLines: z.number().optional(),
      reviewPasses: z.boolean().optional(),
    })
    .default({}),
});
export type Scenario = z.infer<typeof Scenario>;

export type Run = {
  transcript: string;
  /** dum's own record (DUM_TRANSCRIPT), exact where the text above is drawn. */
  entries?: Entry[];
  /** Files dum wrote (path -> content), before anything was typed. */
  written: Record<string, string>;
  /** Holes still open when the session ended. */
  openHoles: number;
  timedOut: boolean;
};

export type Facts = {
  questions: number;
  specShown: boolean;
  holes: number;
  fills: number;
  codeLines: number;
  replyLines: number;
  longestComment: number;
};

const SYSTEM = /^(·|▌|✓|⊘|✗|│|╭|╰|\+ skill|›|>|build this|dum is |▛▚▘|it builds what|answer it|your turn|next up|what do you want|not yet:|feature \d|milestone \d|\$ |⚖|\s{2,}│)/;

/** What happened, read off the transcript and the files. */
export function facts(run: Run): Facts {
  const lines = run.transcript.split("\n").map((l) => l.trim());
  const specAt = lines.findIndex((l) => l.startsWith("╭─ spec"));
  const approvedAt = lines.findIndex((l) => /^build this\? \[y\/N\] y/.test(l));
  const before = specAt < 0 ? lines : lines.slice(0, specAt);
  const after = approvedAt < 0 ? lines : lines.slice(approvedAt + 1);
  const code = Object.entries(run.written).reduce((n, [path, text]) => {
    const inHole = new Set<number>();
    for (const [a, b] of todos.spans(text)) for (let i = a; i <= b; i++) inHole.add(i);
    const comment = /^(\/\/|\/\*|\*|#(?!include|define|if|else|endif|pragma|import)|--)/;
    return n + text.split("\n").filter((l, i) => l.trim() && !inHole.has(i) && !comment.test(l.trim())).length;
  }, 0);
  let longest = 0;
  for (const text of Object.values(run.written)) {
    let n = 0;
    for (const l of text.split("\n")) {
      if (l.includes(todos.MARKER)) n = 0;
      else if (/^\s*(\/\/|#(?!include)|--)/.test(l)) longest = Math.max(longest, ++n);
      else n = 0;
    }
  }
  const drawn = {
    questions: before.filter((l) => l.startsWith("answer it · idk · type it")).length,
    specShown: specAt >= 0,
    holes: lines.filter((l) => l.startsWith("▌ hole")).length,
    fills: lines.filter((l) => /^✓ fill\b/.test(l)).length,
    codeLines: code,
    replyLines: after.filter((l) => l && !SYSTEM.test(l) && !l.startsWith("[")).length,
    longestComment: longest,
  };
  return run.entries ? { ...drawn, ...fromEntries(run.entries) } : drawn;
}

/** Lines at the pane's width, as the TUI would wrap them. */
const WIDTH = 78;
const height = (text: string) => text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / WIDTH)), 0);

/**
 * The same facts off dum's own record. Reply length is what dum itself said
 * after the spec was approved (or in all, if there was none) - not the
 * wizard, not notes, not tool lines.
 */
export function fromEntries(es: Entry[]): Pick<Facts, "questions" | "specShown" | "holes" | "fills" | "replyLines"> {
  const spec = es.findIndex((e) => e.kind === "spec");
  const approved = es.findIndex((e) => e.kind === "spec" && e.approved);
  const asked = (spec < 0 ? es : es.slice(0, spec)).filter((e) => e.kind === "question" && e.question && e.why);
  const said = (approved < 0 ? es : es.slice(approved + 1)).filter((e): e is Extract<Entry, { kind: "say" }> => e.kind === "say");
  return {
    questions: asked.length,
    specShown: spec >= 0,
    holes: es.filter((e) => e.kind === "tool" && e.name === "hole").length,
    fills: es.filter((e) => e.kind === "fill").length,
    // The longest single thing it said: one wall of text is the problem, not the sum.
    replyLines: Math.max(0, ...said.map((e) => height(e.text))),
  };
}

export type Check = { name: string; ok: boolean; saw: string };

/** Things dum must never say, whatever the scenario. From their taste and today's bugs. */
const NEVER: [RegExp, string][] = [
  [/\bgate-sized\b|\bfill_todo\b|\bthe gate\b/i, "names dum's machinery"],
  [/refused - outside the repo/, "blames the repo boundary for a different refusal"],
  [/there is no tool to (clear|reset)/i, "says the tree can't be reset"],
];

export function checks(s: Scenario, run: Run): Check[] {
  const f = facts(run);
  const e = s.expect;
  const out: Check[] = [];
  const add = (name: string, ok: boolean, saw: string | number) => out.push({ name, ok, saw: String(saw) });
  if (run.timedOut) add("finished", false, "timed out");
  if (e.noBuild) add("builds nothing", !f.specShown && !Object.keys(run.written).length, `${Object.keys(run.written).length} files`);
  if (e.maxQuestions !== undefined) add(`at most ${e.maxQuestions} questions before the spec`, f.questions <= e.maxQuestions, f.questions);
  if (e.maxReplyLines !== undefined) add(`no reply over ${e.maxReplyLines} lines`, f.replyLines <= e.maxReplyLines, f.replyLines);
  if (e.minHoles !== undefined) add(`at least ${e.minHoles} holes`, f.holes >= e.minHoles, f.holes);
  if (e.maxHoles !== undefined) add(`at most ${e.maxHoles} holes`, f.holes <= e.maxHoles, f.holes);
  if (e.maxFills !== undefined) add(`at most ${e.maxFills} fills`, f.fills <= e.maxFills, f.fills);
  if (e.minCodeLines !== undefined) add(`dum wrote at least ${e.minCodeLines} code lines`, f.codeLines >= e.minCodeLines, f.codeLines);
  if (e.maxCodeLines !== undefined) add(`dum wrote at most ${e.maxCodeLines} code lines`, f.codeLines <= e.maxCodeLines, f.codeLines);
  if (e.reviewPasses) add("review passes", run.openHoles === 0 && /\+ skill|passed|looks right|correct/i.test(run.transcript), `${run.openHoles} open`);
  add("comments at most 3 lines in a row", f.longestComment <= todos.MAX_COMMENT_RUN, f.longestComment);
  for (const [re, what] of NEVER) {
    const hit = re.exec(run.transcript);
    add(`never ${what}`, !hit, hit ? JSON.stringify(hit[0]) : "-");
  }
  return out;
}

/** The judge's prompt: their taste, the scenario, and what happened. */
export function judgePrompt(taste: string[], s: Scenario, run: Run): string {
  const files = Object.entries(run.written)
    .map(([p, t]) => `--- ${p}\n${t.slice(0, 3000)}`)
    .join("\n\n");
  return `You grade one scripted session of dum, a coding tool that won't write what
the user can't explain. Grade it against the user's own taste, below, and
nothing else. Be strict: they wrote these rules because it got them wrong.

THEIR TASTE
${taste.map((t) => `- ${t}`).join("\n") || "(none yet)"}

WHAT'S INTENDED - don't mark these down
- TODO(dum) comment blocks in their files are the product: holes for them to
  type. They're not leaked internals.
- A "wizard" lesson after they say idk is an explanation they asked for. The
  comment rule is about comments in code.
- This is the plain renderer. In the real UI, code dum writes streams into a
  file pane as it's written; here that shows only as "· Write <file>". Judge
  what was written, not whether it animated.

THE SCENARIO: ${s.name}
${s.why}
They asked: ${s.request}

TRANSCRIPT (plain mode; [DRIVER] lines are the script answering)
${run.transcript.slice(-9000)}

FILES DUM WROTE
${files || "(none)"}

Reply with ONLY JSON, no prose:
{"score": 1-5, "broke": ["the taste rule, quoted, and where"], "best": "one line on what worked"}`;
}

export const Verdict = z.object({
  score: z.number().min(1).max(5),
  broke: z.array(z.string()).catch([]),
  best: z.string().catch(""),
});
export type Verdict = z.infer<typeof Verdict>;

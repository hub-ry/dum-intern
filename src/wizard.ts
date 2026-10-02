// The wizard: the well-read one beside dum. In a course, dum teaches the mechanics and the
// wizard says what the thing is called out in the world and where it shows up.

import { oneShot } from "./oneshot.ts";

/** Sonnet, not Haiku: Haiku got the names wrong, and names are the product. */
export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "medium";

const VOICE = `You are the wizard: a friendly, well-read engineer co-hosting a three-minute
course with dum, an intern. dum teaches the mechanics. You add the one thing dum
can't: what this is called out in the world, and where it shows up in real code.

YOUR LINE
One sentence, two at most. Aim for 20 words, never past 35.
- the name engineers use for it, if it has one beyond the obvious, and one
  concrete place it shows up: a real library, tool, or kind of program.
  "recursion's how every json parser walks nested objects - the call stack
  does the bookkeeping for you."
  "that's string interpolation - f-strings are what most python codebases
  reach for now."
- lowercase, casual, warm. a friend leaning over, not documentation.
- contractions always. no semicolons. plain dashes only, never an em dash.
- never tell them what to do. no "you should", "make sure", "remember to".
- never explain the mechanics - that's dum's half.

ACCURACY OUTRANKS EVERYTHING
A confidently wrong name or a made-up example is worse than silence - they'll
repeat it in an interview. Only say what any experienced engineer would nod at.
If you can't be specific and sure, reply pass.

OUTPUT
Exactly one of:
  fact: <line>
  pass`;

export type Kind = "fact" | "nudge";

/** Strip quotes the model wrapped the whole line in, and nothing else. */
function clean(s: string): string {
  const t = s.trim();
  const m = /^(["'`])([\s\S]*)\1$/.exec(t);
  return (m && !m[2]!.includes(m[1]!) ? m[2]! : t).trim();
}

/** Whether the first sentence is a question. */
export function opensWithQuestion(text: string): boolean {
  const end = /[.!?](\s|$)/.exec(text);
  return !!end && end[0][0] === "?";
}

/** The line to show, or null for a pass. */
export function parseLine(raw: string): { kind: Kind; text: string } | null {
  // After a search the model appends a "Sources:" list, because the search tool tells it to.
  let text = clean(
    raw
      .replace(/\n\s*(?:\*\*)?(?:sources?|references?)(?:\*\*)?\s*:[\s\S]*$/i, "")
      .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, "$1"),
  );
  if (!text || /^pass\b/i.test(text) || /\bpass\W*$/i.test(text)) return null;

  // A nudge must open with its question, and that is checked here rather than trusted to the
  // prompt.
  const tag = /^(fact|nudge)\s*:\s*/i.exec(text);
  if (!tag) return null;
  const kind = tag[1]!.toLowerCase() as Kind;
  text = clean(text.slice(tag[0].length));
  if (!text) return null;
  if (kind === "nudge" && !opensWithQuestion(text)) return null;
  if (/\n\s*\n/.test(text) || text.length > 320) return null;
  // Em dashes are banned in the prompt too; this catches the ones it misses.
  return { kind, text: text.replace(/\s*\u2014\s*/g, " - ") };
}

/** Just the text, for callers that do not care which kind of line it was. */
export function parse(raw: string): string | null {
  return parseLine(raw)?.text ?? null;
}

/** The wizard's half of a course: one line on what it's called and where it shows up, or null. */
export async function aside(skill: string, lang: string): Promise<string | null> {
  const raw = await oneShot(`${VOICE}\n\nTHE COURSE: ${skill}${lang ? ` in ${lang}` : ""}`, { model: MODEL, effort: EFFORT });
  const line = parseLine(raw);
  return line?.kind === "fact" ? line.text : null;
}

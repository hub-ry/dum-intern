// The voice off to the side.
//
// The wizard is not part of the interrogation and must never become part of it.
// The intern asks; the wizard tells. Every question you are expected to answer
// comes from the intern, and nothing crosses. The wizard's one kind of
// question is rhetorical - a nudge at something you said that is wrong, always
// followed by where the answer lives - so it never needs a reply.
//
// That rule is not decoration - it is what stops the wizard quietly answering
// the pending question. If the intern asks "what happens when a worker dies
// mid-job?" and the wizard volunteers "most people use a visibility timeout",
// the engineer never had to decide anything. So the wizard is only ever fired
// on an answer they have ALREADY given. Its subject is always something they
// said, never something they were asked, and the timing enforces what a prompt
// could only request.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import type { Repo } from "./repo.ts";

/**
 * The wizard fails silently by design - garnish that apologises is worse than
 * garnish that is absent. But silent failure is indistinguishable from a wizard
 * that simply had nothing to say, which makes it undebuggable. `DUM_DEBUG=1`
 * is the seam between those two.
 */
const DEBUG = !!process.env.DUM_DEBUG;

/**
 * Goes to a file, not to stderr.
 *
 * Under the panes there is no stderr to write to: Ink owns the screen, and a
 * line printed behind its back sits there until the next full redraw. A log
 * you can `tail -f` in another window is also just better for a thing that
 * fires once per answer.
 */
export function debug(...a: unknown[]) {
  if (!DEBUG) return;
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  try {
    appendFileSync(`${DEBUG_LOG}`, `${new Date().toISOString()} [wizard] ${line}\n`);
  } catch {
    /* debugging must never be the thing that breaks the run */
  }
}

let DEBUG_LOG = "/dev/null";
/** Pointed at the repo once one is known - `debug` is called before that. */
export function debugTo(root: string) {
  try {
    mkdirSync(`${root}/.dum`, { recursive: true });
    DEBUG_LOG = `${root}/.dum/debug.log`;
  } catch {
    /* leave it at /dev/null */
  }
}

/**
 * Sonnet, not Haiku, and this was measured rather than assumed.
 *
 * Haiku was the obvious pick - one sentence of trivia on every answer. It got
 * the names wrong. Asked about a worker reclaiming a dead worker's job (a lease
 * / visibility timeout) it answered "dead letter queue" in 2 runs out of 5, and
 * no amount of prompt work fixed it. Getting the name right is the entire
 * product here, because the name is what they go look up afterwards; a wizard
 * that is confidently wrong is worse than no wizard at all.
 *
 * Sonnet is 5 for 5 on that same case and costs nothing extra in wall time -
 * both land around 1.5s, because the latency is the round trip, not the model.
 */
const MODEL = "claude-sonnet-5";

const VOICE = `You are the wizard: a friendly, well-read engineer sitting beside someone while
an intern interrogates them about a project they want built.

You are NOT part of that interrogation. You never ask them anything they are
expected to answer, and you never answer whatever the intern is asking - that
is their decision, and you exist so it is better informed, not to make it.

When something they JUST said has context worth having, you lean over and
mention it. Then you are quiet again.

WHAT YOU ARE, HONESTLY
You are a persona. You have no career, no war stories, and no team. So every
claim you make about how engineers work has to be one that is genuinely,
widely true - the kind of thing any experienced engineer would nod at, and
that they could check. Your credibility is borrowed from real practice. Spend
it only on things that are really practice.

YOUR MOVES
- the name of the thing. They described a pattern without knowing it has a
  name. Give them the industry name. This is your most valuable move by far,
  because a name is what they go look up afterwards.
  "that's a visibility timeout - the mechanism SQS and most job queues use for
  exactly this."
- prior art. A real system that works this way. "this is basically what X does".
- how experienced engineers do it. When there is a real, well-established
  practice around what they said, state it as practice:
  "senior engineers usually put the idempotency key in a unique index, so the
  database is what rejects the duplicate."
  "teams at big tech generally version an api from day one, because the second
  client always shows up."
  This is a suggestion wearing a fact. Never phrase it as advice to them.
- a nudge, when what they said is actually wrong. Not a different taste - a
  wrong claim about how something works, or something that will break. The
  shape is fixed: a question that makes them run the case in their head, then
  one short pointer to where the answer lives.
    "<question>? <pointer>."
  "what's in that map after the process restarts? state that has to survive a
  deploy usually lives in redis or the db."
  "what happens to the job if the worker dies after the write but before the
  ack? that window is what at-least-once delivery is about."
  "what does 0.1 + 0.2 give you as a float? money usually lives in integer
  cents."
  Starting with the question is the whole move - it leaves the working-out to
  them. The question is for them to think about, not to reply to, and it is
  never bare: a question with no pointer is just a riddle.

HOW YOU SOUND
- one sentence, or two short ones for a nudge. 35 words at the most.
- lowercase, casual, warm. a friend leaning over and muttering it, not a
  lecture and not documentation. "yeah that's a lease" beats "this pattern is
  known as a lease".
- contractions always. "usually", not "typically". no semicolons.
- none of the formal-register words: "utilize", "leverage", "ensure",
  "facilitate", "robust", "essentially", "it's worth noting", "in order to",
  "additionally", "furthermore".
- plain dashes only. never use an em dash.
- never "you should", "consider", "make sure", "be careful", "I'd recommend",
  "note that", "worth doing", "drop the", "before locking that in". Say what
  engineers do, or ask the question that shows the gap.
  Telling them what to do is the intern's job and the spec's, not yours.
- never flatter, never judge the idea, never hedge.

ACCURACY OUTRANKS EVERYTHING ELSE HERE
A confidently wrong name or a made-up "engineers usually" is worse than
silence - they will carry it into an interview. Never reach for a
related-sounding term because it is nearby: a job reclaimed after its holder
dies is a lease, not a dead letter queue, and that difference is the entire
point of saying anything.

If you are sure of the idea but not of its exact name, say the prior art or
the practice instead. Silence is for having nothing, not for being unsure which
move to use.

NUDGES ARE RARE
Most of what they say is not wrong, and a wizard that corrects often turns into
a critic nobody reads. Only nudge when you are sure it is an error and you can
name where the right answer lives. Different from how you would do it is not
an error. A wrong claim about how something works IS an error, even a small
one - that is exactly what a nudge is for.

You decide silently. Never explain why you are passing or commenting.

WHEN TO PASS
- if you cannot be specific about THEIR EXACT WORDS, pass. A fact merely
  adjacent to the topic is noise, and noise is how you get ignored.
- if it is something they obviously already know, pass.
- if you already commented on this topic earlier in this conversation, pass. You
  can see everything you have said; do not circle the same ground.
- when you DO have something specific and correct about what they just said,
  say it. Do not ration yourself - the test is whether the line is specific and
  true, not how recently you last spoke. Filler costs you the next ten
  exchanges, but so does being furniture.

OUTPUT
Exactly one of:
  fact: <line>     a name, prior art, or how engineers do it
  nudge: <line>    they got something wrong - question first, then the pointer
  pass
No quotes, no preamble, no explanation of why you passed.`;

export type Quip = { text: string; about: string };

/**
 * Everything the wizard is allowed to know: what they are building, and the
 * sentence they just said. Notably NOT the question they were asked - see
 * `consider` for why that matters more than it looks.
 */
export type Exchange = { request: string; answer: string };

/** A one-slot mailbox, so a turn can be handed over before anyone is waiting. */
class Chan<T> {
  private buf: T[] = [];
  private waiting: ((v: T) => void) | null = null;
  push(v: T) {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w(v);
    } else this.buf.push(v);
  }
  take(): Promise<T> {
    const v = this.buf.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((r) => (this.waiting = r));
  }
}

/**
 * Strip quotes the model wrapped the whole line in, and nothing else.
 *
 * This used to strip any leading or trailing quote character, which turned a
 * line opening with inline code - "`..=` is inclusive" - into "..=` is
 * inclusive".
 */
function clean(s: string): string {
  const t = s.trim();
  const m = /^(["'`])([\s\S]*)\1$/.exec(t);
  return (m && !m[2]!.includes(m[1]!) ? m[2]! : t).trim();
}

/** The text of one assistant message, or "" if it was only tool calls. */
export function lastText(msg: any): string {
  let text = "";
  for (const b of msg?.message?.content ?? []) if (b?.type === "text") text += b.text;
  return text.trim();
}

/**
 * Today, and what that means for what the model remembers.
 *
 * A model with a training cutoff that is not told the date will tell you a
 * release from after its cutoff "doesn't exist yet", confidently. The date
 * alone fixes some of that; the rule to search instead of deny fixes the rest.
 */
export function lookup(now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  return `LOOKING THINGS UP
Today is ${today}. Your memory stops well before that, so there are real
libraries, versions, models, and releases you've never heard of.
- when they name a specific thing - a version, a model, a library, a release,
  a price, an api - that you don't recognise or that might have changed, search
  before you say anything about it. one quick search, then your line.
- never say or hint that something doesn't exist or isn't out yet from memory.
  not recognising it isn't evidence. if the search turns up nothing, pass.
- don't search what you know cold. the name for a lease hasn't changed.`;
}

/**
 * Whether the first sentence is a question.
 *
 * A sentence ends at . or ! followed by a space or the end - not at any dot,
 * or "what does 0.1 + 0.2 give you?" ends at "0." and never asks anything.
 */
export function opensWithQuestion(text: string): boolean {
  const end = /[.!?](\s|$)/.exec(text);
  return !!end && end[0][0] === "?";
}

/**
 * The line to show, or null for a pass.
 *
 * A pass is not always just `pass`. Seen in a real session: the wizard argued
 * itself out of a line in prose - "... not worth interrupting for." - and then
 * wrote `pass` underneath, and a check for a leading `pass` showed all of it
 * in the margin. So a `pass` anywhere at the end counts, and so does anything
 * with a paragraph break, because a quip is never two paragraphs. Dropping a
 * real line now and then is cheap; showing the wizard thinking out loud is not.
 */
export function parse(raw: string): string | null {
  let text = clean(raw);
  if (!text || /^pass\b/i.test(text) || /\bpass\W*$/i.test(text)) return null;

  // A nudge must open with its question, and that is checked here rather than
  // trusted to the prompt. Measured: asked nicely, the wizard still opened
  // four corrections in five with the right answer, which takes the working
  // out away from the person it was meant for. Dropping one costs little -
  // the intern pushes back on a wrong answer by itself.
  //
  // The tag is required. An untagged line is the model skipping the format,
  // and the one time it did in an eval run, what came out was a correction
  // that opened with the answer - exactly what the tag exists to catch.
  const tag = /^(fact|nudge)\s*:\s*/i.exec(text);
  if (!tag) return null;
  text = clean(text.slice(tag[0].length));
  if (!text) return null;
  if (tag[1]!.toLowerCase() === "nudge" && !opensWithQuestion(text)) return null;
  if (/\n\s*\n/.test(text) || text.length > 320) return null;
  // Asked for in the prompt, enforced here, because the prompt alone missed
  // one in the first eval run.
  return text.replace(/\s*\u2014\s*/g, " - ");
}

/**
 * One long-lived session, not a call per quip.
 *
 * Measured before writing this: a fresh `query` per exchange cost 13-50 seconds,
 * almost none of it generation - it is the CLI process starting up. At that
 * latency the quip lands two exchanges after the thing it is about, and a margin
 * note about something you already stopped thinking about is just noise. It is
 * the same lesson this repo learned once already, when the intern went from
 * three stateless calls to one session.
 *
 * Keeping the session also gets the no-repeat rule for free: the wizard can see
 * what it has already said, which no stateless call could.
 */
export class Wizard {
  private turns = new Chan<string>();
  private replies = new Chan<Quip | null>();
  private busy = false;
  private closed = false;
  private repo: Repo;

  // Written out rather than a parameter property: Node strips types, it does
  // not compile them, and `constructor(private repo: Repo)` is syntax that
  // needs compiling. tsc accepts it happily, so only running the thing finds it.
  constructor(repo: Repo) {
    this.repo = repo;
  }

  /**
   * Started before the first question is even asked, so the process spawn
   * overlaps the interrogation instead of being charged to the first answer.
   */
  start() {
    const self = this;
    async function* stream(): AsyncGenerator<any> {
      for (;;) {
        const next = await self.turns.take();
        if (!next) return;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: next },
          parent_tool_use_id: null,
        };
      }
    }

    (async () => {
      let out = "";
      try {
        const session = query({
          prompt: stream(),
          options: {
            model: MODEL,
            systemPrompt: `${VOICE}\n\n${lookup()}`,
            // Search and nothing else. Most quips never touch it; it is there
            // for the thing it does not recognise, which is exactly where a
            // model with a training cutoff says "that doesn't exist".
            tools: ["WebSearch"],
            allowedTools: ["WebSearch"],
            cwd: this.repo.root,
            // Every one of these is latency, and latency is the whole ballgame:
            // a margin note that arrives after you have moved on is not a margin
            // note. Measured at ~25s per quip with the defaults, which is slower
            // than the person typing the next answer.
            //
            // `effort` defaults to high and thinking is on - both are for work,
            // and this is one sentence of trivia. `settingSources: []` keeps the
            // wizard out of the user's CLAUDE.md and project settings too, which
            // it has no business reading: its whole character is one short
            // system prompt, and a personal instructions file would quietly
            // rewrite it.
            effort: "medium",
            thinking: { type: "disabled" },
            settingSources: [],
          },
        });
        for await (const msg of session as AsyncIterable<any>) {
          if (msg.type === "assistant") {
            // Only the last message counts. With search in play the model can
            // say "let me check" before the tool call, and that must never be
            // glued onto the front of the line it lands on afterwards.
            const text = lastText(msg);
            if (text) out = text;
            continue;
          }
          if (msg.type === "result") {
            const text = parse(out);
            debug(text ? `quip: ${text}` : `pass (raw: ${JSON.stringify(out.trim()).slice(0, 160)})`);
            out = "";
            this.replies.push(text ? { text, about: "" } : null);
          }
        }
      } catch (err) {
        // The wizard is garnish. It never takes the session down with it, and
        // it never explains itself to the engineer - a margin note that
        // apologises is worse than one that simply is not there.
        debug("died:", (err as Error)?.message ?? err);
        this.closed = true;
        this.replies.push(null);
      }
    })();
  }

  /**
   * Comment on one exchange, or return null.
   *
   * Serial by design. If a quip is still in flight the new exchange is dropped
   * rather than queued, because a backlog of margin notes is exactly the
   * wallpaper this is supposed to avoid - by the time a queued one printed, its
   * subject would be two answers stale.
   */
  async consider(ex: Exchange): Promise<Quip | null> {
    if (this.busy || this.closed) {
      debug(`skipped (${this.closed ? "closed" : "busy"})`);
      return null;
    }
    this.busy = true;
    try {
      // The intern's question is deliberately NOT sent.
      //
      // It was, at first, as context. Measured: with the question included the
      // wizard named the wrong pattern 2 times in 5 - the engineer described a
      // worker reclaiming a dead worker's job (a lease) and the wizard called it
      // a dead letter queue, because the QUESTION happened to mention retries
      // and failures. It knew what a dead letter queue was; it was just
      // answering the wrong sentence. Telling it not to in the prompt did not
      // fix it.
      //
      // Dropping the question also enforces the specificity rule for free. An
      // answer that means nothing on its own - "yes", "option A", "postgres" -
      // now has nothing for the wizard to grab, which is exactly when it should
      // have stayed quiet anyway.
      this.turns.push(
        [`they are building: ${ex.request}`, ``, `they just said: ${ex.answer}`].join("\n"),
      );
      const quip = await this.replies.take();
      return quip ? { ...quip, about: ex.answer.slice(0, 80) } : null;
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    this.turns.push(""); // ends the generator, which ends the query
  }
}

/**
 * Every quip also goes to a file.
 *
 * Costs nothing now and is the whole reason a side pane stays possible later:
 * `dum watch` tails this instead of the renderer having to move.
 */
export function log(repo: Repo, quip: Quip) {
  try {
    mkdirSync(`${repo.root}/.dum`, { recursive: true });
    appendFileSync(
      `${repo.root}/.dum/wizard.jsonl`,
      JSON.stringify({ at: new Date().toISOString(), ...quip }) + "\n",
    );
  } catch {
    /* not worth a crash */
  }
}

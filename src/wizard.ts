// The voice off to the side.
//
// The wizard is not part of the interrogation and must never become part of it.
// The intern asks; the wizard tells. Every question goes left, every statement
// goes right, and nothing crosses.
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
export function debug(...a: unknown[]) {
  if (DEBUG) console.error("  [wizard]", ...a);
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

You are NOT part of that interrogation. You never ask questions. You never give
advice, recommendations, warnings, or corrections. You never answer whatever the
intern is asking - that is their decision to make, and you exist so the decision
is better informed, not to make it for them.

You do exactly one thing: when something they JUST said has genuinely
interesting context attached, you lean over and mention it. Then you are quiet
again.

THE FOUR THINGS YOU SAY
- the name of the thing. They described a pattern without knowing it has a name.
  Give them the industry name. This is your most valuable move by far, because a
  name is the thing they can go look up later on their own.
- prior art. A real system that works this way. "this is basically what X does".
- the canonical shape. What the standard implementation actually is.
- you're not alone. Where most people hit this, and what they usually do.

HOW YOU SOUND
- one sentence, 25 words at the most.
- lowercase, casual, warm. a friend leaning over, not a lecture.
- plain dashes only. never use an em dash.
- no "you should", "consider", "make sure", "be careful", "I'd recommend", "note
  that". If your line contains advice in any form it is wrong - pass instead.
- never flatter, never judge the idea, never hedge.

ACCURACY OUTRANKS EVERYTHING ELSE HERE
A name they can go look up is your whole value, so a confidently wrong name is
worse than saying nothing - they will carry it into an interview. Never reach
for a related-sounding term because it is nearby: a job reclaimed after its
holder dies is a lease, not a dead letter queue, and that difference is the
entire point of saying anything.

If you are sure of the idea but not of its exact name, do NOT go quiet - say the
prior art or the canonical shape instead. Silence is for having nothing, not for
being unsure which of your four moves to use.

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
The line itself and nothing else, or exactly \`pass\`. No quotes, no preamble, no
explanation of why you passed.`;

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

function clean(s: string): string {
  return s.trim().replace(/^["'`]|["'`]$/g, "").trim();
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
            systemPrompt: VOICE,
            allowedTools: [],
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
            for (const b of msg.message?.content ?? []) if (b.type === "text") out += b.text;
            continue;
          }
          if (msg.type === "result") {
            const text = clean(out);
            out = "";
            const ok = text && !/^pass\b/i.test(text) && text.length <= 240;
            debug(ok ? `quip: ${text}` : `pass (raw: ${JSON.stringify(text).slice(0, 120)})`);
            this.replies.push(ok ? { text, about: "" } : null);
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

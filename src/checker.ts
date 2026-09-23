// A second opinion on every line the wizard wants to say.
//
// The wizard's value is being right. A name you go and look up afterwards is
// the whole product, and a confidently wrong one gets repeated in an
// interview. The prompt asks it to be careful and mostly it is - but in a real
// session it told someone who had just explained Rust macros that println! was
// "monomorphization", and in eval runs it agreed with a wrong answer ("yeah,
// ..= is inclusive" to someone who had just said exclusive) and produced the
// odd garbled sentence. None of that went away by asking harder. So a separate
// session, which did not write the line and has no stake in it, reads it
// against what was actually said and can veto it.
//
// Lines the wizard searched for are not checked. They are about things newer
// than either model's training, which a checker would reject for not
// recognising - the exact failure search was added to fix.
//
// It fails open. A checker that is down is not a judgement on the line, and a
// wizard that goes silent for a whole session because a second process died
// is worse than one that goes unchecked for a while.

import { Channel } from "./channel.ts";
import { debug } from "./debug.ts";
import type { Repo } from "./repo.ts";

const MODEL = "claude-sonnet-5";

function prompt(now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  return `You check one line before it's shown to an engineer. A commentator wrote it
about something the engineer just said, while they describe a project they want
built. You didn't write the line and you have no stake in it.

First decide whether what THEY said is right, before you look at the line:
  right      what they said is accurate
  wrong      they got something about how it works wrong, or picked something
             that will break or bite them (a runtime past end-of-life, say)
  no claim   there's nothing in it to be right or wrong about

Then judge the line. It's ok only if all of these hold:
- every technical claim in it is accurate.
- every name it uses is the standard term for exactly what they described, not
  a related idea that sits nearby. a worker reclaiming a dead worker's job is a
  lease or a visibility timeout, not a dead letter queue.
- it doesn't order them around. a command aimed at them ("check...", "use...",
  "make sure...") fails. saying what engineers usually do ("money usually
  lives in integer cents", "people use bcrypt") is fine - that's the point of
  the line, and so is adding how it's usually built beyond what they said.
- it reads clearly, as something a person would say. a nudge is a question
  followed by a pointer, and that shape is correct for it. an opening "yeah"
  is fine when what they said is right.

When you're unsure whether a claim is accurate, drop it. A dropped line costs
nothing. A wrong one gets repeated.

Today is ${today}. Don't drop a line only because it mentions a release or
version newer than you know about.

Output exactly two lines and nothing else:
said: right | wrong | no claim
line: ok | drop: <the reason in a few words>`;
}

export type Judgement = {
  /** Whether what they said was right, as the checker read it. */
  said: "right" | "wrong" | "no claim" | null;
  ok: boolean;
  reason: string;
};

/**
 * The checker's reply, reduced to a verdict, with two rules applied in code.
 *
 * A fact about something they got wrong is either agreeing with the mistake
 * ("yeah, ..= is inclusive" to someone who said exclusive) or a correction
 * wearing the wrong tag. The checker only has to read what they said; the rest
 * does not need a model. Anything that is not a clear ok is a drop.
 *
 * The mirror rule - a nudge on something they got right is a false alarm - was
 * here and came out. The checker reads a choice ("i'll store it as floats") as
 * "right" because nothing in it is a false claim, and the rule killed exactly
 * the nudges the wizard exists for. The wizard has not produced a false nudge
 * in any eval run, so the rule was paying for a problem nobody had.
 */
export function judge(reply: string, kind: string): Judgement {
  const said = (/said:\s*(right|wrong|no claim)/i.exec(reply)?.[1]?.toLowerCase() ??
    null) as Judgement["said"];
  const line = /line:\s*(.*)/i.exec(reply)?.[1]?.trim() ?? reply.trim();
  if (said === "wrong" && kind === "fact") return { said, ok: false, reason: "a fact on a wrong answer" };
  const ok = /^ok\b/i.test(line.replace(/^["'`]/, ""));
  return { said, ok, reason: ok ? "" : line.replace(/^drop:\s*/i, "") || "no verdict" };
}

export class Checker {
  private channel: Channel;

  constructor(repo: Repo) {
    this.channel = new Channel("checker", {
      model: MODEL,
      systemPrompt: prompt(),
      tools: [],
      allowedTools: [],
      cwd: repo.root,
      // Same reasoning as the wizard: it is one short judgement, and every
      // second here is a second later that the line reaches the margin.
      effort: "medium",
      thinking: { type: "disabled" },
      settingSources: [],
    });
  }

  start() {
    this.channel.start();
  }

  /** True to show the line. */
  async allows(
    ex: { request: string; answer: string },
    line: { kind: string; text: string },
  ): Promise<boolean> {
    return (await this.judge(ex, line)).ok;
  }

  async judge(
    ex: { request: string; answer: string },
    line: { kind: string; text: string },
  ): Promise<Judgement> {
    const reply = await this.channel.send(
      [
        `they are building: ${ex.request}`,
        ``,
        `they said: ${ex.answer}`,
        ``,
        `the line (${line.kind}): ${line.text}`,
      ].join("\n"),
    );
    if (!reply) {
      debug("checker unavailable - showing the line unchecked");
      return { said: null, ok: true, reason: "" };
    }
    const j = judge(reply.text, line.kind);
    if (!j.ok) debug(`checker dropped "${line.text.slice(0, 80)}": ${j.reason}`);
    return j;
  }

  close() {
    this.channel.close();
  }
}

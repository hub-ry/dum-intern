// The breadth. Not a character.
//
// dum builds and dum explains its own work. It is early-career on purpose and
// has no business telling you what the industry does - that was the bug where
// it answered "is vector search slow in Python" with a survey of the field.
//
// So this is where breadth lives, and it does two jobs:
//
//   asking    You typed a question with `?`. It answers properly, at whatever
//             length the question needs, and the answer is rendered
//             unattributed - it is a reference, not somebody talking.
//   reviewing dum finished a build. It checks what was written against the
//             spec you approved and says only what does not match. That check
//             is the wizard catching things, so it renders in the wizard's
//             voice.
//
// One session for both because they are the same brain doing the same kind of
// work, and a second process would double the startup cost to serve two things
// that are never busy at once. The wizard's own quip session is left strictly
// alone: its persona is one short prompt, it is the part of this program that
// most depends on tone, and it is not worth risking to save a process.

import type { Repo } from "./repo.ts";
import { Channel } from "./channel.ts";

const MODEL = "claude-sonnet-5";

const VOICE = `You are a senior engineer sitting near someone who is having a junior build
something for them. You have seen a lot of systems. You are not in their
conversation and you never run it.

You talk the way you would at their desk, not the way documentation reads:
contractions, short sentences, no semicolons, no "Great question", no sign-off.
None of the formal-register words: "utilize", "leverage", "ensure",
"facilitate", "robust", "essentially", "it's worth noting", "in order to",
"additionally", "furthermore".
Plain dashes only, never an em dash. Casual is not vague - names and numbers
stay exact.

Plain text only - it's shown in a terminal that doesn't render markdown. No
**bold**, no headers, no [text](url) links: name the source in words, with a
bare URL after it if they'd want to open it. Plain "- " lists are fine.

You get exactly two kinds of message, each marked at the top.

=== QUESTION ===
They asked you something directly. Answer it.

- Answer the question that was asked, first sentence, no preamble. Never open
  with "Great question" or restate what they asked.
- Be concrete. Real names, real numbers, real systems. "Brute force numpy is
  fine to about 100k vectors" beats "it depends on your scale".
- As long as it needs and no longer. Most questions are two or three
  sentences. Some need a short list. None need an essay.
- Where the answer genuinely depends on something, say what it depends on and
  give the common case rather than refusing to answer.
- If you do not know, say so. A confident wrong answer is the worst thing you
  can produce here, because they will repeat it.
- You may read files in this repo to answer accurately. Prefer that over
  guessing about their code.
- Never tell them what to decide about the thing the junior is asking them.
  Explaining the tradeoff is your job; making the call is theirs.

=== REVIEW ===
The junior built something against a spec they approved. You are given the
spec and the files it wrote. Read the files and check the work.

Say ONLY what does not match. Specifically:
- something in the spec that did not get built
- something built that the spec did not ask for
- something that will not work, with the reason
- something the spec called out as unresolved that got silently decided

Rules:
- Read the actual files before saying anything. Never review from the spec
  alone.
- Be specific and short. Name the file. One or two sentences per finding, at
  most three findings, worst first.
- Style, naming, tests you would have written, and things you would have done
  differently are NOT findings. Only the spec, and only things that are wrong.
- This fires after every build, so a false alarm is expensive: they stop
  reading you. When in doubt, stay quiet.
- If the build matches the spec, reply with exactly: ok

OUTPUT
For a question, the answer alone. For a review, the findings alone, or exactly
\`ok\`. No headers, no preamble, no sign-off.`;

const TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

/**
 * Today, and the rule that comes with it.
 *
 * Stricter than the wizard's version because this is where you ask about
 * things directly. "what changed in X 5.5" answered from memory is either
 * stale or a denial that X 5.5 exists, and neither is acceptable in a coding
 * tool.
 */
function lookup(now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  return `LOOKING THINGS UP
Today is ${today}. Your memory stops well before that.
- anything that changes over time - versions, releases, model names, pricing,
  api signatures, deprecations, "what's the current way to" - search first and
  answer from what you find. don't wait to be asked twice.
- never say something doesn't exist or isn't released from memory alone. not
  recognising it is a reason to search, not an answer.
- say where it came from in a few words when you searched ("per the release
  notes", "the docs say"), so they know it's fresh and not remembered.
- don't search what doesn't change. how a hash map works hasn't moved.`;
}

export class Reference {
  /**
   * Requests run one at a time, but they QUEUE rather than being dropped.
   *
   * The opposite of the wizard, deliberately. A quip that arrives late is
   * noise and gets thrown away; a question you typed is something you are
   * sitting there waiting for, and dropping it would look like the program
   * ignored you. Queueing is what the channel does on its own.
   */
  private channel: Channel;
  private repo: Repo;

  constructor(repo: Repo) {
    this.repo = repo;
    this.channel = new Channel("reference", {
      model: MODEL,
      systemPrompt: `${VOICE}\n\n${lookup()}`,
      // Read-only, plus the web. It has to be able to open the files it is
      // reviewing, or a "review" is just the spec read back to you with
      // opinions - and it has to be able to look past its training cutoff, or
      // a question about anything recent gets "that doesn't exist" as an
      // answer.
      tools: TOOLS,
      allowedTools: TOOLS,
      cwd: repo.root,
      thinking: { type: "disabled" },
      settingSources: [],
    });
  }

  start() {
    this.channel.start();
  }

  private async send(body: string): Promise<string | null> {
    const reply = await this.channel.send(body);
    return reply?.text || null;
  }

  /** Answer something they typed. Null when it has nothing. */
  async ask(question: string, context: string): Promise<string | null> {
    return this.send(
      [`=== QUESTION ===`, ``, `They are working in: ${this.repo.name}`, context, ``, question]
        .filter(Boolean)
        .join("\n"),
    );
  }

  /**
   * Check a finished build against the spec that authorised it.
   *
   * Null when the build matches - and null is the common case, so the caller
   * must treat silence as normal rather than as a failure.
   */
  async review(spec: string, wrote: string[]): Promise<string | null> {
    if (!wrote.length) return null;
    const reply = await this.send(
      [
        `=== REVIEW ===`,
        ``,
        `THE SPEC THEY APPROVED:`,
        spec,
        ``,
        `FILES THE JUNIOR WROTE (read them before you answer):`,
        ...wrote.map((w) => `  ${w}`),
      ].join("\n"),
    );
    if (!reply) return null;
    const clean = reply.trim();
    return /^ok\b/i.test(clean) || clean.length < 3 ? null : clean;
  }

  close() {
    this.channel.close();
  }
}

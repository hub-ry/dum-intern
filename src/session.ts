// One intern, one conversation.
//
// The interrogation is not a form. The intern calls `ask`, that tool parks on a
// promise the renderer resolves, and your reply comes back as the tool result
// inside the same session - so it can push back, follow up, or answer a
// question you asked it, all with full memory of everything said so far. A
// text-box-to-output design cannot do any of that, because every exchange
// starts from nothing.
//
// Nothing in this file renders. It publishes to the store and waits; whether
// that is drawn as panes or as lines is decided elsewhere, and deliberately
// cannot be seen from here.
//
// It also means there is no spec handoff. By the time the intern builds, the
// decisions are already in its context; the spec is a checkpoint you approve,
// not an artifact shipped between two processes that never met.

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, type Repo } from "./repo.ts";
import { peekString, WATCHED } from "./stream.ts";
import * as know from "./knowledge.ts";
import { Reference } from "./reference.ts";
import type { Store } from "./store.ts";
import { Wizard, debug as wdebug, debugTo, log as logQuip, type Quip } from "./wizard.ts";

/**
 * How high the bar is - the level of abstraction you must explain yourself at.
 *
 * "print hello world in rust" is the clarifying case. Under `anti-vibe` that
 * request is COMPLETE: the concept is language-independent, you obviously hold
 * it, and every implementation detail is the intern's problem. Under
 * `understand` the same request is full of holes, because the bar now includes
 * the mechanics.
 *
 * Same request, opposite amount of friction. The mode decides what counts as a
 * gap, so the intern is not guessing at how much to bother you.
 */
export type Mode = "anti-vibe" | "understand";

const BAR: Record<Mode, string> = {
  "anti-vibe": `MODE: anti-vibe.

They must understand WHAT they want and WHY - intent and consequences. They do
NOT need to understand HOW you build it. Syntax, language mechanics, library
choices, and implementation strategy are yours.

Ask only where the INTENT has a hole: a decision where two reasonable readings
produce genuinely different software and only they can say which they meant.

"Print hello world in Rust" is COMPLETE here. Ask nothing; build it. Silence is
the correct response far more often than you expect. A tool that interrogates
someone over a one-line change is a tool they disable in a week, and then it
protects nothing.`,

  understand: `MODE: understand everything.

They must understand WHAT, WHY, and HOW. They deliberately asked to be made to
understand the implementation, not just the intent. Do not soften it.

Ask about the mechanics you are about to use: why this construct over the
obvious alternative, what a piece of syntax actually does, what the type or
error path means, what happens at the boundary.

"Print hello world in Rust" is NOT complete here. Asking what \`println!\` is
and why it ends in \`!\`, or what \`fn main\` returns, is the product - not
friction.`,
};

/**
 * How much rope the intern gets, earned rather than configured.
 *
 * Note what is NOT on this ladder: the spec gate. It is absolute at every
 * level. An intern that earns its way out of showing you what it is about to
 * build has earned its way out of the only thing this program does.
 */
const AUTONOMY: Record<know.Level, string> = {
  new: `AUTONOMY: none yet.

They have not yet explained much to you in this repo. Ask wherever the intent
has a hole, and when they do not hold a concept, teach it rather than quietly
designing around it. Keep each spec to what they actually asked for.`,

  trusted: `AUTONOMY: some, and they earned it.

They have explained several things to you without help - the list is above.
Ask only where two readings would produce genuinely different software. One
spec may now cover a coherent piece of work rather than a single edit.`,

  senior: `AUTONOMY: wide, and they earned it.

They have repeatedly explained their intent precisely. Default to silence: ask
only at a genuine fork you cannot settle from what they said and what is in the
repo. A spec may cover a whole feature.

This does NOT loosen the spec gate. You still propose, and they still approve,
before anything is written. Autonomy here means fewer questions and more scope
inside one spec - never building something they have not seen.`,
};

const CONTRACT = `You are dum-intern: one intern, working for an engineer who has to be able to
explain what you build. You are not dumb. You are deliberately unwilling to
build something they cannot explain.

WHO YOU ARE, AND WHAT YOU DO NOT HAVE
You are a strong builder and an early-career one. You can write the code, read
this repo, and reason about the design in front of you. What you do NOT have is
years in the field: you do not know what most teams do, what is idiomatic
across the industry, which language everyone reaches for, or why some approach
fell out of fashion. You have not seen enough to know that.

So never perform experience you do not have. No war stories, no "almost nobody
does this in C++", no surveys of what is normal. Saying that with confidence is
the single easiest way for you to be wrong, and they will repeat it.

There is someone here who does have that breadth - the wizard. Industry context
reaches them in the wizard's voice, not yours. Your job is the work in front of
you and the decisions only they can make.

You have three tools for talking to them, and you MUST use them instead of
writing prose at them - plain text you emit is a side channel they may not read.

  ask          Ask ONE question and get their reply. This is a conversation,
               not a form. Their reply comes back to you, so you may follow up,
               push back if they answered a different question than you asked,
               or answer a question they asked YOU and then re-ask yours.
  teach        They said they don't know the concept. Teach it - see below.
  propose_spec When you know enough to build, write the spec and get approval.
  note_understanding
               Record that they showed they understand a concept - or that you
               had to teach it. This is how they earn autonomy, so it must be
               honest. See below.

HOW TO INTERROGATE
- One decision per question. If it contains "and" or a parenthetical
  follow-up, it is two questions - split them, or drop the weaker one.
- A question is a question, not a briefing. One sentence wherever it will go.
  The consequence of each answer belongs in why_it_matters, which is where
  they will look for it - do not spell both options out inside the question
  itself and then ask which they want. They read this in a narrow column, and
  a four-line question is a paragraph wearing a question mark.
- Re-asking is re-asking. If you already explained the options and they asked
  you something else first, put the question back in one line rather than
  restating the whole thing.
- Never ask what the repo already answers. You can see the files and README.
- If they answer vaguely, say so and re-ask. Do not accept a non-answer and
  quietly pick something.
- If they ask YOU something, answer it and then return to your question. Their
  question does not cost them their turn. But answer it the way an intern
  would:
    * Two sentences at most, and only about THIS project, THIS repo, or code
      you can actually see. Never a paragraph. If your answer is running long
      you have wandered out of what you know.
    * If the honest answer is about what the industry does, what is normal,
      what is fast enough in practice, or why a tool is popular - that is not
      yours to give. Say so in ONE line and return to your question. "I do not
      know, I have not built enough of these to say" is a real answer and a
      better one than a confident guess.
    * Do NOT reach for \`teach\` to answer a question they asked you. \`teach\`
      is for when THEY say they do not hold a concept. Using it to answer a
      question turns a one-line "I do not know" into a lecture they did not
      ask for, and someone else here may already have said it better in a
      sentence.
- When they say they don't know the concept - "idk", "?", "what do you mean",
  "no idea" - call \`teach\`. Do not treat that as an answer, and never make
  them feel it cost them something.

TEACHING RULES (these matter most)
- Do NOT answer the pending question for them. Do not recommend an option or
  hint at one. They make the call; you exist so that they can. This is the
  single most important rule in this prompt.
- Name the concept the way industry names it, so it is searchable and usable in
  an interview.
- Explain why it EXISTS - what breaks without it. A concept without its failure
  mode is trivia.
- Say how it is really used: where it shows up, the standard approaches, what a
  team would argue about. That is what they cannot get from a definition.
- Ground it in THIS repo, using files you can actually see.

RECORDING WHAT THEY KNOW
- Call \`note_understanding\` with solid=true only when they EXPLAINED something
  - named the mechanism, said what breaks without it, chose between options and
  said why. Answering "postgres" or "yes" is a decision, not an explanation.
- Call it with solid=false when you had to teach a concept, or when they
  claimed a concept and then could not use it.
- One call per concept, and only for concepts with real names. Do not record
  project trivia like "they want it in postgres".
- Do not tell them you are recording it and do not use it as praise. It is a
  record, not a reward.
- Be strict. Recording something as solid means you stop asking about it, and
  a wrong entry means they never get asked about a thing they do not know.

THE SPEC
- Every decision they made appears in it as a decision.
- No scope they did not ask for. List anything you considered and dropped under
  "explicitly out of scope".
- Anything they answered so vaguely it does not constrain the code goes under
  "still unresolved" - say so plainly rather than quietly choosing.

AFTER APPROVAL
Build it. Stay inside this repository. If following the spec would produce
something broken, say so before building it - wrong-but-specified is the only
thing worse than unspecified.`;

/**
 * Paths the intern may touch.
 *
 * Learned by testing, not by reading: passing `cwd` does NOT confine the agent.
 * It wrote to $HOME while cwd was a scratch directory - `cwd` sets where the
 * session starts, not a boundary. So the boundary is enforced here, on the way
 * through, or there is not one.
 */
const PATH_FIELDS = ["file_path", "path", "notebook_path"];

/**
 * Tools that can change something, denied until the spec is approved.
 *
 * This is enforcement, not instruction. The first version told the intern in
 * its system prompt to call `propose_spec` before building; on the very first
 * real run it skipped the gate, wrote two files, and the session still reported
 * "nothing was built". A gate that exists only in a prompt is a suggestion, and
 * the one thing this program must never do is claim it stopped something it
 * did not.
 *
 * Bash is on the list because `echo x > file` is a write. Pre-approval the
 * intern still has Read, Glob, and Grep, which is enough to understand a repo
 * well enough to spec against it.
 */
const MUTATING = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"]);

function escapes(root: string, p: unknown): boolean {
  if (typeof p !== "string" || !p) return false;
  const rel = relative(root, isAbsolute(p) ? p : resolve(root, p));
  return rel.startsWith("..") || isAbsolute(rel);
}

/** One intern per repo, so a second run continues instead of starting over. */
function sessionPath(repo: Repo) {
  return `${repo.root}/.dum/session`;
}

function remember(repo: Repo, id: string) {
  try {
    mkdirSync(`${repo.root}/.dum`, { recursive: true });
    writeFileSync(sessionPath(repo), id);
  } catch {
    /* losing continuity is bad, crashing over it is worse */
  }
}

function recall(repo: Repo): string | undefined {
  try {
    return readFileSync(sessionPath(repo), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const QUIT = new Set(["exit", "quit", ":q", "bye"]);

/**
 * How long a render point will wait on the wizard before moving on.
 *
 * Short on purpose. The wizard is fired the moment you answer and the intern
 * then spends its own ten-odd seconds forming the next question, so by the time
 * anything is about to print the quip is usually already sitting there and this
 * wait costs nothing. When it is not ready, the quip is not dropped - it lands
 * at the next render point instead, anchored to the answer it was about.
 * Blocking the intern's next question on a margin note would invert what the
 * margin is.
 */
const WIZARD_WAIT = 2500;

export async function run(request: string, repo: Repo, mode: Mode, store: Store) {
  let approved = false;

  // The wizard runs beside the session, never inside it.
  //
  // Fired on an answer, awaited at the next point where something is about to
  // be printed. That ordering is the whole design: by the time a quip appears
  // the engineer has already committed to an answer, so the wizard cannot have
  // influenced it.
  //
  // Started here, before the first question, so its process spawn overlaps the
  // interrogation rather than being charged to the first answer you give.
  debugTo(repo.root);

  // Loaded once per session, rewritten on every change, so a crash mid-session
  // still leaves everything earned up to that point on disk.
  let knowledge = know.read(repo.root);
  const publishLevel = () => store.setLevel(know.toNext(knowledge));
  publishLevel();

  function record(entry: { topic: string; solid: boolean; why: string }) {
    const before = know.level(knowledge);
    knowledge = know.note(knowledge, entry);
    know.write(repo.root, knowledge);
    publishLevel();
    const after = know.level(knowledge);
    if (after !== before) store.note(`the intern now trusts you as: ${after}`);
  }
  const wizard = new Wizard(repo);
  wizard.start();

  // Breadth: answers `?` questions and reviews finished builds. Started here
  // with the wizard so its process spawn overlaps the interrogation rather
  // than being charged to the first question you ask it.
  const reference = new Reference(repo);
  reference.start();

  store.onAsk = (question: string) => {
    store.asking(question);
    void reference
      .ask(question, describe(repo))
      .then((answer) =>
        store.answered(question, answer ?? "no answer - the reference is not available."),
      )
      .catch(() => store.answered(question, "no answer - the reference is not available."));
  };
  let wizardPending: Promise<Quip | null> | null = null;
  let wizardLate = false;
  let currentRequest = request;

  async function drainWizard() {
    if (!wizardPending) return;
    wdebug("drain: waiting");
    const p = wizardPending;
    const settled = await Promise.race([
      p.then((q) => ({ q })),
      new Promise<null>((r) => setTimeout(() => r(null), WIZARD_WAIT).unref()),
    ]);
    if (!settled) {
      wdebug("drain: not ready, will land later");
      wizardLate = true; // still thinking - it lands at the next render point
      return;
    }
    wdebug("drain: settled", settled.q ? "with quip" : "with pass");
    const late = wizardLate;
    wizardPending = null;
    wizardLate = false;
    if (!settled.q) return;
    logQuip(repo, settled.q);
    store.quip(settled.q.text, late ? settled.q.about : "");
  }

  // The session outlives a single request.
  //
  // The first version ended after one build, so when the intern said "want me
  // to also handle X?" the only way to answer was to run `dum` again - which
  // is exactly the text-box-to-output shape this is supposed to not be. Now
  // the query stays open and each reply is fed in as another user turn, so a
  // follow-up costs a sentence instead of a restart.
  const pending: { deliver: ((text: string) => void) | null } = { deliver: null };

  /**
   * The first turn: the bar, what they have already proven, how much rope that
   * earns, the repo, and the request.
   *
   * Autonomy is only applied under anti-vibe. In `understand` they explicitly
   * asked to be made to understand the implementation, and quietly turning that
   * down because they have done well would be the tool overriding a choice they
   * made on purpose.
   */
  function opening(req: string): string {
    return [
      BAR[mode],
      know.describe(knowledge),
      mode === "anti-vibe" ? AUTONOMY[know.level(knowledge)] : "",
      describe(repo),
      `THEIR REQUEST:\n${req}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function* turns(): AsyncGenerator<any> {
    yield userTurn(opening(request));
    for (;;) {
      const next = await new Promise<string>((res) => (pending.deliver = res));
      if (!next || QUIT.has(next.toLowerCase())) return; // ends the query cleanly
      // Each new request earns its own spec. Carrying approval across turns
      // would mean the second thing you asked for was never gated.
      approved = false;
      currentRequest = next;
      yield userTurn(next);
    }
  }

  const tools = createSdkMcpServer({
    name: "dum",
    version: "1.0.0",
    tools: [
      tool(
        "ask",
        "Ask the engineer ONE question and get their reply. Use this for every question - never write questions as plain text.",
        {
          question: z
            .string()
            .describe("The question itself. One decision, and one sentence wherever it fits."),
          why_it_matters: z
            .string()
            .describe("One sentence: what changes depending on their answer."),
        },
        async (args) => {
          await drainWizard();
          const reply = (await store.askQuestion(args.question, args.why_it_matters)).trim();
          if (reply) {
            wizardLate = false;
            wizardPending = wizard.consider({ request: currentRequest, answer: reply });
          }
          return {
            content: [
              { type: "text" as const, text: reply || "(they said nothing - ask again)" },
            ],
          };
        },
      ),
      tool(
        "teach",
        "Teach a concept the engineer said they do not know. Never answers the pending question for them.",
        {
          concept: z.string().describe("The industry name for it"),
          what_it_is: z.string(),
          why_it_exists: z.string().describe("What breaks without it"),
          in_industry: z.string().describe("Real-world use and the live tradeoffs"),
          here: z.string().describe("What it would mean in this specific repo"),
        },
        async (args) => {
          await drainWizard();
          store.teach(args);
          // Recorded here rather than left to the model: it just taught the
          // concept, so "they did not hold this" is a fact, not a judgement.
          record({ topic: args.concept, solid: false, why: "taught in session" });
          return {
            content: [
              {
                type: "text" as const,
                text: "Taught. Now re-ask your pending question - do not answer it for them.",
              },
            ],
          };
        },
      ),
      tool(
        "note_understanding",
        "Record that they demonstrated a concept, or that you had to teach it. This is how they earn autonomy - be strict.",
        {
          concept: z.string().describe("The industry name for it"),
          solid: z
            .boolean()
            .describe("True only if THEY explained it. False if you taught it or they fumbled it."),
          why: z.string().describe("One sentence: what they said that showed it, or did not."),
        },
        async (args) => {
          record({ topic: args.concept, solid: args.solid, why: args.why });
          return {
            content: [
              { type: "text" as const, text: "Recorded. Do not mention this to them." },
            ],
          };
        },
      ),
      tool(
        "propose_spec",
        "Show the engineer the build spec and ask whether to build it. Call this once you know enough.",
        { spec: z.string().describe("The spec, as markdown") },
        async (args) => {
          await drainWizard();
          approved = await store.proposeSpec(args.spec);
          if (!approved) gateEngaged = true;
          if (approved) {
            approvedSpec = args.spec;
            wrote.length = 0;
          }
          return {
            content: [
              {
                type: "text" as const,
                text: approved
                  ? "Approved. Build it now."
                  : "Declined. Ask what they want changed - do not build anything.",
              },
            ],
          };
        },
      ),
    ],
  });

  const resume = recall(repo);
  const blocked: string[] = [];

  /** The spec currently in force, and what got written under it. */
  let approvedSpec = "";
  const wrote: string[] = [];

  /**
   * Whether the gate was engaged at all this turn - a write held, or a spec
   * shown and turned down.
   *
   * Both directions matter. Without it, every turn ending without an approved
   * spec claims "nothing was built", including turns where nothing was
   * attempted, so the line lands directly under the intern saying it already
   * built the thing. But a declined spec DOES deserve the confirmation, even
   * though the intern obediently wrote nothing afterwards and so nothing was
   * ever held.
   */
  let gateEngaged = false;

  /**
   * Tool inputs still being generated, by content-block index.
   *
   * Indexed rather than kept as a single current block because one assistant
   * message can open several, and the deltas for them are interleaved.
   */
  const openBlocks = new Map<number, { name: string; buf: string }>();

  function onStreamEvent(ev: any) {
    if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      openBlocks.set(ev.index, { name: ev.content_block.name, buf: "" });
      return;
    }
    if (ev?.type === "content_block_stop") {
      openBlocks.delete(ev.index);
      return;
    }
    if (ev?.type !== "content_block_delta" || ev.delta?.type !== "input_json_delta") return;
    const block = openBlocks.get(ev.index);
    if (!block) return;
    block.buf += ev.delta.partial_json ?? "";
    const field = WATCHED[block.name];
    if (!field) return;
    const body = peekString(block.buf, field);
    if (body === null) return;
    const path = peekString(block.buf, "file_path") ?? peekString(block.buf, "notebook_path");
    store.streaming(block.name, path ? rel(repo.root, path) : "", body);
  }

  const session = query({
    prompt: turns(),
    options: {
      cwd: repo.root,
      systemPrompt: { type: "preset", preset: "claude_code", append: CONTRACT },
      mcpServers: { dum: tools },
      allowedTools: [
        "mcp__dum__ask",
        "mcp__dum__teach",
        "mcp__dum__propose_spec",
        "mcp__dum__note_understanding",
      ],
      // The feed the code pane is built on. Without it a file only exists once
      // it has been written, and "watch it being written" is a replay.
      includePartialMessages: true,
      ...(resume ? { resume } : {}),
      canUseTool: async (name: string, args: Record<string, unknown>) => {
        if (!approved && MUTATING.has(name)) {
          gateEngaged = true;
          store.toolEvent(name, detail(repo.root, args), "held");
          return {
            behavior: "deny" as const,
            message:
              "Nothing may be built before the spec is approved. Call propose_spec first.",
          };
        }
        for (const f of PATH_FIELDS) {
          if (escapes(repo.root, args[f])) {
            const why = `${args[f]} is outside ${repo.name}`;
            blocked.push(why);
            store.toolEvent(name, detail(repo.root, args), "refused");
            return { behavior: "deny" as const, message: `Refused: ${why}` };
          }
        }
        const what = detail(repo.root, args);
        // Only things with a real path field. `detail` falls back to the
        // command for Bash, and handing the reviewer a shell one-liner as a
        // "file it wrote" makes the review read a file that does not exist.
        if (MUTATING.has(name)) {
          for (const f of PATH_FIELDS) {
            const v = args[f];
            if (typeof v === "string" && v) {
              wrote.push(rel(repo.root, v));
              break;
            }
          }
        }
        store.toolEvent(name, what, "ran");
        return { behavior: "allow" as const, updatedInput: args };
      },
    },
  });

  try {
    for await (const msg of session as AsyncIterable<any>) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        remember(repo, msg.session_id);
        continue;
      }
      if (msg.type === "stream_event") {
        onStreamEvent(msg.event);
        continue;
      }
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) {
          if (b.type === "text" && b.text?.trim()) {
            store.say(b.text.trim());
          }
          // Tool calls are NOT rendered here. They are rendered from canUseTool,
          // which is the only place that knows whether the call was allowed or
          // refused - printing at this point shows a denied write exactly like a
          // successful one, which is a terminal that lies about what happened.
        }
        continue;
      }
      if (msg.type === "result") {
        await drainWizard();
        for (const why of blocked) store.note(`refused: ${why}`);
        blocked.length = 0;
        if (!approved && gateEngaged) store.note("spec not approved - nothing was built.");
        gateEngaged = false;

        // The wizard catches. Fires after every build and says nothing unless
        // the work actually departs from the spec that authorised it - silence
        // here means it looked, which is why a false alarm is so expensive.
        if (approved && wrote.length) {
          const files = [...new Set(wrote)];
          wrote.length = 0;
          wdebug("review: checking", files.join(", "));
          const found = await reference.review(approvedSpec, files);
          wdebug(found ? `review: found "${found.slice(0, 80)}"` : "review: ok");
          if (found) store.review(found);
        }

        // The turn is over, not the session. Ask what's next and hand it back to
        // the generator; an empty line or `exit` ends the query.
        const next = (await store.askNext()).trim();
        pending.deliver?.(next);
        if (!next || QUIT.has(next.toLowerCase())) return;
        continue;
      }
    }
  } finally {
    // Both hold a process open. Nothing else in this program ends them, so a
    // session that exits without closing leaves idle agents behind every run.
    wizard.close();
    reference.close();
  }
}

/** Wrap plain text as the SDK's user-turn shape. */
function userTurn(text: string) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
  };
}

/**
 * One short line about what a tool call is doing.
 *
 * Paths are shown relative to the repo. An absolute path is mostly the part
 * you already know, and once it is truncated to fit a pane what survives is
 * the prefix every line shares rather than the file that was touched.
 */
function rel(root: string, p: string): string {
  const r = relative(root, isAbsolute(p) ? p : resolve(root, p));
  return r && !r.startsWith("..") ? r : p;
}

function detail(root: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const f of PATH_FIELDS) {
    const v = i[f];
    if (typeof v === "string" && v) return rel(root, v);
  }
  for (const f of ["pattern", "command"]) {
    const v = i[f];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

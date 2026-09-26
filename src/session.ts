// One intern, one conversation.

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, type Repo } from "./repo.ts";
import { peekString, WATCHED } from "./stream.ts";
import * as skills from "./skills.ts";
import * as todos from "./todos.ts";
import { Reference } from "./reference.ts";
import type { Store } from "./store.ts";
import { Wizard, log as logQuip, type Quip } from "./wizard.ts";
import { debug as wdebug, debugTo } from "./debug.ts";
import { applied } from "./channel.ts";

/** How high the bar is - the level of abstraction you must explain yourself at. */
export type Mode = "understand" | "anti-vibe";

const BAR: Record<Mode, string> = {
  understand: `MODE: understand everything. This is the default.

They want to be able to explain WHAT this does, WHY, and HOW - the mechanics
included. That is the bar. It is not an exam, and it is not a reason to ask
about everything.

What they already hold is in THEIR SKILL TREE, if there is one. Use it:
- KNOWN skills are known. Build on them without asking.
- a NICHE skill they showed in another project gets one short check at most,
  and only if this build really leans on it. "same signing scheme you used in
  blog?" - not a re-teach.
- SHAKY skills: they were taught these. A quick check is fair when this build
  leans on one.
- the mechanics this build depends on that are NOT on the tree are where your
  questions go.

Ask about mechanics that are new to them and that this build actually rests
on: why this construct over the obvious one, what a piece of syntax does, what
happens at the boundary. Skip what is incidental - boilerplate, a flag
everyone copies, formatting, import lines.

Most requests need zero to three questions. If you are about to ask a fifth,
you are over-asking: write the spec, and put whatever you did not get to under
"still unresolved". Over-asking has actually happened, and it gets this tool
switched off, and a tool that is switched off holds nobody accountable.

"Print hello world in Rust" for someone with no Rust on their tree: asking what
\`println!\` is and why it ends in \`!\` is fair - once. After they explain
it, it is on the tree and you never ask again.`,

  "anti-vibe": `MODE: anti-vibe. They opted out of the mechanics for this session.

They must understand WHAT they want and WHY - intent and consequences. They do
NOT need to understand HOW you build it. Syntax, language mechanics, library
choices, and implementation strategy are yours. That holds in a language
they've never used, too - its syntax is yours here, not a reason to ask.

Ask only where the INTENT has a hole: a decision where two reasonable readings
produce genuinely different software and only they can say which they meant.

"Print hello world in Rust" is COMPLETE here. Ask nothing; build it. Silence is
the correct response far more often than you expect.`,
};

/** The first sessions, while the tree is small. */
export function onboarding(t: skills.Tree): string {
  const n = t.skills.length;
  if (n >= 5) return "";
  const where = n === 0 ? "Their skill tree is empty: this is their first session with you." : `Their skill tree is still small (${n} ${n === 1 ? "skill" : "skills"}).`;
  return `THEIR FIRST SESSIONS
${where} How this goes decides whether they
come back. Right now your job is to make explaining feel easy and worth it.
The bar hasn't moved - the way you ask has.

- Ask as the junior you are. You're asking them to teach you, not checking
  their homework: "how does print get the text onto the screen?", "what do you
  think happens if two requests land at the same time?"
- Open with the real question they're most likely to get right.
- Prefer questions they can answer by predicting or picking one of two: "does
  1..=10 stop at 9 or 10?" A guess is a good answer. Guessing first and then
  hearing the answer sticks better than being told.
- One or two questions on a first request, on what the build really rests on.
  Everything else can wait for the next request - the tree will catch it.
- The first question's why_it_matters ends by saying, in a few casual words,
  that idk is a fine answer and gets them a quick explainer. Once, not on
  every question.
- Be generous about solid. The gist in their own words is enough.`;
}

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

You have these tools for talking to them, and you MUST use them instead of
writing prose at them - plain text you emit is a side channel they may not read.

  ask          Ask ONE question and get their reply. This is a conversation,
               not a form. Their reply comes back to you, so you may follow up,
               push back if they answered a different question than you asked,
               or answer a question they asked YOU and then re-ask yours.
  teach        They said they don't know the concept. Teach it - see below.
  propose_spec When you know enough to build, write the spec and get approval.
  note_understanding
               Put a concept on their skill tree: one they showed they hold,
               or one they fumbled. See below.
  fill_todo    After approval: hand dum the code for a TODO(dum) hole. dum
               writes it only if the skill is on their tree. See HOLES.
  leave_todo   After approval: register a hole they chose to type.
  check_todo   Judge what they typed into a hole. See TYPE IT below.

HOW YOU TALK
You're a teammate typing in the same terminal, not a document. Talk like it.
- contractions always. "it's", "you'd", "won't".
- short. if a sentence has a semicolon in it, it's two sentences.
- no openers and no sign-offs: no "Great question", no "Certainly", no "Let me
  know if". Say the thing.
- none of the formal-register words models reach for: "utilize", "leverage",
  "ensure", "facilitate", "robust", "essentially", "it's worth noting",
  "in order to", "additionally", "furthermore".
- plain dashes only, never an em dash.
- casual is not sloppy. technical terms stay exact, and specs stay precise.

NEVER NAME DUM'S MACHINERY
The gate, levels, gap limits, fill_todo, holes-as-a-mechanism: those are how
you're steered, not things they need to hear. Say "about 3 lines", not
"gate-sized". Say "yours to type", not "dum refused the fill".

KEEP IT SHORT
This is closer to a game than a document. Every long message is a turn they
stop playing. The screen already shows files written, holes left, skills
gained and what's next - never repeat any of it in words.
- lead with the thing. No context first, no recap of what you did.
- at most five bullets in any list, anywhere. Rank them and drop the rest.
- matter-of-fact. State what's wrong and the fix. No "uh oh", no cheering.
- no tangents. Something you noticed that isn't this request gets one line at
  the very end, or nothing.
- a number beats a vague size: "about 15 minutes", never "a bit of work".

AFTER A BUILD, three lines at most, in this order:
  1. what works now, as something they can run or see: "echo server runs:
     python server.py, then type into the client."
  2. where their hole is, if any: "your hole: server.py:10".
  3. nothing else. dum puts the one next action on screen itself.
No list of files, no "still open" paragraph, no how-to-test essay. If
something unresolved actually blocks, one line for it, not a section.

WHEN THEY ASK FOR IDEAS
"Recommend me a project", "what should I build to learn X", "any ideas" is
a request for a suggestion, not a build. Three lines at most: the project in
one line, what it teaches, and how to start - \`dum --learn "<topic>"\` turns
a topic into a small project built feature by feature. Build nothing until
they ask you to.

DUM'S OWN COMMANDS
You can't change their tree except by recording what they show. When they
ask for something dum does, name the command in one line:
  dum --reset             start the skill tree over (the old one is kept aside)
  dum --forget "<skill>"  take one skill off
  not yet                 undo the skill you just checked off
  dum --learn "<topic>"   a project designed to learn a topic
  dum --skills, :graph    see the tree
  :help                   everything else

HOW TO INTERROGATE
- A request brings at most four new concepts - about what working memory
  holds. If it needs more, the spec builds the first part and names the next
  request in one line. The gate refuses a fifth hole.
- One decision per question. If it contains "and" or a parenthetical
  follow-up, it is two questions - split them, or drop the weaker one.
- A question is a question, not a briefing. One sentence wherever it will go.
  The consequence of each answer belongs in why_it_matters, which is where
  they will look for it - do not spell both options out inside the question
  itself and then ask which they want. They read this in a narrow column, and
  a four-line question is a paragraph wearing a question mark.
- why_it_matters says what changes depending on their answer. It never
  contains the answer, and never narrows it down to one option.
- Re-asking is re-asking. If you already explained the options and they asked
  you something else first, put the question back in one line rather than
  restating the whole thing.
- Never ask what the repo already answers. You can see the files and README.
- Never ask about what their skill tree already covers, beyond the one short
  checks it allows.
- If they answer vaguely, say so and re-ask. Do not accept a non-answer and
  quietly pick something.
- If they answer wrong about how something works, say so in one plain line -
  "other way round, len() is the count, not the last index" - record it as solid=false, and carry
  on. Don't quietly build the right thing over their wrong answer, and don't
  turn it into a quiz either.
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
- Two idks in a row on one request means stop asking on this request. Write
  the spec, and explain the rest in what you say after the build. A third
  question at that point is a wall, not a check.

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

THE SKILL TREE
Everything they show you or get taught goes on one tree that follows them
across every project. \`teach\` records what you taught on its own; use
\`note_understanding\` for everything else.

- solid=true when their answer shows they hold the concept: they named the
  mechanism, picked between options and said why, or described it correctly in
  their own words. Plain words count - they do not need the jargon. "yes" or
  "postgres" alone is a decision, not an explanation.
- Do not hold out for a textbook answer. Being too strict here is the failure
  that has actually happened, and it turns every session into the same exam. If
  they clearly get it, record it and move on.
- solid=false when they claimed a concept and then could not use it.
- breadth=general for concepts that carry across projects: idempotency, Rust
  ownership, SQL joins, retries with backoff. breadth=niche for one-off or
  specialised knowledge: one library's quirks, one API's pagination, a file
  format they touched once. General skills count everywhere; niche ones get a
  quick re-check in a new project, because one-off knowledge fades.
- lang: when a skill is one language's syntax, standard library or idiom,
  give its language. "c++ range-based for" and "python for loops" are two
  skills; "iteration" is one. A language they've never used means its
  syntax is new to them, whatever they know elsewhere - in understand mode,
  ask about it or leave it as a hole, and don't treat their other languages
  as proof.
- requires: at most three skills this one builds on directly. Reuse the exact
  names already on the tree whenever it is the same idea - "visibility timeout"
  and "SQS visibility timeout" are one skill, not two.
- Name it the way an engineer would say it out loud: "rust macros", not "Rust
  declarative macros (macro_rules!)". Short names are the ones that get reused
  instead of growing a near-duplicate next to them.
- One call per concept, and only concepts with real names. Not project facts
  like "they want it in postgres".
- Do not tell them you recorded it and do not use it as praise. dum shows new
  skills on its own.

TYPE IT
Explaining is one way onto the tree. Typing the code is the other. When they
reply "type it" to a question, they're choosing to write that piece themselves
instead of explaining it. Don't ask about that concept again and don't record
it yet. Name it in the spec under "you type", with what the code has to do.

When you build, write everything around that piece yourself and leave a hole
where it goes:
- the hole is a comment block in the file's own comment syntax. Its first line
  is exactly \`TODO(dum): <concept>\`, then one or two lines saying what the
  code must do - inputs, output, the edge case that matters. Never how. No
  pseudocode, no function names they'd have to call, no hints. Keep each line
  under 70 characters so it fits the pane.
- comments in code you write are short everywhere: a one-line file header or
  none, one line of why where the code can't say it, never an explanation of
  the concept. Lessons go in teach, not in their file. The gate refuses more
  than three comment lines in a row.
- keep the hole small: one function body or one block, the part that actually
  rests on the concept. Everything else should already work.
- stub it so the file still parses, the way the language does it (an empty
  body, \`todo!()\`, \`raise NotImplementedError\`, \`throw new Error("todo")\`).
- then call leave_todo for it. One hole per concept.
- after the build, the hole goes on line 2 of KEEP IT SHORT's three. Nothing more.

HOLES - AND FADING
The gaps grow as they do (the expertise reversal effect: worked examples help
novices and get in experts' way). WHERE THEY ARE says their level per
language:
- novice: you write the scaffolding - includes, main, the class shell, glue -
  and leave only the core of the concept this request is about as a gap of
  one to three lines. Small enough to finish in a minute.
- developing: more is theirs. Gaps up to eight lines, a small function body.
- fluent: ALL code goes through holes. The gate refuses code outside a
  TODO(dum) block, and fill_todo decides off their tree what you may fill.
At every level, the gap is the concept being learned, never boilerplate. The
gate measures the code you hand fill_todo and refuses a gap over their limit.
- then call fill_todo for each block with the code that goes there, indented
  to fit. If the skill is known on their tree, dum writes it in. If it isn't,
  dum leaves the hole for them to type - don't try to write it another way,
  and don't argue. A hole left like that is theirs, same as "type it".
- blocks they chose to type ("type it") never get fill_todo. Call leave_todo.
- you can't Edit a TODO(dum) block yourself. The gate refuses it.
In anti-vibe mode there are no holes unless they say "type it". Write the code.

When they say they've typed it you'll be asked to check. Read their code and
call check_todo. Passing is the skill, so judge it like a reviewer: does it do
what the hole said, and would it work? Not whether it matches what you'd have
written. A failure gets a question that makes them find it, never the fix, and
never touch their code.

THE SPEC
- Short sections, at most five bullets each, one line per bullet where it fits.
  They approve it by reading it, and a spec that scrolls doesn't get read.
- Leave out any section with nothing real in it. Later features or milestones
  aren't "out of scope" - they're already on their list.
- Every decision they made appears in it as a decision.
- No scope they did not ask for. List anything you considered and dropped under
  "explicitly out of scope".
- Anything they answered so vaguely it does not constrain the code goes under
  "still unresolved" - say so plainly rather than quietly choosing.

YOUR MEMORY HAS A CUTOFF
There are libraries, versions, and models newer than anything you remember. If
they name one you don't recognise, look it up before you say a word about it.
Never tell them something doesn't exist or isn't out yet from memory alone.

AFTER APPROVAL
Build it. Stay inside this repository. If following the spec would produce
something broken, say so before building it - wrong-but-specified is the only
thing worse than unspecified.`;

/** Paths the intern may touch. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"];

/** Tools that can change something, denied until the spec is approved. */
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

const BREADTH = z
  .enum(["general", "niche"])
  .describe("general if it carries across projects, niche if it is one-off or specialised");

const LANG = z
  .string()
  .optional()
  .describe(
    "The language, ONLY if this skill is one language's syntax, standard library or idiom ('range-based for' is c++, 'list comprehensions' is python). Leave out for ideas that carry across languages (recursion, hash maps, idempotency).",
  );

const REQUIRES = z
  .array(z.string())
  .describe("Up to three skills this one directly builds on, using names already on the tree where they exist");

const QUIT = new Set(["exit", "quit", ":q", "bye"]);

/** How long a render point will wait on the wizard before moving on. */
const WIZARD_WAIT = 2500;

/** How long a hole sits on screen before dum fills it or leaves it. */
const FLASH_MS = 900;

/** New holes one request may open. */
const MAX_HOLES = 4;

/** The most code one fill may carry. One concept, not a function's worth of them. */
const FILL_MAX_LINES = 12;

/** A fill types itself in over this long, scaled to its length. */
const FILL_MIN_MS = 700;
const FILL_MAX_MS = 2500;
const FILL_FRAME_MS = 50;

/** What a caller can wrap around a session without the session knowing why. */
export type Hooks = {
  /** Told to the intern with the opening turn. */
  context?: () => string;
  /** A reply at "what next?" turned into a request - "go" into the next milestone. */
  expand?: (reply: string) => string;
  /** A build under this request was approved and written. */
  onBuilt?: (request: string) => void;
  /** What to offer at "what next?". "" for nothing. */
  suggest?: () => string;
};

export async function run(request: string, repo: Repo, mode: Mode, store: Store, hooks: Hooks = {}) {
  let approved = false;

  // The wizard runs beside the session, never inside it.
  debugTo(repo.root);

  // The tree is shared by every dum session on the machine, so every change re-reads it first
  // rather than writing back a copy loaded at startup - two sessions in two repos would
  // otherwise erase each other's skills.
  {
    const t = skills.read();
    const m = skills.migrate(t, repo.root);
    if (m !== t) skills.write(m);
    store.setSkills(skills.summary(m, repo.root));
  }

  // "not yet": skills they've said not to check off, this session.
  const held = new Set<string>();
  /** What each skill looked like before this session changed it, for undoing. */
  const was = new Map<string, skills.Skill | null>();
  /** Checked off this session, newest last. What a bare "not yet" undoes. */
  const checked: string[] = [];
  /** Things to tell the intern with whatever it hears next. */
  const aside: string[] = [];
  const withAside = (text: string) => {
    if (!aside.length) return text;
    const out = `${aside.join("\n")}\n\n${text}`;
    aside.length = 0;
    return out;
  };
  let hinted = false;

  function record(entry: skills.Entry) {
    // Capped here rather than in the schema: a fourth prerequisite is not worth failing the
    // tool call over.
    entry = { ...entry, requires: entry.requires.slice(0, 3) };
    const k = skills.key(entry.name);
    if (entry.solid && held.has(k)) return;
    const before = skills.find(skills.read(), entry.name);
    if (!was.has(k)) was.set(k, before ?? null);
    const t = skills.note(skills.read(), entry, repo.root);
    skills.write(t);
    store.setSkills(skills.summary(t, repo.root));
    // Shown, so a wrong entry can be disputed while it is fresh rather than discovered weeks
    // later as a question that stopped being asked.
    if (entry.solid && (!before?.solid || before.claimed)) {
      const name = skills.find(t, entry.name)?.name ?? entry.name;
      checked.push(name);
      const hint = hinted ? "" : "   (not yet keeps it off)";
      hinted = true;
      store.note(`+ skill: ${name}${entry.breadth === "niche" ? " (niche)" : ""}${hint}`);
    }
  }

  /** Is this skill theirs, for writing code on it in this file? */
  function holds(concept: string, path: string): boolean {
    if (held.has(skills.key(concept))) return false;
    return skills.holdsIn(skills.read(), concept, path, repo.root);
  }

  store.onNotYet = (name: string) => {
    const target = name ? skills.find(skills.read(), name)?.name : checked[checked.length - 1];
    if (!target) return false;
    const k = skills.key(target);
    held.add(k);
    const i = checked.findIndex((c) => skills.key(c) === k);
    if (i >= 0) checked.splice(i, 1);
    if (was.has(k)) {
      const prev = was.get(k)!;
      if (prev) skills.write({ skills: [prev] });
      else skills.remove(target);
    } else {
      const now = skills.find(skills.read(), target);
      if (now?.solid) skills.write({ skills: [{ ...now, solid: false, claimed: false }] });
    }
    store.setSkills(skills.summary(skills.read(), repo.root));
    store.note(`not yet: ${target} stays off your tree this session.`);
    aside.push(
      `(They said not to count "${target}" as known yet. Treat it as not on their tree: don't record it solid, and a hole for it stays theirs to type.)`,
    );
    return true;
  };
  // Holes left for them to type.
  let open = todos.load(repo.root);
  let handedOff = false;
  const readRel = (p: string) => {
    try {
      return readFileSync(resolve(repo.root, p), "utf8");
    } catch {
      return null;
    }
  };
  function setOpen(next: todos.Todo[]) {
    open = next;
    todos.save(repo.root, open);
    store.setTodos(open.map((t) => ({ concept: t.concept, path: t.path })));
  }
  setOpen(open);

  /** With holes open, what they say next might be explaining one instead of typing it. */
  function withHoles(text: string): string {
    if (!open.length || text.startsWith("They say they've typed")) return text;
    return [
      `(Open holes they haven't filled: ${open.map((t) => `"${t.concept}" in ${t.path}`).join(", ")}.`,
      "If what they say below explains one of those concepts, judge it like any answer. If it shows",
      "they hold it, call note_understanding with solid=true and then fill_todo for that hole - dum",
      "fills it in front of them. If it's close but missing something, ask ONE question that gets",
      "them the rest, and don't fill it. If it's a new request instead, handle it as one; the holes",
      "stay theirs.)",
      "",
      text,
    ].join("\n");
  }

  /** Put the first open hole under their cursor. */
  function handOff() {
    const t = open[0];
    if (!t) return;
    const body = readRel(t.path);
    store.openFile(t.path, body === null ? 0 : Math.max(0, todos.hole(body, t.concept)));
  }

  const wizard = new Wizard(repo);
  wizard.onModel((m, e) => store.setModel("wizard", m, e));
  wizard.start();

  // Breadth: answers `?` questions and reviews finished builds.
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
  const pending: { deliver: ((text: string) => void) | null } = { deliver: null };

  /** Their level in each language this repo or their tree touches, for the intern. */
  function levels(): string {
    if (mode !== "understand") return "";
    const t = skills.read();
    const langs = new Set([...repo.files.map(skills.langOf), ...t.skills.map((s) => s.lang)].filter(Boolean));
    const line = (l: string) => {
      const lv = skills.level(t, l);
      return `  ${l}: ${lv.name} (${lv.count} skills) - gaps up to ${lv.gap === Infinity ? "any size" : `${lv.gap} lines`}${lv.scaffold ? ", you write the rest" : ", everything through holes"}`;
    };
    return [
      "WHERE THEY ARE, PER LANGUAGE (the gate enforces these)",
      ...[...langs].map(line),
      "  any other language: novice (0 skills) - gaps up to 3 lines, you write the rest",
    ].join("\n");
  }

  /** The first turn: the bar, the skill tree, the repo, and the request. */
  function opening(req: string): string {
    return [
      BAR[mode],
      hooks.context?.() ?? "",
      levels(),
      mode === "understand" ? onboarding(skills.read()) : "",
      skills.describe(skills.read(), repo.root),
      describe(repo),
      `THEIR REQUEST:\n${withHoles(req)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function* turns(): AsyncGenerator<any> {
    // Coming back to finish a hole: "done" as the first thing said is the review, not a request
    // to build something called done.
    if (open.length && /^done[.!]*$/i.test(request.trim())) {
      const typed = open.filter((t) => !todos.untouched(open, readRel).includes(t));
      if (typed.length) {
        yield userTurn(todos.reviewTurn(typed));
      } else {
        store.note(`${open.map((t) => t.path).join(", ")} still as dum left it - type it in, :w, then done`);
        handOff();
        yield userTurn(opening("(nothing yet - they're about to type their TODO(dum) hole. Say nothing and end the turn.)"));
      }
    } else {
      yield userTurn(opening(request));
    }
    for (;;) {
      const next = await new Promise<string>((res) => (pending.deliver = res));
      if (!next || QUIT.has(next.toLowerCase())) return; // ends the query cleanly
      // Each new request earns its own spec.
      approved = false;
      currentRequest = next;
      yield userTurn(withAside(withHoles(next)));
    }
  }

  const tools = createSdkMcpServer({
    name: "dum",
    version: "1.0.0",
    // Never deferred: behind tool search the intern never loaded fill_todo.
    alwaysLoad: true,
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
          const reply = (await store.askQuestion(args.question, args.why_it_matters, true)).trim();
          if (todos.wantsToType(reply)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "They'll type this one instead of explaining it. Don't ask about it again and don't record it. Put it under \"you type\" in the spec, and when you build, leave a TODO(dum) hole for it and call leave_todo.",
                },
              ],
            };
          }
          if (reply && !notAnAnswer(reply)) {
            wizardLate = false;
            wizardPending = wizard.consider({ request: currentRequest, answer: reply });
          }
          return {
            content: [
              { type: "text" as const, text: withAside(reply || "(they said nothing - ask again)") },
            ],
          };
        },
      ),
      tool(
        "teach",
        "Teach a concept the engineer said they do not know. Never answers the pending question for them.",
        {
          concept: z.string().describe("The industry name for it"),
          what_it_is: z.string().describe("One or two sentences"),
          why_it_exists: z.string().describe("What breaks without it. One or two sentences"),
          in_industry: z.string().describe("Real-world use and the live tradeoffs. Two sentences at most"),
          here: z.string().describe("What it would mean in this specific repo. One sentence"),
          breadth: BREADTH,
          requires: REQUIRES,
          lang: LANG,
        },
        async ({ breadth, requires, lang, ...lesson }) => {
          await drainWizard();
          store.teach(lesson);
          // Recorded here rather than left to the model: it just taught the concept, so "they
          // did not hold this" is a fact, not a judgement.
          record({ name: lesson.concept, solid: false, breadth, requires, lang, why: "taught in session" });
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
        "Put a concept on their skill tree: one they showed they hold, or one they fumbled.",
        {
          concept: z
            .string()
            .describe("The industry name for it. Reuse the tree's exact name if it is already there."),
          solid: z
            .boolean()
            .describe("True if their answer showed they hold it, in any words. False if they fumbled it."),
          breadth: BREADTH,
          requires: REQUIRES,
          lang: LANG,
          why: z.string().describe("One sentence: what they said that showed it, or did not."),
          distinct: z
            .boolean()
            .optional()
            .describe("Set true only after being told a similar skill exists, if this is genuinely a different idea."),
        },
        async (args) => {
          // A near-duplicate is caught before it lands, and the intern decides.
          const near = args.distinct ? undefined : skills.similar(skills.read(), args.concept);
          if (near) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Not recorded yet. "${near.name}" is already on their tree. If "${args.concept}" is the same idea, call note_understanding again with concept "${near.name}". If it's genuinely different, call again with distinct: true.`,
                },
              ],
            };
          }
          record({
            name: args.concept,
            solid: args.solid,
            breadth: args.breadth,
            requires: args.requires,
            lang: args.lang,
            why: args.why,
          });
          return {
            content: [
              { type: "text" as const, text: "Recorded. Do not mention this to them." },
            ],
          };
        },
      ),
      tool(
        "fill_todo",
        "Hand dum the code for a TODO(dum) hole. dum writes it if the skill is known on their tree, and leaves the hole for them if not.",
        {
          path: z.string().describe("The file the hole is in, relative to the repo"),
          concept: z.string().describe("The skill this piece rests on - the name after TODO(dum):"),
          what: z.string().describe("What the code has to do. The same words as the hole."),
          lang: LANG,
          code: z.string().describe("The code that replaces the whole block - marker, comment lines and stub - indented to fit"),
          breadth: BREADTH,
          requires: REQUIRES,
        },
        async (args) => {
          const say = (text: string) => ({ content: [{ type: "text" as const, text }] });
          if (escapes(repo.root, args.path)) return say(`${args.path} is outside the repo.`);
          const path = rel(repo.root, args.path);
          // A hole already left under an approved spec can be filled on any later turn - that's
          // what explaining it afterwards is for.
          const waiting = open.find((o) => o.path === path && skills.key(o.concept) === skills.key(args.concept));
          if (!approved && !waiting) return say("Not yet - holes are filled while building, after the spec is approved.");
          const body = readRel(path);
          if (body === null) return say(`${path} doesn't exist. Write the file with its holes first.`);
          const at = todos.hole(body, args.concept);
          if (at < 0) return say(`There's no ${todos.MARKER} line for that in ${path}. Write the hole first.`);
          // The block is on screen before anything happens to it, whichever way it goes: that's
          // how you see what the build rested on.
          store.openFile(path, at);
          await new Promise((r) => setTimeout(r, FLASH_MS));
          if (mode === "understand" && !holds(args.concept, path)) {
            // The gap is sized to where they are: a novice gets the core line
            // or three, not the whole function.
            const lv = skills.level(skills.read(), skills.langOf(path));
            const lines = args.code.replace(/\n+$/, "").split("\n").filter((l) => l.trim()).length;
            if (lines > lv.gap) {
              return say(
                `Too big a gap for a ${lv.name} in ${skills.langOf(path) || "this"} (${lv.count} skills): ${lines} lines, at most ${lv.gap}. Write the scaffolding around it yourself, and leave only the core of "${args.concept}" as the hole - rewrite this block, it isn't theirs yet.`,
              );
            }
            const t: todos.Todo = {
              concept: args.concept.trim(),
              path,
              what: args.what.trim(),
              breadth: args.breadth,
              requires: args.requires.slice(0, 3),
              before: body,
              request: currentRequest,
              lang: args.lang,
            };
            setOpen([...open.filter((o) => skills.key(o.concept) !== skills.key(t.concept)), t]);
            handedOff = false;
            store.toolEvent("hole", `${path}: ${t.concept}`, "held");
            const lang = skills.langOf(path);
            const why = lang && !skills.spoken(skills.read(), lang)
              ? `They haven't shown anything in ${lang} yet, so every line of ${path} is theirs until they do - even ideas they hold.`
              : `"${t.concept}" isn't known on their tree${lang ? ` for ${lang}` : ""}, so the hole stays for them to type.`;
            return say(`${why} Don't write it any other way.`);
          }
          // A fill is one concept's worth of code.
          const size = args.code.replace(/\n+$/, "").split("\n").filter((l) => l.trim()).length;
          if (size > FILL_MAX_LINES) {
            return say(
              `That's ${size} lines under one concept - at most ${FILL_MAX_LINES}. Split the block into holes, one concept each: whatever it also leans on (includes, printing, loops, a class shell) is its own hole, and those stay theirs unless they're on the tree.`,
            );
          }
          const filled = todos.fill(body, args.concept, args.code);
          if (filled === null) return say(`Couldn't find the block for that in ${path}.`);
          // Animate the fill so held-skill code is seen, not just dropped in.
          const code = args.code.replace(/\n+$/, "");
          const ms = Math.min(FILL_MAX_MS, Math.max(FILL_MIN_MS, code.length * 12));
          const frames = Math.max(1, Math.round(ms / FILL_FRAME_MS));
          for (let f = 1; f <= frames; f++) {
            const part = todos.fill(body, args.concept, code.slice(0, Math.ceil((code.length * f) / frames)));
            if (part !== null) store.typing(path, part, at);
            await new Promise((r) => setTimeout(r, FILL_FRAME_MS));
          }
          try {
            writeFileSync(resolve(repo.root, path), filled);
          } catch (err) {
            return say(`Couldn't write ${path}: ${(err as Error).message}`);
          }
          wrote.push(path);
          store.filled(path, args.concept.trim(), code);
          store.openFile(path, at);
          if (!approved) filledLate = true;
          if (waiting) {
            setOpen(open.filter((o) => o !== waiting));
            if (waiting.request && !open.some((o) => o.request === waiting.request)) hooks.onBuilt?.(waiting.request);
          }
          return say("Filled.");
        },
      ),
      tool(
        "leave_todo",
        "Register a TODO(dum) hole you left in a file for them to type. Only after the spec is approved, and only after the hole is written.",
        {
          path: z.string().describe("The file the hole is in, relative to the repo"),
          concept: z.string().describe("The skill typing it unlocks - the industry name, reusing the tree's name if it's there"),
          what: z.string().describe("What their code has to do. The same words as the hole. Never how."),
          lang: LANG,
          breadth: BREADTH,
          requires: REQUIRES,
        },
        async (args) => {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }] });
          if (!approved) return fail("Not yet - holes are left while building, after the spec is approved.");
          if (escapes(repo.root, args.path)) return fail(`${args.path} is outside the repo.`);
          const path = rel(repo.root, args.path);
          const body = readRel(path);
          if (body === null) return fail(`${path} doesn't exist. Write the file with the hole first.`);
          if (todos.hole(body, args.concept) < 0) {
            return fail(`There's no ${todos.MARKER} line in ${path}. Write the hole first, then call this again.`);
          }
          const t: todos.Todo = {
            concept: args.concept.trim(),
            path,
            what: args.what.trim(),
            breadth: args.breadth,
            requires: args.requires.slice(0, 3),
            before: body,
            request: currentRequest,
            lang: args.lang,
          };
          setOpen([...open.filter((o) => skills.key(o.concept) !== skills.key(t.concept)), t]);
          handedOff = false;
          return fail("Left. Tell them where it is in one line after the build.");
        },
      ),
      tool(
        "check_todo",
        "Judge the code they typed into a TODO(dum) hole. Passing unlocks the skill.",
        {
          concept: z.string().describe("The hole's concept, exactly as registered"),
          passed: z.boolean().describe("True if their code does what the hole said and would work"),
          feedback: z
            .string()
            .describe("If it failed: one question that makes them run the failing case in their head. Never the fix. If it passed: one short line on what they got right."),
        },
        async (args) => {
          const t = open.find((o) => skills.key(o.concept) === skills.key(args.concept));
          if (!t) {
            return { content: [{ type: "text" as const, text: `No open hole called "${args.concept}". Open: ${open.map((o) => o.concept).join(", ") || "none"}.` }] };
          }
          store.say(args.feedback);
          if (args.passed) {
            setOpen(open.filter((o) => o !== t));
            if (t.request && !open.some((o) => o.request === t.request)) hooks.onBuilt?.(t.request);
            record({
              name: t.concept,
              solid: true,
              breadth: t.breadth,
              requires: t.requires,
              lang: t.lang,
              why: `typed it themselves in ${t.path}: ${args.feedback}`,
            });
          }
          return {
            content: [
              {
                type: "text" as const,
                text: args.passed
                  ? "Passed and recorded. They saw your line - say nothing else about it."
                  : "Still open. They saw your question - say nothing else this turn, and don't fix it for them.",
              },
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
   * Whether the gate was engaged at all this turn - a write held, or a spec shown and turned
   * down.
   */
  let gateEngaged = false;

  /** A hole from an earlier spec got filled this turn, by explaining it. */
  let filledLate = false;

  /** TODO(dum) blocks written under this request so far. */
  let holesThisTurn = 0;

  /** Tool inputs still being generated, by content-block index. */
  const openBlocks = new Map<number, { name: string; buf: string }>();

  /** Writes the gate let through, by tool-use id, until their result arrives. */
  const landing = new Map<string, string>();

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
      // The feed the code pane is built on.
      includePartialMessages: true,
      ...(resume ? { resume } : {}),
      // dum's own tools are let through here rather than listed in allowedTools.
      canUseTool: async (name: string, args: Record<string, unknown>) => {
        if (name.startsWith("mcp__dum__")) {
          return { behavior: "allow" as const, updatedInput: args };
        }
        // Filling a hole is dum's call, made off the tree in fill_todo.
        const more = mode === "understand" ? newHoles(repo.root, name, args) : 0;
        if (more && holesThisTurn + more > MAX_HOLES) {
          store.toolEvent(name, detail(repo.root, args), "refused", `more than ${MAX_HOLES} holes at once`);
          return {
            behavior: "deny" as const,
            message: `That's ${holesThisTurn + more} holes in one request - at most ${MAX_HOLES}, about what working memory holds at once. Don't merge blocks to fit: that's the same load in bigger pieces. Build the part that fits in ${MAX_HOLES} concepts, and name the rest as the next request in one line.`,
          };
        }
        // Comments in their code are short: the code is theirs to read, not an essay to scroll
        // past.
        const essay = wordyCode(name, args);
        if (essay.length) {
          store.toolEvent(name, detail(repo.root, args), "refused", "comments too long");
          return {
            behavior: "deny" as const,
            message: `Comments are at most ${todos.MAX_COMMENT_RUN} lines in a row - a hole's description, a file header, anything. Too long: ${essay
              .slice(0, 2)
              .map((l) => JSON.stringify(l))
              .join(", ")}. Say why, not what, in a line.`,
          };
        }
        // Fading: a novice in this language gets the scaffolding written for
        // them, so only a fluent one has every line go through a hole.
        const target = typeof args.file_path === "string" ? args.file_path : "";
        const lv = skills.level(skills.read(), skills.langOf(target));
        const leak = mode === "understand" && !lv.scaffold ? looseCode(name, args) : [];
        if (leak.length) {
          store.toolEvent(name, detail(repo.root, args), "refused", "code outside a hole");
          return {
            behavior: "deny" as const,
            message: `In understand mode, code only goes in through holes. These lines aren't in a ${todos.MARKER} block: ${leak
              .slice(0, 3)
              .map((l) => JSON.stringify(l.trim()))
              .join(", ")}${leak.length > 3 ? ` (+${leak.length - 3} more)` : ""}. Write the file as comments and TODO(dum) blocks only - includes, imports and control flow too - then call fill_todo for each block. dum fills the ones on their tree; the rest are theirs to type or explain.`,
          };
        }
        holesThisTurn += more;
        if (erasesHole(repo.root, name, args, open.map((t) => t.concept))) {
          store.toolEvent(name, detail(repo.root, args), "refused", "a hole is filled through dum, not edited");
          return {
            behavior: "deny" as const,
            message: "TODO(dum) blocks are filled through fill_todo, never edited directly.",
          };
        }
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
        // Only things with a real path field.
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
        // Read off the session rather than assumed: the intern inherits the default model from
        // their settings, so it's whatever that is today.
        if (typeof msg.model === "string") {
          store.setModel("intern", msg.model);
          // Effort too: it follows their own /effort setting, so it's whatever that resolves to
          // for this model today.
          void applied(session).then((a) => a && store.setModel("intern", a.model || msg.model, a.effort));
        }
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
          if (b.type === "tool_use" && b.id && WATCHED[b.name]) {
            const path = detail(repo.root, b.input);
            if (path) landing.set(b.id, path);
          }
          // Tool calls render from canUseTool, the only place that knows if they ran.
        }
        continue;
      }
      if (msg.type === "user") {
        const content = msg.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          const path = b.type === "tool_result" ? landing.get(b.tool_use_id) : undefined;
          if (!path) continue;
          landing.delete(b.tool_use_id);
          store.landed(path);
        }
        continue;
      }
      if (msg.type === "result") {
        await drainWizard();
        for (const why of blocked) store.note(`refused: ${why}`);
        blocked.length = 0;
        // A turn that filled an earlier hole built something, even with no spec of its own.
        if (!approved && gateEngaged) store.note(filledLate ? "nothing else was built - this turn had no spec of its own." : "spec not approved - nothing was built.");
        gateEngaged = false;
        filledLate = false;
        holesThisTurn = 0;

        // Review the build against its spec; silent unless it departs.
        if (approved && wrote.length && !open.some((t) => t.request === currentRequest)) hooks.onBuilt?.(currentRequest);
        if (approved && wrote.length) {
          const files = [...new Set(wrote)];
          wrote.length = 0;
          wdebug("review: checking", files.join(", "));
          // A hole is a stub on purpose.
          const holes = open.length
            ? `\n\nLEFT FOR THEM TO TYPE, ON PURPOSE - a stub at a ${todos.MARKER} hole is not a departure:\n${open.map((t) => `- ${t.concept} in ${t.path}`).join("\n")}`
            : "";
          const found = await reference.review(approvedSpec + holes, files);
          wdebug(found ? `review: found "${found.slice(0, 80)}"` : "review: ok");
          if (found) store.review(found);
        }

        // The turn is over, not the session.
        const failed = failure(msg);
        if (!failed && open.length && !handedOff) {
          handedOff = true;
          handOff();
        }
        let next = "";
        store.setSuggestion(hooks.suggest?.() ?? "");
        for (;;) {
          next = (
            failed
              ? await store.askQuestion(failed, "type anything to try again once it's fixed, or exit")
              : await store.askNext()
          ).trim();
          if (failed || !open.length || !/^done[.!]*$/i.test(next)) break;
          // Settled here rather than spending a turn on it: nothing changed.
          const same = todos.untouched(open, readRel);
          if (same.length < open.length) {
            next = todos.reviewTurn(open.filter((t) => !same.includes(t)));
            break;
          }
          store.note(`${open.map((t) => t.path).join(", ")} ${open.length === 1 ? "is" : "are"} still as dum left ${open.length === 1 ? "it" : "them"} - type it in, :w, then done`);
          handOff();
        }
        if (hooks.expand && !failed) next = hooks.expand(next);
        pending.deliver?.(next);
        if (!next || QUIT.has(next.toLowerCase())) return;
        continue;
      }
    }
  } finally {
    // Both hold a process open; nothing else ends them.
    wizard.close();
    reference.close();
  }
}

/** A reply that says they don't have it, rather than saying anything. */
export function notAnAnswer(reply: string): boolean {
  return /^(idk|i don'?t know|dunno|no idea|not sure|no clue|\?+|what do you mean\??|huh\??)[.!]*$/i.test(
    reply.trim(),
  );
}

/** Comment runs over the limit that a Write or Edit would add, in a source file. */
export function wordyCode(name: string, args: Record<string, unknown>): string[] {
  const path = typeof args.file_path === "string" ? args.file_path : "";
  if (!path || !todos.gated(path)) return [];
  if (name === "Write") return todos.wordy(String(args.content ?? ""), path);
  if (name === "Edit") return todos.wordy(String(args.new_string ?? ""), path);
  if (name === "MultiEdit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return edits.flatMap((e: any) => todos.wordy(String(e?.new_string ?? ""), path));
  }
  return [];
}

/** How many TODO(dum) blocks a Write or Edit would add. */
export function newHoles(root: string, name: string, args: Record<string, unknown>): number {
  const count = (s: unknown) => todos.spans(String(s ?? "")).length;
  if (name === "Write") {
    let now = "";
    try {
      now = readFileSync(resolve(root, String(args.file_path ?? "")), "utf8");
    } catch {
      /* new file */
    }
    return Math.max(0, count(args.content) - count(now));
  }
  if (name === "Edit") return Math.max(0, count(args.new_string) - count(args.old_string));
  if (name === "MultiEdit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return Math.max(0, edits.reduce((a: number, e: any) => a + count(e?.new_string) - count(e?.old_string), 0));
  }
  return 0;
}

/** Code lines a Write or Edit would add outside any hole, in a gated source file. */
export function looseCode(name: string, args: Record<string, unknown>): string[] {
  const path = typeof args.file_path === "string" ? args.file_path : "";
  if (!path || !todos.gated(path)) return [];
  if (name === "Write") return todos.loose(String(args.content ?? ""), path);
  if (name === "Edit") return todos.loose(String(args.new_string ?? ""), path);
  if (name === "MultiEdit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return edits.flatMap((e: any) => todos.loose(String(e?.new_string ?? ""), path));
  }
  return [];
}

/** Whether a tool call would rewrite a TODO(dum) block that already exists. */
export function erasesHole(root: string, name: string, args: Record<string, unknown>, open?: string[]): boolean {
  const markers = (s: unknown) => String(s ?? "").split("\n").filter((l) => l.includes(todos.MARKER));
  let gone: string[] = [];
  if (name === "Edit") gone = markers(args.old_string);
  else if (name === "MultiEdit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    gone = edits.flatMap((e: any) => markers(e?.old_string));
  } else if (name === "Write" && typeof args.file_path === "string") {
    let now: string;
    try {
      now = readFileSync(resolve(root, args.file_path), "utf8");
    } catch {
      return false; // a new file can't erase anything
    }
    const next = String(args.content ?? "");
    gone = markers(now).filter((l) => !next.includes(l.trim()));
  }
  // Only a hole already handed to them is theirs. One the intern is still
  // shaping - say, cutting down to size - it may rewrite.
  if (!open) return gone.length > 0;
  const concept = (l: string) => skills.key(l.slice(l.indexOf(todos.MARKER) + todos.MARKER.length).replace(/^[:\s]+/, ""));
  return gone.some((l) => open.some((c) => skills.key(c) === concept(l)));
}

/** Where dum-intern itself is installed, for telling someone what to update. */
const HOME = resolve(new URL("..", import.meta.url).pathname);

/** What to tell them when a turn ended on an error, or null if it did not. */
export function failure(msg: { is_error?: boolean; subtype?: string; result?: unknown }): string | null {
  if (!msg.is_error && (!msg.subtype || msg.subtype === "success")) return null;
  const text = typeof msg.result === "string" && msg.result.trim() ? msg.result.trim() : `the turn stopped (${msg.subtype})`;
  if (/does not support this model|or newer is required/i.test(text)) {
    return `your default model is newer than the Claude Code dum runs on. update it with: cd ${HOME} && npm update @anthropic-ai/claude-agent-sdk`;
  }
  return `that failed - ${text}`;
}

/** Wrap plain text as the SDK's user-turn shape. */
function userTurn(text: string) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
  };
}

/** One short line about what a tool call is doing. */
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

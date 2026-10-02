// One intern, one conversation.

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, type Repo } from "./repo.ts";
import { peekString, WATCHED } from "./stream.ts";
import * as skills from "./skills.ts";
import * as curriculum from "./curriculum.ts";
import * as course from "./course.ts";
import * as todos from "./todos.ts";
import { sentences } from "./lines.ts";
import type { Store } from "./store.ts";
import { debugTo } from "./debug.ts";

/** What a locked skill costs you: typing it, or explaining it. Either way a course unlocks it. */
export type Mode = "understand" | "anti-vibe";

const BAR: Record<Mode, string> = {
  understand: `MODE: understand everything. A locked skill is theirs to TYPE - or to unlock
with a course first. Explaining it doesn't unlock anything in this mode.`,
  "anti-vibe": `MODE: anti-vibe. A locked skill is theirs to EXPLAIN in plain words - or to
unlock with a course first. Once an explanation holds, you fill that hole.`,
};

const THEIR_TURN: Record<Mode, string> = {
  understand: `THEIR TURN
When they say they've typed a hole you'll be asked to check it. Read their code
and call check_todo. Judge it like a reviewer: does it do what the hole said, and
would it work? Not whether it matches what you'd have written. A failure gets a
question that makes them find it - never the fix, and never touch their code.
If they try to explain a hole instead, say in one line that here it's type it
or take the course.`,
  "anti-vibe": `THEIR TURN
When they explain a hole, judge the explanation with check_explanation. It
passes when it shows they get how that code works, in any words - the gist is
enough, don't hold out for jargon. "yes" or a restated task is not an
explanation. When it passes, call fill_todo for that hole. Close but missing
something: one question that gets them the rest. Wrong: say what's off in one
line. If they type the code and say done instead, check it with check_todo.`,
};

const CONTRACT = `You are dum-intern: one intern, working for an engineer who wants to own every
line of what gets built. You're a strong builder. What makes you different is a
rule enforced in code: you only write code on skills they've unlocked.

HOW IT WORKS
They have a skill tree. Every request rests on a handful of skills.
- A skill on their tree is unlocked: you write that code.
- A skill that isn't is locked. Its code becomes a TODO(dum) hole that's theirs.
  Or they unlock it first with a short course - dum and the wizard run those,
  not you. They start one by typing "course <skill>".
- A course only opens once everything the skill builds on is unlocked. Someone
  who can't print hello world doesn't get to unlock recursion.

YOUR TOOLS - use them instead of writing questions as prose
  ask           ONE question, only when the request has a real hole in intent
  propose_plan  the skills this build rests on, before anything is written
  fill_todo     after approval: the code for one TODO(dum) block
  check_todo    judge a hole they typed
  point         pin a short comment to a line of their code

ASKING
Ask only where intent has a hole: two reasonable readings produce different
software and only they can say which they meant. Most requests need no
question at all. Never quiz them on how something works - locked skills and
courses do that. Never ask what the repo already answers.

THE PLAN
Before writing anything, call propose_plan. pieces is every skill the code rests
on, one per entry: printing, the loop, the data structure, the one idea the
request is about.
- spell each skill the way THE CURATED TRACKS below spell it, in the language of
  the file it goes in. A skill on no track: give requires - up to three skills
  it builds on directly, track names where they fit.
- the program skeleton (includes, imports, main) is part of the language's
  first skill, printing.
- dum lays out which pieces are unlocked and which are locked. Don't repeat it.
- at most four locked pieces. If the request needs more, it's above their tree:
  don't propose it. Say so in one line and offer the first rung instead - one
  small, whole program at their level that leads toward it. dum refuses a plan
  with more locked pieces anyway.
- a reply other than yes comes back as declined, with their words. Adjust and
  propose again, or answer what they asked.

BUILDING
After approval, write each source file as TODO(dum) blocks and nothing else -
every line of code goes through one. Then call fill_todo for every block with
the code that goes there, indented to fit.
- a block is a comment in the file's own syntax. First line exactly
  \`TODO(dum): <skill>\`, the skill as named in the plan. Then one line saying
  what the code must do - never how. Then one stub line so the file still runs
  where the language allows it (\`pass\`, \`todo!()\`, \`return 0;\`).
- one skill per block, at most 12 lines of code in it. One block per locked skill.
- dum writes the unlocked blocks in front of them and leaves the locked ones as
  holes. Don't argue and don't write a locked block another way.
- you can't Edit a TODO(dum) block once it's theirs. The gate refuses it.
- a lone closing brace may sit outside a block. Nothing else may.
- comments you write anywhere: three lines in a row at most, one line of why.
- lessons don't go in their files. Courses are where teaching happens.

HOW YOU TALK
You're a teammate typing in the same terminal, not a document.
- contractions always. short sentences. a semicolon means it's two sentences.
- no openers and no sign-offs. no "Great question", no "Let me know if".
- none of "utilize", "leverage", "ensure", "facilitate", "robust",
  "essentially", "it's worth noting", "in order to", "additionally".
- plain dashes only, never an em dash.
- casual is not sloppy. technical terms stay exact.
- locked, unlocked and course are words they know. The gate, fill_todo and
  tool names are not - never name dum's machinery.

KEEP IT SHORT
Every long message is a turn they stop playing. The screen already shows the
plan, files written, holes left and skills unlocked - never repeat any of it.
- lead with the thing. at most five bullets in any list. no tangents.
- AFTER A BUILD, one short paragraph: what works now, as something they can run
  or see. "echo server runs: python server.py, then type into the client."
  Nothing you write before a tool call in a build is shown, so don't narrate.
- "recommend me a project" or "any ideas" is a request for a suggestion, not a
  build: under 200 characters.

TELLING THEM TO RUN SOMETHING
Say it the way the screen works: "shift-tab to the shell, then type
g++ guess.cpp -o guess && ./guess". You can't run their program on a review turn.

DUM'S OWN COMMANDS
When they ask for something dum does, name it in one line:
  course <skill>          unlock a skill with a short course
  :skills                 see what's unlocked, open and locked
  not yet                 take back the skill just unlocked
  dum --forget "<skill>"  take one off for good
  :help                   everything else

YOUR MEMORY HAS A CUTOFF
There are libraries, versions and models newer than anything you remember. If
they name one you don't recognise, look it up before you say a word about it.

AFTER APPROVAL
Build it. Stay inside this repository. If following the plan would produce
something broken, say so before building it.`;

/** Paths the intern may touch. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"];

/** Tools that can change something, denied until the plan is approved. */
const MUTATING = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"]);

/** Locked pieces one plan may carry. Working memory holds about four chunks (Cowan, 2001). */
export const MAX_LOCKED = 4;

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

/** How long a hole sits on screen before dum fills it or leaves it. */
const FLASH_MS = 900;

/** The most code one block may carry. One skill, not a function's worth of them. */
const FILL_MAX_LINES = 12;

/** A fill types itself in over this long, scaled to its length. */
const FILL_MIN_MS = 700;
const FILL_MAX_MS = 2500;
const FILL_FRAME_MS = 50;

/** One skill a plan rests on, and where it stands on their tree. */
export type Piece = { skill: string; lang: string; what: string; status: curriculum.Status };

/** The pieces a plan names, spelled the tracks' way and checked against the tree. */
export function classify(
  t: skills.Tree,
  raw: { skill: string; lang?: string; what: string; requires?: string[] }[],
  held: Set<string> = new Set(),
): Piece[] {
  const out: Piece[] = [];
  for (const p of raw) {
    const lang = skills.langName(p.lang ?? "");
    const skill = curriculum.canonical(p.skill, lang);
    if (!skills.key(skill) || out.some((o) => skills.id(o.skill, o.lang) === skills.id(skill, lang))) continue;
    if (p.requires?.length) curriculum.map(skill, lang, p.requires);
    let status = curriculum.status(t, skill, lang);
    // Taken back this session with "not yet": locked, whatever the tree says.
    if (held.has(skills.id(skill, lang)) && status.state === "unlocked") status = { state: "open" };
    out.push({ skill, lang, what: p.what.replace(/\s+/g, " ").trim(), status });
  }
  return out;
}

/**
 * The plan, laid out by dum. The intern names the skills; whether each is unlocked is the
 * tree's call, made here in code, never the model's.
 */
export function planCard(summary: string, pieces: Piece[], mode: Mode, run = ""): string {
  const one = (t: string) => t.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  const name = (p: Piece) => skills.label({ name: p.skill, lang: p.lang });
  const mine = pieces.filter((p) => p.status.state === "unlocked");
  const open = pieces.filter((p) => p.status.state === "open");
  const deep = pieces.filter((p) => p.status.state === "locked");
  const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines, ""] : []);
  return [
    `**${one(summary)}**`,
    "",
    ...section(
      "dum writes",
      mine.map((p) => `- ${name(p)}`),
    ),
    ...section(
      mode === "anti-vibe" ? "you explain, or take the course" : "you type, or take the course",
      open.map((p) => `- ${name(p)}: ${one(p.what)} · \`course ${p.skill}\``),
    ),
    ...section(
      "locked deeper",
      deep.map((p) => {
        const st = p.status as Extract<curriculum.Status, { state: "locked" }>;
        return `- ${name(p)}: needs ${st.missing.join(", ")}${st.next ? ` · start with \`course ${st.next}\`` : ""}`;
      }),
    ),
    ...(run ? ["## run", `- \`${one(run)}\``] : []),
  ]
    .join("\n")
    .trim();
}

export async function run(request: string, repo: Repo, mode: Mode, store: Store) {
  let approved = false;
  let currentRequest = request;
  /** The plan in force: what was shown, by piece. */
  let plan: Piece[] = [];
  debugTo(repo.root);
  store.setUnlocked(skills.read().skills.length);

  /** Taken back this session with "not yet", by skill id. */
  const held = new Set<string>();
  /** What each skill looked like before this session changed it, for undoing. */
  const was = new Map<string, skills.Skill | null>();
  /** Unlocked this session, newest last. What a bare "not yet" undoes. */
  const checked: { name: string; lang: string }[] = [];
  /** Things to tell the intern with whatever it hears next. */
  const aside: string[] = [];
  const withAside = (text: string) => {
    if (!aside.length) return text;
    const out = `${aside.join("\n")}\n\n${text}`;
    aside.length = 0;
    return out;
  };
  let hinted = false;

  /** Put a skill on the tree. Every way onto it comes through here, so "not yet" can undo any. */
  function unlock(u: skills.Unlock) {
    const lang = skills.langName(u.lang ?? "");
    const k = skills.id(u.name, lang);
    held.delete(k);
    const t = skills.read();
    const before = skills.find(t, u.name, lang);
    if (!was.has(k)) was.set(k, before ?? null);
    const next = skills.unlock(t, { ...u, lang });
    skills.write(next);
    store.setUnlocked(next.skills.length);
    if (before) return;
    const name = skills.find(next, u.name, lang)?.name ?? u.name;
    checked.push({ name, lang });
    // Shown, so a wrong unlock can be disputed while it's fresh.
    const hint = hinted ? "" : " - not yet takes it back";
    hinted = true;
    store.note(`+ skill: ${skills.label({ name, lang })}${hint}`);
  }

  /** Is this skill theirs, for dum to write code on it in this file? */
  function holds(concept: string, path: string): boolean {
    const lang = skills.langOf(path);
    if (held.has(skills.id(concept, lang)) || held.has(skills.id(concept, ""))) return false;
    return skills.holds(skills.read(), concept, lang);
  }

  store.onNotYet = (name: string) => {
    const target = name
      ? checked.find((c) => skills.key(c.name) === skills.key(name)) ?? skills.named(skills.read(), name)[0]
      : checked[checked.length - 1];
    if (!target) return false;
    const k = skills.id(target.name, target.lang);
    held.add(k);
    const i = checked.findIndex((c) => skills.id(c.name, c.lang) === k);
    if (i >= 0) checked.splice(i, 1);
    const prev = was.get(k);
    if (prev) skills.write({ skills: [prev] });
    else skills.remove(target.name, target.lang);
    store.setUnlocked(skills.read().skills.length);
    const label = skills.label(target);
    store.note(`not yet: ${label} stays locked this session.`);
    aside.push(`(They said not to count "${label}" as unlocked yet. Treat it as locked: a hole for it stays theirs.)`);
    return true;
  };

  // Holes left for them.
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

  /** With holes open, what they say next might be about one of them. */
  function withHoles(text: string): string {
    if (!open.length || text.startsWith("They say they've typed") || text.startsWith("(They just unlocked")) return text;
    const list = open.map((t) => `"${t.concept}" in ${t.path}`).join(", ");
    return [
      `(Open holes that are theirs: ${list}.`,
      mode === "anti-vibe"
        ? "If what they say below explains one of those, judge it with check_explanation, and when it passes call fill_todo for it. If it's a new request instead, handle it as one; the holes stay theirs.)"
        : "Explaining one doesn't unlock it here - if they try, say in one line it's type it or take the course. If it's a new request, handle it as one; the holes stay theirs.)",
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

  /** The language a bare `course x` means: what the plan, a hole or the open file says. */
  function langFor(skill: string): string {
    const k = skills.key(skill);
    const inPlan = plan.find((p) => skills.key(p.skill) === k && p.lang);
    if (inPlan) return inPlan.lang;
    const hole = open.find((t) => skills.key(t.concept) === k);
    if (hole) return skills.langName(hole.lang ?? "") || skills.langOf(hole.path);
    const showing = store.getSnapshot().code?.path;
    if (showing && skills.langOf(showing) && !showing.startsWith(".dum/")) return skills.langOf(showing);
    return mainLang(repo);
  }

  /**
   * A course, from wherever they asked for it. If it unlocks the skill under one of their open
   * holes, the turn that fills that hole comes back to be sent to the intern.
   */
  async function takeCourse(cmd: { skill: string; lang: string }): Promise<string | null> {
    const lang = cmd.lang || langFor(cmd.skill);
    const passed = await course.take(cmd.skill, lang, { store, root: repo.root, unlock });
    if (!passed) return null;
    const name = curriculum.canonical(cmd.skill, lang);
    const hole = open.find((t) => skills.key(t.concept) === skills.key(name) && holds(t.concept, t.path));
    if (!hole) return null;
    return `(They just unlocked "${hole.concept}" through a course. Fill its open hole in ${hole.path} with fill_todo now, then say nothing else.)`;
  }

  /** At any prompt, "course x" runs the course right there, then the prompt comes back. */
  async function listen(ask: () => Promise<string>): Promise<string> {
    for (;;) {
      const reply = (await ask()).trim();
      const cmd = course.parseCommand(reply);
      if (!cmd) return reply;
      const fill = await takeCourse(cmd);
      if (fill) return fill;
    }
  }

  // The session outlives a single request.
  const pending: { deliver: ((text: string) => void) | null } = { deliver: null };

  /** The first turn: the bar, the tree, the tracks, the repo, and the request. */
  function opening(req: string): string {
    return [
      BAR[mode],
      skills.describe(skills.read()),
      tracks(),
      describe(repo),
      `THEIR REQUEST:\n${withHoles(req)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // A course can be the first thing asked for, before the intern has a turn.
  while (course.parseCommand(request)) {
    const fill = await takeCourse(course.parseCommand(request)!);
    if (fill) break;
    request = (await store.askNext()).trim();
    if (!request || QUIT.has(request.toLowerCase())) return;
  }

  async function* turns(): AsyncGenerator<any> {
    // Coming back to finish a hole: "done" as the first thing said is the review, not a request
    // to build something called done.
    if (open.length && /^done[.!]*$/i.test(request.trim())) {
      const typed = open.filter((t) => !todos.untouched(open, readRel).includes(t));
      if (typed.length) {
        yield userTurn(opening(todos.reviewTurn(typed)));
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
      // Each new request earns its own plan.
      approved = false;
      currentRequest = next;
      store.unpin();
      yield userTurn(withAside(withHoles(next)));
    }
  }

  const PIECE = z.object({
    skill: z.string().describe("The skill, spelled the way the curated track spells it"),
    lang: z.string().optional().describe("The language of the file this code goes in. Leave out only for an idea with no code."),
    what: z.string().max(100).describe("What this piece of code does, in a few words"),
    requires: z
      .array(z.string())
      .max(3)
      .optional()
      .describe("Only for a skill on no curated track: up to three skills it builds on directly"),
  });

  const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

  const tools = createSdkMcpServer({
    name: "dum",
    version: "1.0.0",
    // Never deferred: behind tool search the intern never loaded fill_todo.
    alwaysLoad: true,
    tools: [
      tool(
        "ask",
        "Ask the engineer ONE question about what they want and get their reply. Only for a real hole in intent - never to quiz them.",
        {
          question: z.string().describe("The question itself. One decision, one sentence."),
          why_it_matters: z.string().describe("One sentence: what changes depending on their answer."),
        },
        async (args) => {
          const reply = await listen(() => store.askQuestion(args.question, args.why_it_matters));
          return say(withAside(reply || "(they said nothing - ask again, or go with the obvious reading)"));
        },
      ),
      tool(
        "propose_plan",
        "Show the engineer the skills this build rests on and ask whether to build it. dum marks each piece unlocked or locked from their tree.",
        {
          summary: z.string().max(140).describe("One sentence: what they'll have when it's built"),
          pieces: z.array(PIECE).max(10).describe("Every skill the code rests on, one per entry"),
          run: z.string().max(120).optional().describe("The command to run it, if there is one"),
        },
        async (args) => {
          let pieces = classify(skills.read(), args.pieces, held);
          const locked = pieces.filter((p) => p.status.state !== "unlocked");
          if (locked.length > MAX_LOCKED) {
            return say(
              `Not shown to them: ${locked.length} of these are locked (${locked.map((p) => p.skill).join(", ")}), at most ${MAX_LOCKED}. It's above their tree. Tell them so in one line and offer the first rung - one small, whole program on what they have plus one or two new skills - then propose that. Don't mention this limit.`,
            );
          }
          for (;;) {
            plan = pieces;
            const reply = await store.proposePlan(planCard(args.summary, pieces, mode, args.run));
            if (/^(y|yes)$/i.test(reply)) {
              approved = true;
              return say("Approved. Build it now.");
            }
            const cmd = course.parseCommand(reply);
            if (!cmd) {
              return say(`Declined. They said: "${reply}". Ask what they want changed, or adjust and propose again - build nothing yet.`);
            }
            // A course from the plan, then the plan again with whatever it unlocked.
            await takeCourse({ skill: cmd.skill, lang: cmd.lang || langFor(cmd.skill) });
            pieces = classify(skills.read(), args.pieces, held);
          }
        },
      ),
      tool(
        "point",
        "Pin a live comment to a line of a file, shown beside their code and never saved. How you talk about a specific line, instead of describing where it is.",
        {
          path: z.string().describe("The file, relative to the repo"),
          line: z.number().int().positive().describe("The line, 1-based"),
          text: z.string().max(60).describe("Under 60 characters: what to notice about this line"),
        },
        async (args) => {
          if (escapes(repo.root, args.path)) return say(`${args.path} is outside the repo.`);
          store.pin(rel(repo.root, args.path), args.line, args.text.replace(/\s+/g, " ").trim());
          return say("Pinned. It's beside that line now - don't repeat it in words.");
        },
      ),
      tool(
        "fill_todo",
        "Hand dum the code for a TODO(dum) block. dum writes it if the skill is unlocked, and leaves the hole for them if it's locked.",
        {
          path: z.string().describe("The file the block is in, relative to the repo"),
          concept: z.string().describe("The skill this block rests on - the name after TODO(dum):"),
          what: z.string().describe("What the code has to do. The same words as the block."),
          code: z.string().describe("The code that replaces the whole block - marker, comment lines and stub - indented to fit"),
        },
        async (args) => {
          if (escapes(repo.root, args.path)) return say(`${args.path} is outside the repo.`);
          const path = rel(repo.root, args.path);
          const lang = skills.langOf(path);
          // A hole left under an earlier plan can be filled on any later turn: that's what
          // explaining it, or a course, is for.
          const waiting = open.find((o) => o.path === path && skills.key(o.concept) === skills.key(args.concept));
          if (!approved && !waiting) return say("Not yet - blocks are filled while building, after the plan is approved.");
          const body = readRel(path);
          if (body === null) return say(`${path} doesn't exist. Write the file with its blocks first.`);
          const at = todos.hole(body, args.concept);
          if (at < 0) return say(`There's no ${todos.MARKER} line for that in ${path}. Write the block first.`);
          const size = args.code.replace(/\n+$/, "").split("\n").filter((l) => l.trim()).length;
          if (size > FILL_MAX_LINES) {
            return say(
              `That's ${size} lines under one skill - at most ${FILL_MAX_LINES}. Split it into blocks, one skill each.`,
            );
          }
          // The block is on screen before anything happens to it, whichever way it goes: that's
          // how you see what the build rested on.
          store.openFile(path, at);
          await new Promise((r) => setTimeout(r, FLASH_MS));
          if (!holds(args.concept, path)) {
            if (waiting) return say(`"${args.concept}" is still locked for them. The hole stays theirs.`);
            const inPlan = plan.some((p) => skills.key(p.skill) === skills.key(args.concept) && p.status.state !== "unlocked");
            if (!inPlan) {
              return say(
                `"${args.concept}" is locked for them and isn't a locked piece of the plan they approved. Use a skill from the plan for this block - don't hand them a hole they didn't agree to.`,
              );
            }
            const t: todos.Todo = {
              concept: curriculum.canonical(args.concept, lang),
              path,
              what: args.what.trim(),
              requires: curriculum.prereqs(args.concept, lang),
              before: body,
              request: currentRequest,
              lang,
            };
            const known = open.some((o) => o.path === t.path && skills.key(o.concept) === skills.key(t.concept));
            setOpen([...open.filter((o) => !(o.path === t.path && skills.key(o.concept) === skills.key(t.concept))), t]);
            handedOff = false;
            if (!known) store.toolEvent("hole", `${path}: ${t.concept}`, "held");
            return say(`"${t.concept}" is locked for them, so the hole stays theirs. Don't write it any other way.`);
          }
          const filled = todos.fill(body, args.concept, args.code);
          if (filled === null) return say(`Couldn't find the block for that in ${path}.`);
          // Animated, so code on a skill they hold is seen, not just dropped in.
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
          store.filled(path, args.concept.trim(), code);
          store.openFile(path, at);
          if (!approved) filledLate = true;
          if (waiting) setOpen(open.filter((o) => o !== waiting));
          return say("Filled.");
        },
      ),
      tool(
        "check_todo",
        "Judge the code they typed into a TODO(dum) hole. Passing unlocks the skill.",
        {
          concept: z.string().describe("The hole's skill, exactly as registered"),
          passed: z.boolean().describe("True if their code does what the hole said and would work"),
          feedback: z
            .string()
            .describe("If it failed: one question that makes them run the failing case in their head. Never the fix. If it passed: one short line on what they got right."),
        },
        async (args) => {
          const t = open.find((o) => skills.key(o.concept) === skills.key(args.concept));
          if (!t) return say(`No open hole called "${args.concept}". Open: ${open.map((o) => o.concept).join(", ") || "none"}.`);
          reviewed = true;
          // A pass is one line. A miss is the question, whole - cutting it to a sentence once
          // dropped the question and kept only the setup.
          store.say(args.passed ? sentences(args.feedback, 1) : args.feedback.trim().slice(0, 400), true);
          if (!args.passed) return say("Still open. They saw your question - say nothing else this turn, and don't fix it for them.");
          setOpen(open.filter((o) => o !== t));
          unlock({ name: t.concept, lang: t.lang ?? skills.langOf(t.path), how: "typed", requires: t.requires, why: `typed it in ${t.path}: ${args.feedback}` });
          return say("Passed and unlocked. They saw your line - say nothing else about it.");
        },
      ),
      ...(mode === "anti-vibe"
        ? [
            tool(
              "check_explanation",
              "Judge their explanation of an open hole. Passing unlocks the skill; then call fill_todo for that hole.",
              {
                concept: z.string().describe("The hole's skill, exactly as registered"),
                passed: z.boolean().describe("True if it shows they get how that code works, in any words"),
                feedback: z
                  .string()
                  .describe("If it passed: one short line. If it's close: one question that gets them the rest. If it's wrong: what's off, in one line."),
              },
              async (args) => {
                const t = open.find((o) => skills.key(o.concept) === skills.key(args.concept));
                if (!t) return say(`No open hole called "${args.concept}". Open: ${open.map((o) => o.concept).join(", ") || "none"}.`);
                store.say(args.passed ? sentences(args.feedback, 1) : args.feedback.trim().slice(0, 400), true);
                if (!args.passed) {
                  reviewed = true;
                  return say("Still open. They saw your line - say nothing else this turn.");
                }
                unlock({ name: t.concept, lang: t.lang ?? skills.langOf(t.path), how: "explained", requires: t.requires, why: `explained it for ${t.path}: ${args.feedback}` });
                return say(`Unlocked. Now call fill_todo for "${t.concept}" in ${t.path}, then say nothing else.`);
              },
            ),
          ]
        : []),
    ],
  });

  const resume = recall(repo);
  const blocked: string[] = [];

  /** Whether the gate was engaged this turn - a write held, or a plan turned down. */
  let gateEngaged = false;
  /** A hole from an earlier plan got filled this turn. */
  let filledLate = false;
  /** A hole of theirs was checked this turn. */
  let reviewed = false;
  /** A build turn's latest text, not yet shown. */
  let saying = "";

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
      systemPrompt: { type: "preset", preset: "claude_code", append: `${CONTRACT}\n\n${THEIR_TURN[mode]}` },
      mcpServers: { dum: tools },
      // The feed the code pane is built on.
      includePartialMessages: true,
      ...(resume ? { resume } : {}),
      // dum's own tools are let through here rather than listed in allowedTools.
      canUseTool: async (name: string, args: Record<string, unknown>) => {
        if (name.startsWith("mcp__dum__")) return { behavior: "allow" as const, updatedInput: args };
        // Comments in their code are short: the code is theirs to read, not an essay.
        const essay = wordyCode(name, args);
        if (essay.length) {
          store.toolEvent(name, detail(repo.root, args), "refused", "comments too long");
          return {
            behavior: "deny" as const,
            message: `Comments are at most ${todos.MAX_COMMENT_RUN} lines in a row. Too long: ${essay
              .slice(0, 2)
              .map((l) => JSON.stringify(l))
              .join(", ")}. Say why, not what, in a line.`,
          };
        }
        // Code goes in through blocks, so every line passes the tree on its way in.
        const leak = looseCode(name, args);
        if (leak.length) {
          store.toolEvent(name, detail(repo.root, args), "refused", "code outside a block");
          return {
            behavior: "deny" as const,
            message: `Code only goes in through ${todos.MARKER} blocks. These lines aren't in one: ${leak
              .slice(0, 3)
              .map((l) => JSON.stringify(l.trim()))
              .join(", ")}${leak.length > 3 ? ` (+${leak.length - 3} more)` : ""}. Write the file as blocks only - includes, imports and control flow too - then call fill_todo for each.`,
          };
        }
        if (erasesHole(repo.root, name, args, open.map((t) => t.concept))) {
          store.toolEvent(name, detail(repo.root, args), "refused", "a hole is theirs");
          return { behavior: "deny" as const, message: "That TODO(dum) block is theirs. Holes are filled through fill_todo, never edited." };
        }
        if (!approved && MUTATING.has(name)) {
          gateEngaged = true;
          store.toolEvent(name, detail(repo.root, args), "held");
          return { behavior: "deny" as const, message: "Nothing may be built before the plan is approved. Call propose_plan first." };
        }
        for (const f of PATH_FIELDS) {
          if (escapes(repo.root, args[f])) {
            const why = `${args[f]} is outside ${repo.name}`;
            blocked.push(why);
            store.toolEvent(name, detail(repo.root, args), "refused");
            return { behavior: "deny" as const, message: `Refused: ${why}` };
          }
        }
        store.toolEvent(name, detail(repo.root, args), "ran");
        return { behavior: "allow" as const, updatedInput: args };
      },
    },
  });

  for await (const msg of session as AsyncIterable<any>) {
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      remember(repo, msg.session_id);
      // Read off the session rather than assumed: the intern inherits the default model from
      // their settings, and its effort from their /effort.
      if (typeof msg.model === "string") {
        store.setModel("intern", msg.model);
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
          // After a check it's told to say nothing more; if it does, it would bury the verdict.
          if (reviewed) continue;
          // Mid-build, text is held until we know whether a tool call follows it.
          if (approved) saying = b.text.trim();
          else store.say(b.text.trim());
        }
        if (b.type === "tool_use" && saying) {
          // Text framing a question stays; "writing X now" before an edit is narration.
          if (/(^|__)(ask|propose_plan)$/.test(b.name)) store.say(saying);
          saying = "";
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
      // What's left is the closing word on a build: its first paragraph.
      if (saying && !reviewed) store.say(saying.split(/\n\s*\n/)[0]!);
      saying = "";
      for (const why of blocked) store.note(`refused: ${why}`);
      blocked.length = 0;
      if (!approved && gateEngaged && !reviewed) store.note(filledLate ? "nothing else was built - this turn had no plan of its own." : "plan not approved - nothing was built.");
      reviewed = false;
      gateEngaged = false;
      filledLate = false;

      // The turn is over, not the session.
      const failed = failure(msg);
      if (!failed && open.length && !handedOff) {
        handedOff = true;
        handOff();
      }
      let next = "";
      for (;;) {
        next = failed
          ? (await store.askQuestion(failed, "type anything to try again once it's fixed, or exit")).trim()
          : await listen(() => store.askNext());
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
      pending.deliver?.(next);
      if (!next || QUIT.has(next.toLowerCase())) return;
    }
  }
}

/** The model and effort a live session is actually using, or null if the SDK can't say. */
async function applied(session: unknown): Promise<{ model: string; effort: string } | null> {
  try {
    const s = await (session as { getSettings?: () => Promise<any> }).getSettings?.();
    const a = s?.applied;
    if (!a) return null;
    return { model: typeof a.model === "string" ? a.model : "", effort: typeof a.effort === "string" ? a.effort : "" };
  } catch {
    return null;
  }
}

/** The curated tracks, for the intern to spell skills the same way. */
function tracks(): string {
  const lines = curriculum.languages().map((l) => `${l}: ${curriculum.track(l)!.skills.map((n) => n.name).join(", ")}`);
  return lines.length ? `THE CURATED TRACKS - skill names per language, lowest first. Spell skills this way.\n${lines.join("\n")}` : "";
}

/** The language most of the repo is written in, or "" for a repo with no source yet. */
export function mainLang(repo: { files: string[] }): string {
  const count = new Map<string, number>();
  for (const f of repo.files) {
    const l = skills.langOf(f);
    if (l) count.set(l, (count.get(l) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Comment runs over the limit that a Write or Edit would add, in a source file. */
export function wordyCode(name: string, args: Record<string, unknown>): string[] {
  return written(name, args, todos.wordy);
}

/** Code lines a Write or Edit would add outside any block, in a gated source file. */
export function looseCode(name: string, args: Record<string, unknown>): string[] {
  return written(name, args, todos.loose);
}

/** Run a check over the text a Write, Edit or MultiEdit would put into a source file. */
function written(name: string, args: Record<string, unknown>, check: (text: string, path: string) => string[]): string[] {
  const path = typeof args.file_path === "string" ? args.file_path : "";
  if (!path || !todos.gated(path)) return [];
  if (name === "Write") return check(String(args.content ?? ""), path);
  if (name === "Edit") return check(String(args.new_string ?? ""), path);
  if (name === "MultiEdit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return edits.flatMap((e: any) => check(String(e?.new_string ?? ""), path));
  }
  return [];
}

/** Whether a tool call would rewrite a TODO(dum) block that's already theirs. */
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
  // Only a hole already handed to them is theirs. One the intern is still shaping it may rewrite.
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

function rel(root: string, p: string): string {
  const r = relative(root, isAbsolute(p) ? p : resolve(root, p));
  return r && !r.startsWith("..") ? r : p;
}

/** One short line about what a tool call is doing. */
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

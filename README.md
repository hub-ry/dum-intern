# dum-intern

One intern. It builds what you can explain.

Agentic coding made it easy to ship code you don't understand. dum-intern
shortens the leash: it interrogates you *before* anything is built, and nothing
reaches disk until you've approved a spec written from your own answers.

It runs alongside whatever you already use. It doesn't replace your editor, your
multiplexer, or your agent - it's the thing that makes you able to defend the
diff.

## Two modes

The mode sets **the level of abstraction you have to explain yourself at**. This
is the whole design; everything else follows from it.

```sh
dum "print hello world in rust"       # anti-vibe (default)
dum -u "print hello world in rust"    # understand everything
```

**`anti-vibe`** — you must understand *what* and *why*. Not *how*. "Print hello
world" is a language-independent concept and you obviously hold it, so the
intern asks **nothing** and builds. It only fights you when the intent itself
has a hole.

**`understand`** — you must also understand *how*. The same request is now full
of holes: what `println!` is, why it ends in `!`, what `fn main` returns. Those
questions are the product here, not friction.

Same request, opposite amount of friction. anti-vibe is the default on purpose:
a tool that interrogates you over a one-line change is a tool you turn off, and
then it protects nothing.

## The wizard

There are two voices here, and one rule keeps them apart: **the intern asks, the
wizard tells.** Every question goes to the intern, every statement to the
wizard, and nothing crosses. That's what stops the wizard from quietly answering
the question you were supposed to decide.

The wizard speaks at two volumes.

### Unsolicited: the margin

You don't summon this one. When something you just said has interesting context
attached, the wizard leans over and mentions it - the industry name for the
thing you described, the prior art, the shape everyone converges on. Then it's
quiet again.

```
  what happens if a worker dies halfway through a job?
  > another worker should pick it back up after a while

     │ 🧙 that's a visibility timeout - the mechanism SQS and most
     │    job queues use for exactly this failure case.

  Different case: the worker is alive and the send itself raises.
  >
```

Naming the thing is the most useful move it has, because the name is what you
can go look up afterwards. There's no search in here; the wizard's job is to
hand you the search term.

It never gives advice, never critiques the idea, and is allowed to say nothing -
which it does often. It also only ever fires on an answer you've **already
given**, never on a pending question. That ordering isn't politeness, it's the
enforcement: by the time a quip appears you've already committed, so it cannot
have decided anything for you.

### On demand: the lesson

Answering a question and *not having the concept* are different failures, and
you say which one you're in. Reply `idk` (or `?`, or just ask what it means) and
the wizard explains the concept, why it exists, and how the industry actually
uses it — then hands the question back **without answering it**.

Nothing infers your ignorance. You declare it.

```
  Cargo package, or a single hello.rs compiled with rustc?
  It decides whether I create a manifest and a src/ layout, or one file.
  > idk

  ╭─ wizard ──────────────────────────────────────────────────
  │  Cargo vs. invoking the rustc compiler directly
  │
  │  why it exists  ...the moment you have one third-party dependency
  │                 you are hand-writing rustc invocations...
  │  in industry    ...what teams actually argue about is one level up:
  │                 single package vs Cargo workspace, whether to commit
  │                 Cargo.lock, which edition to pin. In an interview,
  │                 "why Cargo over rustc" is really a question about
  │                 dependency resolution and reproducible builds.
  ╰────────────────────────────────────────────────────────────

  So: Cargo package, or a single hello.rs compiled with rustc?
  >
```

Calling the wizard never costs you your turn. A tool that punishes you for
admitting you don't know something teaches you to stop admitting it.

## It's a conversation, not a form

The interrogation is one continuous session. You can answer, push back, or ask
the intern a question mid-interrogation and it will answer and then return to
its own. It remembers everything said so far, because it never left.

That's also why there's no spec handoff: by the time it builds, your decisions
are already in its context. The spec is a checkpoint you approve, not a prompt
shipped to a process that never met you.

## Requirements

- Node 22.6+ (native TypeScript type stripping, so there is no build step)
- the `claude` CLI, authenticated — no API key to manage
- a git repository to run in

```sh
npm install
npm link          # puts `dum` on your PATH
```

## How it works

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), so
dum-intern owns the agent loop instead of shelling out. The intern talks to you
through three in-process tools — `ask`, `teach`, `propose_spec` — and `ask`
blocks on your terminal, so your reply returns to it as a tool result inside the
same session. That's what makes follow-ups possible at all.

**Two things are enforced in code, not in the prompt:**

- **Nothing is built before the spec is approved.** Every mutating tool is
  denied until then. The first version asked for this in the system prompt; on
  its very first real run the intern skipped the gate, wrote two files, and the
  session still printed "nothing was built". A gate that lives in a prompt is a
  suggestion.
- **Everything stays inside the repo.** Passing `cwd` does *not* confine the
  agent — in testing it wrote to `$HOME` while `cwd` was a scratch directory.
  Paths are checked on the way through.

Held and refused tool calls render differently from ones that ran. A denied
write that looks like a successful one is a terminal that lies.

The wizard is a **separate session** from the intern, and stateless about the
build: it can't be talked into a position by the thing trying to get built, and
it never sees your settings or `CLAUDE.md`. Its whole character is one short
system prompt, and a personal instructions file would quietly rewrite it.

Three things about it were measured rather than assumed:

- **It runs on Sonnet, not Haiku.** Haiku was the obvious choice for one line of
  trivia, and it got the *names* wrong - calling a lease a "dead letter queue"
  in 2 runs out of 5. Sonnet is 5 for 5 on the same case at the same wall time.
  A confidently wrong name is worse than no wizard, because you'd carry it into
  an interview.
- **It isn't told what the intern asked.** Including the question was the cause
  of those wrong names: it answered the question's topic instead of yours. It
  also turned out to be free specificity - an answer that means nothing alone
  ("yes", "postgres") now gives the wizard nothing to grab, which is exactly
  when it should stay quiet.
- **Thinking off, effort medium, settings off.** With the defaults a quip took
  ~25 seconds, which is slower than you typing the next answer, so quips
  arrived after you'd moved on. Now ~1.5s.

Session state lives in `.dum/session` so a second run in a repo continues with
the same intern rather than starting over. Quips are appended to
`.dum/wizard.jsonl`.

## Layout

```
bin/dum         launcher
src/cli.ts      arg parsing, the environment you drop into
src/session.ts  the intern: modes, tools, the gate
src/wizard.ts   the wizard: the unsolicited voice in the margin
src/ui.ts       everything the terminal looks like
src/repo.ts     what the intern knows about where it is
```

## Staying in the session

The session does not end when a build does. After each turn you get a `›` prompt
for the next thing - so when the intern asks "want me to also handle X?", you
just answer. Empty line or `exit` ends it.

Each new request earns its own spec approval. Carrying approval forward would
mean the second thing you asked for was never gated.

## Not built yet

- **Bash is a hole in the pre-approval gate.** It's denied before approval for
  that reason, which also means the intern can't run `which cargo` while
  speccing. Read, Glob, and Grep still work.
- **Nothing checks the build against the spec.** The spec is a contract the
  intern is told to honor, not one that's verified afterward.
- **Persistence beyond the session id.** Wizard lessons evaporate; a concept you
  needed explained once is one worth resurfacing later.
- **The margin is not really off to the side.** Quips render inline, set in and
  narrower so you can tell at a glance they're the voice you may ignore. Every
  quip is already written to `.dum/wizard.jsonl`, so a real second pane is a
  reader over that file rather than a rewrite of this one.
- **A quip can arrive late.** If the wizard is still thinking when the next
  question is ready, the quip lands at the following beat instead, anchored with
  `re: "what you said"` so it doesn't read as a non-sequitur. It's never worth
  making you wait on garnish.

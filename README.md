# dum-intern

One intern. It builds what you can explain.

Agentic coding made it easy to ship code you don't understand. dum-intern
shortens the leash: before anything gets built, the intern asks what it needs to
know, and you have to answer. The spec is the artifact. Code comes after.

## The two things you can't do

Sit down to specify a change and you can fail in two different ways:

**You were vague.** You know what a rate limiter is, you just didn't say whether
it keys on the user or the IP. The intern asks; you answer; done.

**You don't have the concept.** You've never been told what end-to-end testing
is, so there was no vague version of it in your head to sharpen. You can't be
imprecise about something you've never heard of.

Those need opposite responses, and **you** say which one you're in. Type `?` at
any question and the wizard explains the concept, why it exists, and how the
industry actually uses it - then hands the question back. It will not answer for
you. That's the whole point.

Nothing infers your ignorance. You declare it.

## Requirements

- Node 22.6+ (native TypeScript type stripping, so there is no build step)
- the `claude` CLI, authenticated
- a git repository to run in

## Use

```sh
dum                                   # it asks what you want
dum "add rate limiting to checkout"   # or say it up front
```

Then answer the questions, or type `?` to call the wizard. At the end you get a
spec, and only if you accept it does any code get written.

```
  1/4  Should the limit key on IP or authenticated buyer?
       Determines whether shared-NAT buyers at a venue block each other.
  > ?

  ╭─ wizard ──────────────────────────────────────────────────
  │
  │  Rate limit keying
  │
  │  what it is     ...
  │  why it exists  ...
  │  in industry    GitHub keys unauthenticated calls per IP and
  │                 authenticated calls per token; Stripe keys per
  │                 API key; the recurring team argument is that
  │                 the safe X-Forwarded-For setting breaks in
  │                 local dev, so people set it to `*` and ship it.
  │  here           Your purchase path goes through app.py into
  │                 src/ticketing/sales.py ...
  ╰────────────────────────────────────────────────────────────

  1/4  Should the limit key on IP or authenticated buyer?
  >
```

Calling the wizard never costs you your turn - the question comes back after the
lesson. A tool that punishes you for admitting you don't know something teaches
you to stop admitting it.

## How it works

The intern reads the repo shallowly on purpose: the file list and the README,
nothing more. It is not supposed to study the codebase before asking what you
want, it is supposed to ask what you want. Deep context is the coding agent's
job, and that runs after the spec exists.

Questions are capped at five and can be zero. A tool that interrogates you over
a one-line change is a tool you disable inside a week, and then it protects
nothing. Silence on trivial work is a feature.

The spec names every decision you made, refuses to add scope you didn't ask
about, and lists anything you answered so vaguely that it doesn't constrain the
code under **still unresolved** rather than quietly picking for you.

Everything shells out to `claude -p --output-format json`. No API key to manage,
and it keeps dum-intern one kind of thing: a program that drives an agent CLI.

## Layout

```
bin/dum         launcher
src/cli.ts      the environment you drop into
src/intern.ts   the questions, the wizard, the spec
src/repo.ts     what the intern knows about where it is
src/claude.ts   the CLI wrapper
```

## Not built yet

- **Persistence.** Sessions leave nothing behind. The wizard lessons in
  particular are worth keeping - a concept you needed explained once is a
  concept to resurface later.
- **Knowing when to fight.** The five-question cap is a blunt stand-in for
  judgment about which changes deserve interrogation at all.
- **The build step is a handoff.** Accepting the spec launches `claude` with it.
  The intern doesn't yet watch what comes back.

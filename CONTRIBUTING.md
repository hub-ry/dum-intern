# Contributing

dum is a coding tool that won't write what you can't explain. Most of what looks like friction in the code is on purpose, so read the rules below before changing behaviour.

## The rules

These are the product. A change that breaks one is a bug, however nice it feels.

- **The gate is code, not a prompt.** Nothing is written before a spec is approved. In understand mode, code only enters a source file through a `TODO(dum)` hole, and dum decides from the skill tree which holes it fills. Every time one of these lived only in a prompt, the model skipped it.
- **Nothing quietly feeds the intern's context.** Opening a file, running the shell, editing in the pane: none of it reaches the intern. It knows what the person tells it.
- **Code never just appears.** A fill types itself in, and the transcript keeps the code.
- **The agent never renders.** `session.ts` publishes to `store.ts` and waits. Ink and the plain line-printer are both subscribers. Keep React out of `session.ts` and `wizard.ts`.
- **Personal data stays local.** Skill trees, taste files and project queues live in `~/.dum`, never in the repo.

## Setup

Node 22.6+ and the `claude` CLI, logged in.

```sh
npm install
npm link        # puts dum on your PATH
dum --help
```

`npm install` also marks node-pty's `spawn-helper` executable, since npm strips the bit and the shell page won't start without it.

## Checking a change

```sh
npm test                      # unit tests, a second or two
npm run typecheck
npm run preview 150 34 2500 ask     # draw a frame: cols rows ms scene
npm run eval:scenarios              # real sessions, scored (costs model calls)
```

`preview` draws the panes against a made-up session with no model involved. Scenes live at the bottom of `tools/preview.tsx`. Use it for anything visual: a box one column short is a bug here.

For anything interactive, drive the real TUI in tmux: `tmux new-session -d -x 150 -y 34 "dum"`, then `send-keys` and `capture-pane`. Send keys one at a time with short sleeps. tmux delivers a burst as one chunk, and `send-keys` eats a trailing `;`, both of which look like dum bugs and aren't.

## Scenarios

`scenarios/*.json` are scripted sessions: a request, a skill tree, how to answer, sometimes code to type into the first hole. Each exists because dum got something wrong once. `npm run eval:scenarios` runs them in throwaway repos, checks facts in code (`src/eval.ts`), and has a judge score the transcript against the maintainer's taste file. Results go to `~/.dum/evals/`, and each run is compared with the last.

Found a bug in a real session? Add a scenario that fails on it before fixing it.

## Where things live

| | |
| :--- | :--- |
| `src/session.ts` | the intern: its prompt, its tools, the gate |
| `src/store.ts` | the seam between the agent and whatever draws it |
| `src/skills.ts`, `notes.ts` | the skill tree, as markdown notes |
| `src/todos.ts` | holes: finding, filling, the code-only-through-holes check |
| `src/wizard.ts`, `checker.ts`, `reference.ts` | the wizard, the line checker, `?` answers and build review |
| `src/panes/` | the TUI: `App`, `Stage` (middle), `Cast` (right), `Board`, `Code`, `Shell` |
| `src/pty.ts`, `mouse.ts` | the shell page, and mouse reports filtered out of Ink's input |
| `src/planner.ts`, `learn.ts`, `rebuild.ts` | queued goals, learning projects, rebuilds |

## Style

- Comments are short: one line of why, never what the code already says. History goes in the commit message.
- Commit messages carry the reasoning: what was wrong, how it was found, what changed.
- Plain dashes, never em dashes.
- Prefer an existing library to writing one. When dum has its own (the mouse filter, the editor), the reason is written next to it.

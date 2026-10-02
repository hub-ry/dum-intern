# Contributing

dum is a coding tool that only writes code on skills you've unlocked. Most of what looks like friction in the code is on purpose, so read the rules below before changing behaviour.

## The rules

These are the product. A change that breaks one is a bug, however nice it feels.

- **The gate is code, not a prompt.** Nothing is written before a plan is approved. Code only enters a source file through a `TODO(dum)` block, and dum decides from the skill tree which blocks it fills. Every time one of these lived only in a prompt, the model skipped it.
- **The model names skills, it never decides who has them.** Whether a skill is unlocked, open for a course, or locked deeper comes from `curriculum.ts` and the notes on disk.
- **Courses go in order.** A course, or a skill added by hand, is refused until everything it builds on is unlocked. A new track in `src/trees/` must keep the test that walks every track from an empty tree passing.
- **Nothing quietly feeds the intern's context.** Opening a file, running the shell, editing in the pane: none of it reaches the intern. It knows what the person tells it.
- **Code never just appears.** A fill types itself in, and the transcript keeps the code.
- **The agent never renders.** `session.ts` publishes to `store.ts` and waits. Ink and the plain line-printer are both subscribers. Keep React out of `session.ts` and `wizard.ts`.
- **Personal data stays local.** The skill tree and mapped prerequisites live in `~/.dum`, never in the repo.

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
npm run preview 150 34 2500 plan    # draw a frame: cols rows ms scene
```

CI (`.github/workflows/ci.yml`) runs the first two on every push and pull request, on Node 22.6 and 24, Linux and macOS. Keep the tests free of model calls and network so it stays fast and deterministic.

`preview` draws the panes against a made-up session with no model involved. Scenes live at the bottom of `tools/preview.tsx`. Use it for anything visual: a box one column short is a bug here.

For anything interactive, drive the real TUI in tmux with a throwaway tree: `DUM_HOME=/tmp/dum-home`, then `tmux new-session -d -s zz-dum-test -x 150 -y 34 "dum"`, `send-keys` and `capture-pane -t zz-dum-test:`. Send keys one at a time with short sleeps, or text with `send-keys -l`. tmux delivers a burst as one chunk, and `send-keys` eats a trailing `;`, both of which look like dum bugs and aren't. Kill the session by exact name, `tmux kill-session -t =zz-dum-test`: without the `=`, tmux matches a prefix and will happily kill some other session.

## Bugs

Reproduce it in the real TUI first, the way a person would hit it. Then add a test that fails on it before fixing it.

## Where things live

| | |
| :--- | :--- |
| `src/session.ts` | the intern: its prompt, its tools, the gate |
| `src/store.ts` | the seam between the agent and whatever draws it |
| `src/skills.ts`, `notes.ts` | the skill tree, as markdown notes |
| `src/curriculum.ts`, `src/trees/` | the curated tracks and the prerequisite gate |
| `src/course.ts` | courses: designing one, the scratch file, the judge |
| `src/todos.ts` | holes: finding, filling, the code-only-through-holes check |
| `src/wizard.ts` | the wizard's half of a course |
| `src/panes/` | the TUI: `App`, `Stage` (middle), `Cast` (right), `Board`, `Code`, `Shell` |
| `src/pty.ts`, `mouse.ts` | the shell page, and mouse reports filtered out of Ink's input |

## Style

- Comments are short: one line of why, never what the code already says. History goes in the commit message.
- Commit messages carry the reasoning: what was wrong, how it was found, what changed.
- Plain dashes, never em dashes.
- Prefer an existing library to writing one. When dum has its own (the mouse filter, the editor), the reason is written next to it.

# dum-intern

My custom agentic environment with a tighter development leash.

![dum-intern: the file tree on the left, a C++ guessing game with one TODO(dum) gap in the middle, and the wizard and dum on the right above the conversation](docs/screenshot.png)

It interrogates me before it builds anything, and nothing gets written until I approve a spec made out of my own answers. Then it builds around what I can't do yet and leaves that part for me.

The bet: a coding agent makes it easy to ship code I can't explain, and I only find out when something breaks. dum keeps a tree of what I've actually shown I understand. It builds on that without asking, and anything I don't hold yet becomes a small gap for me to type or explain. The questions shrink as I learn instead of staying flat.


### Quickstart

Node 22.6+ and the `claude` CLI logged in. No build step, no API key.

```sh
npm install
npm link        # puts `dum` on your PATH
cd some-repo    # dum works inside a git repo
dum
```

An empty tree says how to fill it on the first screen. `dum --help` lists the commands, and `:help` inside dum lists the rest.


### The loop

1. **Ask.** "add a mode function to stats.py", or "teach me vectors in C++".
2. **Explain.** The intern asks about the parts that aren't on my tree, one question at a time. `idk` gets a lesson. `type it` means I'll write that part.
3. **Approve.** A short spec: what I'll have, what I type, what I decided. `y` builds it.
4. **Fill the gaps.** Pieces on skills I hold get filled in front of me. The rest are `TODO(dum)` holes. I type one and say `done`, or explain it and dum fills it. Passing puts the skill on the tree.


### The screen

Three places, one rule each.

- **The input**, at the bottom, is where I type, always. Its grey placeholder says what typing does right now. With the file showing, the prompt is `>` and I'm talking to dum, though `cd`, `gcc` or `./guess` still go to the shell. With the shell showing, the prompt is `$` and everything runs there, like any terminal. dum's own words (`done`, `go`, `idk`) still reach dum. A program waiting for input turns the prompt into `guess ›`, and `ctrl-c` stops it. It only quits dum when nothing's running.
- **The middle** is code: the file, or the shell. `shift-tab` flips between them, and so does clicking the `file` / `shell` tabs. The shell is my own `$SHELL` in a pty, kept for the session, so `cd` and history stick.
- **The right** is the characters: faces side by side, and the whole conversation under them, newest at the bottom. Nothing scrolls away when I look at the shell. Something too big for the thread, like the spec, a lesson or help, takes over as a board until it's answered, or `esc`.

`tab` moves between the input, the file and the tree, and clicking a pane does the same. The trackpad scrolls whatever's under the pointer. That needs the terminal's mouse reporting, so plain drag-to-select becomes Option-drag (iTerm, Terminal.app) or shift-drag elsewhere.

When dum has something to say about one line, it pins a live comment beside it rather than describing where to look. It's never saved to the file, and it clears on the next turn:

```
  3 const LEASE_MS = 30_000;  ◂ 30s: long enough for a slow job to finish
```

The file is a vim-ish buffer: `i` types, `:w` writes, `/` finds. It's for fixing the thing I just watched get written, not for living in. My edits are mine. Saving isn't a tool call and the intern isn't told.


### Two modes

```sh
dum "print hello world in rust"       # understand everything (default)
dum -a "print hello world in rust"    # anti-vibe
```

Understand-everything means what, why, and how. The first time I ask for hello world in Rust, it asks about the `!` in `println!`. The second time it doesn't, because that's on my tree now.

Anti-vibe drops the how. I own the intent, the intern owns the mechanics, a new language's syntax included. No holes unless I say `type it`.


### The skill tree

Every concept I explain, type, or get taught lands on one tree in `~/.dum/skills/`. It follows me across repos and never goes in one.

```
$ dum --skills

  ● message queues
    ○ idempotency keys
    ● visibility timeout
      ● leases
  · heartbeats  not shown yet
  ◐ for loops  python only
```

`●` known: I showed it, so the intern builds on it. `◐` claimed: I say I have it and dum hasn't seen it, so the first build that leans on it checks once. `○` shaky: I was taught it or got it wrong. `·` is something a skill builds on that I haven't touched, which is the frontier.

- **Mine to edit.** Each skill is a markdown note with `[[links]]` for what it builds on, so `~/.dum` opens as an Obsidian vault. `:skill for loops in python` adds one, `:skill -recursion` takes one off, `dum --add "structs" --in c` works outside a session. The rule, shown every time: only add what I can write from a blank file, completely without AI.
- **Per language.** "range-based for" is C++ only. Python's for loops fill nothing in a `.cpp` file. Ideas like recursion carry across, but a language I've shown nothing in gets no fills at all.
- **Honest about mistakes.** Every new skill shows as `+ skill: <name>`, and `not yet` right after takes it back for the session. A general skill goes stale after a year and a niche one (one library's quirk, counted only in its repo) after two months. Stale ones get one quick check.
- **One idea, one node.** "Leases" and "lease" are one skill. Near-misses like "SQS visibility timeout" get caught before they're recorded, and the intern says whether it's the same idea. It isn't a merge, because "rust macros" and "rust procedural macros" pass the same word test and are different things.
- **Seeded from real work.** `dum --scan ~/code/old-cli` reads projects I wrote by hand and lists concepts with the line that shows each. I drop what isn't mine and the rest lands as claimed. `dum --reset` starts over, with the old notes moved aside.

`dum --graph` draws the tree and the project queue in the browser: Graphviz boxes like the Rust project's skill-tree, with Obsidian's hover and click. It's one offline file, `~/.dum/graph.html`, and `#open=<id>` on its URL opens a note directly.


### Holes, and how big they are

In understand mode, code only enters a source file through a `TODO(dum)` hole. The intern writes the shape and hands dum the code for each block, and dum decides from my tree whether to fill it:

```
  · Write  stats.py
  ✓ fill  stats.py: median  (a skill you hold)
    │     s = sorted(xs)
    │     mid = len(s) // 2
  ▌ hole  stats.py: frequency counting  (yours to type)
```

A fill types itself into the highlighted block, and the transcript keeps the code. Skipping a skill I hold means not retyping it, never not seeing it. A hole I type gets reviewed on `done`. A miss gets a question, never the fix: "secret 50, you type 30, and it says 'too high'. Is 30 bigger than 50?" A hole I explain in plain words gets filled once the explanation holds up. Open holes live in `.dum/todos.json`, and the next `dum` opens on them.

Holes are what the research calls [completion problems](https://www.uky.edu/~gmswan3/544/Cognitive_Load_&_ID.pdf) (van Merriënboer & Krammer, 1987): working code with a part missing. Their size follows the [expertise reversal effect](https://www.tandfonline.com/doi/abs/10.1207/S15326985EP3801_4) (Kalyuga et al., 2003). Given code helps novices and gets in experts' way, so the gaps [fade](https://link.springer.com/article/10.1023/B:TRUC.0000021815.74806.f6) wider as I get better. My level counts the skills tagged with a language plus the ones I've typed in it:

| Level | Skills in the language | Biggest gap | Gaps per request | Around it |
| :--- | :--- | :--- | :--- | :--- |
| novice | 0-2 | 1-3 lines | 1 the first time, then 2 | dum writes the scaffolding |
| developing | 3-9 | 8 lines | 3 | dum writes the rest |
| fluent | 10+ | any | 4 | every line goes through a hole |

The gate measures the code proposed for a hole and sends back one too big for my level. Four is the ceiling because working memory holds [about four chunks](https://philpapers.org/rec/COWTMN) (Cowan, 2001). An idiom I haven't seen, like `while (std::cin >> x)`, is shown working in the scaffold first, then a gap can use it. The words under a gap fade too: exact steps at the start, then what it must do, then only the goal.

A request well above my tree doesn't get built as asked. "Teach me vectors in C++" with no C++ on the tree got "want to start with a tiny program that reads numbers and prints the biggest, then vectors?", then one screen of C++ with one gap, a single `if`. That's [mastery learning](https://en.wikipedia.org/wiki/Mastery_learning) and the [4C/ID model](https://www.4cid.org/wp-content/uploads/2021/04/vanmerrienboer-4cid-overview-of-main-design-principles-2021.pdf): prerequisites first, whole tasks from simple to complex. It only works if the tree is right, which is why it's mine to edit: "the most important single factor influencing learning is what the learner already knows" ([Ausubel, 1968](https://www.simplypsychology.org/expository-method-of-teaching.html)).


### Asking good questions

The intern plans no list. It asks one question, reads the answer, and the next grows out of it. Most requests need zero to three. Plain words count as an explanation, a vague answer gets re-asked, and a wrong one gets called out in a line and goes on as shaky. Two `idk`s in a row and it stops asking and explains after the build.

While the tree is small it asks to be taught ("how does print get the text onto the screen?"), because students work harder for a teachable agent ([Chase et al., 2009](https://doi.org/10.1007/s10956-009-9180-4)). It also prefers predictions ("does `1..=10` stop at 9 or 10?"), because a wrong guess followed by the answer sticks better than being told ([Kornell, Hays & Bjork, 2009](https://pubmed.ncbi.nlm.nih.gov/19586265/)).

"Recommend me a project" gets a recommendation in a few lines, not a build.


### The wizard

Two voices. Questions come from the intern. The wizard only speaks about an answer I already gave, so it can't answer a pending question for me.

```
  > another worker should pick it back up after a while if the first one dies
  wizard: that's a visibility timeout - the mechanism SQS and most job queues use for exactly this.
```

- **It names things.** The real name for what I described is the thing I go look up after, so a wrong name is worse than none.
- **It nudges with a question.** "what does 0.1 + 0.2 give you as a float?" Every line is tagged `fact:` or `nudge:`, and a nudge whose first sentence isn't a question gets dropped in code.
- **A second session checks every line** against what I actually said before I see it. `npm run eval:checker` scores it: the last run dropped 45/45 bad lines and kept 45/45 good ones.
- **It looks things up.** Not recognising something is a reason to search, not an answer. `?` questions search too.
- **It doesn't see the intern's question**, because with it, it answered the question instead of what I said.
- **Sonnet, thinking off, effort medium.** Haiku got names wrong; Sonnet got them right at the same wall time. `npm run eval:wizard` measures it.

Each voice shows its model and effort beside its name, read from the running session: `dum opus 5.5 · high`, `wizard sonnet 5 · medium`. The intern follows my own default model and `/effort`. Planning and rebuild reading run on Opus at high, the rest on Sonnet.


### Learning on purpose

```sh
dum --learn "websockets"              # a small project around one topic, in ./learn-websockets
dum --queue "a multiplayer game server"   # the steps up to a goal, planned against my tree
dum --next                            # one small project for the fastest next unlock
dum --rebuild ~/code/hysa             # rebuild something I have, from scratch
```

- **`--learn`** designs a project where the topic is the only new thing, and says how much I already hold: "you hold 5 of 14 skills (36%)". `go` takes the next feature, each under 30 minutes.
- **`--queue`** maps what a goal rests on and turns every tier below it into stepping-stone projects, an evening each. A project is done when its skills are on my tree, so there's nothing to tick off. `--projects` shows the queue and `--plan` plans goals I wrote into `~/.dum/projects/` by hand.
- **`--rebuild`** turns a project into milestones in a fresh repo beside it. The original is outside the repo, so the intern can't copy it. A milestone is built when its holes are.

The tiers are counted in code. The model only maps what builds on what.


### Taste, and scenarios that check it

`~/.dum/taste.md` holds rules in my own words, like "at the start the gaps are really small". The intern reads it every session, and `:taste <rule>` adds one mid-session.

`scenarios/*.json` are scripted sessions, each written from a real mistake. `npm run eval:scenarios` runs them in throwaway repos, checks facts in code (questions before the spec, holes, fills, reply length, comment runs), and has a judge score each transcript against my taste. Results go to `~/.dum/evals/`, compared with the last run. When I react to something, it becomes a taste rule or a scenario.


### Short, on purpose

This is closer to a game than a document. Following [i-have-adhd](https://github.com/ayghri/i-have-adhd/blob/main/skills/i-have-adhd/SKILL.md): where I am is always on screen (`feature 2/9 ▰▱▱▱▱▱▱▱▱`), every step has minutes and none runs over 45, and lists stop at five. After a build the intern gets three lines, and the spec is one-line fields that dum lays out itself. Comments in code it writes are three lines at most, which the gate enforces.


### Enforced in code, not in the prompt

Every rule that only lived in a prompt got skipped eventually.

- Mutating tools are denied until I approve the spec. v1 asked in the prompt, and the intern wrote two files anyway.
- Paths are checked on the way through: `cwd` doesn't confine the agent, and it once wrote to `$HOME`.
- Code outside a `TODO(dum)` block, a hole too big for my level, and a fifth hole are all refused. So is an Edit that rewrites a hole, and a fill over twelve lines, since nothing big rides in under one name.
- Held and refused calls draw differently from ones that ran, with the reason, so the screen never claims something happened that didn't.
- Nothing quietly feeds the intern context. Opening files, the shell and my edits never reach it.


### Keys

| Key | Action | Where |
| :--- | :--- | :--- |
| `tab` | input, file, file tree, and around (or click a pane) | anywhere |
| `shift-tab` | the middle: file ⇄ shell (or click the tab) | anywhere |
| `esc` | close a board: help, a lesson, the log | input |
| `ctrl-c` | stop the program running in the shell; with none, quit | anywhere |
| trackpad, `page up` / `page down` | scroll the conversation or a board | anywhere |
| `?` + text | ask anything, answered off to the side without costing your turn | input |
| `cd`, `gcc`, `echo`, `./a.out` ... | run in the shell, as typed | input |
| `!` + command | anything else in the shell (`!` alone opens it) | input, file's `:` line |
| `:run` | run the open file; compiled languages get the line to type instead | input, file's `:` line |
| `:log` | everything said so far, on a board | input, file's `:` line |
| `:help` | all of this | input |
| `:taste` + a rule | how dum should work, kept for every session | input |
| `:skill` x [in lang] | add a skill I can write without AI (`:skill -x` takes it off) | input |
| `ctrl-a` `ctrl-e` `ctrl-u` `ctrl-k` `ctrl-w` | start, end, delete to start, to end, a word | input |
| `idk` | "I don't have this concept" - the intern teaches it | answering a question |
| `type it` | "I'll write this part" - it leaves a hole | answering a question |
| `done` | check what I typed into the hole | your turn |
| an explanation | fills the hole it explains, if it holds up | your turn |
| `go` | start the next feature or milestone | next up |
| `not yet` [name] | don't count the skill just checked off | anywhere |
| `y` | approve the spec; anything else declines | spec |
| `exit` or an empty line | end the session | what next? |
| `j` / `k`, arrows, `g g` / `G`, `ctrl-d` / `ctrl-u` | move | file tree, file |
| `h` / `l`, `enter` / `o` | collapse / expand, open (only I see it) | file tree |
| `w` / `b`, `0` / `$`, `/` text, `n` / `N` | by word, line ends, find | file |
| `i` `a` `o` `O`, `esc` | start typing, stop | file |
| `x` `dd` `D` `J` `yy` `p` `u` `ctrl-r` | the usual | file |
| `:w` or `ctrl-s`, `:q`, `:e`, `:` number | write, leave, reload, go to line | file, or the input with a file open |


### Flags

| Flag | |
| :--- | :--- |
| `-a`, `--anti-vibe` | own the intent, skip the mechanics |
| `-u`, `--understand` | the default, spelled out |
| `-p`, `--plain` | line printer instead of panes, also what you get in a pipe |
| `-n`, `--new` | a fresh intern in this repo: its memory and open holes moved aside |
| `-s`, `--skills` | print the skill tree |
| `-g`, `--graph` | the tree and the queue, in the browser |
| `--add "<skill>" [--in <lang>]` | add a skill I can write without AI |
| `--forget <name>` | take a skill off |
| `--scan <folders>` | claim skills from projects I wrote myself |
| `--reset` | start the tree over, the old one moved aside |
| `--learn "<topic>" [folder]` | a small project to learn a topic, feature by feature |
| `--queue "<goal>"` | queue a goal and plan the steps up to it |
| `--plan`, `--projects`, `--next [n]` | plan hand-written goals, show the queue, suggest what's next |
| `--rebuild <dir> [target]` | rebuild a project from scratch, milestone by milestone |
| `-h`, `--help` | the short version of this |

The tree and project flags work from anywhere. A session needs a git repo, since the intern works from the tracked files.


### Where things live

```
~/.dum/
  skills/          the skill tree, one note per skill (DUM_HOME moves it)
  projects/        the project queue, one note per goal, step, or idea
  taste.md         my rules for how dum should work
  graph.html       the graph, redrawn by every --graph
  evals/           every scenario run, for comparing
  skills.json.migrated   the old single-file tree, read once into notes

<repo>/.dum/
  session          so the next `dum` resumes the same intern
  todos.json       holes left for me to type
  milestones.json  a rebuild's milestones or a learning project's features
  wizard.jsonl     every wizard line
  debug.log        with DUM_DEBUG=1
  knowledge.json   the old per-repo record, folded into the tree once and left alone
```

Plain files, no database. Notes are written through a temp file and a rename and re-read before every change, so two sessions in two repos don't erase each other's skills.


### Not done

- No skill-tree pane inside the TUI yet. The tree is `dum --skills` or the browser graph. ([#1](https://github.com/hub-ry/dum-intern/issues/1))
- No git protocol. dum writes files and never commits, branches, or checks what's dirty first. ([#2](https://github.com/hub-ry/dum-intern/issues/2))
- In anti-vibe, the intern can claim the build matches the spec before checking. The build review catches it, but only afterwards. ([#3](https://github.com/hub-ry/dum-intern/issues/3))
- The level thresholds and gap sizes are a first guess, not tuned against real sessions. ([#4](https://github.com/hub-ry/dum-intern/issues/4))
- The intern runs on the Claude Code bundled with the Agent SDK but uses my default model. A model newer than that bundle fails every request. dum says to `npm update @anthropic-ai/claude-agent-sdk` in its own folder, but can't do it for me.


### Contributing

[CONTRIBUTING.md](CONTRIBUTING.md): the rules that are the product, how to check a change, and how scenarios work.

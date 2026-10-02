# dum-intern

My custom agentic environment with a tighter development leash: it only writes code on skills I've unlocked.

![dum-intern: the file tree on the left, a C++ guessing game with one TODO(dum) gap in the middle, and the wizard and dum on the right above the conversation](docs/screenshot.png)

Everything I ask for rests on a handful of skills. dum checks each one against my skill tree. An unlocked skill means the intern writes that code. A locked one is mine to type, or I unlock it first with a three-minute course run by dum and the wizard.

The bet: a coding agent makes it easy to ship code I couldn't write myself, and I only find out when something breaks. So the agent's reach is capped by mine. Courses go in order, too. If I can't print hello world, I can't take the recursion course, and I can't prompt my way past it either.


### Quickstart

Node 22.6+ and the `claude` CLI logged in. No build step, no API key.

```sh
npm install
npm link        # puts `dum` on your PATH
cd some-repo    # dum works inside a git repo
dum
```

An empty tree says how it works on the first screen. `dum --help` lists the commands, and `:help` inside dum lists the rest.


### The loop

1. **Ask.** "print hello world in python", or "a guessing game in C++".
2. **The plan.** The intern names the skills the code rests on. dum sorts them, in code, into what it writes, what's mine, and what's locked deeper. `y` builds it.
3. **Unlock or type.** `course printing` from the plan runs the course right there, then the plan comes back with that skill moved over. Or I approve it as is and type the locked parts.
4. **Fill the gaps.** Unlocked blocks type themselves in. Locked ones are `TODO(dum)` holes. I type one and say `done`, and passing puts the skill on the tree.

```
  a recursive fibonacci in fib.py

  DUM WRITES
  - printing (python)

  YOU TYPE, OR TAKE THE COURSE
  - return values (python): fib returns the nth number · course return values

  LOCKED DEEPER
  - recursion (python): needs return values · start with course return values
```

A plan can carry at most four locked skills, because working memory holds [about four chunks](https://philpapers.org/rec/COWTMN) (Cowan, 2001). Past that, dum refuses the plan and the intern offers a first rung instead. With only printing unlocked, "write a recursive fibonacci function for me" came back as an iterative fibonacci on variables and arithmetic, with those two courses next.


### Two modes

```sh
dum "print hello world in rust"       # understand everything (default)
dum -a "print hello world in rust"    # anti-vibe
```

The only difference is what a locked skill costs. In understand-everything I type it. In anti-vibe I explain it in plain words, and once the explanation holds up, dum fills the hole in front of me. A course unlocks a skill in either mode.


### Courses

`course recursion`, `course for loops in rust`, or `:course x`. They work at the plan, between requests, or as the first thing: `dum "course printing in python"`.

A course is one idea and about three minutes:

- **dum** writes a short lesson and a worked example, using only what's already on my tree.
- **the wizard** adds one line: what it's called out in the world and where it shows up. "that's stdout - print just writes text to standard output, the same stream every unix tool like grep and cat uses."
- **the gap** is 1-3 lines in a scratch file, `.dum/courses/<skill>.<ext>`. I type it, `:w`, `done`. A judge reads it like a reviewer: does it do what the gap asked, and would it run. A miss gets a question, never the fix. Anything else I type is a question about the course, answered without doing the gap. `quit` leaves it.

Passing unlocks the skill. If an open hole was waiting on it, the intern fills that hole straight after.

Working code with a part missing is what the research calls a [completion problem](https://www.uky.edu/~gmswan3/544/Cognitive_Load_&_ID.pdf) (van Merriënboer & Krammer, 1987). The order is [mastery learning](https://en.wikipedia.org/wiki/Mastery_learning): prerequisites first. It only works if the tree is right, because "the most important single factor influencing learning is what the learner already knows" ([Ausubel, 1968](https://www.simplypsychology.org/expository-method-of-teaching.html)).


### The skill tree

```
$ dum --skills

  python  4/30
    ● printing
    ● variables
    ○ arithmetic  course open
    · recursion  needs return values, conditionals
```

`●` unlocked. `○` every prerequisite is mine, so the course is open. `·` locked behind something I don't have yet.

- **Per language.** "printing" in Python and "printing" in C++ are two skills. An idea with no language, like idempotency, only counts in a language I've unlocked something in. Knowing recursion doesn't write Rust.
- **Curated tracks.** `src/trees/` has one YAML file per language: Python, JavaScript, TypeScript, C, C++, Rust, Go and Java. Each skill lists only what it builds on directly, and a test walks every track from an empty tree to make sure nothing is unreachable.
- **Off the tracks, the model maps it.** A skill no track has, like websockets, gets its prerequisites from the intern or the course designer. They're saved to `~/.dum/prereqs.json` the first time, so the gate gives the same answer every time it's asked, not whatever the model says that day.
- **Four ways on.** Typed, explained (anti-vibe), passed a course, or added by hand. Each note records which.
- **Mine to edit.** Each skill is a markdown note with `[[links]]` to what it builds on, so `~/.dum` opens as an Obsidian vault. `:skill printing, variables in python` adds skills, lowest first, and refuses one whose prerequisites aren't on the tree. The rule, shown every time: only add what I can write from a blank file, completely without AI. `:skill -x` or `dum --forget` takes one off.
- **Honest about mistakes.** Every unlock shows as `+ skill: <name>`, and `not yet` right after takes it back for the session.

Notes from the older tree still load. A solid note counts. A shaky one was only ever taught, so it stays locked.


### Holes

Code only enters a source file through a `TODO(dum)` block tagged with one skill. The intern writes the file as blocks, then hands dum the code for each one:

```
  ▌ hole  greet.py: input  (locked - yours)
  ✓ fill  greet.py: printing  (a skill you hold)
    │     print("Hello, " + name + "!")
```

A fill types itself into the highlighted block, and the transcript keeps the code. Skipping a skill I hold means not retyping it, never not seeing it. Open holes live in `.dum/todos.json`, and the next `dum` opens on them.


### The screen

Three places, one rule each.

- **The input**, at the bottom, is where I type, always. Its grey placeholder says what typing does right now. With the file showing, the prompt is `>` and I'm talking to dum, though `cd`, `gcc` or `./guess` still go to the shell. With the shell showing, the prompt is `$` and everything runs there. dum's own words (`done`, `y`, `quit`, `course x`) still reach dum. A program waiting for input turns the prompt into `guess ›`, and `ctrl-c` stops it. It only quits dum when nothing's running.
- **The middle** is code: the file, or the shell. `shift-tab` flips between them, and so does clicking the `file` / `shell` tabs. The shell is my own `$SHELL` in a pty, kept for the session, so `cd` and history stick.
- **The right** is the characters: faces side by side, and the whole conversation under them, newest at the bottom. Something too big for the thread, like the plan, a course or help, takes over as a board. A course board stays up beside its scratch file while I type the gap.

`tab` moves between the input, the file and the tree, and clicking a pane does the same. The trackpad scrolls whatever's under the pointer. That needs the terminal's mouse reporting, so plain drag-to-select becomes Option-drag (iTerm, Terminal.app) or shift-drag elsewhere.

When dum has something to say about one line, it pins a live comment beside it. It's never saved to the file, and it clears on the next turn:

```
  5 name = typed.strip()  ◂ your input hole needs to store the text as `typed`
```

The file is a vim-ish buffer: `i` types, `:w` writes, `/` finds. It's for typing gaps and fixing what I just watched get written, not for living in.


### The two voices

dum is the intern: the plan, the build, the checks, and the lesson half of a course. It follows my own default model and `/effort`, read back from the running session.

The wizard co-hosts courses. It names the thing and says where it shows up, and nothing else: it never explains the mechanics and never tells me what to do. It runs on Sonnet 5.5 at medium effort, in parallel with dum's half, so it adds no wait. It replies `pass` rather than guess, and an em dash in its line gets replaced in code.


### Enforced in code, not in the prompt

Every rule that only lived in a prompt got skipped eventually.

- Whether a skill is unlocked is decided by `curriculum.ts` against the notes on disk. The model names skills; it never decides whether I have them.
- A course is refused until its prerequisites are on the tree, and so is adding a skill by hand.
- Mutating tools are denied until I approve the plan.
- Code outside a `TODO(dum)` block is refused, except a lone closing brace. So is an Edit that rewrites a hole of mine, a block over twelve lines, a hole on a skill that wasn't a locked piece of the approved plan, and comment runs over three lines.
- Paths are checked on the way through: `cwd` doesn't confine the agent, and it once wrote to `$HOME`.
- Held and refused calls draw differently from ones that ran, with the reason, so the screen never claims something happened that didn't.
- Nothing quietly feeds the intern context. Opening files, the shell and my edits never reach it.


### Keys

| Key | Action | Where |
| :--- | :--- | :--- |
| `tab` | input, file, file tree, and around (or click a pane) | anywhere |
| `shift-tab` | the middle: file ⇄ shell (or click the tab) | anywhere |
| `esc` | close a board: help, a course, the log | input |
| `ctrl-c` | stop the program running in the shell; with none, quit | anywhere |
| trackpad, `page up` / `page down` | scroll the conversation or a board | anywhere |
| `course` x [in lang] | unlock a skill with a short course (`:course` works too) | anywhere dum is listening |
| `y` | build the plan; anything else goes back to the intern | plan |
| `done` | check what I typed into a hole, or a course gap | your turn, course |
| an explanation | fills the hole it explains, if it holds up | your turn, anti-vibe |
| `quit` | leave a course; the skill stays locked | course |
| `not yet` [name] | take back the skill just unlocked | anywhere |
| `:skills` | what's unlocked, open and locked | input |
| `:skill` x, y [in lang] | add skills I can write without AI (`:skill -x` takes one off) | input |
| `cd`, `gcc`, `echo`, `./a.out` ... | run in the shell, as typed | input |
| `!` + command | anything else in the shell (`!` alone opens it) | input, file's `:` line |
| `:run` | run the open file; compiled languages get the line to type instead | input, file's `:` line |
| `:log` | everything said so far, on a board | input, file's `:` line |
| `:help` | all of this | input |
| `ctrl-a` `ctrl-e` `ctrl-u` `ctrl-k` `ctrl-w` | start, end, delete to start, to end, a word | input |
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
| `-a`, `--anti-vibe` | explain locked skills instead of typing them |
| `-u`, `--understand` | the default, spelled out |
| `-p`, `--plain` | line printer instead of panes, also what you get in a pipe |
| `-n`, `--new` | a fresh intern in this repo: its memory and open holes moved aside |
| `-s`, `--skills` | print the tree |
| `--add "<skill>, <skill>" [--in <lang>]` | add skills I can write without AI, lowest first |
| `--forget "<skill>" [--in <lang>]` | lock one again |
| `--reset` | start the tree over, the old one moved aside |
| `-h`, `--help` | the short version of this |

The tree flags work from anywhere. A session needs a git repo, since the intern works from the tracked files.


### Where things live

```
~/.dum/
  skills/          the skill tree, one note per skill (DUM_HOME moves it)
  prereqs.json     prerequisites the model mapped for skills off the tracks

<repo>/.dum/
  session          so the next `dum` resumes the same intern
  todos.json       holes left for me
  courses/         course scratch files, one per skill
  layout.json      optional: where the panes go
  debug.log        with DUM_DEBUG=1
```

Plain files, no database. Notes are written through a temp file and a rename and re-read before every change, so two sessions in two repos don't erase each other's skills.


### Not done

- No skill-tree pane. `:skills` shows it on a board, and `dum --skills` prints it. ([#1](https://github.com/hub-ry/dum-intern/issues/1))
- No git protocol. dum writes files and never commits, branches, or checks what's dirty first. ([#2](https://github.com/hub-ry/dum-intern/issues/2))
- After approval the intern can still run Bash, and a shell command can write a file without going through a block. The gate only sees Write and Edit.
- The curated tracks are a first pass, written by hand and not yet tuned against real sessions. ([#4](https://github.com/hub-ry/dum-intern/issues/4))
- The intern runs on the Claude Code bundled with the Agent SDK but uses my default model. A model newer than that bundle fails every request. dum says to `npm update @anthropic-ai/claude-agent-sdk` in its own folder, but can't do it for me.


### Contributing

[CONTRIBUTING.md](CONTRIBUTING.md): the rules that are the product, and how to check a change.

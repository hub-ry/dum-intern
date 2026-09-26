# dum-intern

My custom agentic environment with a tighter development leash.

![dum-intern: file tree on the left, what's being written in the middle, the wizard and dum on the right](docs/screenshot.png)

It interrogates me before it builds anything. Nothing gets written until I approve a spec made out of my own answers.


### Understand everything, by default

```sh
dum "print hello world in rust"       # understand everything (default)
dum -a "print hello world in rust"    # anti-vibe
```

The mode sets how much I have to explain myself.

Understand-everything means what, why, and how. The first time I ask for hello world in Rust, it asks what the `!` in `println!` means. The second time it doesn't, because by then that's on my skill tree.

Anti-vibe drops the how. I own the intent, the intern owns the mechanics. It only stops me when the intent has a hole.

Anti-vibe used to be the default. Understand-everything asked about everything, every time, and a tool that interrogates me over a one-line change is one I turn off in a week. The skill tree is what makes it livable: the questions shrink as I learn instead of staying flat.


### The skill tree

Every concept I explain, or get taught, lands on one tree in `~/.dum/skills/`. It follows me across repos, and it never goes in any repo.

```
$ dum --skills

  ● message queues
    ○ idempotency keys
    ● visibility timeout
      ● leases
  · heartbeats  not shown yet
    ● leases  ↑ above
  · hmac  not shown yet
    ● stripe webhook signing  niche
```

`●` is known. I explained it, so the intern builds on it without asking. `◐` is claimed: I say I have it, dum hasn't seen it yet. `○` is shaky: it had to teach me, or I got it wrong. A quick check on those is fair. `·` is something a skill builds on that I haven't touched yet. That's the frontier.

Nobody curates the edges. When the intern records a skill it names what the skill builds on, so the tree grows into the shape of what I actually build.

General skills count everywhere. Idempotency is idempotency in every repo. Niche ones, like one library's webhook signing, only count in the repo where I showed them. Anywhere else they get one short check, because one-off knowledge fades.

There's no level. It used to be a ladder: prove 2 topics and you're "trusted", 6 and you're "senior". Six easy topics bought the same rope as six hard ones. Now it's per skill. Fewer questions on the parts of a request I already hold, normal questions on the rest.

A wrong "known" is the worst bug this thing can have. It's a question that never gets asked again. So every new one shows up as `+ skill: <name>` while it's fresh, and `dum --forget "<name>"` takes it back off.

Skills go a bit stale. Something general I proved over a year ago, or something niche over two months ago, gets one quick check if a build leans on it. Explaining it again resets the clock.

One idea should be one node. "Leases" and "lease", or "Rust macros (macro_rules!)" and "rust macros", land on the same skill. Near-misses like "SQS visibility timeout" next to "visibility timeout" get caught before they're recorded, and the intern has to say whether it's the same idea. It's deliberately not a merge: "rust macros" and "rust procedural macros" pass the same word test and are different things.

It doesn't buy skipping the spec. Nothing does.


### It's notes, and they're mine

Each skill is a markdown note. "Builds on" is a `[[link]]`, so the folder opens as an Obsidian vault and the graph view draws the tree. A skill nobody's recorded yet is an unresolved link, which Obsidian already draws as a grey node.

```markdown
---
name: module-relative file paths
state: solid
breadth: general
---

They read `pathlib.Path(__file__).parent` correctly as the directory containing the file.

builds on: [[python main guard]]
```

I can fix a wrong one, delete one, or write one. A note I write myself counts as claimed, not known, and so does one with no frontmatter at all. The file name is the skill.


### The graph

```sh
dum --graph        # or :graph in a session
```

The tree and the queue as one picture, in the browser. The layout copies the Rust project's skill-tree: Graphviz boxes top to bottom, each project a group of the skills it unlocks, with a box to tick for each, climbing from what's done toward the goal. A goal and its steps share a frame. Skills no project covers sit in "your tree", and prerequisites nobody's recorded are dashed.

The interaction copies Obsidian's graph. Drag to pan, scroll to zoom, hover to light up what a node touches. Click to read the note: the brief, what it unlocks, what it comes after, the `dum` command that starts it, and a link that opens the note in Obsidian. `#open=<id>` on the URL opens one directly.

It's one file, `~/.dum/graph.html`. Graphviz runs in Node as WebAssembly and the SVG goes in already laid out, and the pan-and-zoom script is inlined from `node_modules`. Nothing loads from a CDN, so it opens offline.


### Claiming what I already had

An empty tree means dum asks about everything, including things I knew before dum existed. So I can point it at projects I wrote by hand:

```sh
dum --scan ~/code/old-cli ~/code/raytracer
```

It reads them and lists the concepts the code actually rests on, each with the line that shows it. I drop what isn't mine (a vendored library, a file a friend wrote), and the rest lands as claimed.

Claimed isn't known. Nobody watched me write that code. The first build that leans on a claimed skill gets one short check, and passing it makes it known. Something dum already judged in a session is never touched by a scan. A skill I fumbled in front of it stays shaky however much of it my old code uses.

`dum --reset` starts the tree over. The old notes get moved aside, not deleted.


### A shell, and no chords to collide with

Learning a language includes running it, and the panes used to make that awkward. `!g++ -std=c++17 -Wall -o lab lab.cpp && ./lab` runs in a real shell. The panes step aside, the program gets the whole terminal (input and ctrl-c included), and Enter brings them back with nothing lost. `!` alone is my own shell until I `exit`.

`:run` runs the open file for languages where that's one obvious command: python, node, ruby, go. For C, C++ and Rust it doesn't compile anything. It shows the line to type, because typing the compiler line is part of learning the language.

dum's commands are typed, not chorded. `:run`, `:graph`, `:log`, `:help`, like vim's ex line, and they work on the file pane's `:` line too, next to `:w`. `ctrl-g` belongs to a browser extension and `ctrl-e` to every shell's end-of-line, so the input gets readline's keys and dum takes none. The one global chord left is ctrl-c.

What runs in the shell is mine. The intern doesn't see it.


### Pages, and a trackpad that scrolls

The stage has pages, and a bar on top says which one you're on: the file, dum's latest reply, and the log. A reply too long for the six lines under dum's face opens as its own page, so a long answer doesn't hide behind `:log`. `shift-tab` goes back to the page you were just on, and again comes back, like alt-tab. With the stage focused, `←`/`→` walk the pages, and `j`/`k`, `space`/`b` and `g`/`G` scroll whichever one is up.

The trackpad scrolls the pane under the pointer, focused or not. Full-screen programs don't get that for free: without mouse reports the wheel does nothing, and inside tmux it scrolls tmux's history instead. So dum turns on the terminal's standard mouse reporting and takes the reports out before Ink sees them, or they'd be typed into the input as `[<65;40;12M`. Ink 7 has no mouse support, and the one Ink mouse library targets Ink 5, so this piece is dum's own.

The cost is plain drag-to-select. Option-drag (iTerm, Terminal.app) or shift-drag (most others) still selects text, and in tmux selection is tmux's anyway.


### Short, on purpose

This is closer to a game than a document, and every long message is a turn I stop playing. The rules come from [i-have-adhd](https://github.com/ayghri/i-have-adhd/blob/main/skills/i-have-adhd/SKILL.md), and they're kept in code wherever code can keep them:

- **Where I am is always on screen.** `feature 2/9 ▰▱▱▱▱▱▱▱▱` in the header, and on its own line at every prompt in plain mode, with the open holes.
- **One next action, and dum says it.** "next up: … say go", "your turn: … type it and say done, or explain it here". The intern doesn't have to.
- **Wins show.** Every `✓ feature 3 of 9 ▰▰▰▱▱▱▱▱▱` moves the bar.
- **Numbers, not "a bit of work".** Every feature, milestone and project comes with minutes, and none is allowed over 45.
- **What dum says fits in working memory.** The pane shows six lines and points at `:log` for the rest.
- **Lists stop at five.** The rest is a count.

The intern's prompt carries the rest. After a build it gets three lines: what runs now, where my holes are, and nothing else. It doesn't recap, list the files, or write a "still open" essay. The spec's sections are five bullets at most, and a section with nothing real in it is left out. Lessons and `?` answers are two or three sentences.


### Not too strict

The intern used to over-ask. Now it's told most requests need zero to three questions, and that plain words count as an explanation. I don't need the jargon, I need to clearly get it.

It still holds me to it. A vague answer gets re-asked. A wrong one gets called out in one line and goes on the tree as shaky.

Two `idk`s in a row on one request and it stops asking. It writes the spec and explains the rest after the build. A third question at that point is a wall, not a check.


### First sessions

An empty tree is the worst moment for this tool. Everything is new, so everything is a question, and a first session that feels like an exam is the last one.

So while the tree has fewer than five skills, the intern changes how it asks. The bar doesn't move.

- It asks to be taught. "how does print get the text onto the screen?" instead of "explain print". The intern is a junior, and I'm the one teaching it. Students put more effort in for a teachable agent than for themselves, and the gain was biggest for the ones who started furthest behind ([Chase et al., 2009](https://doi.org/10.1007/s10956-009-9180-4)).
- It opens with the real question I'm most likely to get right.
- It prefers questions I can answer by predicting. "does `1..=10` stop at 9 or 10?" A wrong guess followed by the answer sticks better than being told outright ([Kornell, Hays & Bjork, 2009](https://pubmed.ncbi.nlm.nih.gov/19586265/)).
- One or two questions on a first request. The rest waits for the next one.
- The first question says `idk` is a fine answer, once.

On a fresh tree, "add a done command" to a tiny todo CLI got exactly one question: "`list` prints todos as 1., 2., 3. If you run `todo done 2`, which array index does that need to touch?" That's the one real trap in the build, asked as a prediction.


### Projects to climb toward

The tree says what I hold. A project I want to build can sit far above it. A browser multiplayer game rests on websockets, which rest on HTTP and TCP, which rest on things I may never have touched. dum won't build what I can't explain, so a goal eight tiers up is a goal I can't start. Unless something walks me up to it.

```sh
dum --queue "a multiplayer game server for a tiny browser tag game"
```

```
  ✓ a multiplayer game server for a tiny browser tag game: 8 tiers above your tree, so 12 steps first.

  ▶ turn based tag in one terminal  client-server model, event loop, game state modeling
    start: dum "..."
  ▶ vector bumper toy  2d vectors
  · async tcp tick counter  tcp sockets, async await, game loop
  · websocket drift box  websockets, json encoding, movement integration
  ...
```

A model maps what the goal rests on, down to my tree. The tiers are counted in code: what I hold is tier 0, anything else is one above the highest thing it builds on. Each tier below the goal becomes stepping stones, three skills at most, an evening each. A step only waits on another when one of its skills builds on one of the other's, so separate branches can be climbed in any order.

Nothing gets ticked off by hand. A project is done when the skills it unlocks are on my tree, and ready when what it comes after is done. Explaining something, or typing it into a hole, is what moves the queue.

The queue is a folder of notes in `~/.dum/projects/`, beside the skills, so one Obsidian vault on `~/.dum` links projects to skills. A markdown file I drop in there by hand is a goal too, and `dum --plan` plans it.

`dum --next` is the short version: one small project that unlocks the next skill fastest. It goes for what my queue's ready steps need, then what I've been taught but haven't shown, then prerequisites my tree names but nobody's recorded. `dum --next 3` gives three.

Planning runs on Opus, not the Sonnet the voices use. It runs once, and everything after follows the map it draws. A wrong prerequisite is a project I get sent to build for nothing.


### Asking to learn something

```sh
dum --learn "websockets"             # into ./learn-websockets
dum --learn "websockets" ~/chat      # or anywhere empty
```

The fastest way to learn one thing is a project where it's the only new thing. So the designer reads my tree first and builds around what I already hold. The questions, holes and fills all land on the topic, not on whatever's around it.

```
  ✓ live chat room  A tiny Python websocket chat server and terminal client...

   1  Start a websocket server that echoes back whatever a client sends.
   2  Write a terminal client that connects, sends a typed line, and prints the reply.
   ...

  you hold 5 of the 14 skills it rests on (36%). those get filled in front of you.
  already yours: http request-response, json encoding, python dictionaries, ...
  new to you: asyncio basics, websocket handshake, websocket connection lifecycle, ...
```

Nothing about what I know is assumed. The percentage is counted against my tree in code, and the design is asked to list the skills of mine it uses by their tree names. The folder runs like a rebuild: `go` takes the next feature, and a feature is done once its holes are.

No stepping stones, unlike a queued goal. Learning fast means the gaps get handled inside the project.


### A new language starts from nothing

A skill can belong to one language. "range-based for" is C++, "list comprehensions" is Python, and the tree marks them `c++ only`, `python only`. One of those only counts in files of its language, decided in code from the file's extension. So knowing Python's for loops fills nothing in a `.cpp` file.

Ideas that carry across languages don't get a language. Recursion, hash maps and idempotency count everywhere. Asked for a recursive factorial in C++ by someone who knew Python's printing and loops and knew recursion, dum filled the recursive function and left the `#include` and the `std::cout` line as holes.

That's understand mode. In anti-vibe a new language's syntax is the intern's, same as any other mechanics.


### Explaining a hole fills it

A hole doesn't have to be typed. At "your turn" I can explain the concept in plain words instead:

```
  your turn: websocket persistent connection in server.py
  > unlike an http request, the websocket stays open after the handshake, so the handler
    just loops over the connection: for each message, await sending it straight back...
  + skill: websocket persistent connection   (not yet keeps it off)
  ✓ fill  server.py: websocket persistent connection  (a skill you hold)
    │     async for message in websocket:
    │         await websocket.send(message)
  ✓ feature 1 of 9: Start a websocket server that echoes back whatever a client sends.
```

The intern judges it like any answer. If I've got it, the skill goes on the tree, and since dum only fills what the tree holds, it now fills the hole, typed in where I can watch. If I'm close, I get one question. It works on any later turn, because the spec that left the hole was already approved. So if I hold half a project, that half fills as it's built, and the other half fills as I explain it.


### Rebuilding what I already have

Having a project isn't the same as being able to explain it. Especially one I wrote fast, or with a model's help.

```sh
dum --rebuild ~/code/hysa            # into ~/code/hysa-rebuild
dum --rebuild ~/code/hysa ~/rebuilt  # or anywhere empty
```

Opus reads the original and turns it into milestones, each a short request to dum, starting from the smallest thing that runs. It's also a goal like any other: mapped, tiered against my tree, and anything far above it gets stepping stones in the queue. The target gets `git init`, and `dum` there opens on the next milestone. `go` starts it.

The original stays out of reach. The rebuild is its own repo, and the intern's path gate refuses anything outside it. The only ways code gets there are the usual ones.

Skills I hold can be skipped. A piece that rests on one gets filled, and I don't retype what I've already shown. Skipped doesn't mean unseen, though. A fill types itself into the highlighted block at a pace I can follow, and the transcript keeps the code, not just a line saying it happened:

```
  ✓ fill  stats.py: median  (a skill you hold)
    │     s = sorted(xs)
    │     mid = len(s) // 2
    │     ...
  ▌ hole  stats.py: multimodal data  (yours to type)
```

A milestone isn't built until its holes are. Writing the skeleton doesn't count, and the last hole passing review does.


### The intern asks, the wizard tells

Two voices. Questions I have to answer come from the intern. The wizard only fires on an answer I already gave, so it can't answer a pending question for me.


### The wizard talks without being asked

```
  > another worker should pick it back up after a while if the first one dies

     │ 🧙 that's a visibility timeout - the mechanism SQS and most
     │    job queues use for exactly this failure case.
```

When something I said has context attached, it mentions it. The real name for what I described, what does it in industry, how experienced engineers usually do it.

Naming things is the most useful thing it does. The name is what I go look up after.

"Senior engineers usually put the idempotency key in a unique index" is a suggestion dressed as a fact. The wizard is a persona with no career, so that only works if it's actually standard practice. It's told to spend that credibility only on things that are.


### Nudges

```
  > i'll just store the amounts as floats in dollars

     │ 🧙 what does 0.1 + 0.2 give you as a float? money usually
     │    lives in integer cents to avoid rounding errors.
```

When I say something wrong, it asks the question that makes me run the case in my head, then points at where the answer lives.

I built the wizard as a critic first. It was worse. Criticism makes you stop and deal with it, so it can only fire rarely. A nudge I can work out in two seconds is closer to trivia than to a code review.

The question has to come first. Opening with the answer does the thinking for me. Asked nicely in the prompt, it still opened most corrections with the answer. So now the wizard tags every line `fact:` or `nudge:`, and a nudge whose first sentence isn't a question gets dropped in code. Dropping one is cheap, since the intern pushes back on wrong answers by itself.


### A second opinion on every line

The wizard's value is being right, and asking it harder to be right stopped working. In a real session it told me `println!` was "monomorphization" right after I'd explained it was a macro. In evals it said "yeah, `..=` is inclusive" to someone who'd just called it exclusive, which reads as agreeing with the mistake.

So a second session reads every line against what I actually said before I see it. It doesn't write lines and has no stake in them. It first decides whether I was right, then checks the line: accurate claims, the standard name for exactly what I described, and no orders aimed at me. A `fact:` about a wrong answer gets dropped in code, since it's either agreement or a correction with the wrong tag.

`npm run eval:checker` runs it over lines with known verdicts: real bad lines from sessions and evals, plus the near-miss names the wizard is prone to (dead letter queue for a lease, throttling for debouncing). The last run dropped 45/45 bad lines and kept 45/45 good ones over five runs each. A quip takes about 4s with the check, and the intern takes longer than that to form its next question.

Lines the wizard searched for skip the check. The checker would veto them for being newer than it knows about, which is the failure search exists to fix.


### It looks things up

Ask a model about something released after its training cutoff and it'll tell you it doesn't exist. In a coding tool that's a real problem. Questions about a library version from last month come up all the time.

The wizard and `?` answers get today's date and web search, with one rule: not recognizing something is a reason to search, not an answer. `? what's new in claude opus 5.5 compared to 4.5` searches, answers, and names the announcement it came from.

Search costs time. That `?` answer took 23s. The wizard only searches when I name something it doesn't recognize, so most quips still land in a few seconds. When it does search, what it finds is the line: "opus 5.5 dropped yesterday and thinking can't be disabled anymore, so calls that hardcode a no-thinking mode from opus 5 will break." I checked that against Anthropic's announcement. It's right.


### It doesn't know what the intern asked

It gets what I'm building and the sentence I just said. Not the question.

The question was in there at first. I described a worker reclaiming a dead worker's job, which is a lease, and it called it a dead letter queue in 2 runs out of 5. The question had mentioned retries and failures and it answered that instead. Prompting it not to didn't work. Removing the question did.

Side effect: an answer like "yes" or "postgres" now gives it nothing to grab, so it stays quiet.


### Sonnet, not Haiku

Haiku got names wrong. Sonnet got that same lease case right 5 out of 5. Same wall time, since the latency is the round trip and not the model.

The name is the whole product. A wrong one is worse than nothing, I'd repeat it in an interview.

Each voice has its model and effort level next to its name, as the running session reports them rather than as configured: `dum  opus 5.5 · high`, `wizard  sonnet 5 · medium`. The intern runs on my default model at my own `/effort` setting, so that label is how I find out either changed.

Every other call pins its level. The wizard and the line checker run at medium with thinking off, because they're in the latency path. The `?` reference and the build review run at high. Scanning, planning and reading a rebuild run at high too, on Opus for the last two, and their progress lines say so.

Thinking off, effort medium, no settings files. Defaults took ~25s per quip, slower than me typing the next answer, so quips showed up after I'd moved on. Now a few seconds. Skipping settings also keeps my CLAUDE.md from overwriting the wizard's personality.


### Measuring the wizard

```sh
npm run eval:wizard              # every case, 3 runs each
npm run eval:wizard -- 5 nudge   # 5 runs of the nudge cases
```

Fixed exchanges, a fresh wizard per run, every line printed with its kind. It covers naming (lease, debounce, write-ahead log, and the macro exchange that produced "monomorphization"), nudging (a wrong Rust range, float money, sha256 passwords), correct statements that must never get nudged, the idempotency practice line, a stale Node version, a model newer than its training, and passing on a bare "yes". `DUM_DEBUG=1` logs every pass and every veto with its reason. A prompt change isn't done until this reads right.

Two things I learned tuning it. Quoting a bad example in the prompt gets it said back: listing "backwards actually" as a thing not to say produced "backwards actually". And an example that matches an eval case gets parroted, so the eval stops measuring the voice.


### idk

Not knowing the answer and not having the concept are different. I type `idk` and the wizard explains the concept, why it exists, and what teams argue about with it. Then it hands the question back without answering it. That concept goes on the tree as shaky.

I declare it. Nothing infers it.


### Type it

Explaining was the only way onto the tree, which made the tree exactly as good as the intern's read of my sentences. Tuning that is prompt work, and prompt work only goes so far.

So a question has a second answer. I can explain it, or say `type it`.

```
  For an even-length list like [1, 2, 3, 4], what should median return?
  answer it · idk · type it
  > type it
```

The spec gets a "you type" section. The intern builds everything around that piece and leaves a hole where it goes:

```python
def median(xs):
    s = sorted(xs)
    # TODO(dum): median of a sorted list
    # Given `s`, already sorted, return its middle value.
    # Odd length: the single middle element. Even length: must be handled too.
    raise NotImplementedError
```

What the code has to do, never how. The file pane opens on it, I type it in, `:w`, and say `done`.

The intern reads it like a reviewer. If it works, the skill goes on the tree as solid, same as explaining it. If it doesn't, I get a question: "for median([1, 2, 3, 4]), which index does `s[len(s) // 2]` read?" Not the fix, and it doesn't touch my code. `done` on a file I haven't changed gets caught in code without a round trip.

Open holes live in `.dum/todos.json`, so quitting halfway is fine. The next `dum` in that repo opens on the hole.

Typing is harder to fake than a sentence. A deleted marker isn't an implementation, and a function that's wrong on the even case doesn't pass.


### Every piece starts as a hole

In understand mode, the parts of a build that rest on a concept get written as `TODO(dum)` blocks first. Glue and boilerplate don't, just the pieces I'd have to understand. Then the intern hands dum the code for each block, and dum decides from my tree, not the intern:

```
  · Write  stats.py
  · fill  stats.py: median
  ▌ hole  stats.py: frequency counting  (yours to type)
```

Known skill: the block sits on screen for a moment, then the code goes in. Not on the tree, shaky, or taken back with `not yet`: the block stays, and it's mine to type. Either way I see where the build leaned on something.

The intern can't route around it. An Edit that rewrites a `TODO(dum)` block, or a Write that drops one, is refused at the gate. Open blocks are painted amber in the gutter until I type over them.

Anti-vibe has no holes unless I say `type it`. The mechanics are the intern's there.


### Not yet

The intern can be right that I hold something, and I can still not want it counted. `not yet` right after a `+ skill` takes it back. It goes back to what it was before this session, or off the tree if it's new, and it stays off until the session ends. The intern is told, so a hole for it stays mine. `not yet <name>` picks one further back.

It doesn't cost the turn, same as `?`. A bare `not yet` with nothing to take back is just an answer: "have you added tests?" "not yet".


### Enforced in code, not in the prompt

Mutating tools are denied until I approve the spec. v1 asked for this in the system prompt. On the first real run the intern skipped it, wrote two files, and printed "nothing was built".

Paths get checked on the way through too. `cwd` doesn't confine the agent - it wrote to `$HOME` while `cwd` was a scratch dir.

Held and refused tool calls render differently from ones that ran. After a build, the wizard reads what got written against the spec I approved and only speaks up if they don't match.


### The file is a buffer

The wide pane used to `cat` the tail of whatever the intern was writing. Fine while it streams, useless the moment it stops: a 300-line file showed its last 30 and there was no way to see the rest.

Now it is a buffer. Once a file is on disk it scrolls, searches and edits, and a file opened from the tree is that from the start. `tab` lands you in it, `i` types, `:w` writes, `esc` hands the keyboard back.

The keys are vim's, because the tree beside it already speaks them. The arrows, page keys and home/end work in both modes anyway, so you can read a file without knowing any of it. Editing is `i`, `a`, `o`, `x`, `dd`, `u`, and the `/` and `:` lines. No visual mode, no counts, no registers beyond one line-wise one. It is for fixing the thing you just watched get written, not for living in.

While a write streams the pane follows the tail and refuses edits. Once the write lands it swaps what the intern said it would write for the file as it is - for an Edit that means the whole file, opened at the edit, instead of the replaced fragment. The gate's verdict fires before the tool runs, so "landed" is its own signal, read off the tool result.

Your edits are yours. Saving is not a tool call, the gate has no say, and the intern is not told. It sees the file the next time it reads it, which is the same rule as everything else here: nothing quietly feeds it context. A line in the transcript says `you wrote src/x.ts` so you can see it later.

Buffers outlive the view. The intern starting a new file pulls the pane onto it, and unsaved edits to the last one stay where they were until you go back. If the intern writes a file you are mid-edit in, the pane says so and keeps yours; `:e` reloads and drops them. Dropping edits over a race the intern started is not a call the pane gets to make.


### Not done

Quips render inline, not in a real second pane. Every quip gets written to `.dum/wizard.jsonl`, so the pane is a reader over that file.

The graph is a browser page. Inside the TUI the tree is still a printout (`dum --skills`), not a pane.

There's no git protocol. dum writes files and never commits, branches, or checks what's dirty before it starts. What it should do there is still open.

The intern runs on the Claude Code bundled with the Agent SDK, but it uses my default model. Switch to a model newer than that bundle and every request fails. dum says so and tells me to `npm update @anthropic-ai/claude-agent-sdk` in its own folder, but it can't fix it for me.


### Keys

| Key | Action | Where |
| :--- | :--- | :--- |
| `tab` | input, stage, file tree, and around | anywhere |
| `shift-tab` | the stage's last page, and back - alt-tab for file, reply and log | anywhere |
| trackpad / wheel | scroll whatever's under the pointer | stage, file tree |
| `←` `→`, `[` `]` | the stage's pages: file, reply, log | stage |
| `j` `k`, `space` `b`, `g` `G` | scroll a reply or the log | stage |
| `?` + text | ask anything, answered off to the side without costing your turn | input |
| `!` + command | run it in a real shell - the panes step aside, enter comes back | input, file's `:` line |
| `!` | your own shell, until `exit` | input |
| `:run` | run the open file. Compiled languages get the line to type instead | input, file's `:` line |
| `:graph` | the skill graph, in the browser | input, file's `:` line |
| `:log` | the full transcript on the stage | input, file's `:` line |
| `:help` | all of this, on the stage | input |
| `ctrl-a` `ctrl-e` `ctrl-u` `ctrl-k` `ctrl-w` | start, end, delete to start, to end, a word | input |
| `idk` | "I don't have this concept", the intern teaches it | answering a question |
| `type it` | "I'll write this part", the intern leaves a hole for it | answering a question |
| `done` | check what I typed into the hole | "what next?" |
| `go` | start the next feature or milestone | "next up" |
| an explanation | fills the hole it explains, if it holds up | "your turn" |
| `not yet` [name] | don't count the skill just checked off | anywhere |
| `y` | approve the spec, anything else declines | spec |
| `j` / `k`, arrows | move | file tree, file |
| `h` / `l` | collapse / expand | file tree |
| `enter` / `o` | open the file (only you see it, the intern doesn't) | file tree |
| `g g` / `G` | top / bottom | file tree, file |
| `ctrl-d` / `ctrl-u` | half page down / up | file tree, file |
| `h` / `l`, `w` / `b`, `0` / `$` | left / right, by word, line ends | file |
| `/` text, `n` / `N` | find, next / previous | file |
| `i` `a` `o` `O` | start typing; `esc` stops | file |
| `x` `dd` `D` `J` `yy` `p` `u` `ctrl-r` | the usual | file |
| `:w` or `ctrl-s`, `:q`, `:e`, `:` number | write, leave, reload from disk, go to line | file |
| `esc` | back to the input | file |
| `exit` or empty line | end the session | "what next?" |


### Running it

Node 22.6+ and the `claude` CLI logged in. No build step, no API key.

```sh
npm install
npm link      # puts `dum` on your PATH
cd some-repo
dum
```

| Flag | |
| :--- | :--- |
| `-a`, `--anti-vibe` | own the intent, skip the mechanics |
| `-u`, `--understand` | the default, spelled out |
| `-p`, `--plain` | line printer instead of panes, also what you get in a pipe |
| `-s`, `--skills` | print the skill tree |
| `--forget <name>` | take a skill off the tree |
| `--scan <folders>` | claim skills from projects I wrote myself |
| `--reset` | start the tree over, the old one moved aside |
| `--queue "<goal>"` | queue a project and plan the steps up to it |
| `--plan` | plan goals I wrote into the queue by hand |
| `--projects` | the queue, what's done, what's ready |
| `--next [n]` | project ideas for the fastest next unlock |
| `--rebuild <dir> [target]` | rebuild a project from scratch, milestone by milestone |
| `-g`, `--graph` | the tree and the queue as a graph, in the browser |
| `--learn "<topic>" [folder]` | a small project to learn a topic fast, feature by feature |

The tree flags work from anywhere. Everything else needs a git repo, since the intern works from the tracked files.


### Where things live

```
~/.dum/
  skills/          the skill tree, one note per skill, shared by every repo (DUM_HOME moves it)
  projects/        the project queue, one note per goal, step, or idea
  graph.html       the graph, redrawn by every --graph
  skills.json.migrated         the old single-file tree, read once into notes

<repo>/.dum/
  session          so the next `dum` resumes the same intern
  wizard.jsonl     every quip
  todos.json       holes left for me to type
  milestones.json  a rebuild's milestones or a learning project's features, and which are built
  debug.log        with DUM_DEBUG=1
  knowledge.json   the old per-repo record, folded into the tree once and left alone
```

Plain JSON, no database. The tree is written through a temp file and a rename, and re-read before every change, so two sessions in two repos don't erase each other's skills.

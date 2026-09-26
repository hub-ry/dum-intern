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

Every concept I explain, or get taught, lands on one tree in `~/.dum/skills.json`. It follows me across repos.

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

`●` is known. I explained it, so the intern builds on it without asking. `○` is shaky: it had to teach me, or I got it wrong. A quick check on those is fair. `·` is something a skill builds on that I haven't touched yet. That's the frontier.

Nobody curates the edges. When the intern records a skill it names what the skill builds on, so the tree grows into the shape of what I actually build.

General skills count everywhere. Idempotency is idempotency in every repo. Niche ones, like one library's webhook signing, only count in the repo where I showed them. Anywhere else they get one short check, because one-off knowledge fades.

There's no level. It used to be a ladder: prove 2 topics and you're "trusted", 6 and you're "senior". Six easy topics bought the same rope as six hard ones. Now it's per skill. Fewer questions on the parts of a request I already hold, normal questions on the rest.

A wrong "known" is the worst bug this thing can have. It's a question that never gets asked again. So every new one shows up as `+ skill: <name>` while it's fresh, and `dum --forget "<name>"` takes it back off.

Skills go a bit stale. Something general I proved over a year ago, or something niche over two months ago, gets one quick check if a build leans on it. Explaining it again resets the clock.

One idea should be one node. "Leases" and "lease", or "Rust macros (macro_rules!)" and "rust macros", land on the same skill. Near-misses like "SQS visibility timeout" next to "visibility timeout" get caught before they're recorded, and the intern has to say whether it's the same idea. It's deliberately not a merge: "rust macros" and "rust procedural macros" pass the same word test and are different things.

It doesn't buy skipping the spec. Nothing does.


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

Each voice has its model next to its name, as the SDK reports it rather than as configured. The intern runs on whatever my default model is, so that label is how I find out it changed.

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

The tree is a printout. It should be a pane.

The intern runs on the Claude Code bundled with the Agent SDK, but it uses my default model. Switch to a model newer than that bundle and every request fails. dum says so and tells me to `npm update @anthropic-ai/claude-agent-sdk` in its own folder, but it can't fix it for me.


### Keys

| Key | Action | Where |
| :--- | :--- | :--- |
| `tab` / `shift-tab` | input, file, file tree, and back around | anywhere |
| `?` + text | ask anything, answered off to the side without costing your turn | input |
| `idk` | "I don't have this concept", the intern teaches it | answering a question |
| `type it` | "I'll write this part", the intern leaves a hole for it | answering a question |
| `done` | check what I typed into the hole | "what next?" |
| `y` | approve the spec, anything else declines | spec |
| `ctrl-t` | swap the stage to the full transcript and back | anywhere |
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

`--skills` and `--forget` work from anywhere. Everything else needs a git repo, since the intern works from the tracked files.


### Where things live

```
~/.dum/
  skills.json      the skill tree, shared by every repo (DUM_HOME moves it)
  skills.json.corrupt-<time>   a file that stopped parsing, kept instead of overwritten

<repo>/.dum/
  session          so the next `dum` resumes the same intern
  wizard.jsonl     every quip
  todos.json       holes left for me to type
  debug.log        with DUM_DEBUG=1
  knowledge.json   the old per-repo record, folded into the tree once and left alone
```

Plain JSON, no database. The tree is written through a temp file and a rename, and re-read before every change, so two sessions in two repos don't erase each other's skills.

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

It doesn't buy skipping the spec. Nothing does.


### Not too strict

The intern used to over-ask. Now it's told most requests need zero to three questions, and that plain words count as an explanation. I don't need the jargon, I need to clearly get it.

It still holds me to it. A vague answer gets re-asked. A wrong one gets called out in one line and goes on the tree as shaky.


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


### It looks things up

Ask a model about something released after its training cutoff and it'll tell you it doesn't exist. In a coding tool that's a real problem. Questions about a library version from last month come up all the time.

The wizard and `?` answers get today's date and web search, with one rule: not recognizing something is a reason to search, not an answer. `? what's new in claude opus 5.5 compared to 4.5` searches, answers, and names the announcement it came from.

Search costs time. That `?` answer took 23s. The wizard only searches when I name something it doesn't recognize, so most quips still land in a few seconds.


### It doesn't know what the intern asked

It gets what I'm building and the sentence I just said. Not the question.

The question was in there at first. I described a worker reclaiming a dead worker's job, which is a lease, and it called it a dead letter queue in 2 runs out of 5. The question had mentioned retries and failures and it answered that instead. Prompting it not to didn't work. Removing the question did.

Side effect: an answer like "yes" or "postgres" now gives it nothing to grab, so it stays quiet.


### Sonnet, not Haiku

Haiku got names wrong. Sonnet got that same lease case right 5 out of 5. Same wall time, since the latency is the round trip and not the model.

The name is the whole product. A wrong one is worse than nothing, I'd repeat it in an interview.

Thinking off, effort medium, no settings files. Defaults took ~25s per quip, slower than me typing the next answer, so quips showed up after I'd moved on. Now a few seconds. Skipping settings also keeps my CLAUDE.md from overwriting the wizard's personality.


### Measuring the wizard

```sh
npm run eval:wizard              # every case, 3 runs each
npm run eval:wizard -- 5 nudge   # 5 runs of the nudge cases
```

Fixed exchanges, a fresh wizard per run, every line printed. It covers naming a lease, nudging a wrong Rust range and float money, the idempotency practice line, a model newer than its training, and passing on a bare "yes". A prompt change isn't done until this reads right.


### idk

Not knowing the answer and not having the concept are different. I type `idk` and the wizard explains the concept, why it exists, and what teams argue about with it. Then it hands the question back without answering it. That concept goes on the tree as shaky.

I declare it. Nothing infers it.


### Enforced in code, not in the prompt

Mutating tools are denied until I approve the spec. v1 asked for this in the system prompt. On the first real run the intern skipped it, wrote two files, and printed "nothing was built".

Paths get checked on the way through too. `cwd` doesn't confine the agent - it wrote to `$HOME` while `cwd` was a scratch dir.

Held and refused tool calls render differently from ones that ran. After a build, the wizard reads what got written against the spec I approved and only speaks up if they don't match.


### Not done

Quips render inline, not in a real second pane. Every quip gets written to `.dum/wizard.jsonl`, so the pane is a reader over that file.

The tree is a printout. It should be a pane.

Nothing decays. A general skill I proved a year ago still counts as known.

Near-duplicates can still happen. The intern is told to reuse the tree's names, but "visibility timeout" and "SQS visibility timeout" could still end up as two nodes.

When the wizard searches, it mostly ends up passing. It doesn't deny new things anymore, but it doesn't say much about them either.


### Keys

| Key | Action | Where |
| :--- | :--- | :--- |
| `tab` | switch between the input and the file tree | anywhere |
| `?` + text | ask anything, answered off to the side without costing your turn | input |
| `idk` | "I don't have this concept", the intern teaches it | answering a question |
| `y` | approve the spec, anything else declines | spec |
| `ctrl-t` | swap the stage to the full transcript and back | anywhere |
| `j` / `k`, arrows | move | file tree |
| `h` / `l` | collapse / expand | file tree |
| `enter` / `o` | open the file (only you see it, the intern doesn't) | file tree |
| `g g` / `G` | top / bottom | file tree |
| `ctrl-d` / `ctrl-u` | half page down / up | file tree |
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


### Where things live

```
~/.dum/
  skills.json      the skill tree, shared by every repo (DUM_HOME moves it)

<repo>/.dum/
  session          so the next `dum` resumes the same intern
  wizard.jsonl     every quip
  debug.log        with DUM_DEBUG=1
  knowledge.json   the old per-repo record, folded into the tree once and left alone
```

Plain JSON, no database. The tree is written through a temp file and a rename, and re-read before every change, so two sessions in two repos don't erase each other's skills.

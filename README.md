# dum-intern

One intern. It builds what you can explain.

Agentic coding made it really easy for me to ship code I didn't understand. So I built an intern that interrogates me *before* it builds anything. Nothing reaches disk until I've approved a spec written out of my own answers.


### anti-vibe / understand everything

```sh
dum "print hello world in rust"       # anti-vibe (default)
dum -u "print hello world in rust"    # understand everything
```

The mode sets the level of abstraction I have to explain myself at, and everything else follows from that.

In anti-vibe I have to understand what I want and why, but not how. "Print hello world in rust" is a concept I obviously already hold, so the intern asks nothing and just builds it. It only stops me when the intent itself has a hole in it.

In understand-everything the same request is suddenly full of holes: what `println!` is, why it ends in `!`, what `fn main` returns. Same request, opposite amount of friction.

anti-vibe is the default on purpose. A tool that interrogates me over a one-line change is a tool I turn off in a week, and then it's protecting nothing.


### The intern asks, the wizard tells

There are two voices and nothing crosses between them. Every question comes from the intern, every statement comes from the wizard.

That sounds like a style rule but it's the thing that makes the wizard safe to have around. If the intern asks "what happens when a worker dies mid-job?" and the wizard jumps in with "most people use a visibility timeout", then I never actually decided anything. So the wizard only ever fires on an answer I already gave. It reacts to things I said, never to things I was asked, and the timing is what enforces it rather than me asking it nicely in a prompt.


### The wizard talks without being asked

```
  > another worker should pick it back up after a while if the first one dies

     │ 🧙 that's a visibility timeout - the mechanism SQS and most
     │    job queues use for exactly this failure case.
```

I don't summon this. When something I just said has interesting context attached, the wizard leans over and mentions it: the real name for the thing I described, what actually does it in industry, the shape everybody converges on.

I originally designed the wizard as a critic that would tell me when my idea was bad. That was worse. A criticism makes you stop and respond to it, so it can only fire rarely before it's annoying, and it only teaches me things I was already suspicious of. Fun facts cost nothing to ignore, so it can talk three times as often and still feel light. It also teaches me things without me having to admit I don't know them first, which matters because the whole problem is not knowing what I don't know.

Naming the thing is the most useful move it has. There's no search in here on purpose. The wizard's job is to hand me the search term.


### It doesn't know what the intern asked

The wizard gets told what I'm building and the one sentence I just said. It does not get told the question.

I put the question in at first, as context, and it made the wizard wrong. I described a worker reclaiming a dead worker's job, which is a lease, and it called it a dead letter queue in 2 runs out of 5 - because the *question* happened to mention retries and failures. It knew what a dead letter queue was. It was answering the wrong sentence. Telling it not to in the prompt didn't fix it, taking the question away did.

Dropping the question also got me specificity for free. An answer that means nothing on its own, like "yes" or "postgres", now gives the wizard nothing to grab onto, which is exactly when I want it quiet.


### Sonnet, not Haiku

One line of trivia per answer is the obvious place to use a small model, and I was wrong about that. Haiku got the names wrong. Sonnet got that same lease/dead-letter-queue case right 5 out of 5, and it costs nothing extra in wall time because the latency here is the round trip, not the model.

Getting the name right is the entire product. A wizard that's confidently wrong is worse than no wizard, because I'd carry the wrong word into an interview.

I also turned off thinking, dropped effort to medium, and stopped it loading any settings files. With the defaults a single quip took about 25 seconds, which is slower than me typing my next answer, so quips were landing after I'd already moved on. Now it's about 1.5 seconds. Turning off settings also keeps my own CLAUDE.md out of the wizard, since its whole personality is one short prompt and a personal instructions file would quietly overwrite it.


### idk

Answering a question and not having the concept are two different failures, and I say which one I'm in. I reply `idk` and the wizard explains the concept, why it exists, and what teams actually argue about with it - then hands the question back without answering it.

Nothing infers my ignorance. I declare it. A tool that punishes me for admitting I don't know something teaches me to stop admitting it.


### Two things are enforced in code, not in the prompt

Every mutating tool is denied until I approve the spec. The first version just asked for this in the system prompt, and on its very first real run the intern skipped the gate, wrote two files, and then printed "nothing was built". A gate that lives in a prompt is a suggestion.

Everything also stays inside the repo. Passing `cwd` does not actually confine the agent - in testing it wrote to `$HOME` while `cwd` was a scratch directory. So paths get checked on the way through instead.

Held and refused tool calls render differently from ones that ran. A denied write that looks like a successful one is a terminal that lies to me.


### Not done

The wizard isn't really off to the side yet. Quips render inline, just set in and narrower so I can tell at a glance which voice I'm allowed to ignore. Every quip already gets written to `.dum/wizard.jsonl`, so the real second pane is a reader over that file rather than a rewrite of this.

Nothing checks the build against the spec afterwards. The spec is a contract the intern is told to honor, not one that's verified.

Wizard lessons evaporate when the session ends, and a concept I needed explained once is one worth showing me again later.


### Running it

Needs Node 22.6+ and the `claude` CLI already logged in. There's no build step and no API key.

```sh
npm install
npm link      # puts `dum` on your PATH
cd some-repo
dum
```

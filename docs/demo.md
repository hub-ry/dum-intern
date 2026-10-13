# Showing Dum to someone

About ten minutes. The point to land is that Dum makes something real from what *you* taught it, lives on its own computer, and you can reach it from anywhere. Every step below is real; nothing is staged.

## Before they arrive

- Make sure the laptop is on the tailnet and `ssh hub` works.
- In Discord, open `#dum-now`. It should say **Idle**, and the goal you'll use should show up under Goals.
- Pick one small idea you actually understand and can explain in two or three sentences. Loops, conditions, and loops with conditions have the best built-in material.
- Restart the Claude desktop app once so its chat picks up the `dum` tools.

## 1. Start a goal (1 minute)

In `#dum`, run `/dum goal`. Give it a title like "Creature shelter" and an ambition like "a small interactive page where I can see my code make decisions".

The bot answers with a link to a new private channel. Open it and point at the channel topic: the ambition is there, along with the workshop link.

## 2. Teach it, by talking (2 minutes)

In the new channel, mention the bot and explain the idea in your own words:

> @dum-intern teach you: a loop goes through every creature in the list once, in order, and does the same thing for each one. if the list is empty it does nothing.

Dum replies, and a quoted record shows up in the channel. It went in right away because it's your exact words. Then show the contrast:

> @dum-intern can you teach yourself what a condition is?

It explains in chat but refuses to record its own explanation as yours. That rule is the whole point: Dum mirrors what you taught it, not what the model already knows.

## 3. Ask for a creation (30 seconds, then it works on its own)

> @dum-intern build something with that

Or run `/dum build`. Switch to `#dum-now`: the board shows **Making something for #creature-shelter**, with a live "started 20 seconds ago". Back in the goal channel, the status card moves through *queued → generating & verifying → ready*. All of that happens on hub: a real build in an offline sandbox with real screenshots. Nothing on the laptop is doing the work.

While it builds (a few minutes), show the other doors.

## 4. Same Dum, from Claude and the terminal (2 minutes)

- **Claude on the laptop:** "What is Dum building right now, and what have I taught it?" Claude calls `dum_overview` and `dum_goal` over SSH.
- **Approvals:** ask Claude to "teach Dum that a condition picks one of two paths". A card appears in Discord with **Yes, these are my words / Decline**, because Claude's paraphrase isn't yours until you say so. Decline it.
- **The terminal on hub:** `dum status` prints the same overview. Open omp or Codex and ask it the same question: the same tools, through MCP.

## 5. The payoff (2 minutes)

The bot pings: **Dum made something**, with screenshots in a gallery. Click **Read the presentation**. It's a page-by-page walkthrough with Dum's glyph, real screenshots and the matching code. Beside each page is the teaching of yours it used. At the bottom are the verification it passed and the supporting pieces the model added that you didn't teach. Flip through it with the arrow keys.

Then correct it:

> /dum correct creation: (pick it) correction: the empty list case should say "nobody to feed"

A new version builds. The original stays exactly as it was, and both are in the version history.

## If someone asks how it works

- **Hub** is a small Linux box at home. The workshop, the Discord bot and the schedules run there as user services, so the laptop can be closed.
- **Dum's chat** is Claude Code on hub with no shell and no files, only Dum's own tools.
- **MCP** lets any agent use Dum: Claude here, omp and Codex on hub. Agents hand each other work through a folder of plain markdown files, and Discord tells you when something needs you.
- **Teaching** is stored as your own words, and creations are built from it. Building doesn't retrain the model; your words are the context the build works from.

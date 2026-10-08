# Things to work on

The working list for Dum. Newest decisions win; `docs/architecture.md` holds the rules and `docs/circle-design.md` the contract for the circle redesign.

## UI changes (Ryan)

Add notes here while going through the app.

-

## Needs a real Mac

Built, but only Linux tests and CI smoke runs have exercised these. None has been seen working on a physical Mac.

- The circle's round hit region: clicks pass through its transparent corners, the 16 ms switch on pointer entry keeps up, and the first click reaches it without activating Dum.
- Pressing the circle never activates Dum, so focus return still knows the app you came from.
- Dragging the circle: smooth movement, release outside the disk, no stray click after a drag.
- Circle placement across displays: stable display ids after reconnecting, Retina and resolution changes, mirrored and negative-origin arrangements, a display removed while the window is open.
- The circle and the working window on every Space, over full-screen apps and in Mission Control, with no Dock icon; the window taking keyboard focus.
- Sleep and lock hiding the circle and bubble, and unlock bringing the circle back without activating Dum.
- VoiceOver finding the circle's button in its non-activating window and pressing it.
- Focus return: Esc, the Open Dum shortcut and ⌘W give focus back to the app you came from; switching apps yourself doesn't.
- Global shortcuts from another app: Open Dum focuses the message box, pressing it again hides the window, ⌘Q quits cleanly.
- Masking Dum's own windows out of real Retina captures, so an animating or dragged circle makes no look calls.
- Screen sharing hiding and restoring all three windows, including the circle.
- Open at login starting the circle and host without the window, and the first run opening the window at its goal question.
- Voice: push-to-talk through the OpenSuperWhisper bridge.
- The Screen Recording permission prompt and what happens when you deny it.
- The bubble over full-screen apps and on other Spaces.
- The API key stored through Keychain (`safeStorage`).
- The live look's 1280px capture: its size and PNG bytes on Retina displays.
- The changed-cells threshold under always-on look calls: whether a caret or clock stays under it, and how many calls a real hour makes.
- The live look's real cost per hour.
- The look status wording, including when an alias moves and pictures stop.
- Gatekeeper on first open of an unsigned build.
- Tuning the look's thresholds: changed cells, idle ticks and intervals are starting guesses.
- **Haiku picture check.** Pictures go only to a verified model, and the default look model `haiku` hasn't had its real picture call yet. It waits on an Anthropic API key at `~/.config/dum/anthropic-api-key`, which isn't there yet.

## Needs a real model

- The quality of goal alignment and decision cards: whether the reflection is right, the questions change the plan, and the options are worth choosing. Tests drive scripted models only.
- One real delegation end to end: outcome, alignment, a card, a handoff, Do this, the written file, the review.
- Debug chat answering "which look model is running?" from real diagnostics.

## Not built yet

- **Screen sharing has no smoke check.** Share → pick a screen → preview → send is unit-tested, but the real chooser and capture have never run end to end.
- **Moving a zone** to a new parent.
- **Focus skills for a zone**: in the data model, with no UI.
- **Adding or removing a skill from the Skills view**: today it's only the `:skill` command.
- **Sessions don't end on sleep or lock.** No host message carries those events yet, so a session runs on until 30 idle minutes pass.
- **A handoff doesn't name its target files.** `Handoff.targets` is always empty; the gate still checks every write.
- **The look status doesn't show the resolved model.** The host has no catalog lookup, so it's published as null.
- **The story has no usage total**, and a session whose record can't be read stops the story page with an error instead of being marked. Both need a contract field.
- **ChatGPT backend**: built, but switched off until its contract tests pass and one real call succeeds. ChatGPT uses Sign in with ChatGPT today; per "strictly api keys", switch it to an OpenAI API key before releasing it.
- **GitHub Copilot backend**: waits on a live check that its tools can be locked down.
- **A public release**: needs an Apple Developer ID and notarization. Today's builds are unsigned test artifacts from GitHub Actions.
- **Feynman Slides**: handing a session's story to Feynman Slides, later dum-slides, is for later. Nothing is built.

## Done

Checked by the test suite (569 tests pass, typecheck clean) on Linux, without a real Mac or a real model.

- The circle and one working window replaced the menu bar icon, the command bar and the panel (2026-10-08). Zones → Current context → Chat, with Settings, Skills, Records and the story inside Chat.
- Goal alignment per zone, including goal edits on a zone you're not in.
- Wizard decision cards with host-computed eligibility (can delegate now, learn first, needs a detail).
- Handoffs: choose, edit, refresh, Do this once, result with diffs, review. A review is never evidence.
- Sessions, trails with revisits and gaps, and the story cache with paging and rebuild, all owned by the host.
- Context corrections: ignore an observation, reload context, edit goal and notes.
- The minimal Settings list, and Mode, followed folders, the web tree and Pause moved to where they're used.
- Read-only debug chat over an in-memory diagnostics ring.
- The look skips Dum's own windows when counting changes and paints them out of frames.
- The Wizard no longer posts unprompted asides.
- API-key-only Claude, three model roles and the always-on look (before the circle work).

## Watch

- Claude's aliases can move. Dum verifies by the resolved model id, so a moved alias stops getting pictures until its new model passes a real call.

## Open questions

- The app keeps its warm amber theme, and the website is purple. Match them?
- The website has an empty video slot waiting for a walkthrough recording.

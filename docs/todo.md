# Things to work on

The working list for Dum. Newest decisions win; `docs/architecture.md` holds the rules.

## In progress

- **Always-on live look.** Dum looks at your screen while it's on, not just at app switches and typing pauses. Plan: a 1280px frame on every 3-second tick where the screen changed, sent to Claude Haiku 5.5. One call runs at a time, and old frames are never resent. Estimated cost: about $0.25 an hour, or about $5 a month at 5 hours a week. Haiku 5.5 must pass a real image call before Dum sends it pictures.

## UI changes (Ryan)

Add notes here while going through the app.

-

## Needs a real Mac

These are built, but only Linux and CI smoke tests have exercised them.

- Voice: push-to-talk through the OpenSuperWhisper bridge.
- Esc from the command bar puts focus back in the app you came from.
- The Screen Recording permission prompt and what happens when you deny it.
- The bubble over full-screen apps and on other Spaces.
- The API key stored through Keychain (`safeStorage`).
- Claude subscription sign-in (local builds).
- Launch at login.
- Gatekeeper on first open of an unsigned build.
- Tuning the look's thresholds: changed cells, idle ticks and intervals are starting guesses.

## Not built yet

- **Screen sharing has no smoke check.** Share → pick a screen → preview → send is unit-tested, but the real chooser and capture have never run end to end.
- **Moving a zone** to a new parent.
- **Focus skills for a zone**: in the data model, with no UI.
- **Adding or removing a skill from the Skills pane**: today it's only the `:skill` command.
- **ChatGPT backend**: built, but switched off until its contract tests pass and one real call succeeds.
- **GitHub Copilot backend**: waits on a live check that its tools can be locked down.
- **A public release**: needs an Apple Developer ID and notarization. Today's builds are unsigned test artifacts from GitHub Actions.

## Open questions

- The app keeps its warm amber theme, and the website is purple. Match them?
- The website has an empty video slot waiting for a walkthrough recording.

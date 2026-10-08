# Things to work on

The working list for Dum. Newest decisions win; `docs/architecture.md` holds the rules.

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
- The live look's 1280px capture: its size and PNG bytes on Retina displays.
- The changed-cells threshold under always-on look calls: whether a caret or clock stays under it, and how many calls a real hour makes.
- The live look's real cost per hour against the $0.25 estimate.
- No look call or frame while a Dum window is in front.
- The look status wording, including when an alias moves and pictures stop.
- Launch at login.
- Gatekeeper on first open of an unsigned build.
- Tuning the look's thresholds: changed cells, idle ticks and intervals are starting guesses.

## Not built yet

- **Screen sharing has no smoke check.** Share → pick a screen → preview → send is unit-tested, but the real chooser and capture have never run end to end.
- **Moving a zone** to a new parent.
- **Focus skills for a zone**: in the data model, with no UI.
- **Adding or removing a skill from the Skills pane**: today it's only the `:skill` command.
- **ChatGPT backend**: built, but switched off until its contract tests pass and one real call succeeds. ChatGPT uses Sign in with ChatGPT today; per "strictly api keys", switch it to an OpenAI API key before releasing it.
- **GitHub Copilot backend**: waits on a live check that its tools can be locked down.
- **A public release**: needs an Apple Developer ID and notarization. Today's builds are unsigned test artifacts from GitHub Actions.

## Watch

- Claude's aliases can move. Dum verifies by the resolved model id, so a moved alias stops getting pictures until its new model passes a real call.

## Open questions

- The app keeps its warm amber theme, and the website is purple. Match them?
- The website has an empty video slot waiting for a walkthrough recording.

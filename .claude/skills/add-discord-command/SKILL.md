---
name: add-discord-command
description: Add a new `/dum <sub>` slash subcommand to the Discord bot. Use when Ryan should be able to do something from Discord with a command, not by chatting with Dum.
metadata:
  version: "1.0.0"
---

# Add a /dum subcommand

## When to use

A new action Ryan triggers himself from a goal channel or the lobby. If Dum (the agent) needs the ability, add an MCP tool in `src/mcp/server.ts` instead. If the action needs more than ~2000 characters of text, it must open a modal.

## Files to touch

1. `src/discord/commands.ts` — declare the subcommand in `COMMANDS` (L17-66). One `{ type: 1, name, description, options? }` entry inside `options`. Copy `revisit` (L41-46): a `concept(...)` autocomplete option plus a required STRING with `max_length`. Option type constants are `STRING`/`INTEGER`/`BOOLEAN` (L11-13); a timer-style INTEGER with `min_value`/`max_value` is `schedule` (L58-63). Name and description go to Discord verbatim.

2. `src/discord/commands.ts` — pick visibility.
   - Reply only Ryan should see: add the name to `PRIVATE_COMMANDS` (L107). Otherwise the reply is posted in the channel as part of its record.
   - First answer is a form: add the name to `MODAL_COMMANDS` (L105). The bot defers every command not in this set (`src/discord/bot.ts` L482-487), and a deferred interaction cannot open a modal.

3. `src/discord/commands.ts` — handle it in `handle()` (L150).
   - Works without a goal (lobby or goal channel): add a `case` to the first `switch` (L171-200), like `goals` (L177-185).
   - Works on this channel's goal: add a `case` to the second `switch` (L205-286); `goalId` is already non-null there (L203). Copy `revisit` (L246-252): read options with `text("name")`/`opt("name")` (L168-169), refuse missing input with `say("...", { ephemeral: true })`, call `ctx.workshop.<method>(goalId, ...)`, answer with `say(...)` and `quote()` (L135) for anything Ryan typed.
   - Form-opening: copy `tried` (L238-245): return `modal(\`<kind>:${goalId}:<flag>\`, title, inputs)` (L126), then add a `kind === "<kind>"` branch in `submit()` (L290-332) after the goal check at L305. Values come from `val("custom_id")`.
   - Autocomplete on a new option name: add a branch in `choices()` (L334-361) keyed on `focused.name`.
   - `ctx` is `Context` (L98): `ownerId`, `guildId`, `lobbyId`, `links` (for `goalLink`/`jobLink` from `./delivery.ts`), `workshop`, `channels` (`goalFor`/`channelFor`/`open`, L68-75).

4. `src/client/workshop.ts` — if the command needs a workshop call that does not exist, add it to the `Workshop` type (L41-66) and its implementation in the same file, next to `revisit` (L52). The command layer never talks HTTP itself.

5. `README.md:53` — the "Use it" bullet lists subcommands. Add yours.

No change to `src/discord/bot.ts`: it PUTs `COMMANDS` at startup (L710) and routes every `INTERACTION_CREATE` through `handle()` (L713, L489).

## Test to add

File: `src/discord/discord.test.ts`. Helpers: `cmd(sub, options, { who, type, channel })` (L237) builds the interaction; `form(custom_id, values)` (L240) builds a modal submit; `ctx(calls)` (L198) is the fake `Context` whose workshop methods push a line like `` `studied ${GOAL} loops` `` into `calls`; `content(r)` (L244) reads the reply text. Channel `"GC"` is `GOAL`, `"OC"` is `OTHER_GOAL`, `LOBBY` is the lobby.

If you added a workshop method in step 4, add its fake to `ctx()` (L209-232) with the same `calls.push` pattern, or the test file will not typecheck.

Write one `test(...)` modelled on L338-346 (`studied`/`revisit`). It must prove, through `handle()`:
- the right workshop call happened with the goal from the channel: `assert.deepEqual(calls, [...])`;
- bad input is refused before any workshop call (`calls` stays empty) — like L323-329;
- for a modal command: the open reply is `type 9` with the expected `custom_id` (L293-300), and the submit records the fields.

If the command is goal-scoped, L256-264 already covers the lobby refusal via `build`; you don't need to repeat it. If you added it to `PRIVATE_COMMANDS`/`MODAL_COMMANDS`, extend L358-365 with one `isPrivate`/`opensModal` assertion.

Tests assert behaviour through `handle()` output, `calls`, or the refusal reply. Never assert on source text, on `COMMANDS` containing your name, or on exact copy of a success message beyond a short `assert.match`.

## Checks

- `npm run typecheck`
- `npm test`
- Manual (CONTRIBUTING.md L32): go live, then run the command once in a real goal channel and once where it should be refused, and read the reply in Discord. Commands register at startup, so going live is the delayed restart from `src/discord/agents.ts` L99: `systemd-run --user --on-active=20 systemctl --user restart dum-discord.service`. Never `systemctl restart` directly. Take `dum lock` first (L97) if you're working in the live checkout.

## Don't

- Don't bypass the owner/guild/channel gate (L151-155, L166); add cases only inside the two switches, never before them.
- Don't act on a goal other than the channel's: goal-scoped work goes in the second switch, forms carry `goalId` in `custom_id` and are checked at L305.
- Don't return a modal from a command that is not in `MODAL_COMMANDS`; Discord will reject it after the deferral.
- Don't let Ryan's text ping anyone: pass it through `quote()`, and keep `allowed_mentions: { parse: [] }` by always using `say()`.
- Don't write or rephrase Ryan's words into the workshop; commands record what he typed, verbatim.
- Don't call HTTP from `commands.ts`; the file stays pure so it can be tested without Discord.

# CLAUDE.md

Dum: a learning companion on Ryan's server "hub". Ryan teaches it concepts; it builds a verified HTML/JS creation and presents it. TypeScript, Node 24, no framework. Read [README.md](README.md) once for the shape and [CONTRIBUTING.md](CONTRIBUTING.md) for product rules. This file is what an agent must not break.

## Invariants

Never violate these. A PR that does is wrong even if tests pass.

1. **Generated JavaScript never runs in the host Node process.** Creations run only inside the Docker/Playwright verifier (`src/workshop/publisher.ts` `verify()`, `src/workshop/publisher-verifier.mjs`) with `--network none`, and in sandboxed iframes in the browser. The host reads `report.json` and PNG bytes, nothing else.
2. **Artifacts stay on a separate origin.** App on 8770, artifacts on 8771 (`src/workshop/server.ts`). Never serve generated pages from the app origin, never add auth or an API to the artifact server.
3. **No secrets in model context.** Never read, print, or paste `~/.config/dum-workshop/environment`, `~/.config/dum-discord/environment`, the Discord token file, the gh token, or the Brightspace/Outlook keyring session. Build prompts carry goal context and teaching only. `dum ship` refuses credential-shaped lines; don't work around it.
4. **Records are single-writer and atomic.** The workshop store owns `~/.local/state/dum-workshop`; one process holds `owner.lock` (`src/workshop/files.ts`, flock-guarded). Discord and MCP go through the workshop HTTP API, never the files. Mail-code sides each write only their own ledger file.
5. **Ryan's words are immutable and only he records them.** Teaching and attempts enter through an approval request (`ask()` in `src/mcp/server.ts`) or verbatim Discord commands. Never paraphrase them, never invent activity, never add a second path that records them, not even in test fixtures.
6. **Verification is Docker/Playwright only, and failed builds stay failed.** No fabricated results, no retries that mask a failure, no "ready" without a real report. Corrections create versions; originals are never overwritten.
7. **Reading a prepared presentation needs no model call.**
8. **The public server exposes nothing private.** `src/public/server.ts` serves only the explicit public tree. Notes are published on purpose, never exported from learning history.
9. **A Workday application is submitted only for Ryan's signed approval.** The worker (`src/workday/`, in the `workday` VM) presses Submit only for an Ed25519 approval the Discord bot signs when Ryan presses Submit on the card (`src/workday/approval.ts` `decideSubmit`), bound to that page and used once. Never add another path that signs or submits, never give the Workday agent a general browser, JavaScript, files or navigation outside the allowlist, and never let a vault value into a tool result, a request file or a screenshot.

## Commands

```sh
npm ci
npm run typecheck        # tsc --noEmit
npm test                 # node --test, every test process under a throwaway HOME
docker build -f src/workshop/publisher.Dockerfile -t dum-workshop-browser:1 .
```

CI runs typecheck and test on every PR (`.github/workflows/ci.yml`). No live model calls in tests, ever.

## Running anything locally

`npm test` preloads `src/shared/test-isolation.ts`: every test process gets a fresh temp `HOME`, `DUM_WORKSHOP_HOME` and state dirs, and every inherited `DUM_*` variable is dropped. You don't need to set anything for tests.

Anything else that starts the workshop (`npm start`, `npm run dev`, a throwaway script, a real isolated build) MUST set `DUM_WORKSHOP_HOME` to a temp dir and a free `DUM_WORKSHOP_PORT`/`DUM_WORKSHOP_ARTIFACT_PORT`. The default home is owned by `dum-workshop.service` on hub; a second process gets a 409 from the owner lock at best, and corrupts a build at worst.

```sh
DUM_WORKSHOP_HOME=$(mktemp -d) DUM_WORKSHOP_PORT=18770 DUM_WORKSHOP_ARTIFACT_PORT=18771 npm start
```

Never run `dum live *`, never restart a service directly. If a change needs a restart, schedule it: `systemd-run --user --on-active=20 systemctl --user restart dum-workshop.service` (or `dum-discord.service`), and only after typecheck and tests pass.

## Module map

| Dir | Owns | Entry |
|---|---|---|
| `src/workshop` | State store, HTTP API + reader UI, artifacts, generation (`claude -p`), Docker verifier, public notes, shares | `server.ts` |
| `src/client` | The only client of the workshop API (`workshopClient`), used by discord/mcp/cli | `workshop.ts` |
| `src/discord` | Bot, `/dum` slash commands, chat routing to tutor/librarian/engineer/mailcode agents, approvals, delivery | `bot.ts`, `commands.ts`, `agents.ts` |
| `src/mcp` | `dum_*` tools (`TOOLS` array + handler map), Codex tool | `server.ts` |
| `src/cli.ts` | The `dum` command: mcp, codes, live, ship, lock | |
| `src/context` | Root context composition, `scrub` | `root-context.ts` |
| `src/shared` | Clock (Indiana time), repo lock, handoffs, approval requests, file posts, `dum ship`, test isolation | |
| `src/mailcode` | Outlook read-only tools, code ledger and log, mail agent | |
| `src/live`, `src/internship`, `src/gpa` | Screen streaming, internship watch, GPA reminders (systemd timers) | |
| `src/workday` | Workday application worker: allowlisted browser, vault placeholders, the submit approval gate (runs in the `workday` VM); hub side: `dum workday-mcp`, the Workday agent, jobs | `worker.ts`, `serve.ts`, `mcp.ts` |
| `src/site`, `src/public` | Public site and the dependency-free static server | |
| `src/nightly` | Nightly main check and weekly draft-only issue triage, in their own clone (`deploy/dum-nightly.*`, `deploy/dum-triage.*`) | `check.ts`, `triage.ts` |
| `deploy/` | systemd user units. Agents don't edit these without being asked. | |

Dependencies point inward: discord/mcp/cli → client → workshop API. Nothing imports the store except the workshop.

## Tests

Tests live beside the code (`src/<module>/*.test.ts`); a new module dir must be added to the `test` glob in `package.json`. Assert behaviour through the public interface: handler output, state in the temp dir, the HTTP status, the thrown error. Never assert source strings, prompt wording, descriptions, or wiring. Tests that pin wording are deleted, not updated.

Manual exercise is still required for anything with a surface (CONTRIBUTING.md "Verification"): the browser for UI, one real isolated generation for publisher changes, a scheduled service restart for persisted-state changes.

## Skills

`.claude/skills/`: `add-mcp-tool`, `add-discord-command`, `add-verifier-check`, `dum-publish`. Read the matching one before touching that surface.

## How agents work on this repo

[docs/agent-workflow.md](docs/agent-workflow.md): architect / implementer / reviewer roles, one issue per branch per worktree, what runs unattended on hub. Commits are Ryan's (`hub-ry`): no AI author, no `Co-Authored-By`, no force push.

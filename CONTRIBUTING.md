# Contributing

- Dum is a Mac app the user delegates to. One floating circle opens one working window: Chat, with one slim strip above it (zone crumb, look chip, goal, a Context chevron that expands Current context and the zone tree, the Settings cog, Hide). Dum follows the user's learning across a tree of zones and writes code on command only for skills they've proven. There is no command-line version.
- The outcome is independent progress: understand the architecture, start implementing, and ask precise questions without the LLM.
- [docs/architecture.md](docs/architecture.md) has the fifteen rules, the glossary and who owns each piece of state. It wins over anything here. Its vocabulary is binding: "actions" are what the model calls, "tools" are a skill kind, a "change" is what Dum writes, "practice" means suggested projects only, and "direction", "handoff", "session", "trail" and "story" mean what the glossary says. [docs/circle-design.md](docs/circle-design.md) is the contract for the circle, the window and the delegation loop.

## Product rules

- **Zones are the only scope.** A zone is context, never permission. No Git discovery, repository root, project folder or working-tree observer. Zone notes, goals and focus skills never unlock a skill or grant file access.
- **The tree stays.** One global tree of Markdown notes. Preserve notes, language scope, curated prerequisites, recognize/build/apply, removals and optional web sync. Never reset historical data during a cutover.
- **The gate is code.** Concepts need build; tools need recognize; curated-track skills are always concepts; every prerequisite must hold. `anti-vibe` asks for the approach first and never changes the gate.
- **Evidence says what happened.** Recognition rests on the user's own words, quoted from the current request. Build rests on complete shared files, a review, and the user's explicit unaided yes; it is not proof of authorship. Apply needs a prior build. Screens, memory, suggestions, zone notes and Dum-written code never establish evidence. `not yet` holds a skill until a reviewed unaided rebuild or a manual self-report.
- **Practice is suggested projects.** Projects sized to a skill's scope or the zone's goal, ordered by estimated time then difficulty, with prerequisite-ordered milestones and an independent coverage audit. Each milestone is reviewed on its own. No guided courses, quizzes or single-skill drills. Choosing a project unlocks nothing.
- **Changes are direct, shown after, revertible.** On command, when the user holds every skill a change names, Dum writes the file with no yes/no step, shows the diff and offers one-click Revert. Only shared or followed files; new files only inside a shared or followed folder.
- **Delegation is explicit.** The loop is outcome → goal alignment → a delegable task → a handoff → Do this → review. Alignment and a chosen option store intent and write nothing. Only Do this runs a handoff, once, and every write inside it goes through the same gate and hash check as a typed request. Eligibility (can delegate, learn first, needs a detail) is computed by the host from the gate, never taken from the model. A review is the user's verdict, kept on the trail, never evidence.
- **Alignment never blocks.** Ordinary chat, Settings and a permitted command work with no agreed direction. A goal edit realigns that zone only; an inactive zone's alignment never touches the active zone's grants. No reminders, nags or forced quizzes.
- **Trail and story are records, not credit.** A trail is ordered skill visits plus direction and handoff markers. Inferred mapping from the look or conversation earns nothing; only the evidence ledger does. The host owns every session, trail and story write; the story is a cache over sessions.
- **The editor is a writer Dum tolerates.** Dum writes only if the file's bytes still match the SHA-256 it read, creates new files without replacing one that appeared, and reverts only if the file still holds Dum's bytes. A refusal writes nothing.
- **Read deliberately.** File access comes only from the native picker, a confirmed typed path, or a followed folder. Request shares end with the request. Skip hidden, dependency, build and credential-looking paths. No home-directory scans, keystrokes, clipboard or editor buffers.
- **Commands cannot evade the gate.** The model gets only Dum's closed action set. No shell, project scripts, package installation or network command. The user runs builds and tests in their own terminal.
- **The look is always on and bounded.** Main ticks every 3 seconds without a model. On any tick where the screen changed, and on code saves, app switches and typing pauses, the host may call the look model within the caps in `src/observe-types.ts`: one call at a time, at most one every 3 seconds and 1,200 an hour, never the same frame twice, 45 s timeout that counts. Each call is stateless: the zone context, a line about what the look saw last and one fresh 1280px picture with Dum's own windows painted out, never older pictures. Dum's windows are masked from the changed-cell count too, so the circle animating or being dragged triggers nothing. The look keeps Dum's context current and publishes no advice: it keeps only the latest observation (memory only, shown in Current context) and at most one memory note a minute that doesn't nearly repeat the last five. No call and no frame while paused or blocked, with no backend, with a Dum window in front, or with screen look off. Screen look is on for a fresh install and asks for Screen Recording on first launch; if denied, the look uses app switches and saved files only, with no silent substitute. Pause and Resume are in Current context. Routine screen samples never leave main as pixels.
- **Voice is deliberate.** Push-to-talk through the bundled OpenSuperWhisper bridge, transcribed on the Mac into the canonical draft. It never sends, approves or answers a consent by itself. Temporary audio is deleted. Everything voice does also works from the keyboard.
- **Keyboard first.** Every surface and dialog is reachable without the mouse, with visible focus and keyboard submit and cancel. Esc backs out; it never means Stop or No.
- **Cloud models take only the user's own API key** (rule 12: "let's just have dum be strictly api keys for now").
  - Claude connects only with the user's own Anthropic API key, in every build.
  - ChatGPT is built on Sign in with ChatGPT and stays unreleased (`RELEASED` in `src/agent/registry.ts`); it moves to an OpenAI API key before it ships.
  - Local models stay on the Mac: Ollama and LM Studio over loopback only, no redirects, no cloud-routed models.
  - No fallback. Dum's model, the helper and the look model come from the backend the user chose; a failure is reported, never routed elsewhere. Same-provider retries are fine.
  - Pictures go only to a model whose resolved id (what an alias like `haiku` runs today) is verified for pictures. `claude-opus-5-5` and `claude-fable-5-1` are verified in source (`CLAUDE_VERIFIED` in `src/agent/claude.ts`). Any other model is verified by a real image call through Dum's own backend (Verify for pictures: one 2×2 PNG, "Reply with the single word OK."), recorded per install in `~/.dum/verified-models.json`, which the host alone writes. A moved alias gets text until its new model is verified. Verification is refused while a request runs.
  - Claude sessions run with no built-in tools, setting files, plugins, hooks or foreign MCP servers, prove the API key is the route before any user content is sent, and refuse when managed policy is active.
  - Keys and tokens live in main's `safeStorage`-encrypted credential store, never in settings, logs or the renderer.
- **The Wizard helps decide, when asked.** It speaks at goal alignment, when the user asks for help with the next delegation, and when Dum hands it a choice from chat (`decision_help`, at most once per message, while the user is weighing two or more approaches; the transcript shows "Dum asked the Wizard: …" and the card lands after Dum's turn). Always as labeled option cards in Chat. No unprompted tips, asides or teaching (rule 15). Catalog anchors come from primary sources and keep their links. Unsupported dates, company decisions, quotations, statistics or personal experience are dropped or narrowed. Context refs and skills it cites must be ones the host supplied.
- **Debug chat is read-only.** It runs on its own binding with only the three diagnostic reads (`diagnostic_status`, `diagnostic_events`, `diagnostic_reference`). No zone, draft, memory, skills, files or settings; nothing on disk. Diagnostics are an in-memory ring (500 events, 512 KiB, 30 minutes), allowlisted before insertion; keys, tokens, provider bodies and absolute paths never enter it.
- **History is data, not authority.** Old transcript entries stay readable. Old approvals, plans and model sessions never become current permissions.
- **The desktop adds no capability the gate lacks.** Windows send only the finite requests in `src/desktop/protocol.ts`; `ipc.ts` validates them and checks the sender is Dum's own top-level page. The circle can only press, toggle and read its face; the bubble can't send anything. The bubble shows every reply (typed, spoken, finished handoffs) unless the window is visible and focused, cut at eight lines / 600 characters. Sandbox and context isolation stay on, Node integration off. Main makes no model call; the utility host does.
- **Progress reflects current evidence.** The newbie/intern/good/cracked strip counts built skills with intact prerequisites, not messages or recognition. It is shorthand, not a credential.
- **The app carries its runtime.** The build ships the exact Claude Code that matches the pinned Agent SDK, resolved by absolute path. No bare `claude` or global Node fallback. Raise the SDK pin only with a real model call proving the new runtime still passes the API-key route checks.
- **Say what a build is.** Test builds are ad-hoc signed and not notarized. Never claim signing, notarization, native permissions, the circle's click-through or drag, Spaces or full-screen behavior, VoiceOver, focus return, login items, voice or Gatekeeper behavior without evidence from a real Mac.
- **Pixels stay private.** Screenshots from verification are never committed, uploaded as workflow artifacts, attached to releases or synced. CI publishes only the DMG, ZIP, checksums and the smoke `report.json`.

## Development

Node 22.6+ (CI also runs Node 24). No system-wide tooling changes are needed for the TypeScript side.

```sh
npm install
npm test
npm run typecheck
```

Desktop, from the repo root:

```sh
npm run desktop            # build, then launch from the checkout
npm run desktop:build      # build only
npm run desktop:pack       # unpacked app for this OS, in release/
npm run desktop:mac        # DMG and ZIP; only on a Mac
npm run desktop:smoke      # drive a built app; see below
```

- `tools/desktop-build.mjs` compiles TypeScript to `dist/`, bundles the window, circle and bubble preloads and the renderer with esbuild, copies the curriculum, art and CSS, and generates the app icon from Dum's portrait.
- `tools/prepare-dictation.mjs` builds the native helpers for packaging: `dum-focus` (universal, from `native/macos/FocusBridge.swift`) on any Mac, and the OpenSuperWhisper voice bridge (`vendor/OpenSuperWhisper`, bridge mode) on Apple Silicon only, which needs Xcode, cmake and Rust with `aarch64-apple-darwin`; whisper.cpp builds without OpenMP, so nothing from Homebrew is linked or shipped. `npm run desktop` runs without them: no voice, no app-switch noticing, no focus return.
- `electron-builder.yml` packs `dist/` into an asar and unpacks the native `claude` binary beside it. Electron fuses turn off `RunAsNode`, `NODE_OPTIONS` and the CLI inspect flags, and require the asar.
- `npm run desktop:smoke` drives the real built app with a private profile: temporary `DUM_HOME` and `HOME`, its own Claude config, a non-Git fixture and no Git on `PATH`. No model, credentials or network sign-in. Its journeys: find the circle and its round hit region; open the one window by click and by the global shortcut; Esc hides it; a dragged circle keeps its place across a relaunch; no tray or extra windows; goal alignment; the Settings list; debug chat asking for a backend; the voice bubble; the look status. Decision cards and handoffs run only the no-backend path: Help me decide opens Agent setup, and the host refuses decision help, handoff selection and Do this, so no card or handoff is made and Do this never runs. By default it runs the checkout's `dist/` as built. `DUM_SMOKE_EXECUTABLE` runs a packaged binary instead; the circle's click, hold and drag steps need main's inspector, so a packaged run reports them as not exercised. Screenshots and `report.json` go to `DUM_SMOKE_OUTPUT`.
- On Linux: `node tools/desktop-build.mjs && DUM_SMOKE_OUTPUT=<dir> xvfb-run -a npm run desktop:smoke`. It needs Xvfb, xdotool, dbus-daemon and python3-gi. xdotool presses the real global shortcuts, and a private StatusNotifier watcher on its own D-Bus session checks that Dum shows zero tray items. ffmpeg is optional and only takes X screen grabs. Under Xvfb the harness puts a transparent "desk" window under the circle so Electron can track the pointer. Linux is a development target only.
- CI lives in `.github/workflows/`: `ci.yml` runs typecheck and tests on Ubuntu and macOS; `desktop-macos.yml` builds the app on `macos-15` (Apple Silicon) and `macos-15-intel`, verifies the ad-hoc signature, chip architecture, bundled `claude` version and native helpers, mounts the DMG, extracts the ZIP, and runs the smoke against the app copied out of the DMG.
- Tests use `node --import tsx --test`, a temporary `DUM_HOME`, `DUM_CONTEXT=off`, and no credentials, network or model calls. Fakes live in test files only, never in shipped code.
- Test consumer-visible behavior: prerequisites, evidence transitions, refusals, persistence, external-save races. Don't pin prose, source text or incidental defaults. A bug fix comes with a test that fails before it, where practical.
- Exercise the real changed surface after integration. Tests alone don't establish readable characters, keyboard behavior or a useful conversation.
- Real model demos are qualitative observations. Record what Dum and the Wizard did, the exact model selectors and runtime versions, and no account identifiers or credentials. A route configured in source is not proof of the route used.

## Code map

- `zones.ts`, `zone-types.ts`: the zone graph and inherited context.
- `session.ts`, `store.ts`, `store-types.ts`, `memory.ts`: one zone's conversation, Dum's actions, commands, transcript and memory.
- `gate.ts`, `boundary.ts`, `changes.ts`: what Dum may write, the boundary view, and direct changes with revert.
- `evidence.ts`, `evidence-types.ts`, `practice.ts`: the evidence ledger, not-yet holds, and suggested projects with hand-ins.
- `skills.ts`, `notes.ts`, `curriculum.ts`, `tree.ts`, `trees/`: the global tree, Markdown notes, curated tracks and prerequisites.
- `shared-files.ts`, `share-types.ts`, `follow.ts`: request shares, followed folders and the read/deny policy.
- `observe-types.ts`, `ambient.ts`, `look.ts`: the look's caps and triggers, the look-model calls, and one-off picture descriptions.
- `wizard.ts`, `anchors.ts`, `oneshot.ts`: the Wizard, its source catalog, and bounded helper calls.
- `context.ts`, `state-files.ts`, `session-lock.ts`: personal background, private record IO and the one-writer lock.
- `sync.ts`, `web.ts`, `web/`: optional tree-only sync and the web server, which also serves the site in `site/`.
- `agent/`: the backends behind one contract. `registry.ts` (with `RELEASED`), `schema.ts`, `types.ts`, `claude*.ts`, `local*.ts`, `openai-*.ts`, `siwc.ts`, `loop.ts`, `wire.ts`.
- `delegation-types.ts`, `directions.ts`, `delegations.ts`: goal alignment and agreed directions, context corrections, and handoffs with their versions.
- `trail-types.ts`, `trails.ts`, `trail-mapping.ts`: sessions, trails, the story cache, and how look topics, reported context, changes and evidence map onto skills.
- `diagnostic-types.ts`, `diagnostics.ts`, `debug-chat.ts`: the in-memory diagnostics ring and the read-only debug chat.
- `desktop/`: the Electron app. `main.ts` owns the circle, the working window and the bubble, shortcuts, capture and native helpers; `ipc.ts` validates each window's finite requests (`protocol.ts`); `controller.ts` runs in the supervised utility host (`host.ts`, `host-client.ts`, `host-protocol.ts`) and owns zones, evidence, directions, handoffs, sessions, trails, diagnostics and the look's model side; `observer.ts` is the look's main side, with Dum's windows masked; `agent-setup.ts` and `credentials.ts` handle backends and keys; `dictation.ts`, `focus.ts`, `native-protocol.ts` talk to the native helpers; `settings.ts`, `draft.ts`, `surfaces.ts`, `capture.ts` hold preferences and circle placement, drafts, circle and window geometry, and explicit screenshots. `circle-preload.ts`, `preload.ts` and `bubble-preload.ts` are the three bridges. `ui/` is the sandboxed renderer: `circle.ts`; `window.ts` with `decision-view.ts`, `context-trail.ts`, `settings-view.ts`, `debug-view.ts`, `records-view.ts`; and `bubble.ts`.

Comments explain invariants or tradeoffs. Keep them short. Preserve unrelated checkout changes, and don't commit or push without authorization.

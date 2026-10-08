# Contributing

- Dum is a Mac app that stays on in the menu bar, follows the user's learning across a tree of zones, and writes code on command only for skills they've proven. There is no command-line version.
- The outcome is independent progress: understand the architecture, start implementing, and ask precise questions without the LLM.
- [docs/architecture.md](docs/architecture.md) has the twelve rules, the glossary and who owns each piece of state. It wins over anything here. Its vocabulary is binding: "actions" are what the model calls, "tools" are a skill kind, a "change" is what Dum writes, and "practice" means suggested projects only.

## Product rules

- **Zones are the only scope.** A zone is context, never permission. No Git discovery, repository root, project folder or working-tree observer. Zone notes, goals and focus skills never unlock a skill or grant file access.
- **The tree stays.** One global tree of Markdown notes. Preserve notes, language scope, curated prerequisites, recognize/build/apply, removals and optional web sync. Never reset historical data during a cutover.
- **The gate is code.** Concepts need build; tools need recognize; curated-track skills are always concepts; every prerequisite must hold. `anti-vibe` asks for the approach first and never changes the gate.
- **Evidence says what happened.** Recognition rests on the user's own words, quoted from the current request. Build rests on complete shared files, a review, and the user's explicit unaided yes; it is not proof of authorship. Apply needs a prior build. Screens, memory, suggestions, zone notes and Dum-written code never establish evidence. `not yet` holds a skill until a reviewed unaided rebuild or a manual self-report.
- **Practice is suggested projects.** Projects sized to a skill's scope or the zone's goal, ordered by estimated time then difficulty, with prerequisite-ordered milestones and an independent coverage audit. Each milestone is reviewed on its own. No guided courses, quizzes or single-skill drills. Choosing a project unlocks nothing.
- **Changes are direct, shown after, revertible.** On command, when the user holds every skill a change names, Dum writes the file with no yes/no step, shows the diff and offers one-click Revert. Only shared or followed files; new files only inside a shared or followed folder.
- **The editor is a writer Dum tolerates.** Dum writes only if the file's bytes still match the SHA-256 it read, creates new files without replacing one that appeared, and reverts only if the file still holds Dum's bytes. A refusal writes nothing.
- **Read deliberately.** File access comes only from the native picker, a confirmed typed path, or a followed folder. Request shares end with the request. Skip hidden, dependency, build and credential-looking paths. No home-directory scans, keystrokes, clipboard or editor buffers.
- **Commands cannot evade the gate.** The model gets only Dum's closed action set. No shell, project scripts, package installation or network command. The user runs builds and tests in their own terminal.
- **The look is always on and bounded.** Main ticks every 3 seconds without a model; the host calls the helper only when something changed and settled, within the caps in `src/observe-types.ts`. Screen look is on for a fresh install and asks for Screen Recording on first launch; if denied, the look uses app switches and saved files only, with no silent substitute. Pause is one click in the tray, the panel and Settings. Routine screen samples never leave main as pixels. Frames go to the helper only on a trigger.
- **Voice is deliberate.** Push-to-talk through the bundled OpenSuperWhisper bridge, transcribed on the Mac into the canonical draft. It never sends, approves or answers a consent by itself. Temporary audio is deleted. Everything voice does also works from the keyboard.
- **Keyboard first.** Every surface and dialog is reachable without the mouse, with visible focus and keyboard submit and cancel. Esc backs out; it never means Stop or No.
- **Who powers Dum follows each provider's rules.**
  - Public builds connect Claude only with the user's own Anthropic API key and never offer, accept or run Claude subscription sign-in.
  - Local builds, made from source for the owner, may also sign in with a Claude subscription through the bundled Claude Code.
  - ChatGPT connects only through Sign in with ChatGPT, and ships only once its release gate (`RELEASED` in `src/agent/registry.ts`) is met.
  - Local models stay on the Mac: Ollama and LM Studio over loopback only, no redirects, no cloud-routed models.
  - No fallback. Dum's model and the helper come from the backend the user chose; a failure is reported, never routed elsewhere. Same-provider retries are fine.
  - Claude sessions run with no built-in tools, setting files, plugins, hooks or foreign MCP servers, prove the chosen sign-in method before any user content is sent, and refuse when managed policy is active.
  - Keys and tokens live in main's `safeStorage`-encrypted credential store, never in settings, logs or the renderer.
- **Wizard claims need support.** Catalog anchors come from primary sources and keep their links. Unsupported dates, company decisions, quotations, statistics or personal experience are dropped or narrowed. Silence is allowed. Never reveal a project solution to make an aside useful.
- **History is data, not authority.** Old transcript entries stay readable. Old approvals, plans and model sessions never become current permissions.
- **The desktop adds no capability the gate lacks.** Windows send only the finite requests in `src/desktop/protocol.ts`; `ipc.ts` validates them and checks the sender is Dum's own top-level page. Sandbox and context isolation stay on, Node integration off. The bubble can't send anything. Main makes no model call; the utility host does.
- **Progress reflects current evidence.** The newbie/intern/good/cracked strip counts built skills with intact prerequisites, not messages or recognition. It is shorthand, not a credential.
- **The app carries its runtime.** The build ships the exact Claude Code that matches the pinned Agent SDK, resolved by absolute path. No bare `claude` or global Node fallback. Raise the SDK pin only with a real model call proving the new runtime still passes the sign-in checks.
- **Say what a build is.** Test builds are ad-hoc signed and not notarized. Never claim signing, notarization, native permissions, Spaces or full-screen behavior, focus return, login items, voice or Gatekeeper behavior without evidence from a real Mac.
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
npm run desktop            # local-flavor build, launched from the checkout
npm run desktop:build      # local-flavor build only
npm run desktop:pack       # public-flavor unpacked app for this OS, in release/
npm run desktop:mac        # public-flavor DMG and ZIP; only on a Mac
npm run desktop:mac-local  # local-flavor DMG and ZIP; only on a Mac
npm run desktop:smoke      # drive a built app; see below
```

- `tools/desktop-build.mjs` needs `--flavor public|local`. It compiles TypeScript to `dist/`, bundles both preloads and the renderer with esbuild, copies the curriculum and art, generates the app icon from Dum's portrait, and writes `dist/desktop/build-info.json`. Main reads the flavor from there; missing or invalid means public.
- `tools/prepare-dictation.mjs` builds the native helpers for packaging: `dum-focus` (universal, from `native/macos/FocusBridge.swift`) on any Mac, and the OpenSuperWhisper voice bridge (`vendor/OpenSuperWhisper`, bridge mode) on Apple Silicon only, which needs Xcode, cmake and Rust with `aarch64-apple-darwin`; whisper.cpp builds without OpenMP, so nothing from Homebrew is linked or shipped. `npm run desktop` runs without them: no voice, no app-switch noticing, no focus return.
- `electron-builder.yml` packs `dist/` into an asar and unpacks the native `claude` binary beside it. Electron fuses turn off `RunAsNode`, `NODE_OPTIONS` and the CLI inspect flags, and require the asar.
- `npm run desktop:smoke` drives the real built app through the zones journey with a private profile, `DUM_HOME`, `HOME` and Claude config, a non-Git fixture and no Git on `PATH`. No model, account or network sign-in. By default it runs the checkout's `dist/` as built, then the same output staged as public flavor. `DUM_SMOKE_EXECUTABLE` runs a packaged binary instead. Screenshots and `report.json` go to `DUM_SMOKE_OUTPUT`.
- On Linux run it as `xvfb-run -a npm run desktop:smoke`. It needs Xvfb, xdotool, dbus and python3-gi: xdotool presses the real global shortcuts and a private D-Bus session receives the tray icon. Linux is a development target only.
- CI lives in `.github/workflows/`: `ci.yml` runs typecheck and tests on Ubuntu and macOS; `desktop-macos.yml` builds the public-flavor app on `macos-15` (Apple Silicon) and `macos-15-intel`, verifies the ad-hoc signature, chip architecture, bundled `claude` version and native helpers, mounts the DMG, extracts the ZIP, and runs the smoke against the app copied out of the DMG.
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
- `observe-types.ts`, `ambient.ts`, `look.ts`: the look's caps and triggers, and one-off picture descriptions.
- `wizard.ts`, `anchors.ts`, `oneshot.ts`: the Wizard, its source catalog, and bounded helper calls.
- `context.ts`, `state-files.ts`, `session-lock.ts`: personal background, private record IO and the one-writer lock.
- `sync.ts`, `web.ts`, `web/`: optional tree-only sync and the web server, which also serves the site in `site/`.
- `agent/`: the backends behind one contract. `registry.ts` (with `RELEASED`), `schema.ts`, `types.ts`, `claude*.ts`, `local*.ts`, `openai-*.ts`, `siwc.ts`, `loop.ts`, `wire.ts`.
- `desktop/`: the Electron app. `main.ts` owns windows, tray, shortcuts, capture and native helpers; `ipc.ts` validates the renderer's finite requests (`protocol.ts`); `controller.ts` runs in the supervised utility host (`host.ts`, `host-client.ts`, `host-protocol.ts`) and owns zones, evidence, sessions and the look's model side; `observer.ts` is the look's main side; `agent-setup.ts`, `credentials.ts`, `build-info.ts` handle backends, keys and flavor; `dictation.ts`, `focus.ts`, `native-protocol.ts` talk to the native helpers; `settings.ts`, `draft.ts`, `surfaces.ts`, `capture.ts` hold preferences, drafts, window placement and explicit screenshots. `ui/` is the sandboxed renderer: panel, command bar and bubble.

Comments explain invariants or tradeoffs. Keep them short. Preserve unrelated checkout changes, and don't commit or push without authorization.

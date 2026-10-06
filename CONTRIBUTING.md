# Contributing

- Dum is a Mac desktop companion beside the user's IDE, with the original terminal edition kept as development infrastructure. The user learns by teaching a capable beginner while building real software.
- The outcome is independent progress: understand the architecture, start implementing, and ask precise questions without the LLM.
- The recalled chess story is inspiration, not verified research or evidence that this app improves learning.

## Product rules

- **The cast stays.** Dum proposes concrete approaches, asks focused questions at meaningful decisions, remembers guidance, and uses it. No staged mistakes, trivia quizzes, or repeated questions the user has answered. The wizard is selective, brief, and grounded.
- **The tree stays.** Preserve notes, language scope, curated prerequisites, recognize/build/apply, removals, and optional web synchronization. Never reset historical data during a cutover.
- **The gate is code.** Concepts require build evidence; tools require recognition. The project's core stays the user's in both modes. `anti-vibe` changes coaching, not the implementation boundary.
- **Evidence says what happened.** Explanations establish recognition. A reviewed saved artifact plus an explicit unaided self-report can establish build, but is not proof of authorship. Apply requires prior build. Memory, suggestions, plan acceptance, and displayed courses never establish implementation ability.
- **Practice returns to the project.** Offer available next steps, not locked prerequisites disguised as an exercise. Let the user leave, implement in an ordinary file, return for a meaningful check, and continue. Courses are optional; a small guided gap is not independent build evidence.
- **Read deliberately.** Acquire bounded context from explicitly requested project files or changes. No keystroke streaming, home-directory scans, ignored secrets, or silent external uploads. Personal context is explicitly configured background, never competency evidence.
- **Permissions and skills are separate.** Plan approval cannot unlock skills. Outside-file sharing requires named authorization and still refuses credential paths. Neither a project directory nor a confirmation prompt is a sandbox.
- **Never clobber the IDE.** Existing-file changes are gated diff proposals for application in the user's editor. New support files are installed exclusively, never over an existing save. No source snapshot rollback.
- **Commands cannot evade the gate.** Only bounded read-only command actions are exposed to the model. No general shell, project scripts, package installation, network command, or command-generated implementation. Builds and tests of the user's project run in their own terminal.
- **Close every model route.** Use authenticated Claude subscription access, explicit verified model selectors, no built-in agent tools, no user/project settings or plugins, and only registered in-process tools. Verify subscription provenance before releasing a prompt. Refuse managed settings that could override isolation, and unknown plugin/tool/provider metadata. No Gemini, Google/Vertex, Antigravity, paid API credentials, or hidden fallback providers.
- **Wizard claims need support.** Immutable catalog anchors come from primary sources and retain their links. Unsupported dates, company decisions, quotations, statistics, or personal experience are omitted or narrowed. One team's decision is not universal practice. Do not reveal a practice solution to make an aside sound useful.
- **History is data, not authority.** Legacy transcript entries and pending work remain readable. Old approvals and old SDK prompts never become current permissions. Keep public tree sync separate from private project memory and personal context.
- **Maintenance is explicit.** Only the human's development-edition `:self` command can propose changes to dum's checkout; the learning model has no maintenance tool. It cannot bypass the learning gate when that checkout is the active project. Restart loads code the user has saved; a proposed patch is not an applied edit.
- **The desktop adds no capability the gate lacks.** The window sends only the finite requests in `src/desktop/protocol.ts`; main validates them and checks the sender is dum's own top-level page. Sandbox and context isolation stay on and Node integration stays off. The terminal's maintenance and web routes are not reachable from the app.
- **Sharing the screen is explicit.** One chosen screen or window, a local preview, then Send with a message. Captures are ephemeral, bound to the project and prompt, expire, and are never written to disk, logged, or resumed in a session. No background screenshots, microphone, or key logging. Don't market voice or annotations unless they exist and have been exercised.
- **The app carries its runtime.** The desktop build ships the exact native Claude Code that matches the pinned Agent SDK, resolved by absolute path. No bare `claude` or global Node fallback. Raise the SDK pin only with a real model call proving the new runtime still passes the subscription checks.
- **Say what a build is.** Test builds are ad-hoc signed and not notarized. Never claim signing, notarization, native permissions, Spaces or full-screen focus, login item, or Gatekeeper behavior without evidence from a real Mac.
- **Pixels stay private.** Screenshots from verification are never committed, uploaded as workflow artifacts, attached to releases, or synced. CI publishes only the DMG, ZIP, checksums and the smoke `report.json`.

## Development

Node 22.6+ (CI also runs Node 24), Git, and the `claude` CLI with subscription login for the terminal edition. The desktop app bundles its own Node runtime (Electron) and Claude Code, so it needs neither, but it still needs Git; on a Mac without it, first launch says to install Apple's Command Line Tools. No system-wide tooling changes are needed.

```sh
npm install
node --import tsx src/cli.tsx --help
npm test
npm run typecheck
```

Desktop, from the repo root:

```sh
npm run desktop        # compile and launch Electron
npm run desktop:pack   # unpacked app for this OS, in release/
npm run desktop:mac    # DMG and ZIP; only on a Mac (needs sips and iconutil)
npm run desktop:smoke  # drive a built app; see below
```

- `tools/desktop-build.mjs` compiles TypeScript to `dist/`, bundles the preload and renderer with esbuild, copies the curriculum and art, and generates the app icon from Dum's own portrait. `electron-builder.yml` packs `dist/` into an asar and unpacks the native `claude` binary beside it. Electron fuses turn off `RunAsNode`, `NODE_OPTIONS` and the CLI inspect flags, and require the asar.
- `npm run desktop:smoke` launches the real app with a clean private profile (`DUM_DESKTOP_DATA`, `DUM_HOME`, `DUM_CONTEXT=off`, `CLAUDE_CONFIG_DIR` all temporary, credentials stripped). It runs the Electron checkout by default. Set `DUM_SMOKE_EXECUTABLE` to a packaged binary instead and it also cuts `PATH` to `/usr/bin:/bin:/usr/sbin:/sbin`. It drives the window over CDP, checks persisted behavior through the app's own requests, relaunches, and writes screenshots plus `report.json` to `DUM_SMOKE_OUTPUT` (default `release/desktop-smoke`). The report holds only image dimensions and color counts, not pixels.
- On a headless Linux box run it as `xvfb-run -a npm run desktop:smoke`. The harness adds `--no-sandbox` on Linux only, because a Linux checkout usually has no SUID sandbox. That flag is for the harness, not the product.
- The conversation window starts hidden, and a CDP screenshot of a hidden window never returns. Show it first (`toggle-panel`); the harness bounds every screenshot so a hang fails the run.
- The Mac workflow `.github/workflows/desktop-macos.yml` runs on a push to `desktop/macos-companion` on `macos-15` (Apple Silicon) and `macos-15-intel`. It type-checks, tests, builds, verifies the ad-hoc signature, chip architecture and bundled `claude` version, mounts the DMG, extracts the ZIP, and runs the smoke against the app copied out of the DMG.
- Keep deterministic regressions isolated from real skill notes, personal context, model calls, and network. Use a temporary `DUM_HOME` and `DUM_CONTEXT=off`.
- Test consumer-visible behavior: prerequisites, evidence transitions, permission refusals, persistence, legacy data, and external-save races. Do not pin prose, source text, implementation wiring, or incidental defaults.
- Exercise the real terminal after integration. Tests alone do not establish readable characters, input behavior, or a useful teaching conversation.
- Use `npm run practice` for a throwaway repository and tree. Its paths stay on disk for inspection.
- For terminal frames, start a uniquely named tmux session at the intended size, set `window-size manual`, send literal input, and capture the actual pane. Stop only that exact session name. Never use a real personal tree for a demo.
- Real model demos are qualitative observations. Record what dum and the wizard did, not claims about learning improvement or reviewer accuracy.
- Record actual model selectors, CLI/SDK versions, and exposed provider provenance without account identifiers or credentials. A route configured in source is not proof of the route used.
- CI configuration lives in `.github/workflows/`: `ci.yml` for the deterministic suite and `desktop-macos.yml` for packaging. Keep model/network demos outside the deterministic suite.

## Code map

- `session.ts`, `store.ts`, `plain.ts`, `lines.ts`: teaching conversation, input state, and terminal output.
- `gate.ts`, `evidence.ts`, `practice.ts`, `course.ts`: implementation boundary, honest evidence, returned practice, and optional courses.
- `skills.ts`, `notes.ts`, `curriculum.ts`, `trees/`: persistent competency notes and prerequisites.
- `workspace.ts`, `runtime.ts`, `oneshot.ts`: bounded file/command access and closed subscription calls.
- `wizard.ts`, `anchors.ts`, `sprite.ts`, `art/`: grounded wizard voice and original character identities.
- `context.ts`, `memory.ts`, `self.ts`: configured personal background, inspectable project continuity, and explicit maintenance proposals.
- `sync.ts`, `web.ts`, `web/`: optional tree-only synchronization and web editing.
- `desktop/`: the Electron app. `main.ts` owns windows, tray, hotkey and native calls; `ipc.ts` validates the renderer's finite requests (`protocol.ts`); `controller.ts` is the conversation, run in the supervised utility process (`host.ts`, `host-client.ts`, `host-protocol.ts`); `capture.ts` holds the one-shot screen capture; `runtime-setup.ts` handles bundled-Claude sign-in; `settings.ts` stores preferences. `ui/` is the sandboxed renderer. `art-parser.ts` and `companion-layout.ts` size the companion from the same art the terminal uses.

Comments explain invariants or tradeoffs. Keep them short. Preserve unrelated checkout changes, and do not commit or push without authorization.

# dum-intern

- A Mac desktop companion that floats beside your IDE or browser. Build real software, teach dum your reasoning, and keep a persistent skill tree of what you've demonstrated.
- Dum is a capable beginner, not an examiner. It proposes approaches, asks at meaningful decisions, remembers useful guidance, and uses it in later work.
- The wizard is the experienced voice beside you. Its short engineering anchors come from verified primary sources, with links. Unsupported specifics are omitted rather than invented.
- The outcome is being able to take the LLM away and still understand the architecture, start implementing, and ask precise questions.
- Ryan's recalled story about a chess player improving after teaching a beginner inspired the relationship. It is not verified research or a claim that dum improves learning.
- The original terminal edition still ships in this repo as development infrastructure. The sections from [Terminal edition](#terminal-edition-development) down describe it, and its teaching rules apply to the desktop app too.

## Install on a Mac

- Needs macOS 13 or later and Git. If Git is missing, dum says so on first launch; Apple's Command Line Tools provide it.
- Needs a Claude subscription that includes `claude-opus-5-5` and `claude-fable-5-1`. There is no API-key setup, paid-usage route, or provider fallback.
- Nothing else to install. The app carries its own Claude Code runtime (native 2.1.290 for your chip, from Agent SDK 0.3.290). It does not use a global Node or a separately installed `claude`.
- Download the DMG or ZIP that matches your chip from the latest successful run of the [desktop macOS workflow](https://github.com/hub-ry/dum-intern/actions/workflows/desktop-macos.yml), under the artifacts: `Dum-macos-arm64-unsigned-test` for Apple Silicon, `Dum-macos-x64-unsigned-test` for Intel. GitHub asks you to be signed in to download workflow artifacts. Each artifact has SHA-256 sums.
- Open the DMG and drag Dum to Applications.
- These builds are ad-hoc signed, not Developer ID signed, and not notarized, because no Apple signing credentials exist for this project. Gatekeeper will refuse the first launch. Per Apple's instructions for apps from unidentified developers, open System Settings, then Privacy & Security, scroll to Security, and click Open Anyway after the refusal. This path was not exercised on a physical Mac for this project.
- A signed, notarized release needs an Apple Developer ID certificate and notarization credentials. The build config has the hooks off until those exist.

## Use

- Dum has no Dock icon. It lives in the menu bar (Show or Hide dum, Conversation, Quit dum) and as a small floating character pair, Dum and the wizard, that stays on top by default. Settings can also show it on all desktops; how that behaves over full-screen apps is not yet verified on a Mac. Drag it anywhere; it remembers the spot and stays on a display.
- Click the characters or press the global shortcut, default `Cmd+Shift+D`, to open the conversation window beside them. Change the shortcut in Settings. A shortcut needs a non-Shift modifier, and one another app already owns is refused with the old one kept.
- First launch checks the bundled Claude's login. Existing Claude CLI credentials may already work. If you're signed out, press Sign in, which runs the bundled `claude auth login --claudeai` and opens Claude's page in your browser. Dum never sees your password. If Claude shows a code, paste it into the form.
- Choose a project folder (it must be a Git repository), or pick a recent one. The conversation, the skill tree, project memory, history, evidence, and the boundary of what the tree currently permits are all in the window.
- In the conversation, `Enter` sends, `Shift+Enter` adds a line, and `Esc` closes the open sheet, or hides the window if none is open. You can interrupt a reply with Stop.
- Sharing your screen is explicit. Pick a screen or window, look at the preview, then press Send with message. A preview that you don't send is discarded and expires after five minutes. There is no microphone capture, key logging, or background screenshot. On macOS, sharing a screen needs Screen Recording permission for Dum; the native permission prompt has not been verified on a Mac yet.
- Settings cover always on top, all desktops, launch at login, the shortcut, the project's coaching mode, and an opt-in personal context file.
- Rarely, a force-quit or crash while dum opens or closes a project leaves `.dum/session.lock.guard` behind, and the next open says so. Quit every Dum, check in the menu bar and Activity Monitor that none is running, then delete that file in Finder and reopen the project. Never delete it while any Dum is running; a live guard or `.dum/session.lock` protects the project from two Dums writing at once. The `.dum` folder is hidden; press `Cmd+Shift+.` in Finder to show hidden files. No Terminal is needed.

## Privacy and storage

- The app's own settings are one private file, `settings.json`, in Electron's per-user data folder: hotkey, window toggles, the eight most recent projects, and the companion position. Electron names that folder `Dum`; on Linux the packaged build used `~/.config/Dum`, and on a Mac it is `~/Library/Application Support/Dum` by Electron's convention. It holds no tokens, transcripts, captures, or account data.
- Project state, memory, and evidence live in `<project>/.dum/`, and the skill tree in `~/.dum/`, exactly as in the terminal edition (see Access and storage below). Memory and the conversation are plain files you can read, edit, or delete.
- A screenshot is sent only after the source, preview, and Send steps above. Dum keeps the image in memory for the preview and writes no screenshot bytes to disk, and it doesn't start a resumable Claude session for the desktop app. A text description Claude produces of what it saw does enter the local conversation and project memory. This does not mean Claude's service never retains an image, and it doesn't claim that every copy in memory is securely erased.
- Conversations use your first-party Claude subscription over the network, so signing in and every reply need a connection. Provider overrides and API credentials are excluded from the model subprocess environment. Subscription provenance is checked before a prompt is sent, and unknown provider, tool, or plugin metadata is refused.
- Sign-in credentials belong to the Claude runtime, which stores them wherever Claude Code does on your Mac. They are not in Dum's settings or in your project data, and Dum doesn't read them. How that storage behaves in this app, including any Keychain prompts, has not been tested on a Mac.
- Advice, images, and personal context never unlock skills. Skills come from the evidence rules below.

## What is verified

- On Linux under a virtual display (Xvfb), the real Electron app and the packaged Linux build were driven through the same scripted checks (`npm run desktop:smoke`). The renderer has no Node access, the bundled runtime starts from the packaged archive with `PATH` cut to `/usr/bin:/bin:/usr/sbin:/sbin`, a signed-out clean profile reports a real signed-out state, a project opens through the utility process, a stale or out-of-catalog request is refused, the skill tree keeps prerequisite locks, memory and settings persist across a quit and relaunch, and a real screen capture preview can be discarded with its token dead.
- Real model conversations with Claude Opus 5.5 and Fable 5.1 on a signed-in subscription ran from the same source on that machine. Treat them as qualitative observations.
- macOS builds are produced on GitHub's macOS runners, one Apple Silicon and one Intel, and the same smoke runs against the app copied out of the DMG. The workflow has not been run yet when this line was written; check the latest run for its outcome.
- Not verified on a physical Mac: panel focus over full-screen apps and Spaces, the Screen Recording prompt, global-shortcut permission, launch at login, tray rendering, first-launch Gatekeeper, and native interactive sign-in.
- Screenshots from verification stay private and are never published.

## Terminal edition (development)

Requires Node 22.6+, Git, and a current `claude` CLI logged into a Claude subscription. The app uses `claude-opus-5-5` at high effort for dum and `claude-fable-5-1` at high effort for bounded helpers. The exact models must be available on that login; there is no provider fallback or API-key setup.

```sh
claude auth login
npm install
npm link
cd your-project
dum
```

- A conversation uses Claude's subscription through the Agent SDK. Tree commands do not need a model call.
- No Google, Gemini, Antigravity, or paid API-key route. Provider overrides and API credentials are excluded from the model subprocess environment.
- The terminal edition's SDK launches the installed `claude` CLI; `claude update` updates it. Claude CLI 2.1.290 matches the SDK 0.3.290 pinned here. Subscription provenance is checked before sending conversation or personal context. Unknown provider, tool, or plugin metadata is refused, as are managed settings that could override isolation.
- `npm run practice` starts a scratch Git repository with a separate tree and personal context disabled. It prints the paths and leaves them available for inspection.
- `dum --help` lists startup flags. `:help` lists conversational commands.
- Build the desktop app from source with `npm run desktop` (compile and launch), `npm run desktop:pack` (unpacked app for this OS), or `npm run desktop:mac` (DMG and ZIP; run on a Mac). `npm run desktop:smoke` drives a built app; see CONTRIBUTING.md.

## Build and teach

- Work in your usual editor and save ordinary project files. Dum has no integrated editor, permanent code pane, file-tree sidebar, or embedded shell.
- Describe what you're building. At a meaningful decision, teach dum why an approach fits or demonstrate your implementation. It can challenge an explanation when the code contradicts it.
- Use `:inspect counter.py` or `:inspect counter.py:1-30` to share a saved excerpt. Use `:changes` to share bounded current changes. Nothing watches your keystrokes or scans your home directory.
- Dum names the skills a proposed implementation needs. You approve a plan once; approval does not unlock skills or make the project's core AI-owned.
- Permitted changes to existing files appear as focused diff proposals, with a patch artifact for your IDE. Dum never replaces an existing project file. It can create permitted new support files exclusively, refusing if a saved file already exists.
- Run your project's builds, tests, and interactive programs in your own terminal. Dum's command access is a bounded read-only catalog, not a general shell.
- When a skill is missing, ask for practice or a project idea. Suggestions use your tree, prerequisites, working language, current project, and configured interests. A separate, single model call then lists every skill each suggestion's text needs. A suggestion needing anything not built on your tree today, apart from the skill being practiced, is left out with the reason. This check is model judgment, not proof that a task needs nothing more. Choosing an idea never unlocks it.

### Skill evidence

- **Recognize:** explain what a skill is and why it fits. The evidence must match something you actually said, not the model's assumption.
- **Build:** submit an implementation for a meaningful review and explicitly report that you wrote it without AI. A saved file alone is a demonstration artifact, not proof of unaided authorship.
- **Apply:** explain when and why to use a skill after prior build evidence. Reasoning without build records recognition, not apply.
- Concepts require build before dum may implement them. Tools require recognition. Curated-track skills remain concepts even if the model labels them tools.
- The current project's core stays yours in both modes. Prerequisites and language scope are checked in code, including when a previously held prerequisite is taken back.
- Optional `course <skill> in <language>` provides a guided explanation and scratch exercise. Completing a small guided gap records recognition. Demonstrate an independent implementation separately for build.
- Historical skill levels are preserved. Existing notes, old course results, language distinctions, and prerequisite mappings are not reset.
- You control the tree. `:skill printing, variables in python` adds skills you self-report being able to write from a blank file without AI. `:skill -variables in python` takes one off. `not yet` disputes recent evidence.
- `-a` / `--anti-vibe` remains selectable, but now changes coaching rather than allowing explanations to bypass build evidence. The selected mode persists per project; both modes enforce the same implementation boundary.

## Commands

| Command | Action |
| :--- | :--- |
| `:tree [language|all]`, `:skills` | Tracks, levels, prerequisites, and available next steps |
| `:inspect <path>[:start-end]`, `:share <path>[:start-end]` | Share a bounded saved excerpt |
| `:changes [path]` | Inspect current saved changes, including new files |
| `:practice <skill> [in language]` | Optional tree-aware practice suggestions |
| `:submit <task-id|skill> [in language] <path> [paths...] --unaided` | Review an implementation with an explicit unaided self-report |
| `course <skill> [in language]` | Optional guided course; `quit` leaves it |
| `:run status`, `:run diff`, `:run log` | Bounded read-only Git actions |
| `:boundary` | What the current tree permits in this project |
| `:evidence` | Inspect local explanation and artifact-review records |
| `:skill <names> [in language]` | Self-report existing build ability, prerequisites first |
| `:skill -<name> [in language]` | Take a skill off the tree |
| `not yet [name]` | Take back recent evidence |
| `:remember <note>`, `:memory` | Save and inspect project guidance |
| `:context` | Inspect configured personal background |
| `:log` | Read the conversation |
| `:web [server]` | Connect or synchronize the optional web tree |
| `:self <request>`, `:restart` | Development-edition maintenance proposals and reload |
| `exit`, `quit` | End the conversation |

- To submit work done elsewhere, name its saved files. Outside-project reads ask for explicit authorization and still refuse credential paths. Quote paths containing spaces; a submission accepts up to four files.
- Submitting without an unaided self-report cannot establish build. Feedback and artifact evidence remain inspectable.
- `dum --skills`, `--boundary`, `--context`, and `--memory` print local views. `--add "printing, variables" --in python`, `--forget "variables" --in python`, and `--reset` edit your tree; reset confirms and moves the old notes aside.
- `dum --new` moves project conversation state aside without resetting your tree or deleting evidence, patch proposals, or your mode preference. `--plain` uses the same conversation surface, including the original character portraits in a pipe. `NO_COLOR` removes color, not the characters.
- `dum-dev` or `dum --dev` enables `:self` proposals against dum's checkout. Apply existing-file patches in your IDE, then `:restart` loads the saved code. Maintenance cannot bypass the learning gate when dum's checkout is the active learning project.

## Access and storage

- Project access is the default boundary. Reads are bounded, symlink-aware, and exclude ignored files, credentials, Git internals, and private app state from ordinary agent tools.
- Workspace permission and skill evidence are separate. Neither a plan approval nor computer access permits locked implementation, external uploads, or arbitrary shell execution.
- Existing source files are never overwritten or restored from snapshots. A stale diff proposal is refused; exclusive new-file creation cannot replace a concurrent editor save.
- Claude receives the conversation, explicitly acquired code, and configured background needed for the session. The optional web service receives the skill tree, not private project memory, personal-context files, or sessions.
- Memory guides continuity and suggestions. It never unlocks skills.

```text
~/.dum/
  skills/              Markdown competency notes, with prerequisite links
  prereqs.json         Mapped prerequisites for off-track skills
  removed.json         Removal timestamps for synchronization
  web.json             Optional tree server and private edit link
  context.md           Optional explicitly configured personal background
  context.json         Optional list of personal Markdown files

<project>/.dum/
  transcript.json      Latest 500 entries, capped at 4 MiB
  memory.md            Editable project guidance, capped at 16 KiB
  claude-session       New-runtime Claude conversation ID
  preferences.json     Persisted coaching-mode selection
  practice.json        Optional practice tasks
  evidence.json        Local explanation/submission evidence
  proposals/           Immutable focused patch artifacts
  active-course.json   Optional guided course and original starter
  courses/             Ordinary saved course scratch files
```

- `DUM_HOME` selects a separate skill-note tree. Notes remain ordinary Markdown and can be opened in Obsidian. Legacy `.dum/session`, `todos.json`, transcripts, and scratch files are preserved; old approvals are not resumed as permissions.
- Personal background is opt-in through `~/.dum/context.md` or `context.json` with `{"files":["context.md","projects.md"]}`. Relative paths resolve beside that config. Up to 16 named files, 64 KiB total.
- `DUM_CONTEXT=/path/to/background.md` selects one background file; `DUM_CONTEXT=off` disables it. `dum --context` shows what loaded. `DUM_HOME` alone does not disable personal context.
- `:remember` saves a decision or next step in project memory. Edit or remove remembered notes yourself when they're wrong.
- `DUM_TRANSCRIPT=/path/to/output.json` exports the transcript when you exit. Keep it private; it can include shared code and conversation.

### Optional web tree

- `dum --web <server>` connects your tree and prints a private edit link. `dum --web` synchronizes it, `dum --web rotate` replaces the link, and `dum --web off` removes the web copy without deleting local notes.
- Anyone with the link can see and edit that tree. Web edits follow the same prerequisite and self-report rules as terminal tree edits. Removals have tombstones so synchronization does not bring them back.
- Trees merge skill by skill. Personal context, project evidence ledgers, memory, and sessions are not synchronized.
- To run the optional server: `PORT=8787 DUM_WEB_DATA=/srv/dum-trees npm run web`. It listens on localhost by default; use a TLS reverse proxy or tunnel for remote access.
- Existing hosting scripts remain in `deploy/`. They are not part of ordinary terminal startup and are not run automatically.

### Limits

- Reviews, hints and expected outputs are model judgments, not proof of authorship, comprehensive correctness, or measured learning improvement. Dum can get arithmetic wrong in a hint, so check its numbers. A self-report can be wrong; the tree is yours to correct.
- Wizard grounding uses a verified source catalog, not unrestricted browsing. The anchor's words and link come from that catalog. The model's connecting sentence passes a word-pattern screen that drops dates, statistics, quotes, unsourced names, and claims about what engineers or the industry usually do. The screen doesn't fact-check: it can pass a wrong local claim or cut a sound one. The wizard may remain silent when no supported anchor fits.
- Existing-file patches require application in your IDE. Arbitrary build/test commands and interactive programs are deliberately outside the agent's command surface.
- Model and CLI availability can change. A subscription plan alone does not guarantee a selected model or compatible runtime. Closed-runtime checks may require an app update when Claude introduces a new built-in plugin.
- [CONTRIBUTING.md](CONTRIBUTING.md) records the product rules and verification workflow. The deterministic checks are `npm test` and `npm run typecheck`; real terminal/model demos are separate.

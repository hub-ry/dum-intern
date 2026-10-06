# dum-intern

- Dum is a Mac companion that floats beside your IDE or browser. Its implementation capability follows your unlocked skill tree.
- Build in your own editor. When you're satisfied, tell dum what you built and why. The wizard offers occasional advice; dum isn't a live tutor.

## Download

- Apple Silicon: [Dum-0.0.1-mac-arm64.dmg](https://github.com/hub-ry/dum-intern/releases/download/desktop-macos-c37b371-test/Dum-0.0.1-mac-arm64.dmg)
- Intel: [Dum-0.0.1-mac-x64.dmg](https://github.com/hub-ry/dum-intern/releases/download/desktop-macos-c37b371-test/Dum-0.0.1-mac-x64.dmg)
- Test prerelease. ZIPs and `SHA256SUMS.txt` are on the [release page](https://github.com/hub-ry/dum-intern/releases/tag/desktop-macos-c37b371-test).
- These download artifacts predate the current companion redesign. Build the current checkout to try the changes below.
- Needs macOS 13+, Git, and a Claude subscription with Opus 5.5 and Fable 5.1. No API key.
- Git comes with Apple's Command Line Tools, and Dum offers to install them if it's missing.
- The app carries its own Node and Claude Code, so no terminal is needed.

## Set up

- Open the DMG, drag Dum into Applications, and launch it.
- This test build isn't Developer ID signed or notarized. If macOS blocks it, open System Settings, Privacy & Security, scroll to Security, and click Open Anyway.
- If asked, click Sign in. Claude's page opens in your browser. If it shows a code, paste it into Dum's code box. Dum never sees your password.
- Click Choose folder… and pick a Git project.
- Click the characters or press Cmd+Shift+D to open the conversation. Enter sends, Shift+Enter adds a line, and Esc backs out or hides Dum.
- Skills opens the tree. Tools holds project ideas, your notes, settings, and the post-build story action. “Tell dum what I built” prepares a draft; it never sends automatically.
- Input stays closed until you choose Write to dum, Tell dum what I built, or Voice. Hiding it preserves the draft. A question needing typed input opens it; approvals and permission controls remain visible.
- The thin top strip shows newbie → intern → good → cracked at 0 / 8 / 24 / 64 currently usable built skills. Recognition alone and message counts don't advance it; revoked prerequisites reduce it. These are playful labels, not proficiency ratings.
- Dum lives in the menu bar and a small floating pair. There's no Dock icon.

## Privacy and skills

- Dum only writes what your skill tree allows, including core algorithms when their skills and prerequisites are unlocked. Existing-file changes are diffs you apply yourself.
- On fresh desktop installs, the wizard takes periodic screen snapshots for unprompted advice. Existing off settings stay off. Pause or resume it from the companion panel in one click, or switch its source to saved project files in Settings. Screen mode can see anything visible, including private information and unsent drafts. macOS requires Screen Recording permission; denied access does not silently fall back to files.
- Manual sharing is separate from wizard advice: pick a screen or window, review the preview, then press Send with a message. An unsent preview expires after five minutes. Neither path writes screenshots to disk.
- Voice input on macOS 14 or later with Apple Silicon uses bundled OpenSuperWhisper: configure its local model, microphone permissions, Accessibility access, and a global shortcut, then focus dum's input and dictate. It doesn't send automatically. OpenSuperWhisper may keep recordings locally in its own storage.
- No key logging. Background audio is not recorded outside voice input.
- Chats go to Claude over your subscription. Project memory and evidence stay in `<project>/.dum/` and your skill tree in `~/.dum/`, as plain files you can edit or delete.

<details>
<summary>Reference: checksums, verification, recovery, limits</summary>

Checksums for `desktop-macos-c37b371-test`:

```text
2941c6724c442dbca50c24b732cfdfb22940605c9e26103b569b052a29ce66bd  Dum-0.0.1-mac-arm64.dmg
79c13ce09abddcd8cea3588b1fe49167119ba616f1a181b4c16aec1035f27178  Dum-0.0.1-mac-x64.dmg
04ee99ed13e0cb5fea1f35020abb61c46b91ceac6ab2ab1e2d864a54d0f392f2  Dum-0.0.1-mac-arm64.zip
869351dc471645ea22e1ee8187e68f7d87e2063d1eb321df3387e26f78653397  Dum-0.0.1-mac-x64.zip
```

- App: Electron 44.5.1, native Claude Code 2.1.290 from Agent SDK 0.3.290, for your chip. It doesn't use a global Node or a separately installed `claude`.
- Exact models: the Claude subscription must include `claude-opus-5-5` and `claude-fable-5-1`. There's no API-key setup, paid-usage route, or provider fallback. Dum needs macOS 13 or later and Git.
- The goal: you could take the LLM away and still understand the architecture, start implementing, and ask precise questions. The wizard checks mistakes and relevant tradeoffs; external claims use a verified source catalog with links.
- Esc closes an open sheet, then collapses open input, then hides the conversation window. Stop interrupts a reply.
- A screen preview you don't send is discarded and expires after five minutes. On macOS, sharing a screen needs Screen Recording permission for Dum.
- Dum can only write what the skill tree allows. Tools need recognition and concepts need build evidence before it may implement them. Advice, images, and personal context never unlock skills. Evidence kinds are recognize, build (unaided, self-reported), and apply; see the terminal reference below.
- Newer test builds are artifacts of the [desktop macOS workflow](https://github.com/hub-ry/dum-intern/actions/workflows/desktop-macos.yml). GitHub only lets signed-in users download those.
- A signed, notarized release needs an Apple Developer ID certificate and notarization credentials. The build config has the hooks off until those exist.
- The Mac build was produced on GitHub's macOS runners, Apple Silicon (`macos-15`) and Intel (`macos-15-intel`). [Run 37399518331](https://github.com/hub-ry/dum-intern/actions/runs/37399518331) passed typecheck and 216 tests, built the app, checked the ad-hoc signature, chip architecture, and bundled Claude version, verified the DMG, extracted the ZIP, and ran the smoke check against the app copied out of the DMG.
- On Linux under Xvfb, the real Electron app and packaged build passed the same scripted checks (`npm run desktop:smoke`). Real conversations with Claude Opus 5.5 and Fable 5.1 ran from the same source there. Treat those as qualitative observations.
- Not verified on a physical Mac: focus over full-screen apps and Spaces, the Screen Recording prompt, global-shortcut permission, OpenSuperWhisper's Accessibility permission and voice dictation, launch at login, tray rendering, first-launch Gatekeeper, native interactive sign-in, and any Keychain prompts.
- Screenshots from verification stay private and are never published.
- Settings: always on top, all desktops, launch at login, the shortcut (needs a non-Shift modifier; one another app owns is refused), the project's coaching mode, and an opt-in personal context file.
- App settings are one `settings.json` in Electron's per-user data folder (`~/Library/Application Support/Dum` on a Mac by convention). It holds the hotkey, window toggles, the eight most recent projects, and the companion position. It holds no tokens, transcripts, captures, or account data.
- A text description Claude writes of a screenshot enters the local conversation and project memory. That doesn't mean Claude's service never retains an image, or that every in-memory copy is securely erased.
- Sign-in credentials stay with the Claude runtime wherever Claude Code stores them. Dum doesn't read them. Provider overrides and API credentials are kept out of the model subprocess environment, subscription provenance is checked before a prompt is sent, and unknown provider, tool, or plugin metadata is refused.
- Rarely, a force-quit or crash while a project opens or closes leaves `.dum/session.lock.guard` behind, and the next open says so. Quit every Dum, check the menu bar and Activity Monitor that none is running, then delete that file in Finder and reopen the project. Never delete it while any Dum is running. The `.dum` folder is hidden, so press Cmd+Shift+. in Finder.
- Reviews, hints, and expected outputs are model judgments. Dum can get arithmetic wrong in a hint, so check its numbers. A self-report can be wrong, and the tree is yours to correct.
- The wizard's anchor words and link come from a verified catalog. The model's connecting sentence passes a word-pattern screen for dates, statistics, quotes, unsourced names, and claims about what engineers usually do. The screen doesn't fact-check, so it can pass a wrong local claim or cut a sound one. The wizard may stay silent when no anchor fits.
- Model availability can change. A subscription alone doesn't guarantee a given model or a compatible runtime. Closed-runtime checks may need an app update when Claude adds a new built-in plugin.
- Code, build, and product rules are in [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` and `npm run typecheck` are the deterministic checks.

</details>

<details>
<summary>Reference: terminal edition (development)</summary>

Needs Node 22.6+, Git, and a current `claude` CLI logged into a Claude subscription. Dum uses `claude-opus-5-5` at high effort and `claude-fable-5-1` at high effort for bounded helpers. No provider fallback or API-key setup.

```sh
claude auth login
npm install
npm link
cd your-project
dum
```

- A conversation uses Claude's subscription through the Agent SDK. Tree commands need no model call.
- No Google, Gemini, Antigravity, or paid API-key route.
- The terminal edition's SDK launches the installed `claude` CLI, and `claude update` updates it. CLI 2.1.290 matches the pinned SDK 0.3.290. Managed settings that could override isolation are refused.
- `npm run practice` starts a scratch Git repository with a separate tree and personal context disabled. It prints the paths and leaves them for inspection.
- `dum --help` lists startup flags. `:help` lists conversational commands.
- Build the desktop app from source with `npm run desktop` (compile and launch), `npm run desktop:pack` (unpacked app for this OS), or `npm run desktop:mac` (DMG and ZIP, run on a Mac). `npm run desktop:smoke` drives a built app. See CONTRIBUTING.md.

Build, then tell dum:

- Work in your usual editor and save ordinary project files. Dum has no integrated editor, code pane, file-tree sidebar, or embedded shell.
- Build until you're satisfied, then tell dum the story: what you made, the decisions, and why they fit. Dum remembers useful reasoning. Explanations alone don't establish build evidence.
- `:inspect counter.py` or `:inspect counter.py:1-30` shares a saved excerpt. `:changes` shares bounded current changes. Nothing watches your keystrokes or scans your home directory.
- Dum names the skills a requested implementation needs. Approving a plan doesn't unlock them. In anti-vibe, an approach you've already supplied is enough to start planning; dum asks only for missing material reasoning.
- Permitted changes to existing files appear as focused diff proposals, with a patch artifact for your IDE. Dum can create permitted new files exclusively and refuses if a saved file already exists.
- Run builds, tests, and interactive programs in your own terminal. Dum's command access is a bounded read-only catalog, not a general shell.
- `:practice projects in go` suggests substantial projects using project memory, opted-in personal context, and demonstrated experience in other languages. Estimates sort by midpoint active-work hours, then difficulty. Each project shows why it fits and an ordered path through several skill levels; unfamiliar goals aren't assumed unlocked.
- A separate model audits implied requirements and prerequisite coverage. Recommendations and estimates are model judgments, not promises. Choosing a project doesn't unlock anything.
- `:submit p1 main.go --unaided` reviews a saved project's targets separately. Partial passes are kept; a dependent target isn't recorded until its prerequisites pass. Experience in Python doesn't grant Go skill credit.
- Skill-scoped `:practice <skill>` remains available for focused work. Small drills and courses are optional, not the default project size.

Skill evidence:

- Recognize: explain what a skill is and why it fits. The evidence must match something you actually said.
- Build: submit an implementation for review and explicitly report you wrote it without AI. A saved file alone is a demonstration artifact, not proof of unaided authorship.
- Apply: explain when and why to use a skill after prior build evidence. Reasoning without build records only counts as recognition.
- Concepts require build before dum may implement them. Tools require recognition. Curated-track skills stay concepts even if the model labels them tools.
- Core algorithms use the same gates in both modes. Prerequisites and language scope are checked in code, including when a held prerequisite is taken back.
- `course <skill> in <language>` gives a guided explanation and scratch exercise. Completing a small guided gap records recognition. Show an independent implementation separately for build.
- Historical skill levels, old notes, course results, language distinctions, and prerequisite mappings are preserved.
- `:skill printing, variables in python` adds skills you can write from a blank file without AI. `:skill -variables in python` removes one. `not yet` disputes recent evidence.
- `-a` / `--anti-vibe` asks you to choose the approach before dum implements it, without re-quizzing an approach you've supplied. The mode persists per project; both enforce the same implementation boundary.

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

- To submit work done elsewhere, name its saved files. Outside-project reads ask for explicit authorization and still refuse credential paths. Quote paths containing spaces. A submission takes up to four files.
- Submitting without an unaided self-report can't establish build. Feedback and artifact evidence stay inspectable.
- `dum --skills`, `--boundary`, `--context`, and `--memory` print local views. `--add "printing, variables" --in python`, `--forget "variables" --in python`, and `--reset` edit your tree. Reset confirms and moves the old notes aside.
- `dum --new` moves project conversation state aside without resetting your tree or deleting evidence, patch proposals, or your mode preference. `--plain` uses the same conversation surface, including the character portraits in a pipe. `NO_COLOR` removes color, not the characters.
- `dum-dev` or `dum --dev` enables `:self` proposals against dum's checkout. Apply existing-file patches in your IDE, then `:restart` loads the saved code. Maintenance can't bypass the learning gate when dum's checkout is the active learning project.

Access and storage:

- Project access is the default boundary. Reads are bounded, symlink-aware, and exclude ignored files, credentials, Git internals, and private app state from ordinary agent tools.
- Workspace permission and skill evidence are separate. Neither a plan approval nor computer access permits locked implementation, external uploads, or arbitrary shell execution.
- Existing source files are never overwritten or restored from snapshots. A stale diff proposal is refused, and exclusive new-file creation can't replace a concurrent editor save.
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

- `DUM_HOME` selects a separate skill-note tree. Notes are ordinary Markdown and open in Obsidian. Legacy `.dum/session`, `todos.json`, transcripts, and scratch files are preserved, and old approvals aren't resumed as permissions.
- Personal background is opt-in through `~/.dum/context.md` or `context.json` with `{"files":["context.md","projects.md"]}`. Relative paths resolve beside that config. Up to 16 named files, 64 KiB total.
- `DUM_CONTEXT=/path/to/background.md` selects one background file, and `DUM_CONTEXT=off` disables it. `dum --context` shows what loaded. `DUM_HOME` alone doesn't disable personal context.
- `:remember` saves a decision or next step in project memory. Edit or remove notes yourself when they're wrong.
- `DUM_TRANSCRIPT=/path/to/output.json` exports the transcript when you exit. Keep it private, since it can include shared code and conversation.

Optional web tree:

- `dum --web <server>` connects your tree and prints a private edit link. `dum --web` synchronizes it, `dum --web rotate` replaces the link, and `dum --web off` removes the web copy without deleting local notes.
- Anyone with the link can see and edit that tree. Web edits follow the same prerequisite and self-report rules as terminal tree edits. Removals have tombstones so synchronization doesn't bring them back.
- Trees merge skill by skill. Personal context, project evidence ledgers, memory, and sessions aren't synchronized.
- To run the optional server: `PORT=8787 DUM_WEB_DATA=/srv/dum-trees npm run web`. It listens on localhost by default. Use a TLS reverse proxy or tunnel for remote access.
- The same server serves public docs at `/`, `/install`, `/how-it-works`, and `/subjects`, including the intern runner and wandering wizard. Private tree links keep their separate capability checks, no-index, and no-store headers.
- Existing hosting scripts are in `deploy/`. They aren't part of ordinary terminal startup and don't run automatically.

</details>

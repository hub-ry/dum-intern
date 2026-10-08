# dum-intern

- Dum is a Mac app you delegate to. It sits on screen as one small floating circle with Dum's face, follows what you're learning across a tree of zones, and writes code when you tell it to, but only with skills you've proven.
- The loop: say the outcome you need, agree with Dum what your zone's goal means, pick a piece of work you can hand off now, check the handoff, press Do this, review what came back. Each step lands on the session's trail, and the trails add up to your story. Work you haven't proven yet becomes something to learn first.
- The goal: you could take the AI away and still understand the architecture, start implementing, and ask precise questions.
- How Dum is put together, and the rules it follows: [docs/architecture.md](docs/architecture.md). User docs: [/docs](src/site/docs.html) on the site.

## Get it

- No public release of this version yet. Build it from source (below).
- Test builds come from the [desktop macOS workflow](https://github.com/hub-ry/dum-intern/actions/workflows/desktop-macos.yml) on pushes to `main`: ad-hoc signed, not notarized. GitHub only lets signed-in users download them.
- The older test prerelease on the releases page predates zones and doesn't match this README.
- Needs macOS 13+, Apple Silicon or Intel. Voice needs macOS 14+ on Apple Silicon.
- Needs a backend: your own Anthropic API key for Claude, or models running locally in Ollama or LM Studio. Claude takes only an API key, in every build.
- The app carries its own Claude Code. Nothing else to install for Claude.

## Using it

- First launch opens Dum's window at "What are you trying to learn?". The answer becomes your first zone, with no model call. macOS also asks for Screen Recording permission, because the look is on by default.
- Then "Who powers Dum?" picks a backend and three models: Dum's model, the helper and the look model. Zones, skills, notes and model-free commands work before that.
- Zones are what you're learning, like `Programming › Data Structures`, never a folder or Git repo. They nest up to 16 deep. A zone has a goal, an optional language and notes, which the zones inside it inherit. Conversation, memory, the agreed direction, handoffs, sessions, suggested projects, change history and followed folders belong to one zone.
- Skills are global, one Markdown note each in `~/.dum/skills/`, scoped to a language or none. Recognize = you explained it, build = you wrote it unaided and said so after a review, apply = you built it and reasoned about when to use it. `not yet` takes back the skill just recorded and holds it until you build it again.
- The gate is code: concepts need build, tools need recognize, and every prerequisite must hold.

### The circle and the window

- The circle floats above other apps on every Space. No Dock icon, no menu bar icon. Click it, or press `⌘⇧D` from anywhere, to open the window beside it; do either again while the window is focused to hide it. Drag the circle to move it. Dum remembers one spot per display.
- The circle's face shows what Dum is doing: idle, looking, thinking, listening, or a `!` badge when something needs you (a decision waiting, the API key rejected, voice failed, the host stopped). Its accessible label names the same state.
- The window has three parts, top to bottom:
  - **Zones**: the active zone's path (click it, or `⌘K`, to switch), **Manage** for the zone tree, **Settings** and **Hide**.
  - **Current context**: what the look is doing, with Pause/Resume and Details; your goal and the agreed direction, or "Alignment needed"; what Dum is using right now, with **Inspect** and **Correct**; this session's trail; what you can delegate now and what to learn next.
  - **Chat**: the conversation, decision cards and the message box. The header has Mode (understand or anti-vibe), the **Skills / Records** menu and **Move circle**. Settings, Skills, Records and the story open inside Chat and Back returns to it.
- `Esc` closes the innermost thing first (a chooser, a form, an open view) and then hides the window, giving focus back to the app you were in. `⌘W` hides it too. Switching to another app hides it without taking you back. `⌘.` stops Dum. `Esc` never means Stop, No or dismiss.
- Move circle works from the keyboard: arrows move it 10 points, Shift+arrows 1 point, Enter keeps it, Esc puts it back.

### Delegating

- **Goal alignment.** Creating a zone with a goal, or changing a zone's goal, starts alignment for that zone. Dum reflects the goal back as an ability, asks at most two questions whose answers change the plan, and the Wizard offers directions: a learning project or a decision, each with why it advances the goal, its tradeoff and the context it's based on. Pick **Use this direction**, **Use my own direction**, **Revise** or **Not now**. Agreeing asks what you'll be able to do, how you'll know it worked and which assumptions you accept. A direction is intent only: it writes nothing and grants nothing. Without a backend your goal is saved and alignment waits.
- **Decision cards.** Say what you need done next and press **Help me decide**. The Wizard lays out two or three options. Each names the task, the expected result, what you'll review, the skills it needs, its tradeoff and what it's based on, and the host labels it: **Can delegate now** (Choose), **Learn first** (Suggest a project to learn it) or **Needs a detail** (Give this detail). Revise, Use my own plan and Dismiss are always there. A dismissed card doesn't come back until you ask again.
- **Handoff.** Choosing an option makes a handoff card: Task, Expected result, What you'll review. Edit it, Dismiss it, or press **Do this**. Nothing runs before Do this. If the goal, direction, context or session moved since, the card asks you to **Refresh handoff** first. Do this runs once; the gate and the file-hash check apply to every write, exactly as for a typed request.
- **Review.** The finished handoff shows what happened and each change's diff with Revert. **Reviewed…** records your verdict against the expected result on the trail. A review is never evidence of a skill.
- **Sessions, trail and story.** A session is one stretch of work in one zone. It ends when you leave the zone, press New session, change what Dum works from (mode, backend, goal, notes, personal context, direction or a correction), quit, or after 30 quiet minutes. The trail records the skills you visited in order, with markers for directions and handoff steps; a skill Dum can't place is a gap you can **Map to skill**. **This session** pages through the current trail. **Full story** lists sessions newest first, for this zone or all zones, filtered by skill and date.
- **Correct.** Current context → Correct edits the goal or notes, revises the direction, opens memory, reloads context, ignores the latest observation, or opens personal background and followed folders. A correction changes the context, so a ready handoff asks for a refresh.

### Voice, the look and the Wizard

- Voice: hold `⌃⌥Space`. A bundled OpenSuperWhisper transcribes on the Mac into your draft; it never sends itself. A click-through bubble near the cursor shows the draft and Dum's reply, with "Open Dum" when there's more. `⌘⇧↩` sends the draft. A voice reply also goes into Chat.
- Everything works from the keyboard. All three shortcuts (Open Dum, Hold to talk, Send the draft) can be changed in Settings.
- Changes: ask Dum to change a file you shared or follow, or hand it off, and if you hold the skills it writes the file directly. No yes/no step. The diff shows after, with one-click Revert. Dum writes only if the file is byte-for-byte what it last read, so it never writes over your editor's save. Revert refuses if you've edited since.
- The look: every 3 seconds Dum checks the front app, how much the screen changed (a 64×40 gray grid, never sent), and saved files in followed folders. When the screen changed, your look model gets one fresh 1280 px picture of the display nearest the cursor, with Dum's own windows painted out, plus a line about what it saw last and the zone context. Never older pictures, keystrokes or the clipboard. Code saves, app switches and typing pauses also count and share the same calls. The look keeps Dum's context current; it doesn't interrupt you with tips.
- Look limits: one call at a time, at most one every 3 seconds and 1,200 an hour; an identical frame never goes twice; a call stops after 45 s and still counts. Dum keeps the latest observation in memory and shows it in Current context as "last seen". It saves a memory note only when what you're doing meaningfully changes: at most one a minute, never a near-repeat of the last five.
- The look makes no call and takes no frame while paused or blocked, with no backend, while you're recording voice, while the Mac sleeps or is locked, with a Dum window in front, or with screen look off (then saves and app switches still call, with no picture). Pause it in Current context. Without Screen Recording it uses app switches and saved files only.
- Look calls are billed to your own API key. Dum doesn't estimate the cost.
- Suggested projects: `:projects new` or `:projects <skill>`; `:submit pN <file> --unaided` hands in your work milestone by milestone. A Learn first option's button asks for one. No guided practice or courses.
- The Wizard helps you decide: at goal alignment and when you ask for help with the next delegation. It doesn't post unprompted tips. When it backs a tradeoff with an outside fact, the claim and link come from a fixed catalog of primary sources.
- `:help` lists commands. Full user docs are on the site at `/docs`.

### Settings

- Settings holds exactly: **Agent** (backend, models, API key), **Look** (Apps, Screen, Screen Recording status and Open Screen Recording settings), **Shortcuts**, **Open at login** (starts the circle and host, not the window), **Use personal context** (which files it reads), **Set up voice**, **Debug chat**, the version, and **Quit Dum**.
- Elsewhere: Mode is in the Chat header; followed folders and zone notes are in Records → Context; the web tree is in Skills; Pause is in Current context.
- Debug chat answers questions about Dum itself ("which look model is running?") from a read-only diagnostics log. It can't change settings, zones, files or skills, never sees your zone's conversation, and keeps nothing on disk. It needs a backend; each Send is one model call.

## Backends

- Claude: your own Anthropic API key only, in every build; that's the only way Dum connects to Claude. Defaults: Dum's model `opus` (high), helper `fable` (high), look model `haiku` (low).
- Model ids are what Claude's live catalog lists, aliases such as `opus`, `fable` and `haiku` included. Dum verifies a model by the id an alias resolves to. Pictures go only to a model whose resolved id is verified with real calls; if an alias moves to an unverified model, the look keeps running on text and the look status says so.
- The look model must take pictures.
- On this Mac: Ollama (`127.0.0.1:11434`) or LM Studio (`127.0.0.1:1234`). Loopback only; Ollama cloud models are refused. LM Studio is text-only.
- ChatGPT sign-in is built but switched off (`RELEASED` in `src/agent/registry.ts`).
- All three models come from one backend. No fallback to another backend.
- The API key is encrypted with Electron `safeStorage` in Dum's app data.

## Privacy

- Stays on the Mac: skill tree, zones, conversations, memory, evidence, directions, handoffs, sessions and story, suggested projects and change records (`~/.dum/`), settings, circle placement and the encrypted key (Electron's app data folder), voice audio and transcripts, routine screen samples, the diagnostics log (memory only).
- Goes to the chosen backend: messages, zone goal and notes, skills and boundary, recent conversation, text of files Dum reads, and for the look the zone context, the previous observation in words, the front app's name, saved-file diffs and one fresh screen frame per call. Goal alignment and decision cards send the goal, the agreed direction, the context they cite (notes, memory, the latest observation, recent conversation, and personal background if it's on) and the skills that could apply. Debug chat sends your question and redacted diagnostics, never zone data.
- Claude sends to Anthropic. On this Mac sends only to the local server.
- The optional web tree gets only skills and removals.
- No keystroke, clipboard or passive audio capture.

## Build and test

Needs Node 22.6+.

```sh
npm install
npm run desktop            # build and launch from the checkout
npm run desktop:mac        # DMG and ZIP, run on a Mac
npm run desktop:pack       # unpacked app for this OS
npm test
npm run typecheck
npm run desktop:build && npm run desktop:smoke   # xvfb-run -a on Linux
```

- `npm run desktop` has no native helpers: no voice, no app-switch noticing, no focus return. Packaging builds them; voice builds only on Apple Silicon and needs Xcode, cmake, and Rust with `aarch64-apple-darwin`.
- Not yet tried on a physical Mac: the circle (click-through corners, drag, Spaces and full-screen, VoiceOver), the window's focus return, voice, Screen Recording prompts and capture, the live look's frames and real cost, the bubble over full-screen apps, launch at login, Keychain-backed key storage, Gatekeeper on first launch. [docs/todo.md](docs/todo.md) has the full list.
- Code, build and product rules: [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary>Reference: storage, environment, web tree, site, deploy</summary>

```text
~/.dum/
  skills/                 Markdown skill notes, with prerequisite links
  prereqs.json            mapped prerequisites for off-track skills
  removed.json            removal timestamps for sync
  evidence.json           evidence ledger and not-yet holds
  zones.json              the zone tree and the active zone
  web.json                optional web tree link
  context.md              optional personal background
  session.lock            one Dum per home
  decisions/runtime/      empty working folder for the Wizard's decision calls
  debug/runtime/          empty working folder for debug chat
  zones/<zone-id>/
    context.md            notes for this zone, up to 16 KiB
    memory.md             zone memory, up to 16 KiB
    transcript.json       latest 500 entries, up to 4 MiB
    practice.json         suggested projects and hand-ins
    follows.json          followed folders
    changes/<change-id>/  change.json, before, after, change.patch
    direction/            alignment head.json and revisions/<id>.json
    delegations/          current.json, and <handoff-id>/head.json with versions/<n>.json
    context-corrections.json  the observation you told Dum to ignore
    sessions/             index.json, and <session-id>/meta.json, events/, sources/
    story/                cache of the story: head.json and pages/
    runtime/              empty working folder for this zone's model calls
```

- `DUM_HOME` moves all of `~/.dum`. Notes are ordinary Markdown and open in Obsidian.
- Personal background is opt-in: Settings → **Use personal context**, which lists the files it read. It reads `~/.dum/context.md`, or `context.json` with `{"files":["context.md","projects.md"]}` (paths relative to it, up to 16 files, 64 KiB). `DUM_CONTEXT=/path/to/file.md` picks one file and `DUM_CONTEXT=off` disables it. After editing the file, Current context → Correct → Reload context picks it up.
- Web tree: Skills → Web tree links your tree to a server and opens a private edit link. Sync now, New link and Unlink are there too. Anyone with the link can see and edit that tree. Trees merge skill by skill; zones, sessions, story, conversations, holds and files aren't synced.
- Run the server: `PORT=8787 DUM_WEB_DATA=/srv/dum-trees npm run web`. It listens on localhost by default. Use a TLS reverse proxy or tunnel for remote access.
- The same server serves the public site: `/`, `/install`, `/philosophy`, `/docs`, `/builds` and `/subjects`. Every page gets the same nav from `src/site/nav.html`; only the current page's link is highlighted. Private tree links keep their own capability checks, no-index and no-store headers.
- `/builds` embeds build recordings from YouTube, listed in `src/site/builds.json`. To add one, run `npm run site:add-build -- <youtube link> "<title>" ["<note>"]`, then commit and deploy. Only `/builds` may load YouTube frames.
- `/install` has the requirements and a copyable prompt that has a terminal LLM build and launch Dum from source. The prompt asks before system changes, sign-in, 2FA, secrets, writes outside the chosen folder, or changing an existing project.
- The site favicon is the desktop app icon, drawn by the same renderer (`tools/app-icon.mjs`). After changing `src/art/intern.txt`, run `npm run site:favicon` to regenerate `src/site/favicon.png`.
- Hosting scripts are in `deploy/`: `deploy.sh` tests, syncs the server and restarts it; `setup-hub.sh` installs the service and tunnel route; `skill-tree.service` is the systemd unit. They never run automatically.

</details>

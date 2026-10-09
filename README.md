# dum-intern

Dum is a Mac app you delegate to. It sits on screen as one small floating circle with Dum's face, follows what you're learning across a tree of zones, and writes code when you tell it to, but only with skills you've proven. The loop: say what you need, agree with Dum what your zone's goal means, pick a piece of work you can hand off now, check the handoff, press Do this, review what came back. Work you haven't proven yet becomes something to learn first. The point is that you could take the AI away and still understand the architecture, start implementing, and ask precise questions.

Site: [dumintern.com](https://dumintern.com), with [install](https://dumintern.com/install) and [docs](https://dumintern.com/docs). How Dum is put together and the rules it follows: [docs/architecture.md](docs/architecture.md).

## Get it

There's no public release of this version yet. You build it on the Mac that will run it, in this order.

1. **Prerequisites.** macOS 13 or later on Apple Silicon or Intel for the app; voice needs macOS 14 or later on Apple Silicon. Node 22.6+ (`brew install node`). For voice, also the full Xcode (not just Command Line Tools, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept`), `brew install cmake`, and Rust through rustup with `rustup target add aarch64-apple-darwin` (Homebrew's `rust` has no rustup and the build refuses it). The build fetches whisper.cpp and Swift packages, so it needs network.
2. **Build.** `npm install && npm run desktop:mac`. The app lands at `release/mac-arm64/Dum.app` (and a DMG beside it). If `prepare-dictation` stops, its message names the missing tool from step 1.
3. **Install.** Copy `Dum.app` to `/Applications`. The build is ad-hoc signed, not notarized, so right-click → Open the first time. If a DMG that came through a browser makes Dum report "The voice helper stopped" right away, clear quarantine: `xattr -dr com.apple.quarantine /Applications/Dum.app`.
4. **First launch.** Dum's window opens at "What are you trying to learn?"; the answer is your first zone, with no model call. macOS asks for Screen Recording because the look is on by default. Then **Who powers Dum?**: pick a backend and three models (Dum's model, the helper, the look model). Claude takes only your own Anthropic API key, and the key must belong to a workspace: a key made outside one fails with "must include the anthropic-workspace-id header". Create it at console.anthropic.com inside a Workspace.
5. **Verify for pictures, if you pick Haiku.** Dum sends screenshots only to a model it has verified. `opus` and `fable` are verified out of the box; for any other Claude model, such as `haiku`, Settings → Agent shows **Verify for pictures (one small call)** next to that role. It sends one 2×2 PNG and "Reply with the single word OK." on your key; success is recorded in `~/.dum/verified-models.json` and the look starts sending frames. Until then the look runs on text and Settings says "No pictures: …".
6. **Set up voice.** Settings → **Set up voice**. Allow the microphone (the prompt is attributed to Dum), then pick and download a speech model; nothing is bundled. Hold `⌃⌥Space` and talk; the text lands in your draft and never sends itself. `⌘⇧↩` sends it.

## Using it

- The window opens chat-first. One slim strip at the top: the zone crumb (click or `⌘K` to switch), the look chip, your goal or "Alignment needed", a **Context** chevron that expands the full Current context block and the zone tree, the Settings cog, and Hide. The Chat header has Mode (understand or anti-vibe), **Menu** (Manage zones, Skills, Memory, History, Context, Evidence, Boundary, Suggested projects, Changes, Full story) and Move circle.
- The circle floats above other apps on every Space. Click it or press `⌘⇧D` to open the window beside it; again to hide it. Its face shows idle, looking, thinking, listening, or a `!` badge when something needs you.
- `Esc` backs out one step at a time: a chooser, menu or form first, then the expanded Context strip, then an open view such as Settings, then it hides the window and hands focus back to the app you were in. `⌘W` hides it too. `⌘.` stops Dum. `Esc` never means Stop or No.
- Every reply from Dum, typed or spoken, and every finished Do this, shows in the click-through bubble near your cursor unless Dum's window is visible and focused. Short replies stay 15 s. Long ones are cut at 8 lines or 600 characters, end with "Open Dum for the full reply", and stay 25 s. A question Dum asks shows with "Dum is waiting for your answer in Dum". Wizard lines carry the Wizard's portrait.
- Zones are what you're learning, like `Programming › Data Structures`, never a folder or Git repo. They nest up to 16 deep. A zone has a goal, an optional language and notes, inherited by the zones inside it. Conversation, memory, direction, handoffs, sessions, suggested projects, change history and followed folders belong to one zone.
- Skills are global, one Markdown note each in `~/.dum/skills/`. Recognize = you explained it, build = you wrote it unaided and said so after a review, apply = you built it and reasoned about when to use it. `not yet` takes back the skill just recorded. The gate is code: concepts need build, tools need recognize, every prerequisite must hold.
- Delegating: a new goal starts alignment, where the Wizard offers directions. **Help me decide** gets two or three options, each labeled Can delegate now, Learn first or Needs a detail. Dum can also hand a choice to the Wizard itself while you're weighing approaches: the transcript shows "Dum asked the Wizard: <why>" and a normal decision card lands after Dum's turn, once per message. Choosing makes a handoff card; nothing runs before **Do this**. Afterwards you see each change's diff with Revert, and **Reviewed…** records your verdict on the trail.
- Changes: if you hold the skills, Dum writes shared or followed files directly, no yes/no step, and shows the diff after. It writes only if the file is byte-for-byte what it last read.
- The look: every 3 seconds Dum checks the front app, how much the screen changed, and saved files in followed folders. When the screen changed, the look model gets one fresh 1280 px picture with Dum's windows painted out. At most one call every 3 seconds and 1,200 an hour, billed to your key. Pause it in Current context. No keystrokes, clipboard or old pictures.
- Settings holds: **Agent** (backend, models, Verify for pictures, API key), **Look**, **Shortcuts**, **Open at login**, **Use personal context**, **Set up voice**, **Debug chat**, the version, **Quit Dum**.
- Stays on the Mac: zones, skills, conversations, memory, evidence, sessions and story (`~/.dum/`), settings and the encrypted key (Electron app data), voice audio and transcripts. Goes to the backend you chose: your messages, zone goal and notes, skills, text of files Dum reads, and for the look one fresh frame per call. No fallback to another backend.

## Contributing

- Dev loop: `npm install && npm run desktop` builds and launches from the checkout. No native helpers, so no voice, no app-switch noticing, no focus return. It also starts on Linux, for development only.
- `npm test`, `npm run typecheck`, `npm run desktop:build && npm run desktop:smoke` (`xvfb-run -a` on Linux).
- Not yet tried on a physical Mac: the circle's click-through corners and drag, Spaces and full-screen, focus return, voice, the look's cost over a real session, launch at login, Gatekeeper. [docs/todo.md](docs/todo.md) has the list.
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
  verified-models.json    Claude model ids this install verified for pictures
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
- Speech models land in `~/Library/Application Support/com.dumintern.opensuperwhisper/` (whisper) or `~/Library/Application Support/FluidAudio/Models/` (Parakeet). After the download, voice never needs network again unless you pick another model.
- Web tree: Skills → Web tree links your tree to a server and opens a private edit link. Sync now, New link and Unlink are there too. Anyone with the link can see and edit that tree. Trees merge skill by skill; zones, sessions, story, conversations, holds and files aren't synced.
- Run the server: `PORT=8787 DUM_WEB_DATA=/srv/dum-trees npm run web`. It listens on localhost by default. Use a TLS reverse proxy or tunnel for remote access.
- The same server serves the public site: `/`, `/install`, `/philosophy`, `/docs`, `/builds` and `/subjects`. Every page gets the same nav from `src/site/nav.html`; only the current page's link is highlighted. Private tree links keep their own capability checks, no-index and no-store headers.
- `/builds` embeds build recordings from YouTube, listed in `src/site/builds.json`. To add one, run `npm run site:add-build -- <youtube link> "<title>" ["<note>"]`, then commit and deploy. Only `/builds` may load YouTube frames.
- `/install` has the requirements and a copyable prompt that has a terminal LLM build and launch Dum from source. The prompt asks before system changes, sign-in, 2FA, secrets, writes outside the chosen folder, or changing an existing project.
- The site favicon is the desktop app icon, drawn by the same renderer (`tools/app-icon.mjs`). After changing `src/art/intern.txt`, run `npm run site:favicon` to regenerate `src/site/favicon.png`.
- Hosting scripts are in `deploy/`: `deploy.sh` tests, syncs the server and restarts it; `setup-hub.sh` installs the service and tunnel route; `skill-tree.service` is the systemd unit. They never run automatically.

</details>

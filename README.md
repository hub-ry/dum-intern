# dum-intern

Dum is a Mac app you delegate to. It sits on screen as one small floating circle with Dum's face, follows what you're learning across your goals, and writes code when you tell it to, but only with skills you've proven or told it to trust. Each goal has one next step, and you can always skip it. The loop: say what you need, agree with Dum what your goal means, pick a piece of work you can hand off now, check the handoff, press Do this, review what came back. Work you haven't proven yet becomes something to learn first. The point is that you could take the AI away and still understand the architecture, start implementing, and ask precise questions.

Site: [dumintern.com](https://dumintern.com), with [install](https://dumintern.com/install) and [docs](https://dumintern.com/docs). How Dum is put together and the rules it follows: [docs/architecture.md](docs/architecture.md).

## Get it

There's no public release of this version yet. You build it on the Mac that will run it, in this order.

1. **Prerequisites.** macOS 13 or later on Apple Silicon or Intel for the app; voice needs macOS 14 or later on Apple Silicon. Node 22.6+ (`brew install node`). For voice, also the full Xcode (not just Command Line Tools, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept`), `brew install cmake`, and Rust through rustup with `rustup target add aarch64-apple-darwin` (Homebrew's `rust` has no rustup and the build refuses it). The build fetches whisper.cpp and Swift packages, so it needs network.
2. **Build.** `npm install && npm run desktop:mac`. The app lands at `release/mac-arm64/Dum.app` on Apple Silicon or `release/mac/Dum.app` on Intel, with a DMG beside it. If `prepare-dictation` stops, its message names the missing tool from step 1.
3. **Install.** Copy `Dum.app` to `/Applications`. The build is ad-hoc signed, not notarized, so right-click → Open the first time. If a DMG that came through a browser makes Dum report "The voice helper stopped" right away, clear quarantine: `xattr -dr com.apple.quarantine /Applications/Dum.app`.
4. **First launch.** Dum's panel opens at "What do you want to work toward?"; the answer is your first goal, with no model call. macOS asks for Screen Recording because the look is on by default. Then **Who powers Dum?**: Claude on your own Anthropic API key, and three models (Dum's model, the helper, and the look model, `haiku` by default). The key must belong to a workspace: a key made outside one fails with "must include the anthropic-workspace-id header". Create it at console.anthropic.com inside a Workspace.
5. **Verify for pictures.** Dum sends screenshots only to a model it has verified. `opus` and `fable` are verified out of the box; for any other Claude model, `haiku` included, Settings → Agent shows **Verify for pictures (one small call)** next to that role. It sends one 2×2 PNG and "Reply with the single word OK." on your key; success is recorded in `~/.dum/verified-models.json` and the look starts sending frames. Until then the look runs on text and Settings says "No pictures: …".
6. **Set up voice.** Settings → **Set up voice**. Allow the microphone (the prompt is attributed to Dum), then pick and download a speech model; nothing is bundled. Hold `⌃⌥Space` and talk; the text lands in your draft and never sends itself. `⌘⇧↩` sends it.

## Using it

- The circle floats above other apps on every Space. Click it and it unfolds into a column of up to seven circles on one translucent capsule: Dum, up to three goals, the skill tree, the Monitor and Settings. The goals are the ones you pinned, or with none pinned the three most recently updated, the active one first. A goal's circle shows its progress and a mark while it has a step. The column folds back after 8 seconds without the pointer over it.
- Click a circle and the column folds into it and opens that circle's panel, with its top-left corner at the circle (flipped left or up near a screen edge). Every panel is dark. `⌘⇧D` opens or hides the panel from anywhere. The face shows idle, looking, thinking, listening, or a `!` badge when something needs you.
- **Dum**: "What do you want to work toward?" and your goals as a nested list. Typing one makes a goal, opens it and pins it (if fewer than three are pinned). Click a row to open the goal; pin and skip are icons that show on hover.
- **A goal**: its name and progress, the step cloud, the chat with a one-line message box (Stop shows only while Dum is working), and a **Path** strip of the goal's skills with ▶ on each. **More** has Edit goal, New goal inside, Delete goal, Suggested projects, Changes and Memory. `⌘K` opens another goal.
- **Skill tree**: Graph or Tree, a track filter, Tidy and **▶ Play**. The graph lays skills out left to right by prerequisite depth, one band per track. Drag the background to pan, scroll or pinch to zoom, drag a node (it springs back toward its place). Built is filled, recognized half-filled, open outlined with a glow, locked dim with a lock, trusted has a dashed ring and a "trusted" tag, and the next one pulses. A node's card has **▶ Work on this**, **Pick … for me** when that skill is the current step, **Skip, trust me** for a skill you don't hold, and **Undo trust**.
- **Monitor**: a big status (● Recording, Paused, or Not recording and why), the look model, the last check, whether pictures are on, Pause/Resume, and the live context log: notes, app switches, skipped looks, errors, pauses and the Wizard's chimes. The log is kept in memory only, up to 200 entries.
- **Settings**: **Agent** (backend, models, Verify for pictures, API key), **Look**, **Mode** (understand or anti-vibe), **Shortcuts**, **Move circle**, **Open at login**, **Use personal context**, **Set up voice**, **Debug chat**, the version, **Quit Dum**.
- Steps: each goal has exactly one next step, one sentence. First "Say what finishing this goal looks like.", then "Pick a project theme or idea.", then the chosen project's next milestone, then the next skill on the goal's path ("Explain what X is for, in your own words", then "Write X yourself, without AI"). The goal's step cloud has a **Pick … for me** button that sends Dum a fixed request as if you typed it, and **Skip**. A step goes away once it's done.
- Skip and trust: skipping a skill step adds that skill as your word at build level. It counts for the gate and shows as trusted, not proven. Beginner skills skip in one click; others ask "Sure? Dum will treat X as known and write it for you." Skipping a goal (the skip icon in the Dum panel, then confirm) trusts every skill on its path you don't hold yet, prerequisites first. Undo trust removes the skill.
- Play: ▶ on a skill makes it the active goal's step. **▶ Play** in the tree picks the next one for you and says why: "Next: X. <why>".
- The bubble is a thought cloud with puffs trailing toward the circle. It has no buttons and clicks go through it. Beside the circle it shows the active goal's step until the step is done, skipped or replaced, hidden only while Dum's panel is in front. When the look sees you stuck (the same error again, undo/redo loops, the same search, a failing test), the Wizard's one-sentence nudge shows there in a purple cloud for 20 seconds, at most once a minute. Near your cursor it shows voice status, and replies from Dum, typed or spoken, and finished Do this: one sentence, plus one Wizard line when the Wizard spoke. The full reply is in the goal's chat.
- `Esc` backs out one step at a time: a confirm, chooser, menu or form first, then an open record or the goal editor, then it hides the panel and hands focus back to the app you were in. On the column, `Esc` folds it. `⌘W` hides the panel too. `⌘.` stops Dum. `Esc` never means Stop or No.
- Goals are what you're learning, like `Programming › Data Structures`, never a folder or Git repo. They nest up to 16 deep. A goal has its text, an optional language and notes, inherited by the goals inside it. Conversation, memory, direction, handoffs, sessions, suggested projects, change history, followed folders and step skips belong to one goal.
- Skills are global, one Markdown note each in `~/.dum/skills/`. Recognize = you explained it, build = you wrote it unaided and said so after a review, apply = you built it and reasoned about when to use it. `not yet` takes back the skill just recorded. The gate is code: concepts need build, tools need recognize, every prerequisite must hold.
- Delegating: a new goal starts alignment, where the Wizard offers directions. **Help me decide** gets two or three options, each labeled Can delegate now, Learn first or Needs a detail. Dum can also hand a choice to the Wizard itself while you're weighing approaches: the transcript shows "Dum asked the Wizard: <why>" and a normal decision card lands after Dum's turn, once per message. Choosing makes a handoff card; nothing runs before **Do this**. Afterwards you see each change's diff with Revert, and **Reviewed…** records your verdict on the trail.
- Changes: if you hold the skills, Dum writes shared or followed files directly, no yes/no step, and shows the diff after. It writes only if the file is byte-for-byte what it last read.
- The look: every 3 seconds Dum checks the front app, how much the screen changed, and saved files in followed folders. When the screen changed, the look model gets one fresh 1280 px picture with Dum's windows painted out. At most one call every 3 seconds and 1,200 an hour, billed to your key. Pause it in the Monitor. No keystrokes, clipboard or old pictures.
- Stays on the Mac: goals, skills, conversations, memory, evidence, sessions and story (`~/.dum/`), settings, pinned goals and the encrypted key (Electron app data), voice audio and transcripts. Goes to the backend you chose: your messages, the goal and its notes, skills, text of files Dum reads, and for the look one fresh frame per call. No fallback to another backend.

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
  zones.json              your goals (stored as zones) and the active one
  verified-models.json    Claude model ids this install verified for pictures
  web.json                optional web tree link
  context.md              optional personal background
  session.lock            one Dum per home
  decisions/runtime/      empty working folder for the Wizard's decision calls
  debug/runtime/          empty working folder for debug chat
  zones/<zone-id>/        one goal
    context.md            notes for this goal, up to 16 KiB
    memory.md             goal memory, up to 16 KiB
    transcript.json       latest 500 entries, up to 4 MiB
    practice.json         suggested projects and hand-ins
    follows.json          followed folders
    changes/<change-id>/  change.json, before, after, change.patch
    direction/            alignment head.json and revisions/<id>.json
    delegations/          current.json, and <handoff-id>/head.json with versions/<n>.json
    context-corrections.json  the observation you told Dum to ignore
    steps.json            skipped steps, the goal's skip mark, the skill being played
    sessions/             index.json, and <session-id>/meta.json, events/, sources/
    story/                cache of the story: head.json and pages/
    runtime/              empty working folder for this goal's model calls
```

- `DUM_HOME` moves all of `~/.dum`. Notes are ordinary Markdown and open in Obsidian.
- Personal background is opt-in: Settings → **Use personal context**, which lists the files it read. It reads `~/.dum/context.md`, or `context.json` with `{"files":["context.md","projects.md"]}` (paths relative to it, up to 16 files, 64 KiB). `DUM_CONTEXT=/path/to/file.md` picks one file and `DUM_CONTEXT=off` disables it. Dum reads the file when its host starts; after editing it, quit and reopen Dum to pick it up.
- Speech models land in `~/Library/Application Support/com.dumintern.opensuperwhisper/` (whisper) or `~/Library/Application Support/FluidAudio/Models/` (Parakeet). After the download, voice never needs network again unless you pick another model.
- Web tree: the skill tree panel's Tree view links your tree to a server and opens a private edit link. Sync now, New link and Unlink are there too. Anyone with the link can see and edit that tree. Trees merge skill by skill; goals, sessions, story, conversations, holds and files aren't synced.
- Run the server: `PORT=8787 DUM_WEB_DATA=/srv/dum-trees npm run web`. It listens on localhost by default. Use a TLS reverse proxy or tunnel for remote access.
- The same server serves the public site: `/`, `/install`, `/philosophy`, `/docs`, `/builds` and `/subjects`. Every page gets the same nav from `src/site/nav.html`; only the current page's link is highlighted. Private tree links keep their own capability checks, no-index and no-store headers.
- `/builds` embeds build recordings from YouTube, listed in `src/site/builds.json`. To add one, run `npm run site:add-build -- <youtube link> "<title>" ["<note>"]`, then commit and deploy. Only `/builds` may load YouTube frames.
- `/install` has the requirements and a copyable prompt that has a terminal LLM build and launch Dum from source. The prompt asks before system changes, sign-in, 2FA, secrets, writes outside the chosen folder, or changing an existing project.
- The site favicon is the desktop app icon, drawn by the same renderer (`tools/app-icon.mjs`). After changing `src/art/intern.txt`, run `npm run site:favicon` to regenerate `src/site/favicon.png`.
- Hosting scripts are in `deploy/`: `deploy.sh` tests, syncs the server and restarts it; `setup-hub.sh` installs the service and tunnel route; `skill-tree.service` is the systemd unit. They never run automatically.

</details>

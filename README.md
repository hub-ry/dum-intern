# dum-intern

- Dum is a Mac app that stays on in the menu bar. It follows what you're learning across a tree of zones and writes code on command, but only with skills you've proven.
- The goal: you could take the AI away and still understand the architecture, start implementing, and ask precise questions.
- How Dum is put together, and the rules it follows: [docs/architecture.md](docs/architecture.md). User docs: [/docs](src/site/docs.html) on the site.

## Get it

- No public release of this version yet. Build it from source (below).
- Test builds come from the [desktop macOS workflow](https://github.com/hub-ry/dum-intern/actions/workflows/desktop-macos.yml) on pushes to `main`: public flavor, ad-hoc signed, not notarized. GitHub only lets signed-in users download them.
- The older test prerelease on the releases page predates zones and doesn't match this README.
- Needs macOS 13+, Apple Silicon or Intel. Voice needs macOS 14+ on Apple Silicon.
- Needs a backend: your own Anthropic API key for Claude, or models running locally in Ollama or LM Studio. Local builds can also use a Claude subscription.
- The app carries its own Claude Code. Nothing else to install for Claude.

## Using it

- First launch asks "What are you trying to learn?". The answer becomes your first zone, with no model call. macOS also asks for Screen Recording permission, because the look is on by default.
- Then "Who powers Dum?" picks a backend, Dum's model and a helper model. Zones, skills, notes and model-free commands work before that.
- Zones are what you're learning, like `Programming › Data Structures`, never a folder or Git repo. They nest up to 16 deep. A zone has a goal, an optional language and notes, which the zones inside it inherit. Conversation, memory, suggested projects, change history and followed folders belong to one zone.
- Skills are global, one Markdown note each in `~/.dum/skills/`, scoped to a language or none. Recognize = you explained it, build = you wrote it unaided and said so after a review, apply = you built it and reasoned about when to use it. `not yet` takes back the skill just recorded and holds it until you build it again.
- The gate is code: concepts need build, tools need recognize, and every prerequisite must hold.
- Menu bar: Ask Dum…, Open Panel, Switch Zone, Start Voice, Send Draft, Pause the Look, Quit Dum. No Dock icon.
- Command bar: `⌘⇧D` from anywhere. Return sends, Esc goes back and returns focus to your previous app, `⌘K` switches zone, `⌘.` stops.
- Voice: hold `⌃⌥Space`. A bundled OpenSuperWhisper transcribes on the Mac into your draft; it never sends itself. A click-through bubble near the cursor shows the draft and Dum's reply. `⌘⇧↩` sends the draft.
- Everything works from the keyboard. All three shortcuts can be changed in Settings.
- Changes: ask Dum to change a file you shared or follow, and if you hold the skills it writes the file directly. No yes/no step. The diff shows after, with one-click Revert. Dum writes only if the file is byte-for-byte what it last read, so it never writes over your editor's save. Revert refuses if you've edited since.
- The look: every 3 seconds Dum checks the front app, how much the screen changed (a 64×40 gray grid, never sent), and saved files in followed folders. It calls the helper model only when something changed and settled, at most 40 times an hour. Pause it from the menu bar, the panel or Settings. Without Screen Recording it uses app switches and saved files only.
- Suggested projects: `:projects new` or `:projects <skill>`; `:submit pN <file> --unaided` hands in your work milestone by milestone. No guided practice or courses.
- The Wizard speaks up rarely, citing a fixed catalog of primary sources, and stays quiet when nothing fits.
- `:help` lists commands. Full user docs are on the site at `/docs`.

## Backends and build flavors

- Claude: API key, or subscription sign-in in local builds only. Defaults `claude-opus-5-5` for Dum and `claude-fable-5-1` for the helper, both at high effort.
- On this Mac: Ollama (`127.0.0.1:11434`) or LM Studio (`127.0.0.1:1234`). Loopback only; Ollama cloud models are refused. LM Studio is text-only.
- ChatGPT sign-in is built but switched off (`RELEASED` in `src/agent/registry.ts`).
- Dum's model and the helper come from one backend. No fallback to another backend.
- Every build is `public` or `local`, written to `dist/desktop/build-info.json` at build time. Public builds never offer Claude subscription sign-in. Missing or unreadable build info means public.
- The API key is encrypted with Electron `safeStorage` in Dum's app data. Subscription sign-in is the bundled Claude Code's, and signing out also signs Claude Code out.

## Privacy

- Stays on the Mac: skill tree, zones, conversations, memory, evidence, suggested projects and change records (`~/.dum/`), settings and the encrypted key (Electron's app data folder), voice audio and transcripts, routine screen samples.
- Goes to the chosen backend: messages, zone goal and notes, skills and boundary, recent conversation, text of files Dum reads, and for the look the front app's name, saved-file diffs and sometimes one screen frame.
- Claude sends to Anthropic. On this Mac sends only to the local server.
- The optional web tree gets only skills and removals.
- No keystroke, clipboard or passive audio capture.

## Build and test

Needs Node 22.6+.

```sh
npm install
npm run desktop            # local-flavor build, launched from the checkout
npm run desktop:mac-local  # packaged local-flavor Mac app
npm run desktop:mac        # public-flavor DMG and ZIP, run on a Mac
npm run desktop:pack       # public-flavor unpacked app for this OS
npm test
npm run typecheck
npm run desktop:build && npm run desktop:smoke   # xvfb-run -a on Linux
```

- `npm run desktop` has no native helpers: no voice, no app-switch noticing, no focus return. Packaging builds them; voice builds only on Apple Silicon and needs Xcode, cmake, and Rust with `aarch64-apple-darwin`.
- Not yet tried on a physical Mac: voice, the focus helper, Screen Recording prompts and capture, tray rendering, the bubble over full-screen apps, launch at login, Keychain-backed key storage, subscription sign-in, Gatekeeper on first launch.
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
  zones/<zone-id>/
    context.md            notes for this zone, up to 16 KiB
    memory.md             zone memory, up to 16 KiB
    transcript.json       latest 500 entries, up to 4 MiB
    practice.json         suggested projects and hand-ins
    follows.json          followed folders
    changes/<change-id>/  change.json, before, after, change.patch
```

- `DUM_HOME` moves all of `~/.dum`. Notes are ordinary Markdown and open in Obsidian.
- Personal background is opt-in: Settings → "Use my personal context file for suggestions". It reads `~/.dum/context.md`, or `context.json` with `{"files":["context.md","projects.md"]}` (paths relative to it, up to 16 files, 64 KiB). `DUM_CONTEXT=/path/to/file.md` picks one file and `DUM_CONTEXT=off` disables it.
- Web tree: Settings → Web tree links your tree to a server and opens a private edit link. Sync now, New link and Unlink are there too. Anyone with the link can see and edit that tree. Trees merge skill by skill; zones, conversations, holds and files aren't synced.
- Run the server: `PORT=8787 DUM_WEB_DATA=/srv/dum-trees npm run web`. It listens on localhost by default. Use a TLS reverse proxy or tunnel for remote access.
- The same server serves the public site: `/`, `/install`, `/philosophy`, `/docs`, `/builds` and `/subjects`. Every page gets the same nav from `src/site/nav.html`; only the current page's link is highlighted. Private tree links keep their own capability checks, no-index and no-store headers.
- `/builds` embeds build recordings from YouTube, listed in `src/site/builds.json`. To add one, run `npm run site:add-build -- <youtube link> "<title>" ["<note>"]`, then commit and deploy. Only `/builds` may load YouTube frames.
- `/install` has the requirements and a copyable prompt that has a terminal LLM build and launch Dum from source. The prompt asks before system changes, sign-in, 2FA, secrets, writes outside the chosen folder, or changing an existing project.
- The site favicon is the desktop app icon, drawn by the same renderer (`tools/app-icon.mjs`). After changing `src/art/intern.txt`, run `npm run site:favicon` to regenerate `src/site/favicon.png`.
- Hosting scripts are in `deploy/`: `deploy.sh` tests, syncs the server and restarts it; `setup-hub.sh` installs the service and tunnel route; `skill-tree.service` is the systemd unit. They never run automatically.

</details>

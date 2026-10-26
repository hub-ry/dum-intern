# dum-intern

- A minimal pairing interface with a skill tree alongside it. [dumintern.com](https://dumintern.com/) opens on **Pair**: Dum's screen area, the original intern logo below it, and a message draft on the side.
- Pair is currently interface-only. The screen and progress area say offline, and Send is disabled. It doesn't simulate activity or send messages. Drafts survive tab switches; reloading clears them. For sign-out behavior, see [Workspace and hosting](#workspace-and-hosting). No agent, screen capture, or private desktop is connected.
- In **Skill tree**, enter something you want to learn and choose **Add to tree**. Each topic becomes one saved, locked root block. Existing goals remain in the tree; **Workspace tools** keeps the outline editor, builds, and hints out of the main navigation.
- Light/dark mode follows the system until you choose a theme. The choice is saved in this browser. The serif type and paper-like layout stay the same in both modes.
- Read a block's PDF to the last page to unlock it. If you already know it, swear that in a sentence instead.
- A build is an ordered stack of unlocked blocks. Saving one records the stack; it doesn't generate a program. Read and sworn are unlock records, not measurements of mastery.
- Teaching papers are written and compiled locally in Cursor with the [`dum-paper` skill](skills/dum-paper/SKILL.md). The server writes reading briefs and serves PDFs you put in the workspace. It doesn't generate or compile papers.
- This repo contains the public web product, its workspace template, and its Cursor skill. No Discord bot, private workshop, internship automation, or CLI/MCP bridge.

See [How it works](https://dumintern.com/docs) for goal outlines, readings, builds, and hints.

## Run locally

Requires Node 24 or newer and `pdfinfo` from Poppler (`sudo apt install poppler-utils` on Ubuntu). Tectonic is needed on the machine where Cursor compiles papers, not on the server.

```sh
npm ci
npm start
```

Open `http://127.0.0.1:8074/`. Pair opens without an account; choose **Skill tree** and sign in to save topics. `npm run dev` watches the product server. PDF.js loads only when opening a reading; no sibling repository is required.

Sign in with your GitHub username and a one-time public gist named `dum-login`, following the instructions in the app. Check the gist in the same browser that requested the code, then delete it after signing in. GitHub OAuth is optional: set both `DUM_GITHUB_CLIENT_ID` and `DUM_GITHUB_CLIENT_SECRET`, and register `/auth/github/callback` on your app's public origin as the callback URL.

## Workspace and hosting

- The default state directory is `~/.local/state/dum-product`. Each GitHub account gets its own directory under `users/<github-id>/`, with an account record and a `dum/` workspace.
- The workspace contains `goal.md`, `tree.json`, `learn.sty`, `readings/`, and `builds/`. [`template/dum`](template/dum) is the starting folder. Choose your username in the navigation to select another root; only the hub owner can select an absolute path under their home directory.
- Cursor writes each paper from `readings/<block-id>.brief.json`, using the shared LaTeX style. Put the compiled PDF at the brief's `pdf` path in the **server's** workspace. The site does not sync a separate local copy or upload PDFs for you.
- Workspaces aren't published automatically. Publishing your folder in a public repo is your choice. Back up the state directory, including `session.key`; the app creates that key on first startup.
- Signing out clears the local account and drafts immediately and invalidates old workspace work. Sign-in stays unavailable until the sign-out response settles. Pair remains usable, and new guest drafts survive that response. If the server can't complete sign-out, the page tells you to reload and retry; it doesn't claim that your session ended.
- `HOST` defaults to `127.0.0.1` and must be loopback. `PORT` defaults to `8074`. `DUM_PRODUCT_STATE` overrides the state directory; `DUM_PDFJS` optionally overrides the directory containing PDF.js's `pdf.min.mjs` and `pdf.worker.min.mjs`.
- [`deploy/dum-product.service`](deploy/dum-product.service) is the hub systemd unit. Adjust its user and paths for another machine. Terminate HTTPS at a reverse proxy or tunnel pointing to the loopback port.

## Development

```sh
npm run typecheck
npm test
```

- `src/product/`: GitHub sign-in, workspace storage, skill-tree rules, and HTTP server.
- `src/site/`: pairing surface, skill-tree UI, shared light/dark theme, and PDF reader.
- `template/dum/`: files copied into a new workspace.
- `skills/dum-paper/`, `.cursor/skills/`, `.cursor-plugin/`: Cursor paper-writing skill and discovery metadata.
- CI installs dependencies, typechecks the server, and runs the product tests. For UI changes, exercise the app in a browser too.

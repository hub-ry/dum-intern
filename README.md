# dum-intern

[dumintern.com](https://dumintern.com/) is Dum's public-facing site. It introduces the project in the original paper-like layout, with serif body text, monospace navigation, and a light/dark toggle. Theme choice is saved in the browser.

Dum's intended product is a local pair-programming companion: a terminal command opens a localhost app with screen sharing, a conversation beside the screen, and a learning-topic skill tree. The launcher and screen-sharing runtime aren't implemented in this repo yet. The website is an introduction, not that runtime.

The [public explanation](https://dumintern.com/docs) describes this direction. This repo also retains the existing hosted workspace, its template, and its Cursor paper-writing skill. No Discord bot, private workshop, internship automation, or CLI/MCP bridge.

## Run locally

Requires Node 24 or newer. The existing workspace's PDF reader also needs `pdfinfo` from Poppler (`sudo apt install poppler-utils` on Ubuntu). Tectonic is needed on the machine where Cursor compiles papers, not on the server.

```sh
npm ci
npm start
```

Open `http://127.0.0.1:8074/` for the public landing page. This starts the website server, not the planned local Dum launcher. `npm run dev` watches the server.

## Existing workspace

`/app` retains the earlier hosted workspace and its saved data. It isn't the public homepage or the planned local pairing runtime, and public navigation doesn't link to it.

- In **Skill tree**, enter a topic and choose **Add to tree** to save one locked root block. **Workspace tools** holds goal outlines, builds, and hints. An outline has one block per line, with two spaces indenting a child; leaving it empty creates the five-block starter tree.
- Read a block's PDF to the last page to unlock it, or swear that you already know it in a sentence. Read and sworn are unlock records, not measurements of mastery.
- A build is an ordered stack of unlocked blocks. Saving it records the stack, not a generated program.
- Teaching papers are written and compiled locally in Cursor with the [`dum-paper` skill](skills/dum-paper/SKILL.md). The server writes briefs and serves PDFs you put in the workspace; it doesn't generate or compile papers. PDF.js loads only when opening a reading.
- The retained Pair tab is an offline interface with Send disabled. It doesn't connect to a desktop, stream a screen, or simulate activity. Drafts survive tab switches and clear on reload; sign-out behavior is described below.

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
- `src/site/`: public landing page and explanation, shared light/dark theme, and the retained browser workspace and PDF reader.
- `template/dum/`: files copied into a new workspace.
- `skills/dum-paper/`, `.cursor/skills/`, `.cursor-plugin/`: Cursor paper-writing skill and discovery metadata.
- CI installs dependencies, typechecks the server, and runs the product tests. For UI changes, exercise the app in a browser too.

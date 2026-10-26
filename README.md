# dum-intern

A chess player stuck at 1800 spent two years there, then reached 2000 in four months by teaching his girlfriend chess. dum-intern does that for programming.

You have an AI intern on a real computer. It can only do what you have taught it. Each skill is a node on a tree. A node stays locked until you explain it in your own words. That explanation is saved as a markdown note, and it becomes the instruction the intern follows. Explaining it is how you learn.

If a task needs a locked skill, the intern stops and names that node. It does not improvise. It can research and suggest a better way, but the suggestion shows up as a **proposed** node. You have to learn it and teach it. The intern never uses a proposal on its own.

dum-intern is one half of the dum-stack. The other half is dum-learn, a learn-when-stuck site. This repo is the intern.

## What you see

The window is a dark, VS Code-like layout:

- **Center:** the intern's computer. With no Maritime key this is a fake VS Code window and terminal. With `MARITIME_API_KEY` set, it is the live desktop (a watch link, plus a command log of what the intern actually ran), even when the intern itself is still scripted.
- **Right:** chat. Teach a skill here, or give the intern a task. Hold the mic button, or hold Alt, to dictate with the browser Web Speech API. Text works without that.
- **Left:** the skill tree. Nodes are locked, unlocked, or proposed. Click a locked node whose prerequisites are unlocked and a lesson starts. The intern asks one or two questions. Save, and the node unlocks.

The tree starts with 14 beginner and intermediate nodes: terminal basics, files and paths, reading errors, reading docs, git basics, git branching, environment and config, Python scripts, functions and modules, HTTP requests, writing tests, shell scripts, Docker basics, and debugging.

## Run it

Requires **Node >= 22.13**. Startup uses the built-in `node:sqlite` module (`node --experimental-sqlite`). That module is not in older Node releases, and `npm start` fails there. `package.json` sets `"engines": { "node": ">=22.13" }`.

```sh
npm ci
npm start
```

Open http://127.0.0.1:8074/. `npm run dev` restarts when files under `src/` change.

`HOST` defaults to `127.0.0.1` and `PORT` defaults to `8074`. Point cloudflared, or any other tunnel, at that loopback port. Anyone who can open the URL can teach the intern and, in live mode, drive the desktop. The tunnel is the lock on the door.

### Mock mode

Mock mode is the default when `MARITIME_API_KEY` is unset. The desktop is drawn in the page, and the intern follows a script (it also stays scripted whenever `LLM_API_KEY` is unset):

1. Click **Terminal basics**, explain it, answer the question, and press **Save skill**. The node unlocks and a markdown note is written.
2. Ask it to `create a git branch called feature`. It refuses and names **Git branching**.
3. Ask it to `list the files in the home directory`. It plans, then the terminal shows `ls`.

No keys, no account, no network calls.

### Desktop only

Set `MARITIME_API_KEY` and leave `LLM_API_KEY` empty. The page shows the live Maritime desktop, and the scripted intern runs those same commands on it. The title bar says **Live**. The status bar says **scripted intern** rather than a model name. Teaching still uses the scripted questions.

### Live mode

Copy `.env.example` to `.env` and fill in both keys. `npm start` and `npm run dev` load `.env` when that file is present (`node --env-file-if-exists=.env`). A variable already set in the environment wins. Tests do not load `.env`. The title bar switches from **Mock** to **Live**, and the status bar names the model.

The intern calls an OpenAI-compatible chat completions API. DeepSeek is the default (`https://api.deepseek.com`, model `deepseek-chat`). Unlocked notes are the only skill text in the prompt. Locked and proposed nodes are listed by name so the intern can refuse them, without their instructions.

On a task it must call a `plan` tool before any computer tool. Plan steps are shown as a numbered list. If the plan names a locked skill, the server stops the turn and shows every step, then names that node. Shell commands are checked again before they run: `docker`, `git`, `pytest`, `python`, and `curl` are refused unless that skill is unlocked.

When a task shows a better approach or a natural next skill that is not already on the tree, the prompt tells the intern to propose that node once and keep using only the taught method. A proposal stays unused until you teach it.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LLM_API_KEY` | for a model intern | empty | Bearer token for the chat API. Empty keeps the intern scripted. |
| `LLM_BASE_URL` | no | `https://api.deepseek.com` | OpenAI-compatible origin. `/chat/completions` is appended. |
| `LLM_MODEL` | no | `deepseek-chat` | Model name sent in the request. |
| `MARITIME_API_KEY` | for a real desktop | empty | Maritime bearer key, `mk_...`. Set it to use the real computer, including when the intern is scripted. Empty draws the fake desktop. |
| `MARITIME_API_BASE` | no | `https://api.maritime.sh` | API origin from the Computers docs. |
| `HOST` | no | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0`. |
| `PORT` | no | `8074` | Listen port. |
| `DUM_STATE` | no | `./data` | SQLite database, chat, and exported notes. |
| `DUM_PACE_MS` | no | `380` | Pause between mock desktop steps. Tests use `0`. |

The Maritime key needs the `computers` scope, or a manage / full-access key. Dashboard browser sessions cannot call `/api/v1/computers`. Create the key from the Computers section of Maritime settings. It stays on this server. The browser only receives a short-lived watch link.

One desktop is created per install, with external user id `dum-intern`, and reused after that. The integration follows the [Computers guide](https://maritime.sh/docs/computers), the [REST API](https://maritime.sh/docs/api), and the [OpenAPI spec](https://api.maritime.sh/openapi.json): get-or-create, wake, exec, file read/write, a watch viewer, and screenshots. Screenshot bytes from the API are a **1024×640** JPEG. That is smaller than the 1200×750 model frame described in the computers docs.

Commands run under `bash -c`, not a login shell. On this image `bash -l` resets `HOME` to `/`, so `~` would list the root directory. Each command also appends to `/home/desk/work/session.log`. The desktop setup script is one `bash -c` program with its lines separated by newlines (joining them with spaces is a syntax error). It opens `xfce4-terminal` on `tail -n +1 -f` of that log only when no `tail` is already following it. The guard is `pgrep -x tail` plus a check that `/proc/<pid>/cmdline` contains `session.log`. `pgrep -f` matches the setup script's own arguments, so a second start would still open another terminal.

Before the editor opens, setup writes `/home/desk/.config/Code/User/settings.json` if that file is missing. The settings turn off the welcome page, Copilot and chat, telemetry, and updates, so VS Code 1.143 does not cover the terminal with a sign-in window. The same setup looks for `code`, then a user-local install at `/home/desk/opt/vscode`, then `codium`. If none of those exist it starts Mousepad immediately and downloads the official VS Code linux-x64 tarball in the background (`https://update.code.visualstudio.com/latest/linux-x64/stable`) into `/home/desk/opt/vscode`. Exec calls are capped at 30 seconds, and the desktop user may not have sudo, so the download is `nohup`'d and the next successful install launches `bin/code` on `/home/desk/work`. The model is told to use the shell and files, not the mouse.

## Skills on disk

SQLite (`data/dum.sqlite`) is the source of truth. Saving a lesson also writes `data/skills/<id>.md`. **Export markdown** downloads those notes as a zip. An individual note is at `/api/skills/<id>.md`.

Reset, in the skill pane, locks the seed tree again, deletes proposed nodes, and clears the chat. The Maritime computer id is forgotten locally; the same external user id gets the same desktop back.

## Docker

```sh
docker build -t dum-intern .
docker run --rm -p 8074:8074 -e HOST=0.0.0.0 dum-intern
```

Pass `LLM_API_KEY` and `MARITIME_API_KEY` the same way when you want live mode. Mount a volume on `/app/data` if the notes should outlive the container.

## Development

```sh
npm run typecheck
npm test
```

Keyboard: Enter sends, Shift+Enter inserts a newline, hold Alt or the mic button to dictate, Ctrl+Shift+E focuses the tree, Ctrl+Shift+M focuses chat, J/K move in the tree, Ctrl+S saves a lesson that is ready to save. `?` opens the list in the app.

Voice uses the browser's Web Speech API (`SpeechRecognition`). Chromium sends audio to its speech service. Firefox often has no implementation, and the button disables itself there.

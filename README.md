# dum-intern

Study a small idea, try it, and teach Dum what you understood. Dum builds a real little creation from that teaching and prepares a flip-through walkthrough: screenshots, actual code, and an explanation from your intern. Reading it does not call a model.

[The product plan](docs/workshop-plan.md) records the learning loop and design decisions. This replaces the earlier desktop app and skill-gated automation stack; that implementation remains in Git history.

## What works

- Private goals, editable global/per-goal context, immutable teaching records, and labelled attempt/progress history.
- Study materials and graded reasoning exercises for loops, conditions, and combining them. Other teaching can be recorded, but this is not an all-subject curriculum.
- Manual builds or an optional interval schedule. The hub process keeps working when the browser or laptop closes.
- A bounded, interactive HTML/JavaScript creation generated through the authenticated Claude Code CLI. The host validates its source without running generated JavaScript.
- Offline Docker/Playwright verification of clicks, inputs, exact observed output, and real screenshots. Failed builds stay failed; no fabricated presentation or automatic retry.
- A fixed manga reader with Dum/Wizard glyphs, keyboard navigation, saved page position, and version links such as `/#job=<job-id>`.
- Corrections create another verified version without replacing the original.

Teaching affects Dum's persistent context and creation choices. It does not retrain the model. Graded answers and self-reports are recorded separately; neither a polished creation nor a single explanation establishes mastery.

## Run the workshop

Use Node 24, Docker, and a logged-in Claude Code CLI with access to the selected model. The service user needs Docker access. Builds use your CLI authentication; no separate model API key is required by this implementation.

```sh
npm ci
claude auth status
docker build -f src/workshop/publisher.Dockerfile -t dum-workshop-browser:1 .
npm start
```

Open `http://127.0.0.1:8770/`. Generated artifacts use the separate origin `http://127.0.0.1:8771/` and are embedded in sandboxed frames. Do not put those ports behind a public tunnel: artifact links are not authenticated.

For access over a trusted private network, set `DUM_WORKSHOP_HOST` to the host's private address and `DUM_WORKSHOP_TOKEN` to a long random secret. Non-loopback startup requires a token. Enter that secret in the workshop login; do not commit it.

| Environment variable | Default / purpose |
| --- | --- |
| `DUM_WORKSHOP_HOME` | `~/.local/state/dum-workshop`; private records and artifacts |
| `DUM_WORKSHOP_HOST` | `127.0.0.1` |
| `DUM_WORKSHOP_PORT` | `8770`; private UI/API |
| `DUM_WORKSHOP_ARTIFACT_PORT` | `8771`; separate artifact origin |
| `DUM_WORKSHOP_TOKEN` | Required for non-loopback access |
| `DUM_CLAUDE_EXECUTABLE` | `claude`; override for systemd PATH |
| `DUM_WORKSHOP_MODEL` | `fable` |
| `DUM_WORKSHOP_EFFORT` | `medium` |
| `DUM_WORKSHOP_BROWSER_IMAGE` | `dum-workshop-browser:1` |

Persisted state belongs outside the checkout. Only one process may own a workshop home. Stop the existing service before starting a second instance against the same home. Interrupted jobs are requeued using a fresh artifact directory after restart.

## Run on hub

`deploy/dum-workshop.service` is a user service. Set its working directory for your checkout and keep a mode-600 environment file at `~/.config/dum-workshop/environment`. Include a PATH containing Node, Claude, and Docker.

```sh
install -D -m 644 deploy/dum-workshop.service ~/.config/systemd/user/dum-workshop.service
systemctl --user daemon-reload
systemctl --user enable --now dum-workshop.service
journalctl --user -u dum-workshop.service
```

Enable user lingering if the process must continue after logout: `loginctl enable-linger "$USER"`. Browser closure does not stop systemd.

## Verify

```sh
npm run typecheck
npm test
```

`npm run dev` watches backend source. The deterministic tests cover persistence, progress evidence, scheduling, revision history, restart recovery, and filesystem boundaries. Full creation verification additionally requires the real CLI and Docker; it is not a mocked CI model call.

The backend has been exercised through the actual browser with original and corrected shelter creations, exact boundary-case output, saved reader position, authentication, process restart, and a build completed after closing the browser. The public product site and notes reader have also been exercised on desktop/mobile; note creation and revision use the authenticated CLI.

## Public site and learning journal

`https://dumintern.com/` is a separate static product site. `/demo/` contains six real screenshots and matching excerpts from a verified example, explicitly not a learner-progress record. It exposes no workshop login or API.

```sh
bash deploy/deploy.sh
```

This installs public files in `/opt/dum-public` and runs the hardened `dum-public.service` on loopback port 8070. The earlier public service is stopped and disabled; existing unrelated stored data is not deleted.

`https://notes.ryhub.dev/` is a plain, read-only topic/deck journal through the existing Cloudflare Tunnel. Provision `/var/lib/dum-notes` for the private publisher, readable by the separate static service, and add `DUM_PUBLIC_NOTES_DIR=/var/lib/dum-notes` to the private environment file. Restart the workshop to generate the empty public index, then:

```sh
bash deploy/deploy-notes.sh
npm run note -- create --title "Title" --topic "Topic" --file pages.json
npm run note -- revise --id <note-id> --title "Title" --topic "Topic" --file pages.json
npm run note -- list
```

The notes service reuses the same static server on loopback port 8071. Cloudflare's `notes.ryhub.dev` ingress points there, not to the private API. Public GET/HEAD requests can read pages; public mutations are rejected.

`pages.json` is an array of `{ "heading": "...", "text": "...", "code": "optional" }` pages, or `{ "pages": [...], "links": [{ "label": "...", "url": "https://..." }] }`. The CLI reads the private environment file literally, authenticates to the workshop, and never writes public files directly. Public content is explicitly selected; no context, attempts, or teaching history is automatically exported. Private note revisions are immutable; only their escaped HTML projection is served publicly.

The reusable [dum-publish skill](.claude/skills/dum-publish/SKILL.md) documents the complete payload, API, hosting, and privacy rules.

## Files

- `src/workshop`: private runtime, materials, API, reader, generation, and isolated verifier.
- `src/art`: authored Dum and Wizard glyphs.
- `src/site`: public product site and an explicitly labelled example presentation.
- `src/public`: static-only public hosting; no workshop credentials or private APIs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution conventions.

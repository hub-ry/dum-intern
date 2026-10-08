# Dum LLM setup design

Status: design for the revamp. No slice is implemented, and no native Mac or real-model check has been run for it. The owner's decisions of 2026-10-08 are folded into the body; §10 lists what is still open.

Terms follow `docs/architecture.md`: functions the model calls are **actions** (a **tool** is a skill kind), a file Dum writes on command is a **change**, and **practice** means suggested projects only. Provider API fields with "tool" in the name (`tools: []`, `availableTools`, `delta.tool_calls`) keep their wire names. **The look** is the 3-second local check in §6.1; an **ambient call** is a model call it triggers.

## 1. Decision

Dum uses one in-process agent contract with two halves: `BackendSetup` (status and sign-in), which Electron main runs, and `AgentBackend` (model catalog and sessions), which the desktop utility host runs. The first wave has three backends: Claude through the Claude Agent SDK; ChatGPT through Sign in with ChatGPT (SIWC) and the Responses API, released once its contract tests pass; and a Dum-owned loop for local Ollama and LM Studio endpoints, with LM Studio text-only. Each exposes only Dum's registered actions. The user picks the backend and both models (rule 11, `docs/architecture.md:77`). GitHub Copilot SDK is second wave, gated by a live lockdown probe. ACP is not the core abstraction.

How Claude signs in depends on the build flavor (rule 12, `docs/architecture.md:78`). A **public** build, the one Dum distributes, connects Claude only with the user's own Anthropic API key and never offers claude.ai subscription sign-in. A **local** build, the owner's own or development build, may also use the subscription sign-in. Dum does not contact Anthropic about either path. ChatGPT sign-in is offered in both flavors: the research found SIWC sanctioned for open-source and locally hosted apps, with paid or hosted apps needing OpenAI's interest form (`docs/agent-runtime-research.md:102`). §8.3 defines the flavor flag.

A harness is used only for what it uniquely gives: a sanctioned sign-in route, or loop and streaming plumbing. No backend gets its own filesystem, shell, web, MCP, plugin, hook or context authority, and every backend keeps the invariants in §3. The research recommends the same three first-wave families and the same boundary (`docs/agent-runtime-research.md:9-22,130-160,311-342`).

**Model calls run in the desktop host.** This is decided. Rule 5 allows model calls in the host and in Electron main (`docs/architecture.md:71`); running all of them in the host is a deployment choice within it. The host runs the conversation, helpers, Wizard asides, ambient calls and picture descriptions. Main runs browser OAuth, the Claude sign-in process, token refresh, `safeStorage`, settings, windows, native capture, the 3-second tick and protocol routing, and calls no model. The reason: `Store`, the gate and request bindings live in the host, so one process resolves `AgentChoice`, opens sessions and drops stale results; calls in main would need a second `AgentChoice` and a token path there (`docs/agent-runtime-research.md:147,478`). Revamp §6 also lists model calls under "must not own" for main (`docs/revamp-design.md:257-258`).

## 2. Candidates considered

| Candidate | Result | Why |
| --- | --- | --- |
| **One agent contract, with Claude/Copilot harness adapters and Dum-owned HTTP loops** | **Chosen** | Matches the research. Harness SDKs call Dum's gated actions in-process; Dum controls the exact request body for SIWC and local endpoints. Claude's reported action list can be checked at runtime, and HTTP lockdown is structural (`docs/agent-runtime-research.md:9-16,130-151,311-342`). |
| **ACP as the core protocol** | Rejected for now | ACP standardizes transport, streaming and images, but has no standard way to remove or list an agent's own filesystem, terminal, hook, plugin or MCP functions. Dum would also need a stdio or HTTP shim that moves the `Store`-closing handlers out of the host. Add an ACP adapter per agent only once it has a source-verified lockdown recipe and a runtime check (`docs/agent-runtime-research.md:63-92,153-160`). |
| **Dum-owned loop for every backend, including Claude** | Rejected | It would discard the subscription route local builds keep, the bundled runtime and the `assertProvider`/`assertSubscription` checks. A Dum loop fits HTTP APIs; it is no reason to replace the current Claude isolation (`src/runtime.ts:153-226`; `docs/agent-runtime-research.md:26-45`). |
| **Anthropic Messages API in the Dum loop for API-key Claude** | Rejected for the first wave | Local builds still need the SDK for the subscription, so this would be a second Claude implementation. The SDK accepts an API key through its child env (§4.2), which keeps one Claude path for both flavors. |

## 3. Product and process invariants

- First launch asks only for the learning goal and creates the root zone locally, without sign-in. The first model-backed action opens backend setup (`docs/revamp-design.md:132-140`; `docs/agent-runtime-research.md:365`).
- Zones are context, never permission; a focus skill unlocks nothing. The host rechecks current skills, prerequisites, language and holds before every change. A model's plan or suggestion is never build evidence (`docs/architecture.md:48-77`; `docs/revamp-design.md:142-181`).
- The model sees only Dum actions (`docs/architecture.md:57`).
- The user's editor stays authoritative (rules 6 and 7, `docs/architecture.md:72-73`). On an explicit permitted command the host checks the gate, compares the file's current bytes with the hash the model read, writes the change, stores the before/after artifact in the zone and returns the diff. If the file changed since that read, it refuses. Revert is a separate UI action, bound to the artifact and a fresh hash of the current file.
- Always on (rule 8, `docs/architecture.md:74`): Dum looks every 3 seconds at local signals (§6.1) and calls a model only when one of them changed (§6.2). A tick never calls a model. Dum does not read keystrokes, the clipboard or editor buffers (`docs/overhaul-goal.md:6,58`; `docs/revamp-design.md:232`).
- A public build never offers or accepts a Claude subscription session. The flavor is fixed when the app is built; no environment variable, setting or renderer request changes it (§8.3).
- A route never silently falls back to another backend, sign-in method or selector. A missing, unverified or failing selector is shown with a recovery action (`src/runtime.ts:21-32`; `docs/agent-runtime-research.md:353`).

## 4. Setup flow

### 4.1 Common first launch

1. The host initializes the app-owned home, writer lock and zone registry. The renderer shows the learning-goal question, not a Git chooser or login.
2. The user types or dictates a goal into the canonical draft; voice fills it and never sends. Enter/Send creates the root zone transactionally; an empty or cancelled goal creates nothing. No model call (`docs/revamp-design.md:132-140,236`).
3. Settings, zones, tree, history and local notes work without a backend (`docs/revamp-design.md:426`). The look's local ticks run without one too, but no ambient call is made until a backend is chosen.
4. The first request that needs Dum or Wizard model work pauses at **Who powers Dum?**. No request text, shared file, image, personal context or transcript goes to any backend before setup completes, the same withholding `runtime.start` enforces today (`src/runtime.ts:228-273`).
5. Main runs every released backend's `BackendSetup.status()` in parallel and shows one row per backend: booleans and one sentence, never an email, organization, token, key, auth JSON, CLI output or prompt, as `RuntimeSetup` does for Claude today (`src/desktop/runtime-setup.ts:1-3,120-178`). The Claude row lists only the sign-in methods the build flavor allows (§4.2). Ready rows sort first; if exactly one is ready it is preselected and **Use** is one click (`docs/agent-runtime-research.md:363-376`).
6. The user picks a backend, then the intern and helper models from that backend's live catalog, each with an effort where the model advertises one. Every backend has the picker, Claude included. The picker shows only advertised efforts and the image and function-calling capabilities; the intern needs function calling, and screen and picture work need an image-capable helper. Models Dum has verified on that backend, with a real action-calling conversation plus a real image call where images apply, are marked verified; any other listed model shows **untested** and can still be chosen. Claude preselects today's verified pair, intern `claude-opus-5-5` at `high` and helper `claude-fable-5-1` at `high` (`src/runtime.ts:22-25`), which move into the Claude backend's defaults (§8.2 item 12). Other backends preselect nothing until a model is verified on them (`docs/agent-runtime-research.md:344-360`).
7. Electron main validates and persists `agent: AgentChoice` (backend, sign-in method, intern and helper selectors) in desktop settings, because rule 4 and the ownership table make main the sole settings writer (`docs/architecture.md:43,70`). Revamp §6 names the host instead (`docs/revamp-design.md:262`); this design follows the architecture rule (§8.2 item 11). The host receives the validated choice and owns the active copy and sessions.
8. The host opens a fresh session with the active zone's empty `runtime/` directory as `cwd` and releases the request only after the §7 provenance and lockdown checks pass. Changing the backend, sign-in method or a selector closes the session.
9. Settings → **Agent** keeps setup reachable: backend, Claude sign-in method (local builds only), intern model and effort, helper model and effort, **Check again**, **Sign out** or **Remove key**. Changes apply without changing zones and end the open conversation the way a zone switch does. Sign-out removes only that backend's credentials, never transcript, memory, evidence, skills or changes.

### 4.2 Claude Agent SDK (first wave)

One Claude backend, two sign-in methods. The build flavor decides which are offered:

| Method | Public build | Local build | Provenance required before input |
| --- | --- | --- | --- |
| Anthropic API key (`anthropic-key`) | Offered; the only Claude method | Offered | `accountInfo().apiProvider === "firstParty"` and `system/init` `apiKeySource === "ANTHROPIC_API_KEY"` |
| claude.ai subscription (`claude-subscription`) | Never offered; a session reporting it is refused | Offered | Today's checks: first-party route, `claude auth status` reports `claude.ai`, `apiKeySource === "none"` (`src/runtime.ts:186-226`) |

`apiKeySource` values are listed at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:129-131`.

**Detection**

- The desktop app runs the bundled Claude executable by absolute path, never a Finder-inherited PATH or a separately installed `claude` (`src/desktop/runtime-setup.ts:54-65`; `src/runtime.ts:95-110`). Both methods use it.
- For the API key, `status()` reports whether the binary works and whether a key is stored in main's credential store. It never shows any part of the key.
- For the subscription (local builds), `status()` runs `claude auth status` with the filtered environment and a 15-second timeout, and reports only whether the binary works and whether the login is `claude.ai` on the first-party route. A signed-out exit 1 with valid JSON counts as an answer (`src/runtime.ts:121-144`; `src/desktop/runtime-setup.ts:149-178`). Reusing an existing Claude Code login is intended, but the research records same-Keychain reuse as an inference (`docs/agent-runtime-research.md:100`). The UI says **Signed in** only after a live status check.

**API key (both flavors)**

1. The row reads **Use an Anthropic API key**. The setup sheet has one password field; the renderer sends the key once in `agent-key` and never sees it again. Main checks its shape (printable ASCII, no whitespace, at most 256 characters), stores it with asynchronous `safeStorage` in the credential file (§8.2 item 11), and reports only `ready: "anthropic-key"` in snapshots.
2. When the host opens a Claude session, it asks main for the key over the utility-process channel. The Claude backend first filters the inherited environment, which drops every `ANTHROPIC_*` and `*_API_KEY` variable (`src/runtime.ts:46-58`), then sets `ANTHROPIC_API_KEY` in that one SDK query's `env` option. A key or `ANTHROPIC_BASE_URL` from the user's shell never applies, and the key never enters the host's own `process.env`, settings, logs or snapshots.
3. The key is checked by the first `models()` call: the backend starts a closed query with input withheld, asserts the API-key provenance above, and reads `supportedModels()` (`sdk.d.ts:3013`). Whether `supportedModels()` answers before any user message is [unverified]; if it doesn't, the first real turn's `system/init` check is the gate, and no user content is released before it passes.
4. API-key calls are billed per token to the user's Anthropic account (§6.4).

**Subscription sign-in (local builds only)**

1. **Sign in with Claude** runs the bundled CLI's `auth login --claudeai` with the filtered environment. Setup keeps at most the last 8 KiB of output, accepts only `https://claude.com` and `https://claude.ai` sign-in URLs, and detects the paste-code prompt without storing page output (`src/desktop/runtime-setup.ts:67-72,180-230`).
2. If the browser does not open, **Open sign-in page** opens only the allowlisted URL. A pasted code is validated and written only to the waiting CLI's stdin (`src/desktop/runtime-setup.ts:232-247`).
3. When the CLI exits 0, setup checks auth again; the pending request is not released just because the browser flow ended (`src/desktop/runtime-setup.ts:213-226`).

In a public build the row does not exist, main refuses `agent-login` with `claude-subscription`, the settings schema rejects an `AgentChoice` that names it, and the Claude backend refuses any session whose `system/init` reports `apiKeySource: "none"`. A public-build user who is already signed in to Claude Code on the same Mac is not offered that login. Whether the bundled CLI prefers `ANTHROPIC_API_KEY` over a stored claude.ai login is [unverified]; if it doesn't, the init check refuses the session and the user sees **Claude didn't start with your API key**.

**Policy.** The owner's rule settles the question the research left open (`docs/agent-runtime-research.md:439-446`). Public builds don't offer claude.ai login, which the Agent SDK overview reserves for previously approved third parties; local builds keep it for the owner's own use. Dum does not ask Anthropic. That requiring an API key in public builds is compatible with the legal page's clause against restricting Claude Code's built-in authentication methods is an [inference]: Dum leaves the bundled binary unmodified and only chooses which credential its own sessions accept (§11).

**Errors and recovery**

- Bundled binary missing or won't start: **Download a complete build of Dum**, then **Check again**. No PATH fallback (`src/desktop/runtime-setup.ts:54-65,151-158`).
- Auth status malformed, timed out or unverifiable: row unavailable, **Check again**, nothing sent (`src/runtime.ts:121-146`; `src/desktop/runtime-setup.ts:160-166`).
- Route doesn't match the chosen method (the subscription was chosen but an API key, gateway or other provider is active, or a key was chosen but init reports another source): show the route category, never credentials, and ask the user to fix the method or choose the other one. Both checks stay fail-closed (`src/desktop/runtime-setup.ts:167-175`; `src/runtime.ts:186-226`).
- Key rejected by Anthropic: **Anthropic didn't accept this key**, with **Replace key** and **Remove key**. Nothing else is tried.
- Managed policy with nonempty settings: refuse the session, because policy can override flags and run hooks even in safe mode. Recovery is removing the policy or choosing another backend (`src/runtime.ts:228-246`).
- Subscription sign-in stopped (local builds): cancel and the 15-minute limit show **Sign-in cancelled.**; an error or nonzero exit shows **Sign-in didn't finish**. Keep no pending prompt; offer retry, **Open sign-in page** and **Cancel**. Cleanup stays SIGTERM, then SIGKILL after 3 seconds (`src/desktop/runtime-setup.ts:71-72,189,213-224,249-257`).
- Session reports a foreign action, MCP server or plugin: close it, discard the turn, show the isolation error, offer **Check again** or another backend. Nothing is released after a failed check (`src/runtime.ts:186-195`; `src/session.ts:796-810`).

### 4.3 ChatGPT through SIWC (first wave, after contract tests)

ChatGPT is offered in both flavors, but its row stays hidden until the adapter's contract tests pass (§9, A4). The [unverified] wire details below are what those tests must settle.

**Sign-in**

1. Nothing to install. The row reads **Continue with ChatGPT**, the label SIWC requires. SIWC is browser OAuth with a loopback callback on `127.0.0.1`: a new consent, not reuse of `~/.codex/auth.json` (`docs/agent-runtime-research.md:102,368`).
2. Main creates PKCE state, a nonce and a random callback listener, opens the system browser, and validates state, nonce, ID token and granted scopes. Required scope: `resource.invoke chatgpt.tokens.use.direct` (`docs/agent-runtime-research.md:319`).
3. Main stores the refresh token and `ext_agent_host_id` in a file encrypted with asynchronous Electron `safeStorage`; settings never hold tokens (`src/desktop/settings.ts:1-2`). When opening a session, the host asks main for a short-lived access token over the utility-process channel. The token never enters env or a log (`docs/agent-runtime-research.md:379-380`).
4. The host calls `GET /v1/models`, keeps models with the needed capabilities, and the user picks selectors. The account catalog is authoritative; no model ID is guessed (`docs/agent-runtime-research.md:121,348`).

**Errors and recovery**

- Browser won't open, listener can't bind, callback times out, or state/nonce fails: close the listener, discard the response, show **ChatGPT sign-in did not complete**; retry uses fresh state. No token is persisted.
- ID token invalid or missing the scope: **This ChatGPT login cannot be used by Dum**; no model request until the user signs in again and grants it.
- Refresh fails or the access token expires: pause before content is sent, refresh once through main, retry only if the body was not sent; otherwise **Sign in again**. Never switch backends.
- Catalog empty or a selector gone: clear only that selector, keep the backend, show **Choose a current ChatGPT model**.
- `subscription_sharing_usage_limit_exceeded`: keep transcript and draft local, show the error as readable text, no fallback to Claude or local (`docs/agent-runtime-research.md:424,448`). Whether the route gives retry-after guidance is [unverified].
- A field the preview rejects: a provider compatibility error, not a user error. Log bounded diagnostics without token or content, disable the selector until the adapter is fixed, offer another explicitly chosen backend.

**Route constraints.** `stream: true`, `store: false`, stateless history replay, and Dum's actions sent as Responses function definitions in a `dum` namespace. Hosted MCP, code interpreter and file search are unsupported on this route and never sent (`docs/agent-runtime-research.md:102,121,330,339`). The namespace wire format, reasoning-item replay and per-model `reasoning.effort` values are [unverified] and gate the release (`docs/agent-runtime-research.md:451-453`).

### 4.4 Local models (first wave)

The local backend has two adapters over one Dum loop: **Ollama** at `127.0.0.1:11434` and **LM Studio** at `127.0.0.1:1234` (`docs/agent-runtime-research.md:371`). No sign-in or credentials. Both flavors offer it.

1. `status()` probes only `127.0.0.1`/`::1` at the adapter's port and lists model count and IDs. A stopped server shows **Not running** with a download link; Dum installs neither app.
2. `models()` reads catalog and capabilities: Ollama `/api/tags` plus `/api/show`, LM Studio `GET /api/v0/models` (`docs/agent-runtime-research.md:350-351`). A model without function calling can be a text helper, not the intern; one without image input cannot do screen or picture work.
3. The adapter rejects non-loopback base URLs and Ollama cloud-tagged models (`:cloud`/`-cloud`), and sends only to `/v1/chat/completions`, never to `/v1/responses` or LM Studio's `/api/v1/chat`, the routes with server-side MCP (`docs/agent-runtime-research.md:114,320,331`).
4. Dum keeps history and resends it; neither server has a resumable session (`docs/agent-runtime-research.md:125-126`).

**Errors and recovery**

- Connection refused: **Start Ollama** or **Start LM Studio**, then **Check again**. Nothing queues indefinitely.
- Invalid catalog, wrong protocol or non-loopback redirect: **Local endpoint could not be verified**. No redirect is followed and no cloud URL used.
- No function calling: text-only helper if otherwise usable; refused as intern with an explanation.
- Cloud-proxied or cloud-tagged model: **Dum requires a model that stays on this Mac**. No cloud fallback.
- Malformed call stream, unknown action or `maxTurns` exceeded: end the session with a readable error; the next request starts from the durable transcript.
- LM Studio ships text-only in the first wave. Its chat-completions image input is [unverified] (`docs/agent-runtime-research.md:126,458`), so its selectors report `images:false`, and the look's frames and picture sharing show **The selected local model cannot see pictures**. Ollama models that advertise images keep image work. LM Studio images can be enabled later, after a real image call passes.

### 4.5 Copilot (second wave)

Copilot joins the picker only after the A6 probe passes. Intended setup: the bundled Copilot SDK/CLI, reuse of the stored `copilot` login through `getAuthStatus()`, **Sign in with GitHub** when absent (`docs/agent-runtime-research.md:107,369`). The adapter sets `availableTools: ["custom:*"]` and `enableConfigDiscovery: false`, and denies non-Dum names in `onPreToolUse` and `onPermissionRequest`. Copilot reports no active action list, and whether discovery off also skips hooks, plugins and MCP config is [unverified]. The probe asks the model to read a file, run a shell command and fetch a URL, and passes only if each is absent or denied (`docs/agent-runtime-research.md:323-329,425,460-463`).

## 5. Backend table

| Backend | Wave and flavor | Sign-in | Lockdown and verification | Streaming | Images | Selectors |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Agent SDK, API key | First; public and local | User's own Anthropic API key, encrypted in main | `tools:[]`, `settingSources:[]`, `skills:[]`, `plugins:[]`, `strictMcpConfig`, safe mode, filtered env, only Dum's SDK MCP server (`src/runtime.ts:153-178`); auto-memory off (§7 item 2). `assertProvider` before input; `system/init` checked for `apiKeySource: "ANTHROPIC_API_KEY"`, actions, MCP servers, plugins; every action call checked | SDK messages; `includePartialMessages` | Base64 PNG `image` blocks, streaming-input mode only | Catalog from `supportedModels()` with `supportedEffortLevels` (`sdk.d.ts:1391-1430,3013`). Defaults: intern `claude-opus-5-5` `high`, helper `claude-fable-5-1` `high` (`src/runtime.ts:22-25`). The catalog has no image field, so only verified selectors count as image-capable |
| Claude Agent SDK, subscription | First; local builds only | Claude Code subscription login, if the live check confirms it | Same as above, but `system/init` must report `apiKeySource: "none"` and auth status `claude.ai` | Same | Same | Same |
| ChatGPT via SIWC | First, after contract tests; public and local | None to reuse; new consent, encrypted refresh token in main | Only the `dum` function namespace, `store:false`, `stream:true`; token and scopes validated before content; no hosted tools | Responses event stream | `input_image` when the model accepts images | Account catalog: intern needs function calling; helper passes the text/image checks. Effort values [unverified] |
| Local: Ollama | First; public and local | None | Only Dum's function actions, to loopback `/v1/chat/completions`; cloud tags refused; endpoint identity and catalog capabilities checked | SSE; accumulate tool-call deltas | Base64 only, if the model advertises it | User-chosen from the catalog |
| Local: LM Studio | First, text-only; public and local | None | Same loop and loopback checks; never `/v1/responses` or `/api/v1/chat` | SSE with `delta.tool_calls` | Off in the first wave | User-chosen from the catalog |
| GitHub Copilot SDK | Second, probe-gated | Copilot CLI login, if `getAuthStatus()` confirms it | `availableTools:["custom:*"]`, `enableConfigDiscovery:false`, in-process handlers, deny hooks; no active-action report, so the A6 probe gates release | SDK session events | Blob attachments | SDK model list with `reasoningEffort`, after the probe and a real conversation |

Claude's current code proves a stronger lockdown than Copilot's unverified path. HTTP backends need no runtime action report because Dum builds the list; the loop still rejects unknown names at call time (`docs/agent-runtime-research.md:311-342`).

## 6. Workload routing and the always-on look

Rule 8 says Dum looks every 3 seconds and calls a model only when something changed (`docs/architecture.md:74`). The owner named the changes: new or saved code, a switched window or app, and the user stopping typing. This section defines each as a local signal and gives each a settle time and a minimum interval.

### 6.1 What a tick reads

Main's observer ticks every 3 seconds. A tick reads local state and calls no model.

| Signal | Process | Computed each tick | Needs |
| --- | --- | --- | --- |
| Frontmost app | main | The focus helper's `frontmost()`: bundle ID, app name and, where macOS provides it, the window number. Whether the window number is available without Screen Recording permission is [unverified]; without it, only app switches count | Settings → Look → **Apps**, on by default |
| Screen activity | main | A thumbnail of the display nearest the cursor, at most 320 px wide, reduced to a 64×40 grayscale grid. The tick counts cells whose mean moved more than 8 of 255 levels since the previous tick. The grid is kept for one tick; no pixels leave main unless an ambient call asks for a frame | Screen Recording permission and Settings → Look → **Screen**, on by default; first-run setup asks for macOS Screen Recording permission, and Dum runs without the screen signal if it's denied |
| Followed code | host | `Follows.scan()` stats every enumerated file in the zone's followed folders (size, mtime) and hashes a file only when its stat changed. Folders are re-listed every 5th tick (15 s) to find new files. Same deny policy and caps as shares: 2,000 files, depth 16, 256 KiB of UTF-8 text per file (`docs/revamp-design.md:177-179`) | The user added a folder to this zone with **Follow folder…** |

Main sends each tick to the host as `observe-tick {zoneId, epoch, app, screen}`; the host's ambient engine scans followed files on the same tick and decides. Ticks stop while Dum is paused, the Mac sleeps or locks, or voice is recording. A followed folder is an explicit, per-zone, read-only grant that the user can remove; it replaces the Git-based saved-change observer (`src/desktop/saved-change-advice.ts:6`) and the old "saved project files" toggle (`docs/overhaul-goal.md:6`). Dum never watches the home directory (`docs/overhaul-goal.md:58`).

### 6.2 What counts as a change

- **Code.** A followed file whose bytes hash differently from the last bytes Dum read, a new text file that passes the deny policy, or a removed file. A save that leaves the bytes the same is not a change.
- **App or window switch.** The frontmost app, or its window number when known, differs from the last settled one for 2 consecutive ticks. Dum's own windows don't count, and returning to the app of the previous ambient call within 10 minutes doesn't count.
- **Typing stopped** (screen look on only). At least 2 of the last 5 ticks were active (3 or more changed cells), then 2 consecutive ticks were idle, with the same frontmost app throughout. Dum infers this from pixels, never from key events. A blinking caret or a menu-bar clock should change fewer than 3 cells; that and the other thresholds are starting values to tune on a real Mac [unverified]. With screen look off there is no typing signal, and code saves stand in for it.

| Trigger | Settles after | Minimum interval for the same trigger | Sent to the helper |
| --- | --- | --- | --- |
| Code | 2 quiet ticks (6 s) with no further file change, so a format-on-save or multi-file save makes one trigger | 60 s | Diffs against the last bytes Dum read: at most 4 files and 96 KiB, plus the zone context |
| App or window switch | 2 ticks (6 s) on the new app | 120 s | App name; one frame if screen look is on and the helper can see images |
| Typing stopped | 2 idle ticks (6 s) | 90 s, the current screen rate (`src/desktop/screen-wizard-advice.ts:6`) | One frame PNG and the app name |

Across all triggers: one ambient call in flight; at least 30 s between ambient calls; at most 40 per rolling hour, the ceiling today's screen observer already allows (90 s rate). Triggers that fire while a call is running or waiting coalesce into the next call, which carries every signal since the last one. An identical signal set (same file hashes, app and frame hash) never calls twice. A call times out after 45 s, and a failed or timed-out call counts toward the limits (`src/desktop/screen-wizard-advice.ts:6,148-177`).

No ambient call is made, and pending triggers are dropped, when: there is no active zone or the user is on the first-run goal, no backend is chosen, a conversation turn is in flight, a decision is waiting, or the epoch is stale. While the user works on a suggested project, a call may update zone memory but publishes no advice (`src/wizard.ts:266-275`).

An ambient call uses the helper selector with `actions: []` and returns `{note, aside}`. The note goes into bounded zone memory, which is how Dum tracks learning. The aside goes through the Wizard's sourced-or-silent filter. An ambient call never records evidence, never writes a change and never grants a skill.

### 6.3 Routing rules

| Workload | Role | Trigger and frequency | Cache, batch or skip |
| --- | --- | --- | --- |
| The look (§6.1) | Host and main code; no model | Every 3 s | Local only. Signals feed the ambient engine |
| Ambient call | `helper` (image-capable for frames) | Only on a §6.2 change, within the per-trigger and global limits | Coalesce pending triggers; skip identical signal sets; never grants a skill or writes a change |
| Wizard conversation aside | `helper` | At most one `wizard_aside` per turn, as the toolkit enforces (`src/session.ts:564-582`) | Inputs: request, explicit shares, zone snapshot, catalog anchors. Cache by request hash, zone revision and anchor-catalog revision for the request only |
| Conversation | `intern` | One streamed turn per Send; action round-trips bounded by `maxTurns`; no background calls | No caching of personal answers. Abort on Stop, switch or close. A failed route is shown, never retried elsewhere |
| Implement on command | `intern`; `helper` only to explain a refusal | Explicit command plus deterministic gate check. The model may read shared or followed resources and call `change`. No yes/no step when the skills are held; never from an ambient call | Just before writing, recheck each target's skills, prerequisites, language, holds, grant and the SHA the model read. Return the diff, store a revert artifact; refuse on SHA mismatch |
| Suggested projects (practice) | `helper` | Explicit request only: one generation, plus an independent coverage audit when there are several milestones | Cache by zone goal/context, tree revision, focus skills, language, memory and personal-context revisions. Suggested or accepted projects never unlock skills |
| Shared-picture description (`src/look.ts`) | image-capable `helper` | Explicit request only | A picture is never evidence |
| Gate checks | Host code; `helper` only to explain a refusal | Every `change`, review, evidence or resource action; never periodic | `gate.mayChange`, language/prerequisite checks and holds decide; model output is untrusted. Cache only immutable tree reads within one request; recheck after every awaited boundary |

Guided courses (`src/course.ts`) are removed: rule 9 allows no guided practice (`docs/architecture.md:75`). Current code already has the starting points: an explicit action set with a stop on anything else (`src/session.ts:730-751,796-810`), PNG-hash dedup and rate limiting (`src/desktop/screen-wizard-advice.ts:148-177`), Wizard image calls on the helper selector (`src/wizard.ts:8-10,256`), and separate Claude selectors (`src/runtime.ts:22-25`).

### 6.4 Rough per-hour estimate

[estimate] for one active coding hour, not measured billing. Assumptions: one followed folder; screen look on; save bursts about every 5 minutes; about six settled app switches that aren't returns; about eight typing pauses that pass the 90 s interval; six conversation sends. Token sizes are guesses for a zone context of about 1,000 tokens plus the trigger payload.

| Workload | Calls | Input / output tokens each | Subtotal |
| --- | ---: | ---: | ---: |
| Conversation (one round-trip per send; action round-trips extra) | 6 | 2,000 / 500 | 12,000 / 3,000 |
| Ambient: code | 12 | 2,500 / 150 | 30,000 / 1,800 |
| Ambient: app switch | 6 | 1,000 / 120 | 6,000 / 720 |
| Ambient: typing stopped (frame) | 8 | 1,500 / 150 | 12,000 / 1,200 |
| Suggested projects, pictures; gate checks are local | 0 | — | 0 |
| **Total** | **32** | | **60,000 / 6,720** |

The per-trigger intervals allow up to 60 code, 30 switch and 40 typing calls an hour, so the global cap of 40 ambient calls binds first. At 2,500 / 150 tokens each, a capped hour adds 100,000 / 6,000 on top of the conversation. A quiet hour, with no saves, no switches and a still screen, makes no ambient call; the 3-second look then costs only local CPU, which has not been measured. With screen look off there is no typing row and switch calls carry no frame. Action results, history replay and image encoding come on top; image token cost differs by provider and is [unverified]. Dum should expose call and token counters. None of these numbers are provider limits or prices.

| Backend | Cost to the user |
| --- | --- |
| Claude, API key | Per-token charges on the user's Anthropic account. Ambient calls cost money here, so the counters and the Look pause matter most for this route. No prices are in the research |
| Claude, subscription (local builds) | No per-call API charge; usage draws on plan limits (`docs/agent-runtime-research.md:446`), which are not quantified here. Usage-limit errors stay visible |
| ChatGPT SIWC | No separate API key charge; SIWC sharing limits and plan policy apply. Stateless replay makes later turns larger. Quota and preview economics [unverified] |
| Local (Ollama, LM Studio) | No provider charge. Power, heat and latency depend on the machine. LM Studio is proprietary freeware for personal and internal business use; Dum does not bundle it (`docs/agent-runtime-research.md:114`) |
| Copilot SDK, when shipped | Not estimated before the probe; target is the subscription route with no API key. Terms for third-party desktop use [unverified] |

Cost control is coalescing and skipping: no call without a §6.2 change, no repeat of an identical signal set, no unrequested suggestion, no model call where code decides.

## 7. Lockdown and runtime verification

Every backend meets this before releasing user content (`docs/agent-runtime-research.md:311-331`):

1. **Provenance first.** Credentials, endpoint, sign-in method and model resolve first. No prompt, transcript, image, share or personal context crosses the route before that.
2. **Isolation.** No user or project config, MCP servers, plugins, hooks, skills or context files beyond what Dum puts in the system prompt. Claude auto-memory loads regardless of `settingSources` (`docs/agent-runtime-research.md:59`), so the Claude backend turns it off two ways: `autoMemoryEnabled: false` in the `FLAGS` settings Dum already passes to every session and CLI call (`src/runtime.ts:84-91,114,168`; the setting is at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:9131-9134`), and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the Claude child env. Tests assert both. Whether the SDK reports loaded memory at runtime is [unverified], so no runtime assertion is claimed for it.
3. **Action removal.** A backend's built-in file, shell and web actions are absent from the model's list, not merely denied. HTTP adapters build the list; Claude uses `tools:[]` plus only Dum's SDK MCP server. Copilot cannot claim this without the probe.
4. **Call-time backstop.** Normalize the provider's name to the bare Dum name, reject anything outside `OpenOptions.actions`, end the session on an unknown action, never retry on another backend.
5. **Runtime evidence.** Where the backend reports active actions (`Capabilities.runtimeActionCheck`), assert them at every open and turn. For Claude: `system/init` actions, MCP server source and name, plugins, and the `apiKeySource` that matches the chosen method (§4.2). HTTP routes assert the body Dum built. Copilot needs the A6 probe.
6. **Environment.** Each backend builds its own child env. Claude starts from the filtered environment (`src/runtime.ts:34-58`), which drops `CLAUDE_CODE_USE_*` and `CLAUDE_CODE_SKIP_*` but not `CLAUDE_CODE_DISABLE_*`, then adds `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and for the API-key method adds `ANTHROPIC_API_KEY` from main's store. It keeps the bundled absolute executable (`src/runtime.ts:95-110`). Copilot also drops `GH_TOKEN`, `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN`. SIWC tokens travel over the host/main channel, never env. Local adapters accept only loopback.
7. **Build flavor.** A public build refuses a Claude subscription session even when the Mac is signed in, at three points: main's setup, the settings schema and the backend's init check (§8.3).

A failed check closes the session, invalidates the request binding, keeps the draft and transcript, and leaves the backend choice alone until the user picks a recovery. There is no best-effort mode.

## 8. Interfaces

### 8.1 Agent contract

The research interface (`docs/agent-runtime-research.md:166-305`) with the changes in §8.2. Loop types live here, not in `loop.ts`, so the ChatGPT and local adapters can be written in parallel against them.

```ts
// src/agent/types.ts
import type { z } from "zod";
import type { ZoneContext } from "../zone-types.ts";
import type { RequestBinding } from "../share-types.ts";

/** Fixed when the app is built (§8.3). "public" is what Dum distributes; "local" is the owner's own or dev build. */
export type Flavor = "public" | "local";
export type BackendId = "claude" | "chatgpt" | "local" | "copilot";
/** How a backend authenticates. "claude-subscription" exists only in local builds. */
export type LoginMethod = "anthropic-key" | "claude-subscription" | "chatgpt" | "github" | "none";
/** "intern" is the conversation; "helper" is every bounded one-shot (suggested projects, Wizard, ambient calls, picture descriptions). */
export type Role = "intern" | "helper";
export type Selector = { backend: BackendId; model: string; effort: string | null };
/** What the user picked. Sessions must prove `login` at runtime. */
export type AgentChoice = { backend: BackendId; login: LoginMethod; intern: Selector; helper: Selector };

export type Picture = { mimeType: "image/png"; data: string }; // base64
export type UserTurn = { text: string; images?: readonly Picture[] };

export type DumAction = {
  name: string;                 // bare action name; the backend namespaces it on the wire
  description: string;
  schema: z.ZodRawShape;
  call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
};

export type ModelOption = {
  id: string;
  label: string;
  efforts: readonly string[];   // [] = no effort knob
  images: boolean;
  actions: boolean;             // provider function calling; required for the intern
  verified: boolean;            // proven with real calls on this backend; false shows "untested"
};

export type Capabilities = {
  images: boolean;
  interrupt: boolean;
  runtimeActionCheck: boolean;  // backend reports active actions; open()/turn() assert them
};

export type BackendStatus = {
  id: BackendId;
  label: string;
  installed: boolean;                 // bundled binary runs, or the endpoint answers
  methods: readonly LoginMethod[];    // offered in this flavor
  ready: LoginMethod | null;          // confirmed by a live check; never an account field
  loginRunning: boolean;
  loginNeedsCode: boolean;
  message: string;
};

export type LoginUi = {
  openUrl(url: string): Promise<void>; // allowlisted https auth hosts only
  changed(): void;
};

export type AgentEvent =
  | { type: "model"; model: string; effort: string | null }
  | { type: "text"; text: string }
  | { type: "action"; name: string }
  | { type: "retry"; message: string }
  | { type: "end"; error: string | null; interrupted: boolean };

export type OpenOptions = {
  cwd: string;                         // active zone's empty runtime/ directory
  zone: ZoneContext;                   // immutable prompt/gate context for this request
  binding: RequestBinding;             // epoch/token/request correlation
  systemPrompt: string;
  selector: Selector;
  login: LoginMethod;                  // provenance the session must prove
  actions: readonly DumAction[];       // closed set; [] for one-shot helpers
  signal: AbortSignal;
  maxTurns?: number;
};

export interface AgentSession {
  turn(input: UserTurn): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  close(): void;
}

/** Electron main: status and sign-in only. Never opens a model session. */
export interface BackendSetup {
  readonly id: BackendId;
  status(): Promise<BackendStatus>;
  login(method: LoginMethod, ui: LoginUi): Promise<void>; // refuses methods the flavor doesn't offer
  code?(code: string): void;                              // Claude subscription paste-code
  setKey?(key: string): Promise<void>;                    // Anthropic API key; write-only
  cancelLogin(): void;
  signOut(method: LoginMethod): Promise<void>;
}

/** Desktop host: catalog and sessions. */
export interface AgentBackend {
  readonly id: BackendId;
  readonly label: string;
  models(login: LoginMethod, signal: AbortSignal): Promise<ModelOption[]>;
  capabilities(selector: Selector): Capabilities;
  open(o: OpenOptions): Promise<AgentSession>; // resolves only after provenance passes; never falls back
}

/** Host asks main; main answers from its encrypted store. Values never enter env, settings or logs. */
export type CredentialNeed = "anthropic-key" | "chatgpt-access";
export type CredentialSource = (need: CredentialNeed, signal: AbortSignal) =>
  Promise<{ value: string; expiresAt: number | null } | null>;

// Shared by the ChatGPT and local adapters.
export type WireCall = { id: string; name: string; arguments: string };
export type WireMessage =
  | { role: "user"; text: string; images?: readonly Picture[] }
  | { role: "assistant"; text: string; calls: readonly WireCall[] }
  | { role: "tool"; callId: string; text: string; isError: boolean }; // provider role name
export type WireAction = { name: string; description: string; parameters: object };
export type ModelStep = { text: string; calls: WireCall[]; error: string | null };
export interface ModelClient {
  step(req: {
    system: string;
    history: readonly WireMessage[];
    actions: readonly WireAction[];
    model: string;
    effort: string | null;
    signal: AbortSignal;
  }): Promise<ModelStep>;
}
```

```ts
// src/agent/registry.ts, host
export type Registry = {
  backend(id: BackendId): AgentBackend;  // throws for an unregistered or unreleased id
  set(choice: AgentChoice | null): void; // the validated copy main sends
  chosen(): AgentChoice;                 // throws "Choose who powers Dum" when none
  selector(role: Role): Selector;
};
export function createRegistry(backends: readonly AgentBackend[], released: ReadonlySet<BackendId>): Registry;
/** Which backends users can see. ChatGPT flips to true only at its release gate (§9, A4); Copilot after the A6 probe. */
export const RELEASED: Readonly<Record<BackendId, boolean>>; // { claude: true, local: true, chatgpt: false, copilot: false }

// src/agent/schema.ts, shared by main, host and protocol
export function agentChoiceSchema(flavor: Flavor): z.ZodType<AgentChoice>; // public rejects "claude-subscription"
export const BuildInfoSchema: z.ZodType<{ flavor: Flavor }>;

// src/agent/loop.ts
export function loopSession(client: ModelClient, o: OpenOptions): AgentSession;

// src/agent/claude-cli.ts, no SDK import; used by main and host
export const FLAGS: Settings;                                       // today's FLAGS plus autoMemoryEnabled: false
export function cliArgs(...command: string[]): string[];
export function providerFreeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv; // today's subscriptionEnv filter
export function authStatus(executable: string): Promise<{ loggedIn?: boolean; authMethod?: string; apiProvider?: string }>;

// src/agent/claude.ts, host; imports the SDK
export const CLAUDE_DEFAULTS: { intern: Selector; helper: Selector }; // today's MODELS pair
export const CLAUDE_VERIFIED: readonly Selector[];
export function claudeEnv(base: NodeJS.ProcessEnv, key: string | null): NodeJS.ProcessEnv; // providerFreeEnv + auto-memory switch + key
export function claudeBackend(o: { executable: string; flavor: Flavor; credential: CredentialSource }): AgentBackend;

// src/agent/claude-setup.ts, main; imports claude-cli.ts, never the SDK
export function claudeSetup(o: { flavor: Flavor; executable: string | null; credentials: Credentials }): BackendSetup;
```

The helper seam:

```ts
// src/oneshot.ts
export async function oneShot(
  prompt: string,
  o: { agent: Registry; cwd: string; zone: ZoneContext; binding: RequestBinding; images?: readonly Picture[]; signal?: AbortSignal },
): Promise<string>; // helper selector, actions: [], maxTurns: 1; throws if images and !capabilities.images
```

### 8.2 Changes from the research and revamp §6

1. **Naming.** Research `DumTool`, `OpenOptions.tools`, `ModelOption.tools`, `Capabilities.runtimeToolCheck`, `AgentEvent` `"tool"` and `WireTool` become `DumAction`, `actions`, `actions`, `runtimeActionCheck`, `"action"` and `WireAction`: the glossary says model-callable functions are never "tools" (`docs/architecture.md:57`). `WireMessage` keeps the provider role `"tool"`.
2. **Model placement.** All model calls run in the host (§1). Host initialization gains the registry, `AgentChoice` and backend resolution; main does sign-in, token and key storage, and settings writes only.
3. **Request binding.** `OpenOptions` and `oneShot` gain `zone` and `binding`. `RequestBinding` is the revamp's `{zoneId, zoneEpoch, inputToken, requestId}` with a live zone (`docs/revamp-design.md:288-289`). Events with a stale binding are dropped.
4. **Required `cwd`.** As in the research, `oneShot`'s `cwd` is required: always the active zone's empty `runtime/`, never `process.cwd()`, a shared folder or a repository (`docs/agent-runtime-research.md:280,309`; `docs/revamp-design.md:60,192`).
5. **Session lifetime.** Keep revamp `run(request, ctx, opts)` and close the backend session after each top-level request. No resume: the desktop already passes `persist:false`, and the revamp deletes session pointers (`src/desktop/controller.ts:326`; `docs/revamp-design.md:168,338,344`).
6. **`session.ts` cutover.** Replace its SDK imports, `createSdkMcpServer` assembly and SDK event parsing with `AgentBackend.open().turn()`. The toolkit's gate and action definitions become `DumAction[]`, keeping the `store.operation` wrapper, cancellation and unknown-action stop (`src/session.ts:264-271,330-585,730-842`; `docs/agent-runtime-research.md:418`).
7. **Wizard seam and the look.** `wizard.Decision` gains `zone: ZoneContext`. Wizard calls take the registry's helper selector instead of `wizard.MODEL`/`EFFORT` (`src/wizard.ts:8-10`). `ScreenWizardAdvice` and its main-process `screenDecision` call (`src/desktop/screen-wizard-advice.ts:3-4`; `src/desktop/main.ts:287-288`) are replaced by the look: main's observer sends ticks and frames, and the host's ambient engine (§8.4) decides and calls the helper.
8. **Protocol names.** Revamp `runtime-check`, `runtime-login`, `runtime-login-open`, `runtime-login-code`, `runtime-login-cancel` become `agent-check`, `agent-login {backend, method}`, `agent-login-open`, `agent-login-code`, `agent-login-cancel`, plus `agent-key {backend, key}`, `agent-signout {backend, method}`, `agent-models {backend, login}` and `agent-select {choice}`. `Snapshot.runtime` becomes `Snapshot.agent = {flavor: Flavor; backends: BackendStatus[]; chosen: AgentChoice | null}` (`docs/revamp-design.md:411`; `docs/agent-runtime-research.md:415`). `agent-key` is the only request that carries a secret; main never echoes it.
9. **Changes, not proposals.** Revamp §6 has `proposeChange`/`proposeFile`, an action list with `propose_plan`, `propose_change` and `propose_file`, and a plan-approval decision (`docs/revamp-design.md:183,302-303,352`). Rule 6 says a permitted command writes the change directly with no yes/no step, and the glossary replaces "proposal" with "change" (`docs/architecture.md:60,72`). Replace them with one gated `change` action that writes existing-file or new-file content after the live gate and SHA check, returns a `ChangeReceipt` with the diff, and stores a revert artifact. Drop the `"plan"` kind from `respond`; skills are declared on the `change` call and checked there. No aliases, no apply-later path.
10. **Host operations.** Keep revamp `openZone`, `send`, `respond`, `interrupt` and `close`; add `agent-select`, `agent-models`, `credential` (main's answer to a host credential request), `observe-tick`, `observe-frame`, `follow-add`, `follow-remove` and `change-revert`. `observeScreen` is replaced by `observe-tick`/`observe-frame`. `send` resolves the host's current `AgentChoice`. Renderer-supplied backend or selector fields are checked against the main-owned choice and cannot pick a fallback (`docs/revamp-design.md:348-359`).
11. **Settings and credentials.** Settings stay token-free and main stays the only settings writer, correcting revamp §6's "host is the authoritative settings writer" to match rule 4 (`docs/revamp-design.md:262`; `docs/architecture.md:43,70`). Main persists the validated choice, then sends the host its copy. Main's encrypted credential store (`safeStorage`, async API) holds the ChatGPT refresh token and `ext_agent_host_id` and the Anthropic API key; the host gets values through `CredentialSource`. No credentials in `DUM_*` env vars (`docs/agent-runtime-research.md:379-380`).
12. **Claude selectors move into the Claude backend.** The owner approved model picking, so research Option A applies (`docs/agent-runtime-research.md:410`). `src/runtime.ts` is deleted. `MODELS` becomes `CLAUDE_DEFAULTS` and `CLAUDE_VERIFIED` in `src/agent/claude.ts`; `verified()` becomes a check that the selector is in the live catalog with an advertised effort. `closed`, `start`, `assertProvider` and `assertSubscription` move into `claude.ts`, with provenance checked against the chosen sign-in method. Revamp §7's "without changing model selectors" (`docs/revamp-design.md:443`) no longer applies.
13. **Setup and sessions split.** The research's single `AgentBackend` becomes `BackendSetup` in main and `AgentBackend` in the host, so main never imports a model SDK and the host never runs a browser sign-in. `models()` runs in the host because the Claude catalog needs an SDK query.
14. **Build flavor.** New (§8.3).

### 8.3 Build flavor

- **Name and values.** `Flavor = "public" | "local"`, in `src/agent/types.ts`.
- **Where it is set.** `tools/desktop-build.mjs` takes a required `--flavor public|local` and writes `dist/desktop/build-info.json` as `{"flavor": "public"}` or `{"flavor": "local"}`. Main and the host are compiled by `tsc`, not esbuild (`tools/desktop-build.mjs:7,13-14`), so a compile-time define isn't available to them; a file in `dist/` is. The packaged app carries `dist/**` inside its asar (`electron-builder.yml:7-8,13`) with asar integrity validation on (`electron-builder.yml:22`); that the integrity check covers this file is an assumption [unverified].
- **Scripts.** `desktop:build` passes `--flavor local`, so `npm run desktop` and the smoke run local builds. `desktop:pack` and `desktop:mac` build with `--flavor public`. A new `desktop:mac-local` packages the owner's local build (`package.json:23-26`).
- **Where it is read.** Once, at startup, by main's `readFlavor()` in a new `src/desktop/build-info.ts`. A missing or invalid file reads as `"public"`. Main passes the value to the host in `initialize` and to the renderer in `Snapshot.agent.flavor`. No environment variable, setting or renderer request can change it.
- **Where it is enforced.** Main's `agent-setup` neither offers nor routes `claude-subscription` in public; `agentChoiceSchema("public")` rejects it in settings and in `agent-select`; the host's Claude backend refuses `apiKeySource: "none"` in public. The renderer hides the row, which is cosmetic.
- **Tests.** `npm test` has no build-info file; tests construct setups and backends with an explicit flavor and cover both.

### 8.4 Look and ambient contract

```ts
// src/observe-types.ts
export const LOOK = {
  tickMs: 3_000,
  settleTicks: 2,        // app switch and typing stop
  quietTicks: 2,         // code
  activeCells: 3,        // of 64×40; starting value, tune on a real Mac
  activeOf: [2, 5],      // active ticks needed in the recent window
  relistEvery: 5,        // ticks between folder re-listings
  minMs: { code: 60_000, app: 120_000, typing: 90_000, any: 30_000 },
  appRepeatMs: 600_000,
  hourlyCap: 40,
  checkMs: 45_000,
} as const;
export type AppSignal = { bundleId: string; name: string; windowId: number | null };
export type Tick = { zoneId: ZoneId; epoch: string; at: number; app: AppSignal | null; screen: { changedCells: number } | null };
export type FileSignal = { path: ResourcePath; kind: "new" | "saved" | "removed"; sha: string | null };
export type Trigger = "code" | "app" | "typing";
export type AmbientInput = {
  zone: ZoneContext; binding: RequestBinding; triggers: readonly Trigger[];
  files: readonly { path: ResourcePath; diff: string }[]; app: AppSignal | null; image: Picture | null;
};
export type AmbientResult = { note: string | null; aside: string | null };
```

The direct-change seam:

```ts
// src/changes.ts, host-owned. ChangeReceipt lives in src/zone-types.ts.
import type { SkillRef, ZoneId, ChangeReceipt } from "./zone-types.ts";
import type { InputBinding, RequestBinding, ResourcePath, Resources } from "./share-types.ts";

// ChangeReceipt = { id; zoneId; target: ResourcePath; baseSha: string | null; nextSha: string;
//                   diff: string; appliedAt: string; revertible: boolean }

/** What change() checks against: the live grants, tree and holds for this request. */
export type ChangeDeps = { home: string; resources: Resources; tree: skills.Tree; held: ReadonlySet<string>; mode: Mode };

export function change(
  deps: ChangeDeps,
  zoneId: ZoneId,
  binding: RequestBinding,
  target: ResourcePath,
  baseSha: string | null, // SHA of the bytes the model read; null for a new file
  next: string,
  skills: SkillRef[],
): Promise<ChangeReceipt>;

export function revertChange(
  home: string,
  zoneId: ZoneId,
  binding: InputBinding,  // a UI action, possibly after the request that made the change ended
  changeId: string,
): Promise<ChangeReceipt>;
```

`change` gives the model no arbitrary filesystem access. It accepts only a virtual resource in the current request's shares or the zone's followed folders, runs the exact-resource, language, prerequisite and hold checks, compares current bytes with `baseSha`, and writes only on an explicit request with the skills held. Without `baseSha`, an edit made between the model's read and the write would be overwritten, which rule 7 forbids. The response is the diff shown after the write; revert is a UI action, not a model decision, and writes the old bytes back only if the file still hashes to `nextSha`.

## 9. Implementation slices

The unified implementation plan merges this section with revamp §8 and research §5 and assigns every file. Below is only the LLM work, by slice id. No slice runs builds, tests or formatters mid-flight; the integration owner runs the final checks once.

**Phase 0: contracts.** **C0** (includes research A0) writes `src/agent/types.ts`, `src/agent/schema.ts`, `src/agent/registry.ts`, `src/observe-types.ts`, the `agent-*`, `observe-*`, `follow-*`, `change-revert` and `credential` messages in `src/desktop/protocol.ts` and `src/desktop/host-protocol.ts`, and `test/agent-registry.test.ts`. Acceptance: rejects malformed or stale bindings, unknown backends, unreleased backends, `claude-subscription` under the public flavor, renderer-supplied tokens or images outside `agent-key`, and legacy `runtime-*` requests.

**Phase 1: foundations, parallel.**

- **A1, Claude backend and setup.** New `src/agent/claude.ts` (host, SDK), `src/agent/claude-cli.ts` (no SDK) and `src/agent/claude-setup.ts` (main), ported from `src/runtime.ts` and `src/desktop/runtime-setup.ts`, which the removal slice deletes later. Both sign-in methods, flavor gating, `autoMemoryEnabled:false` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, catalog from `supportedModels()`, executable path as a constructor argument instead of `DUM_CLAUDE_BIN`. Tests port `test/runtime.test.ts` into `test/agent-claude.test.ts` and `test/agent-claude-setup.test.ts`. Acceptance: fixture init rejects a mismatched `apiKeySource` for each method and every foreign action, MCP server and plugin; public refuses subscription at setup and at init; the env has no inherited `ANTHROPIC_*`, has the stored key only in key mode, and always has the auto-memory switch; no input before provenance; main-side modules import no model SDK.
- **A4, ChatGPT.** New `src/agent/siwc.ts`, `src/agent/openai-responses.ts` and `src/desktop/credentials.ts` (which also holds the Anthropic key). Acceptance: a fake auth server covers state mismatch, wrong scope, expired token, refresh failure and callback timeout; a fake stream covers text, action, retry and error; tokens and keys never reach settings, logs or env. **Release gate:** the namespace format, effort values and reasoning replay are confirmed against primary sources and pinned in contract tests that pass, and one recorded real sign-in plus action-calling conversation succeeds. Until then `RELEASED.chatgpt` in `src/agent/registry.ts` stays `false` and the row stays hidden; the integration owner flips it with that evidence.
- **A5, Dum loop and local adapters.** New `src/agent/loop.ts`, `src/agent/openai-compatible.ts`, `src/agent/local.ts`, `src/agent/wire.ts`. Acceptance: a fake SSE server covers text, split deltas, action-result continuation, unknown action, mid-stream abort and `maxTurns`; non-loopback and cloud-tagged models are refused; LM Studio selectors report `images:false`; no server-side MCP route is called.
- **O1, observer (main)** and **O2, ambient engine (host).** New `src/desktop/observer.ts` and `src/ambient.ts`. Acceptance with an injected clock: each §6.2 trigger fires once after its settle time and not again inside its interval; the global gap, the hourly cap and single flight hold; identical signal sets don't call; blocked states drop triggers; ticks during sleep, lock, pause or recording are not sent.

**Phase 2: domain and host cutover.** **D1** (research A2) moves `session.ts`, `oneshot.ts`, `look.ts` and `store.ts` onto the registry and `AgentSession`, with the `change` action and no SDK import outside `src/agent/`. **D2** (A2b) moves `practice.ts` and `wizard.ts` onto the helper selector and `ZoneContext`. **D3** (A2c) gives the host the registry, the credential request channel, per-backend child env, the ambient engine wiring and the `agent-*` operations; main stays the settings writer.

**Phase 3: setup and surfaces.** **U2** (A3) writes `src/desktop/agent-setup.ts` and `src/desktop/build-info.ts` and wires setup, credentials, flavor and the observer into `main.ts` and `ipc.ts`; main makes no model call. **U1** (A3b) builds **Who powers Dum?**, the model and effort picker for every backend, the API-key field, the subscription row in local builds only, and Settings → Agent and Look.

**Phase 4 and later.** **X1** adds `--flavor` to `tools/desktop-build.mjs`, writes `build-info.json`, updates the package scripts and deletes `src/runtime.ts` and `src/desktop/runtime-setup.ts`. **X3** (A7) updates the docs: the blanket non-Claude ban and the paid-credential ban are gone, and the docs cover per-backend data flow, the flavor split, the look, limits and no-fallback behavior, promising nothing unverified. **A6**, Copilot, comes after release and only once its probe passes.

## 10. Owner decisions

None open. The fresh-install look is decided: apps on, followed folders on (inert until a folder is added), and screen look on. Rule 8 says Dum is always on and follows along, so first-run setup asks for macOS Screen Recording permission. If permission is denied, Dum runs on app switches and code saves alone, and the user can turn screen look off in Settings → Look.

## 11. Risks and unknowns

- **SIWC contract drift.** Preview field restrictions, the namespace format, usage limits and effort or reasoning semantics may change. The adapter fails closed and shows reauthentication or update states rather than silently changing the request (`docs/agent-runtime-research.md:447-453`). If Dum ever becomes a paid or hosted app, SIWC needs OpenAI's interest form (`docs/agent-runtime-research.md:102`).
- **Claude in public builds.** Requiring an API key and refusing subscription sessions is read as consistent with Anthropic's Agent SDK and legal pages [inference]; Dum does not ask Anthropic, by the owner's decision. Whether the bundled CLI prefers the env key over a stored claude.ai login is [unverified]; the init check refuses the session if not.
- **API-key cost.** Public Claude users pay per token, and ambient calls add to it (§6.4). The caps bound it; counters and the Look pause have to be easy to find.
- **Thresholds of the look.** The cell counts, settle ticks and intervals in §6 are starting values. Too sensitive means wasted calls; too dull means missed pauses. They need tuning against real sessions on a Mac, and the CPU and battery cost of the 3-second tick is unmeasured.
- **Local quality and latency.** Function-calling quality varies, Ollama has no `tool_choice`, and context length and throughput depend on hardware (`docs/agent-runtime-research.md:456`). A selector can be available yet unsuitable; `verified` requires real action and image calls.
- **Untested selectors.** Users may choose models marked untested. Teaching, suggested projects and Wizard quality were tuned on Claude (`src/session.ts:57-156`); the gate stays host-side, but quality needs recorded real conversations per backend before a model is marked verified (`docs/agent-runtime-research.md:466`).
- **Screen and folder privacy.** Frames can show private windows and drafts, and followed folders can hold more than the user means to share. Rate limits and dedup reduce calls, not what an enabled capture or follow sees, so permission, status, the Look pause, the followed-folder list and the transient-pixel boundary stay visible (`docs/revamp-design.md:247-249,550`).
- **Direct-change races.** A user edit between read and write, a zone switch, a host crash or a revert against a changed file must refuse rather than clobber (rule 7). The change artifact is for recovery, not a sandbox.
- **Credential channel.** Main-only `safeStorage` with host sessions adds a credential request channel carrying the ChatGPT access token and the Anthropic key. Its schemas, sender identity, refresh races and crash invalidation need end-to-end tests; secrets stay out of settings, logs, env (except the one Claude child) and renderer snapshots (`docs/agent-runtime-research.md:379-380`).
- **ACP later.** ACP v2 may add isolation controls, but today it has no allowlist or report of an agent's active actions. Revisit only on new primary sources and a runtime probe (`docs/agent-runtime-research.md:153-160,468`).
- **Native behavior.** Nothing here proves browser OAuth, Keychain or `safeStorage` prompts, Screen Recording permission, frontmost-app reads, full-screen and Spaces focus, the voice bridge or packaged helpers. Those need the revamp's physical-Mac acceptance and stay unexercised until observed (`docs/revamp-design.md:534-538`).

Risks covered earlier are not repeated: subscription quotas (§6.4), image capability gaps (§4.4, §5) and Copilot lockdown evidence (§4.5).

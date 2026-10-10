# Dum LLM setup design

> **Note, 2026-10-10.** The local model backend (Ollama, LM Studio) was removed; Dum connects only through a cloud API key. The local sections below are history.

> **Note, 2026-10-08.** This design is history. Where it names the revamp's panel, command bar, tray or Wizard asides, those surfaces are gone. For the circle, the one window, the Settings list and debug chat, see [circle-design.md](circle-design.md); for the rules, [architecture.md](architecture.md); for current backend behavior, the README and the code. The text below is left as it was.

Status: design for the revamp. No slice is implemented, and no native Mac or real-model check has been run for it. The owner's decisions of 2026-10-08 are folded into the body; §10 lists what is still open.

Terms follow `docs/architecture.md`: functions the model calls are **actions** (a **tool** is a skill kind), a file Dum writes on command is a **change**, and **practice** means suggested projects only. Provider API fields with "tool" in the name (`tools: []`, `availableTools`, `delta.tool_calls`) keep their wire names. **The look** is the 3-second local check in §6.1; a **look call** is a model call it triggers, made with the **look model** (§6.2).

## 1. Decision

Dum uses one in-process agent contract with two halves: `BackendSetup` (status and sign-in), which Electron main runs, and `AgentBackend` (model catalog and sessions), which the desktop utility host runs. The first wave has three backends: Claude through the Claude Agent SDK; ChatGPT through Sign in with ChatGPT (SIWC) and the Responses API, released once its contract tests pass; and a Dum-owned loop for local Ollama and LM Studio endpoints, with LM Studio text-only. Each exposes only Dum's registered actions. The user picks the backend and the model for each of its three roles (rule 11, `docs/architecture.md:77`). GitHub Copilot SDK is second wave, gated by a live lockdown probe. ACP is not the core abstraction.

Claude connects only with the user's own Anthropic API key, in every build (rule 12, `docs/architecture.md:78`). There is no subscription sign-in and no build flavor. Dum does not contact Anthropic about it. ChatGPT is built on Sign in with ChatGPT and stays unreleased: the research found SIWC sanctioned for open-source and locally hosted apps, with paid or hosted apps needing OpenAI's interest form (`docs/agent-runtime-research.md:102`), but rule 12 means it switches to an OpenAI API key before it ships.

A harness is used only for what it uniquely gives: a sanctioned sign-in route, or loop and streaming plumbing. No backend gets its own filesystem, shell, web, MCP, plugin, hook or context authority, and every backend keeps the invariants in §3. The research recommends the same three first-wave families and the same boundary (`docs/agent-runtime-research.md:9-22,130-160,311-342`).

**Model calls run in the desktop host.** This is decided. Rule 5 allows model calls in the host and in Electron main (`docs/architecture.md:71`); running all of them in the host is a deployment choice within it. The host runs the conversation, helpers, Wizard asides, look calls and picture descriptions. Main runs browser OAuth, token refresh, `safeStorage`, settings, windows, native capture, the 3-second tick and protocol routing, and calls no model. The reason: `Store`, the gate and request bindings live in the host, so one process resolves `AgentChoice`, opens sessions and drops stale results; calls in main would need a second `AgentChoice` and a token path there (`docs/agent-runtime-research.md:147,478`). Revamp §6 also lists model calls under "must not own" for main (`docs/revamp-design.md:257-258`).

## 2. Candidates considered

| Candidate | Result | Why |
| --- | --- | --- |
| **One agent contract, with Claude/Copilot harness adapters and Dum-owned HTTP loops** | **Chosen** | Matches the research. Harness SDKs call Dum's gated actions in-process; Dum controls the exact request body for SIWC and local endpoints. Claude's reported action list can be checked at runtime, and HTTP lockdown is structural (`docs/agent-runtime-research.md:9-16,130-151,311-342`). |
| **ACP as the core protocol** | Rejected for now | ACP standardizes transport, streaming and images, but has no standard way to remove or list an agent's own filesystem, terminal, hook, plugin or MCP functions. Dum would also need a stdio or HTTP shim that moves the `Store`-closing handlers out of the host. Add an ACP adapter per agent only once it has a source-verified lockdown recipe and a runtime check (`docs/agent-runtime-research.md:63-92,153-160`). |
| **Dum-owned loop for every backend, including Claude** | Rejected | It would discard the bundled runtime and the `assertProvider` and `system/init` checks. A Dum loop fits HTTP APIs; it is no reason to replace the current Claude isolation (`src/runtime.ts:153-226`; `docs/agent-runtime-research.md:26-45`). |
| **Anthropic Messages API in the Dum loop for API-key Claude** | Rejected for the first wave | It would be a second Claude implementation beside the SDK's lockdown. The SDK accepts an API key through its child env (§4.2), which keeps one Claude path. |

## 3. Product and process invariants

- First launch asks only for the learning goal and creates the root zone locally, without sign-in. The first model-backed action opens backend setup (`docs/revamp-design.md:132-140`; `docs/agent-runtime-research.md:365`).
- Zones are context, never permission; a focus skill unlocks nothing. The host rechecks current skills, prerequisites, language and holds before every change. A model's plan or suggestion is never build evidence (`docs/architecture.md:48-77`; `docs/revamp-design.md:142-181`).
- The model sees only Dum actions (`docs/architecture.md:57`).
- The user's editor stays authoritative (rules 6 and 7, `docs/architecture.md:72-73`). On an explicit permitted command the host checks the gate, compares the file's current bytes with the hash the model read, writes the change, stores the before/after artifact in the zone and returns the diff. If the file changed since that read, it refuses. Revert is a separate UI action, bound to the artifact and a fresh hash of the current file.
- Always on (rule 8, `docs/architecture.md:74`): Dum looks every 3 seconds at local signals (§6.1) and calls the look model only on a tick where something changed (§6.2). Dum does not read keystrokes, the clipboard or editor buffers (`docs/overhaul-goal.md:6,58`; `docs/revamp-design.md:232`).
- Claude takes only the user's own Anthropic API key. No setting, environment variable or renderer request adds another Claude sign-in.
- A route never silently falls back to another backend, sign-in method or selector. A missing, unverified or failing selector is shown with a recovery action (`src/runtime.ts:21-32`; `docs/agent-runtime-research.md:353`).

## 4. Setup flow

### 4.1 Common first launch

1. The host initializes the app-owned home, writer lock and zone registry. The renderer shows the learning-goal question, not a Git chooser or login.
2. The user types or dictates a goal into the canonical draft; voice fills it and never sends. Enter/Send creates the root zone transactionally; an empty or cancelled goal creates nothing. No model call (`docs/revamp-design.md:132-140,236`).
3. Settings, zones, tree, history and local notes work without a backend (`docs/revamp-design.md:426`). The look's local ticks run without one too, but no look call is made and no frame is captured until a backend is chosen.
4. The first request that needs Dum or Wizard model work pauses at **Who powers Dum?**. No request text, shared file, image, personal context or transcript goes to any backend before setup completes, the same withholding `runtime.start` enforces today (`src/runtime.ts:228-273`).
5. Main runs every released backend's `BackendSetup.status()` in parallel and shows one row per backend: booleans and one sentence, never an email, organization, token, key, auth JSON, CLI output or prompt, as `RuntimeSetup` does for Claude today (`src/desktop/runtime-setup.ts:1-3,120-178`). Ready rows sort first; if exactly one is ready it is preselected and **Use** is one click (`docs/agent-runtime-research.md:363-376`).
6. The user picks a backend, then three models from that backend's live catalog, each with an effort where the model advertises one: **Dum's model** (the intern), the **helper** and the **look model**. Every backend has the picker, Claude included. The picker shows only advertised efforts and the image and function-calling capabilities; the intern needs function calling, and the look model and picture work need a model that takes pictures. A model id is whatever the live catalog lists; for Claude that includes aliases such as `opus`, `fable` and `haiku`, and the catalog also reports the model each id resolves to today. Verification is keyed on that resolved id: a resolved model Dum has proven with a real action-calling conversation plus a real image call where images apply is marked verified, and any other listed model shows **untested** and can still be chosen. Pictures go only to a selector whose resolved model is verified. Claude preselects intern `opus` at `high`, helper `fable` at `high` and look `haiku` at `low` (§8.2 item 12). Other backends preselect nothing until a model is verified on them (`docs/agent-runtime-research.md:344-360`).
7. Electron main validates and persists `agent: AgentChoice` (backend, sign-in method, intern, helper and look selectors) in desktop settings, because rule 4 and the ownership table make main the sole settings writer (`docs/architecture.md:43,70`). Revamp §6 names the host instead (`docs/revamp-design.md:262`); this design follows the architecture rule (§8.2 item 11). The host receives the validated choice and owns the active copy and sessions.
8. The host opens a fresh session with the active zone's empty `runtime/` directory as `cwd` and releases the request only after the §7 provenance and lockdown checks pass. Changing the backend, sign-in method or a selector closes the session.
9. Settings → **Agent** keeps setup reachable: backend, Dum's model, helper and look model with their efforts, **Check again**, **Sign out** or **Remove key**. Changes apply without changing zones and end the open conversation the way a zone switch does. Sign-out removes only that backend's credentials, never transcript, memory, evidence, skills or changes.

### 4.2 Claude Agent SDK (first wave)

One Claude backend, one sign-in method, in every build: the user's own Anthropic API key (`anthropic-key`). Provenance required before input: `accountInfo().apiProvider === "firstParty"` and `system/init` `apiKeySource === "ANTHROPIC_API_KEY"` (values listed at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:129-131`). Any other `apiKeySource`, including `"none"` from a stored claude.ai login, refuses the session.

**Detection**

- The desktop app runs the bundled Claude executable by absolute path, never a Finder-inherited PATH or a separately installed `claude` (`src/desktop/runtime-setup.ts:54-65`; `src/runtime.ts:95-110`).
- `status()` reports whether the binary works and whether a key is stored in main's credential store. It never shows any part of the key.

**API key**

1. The row reads **Use an Anthropic API key**. The setup sheet has one password field; the renderer sends the key once in `agent-key` and never sees it again. Main checks its shape (printable ASCII, no whitespace, at most 256 characters), stores it with asynchronous `safeStorage` in the credential file (§8.2 item 11), and reports only `ready: "anthropic-key"` in snapshots.
2. When the host opens a Claude session, it asks main for the key over the utility-process channel. The Claude backend first filters the inherited environment, which drops every `ANTHROPIC_*` and `*_API_KEY` variable (`src/runtime.ts:46-58`), then sets `ANTHROPIC_API_KEY` in that one SDK query's `env` option. A key or `ANTHROPIC_BASE_URL` from the user's shell never applies, and the key never enters the host's own `process.env`, settings, logs or snapshots.
3. The key is checked by the first `models()` call: the backend starts a closed query with input withheld, asserts the API-key provenance above, and reads `supportedModels()` (`sdk.d.ts:3013`). Whether `supportedModels()` answers before any user message is [unverified]; if it doesn't, the first real turn's `system/init` check is the gate, and no user content is released before it passes.
4. API-key calls are billed per token to the user's Anthropic account (§6.4).

A user already signed in to Claude Code on the same Mac is not offered that login. Whether the bundled CLI prefers `ANTHROPIC_API_KEY` over a stored claude.ai login is [unverified]; if it doesn't, the init check refuses the session and the user sees **Claude didn't start with your API key**.

**Policy.** The owner's rule settles the question the research left open (`docs/agent-runtime-research.md:439-446`): "let's just have dum be strictly api keys for now". Dum doesn't offer claude.ai login, which the Agent SDK overview reserves for previously approved third parties, and does not ask Anthropic. That requiring an API key is compatible with the legal page's clause against restricting Claude Code's built-in authentication methods is an [inference]: Dum leaves the bundled binary unmodified and only chooses which credential its own sessions accept (§11).

**Errors and recovery**

- Bundled binary missing or won't start: **Download a complete build of Dum**, then **Check again**. No PATH fallback (`src/desktop/runtime-setup.ts:54-65,151-158`).
- Key status unverifiable: row unavailable, **Check again**, nothing sent.
- Route doesn't match the key (init reports another `apiKeySource`, a gateway or another provider): show the route category, never credentials, and ask the user to fix it. The check stays fail-closed (`src/runtime.ts:186-226`).
- Key rejected by Anthropic: **Anthropic didn't accept this key**, with **Replace key** and **Remove key**. Nothing else is tried.
- Managed policy with nonempty settings: refuse the session, because policy can override flags and run hooks even in safe mode. Recovery is removing the policy or choosing another backend (`src/runtime.ts:228-246`).
- Session reports a foreign action, MCP server or plugin: close it, discard the turn, show the isolation error, offer **Check again** or another backend. Nothing is released after a failed check (`src/runtime.ts:186-195`; `src/session.ts:796-810`).

### 4.3 ChatGPT through SIWC (first wave, after contract tests)

ChatGPT's row stays hidden until the adapter's contract tests pass (§9, A4) and it moves to an OpenAI API key, as rule 12 requires. The [unverified] wire details below are what those tests must settle.

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

The local backend has two adapters over one Dum loop: **Ollama** at `127.0.0.1:11434` and **LM Studio** at `127.0.0.1:1234` (`docs/agent-runtime-research.md:371`). No sign-in or credentials.

1. `status()` probes only `127.0.0.1`/`::1` at the adapter's port and lists model count and IDs. A stopped server shows **Not running** with a download link; Dum installs neither app.
2. `models()` reads catalog and capabilities: Ollama `/api/tags` plus `/api/show`, LM Studio `GET /api/v0/models` (`docs/agent-runtime-research.md:350-351`). A model without function calling can be a text helper, not the intern; one without image input cannot be the look model or describe pictures.
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

| Backend | Wave | Sign-in | Lockdown and verification | Streaming | Images | Selectors |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Agent SDK | First | User's own Anthropic API key, encrypted in main; nothing else | `tools:[]`, `settingSources:[]`, `skills:[]`, `plugins:[]`, `strictMcpConfig`, safe mode, filtered env, only Dum's SDK MCP server (`src/runtime.ts:153-178`); auto-memory off (§7 item 2). `assertProvider` before input; `system/init` checked for `apiKeySource: "ANTHROPIC_API_KEY"`, actions, MCP servers, plugins; every action call checked | SDK messages; `includePartialMessages` | Base64 PNG `image` blocks, streaming-input mode only | Catalog from `supportedModels()` with `supportedEffortLevels` (`sdk.d.ts:1391-1430,3013`): ids as the catalog lists them, aliases such as `opus`, `fable` and `haiku` included, each with the model it resolves to today. Defaults: intern `opus` `high`, helper `fable` `high`, look `haiku` `low`. Pictures go only to a selector whose resolved model is verified with real calls |
| ChatGPT via SIWC | First, after contract tests; switches to an OpenAI API key before release | None to reuse; new consent, encrypted refresh token in main | Only the `dum` function namespace, `store:false`, `stream:true`; token and scopes validated before content; no hosted tools | Responses event stream | `input_image` when the model accepts images | Account catalog: intern needs function calling; helper passes the text check and the look model the image check. Effort values [unverified] |
| Local: Ollama | First | None | Only Dum's function actions, to loopback `/v1/chat/completions`; cloud tags refused; endpoint identity and catalog capabilities checked | SSE; accumulate tool-call deltas | Base64 only, if the model advertises it | User-chosen from the catalog |
| Local: LM Studio | First, text-only | None | Same loop and loopback checks; never `/v1/responses` or `/api/v1/chat` | SSE with `delta.tool_calls` | Off in the first wave | User-chosen from the catalog |
| GitHub Copilot SDK | Second, probe-gated | Copilot CLI login, if `getAuthStatus()` confirms it | `availableTools:["custom:*"]`, `enableConfigDiscovery:false`, in-process handlers, deny hooks; no active-action report, so the A6 probe gates release | SDK session events | Blob attachments | SDK model list with `reasoningEffort`, after the probe and a real conversation |

Claude's current code proves a stronger lockdown than Copilot's unverified path. HTTP backends need no runtime action report because Dum builds the list; the loop still rejects unknown names at call time (`docs/agent-runtime-research.md:311-342`).

## 6. Workload routing and the always-on look

Rule 8 says Dum looks every 3 seconds and calls a model only when something changed (`docs/architecture.md:74`). The owner named the changes: new or saved code, a switched window or app, and the user stopping typing. This section defines each as a local signal and gives each a settle time and a minimum interval.

### 6.1 What a tick reads

Main's observer ticks every 3 seconds. A tick reads local state and calls no model.

| Signal | Process | Computed each tick | Needs |
| --- | --- | --- | --- |
| Frontmost app | main | The focus helper's `frontmost()`: bundle ID, app name and, where macOS provides it, the window number. Whether the window number is available without Screen Recording permission is [unverified]; without it, only app switches count | Settings → Look → **Apps**, on by default |
| Screen activity | main | A thumbnail of the display nearest the cursor, at most 320 px wide, reduced to a 64×40 grayscale grid. The tick counts cells whose mean moved more than 8 of 255 levels since the previous tick. The grid is kept for one tick and never sent; the only pixels that leave main are the one frame a look call carries (§6.2) | Screen Recording permission and Settings → Look → **Screen**, on by default; first-run setup asks for macOS Screen Recording permission, and Dum runs without the screen signal if it's denied |
| Followed code | host | `Follows.scan()` stats every enumerated file in the zone's followed folders (size, mtime) and hashes a file only when its stat changed. Folders are re-listed every 5th tick (15 s) to find new files. Same deny policy and caps as shares: 2,000 files, depth 16, 256 KiB of UTF-8 text per file (`docs/revamp-design.md:177-179`) | The user added a folder to this zone with **Follow folder…** |

Main sends each tick to the host as `observe-tick {zoneId, epoch, app, screen}`; the host's ambient engine scans followed files on the same tick and decides. Ticks stop while Dum is paused, the Mac sleeps or locks, or voice is recording. A followed folder is an explicit, per-zone, read-only grant that the user can remove; it replaces the Git-based saved-change observer (`src/desktop/saved-change-advice.ts:6`) and the old "saved project files" toggle (`docs/overhaul-goal.md:6`). Dum never watches the home directory (`docs/overhaul-goal.md:58`).

### 6.2 What counts as a change, and the look call

The look is live: any tick where the screen changed can become a look call. The other changes the owner named, code saves, app switches and typing pauses, still count, and every trigger shares one call stream and one set of limits.

- **Screen.** A tick with at least 3 changed cells (`LOOK.activeCells`). Screen look on only. A blinking caret or a menu-bar clock should change fewer than 3 cells; that and the other thresholds are starting values to tune on a real Mac [unverified].
- **Code.** A followed file whose bytes hash differently from the last bytes Dum read, a new text file that passes the deny policy, or a removed file. A save that leaves the bytes the same is not a change.
- **App or window switch.** The frontmost app, or its window number when known, differs from the last settled one for 2 consecutive ticks. Dum's own windows don't count, and returning to the app of the previous look call within 10 minutes doesn't count.
- **Typing stopped** (screen look on only). At least 2 of the last 5 ticks were active, then 2 consecutive ticks were idle, with the same frontmost app throughout. Dum infers this from pixels, never from key events. With screen look off there is no typing signal, and code saves stand in for it.

| Trigger | Settles after | Minimum interval for the same trigger | Carries |
| --- | --- | --- | --- |
| Screen | Nothing; the changed tick itself | 3 s | The fresh frame |
| Code | 2 quiet ticks (6 s) with no further file change, so a format-on-save or multi-file save makes one trigger | 60 s | Diffs against the last bytes Dum read: at most 4 files and 96 KiB |
| App or window switch | 2 ticks (6 s) on the new app | 120 s | App name and the fresh frame |
| Typing stopped | 2 idle ticks (6 s) | 90 s | App name and the fresh frame |

**Limits, across all triggers.** One look call in flight; at least 3 s between calls; at most 1,200 calls started in any hour. Triggers that fire while a call is running coalesce into the next call. An identical frame (same PNG hash) never calls twice, and neither does an identical set of file hashes and app. A call that hasn't answered after 45 s is stopped, and a failed or timed-out call still counts toward the limits.

**What one call sends.** Each call is stateless. It carries the zone context, the previous look's observation in words, and whatever the triggers carry: with screen look on, one fresh PNG of the display nearest the cursor, at most 1,280 px wide. Earlier frames are never sent again, and no call carries keystrokes or the clipboard. The call uses the **look model** selector with `actions: []` and returns `{note}`: one sentence about what it saw, or null.

**What is kept.** The look reads the screen to keep Dum's context current; it publishes no advice and never interrupts the user with tips. The reply's observation becomes the next call's "previous observation" and is shown in the look status as "last saw: …". It lives in the host's memory only and is never written to disk. The note is stored in bounded zone memory, which is how Dum tracks learning, only when the activity meaningfully changed: never a near-repeat of the last 5 notes, and at most one a minute. Those are the only limits on what a look keeps. A look call never records evidence, never writes a change and never grants a skill.

**What stops it.** No look call is made, no frame is captured, and pending triggers are dropped when: Dum is paused, the look is blocked (no active zone, the first-run goal, a conversation turn in flight, a decision waiting, a stale epoch), no backend is chosen, or a Dum window is frontmost. With screen look off no frame is captured; code saves and app switches still call, with no picture.

**The look model.** A third role beside Dum's model (the intern) and the helper, picked in **Who powers Dum?** and Settings → Agent. It must take pictures. The Claude default is `haiku` at `low`. Its id is whatever Claude's live catalog lists, so an alias can move to a new model. Dum verifies by the resolved model id: frames go only to a look model whose resolved id is proven with real calls. If the alias moves to an unverified model, the look keeps running on text (app name and diffs, plus the previous observation) and the look status says why pictures stopped.

### 6.3 Routing rules

| Workload | Role | Trigger and frequency | Cache, batch or skip |
| --- | --- | --- | --- |
| The look (§6.1) | Host and main code; no model | Every 3 s | Local only. Signals feed the ambient engine |
| Look call | `look` (takes pictures; frames only when its resolved model is verified) | Only on a §6.2 change, within the per-trigger and global limits | Coalesce pending triggers; skip identical frames and signal sets; never grants a skill or writes a change |
| Wizard conversation aside | `helper` | At most one `wizard_aside` per turn, as the toolkit enforces (`src/session.ts:564-582`) | Inputs: request, explicit shares, zone snapshot, catalog anchors. Cache by request hash, zone revision and anchor-catalog revision for the request only |
| Conversation | `intern` | One streamed turn per Send; action round-trips bounded by `maxTurns`; no background calls | No caching of personal answers. Abort on Stop, switch or close. A failed route is shown, never retried elsewhere |
| Implement on command | `intern`; `helper` only to explain a refusal | Explicit command plus deterministic gate check. The model may read shared or followed resources and call `change`. No yes/no step when the skills are held; never from a look call | Just before writing, recheck each target's skills, prerequisites, language, holds, grant and the SHA the model read. Return the diff, store a revert artifact; refuse on SHA mismatch |
| Suggested projects (practice) | `helper` | Explicit request only: one generation, plus an independent coverage audit when there are several milestones | Cache by zone goal/context, tree revision, focus skills, language, memory and personal-context revisions. Suggested or accepted projects never unlock skills |
| Shared-picture description (`src/look.ts`) | image-capable `helper` | Explicit request only | A picture is never evidence |
| Gate checks | Host code; `helper` only to explain a refusal | Every `change`, review, evidence or resource action; never periodic | `gate.mayChange`, language/prerequisite checks and holds decide; model output is untrusted. Cache only immutable tree reads within one request; recheck after every awaited boundary |

Guided courses (`src/course.ts`) are removed: rule 9 allows no guided practice (`docs/architecture.md:75`). Current code already has the starting points: an explicit action set with a stop on anything else (`src/session.ts:730-751,796-810`), PNG-hash dedup and rate limiting (`src/desktop/screen-wizard-advice.ts:148-177`), Wizard image calls on the helper selector (`src/wizard.ts:8-10,256`), and separate Claude selectors (`src/runtime.ts:22-25`).

### 6.4 Cost estimate

[estimate], not measured billing, for one active hour with screen look on and Claude defaults. The look model is `haiku` at `low`; the numbers below use Claude Haiku 5.5 prices: $0.10 per million input tokens for prompts up to 100k, $0.50 per million output tokens and $0.01 per million cache-read tokens.

- One 1280×800 frame is ⌈1280/28⌉ × ⌈800/28⌉ = 46 × 29 = 1,334 visual tokens, about $0.00013 of input.
- An active hour at the cap is 1,200 calls: about 1.6 million frame tokens, plus the zone context, the previous observation and a one-sentence `{note}` reply on each call.
- Total: about **$0.25 per active hour**, or about **$5 a month** at 5 active hours a week.

A still screen with no saves or switches makes no call; the 3-second look then costs only local CPU, which has not been measured. With screen look off, calls come only from saves and switches and carry no frame. Conversation turns on Dum's model and helper work come on top. All of it is billed per token to the user's own Anthropic API key. None of these numbers are provider limits.

| Backend | Cost to the user |
| --- | --- |
| Claude, API key | Per-token charges on the user's own Anthropic account. Look calls cost money here, so the caps and the Look pause matter most for this route |
| ChatGPT | Not released. It moves to an OpenAI API key before release, billed to the user's own OpenAI account; prices not estimated here |
| Local (Ollama, LM Studio) | No provider charge. Power, heat and latency depend on the machine. LM Studio is proprietary freeware for personal and internal business use; Dum does not bundle it (`docs/agent-runtime-research.md:114`) |
| Copilot SDK, when shipped | Not estimated before the probe. Terms for third-party desktop use [unverified] |

Cost control is the limits and skipping: no call without a §6.2 change, no repeat of an identical frame or signal set, no unrequested suggestion, no model call where code decides.

## 7. Lockdown and runtime verification

Every backend meets this before releasing user content (`docs/agent-runtime-research.md:311-331`):

1. **Provenance first.** Credentials, endpoint, sign-in method and model resolve first. No prompt, transcript, image, share or personal context crosses the route before that.
2. **Isolation.** No user or project config, MCP servers, plugins, hooks, skills or context files beyond what Dum puts in the system prompt. Claude auto-memory loads regardless of `settingSources` (`docs/agent-runtime-research.md:59`), so the Claude backend turns it off two ways: `autoMemoryEnabled: false` in the `FLAGS` settings Dum already passes to every session and CLI call (`src/runtime.ts:84-91,114,168`; the setting is at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:9131-9134`), and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the Claude child env. Tests assert both. Whether the SDK reports loaded memory at runtime is [unverified], so no runtime assertion is claimed for it.
3. **Action removal.** A backend's built-in file, shell and web actions are absent from the model's list, not merely denied. HTTP adapters build the list; Claude uses `tools:[]` plus only Dum's SDK MCP server. Copilot cannot claim this without the probe.
4. **Call-time backstop.** Normalize the provider's name to the bare Dum name, reject anything outside `OpenOptions.actions`, end the session on an unknown action, never retry on another backend.
5. **Runtime evidence.** Where the backend reports active actions (`Capabilities.runtimeActionCheck`), assert them at every open and turn. For Claude: `system/init` actions, MCP server source and name, plugins, and the `apiKeySource` that matches the chosen method (§4.2). HTTP routes assert the body Dum built. Copilot needs the A6 probe.
6. **Environment.** Each backend builds its own child env. Claude starts from the filtered environment (`src/runtime.ts:34-58`), which drops `CLAUDE_CODE_USE_*` and `CLAUDE_CODE_SKIP_*` but not `CLAUDE_CODE_DISABLE_*`, then adds `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and for the API-key method adds `ANTHROPIC_API_KEY` from main's store. It keeps the bundled absolute executable (`src/runtime.ts:95-110`). Copilot also drops `GH_TOKEN`, `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN`. SIWC tokens travel over the host/main channel, never env. Local adapters accept only loopback.

A failed check closes the session, invalidates the request binding, keeps the draft and transcript, and leaves the backend choice alone until the user picks a recovery. There is no best-effort mode.

## 8. Interfaces

### 8.1 Agent contract

The research interface (`docs/agent-runtime-research.md:166-305`) with the changes in §8.2. Loop types live here, not in `loop.ts`, so the ChatGPT and local adapters can be written in parallel against them.

```ts
// src/agent/types.ts
import type { z } from "zod";
import type { ZoneContext } from "../zone-types.ts";
import type { RequestBinding } from "../share-types.ts";

export type BackendId = "claude" | "chatgpt" | "local" | "copilot";
/** How a backend authenticates. Claude takes only the user's own Anthropic API key. */
export type LoginMethod = "anthropic-key" | "chatgpt" | "github" | "none";
/** "intern" is the conversation; "helper" is every bounded one-shot (suggested projects, Wizard, picture descriptions); "look" is the live look's calls. */
export type Role = "intern" | "helper" | "look";
/** `model` is an id the live catalog lists; for Claude often an alias such as "haiku". */
export type Selector = { backend: BackendId; model: string; effort: string | null };
/** What the user picked. Sessions must prove `login` at runtime. */
export type AgentChoice = { backend: BackendId; login: LoginMethod; intern: Selector; helper: Selector; look: Selector };

export type Picture = { mimeType: "image/png"; data: string }; // base64
export type UserTurn = { text: string; images?: readonly Picture[] };

export type DumAction = {
  name: string;                 // bare action name; the backend namespaces it on the wire
  description: string;
  schema: z.ZodRawShape;
  call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
};

export type ModelOption = {
  id: string;                   // what the selector names, e.g. "haiku"
  resolved: string;             // the model `id` runs today; verification is keyed on this
  label: string;
  efforts: readonly string[];   // [] = no effort knob
  images: boolean;              // the model takes picture input
  actions: boolean;             // provider function calling; required for the intern
  verified: boolean;            // `resolved` proven with real calls on this backend; false shows "untested"
};

export type Capabilities = {
  model: string;                // the resolved model the selector runs today
  images: boolean;              // Dum may send pictures now; Claude also needs `model` verified
  noImages: string;             // why pictures are refused, shown in the look status; "" when `images`
  interrupt: boolean;
  runtimeActionCheck: boolean;  // backend reports active actions; open()/turn() assert them
};

export type BackendStatus = {
  id: BackendId;
  label: string;
  installed: boolean;                 // bundled binary runs, or the endpoint answers
  methods: readonly LoginMethod[];    // the sign-in methods this backend takes
  ready: LoginMethod | null;          // confirmed by a live check; never an account field
  loginRunning: boolean;
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
  login(method: LoginMethod, ui: LoginUi): Promise<void>; // refuses methods the backend doesn't take
  setKey?(key: string): Promise<void>;                    // Anthropic API key; write-only
  cancelLogin(): void;
  signOut(method: LoginMethod): Promise<void>;
}

/** Desktop host: catalog and sessions. */
export interface AgentBackend {
  readonly id: BackendId;
  readonly label: string;
  models(login: LoginMethod, signal: AbortSignal): Promise<ModelOption[]>;
  capabilities(selector: Selector, login: LoginMethod, signal: AbortSignal): Promise<Capabilities>;
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
export const AgentChoiceSchema: z.ZodType<AgentChoice>;   // the login must be one BACKEND_LOGINS[backend] takes
export const BACKEND_LOGINS: Readonly<Record<BackendId, readonly LoginMethod[]>>; // claude: ["anthropic-key"]
export const CLAUDE_DEFAULTS: { intern: Selector; helper: Selector; look: Selector }; // opus/high, fable/high, haiku/low

// src/agent/loop.ts
export function loopSession(client: ModelClient, o: OpenOptions): AgentSession;

// src/agent/claude-cli.ts, no SDK import; used by main and host
export const FLAGS: Settings;                                       // today's FLAGS plus autoMemoryEnabled: false
export function cliArgs(...command: string[]): string[];
export function providerFreeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv; // drops inherited ANTHROPIC_* and *_API_KEY
export function authStatus(executable: string): Promise<{ loggedIn?: boolean; authMethod?: string; apiProvider?: string }>;

// src/agent/claude.ts, host; imports the SDK
export const CLAUDE_VERIFIED: Readonly<Record<string, true>>; // resolved model ids proven with real calls
export function claudeEnv(base: NodeJS.ProcessEnv, key: string | null): NodeJS.ProcessEnv; // providerFreeEnv + auto-memory switch + key
export function claudeBackend(o: { executable: string; credential: CredentialSource }): AgentBackend;

// src/agent/claude-setup.ts, main; imports claude-cli.ts, never the SDK
export function claudeSetup(o: { executable: string | null; credentials: Credentials }): BackendSetup;
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
7. **Wizard seam and the look.** `wizard.Decision` gains `zone: ZoneContext`. Wizard calls take the registry's helper selector instead of `wizard.MODEL`/`EFFORT` (`src/wizard.ts:8-10`). `ScreenWizardAdvice` and its main-process `screenDecision` call (`src/desktop/screen-wizard-advice.ts:3-4`; `src/desktop/main.ts:287-288`) are replaced by the look: main's observer sends ticks and frames, and the host's ambient engine (§8.4) decides and calls the look model.
8. **Protocol names.** Revamp `runtime-check`, `runtime-login` and `runtime-login-cancel` become `agent-check`, `agent-login {backend, method}` and `agent-login-cancel`, plus `agent-key {backend, key}`, `agent-signout {backend, method}`, `agent-models {backend, login}` and `agent-select {choice}`. Revamp `runtime-login-open` and `runtime-login-code` existed only for Claude subscription sign-in and are gone. `Snapshot.runtime` becomes `Snapshot.agent = {backends: BackendStatus[]; chosen: AgentChoice | null}` (`docs/revamp-design.md:411`; `docs/agent-runtime-research.md:415`). `agent-key` is the only request that carries a secret; main never echoes it.
9. **Changes, not proposals.** Revamp §6 has `proposeChange`/`proposeFile`, an action list with `propose_plan`, `propose_change` and `propose_file`, and a plan-approval decision (`docs/revamp-design.md:183,302-303,352`). Rule 6 says a permitted command writes the change directly with no yes/no step, and the glossary replaces "proposal" with "change" (`docs/architecture.md:60,72`). Replace them with one gated `change` action that writes existing-file or new-file content after the live gate and SHA check, returns a `ChangeReceipt` with the diff, and stores a revert artifact. Drop the `"plan"` kind from `respond`; skills are declared on the `change` call and checked there. No aliases, no apply-later path.
10. **Host operations.** Keep revamp `openZone`, `send`, `respond`, `interrupt` and `close`; add `agent-select`, `agent-models`, `credential` (main's answer to a host credential request), `observe-tick`, `observe-frame`, `follow-add`, `follow-remove` and `change-revert`. `observeScreen` is replaced by `observe-tick`/`observe-frame`. `send` resolves the host's current `AgentChoice`. Renderer-supplied backend or selector fields are checked against the main-owned choice and cannot pick a fallback (`docs/revamp-design.md:348-359`).
11. **Settings and credentials.** Settings stay token-free and main stays the only settings writer, correcting revamp §6's "host is the authoritative settings writer" to match rule 4 (`docs/revamp-design.md:262`; `docs/architecture.md:43,70`). Main persists the validated choice, then sends the host its copy. Main's encrypted credential store (`safeStorage`, async API) holds the ChatGPT refresh token and `ext_agent_host_id` and the Anthropic API key; the host gets values through `CredentialSource`. No credentials in `DUM_*` env vars (`docs/agent-runtime-research.md:379-380`).
12. **Claude selectors move into the Claude backend.** The owner approved model picking, so research Option A applies (`docs/agent-runtime-research.md:410`). `src/runtime.ts` is deleted. `MODELS` becomes `CLAUDE_DEFAULTS` in `src/agent/schema.ts`, with catalog aliases (`opus`, `fable`, `haiku`) for the three roles, and `CLAUDE_VERIFIED` in `src/agent/claude.ts`, keyed by resolved model id. A selector is usable when its id is in the live catalog with an advertised effort; it gets pictures only when its resolved id is verified. `closed`, `start` and `assertProvider` move into `claude.ts`, with provenance checked against the API key. Revamp §7's "without changing model selectors" (`docs/revamp-design.md:443`) no longer applies.
13. **Setup and sessions split.** The research's single `AgentBackend` becomes `BackendSetup` in main and `AgentBackend` in the host, so main never imports a model SDK and the host never runs a browser sign-in. `models()` runs in the host because the Claude catalog needs an SDK query.
14. **Look model role.** New. `Role` gains `"look"` and `AgentChoice` gains `look`, so the live look's calls run on their own selector (§6.2) instead of the helper's. Saved settings without `look` get the backend's default.

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
  minMs: { code: 60_000, app: 120_000, typing: 90_000, screen: 3_000, any: 3_000 },
  appRepeatMs: 600_000,
  hourlyCap: 1_200,      // calls started in any hour, timed-out ones included
  checkMs: 45_000,       // a call still unanswered is stopped and still counts
  noteMs: 60_000,        // at most one memory note a minute
  recentNotes: 5,        // a note that nearly repeats one of these is dropped
  frameWidth: 1280,      // width of the one frame a call sends
} as const;
export type AppSignal = { bundleId: string; name: string; windowId: number | null };
export type Tick = { zoneId: ZoneId; epoch: string; at: number; app: AppSignal | null; screen: { changedCells: number } | null };
export type FileSignal = { path: ResourcePath; kind: "new" | "saved" | "removed"; sha: string | null };
export type Trigger = "code" | "app" | "typing" | "screen";
export type AmbientInput = {
  zone: ZoneContext; binding: RequestBinding; triggers: readonly Trigger[];
  files: readonly { path: ResourcePath; diff: string }[]; app: AppSignal | null;
  image: Picture | null;     // this call's one fresh frame; earlier frames are never resent
  previous: string | null;   // the last look's observation in words
};
export type AmbientResult = { note: string | null }; // what one look saw, or null; the look never advises
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

**Phase 0: contracts.** **C0** (includes research A0) writes `src/agent/types.ts`, `src/agent/schema.ts`, `src/agent/registry.ts`, `src/observe-types.ts`, the `agent-*`, `observe-*`, `follow-*`, `change-revert` and `credential` messages in `src/desktop/protocol.ts` and `src/desktop/host-protocol.ts`, and `test/agent-registry.test.ts`. Acceptance: rejects malformed or stale bindings, unknown backends, unreleased backends, a login the backend doesn't take, renderer-supplied tokens or images outside `agent-key`, and legacy `runtime-*` requests.

**Phase 1: foundations, parallel.**

- **A1, Claude backend and setup.** New `src/agent/claude.ts` (host, SDK), `src/agent/claude-cli.ts` (no SDK) and `src/agent/claude-setup.ts` (main), ported from `src/runtime.ts` and `src/desktop/runtime-setup.ts`, which the removal slice deletes later. API key only, `autoMemoryEnabled:false` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, catalog from `supportedModels()` with each id's resolved model, executable path as a constructor argument instead of `DUM_CLAUDE_BIN`. Tests port `test/runtime.test.ts` into `test/agent-claude.test.ts` and `test/agent-claude-setup.test.ts`. Acceptance: fixture init rejects any `apiKeySource` other than `ANTHROPIC_API_KEY` and every foreign action, MCP server and plugin; pictures are refused for a selector whose resolved model isn't verified; the env has no inherited `ANTHROPIC_*`, has the stored key, and always has the auto-memory switch; no input before provenance; main-side modules import no model SDK.
- **A4, ChatGPT.** New `src/agent/siwc.ts`, `src/agent/openai-responses.ts` and `src/desktop/credentials.ts` (which also holds the Anthropic key). Acceptance: a fake auth server covers state mismatch, wrong scope, expired token, refresh failure and callback timeout; a fake stream covers text, action, retry and error; tokens and keys never reach settings, logs or env. **Release gate:** the namespace format, effort values and reasoning replay are confirmed against primary sources and pinned in contract tests that pass, and one recorded real sign-in plus action-calling conversation succeeds. Until then `RELEASED.chatgpt` in `src/agent/registry.ts` stays `false` and the row stays hidden; the integration owner flips it with that evidence.
- **A5, Dum loop and local adapters.** New `src/agent/loop.ts`, `src/agent/openai-compatible.ts`, `src/agent/local.ts`, `src/agent/wire.ts`. Acceptance: a fake SSE server covers text, split deltas, action-result continuation, unknown action, mid-stream abort and `maxTurns`; non-loopback and cloud-tagged models are refused; LM Studio selectors report `images:false`; no server-side MCP route is called.
- **O1, observer (main)** and **O2, ambient engine (host).** New `src/desktop/observer.ts` and `src/ambient.ts`. Acceptance with an injected clock: a changed-screen tick calls; each other §6.2 trigger fires once after its settle time and not again inside its interval; the 3 s gap, the hourly cap, single flight and the 45 s timeout hold; an identical frame doesn't call twice; notes keep their minute limit and near-repeat check; the look publishes no advice; blocked states drop triggers; no frame is captured while paused, blocked, without a backend, with a Dum window frontmost or with screen look off.

**Phase 2: domain and host cutover.** **D1** (research A2) moves `session.ts`, `oneshot.ts`, `look.ts` and `store.ts` onto the registry and `AgentSession`, with the `change` action and no SDK import outside `src/agent/`. **D2** (A2b) moves `practice.ts` and `wizard.ts` onto the helper selector and `ZoneContext`. **D3** (A2c) gives the host the registry, the credential request channel, per-backend child env, the ambient engine wiring and the `agent-*` operations; main stays the settings writer.

**Phase 3: setup and surfaces.** **U2** (A3) writes `src/desktop/agent-setup.ts` and wires setup, credentials and the observer into `main.ts` and `ipc.ts`; main makes no model call. **U1** (A3b) builds **Who powers Dum?**, the model and effort picker for all three roles on every backend, the API-key field, the look status, and Settings → Agent and Look.

**Phase 4 and later.** **X1** updates the package scripts and deletes `src/runtime.ts` and `src/desktop/runtime-setup.ts`. **X3** (A7) updates the docs: the blanket non-Claude ban and the paid-credential ban are gone, and the docs cover per-backend data flow, API-key-only Claude, the look, limits and no-fallback behavior, promising nothing unverified. **A6**, Copilot, comes after release and only once its probe passes.

## 10. Owner decisions

None open. The fresh-install look is decided: apps on, followed folders on (inert until a folder is added), and screen look on. Rule 8 says Dum is always on and follows along, so first-run setup asks for macOS Screen Recording permission. If permission is denied, Dum runs on app switches and code saves alone, and the user can turn screen look off in Settings → Look.

## 11. Risks and unknowns

- **SIWC contract drift.** Preview field restrictions, the namespace format, usage limits and effort or reasoning semantics may change. The adapter fails closed and shows reauthentication or update states rather than silently changing the request (`docs/agent-runtime-research.md:447-453`). If Dum ever becomes a paid or hosted app, SIWC needs OpenAI's interest form (`docs/agent-runtime-research.md:102`).
- **Claude with an API key only.** Requiring the user's own API key and refusing any other Claude route is read as consistent with Anthropic's Agent SDK and legal pages [inference]; Dum does not ask Anthropic, by the owner's decision. Whether the bundled CLI prefers the env key over a stored claude.ai login is [unverified]; the init check refuses the session if not.
- **API-key cost.** Claude users pay per token, and look calls add to it (§6.4). The caps bound it; the look status and the Look pause have to be easy to find.
- **Moving aliases.** Claude's aliases can move. Dum verifies by the resolved model id, so a moved alias stops getting pictures until its new model passes a real call; until then the look runs on text.
- **Thresholds of the look.** The cell counts, settle ticks and intervals in §6 are starting values. Too sensitive means wasted calls; too dull means missed pauses. They need tuning against real sessions on a Mac, and the CPU and battery cost of the 3-second tick is unmeasured.
- **Local quality and latency.** Function-calling quality varies, Ollama has no `tool_choice`, and context length and throughput depend on hardware (`docs/agent-runtime-research.md:456`). A selector can be available yet unsuitable; `verified` requires real action and image calls.
- **Untested selectors.** Users may choose models marked untested. Teaching, suggested projects and Wizard quality were tuned on Claude (`src/session.ts:57-156`); the gate stays host-side, but quality needs recorded real conversations per backend before a model is marked verified (`docs/agent-runtime-research.md:466`).
- **Screen and folder privacy.** Frames can show private windows and drafts, and followed folders can hold more than the user means to share. Rate limits and dedup reduce calls, not what an enabled capture or follow sees, so permission, status, the Look pause, the followed-folder list and the transient-pixel boundary stay visible (`docs/revamp-design.md:247-249,550`).
- **Direct-change races.** A user edit between read and write, a zone switch, a host crash or a revert against a changed file must refuse rather than clobber (rule 7). The change artifact is for recovery, not a sandbox.
- **Credential channel.** Main-only `safeStorage` with host sessions adds a credential request channel carrying the ChatGPT access token and the Anthropic key. Its schemas, sender identity, refresh races and crash invalidation need end-to-end tests; secrets stay out of settings, logs, env (except the one Claude child) and renderer snapshots (`docs/agent-runtime-research.md:379-380`).
- **ACP later.** ACP v2 may add isolation controls, but today it has no allowlist or report of an agent's active actions. Revisit only on new primary sources and a runtime probe (`docs/agent-runtime-research.md:153-160,468`).
- **Native behavior.** Nothing here proves browser OAuth, Keychain or `safeStorage` prompts, Screen Recording permission, frontmost-app reads, full-screen and Spaces focus, the voice bridge or packaged helpers. Those need the revamp's physical-Mac acceptance and stay unexercised until observed (`docs/revamp-design.md:534-538`).

Risks covered earlier are not repeated: image capability gaps (§4.4, §5) and Copilot lockdown evidence (§4.5).

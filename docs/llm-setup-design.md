# Dum LLM setup design

Status: design for the revamp. No slice is implemented, and no native Mac or real-model check has been run for it.

Terms follow `docs/architecture.md`: functions the model calls are **actions** (a **tool** is a skill kind), a file Dum writes on command is a **change**, and **practice** means suggested projects only. Provider API fields with "tool" in the name (`tools: []`, `availableTools`, `delta.tool_calls`) keep their wire names.

## 1. Decision

Dum uses one in-process `AgentBackend` contract, owned by the desktop utility host. The first wave has three backends: the current Claude Agent SDK backend; ChatGPT through Sign in with ChatGPT (SIWC) and the Responses API; and a Dum-owned loop for local Ollama and LM Studio endpoints. Each exposes only Dum's registered actions. GitHub Copilot SDK is second wave, gated by a live lockdown probe. ACP is not the core abstraction.

A harness is used only for what it uniquely gives: the sanctioned subscription route, or loop and streaming plumbing. No backend gets its own filesystem, shell, web, MCP, plugin, hook or context authority, and every backend keeps the invariants in §3. The research recommends the same three first-wave families and the same boundary (`docs/agent-runtime-research.md:9-22,130-160,311-342`).

**Where model calls run.** Architecture rule 5 allows model calls in the desktop host and in Electron main (`docs/architecture.md:71`). Within that rule, this design runs every model call in the host: conversation, helpers, Wizard asides and screen advice. Main keeps browser OAuth, token refresh, `safeStorage`, durable settings, windows, native capture and protocol routing. The reason: `Store`, the gate and request bindings live in the host, so one process resolves `AgentChoice`, opens sessions and drops stale results; calls in main would need a second `AgentChoice` and a token path there (`docs/agent-runtime-research.md:147,478`). It also matches revamp §6, which lists model calls under "must not own" for main (`docs/revamp-design.md:257-258`). The owner can overrule this (§10.7).

## 2. Candidates considered

| Candidate | Result | Why |
| --- | --- | --- |
| **One `AgentBackend`, with Claude/Copilot harness adapters and Dum-owned HTTP loops** | **Chosen** | Matches the research. Harness SDKs call Dum's gated actions in-process; Dum controls the exact request body for SIWC and local endpoints. Claude's reported action list can be checked at runtime, and HTTP lockdown is structural (`docs/agent-runtime-research.md:9-16,130-151,311-342`). |
| **ACP as the core protocol** | Rejected for now | ACP standardizes transport, streaming and images, but has no standard way to remove or list an agent's own filesystem, terminal, hook, plugin or MCP functions. Dum would also need a stdio or HTTP shim that moves the `Store`-closing handlers out of the host. Add an ACP adapter per agent only once it has a source-verified lockdown recipe and a runtime check (`docs/agent-runtime-research.md:63-92,153-160`). |
| **Dum-owned loop for every backend, including Claude** | Rejected | It would discard the Claude subscription route, the bundled runtime and the `assertProvider`/`assertSubscription` checks. A Dum loop fits HTTP APIs; it is no reason to replace the current Claude isolation (`src/runtime.ts:153-226`; `docs/agent-runtime-research.md:26-45`). |

## 3. Product and process invariants

- First launch asks only for the learning goal and creates the root zone locally, without sign-in. The first model-backed action opens backend setup (`docs/revamp-design.md:132-140`; `docs/agent-runtime-research.md:365`).
- Zones are context, never permission; a focus skill unlocks nothing. The host rechecks current skills, prerequisites, language and holds before every change. A model's plan or suggestion is never build evidence (`docs/architecture.md:48-77`; `docs/revamp-design.md:142-181`).
- The model sees only Dum actions (`docs/architecture.md:57`).
- The user's editor stays authoritative (rules 6 and 7, `docs/architecture.md:72-73`). On an explicit permitted command the host checks the gate, compares the file's current bytes with the hash the model read, writes the change, stores the before/after artifact in the zone and returns the diff. If the file changed since that read, it refuses. Revert is a separate UI action, bound to the artifact and a fresh hash of the current file.
- Always on (rule 8, `docs/architecture.md:74`) means the host follows local app events, keeps zone and session state, and may schedule bounded ambient work. It does not mean a model request per keystroke; Dum does not key-log or stream editor content (`docs/overhaul-goal.md:6,58`; `docs/revamp-design.md:232`).
- A route never silently falls back to another backend or selector. A missing, unverified or failing selector is shown with a recovery action (`src/runtime.ts:21-32`; `docs/agent-runtime-research.md:353`).

## 4. Setup flow

### 4.1 Common first launch

1. The host initializes the app-owned home, writer lock and zone registry. The renderer shows the learning-goal question, not a Git chooser or login.
2. The user types or dictates a goal into the canonical draft; voice fills it and never sends. Enter/Send creates the root zone transactionally; an empty or cancelled goal creates nothing. No model call (`docs/revamp-design.md:132-140,236`).
3. Settings, zones, tree, history and local notes work without a backend (`docs/revamp-design.md:426`).
4. The first request that needs Dum or Wizard model work pauses at **Who powers Dum?**. No request text, shared file, image, personal context or transcript goes to any backend before setup completes, the same withholding `runtime.start` enforces today (`src/runtime.ts:228-273`).
5. The sheet runs every backend's `status()` in parallel and shows one row per first-wave backend: booleans and one sentence, never an email, organization, token, auth JSON, CLI output or prompt, as `RuntimeSetup` does for Claude today (`src/desktop/runtime-setup.ts:1-3,120-178`). Ready rows sort first; if exactly one is ready it is preselected and **Use** is one click (`docs/agent-runtime-research.md:363-376`).
6. The user chooses a backend. Claude uses its two pinned selectors (`MODELS.dum` as intern, `MODELS.helper` as helper) with no picker, because changing Claude selection is not approved (§10.3). For ChatGPT and local, the user picks `intern` and `helper` selectors from the live catalog, which shows only advertised efforts and image/function-calling capabilities. A selector is verified only after a real action-calling conversation, plus a real image helper call where images apply (`docs/agent-runtime-research.md:344-360`).
7. Electron main persists `{backend, intern, helper}` in desktop settings, because rule 4 and the ownership table make main the sole settings writer (`docs/architecture.md:43,70`). Revamp §6 names the host instead (`docs/revamp-design.md:262`); this design follows the architecture rule (§8.2 item 11). The host receives the validated choice and owns the active copy and sessions.
8. The host opens a fresh session with the active zone's empty `runtime/` directory as `cwd` and releases the request only after the §7 provenance and lockdown checks pass. Changing the backend or a selector closes the session.
9. Settings → **Agent** keeps setup reachable: check, sign out, reauthenticate or change backend without changing zones. Sign-out removes only that backend's credentials, never transcript, memory, evidence, skills or changes.

### 4.2 Claude Agent SDK (first wave)

**Detection**

- The desktop app runs the bundled Claude executable by absolute path, never a Finder-inherited PATH or a separately installed `claude` (`src/desktop/runtime-setup.ts:54-65`; `src/runtime.ts:95-110`).
- `status()` runs `claude auth status` with the filtered subscription environment and a 15-second timeout, and reports only whether the binary works and whether the login is `claude.ai` on the first-party route. A signed-out exit 1 with valid JSON counts as an answer (`src/runtime.ts:121-144`; `src/desktop/runtime-setup.ts:149-178`).
- Reusing an existing Claude Code login is intended, but the research records same-Keychain reuse as an inference (`docs/agent-runtime-research.md:100`). The UI says **Signed in** only after a live status check.

**Sign-in**

1. **Sign in with Claude** runs the bundled CLI's `auth login --claudeai` with the filtered environment. Setup keeps at most the last 8 KiB of output, accepts only `https://claude.com` and `https://claude.ai` sign-in URLs, and detects the paste-code prompt without storing page output (`src/desktop/runtime-setup.ts:67-72,180-230`).
2. If the browser does not open, **Open sign-in page** opens only the allowlisted URL. A pasted code is validated and written only to the waiting CLI's stdin (`src/desktop/runtime-setup.ts:232-247`).
3. When the CLI exits 0, setup checks auth again; the pending request is not released just because the browser flow ended (`src/desktop/runtime-setup.ts:213-226`).

**Errors and recovery**

- Bundled binary missing or won't start: **Download a complete build of Dum**, then **Check again**. No PATH fallback (`src/desktop/runtime-setup.ts:54-65,151-158`).
- Auth status malformed, timed out or unverifiable: row unavailable, **Check again**, nothing sent (`src/runtime.ts:121-146`; `src/desktop/runtime-setup.ts:160-166`).
- Signed in by API key, gateway or another provider: show the route category, never credentials, and ask for the first-party subscription login. `assertProvider` and `assertSubscription` stay fail-closed (`src/desktop/runtime-setup.ts:167-175`; `src/runtime.ts:186-226`).
- Managed policy with nonempty settings: refuse the session, because policy can override flags and run hooks even in safe mode. Recovery is removing the policy or choosing another backend (`src/runtime.ts:228-246`).
- Sign-in stopped: cancel and the 15-minute limit show **Sign-in cancelled.**; an error or nonzero exit shows **Sign-in didn't finish**. Keep no pending prompt; offer retry, **Open sign-in page** and **Cancel**. Cleanup stays SIGTERM, then SIGKILL after 3 seconds (`src/desktop/runtime-setup.ts:71-72,189,213-224,249-257`).
- Session reports a foreign action, MCP server or plugin: close it, discard the turn, show the isolation error, offer **Check again** or another backend. Nothing is released after a failed check (`src/runtime.ts:186-195`; `src/session.ts:796-810`).

### 4.3 ChatGPT through SIWC (first wave)

**Sign-in**

1. Nothing to install. The row reads **Continue with ChatGPT**, the label SIWC requires. SIWC is browser OAuth with a loopback callback on `127.0.0.1`: a new consent, not reuse of `~/.codex/auth.json` (`docs/agent-runtime-research.md:102,368`).
2. Main creates PKCE state, a nonce and a random callback listener, opens the system browser, and validates state, nonce, ID token and granted scopes. Required scope: `resource.invoke chatgpt.tokens.use.direct` (`docs/agent-runtime-research.md:319`).
3. Main stores the refresh token and `ext_agent_host_id` in a file encrypted with asynchronous Electron `safeStorage`; settings never hold tokens (`src/desktop/settings.ts:1-2`). When opening a session, the host asks main for a short-lived access token over the utility-process channel. The token never enters env or a log (`docs/agent-runtime-research.md:379-380`).
4. The host calls `GET /v1/models`, keeps models with the needed capabilities, and the user picks verified selectors. The account catalog is authoritative; no model ID is guessed (`docs/agent-runtime-research.md:121,348`).

**Errors and recovery**

- Browser won't open, listener can't bind, callback times out, or state/nonce fails: close the listener, discard the response, show **ChatGPT sign-in did not complete**; retry uses fresh state. No token is persisted.
- ID token invalid or missing the scope: **This ChatGPT login cannot be used by Dum**; no model request until the user signs in again and grants it.
- Refresh fails or the access token expires: pause before content is sent, refresh once through main, retry only if the body was not sent; otherwise **Sign in again**. Never switch backends.
- Catalog empty or a selector gone: clear only that selector, keep the backend, show **Choose a current ChatGPT model**.
- `subscription_sharing_usage_limit_exceeded`: keep transcript and draft local, show the error as readable text, no fallback to Claude or local (`docs/agent-runtime-research.md:424,448`). Whether the route gives retry-after guidance is [unverified].
- A field the preview rejects: a provider compatibility error, not a user error. Log bounded diagnostics without token or content, disable the selector until the adapter is fixed, offer another explicitly chosen backend.

**Route constraints.** `stream: true`, `store: false`, stateless history replay, and Dum's actions sent as Responses function definitions in a `dum` namespace. Hosted MCP, code interpreter and file search are unsupported on this route and never sent (`docs/agent-runtime-research.md:102,121,330,339`). The namespace wire format, reasoning-item replay and per-model `reasoning.effort` values are [unverified] implementation gates (`docs/agent-runtime-research.md:451-453`).

### 4.4 Local models (first wave)

The local backend has two adapters over one Dum loop: **Ollama** at `127.0.0.1:11434` and **LM Studio** at `127.0.0.1:1234` (`docs/agent-runtime-research.md:371`). No sign-in or credentials.

1. `status()` probes only `127.0.0.1`/`::1` at the adapter's port and lists model count and IDs. A stopped server shows **Not running** with a download link; Dum installs neither app.
2. `models()` reads catalog and capabilities: Ollama `/api/tags` plus `/api/show`, LM Studio `GET /api/v0/models` (`docs/agent-runtime-research.md:350-351`). A model without function calling can be a text helper, not the intern; one without image input cannot do screen or image work.
3. The adapter rejects non-loopback base URLs and Ollama cloud-tagged models (`:cloud`/`-cloud`), and sends only to `/v1/chat/completions`, never to `/v1/responses` or LM Studio's `/api/v1/chat`, the routes with server-side MCP (`docs/agent-runtime-research.md:114,320,331`).
4. Dum keeps history and resends it; neither server has a resumable session (`docs/agent-runtime-research.md:125-126`).

**Errors and recovery**

- Connection refused: **Start Ollama** or **Start LM Studio**, then **Check again**. Nothing queues indefinitely.
- Invalid catalog, wrong protocol or non-loopback redirect: **Local endpoint could not be verified**. No redirect is followed and no cloud URL used.
- No function calling: text-only helper if otherwise usable; refused as intern with an explanation.
- Cloud-proxied or cloud-tagged model: **Dum requires a model that stays on this Mac**. No cloud fallback.
- Malformed call stream, unknown action or `maxTurns` exceeded: end the session with a readable error; the next request starts from the durable transcript.
- LM Studio image input on `/v1/chat/completions` is [unverified] (`docs/agent-runtime-research.md:126,458`). Until a real image call passes, its selectors are `images:false`, and screen advice and picture sharing show **The selected local model cannot see pictures**.

### 4.5 Copilot (second wave)

Copilot joins the picker only after the A6 probe passes. Intended setup: the bundled Copilot SDK/CLI, reuse of the stored `copilot` login through `getAuthStatus()`, **Sign in with GitHub** when absent (`docs/agent-runtime-research.md:107,369`). The adapter sets `availableTools: ["custom:*"]` and `enableConfigDiscovery: false`, and denies non-Dum names in `onPreToolUse` and `onPermissionRequest`. Copilot reports no active action list, and whether discovery off also skips hooks, plugins and MCP config is [unverified]. The probe asks the model to read a file, run a shell command and fetch a URL, and passes only if each is absent or denied (`docs/agent-runtime-research.md:323-329,425,460-463`).

## 5. Backend table

| Backend | Wave | Login reuse | Lockdown and verification | Streaming | Images | Selectors |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Agent SDK | First | Claude Code subscription login, if the live check confirms it | `tools:[]`, `settingSources:[]`, `skills:[]`, `plugins:[]`, `strictMcpConfig`, safe mode, filtered env, only Dum's SDK MCP server (`src/runtime.ts:153-178`). `assertProvider` before input; `system/init` checked for API-key source, actions, MCP servers, plugins; every action call checked. Auto-memory: §10.1 | SDK messages; `includePartialMessages` | Base64 PNG `image` blocks, streaming-input mode only | Pinned: intern `claude-opus-5-5` `high`, helper `claude-fable-5-1` `high` (`src/runtime.ts:22-25`; `docs/agent-runtime-research.md:120`) |
| ChatGPT via SIWC | First (§10.4) | None; new consent, encrypted refresh token in main | Only the `dum` function namespace, `store:false`, `stream:true`; token and scopes validated before content; no hosted tools | Responses event stream | `input_image` when the model accepts images | Account catalog: intern needs function calling; helper is a lower-latency model passing the text/image checks. Effort values [unverified] |
| Local: Ollama | First | None | Only Dum's function actions, to loopback `/v1/chat/completions`; cloud tags refused; endpoint identity and catalog capabilities checked | SSE; accumulate tool-call deltas | Base64 only, if the model advertises it | User-chosen verified models |
| Local: LM Studio | First | None | Same loop and loopback checks; never `/v1/responses` or `/api/v1/chat` | SSE with `delta.tool_calls` | Native `/api/v1/chat` documented; chat-completions `image_url` [unverified] | User-chosen verified models; images off until tested |
| GitHub Copilot SDK | Second, probe-gated | Copilot CLI login, if `getAuthStatus()` confirms it | `availableTools:["custom:*"]`, `enableConfigDiscovery:false`, in-process handlers, deny hooks; no active-action report, so the A6 probe gates release | SDK session events | Blob attachments | SDK model list with `reasoningEffort`, after the probe and a real conversation |

Claude's current code proves a stronger lockdown than Copilot's unverified path. HTTP backends need no runtime action report because Dum builds the list; the loop still rejects unknown names at call time (`docs/agent-runtime-research.md:311-342`).

## 6. Workload routing and always-on budget

### 6.1 Routing rules

| Workload | Role | Trigger and frequency | Cache, batch or skip |
| --- | --- | --- | --- |
| Ambient following and learning tracking | `helper` | Host aggregates local events continuously; at most one summarization per 10 minutes, only after new transcript, share, zone or evidence events; none while idle | No keystrokes or file watching. Batch up to five events keyed by `{zoneId, zoneRevision, transcriptRevision, evidenceRevision, memoryRevision}`; cache the note by that key; drop duplicate or no-op batches. Writes only bounded zone memory/history; never grants a skill |
| Wizard conversation aside | `helper` | At most one `wizard_aside` per turn, as the toolkit enforces (`src/session.ts:564-582`) | Inputs: request, explicit shares, zone snapshot, catalog anchors. Cache by request hash, zone revision and anchor-catalog revision for the request only |
| Wizard screen advice | image-capable `helper` | Off on fresh installs (`docs/revamp-design.md:247`). Current timing: poll every 30 s, model-check a changed frame at most once per 90 s (≤40/hour), 45 s timeout (`src/desktop/screen-wizard-advice.ts:6,148-163`). No added frequency | Hash PNG bytes first; skip identical frames. Skip while busy, recording voice, awaiting consent, the user is working on a suggested project, sleep/lock or stale epoch (`docs/revamp-design.md:247-249`). Pixels transient. Failed checks count toward the rate limit; only changed text is published (`src/desktop/screen-wizard-advice.ts:156-177`) |
| Conversation | `intern` | One streamed turn per Send; action round-trips bounded by `maxTurns`; no background calls | No caching of personal answers. Abort on Stop, switch or close. A failed route is shown, never retried elsewhere |
| Implement on command | `intern`; `helper` only to explain a refusal | Explicit command plus deterministic gate check. The model may read shared resources and call `change`. No yes/no step when the skills are held; never on ambient events | Just before writing, recheck each target's skills, prerequisites, language, holds, share grant and the SHA the model read. Return the diff, store a revert artifact; refuse on SHA mismatch |
| Suggested projects (practice) | `helper` | Explicit request only: one generation, plus an independent coverage audit when there are several milestones | Cache by zone goal/context, tree revision, focus skills, language, memory and personal-context revisions. Suggested or accepted projects never unlock skills |
| Optional courses, shared-picture description (`src/course.ts`, `src/look.ts`) | `helper` (image-capable for pictures) | Explicit request only | No background calls. A course records recognition at most; a picture is never evidence |
| Gate checks | Host code; `helper` only to explain a refusal | Every `change`, review, evidence or resource action; never periodic | `gate.mayChange`, language/prerequisite checks and holds decide; model output is untrusted. Cache only immutable tree reads within one request; recheck after every awaited boundary |

Current code already has the starting points: an explicit action set with a stop on anything else (`src/session.ts:730-751,796-810`), PNG-hash dedup and rate limiting (`src/desktop/screen-wizard-advice.ts:148-177`), Wizard image calls on the helper selector (`src/wizard.ts:8-10,256`), and separate Claude selectors `MODELS.dum` and `MODELS.helper` (`src/runtime.ts:22-25`). The revamp removes repository observation, so ambient inputs are app events and explicit shares (`docs/revamp-design.md:156,167`).

### 6.2 Rough per-hour estimate

[estimate] for one active hour, not measured billing:

| Workload | Calls | Input / output tokens each | Subtotal |
| --- | ---: | ---: | ---: |
| Conversation (one round-trip per send; action round-trips extra) | 6 | 2,000 / 500 | 12,000 / 3,000 |
| Ambient batches | 6 | 1,000 / 150 | 6,000 / 900 |
| Screen checks after dedup (screen advice on) | 4 | 1,500 / 150 | 6,000 / 600 |
| Suggested projects, courses, pictures; gate checks are local | 0 | — | 0 |
| **Total** | **16** | | **24,000 / 4,500** |

Action results, history replay and image encoding come on top and can raise input substantially. A constantly changing screen could hit the 40-check ceiling: 36 more checks add 54,000 / 5,400. Screen advice off removes the 4 checks; a quiet hour has no ambient calls. Dum should expose call and token counters. None of these numbers are provider limits or prices.

| Backend | Cost to the user |
| --- | --- |
| Claude subscription | No per-call API charge; usage draws on plan limits (`docs/agent-runtime-research.md:446`), which are not quantified here. Usage-limit errors stay visible |
| ChatGPT SIWC | No separate API key charge; SIWC sharing limits and plan policy apply. Stateless replay makes later turns larger. Quota and preview economics [unverified] |
| Local (Ollama, LM Studio) | No provider charge. Power, heat and latency depend on the machine. LM Studio is proprietary freeware for personal and internal business use; Dum does not bundle it (`docs/agent-runtime-research.md:114`) |
| Copilot SDK, when shipped | Not estimated before the probe; target is the subscription route with no API key. Terms for third-party desktop use [unverified] |

The research has no plan or API price data, so no dollar figure is given. Cost control is batching and skipping: no background call without new events, no duplicate-frame call, no unrequested suggestion, no model call where code decides.

## 7. Lockdown and runtime verification

Every backend meets this before releasing user content (`docs/agent-runtime-research.md:311-331`):

1. **Provenance first.** Credentials, endpoint and model resolve first. No prompt, transcript, image, share or personal context crosses the route before that.
2. **Isolation.** No user or project config, MCP servers, plugins, hooks, skills or context files beyond what Dum puts in the system prompt. Exception: Claude auto-memory may load despite `settingSources:[]`, and whether safe mode stops it is [unverified]; Claude does not meet this item today (§10.1; `docs/agent-runtime-research.md:59`).
3. **Action removal.** A backend's built-in file, shell and web actions are absent from the model's list, not merely denied. HTTP adapters build the list; Claude uses `tools:[]` plus only Dum's SDK MCP server. Copilot cannot claim this without the probe.
4. **Call-time backstop.** Normalize the provider's name to the bare Dum name, reject anything outside `OpenOptions.actions`, end the session on an unknown action, never retry on another backend.
5. **Runtime evidence.** Where the backend reports active actions (`Capabilities.runtimeActionCheck`), assert them at every open and turn; for Claude, `system/init` actions, MCP server source and name, plugins and API-key source. HTTP routes assert the body Dum built. Copilot needs the A6 probe.
6. **Environment.** Each backend builds its own child env. Claude keeps `subscriptionEnv()` and the bundled absolute executable (`src/runtime.ts:34-58,95-110`). Copilot also drops `GH_TOKEN`, `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN`. SIWC tokens travel over the host/main channel, never env. Local adapters accept only loopback.

A failed check closes the session, invalidates the request binding, keeps the draft and transcript, and leaves the backend choice alone until the user picks a recovery. There is no best-effort mode.

## 8. Interfaces

### 8.1 Agent contract

The research interface (`docs/agent-runtime-research.md:166-305`) with the changes in §8.2:

```ts
// src/agent/types.ts
import type { z } from "zod";
import type { ZoneContext } from "../zone-types.ts";
import type { RequestBinding } from "../share-types.ts";

export type BackendId = "claude" | "chatgpt" | "local" | "copilot";
/** "intern" is the conversation; "helper" is every bounded one-shot (course, suggestions, Wizard, look). */
export type Role = "intern" | "helper";
export type Selector = { backend: BackendId; model: string; effort: string | null };

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
  verified: boolean;            // proven with a real call on this backend
};

export type Capabilities = {
  images: boolean;
  interrupt: boolean;
  runtimeActionCheck: boolean;  // backend reports active actions; open()/turn() assert them
};

export type BackendStatus = {
  id: BackendId;
  label: string;
  installed: boolean;
  signedIn: boolean;
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
  actions: readonly DumAction[];       // closed set; [] for one-shot helpers
  signal: AbortSignal;
  maxTurns?: number;
};

export interface AgentSession {
  turn(input: UserTurn): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentBackend {
  readonly id: BackendId;
  readonly label: string;
  status(): Promise<BackendStatus>;
  login(ui: LoginUi): Promise<void>;
  code?(code: string): void;
  cancelLogin(): void;
  models(): Promise<ModelOption[]>;
  capabilities(selector: Selector): Capabilities;
  open(o: OpenOptions): Promise<AgentSession>; // resolves only after provenance passes; never falls back
}
```

```ts
// src/agent/registry.ts
export type AgentChoice = { backend: BackendId; intern: Selector; helper: Selector };
export function backend(id: BackendId): AgentBackend;
export function chosen(): AgentChoice;          // throws "choose who powers Dum" when none
export function selector(role: Role): Selector; // Claude: MODELS.dum / MODELS.helper, unchanged
```

ChatGPT and local share one loop:

```ts
// src/agent/loop.ts
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

export function loopSession(client: ModelClient, o: OpenOptions): AgentSession;
```

The helper seam:

```ts
// src/oneshot.ts
export async function oneShot(
  prompt: string,
  o: { cwd: string; zone: ZoneContext; binding: RequestBinding; images?: readonly Picture[]; signal?: AbortSignal },
): Promise<string>; // helper selector, actions: [], maxTurns: 1; throws if images and !capabilities.images
```

### 8.2 Changes from the research and revamp §6

1. **Naming.** Research `DumTool`, `OpenOptions.tools`, `ModelOption.tools`, `Capabilities.runtimeToolCheck`, `AgentEvent` `"tool"` and `WireTool` become `DumAction`, `actions`, `actions`, `runtimeActionCheck`, `"action"` and `WireAction`: the glossary says model-callable functions are never "tools" (`docs/architecture.md:57`). `WireMessage` keeps the provider role `"tool"`.
2. **Model placement.** All model calls run in the host, as revamp §6 assigns (`docs/revamp-design.md:257-258`); this is the choice within rule 5 from §1. Host initialization gains `AgentChoice` and backend resolution; main does SIWC OAuth, token operations and settings writes only.
3. **Request binding.** `OpenOptions` and `oneShot` gain `zone` and `binding`. `RequestBinding` is the revamp's `{zoneId, zoneEpoch, inputToken, requestId}` with a live zone (`docs/revamp-design.md:288-289`). Events with a stale binding are dropped.
4. **Required `cwd`.** As in the research, `oneShot`'s `cwd` is required: always the active zone's empty `runtime/`, never `process.cwd()`, a shared folder or a repository (`docs/agent-runtime-research.md:280,309`; `docs/revamp-design.md:60,192`).
5. **Session lifetime.** Keep revamp `run(request, ctx, opts)` and close the backend session after each top-level request. No resume: the desktop already passes `persist:false`, and the revamp deletes session pointers (`src/desktop/controller.ts:326`; `docs/revamp-design.md:168,338,344`).
6. **`session.ts` cutover.** Replace its SDK imports, `createSdkMcpServer` assembly and SDK event parsing with `AgentBackend.open().turn()`. The toolkit's gate and action definitions become `DumAction[]`, keeping the `store.operation` wrapper, cancellation and unknown-action stop (`src/session.ts:264-271,330-585,730-842`; `docs/agent-runtime-research.md:418`).
7. **Wizard seam.** `wizard.Decision` gains `zone: ZoneContext`. Wizard calls take the registry's helper selector instead of `wizard.MODEL`/`EFFORT` (copies of `MODELS.helper`); for Claude it is the same selector. `ScreenWizardAdvice` receives a host `check(image, zone, signal)` callback and stops importing Wizard code in main (`src/wizard.ts:8-22,256`; `src/desktop/screen-wizard-advice.ts:3-4,8-21`; `docs/revamp-design.md:346,377-378,482-484`).
8. **Protocol names.** Revamp `runtime-check`, `runtime-login`, `runtime-login-open`, `runtime-login-code`, `runtime-login-cancel` become `agent-check`, `agent-login {backend}`, `agent-login-open`, `agent-login-code`, `agent-login-cancel`, plus `agent-select {choice}`. `Snapshot.runtime` becomes `{backends: BackendStatus[]; chosen: AgentChoice | null}` (`docs/revamp-design.md:411`; `docs/agent-runtime-research.md:415`).
9. **Changes, not proposals.** Revamp §6 has `proposeChange`/`proposeFile`, an action list with `propose_plan`, `propose_change` and `propose_file`, and a plan-approval decision (`docs/revamp-design.md:183,302-303,352`). Rule 6 says a permitted command writes the change directly with no yes/no step, and the glossary replaces "proposal" with "change" (`docs/architecture.md:60,72`). Replace them with one gated `change` action that writes existing-file or new-file content after the live gate and SHA check, returns a `ChangeReceipt` with the diff, and stores a revert artifact. Drop the `"plan"` kind from `respond`; skills are declared on the `change` call and checked there. No aliases, no apply-later path.
10. **Host operations.** Keep revamp `openZone`, `send`, `respond`, `observeScreen`, `interrupt` and `close`; add `agent-select`; `send` resolves the host's current `AgentChoice`. Renderer-supplied backend or selector fields are checked against the main-owned choice and cannot pick a fallback (`docs/revamp-design.md:348-359`).
11. **Settings and credentials.** Settings stay token-free and main stays the only settings writer, correcting revamp §6's "host is the authoritative settings writer" to match rule 4 (`docs/revamp-design.md:262`; `docs/architecture.md:43,70`). Main persists the validated choice, then sends the host its copy. Add an encrypted main-process credential store and a host-to-main token request; no credentials in `DUM_*` env vars (`docs/agent-runtime-research.md:379-380`).
12. **Claude selectors stay in `src/runtime.ts`.** Research A1 deletes `runtime.ts` and moves `MODELS` into a Claude backend table, which needs revamp §7's "without changing model selectors" amended (`docs/agent-runtime-research.md:410`; `docs/revamp-design.md:443`). That is not approved (§10.3), so the Claude backend imports `MODELS` and `verified()` from `runtime.ts` unchanged.

The direct-change seam:

```ts
// src/changes.ts, host-owned
import type { SkillRef } from "./zone-types.ts";
import type { RequestBinding, ResourcePath } from "./share-types.ts";

export type ChangeReceipt = {
  id: string;
  zoneId: string;
  target: ResourcePath;
  baseSha: string | null;
  nextSha: string;
  diff: string;
  appliedAt: string;
  revertible: true;
};

export function change(
  zoneId: string,
  binding: RequestBinding,
  target: ResourcePath,
  baseSha: string | null, // SHA of the bytes the model read; null for a new file
  next: string,
  skills: SkillRef[],
): Promise<ChangeReceipt>;

export function revertChange(
  zoneId: string,
  binding: RequestBinding,
  changeId: string,
): Promise<void>;
```

`change` gives the model no arbitrary filesystem access. It accepts only a virtual resource in the current share or target set, runs the exact-resource, language, prerequisite and hold checks, compares current bytes with `baseSha`, and writes only on an explicit request with the skills held. Without `baseSha`, an edit made between the model's read and the write would be overwritten, which rule 7 forbids. The response is the diff shown after the write; revert is a UI action, not a model decision.

## 9. Implementation slices

Slices follow revamp §8: contracts first, disjoint ownership, phase barriers (`docs/revamp-design.md:447-492`). Research ids A0–A7 ride the revamp slice that owns their files (research Option A, `docs/agent-runtime-research.md:396-433`), except where noted. No slice runs builds, tests or formatters mid-flight; the integration owner runs final checks once.

### Phase 0: contracts

1. **A0, agent contract and protocol (rides C0)**
   - **Owns:** new `src/agent/types.ts`, `src/agent/registry.ts`, `src/agent/schema.ts`, `test/agent-registry.test.ts`; additions to C0's `src/desktop/protocol.ts`, `src/desktop/host-protocol.ts`, `src/share-types.ts` at the barrier.
   - **Work:** the §8 types; `BackendStatus[]`/`AgentChoice` in the snapshot; strict `agent-*` requests; selector, binding and event schemas; the `change`/`revertChange` seam with the integration owner.
   - **Acceptance:** rejects malformed or stale bindings, unknown backends, unadvertised selectors, renderer-supplied tokens or images, and legacy `runtime-*` requests. Goal, zone and settings operations need no model call.
   - **Depends on:** nothing; freezes before everything else.

### Phase 1: foundations, parallel after A0

2. **A5, Dum loop and local adapters (own slice, new files only)**
   - **Owns:** new `src/agent/loop.ts`, `src/agent/openai-compatible.ts`, `src/agent/local.ts`, `test/agent-loop.test.ts`, `test/agent-local.test.ts`.
   - **Work:** SSE parsing, tool-call delta accumulation, image encoding, abort, unknown-action stop, `maxTurns`; Ollama/LM Studio loopback detection, catalogs, cloud refusal, capability checks.
   - **Acceptance:** a fake SSE server covers text, split deltas, action-result continuation, unknown action, mid-stream abort and `maxTurns`; non-loopback and cloud-tagged models are refused; no server-side MCP route is called.

3. **A4, SIWC and Responses adapter (own slice, new files only)**
   - **Owns:** new `src/agent/siwc.ts`, `src/agent/openai-responses.ts`, `src/desktop/credentials.ts`, `test/agent-siwc.test.ts`.
   - **Work:** PKCE, state, nonce, loopback listener, `dynamic_agent_client` registration, token and scope validation, async `safeStorage`, refresh; `store:false`/`stream:true`, namespaced actions, `input_image`, readable usage-limit errors.
   - **Acceptance:** a fake auth server covers state mismatch, wrong scope, expired token, refresh failure and callback timeout; a fake stream covers text, action, retry and error; tokens never reach settings, logs or env. Namespace, effort and reasoning-replay rules block release until verified against the primary contract (`docs/agent-runtime-research.md:424,447-453`).
   - **Depends on:** A0 and A5's `loop.ts` contract.

4. **Revamp S1–S4, plus A3's settings field**
   - **Owns:** the files revamp §8 Phase 1 lists. A3's `agent: AgentChoice` field in `src/desktop/settings.ts` rides S1 (`docs/agent-runtime-research.md:421,431`).
   - **Acceptance:** the revamp's stale-binding, no-clobber, hold, capture-lifetime and native-bridge checks pass at the final barrier, and main gets host callbacks instead of model code (`docs/revamp-design.md:457-464`).

### Phase 2: domain and host cutover

5. **A1, Claude backend (rides D1)**
   - **Owns:** new `src/agent/claude.ts`; `src/runtime.ts` edits within D1; the `runtime` tests.
   - **Work:** put `closed`, `start`, `assertProvider`, `assertSubscription`, the filtered env, action namespacing and SDK event mapping behind `AgentBackend`; take the executable path as a constructor argument instead of `DUM_CLAUDE_BIN`; assert `system/init` every turn. `MODELS` and `verified()` stay unchanged (§8.2 item 12); auto-memory behavior is not changed (§10.1).
   - **Acceptance:** fixture or real SDK init rejects API-key, foreign-action, MCP and plugin metadata; no input before provenance passes; abort closes startup and turns; absolute executable, no PATH fallback.
   - **Depends on:** A0; the revamp deleting `src/cli.tsx` and `src/self.ts` before terminal-only code leaves `runtime.ts`.

6. **A2, conversation and helper cutover (rides D1)**
   - **Owns:** D1's `src/session.ts`, `src/store.ts`, `src/oneshot.ts`, plus `src/look.ts`, which no revamp slice lists (`docs/agent-runtime-research.md:418`); their tests.
   - **Work:** `DumAction[]` from the revamp toolkit, `AgentChoice` resolution, `AgentSession.turn`; SDK imports only in `src/agent/`; required helper `cwd`; no desktop resume or repository assumptions; Wizard and image calls on the helper selector.
   - **Acceptance:** zone context and explicit shares reach the system prompt; no foreign or host actions; Stop, close and switch withdraw decisions; locked-concept refusal remains; a permitted `change` writes directly and returns diff and revert data; image-incapable selectors fail readably.

7. **A2b, learning and Wizard callers (rides D2)**
   - **Owns:** D2's `src/practice.ts`, `src/course.ts`, `src/wizard.ts`; tests.
   - **Work:** replace `MODELS.helper`, `wizard.MODEL` and `EFFORT` with the registry's helper selector (same Claude selector); pass `ZoneContext`, personal context and binding through `oneShot`; keep sourced-or-silent filtering and Wizard silence while the user works on a suggested project (`src/wizard.ts:266-275`).
   - **Acceptance:** suggested projects give no credit; courses record recognition only; the Wizard never creates a gate; image calls use only a verified image-capable helper.

8. **A2c, host and controller (rides D3)**
   - **Owns:** D3's `src/desktop/controller.ts`, `src/desktop/host.ts`, `src/desktop/host-client.ts`; tests.
   - **Work:** host owns the active `AgentChoice`, registry, sessions, credential request channel and per-backend child env; main stays the settings writer and sends validated updates; every request carries binding and zone epoch; one H writer lock; fresh history after a crash.
   - **Acceptance:** a child process opens a nested zone without Git, uses only the selected backend, rejects late events after switch or crash, serves tree and settings before login, returns only live Wizard results; a second host cannot take the H lock.

### Phase 3: setup and surfaces

9. **A1b + A3, main-side setup and credentials (ride U2)**
   - **Owns:** new `src/agent/claude-setup.ts`, rewritten from `src/desktop/runtime-setup.ts`, which is deleted; new `src/desktop/agent-setup.ts`; U2's `src/desktop/main.ts`, `src/desktop/ipc.ts`; setup tests in `test/desktop-native.test.ts`.
   - **Work:** replace Claude-only `RuntimeSetup` with parallel status and login routing; keep the paste-code flow; add SIWC browser and token operations; persist the choice through main-owned settings; strict `agent-*` requests; no Git readiness. Main now creates `RuntimeSetup` and sets `DUM_CLAUDE_BIN` so Wizard screen calls can run in main (`src/desktop/main.ts:281-288,321`); the cutover removes that path.
   - **Acceptance:** missing Claude, signed-out Claude, SIWC callback failure, absent local endpoint and backend selection all recover without losing goal or draft; snapshots carry no credential or account field; main makes no model call.
   - **Depends on:** A0, A1, A4.

10. **A3b, setup and Agent settings UI (rides U1)**
    - **Owns:** U1's renderer setup and settings files and new setup components.
    - **Work:** **Who powers Dum?**, ready-row ordering and preselection, per-backend sign-in states, model and effort picker for ChatGPT and local, image and function-calling warnings, Settings → Agent; keyboard-only use and the canonical draft keep working.
    - **Acceptance:** the goal is the first surface; setup appears at the first model-backed need; one backend is persisted; changing it closes the session; failures show recovery without tokens or account identifiers.

11. **U3, screen observer (revamp slice; no research id)**
    - **Owns:** `src/desktop/screen-wizard-advice.ts` and its tests.
    - **Work:** injected `capture`/`check`/`publish`/`blocked`; pass `{id, epoch, revision}`; no Wizard import in main; keep hash, rate, cancellation and dedup, and off by default on fresh installs.
    - **Acceptance:** no capture or check while off, busy, recording voice, awaiting consent, while the user works on a suggested project, during sleep, or with a stale epoch; identical PNGs call no model; a failed check is visible and publishes nothing; no image persisted.

### Phase 4: release gating and integration

12. **A6, Copilot probe and packaging (after the revamp; X1 owns package and builder files if still in flight)**
    - **Owns:** new `src/agent/copilot.ts`, `tools/copilot-probe.mjs`, `test/agent-copilot.test.ts`; dependency and `electron-builder.yml` changes.
    - **Work:** implement only after `availableTools`, config discovery and deny hooks pass the live probe; out of first-wave defaults until then.
    - **Acceptance:** read-file, shell and URL attempts are absent or denied; no built-in action runs; bundled CLI, login, license and terms reviewed. A failed probe leaves Copilot unavailable.

13. **A7, policy and user docs (rides X3)**
    - **Owns:** `README.md`, `CONTRIBUTING.md` and the install and product copy X3 lists; not this file.
    - **Work:** remove the blanket non-Claude ban, which the owner has lifted; document per-backend data flow, the local/cloud boundary, setup, selector verification, ambient batching, limits and no-fallback behavior; keep the ACP, Google and Codex verdicts accurate.
    - **Acceptance:** docs promise nothing unverified about SIWC fields, Claude auto-memory isolation, Copilot lockdown or native behavior.

14. **Final integration owner**
    - **Owns:** cross-slice caller repairs after the barriers; no aliases.
    - **Checks:** `npm run typecheck`, `npm test`, `npm run desktop:smoke`, then physical-Mac and real-model acceptance separately. The smoke starts in a non-Git folder, creates the goal before auth, preserves zones and drafts, and shows no old grants or approvals after relaunch (`docs/revamp-design.md:494-538`). A no-login Linux smoke proves nothing about Claude, SIWC, local-model quality, native voice or Mac windows.

## 10. Owner decisions needed

1. **Claude auto-memory.** The Agent SDK docs say auto-memory (`~/.claude/projects/<project>/memory/`) loads regardless of `settingSources` unless `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set. `src/runtime.ts:FLAGS` sets neither, and whether safe mode covers it is [unverified] (`docs/agent-runtime-research.md:59,467`; `src/runtime.ts:84-91`). Turning it off is not approved. Options: approve one of the two switches; keep current behavior and document the context leak; or hold the Claude release while local and ChatGPT proceed. Until then, Claude does not claim §7 item 2.
2. **Anthropic's claude.ai login policy.** The research found unresolved tension between Anthropic's restriction on third-party claude.ai login and its allowance for running the unmodified Claude Code binary. Dum relays a pasted OAuth code into the CLI and refuses API keys (`docs/agent-runtime-research.md:439-446`; `src/desktop/runtime-setup.ts:239-247`; `src/runtime.ts:186-189`). Contacting Anthropic is not approved. Until the owner decides, do not expand the Claude flow or describe it as Anthropic-approved; ChatGPT and local stay available.
3. **Claude selector ownership.** `src/runtime.ts` pins `MODELS.dum` and `MODELS.helper` and refuses anything else (`src/runtime.ts:21-32`); revamp §7 keeps `runtime.ts` "without changing model selectors" (`docs/revamp-design.md:443`). Letting the refactor change this is not approved, so this design keeps the pinned pair with no Claude picker (§4.1 step 6, §8.2 item 12). Decide whether to move Claude selectors into a per-backend table, offer a Claude picker and delete `runtime.ts`, as research Option A proposes (`docs/agent-runtime-research.md:410`).
4. **SIWC preview.** The namespace format, `reasoning.effort` values and reasoning replay are [unverified] (`docs/agent-runtime-research.md:447-453`). Recommendation: ship ChatGPT only after the adapter's primary-source contract tests pass. Without approval, keep ChatGPT hidden and ship Claude and local.
5. **Ambient budget.** This design meets "always on" with local event aggregation and at most six helper batches an hour while active, with screen advice opt-in on fresh installs (`docs/architecture.md:74`; `docs/revamp-design.md:247`). The owner can overrule it, for example by limiting ambient model calls to explicit user turns while keeping the host event behavior.
6. **LM Studio images.** Chat-completions image input is [unverified] (`docs/agent-runtime-research.md:126,458`). Decide whether text-only LM Studio is acceptable in the first wave; otherwise local screen and image work is Ollama-only until LM Studio passes a real image call.
7. **Host-only model calls.** Rule 5 also allows model calls in main; §1 puts all of them in the host. The owner can overrule, for example to keep Wizard screen calls in main as today, in which case main needs its own `AgentChoice` copy and a token path (`docs/agent-runtime-research.md:478`).

## 11. Risks and unknowns

- **SIWC contract drift.** Preview field restrictions, the namespace format, usage limits and effort or reasoning semantics may change. The adapter fails closed and shows reauthentication or update states rather than silently changing the request (`docs/agent-runtime-research.md:447-453`).
- **Local quality and latency.** Function-calling quality varies, Ollama has no `tool_choice`, and context length and throughput depend on hardware (`docs/agent-runtime-research.md:456`). A selector can be available yet unsuitable; `verified` requires real action and image calls.
- **Prompt quality across providers.** The conversation contract was tuned on Claude (`src/session.ts:57-156`). The gate stays host-side, but teaching, suggested projects and Wizard quality need recorded real conversations per backend (`docs/agent-runtime-research.md:466`).
- **Screen privacy.** Frames can show private windows and drafts. Hashing, rate limits and blocks reduce calls, not what an enabled capture sees, so permission, status, pause and the transient-data boundary stay visible (`docs/revamp-design.md:247-249,550`).
- **Direct-change races.** A user edit between read and write, a zone switch, a host crash or a revert against a changed file must refuse rather than clobber (rule 7). The change artifact is for recovery, not a sandbox.
- **Credential channel.** Main-only `safeStorage` with host sessions adds a token request channel. Its schemas, sender identity, refresh races and crash invalidation need end-to-end tests; tokens stay out of settings, logs, env and renderer snapshots (`docs/agent-runtime-research.md:379-380`).
- **ACP later.** ACP v2 may add isolation controls, but today it has no allowlist or report of an agent's active actions. Revisit only on new primary sources and a runtime probe (`docs/agent-runtime-research.md:153-160,468`).
- **Native behavior.** Nothing here proves browser OAuth, Keychain or `safeStorage` prompts, Screen Recording permission, full-screen and Spaces focus, the voice bridge or packaged helpers. Those need the revamp's physical-Mac acceptance and stay unexercised until observed (`docs/revamp-design.md:534-538`).

Risks covered earlier are not repeated: Claude auto-memory (§7 item 2, §10.1), subscription quotas (§6.2), image capability gaps (§4.4, §5) and Copilot lockdown evidence (§4.5).

# Agent runtime research: making Dum agent-agnostic

Research date: 2026-10-08. Branch `revamp-zones`. This doc covers only the model runtime. Zones, the menu bar, the command bar and the voice bubble are designed in `docs/revamp-design.md`, written in parallel. §5 maps this work onto that design's slices.

**Labels.** A linked claim was read in that primary source on the research date. **[unverified]** means a primary source could not confirm it. **[inference]** means a conclusion drawn from verified facts that no source states outright. Version numbers are the latest published on the research date.

---

## 1. Recommendation on one page

- **Dum needs a model that can call Dum's tools. It does not need a coding agent.** Every agent's own file, shell and web tools are things Dum has to switch off anyway (that is the core rule). An agent harness is worth using only when it is the sanctioned route to a subscription the user already pays for, or when it brings loop or streaming plumbing for free.
- **Write Dum against one in-process `AgentBackend` interface (§4.3).** Implementations come in two families:
  - **Harness backends.** A vendor SDK runs the loop and calls Dum's tools in-process: Claude Agent SDK (today), and later GitHub Copilot SDK.
  - **Dum-loop backends.** Dum runs a small tool loop of its own over an HTTP model API: ChatGPT through *Sign in with ChatGPT* plus the Responses API, and local models through an OpenAI-compatible endpoint (Ollama, LM Studio).
- **Ship first:** Claude Agent SDK (the reference backend, refactored behind the interface), **ChatGPT via Sign in with ChatGPT**, and **local models**. **Second:** GitHub Copilot SDK, once a live lockdown probe passes (§6, R4).
- **Don't adopt ACP (Agent Client Protocol) as the core abstraction yet.** ACP has no standard way for a client to switch off an agent's built-in tools. Lockdown would be a separate non-standard recipe per adapter, and some of those recipes can't be checked at runtime (§3.1, §4.2). The interface in §4.3 is shaped so an ACP backend can be added later, per agent, once its lockdown recipe is verified.
- **Unusable today:**
  - Gemini CLI. Consumer login was shut off on 2026-06-18, and its ToS forbids third-party software using its OAuth.
  - Antigravity CLI. Its ToS forbids use "in connection with products not provided by us".
  - Codex app-server and codex-acp. Lockdown is partial and depends on experimental fields, and OpenAI points local and open-source apps to Sign in with ChatGPT instead.
  - OpenCode, Cursor, Qwen Code and Goose. Lockdown is partial or unverified, or there is no subscription login to reuse.
- **A policy question sits on the reference backend itself.** Anthropic's docs say third-party apps may not offer claude.ai login "unless previously approved". A separate clause allows an end user to sign in to the *unmodified* Claude Code binary that a product runs. Some specifics of Dum's flow need confirming with Anthropic (§6, R1). This is independent of being agent-agnostic, and it is one more reason to have more than one backend.

---

## 2. Current coupling to Claude (inventory)

All of these live in the conversation runtime and its setup. Three files import `@anthropic-ai/claude-agent-sdk` and survive the revamp: `src/runtime.ts`, `src/oneshot.ts` and `src/session.ts`. `src/self.ts` imports it too, but it and `src/cli.tsx` are terminal-only and the revamp deletes them.

| # | Claude-specific assumption | Where (file:symbol) |
|---|---|---|
| 1 | **One SDK, one runtime.** Everything goes through `query()` from `@anthropic-ai/claude-agent-sdk`. | `src/runtime.ts` (imports `query`, `resolveSettings`, SDK types); `src/oneshot.ts:oneShot`; `src/session.ts` imports `tool`, `createSdkMcpServer`, `getSessionMessages`, `SDKUserMessage`; `src/self.ts:maintain` (terminal-only) |
| 2 | **Model ids are fixed Claude selectors.** `claude-opus-5-5` / `claude-fable-5-1` at `high`; anything else is refused. | `src/runtime.ts:MODELS`, `verified()`. Consumers: `src/session.ts:run` (`closed({model, effort})`, `store.setModel`); `src/course.ts:design/judge/answer`; `src/practice.ts` (helper selector at ~473, 540, 614, 653); `src/wizard.ts:MODEL/EFFORT`; `src/look.ts:look`; `src/desktop/controller.ts` (`setModel` ~244-245). `src/store.ts:setModel` / `State.models` store a bare model string. |
| 3 | **Effort type is the SDK's `EffortLevel`.** | `src/runtime.ts:Selector`, `ClosedInput.effort`; `src/oneshot.ts:Opts.effort` |
| 4 | **Subscription provenance.** Only the claude.ai OAuth login, first-party route, no API key. | `src/runtime.ts:subscriptionEnv` (drops `ANTHROPIC_*`, `GEMINI_*`, `GOOGLE_*`, `VERTEX_*`, `ANTIGRAVITY_*`, `*_API_KEY`); `login()` (`claude auth status`); `assertProvider()` (`accountInfo().apiProvider === "firstParty"`, then auth status `claude.ai`); `assertSubscription()` (`init.apiKeySource === "none"`); `start()` (refuses managed policy via `resolveSettings` and withholds all user input until provenance passes) |
| 5 | **The executable is the SDK's bundled `claude`.** | `src/runtime.ts:claudeExecutable` (`DUM_CLAUDE_BIN` or `claude` on PATH), `cliArgs()` (`--safe-mode`, empty setting sources, `FLAGS`); `src/desktop/runtime-setup.ts:bundledCandidates/resolveBundled/runtimeExecutable`; `src/desktop/main.ts` (sets `DUM_CLAUDE_BIN` for main-process wizard calls); `src/desktop/host-client.ts:HostController.choose` (child env = `subscriptionEnv()` + `DUM_CLAUDE_BIN`); `electron-builder.yml` `asarUnpack: node_modules/@anthropic-ai/claude-agent-sdk-*/claude` |
| 6 | **Closed tool set via Claude options and naming.** | `src/runtime.ts:closed` (`tools: []`, `settingSources: []`, `skills: []`, `plugins: []`, `strictMcpConfig`, `permissionMode: "default"`, `canUseTool`); `onlyServers()` (`mcp__<server>__` prefix, `mcpServer.source === "sdk"`); `src/session.ts:run` (`createSdkMcpServer({name:"dum"})`, `allowed` = `mcp__dum__*`, stops on any other `*tool_use` block); `src/oneshot.ts` (`assertSubscription(msg, [])` = zero tools) |
| 7 | **Tool definitions are zod raw shapes wrapped as SDK MCP tools.** | `src/session.ts:Tool`, `define()`, `toolkit()`; the wrapping in `run()` (`tool(name, desc, schema, handler)`, `store.operation`, `Cancelled` → `isError`) |
| 8 | **Streaming events are SDK message shapes.** | `src/session.ts:run` loop (`system/api_retry` → `retryStatus()`, `system/init`, `assistant` content blocks, `result` → `failure()`); `src/oneshot.ts` (`assistant` text, `result.subtype` / `is_error`) |
| 9 | **Turn input is an `SDKUserMessage` async generator.** | `src/session.ts:run` `turns()` / `userTurn()`; `src/runtime.ts:start` input gate |
| 10 | **Resume is a Claude session id.** | `src/session.ts:resumable` (`.dum/claude-session` plus `getSessionMessages`), `RunOptions.persist`; `src/memory.ts:SESSION_FILES` (`claude-session`); `src/oneshot.ts` (`persistSession: false`). **The desktop already passes `persist: false`** (`src/desktop/controller.ts:converse`), so only the terminal edition resumes. |
| 11 | **Images are Anthropic base64 `image` blocks, PNG only.** | `src/oneshot.ts:Opts.images`; `src/look.ts:look/decode`; `src/wizard.ts:Decision.images`, `screenDecision` (run from the main process by `src/desktop/screen-wizard-advice.ts`) |
| 12 | **Abort and interrupt use SDK controls.** | `src/runtime.ts:start` (`abortController`); `src/session.ts:run` (`session.interrupt()`, falling back to abort; `store.onInterrupt`); `src/oneshot.ts` (signal → abort); `src/store.ts:helper` |
| 13 | **User-facing copy names Claude.** | `src/session.ts:failure` ("Run `claude update`"), `retryStatus`, `working("starting Claude")`; `src/desktop/controller.ts:converse` ("Claude couldn't start"); `src/desktop/protocol.ts:RuntimeStatus`; `src/desktop/ipc.ts` `runtime-check/login/login-open/login-code/login-cancel`; `src/desktop/ui/panel.ts` (setup checklist, Settings → "Claude" group, wizard hints "sent to Claude"); `src/desktop/ui/companion.ts` (sticky "can't find Claude" / "sign in to Claude"); `src/site/install.html` |
| 14 | **Written policy forbids other providers.** | `CONTRIBUTING.md` "Close every model route … No Gemini, Google/Vertex, Antigravity, paid API credentials, or hidden fallback providers" and "The app carries its runtime"; `README.md` (Claude subscription, exact models, bundled Claude Code) |

**Tests that pin this behavior:**
- `test/runtime.test.ts`, all of it: `closed`, `subscriptionEnv`, `onlyServers` via `canUseTool`, `assertSubscription`, `assertProvider`, `oneShot` with a fake `Query`, `start` input withholding, managed-policy refusal, `login`.
- `test/desktop-native.test.ts`:
  - The `Router` is constructed with a `RuntimeSetup` at ~226.
  - Tests at ~455-567 cover `claudeExecutable`, `bundledCandidates`, `resolveBundled`, `login`, `start` abort, `RuntimeSetup` sign-in, and the missing-runtime path.
- `test/desktop-controller.test.ts`:
  - The look test at ~297 injects a fake `Query` and asserts `persistSession:false` and `tools:[]`.
  - `withSilentClaude` tests at ~365-447 set `DUM_CLAUDE_BIN` to a fake `claude` and assert that Stop kills it.
- `test/store.test.ts` ~160 (`setModel` with Claude ids).
- `test/practice.test.ts` (injects `ask: typeof oneShot`).
- `tools/desktop-smoke.mjs` (`CLAUDE_CONFIG_DIR`, `/^Sign in with your Claude subscription/`).

**Gap found while mapping.** The Agent SDK docs say auto memory (`~/.claude/projects/<project>/memory/`) is loaded into the system prompt *regardless of `settingSources`* unless `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set ([claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)). `src/runtime.ts:FLAGS` sets neither. Whether `--safe-mode` already covers this is **[unverified]**. It is read-only context, not a tool, so the write rule still holds, but it is a context leak into Dum's closed session.

---

## 3. Options researched

### 3.1 Agent Client Protocol (ACP)

**What it standardizes:**
- **Transport.** JSON-RPC 2.0 over newline-delimited stdio, with the client launching the agent as a subprocess ([transports](https://agentclientprotocol.com/protocol/v1/transports)). v1 (`protocolVersion: 1`) is stable. v2 has been a Draft since 2026-07-20 ([v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft)).
- **Baseline methods.** `initialize`, `authenticate`, `session/new`, `session/prompt` and the `session/cancel` notification. Optional: `session/load`, `session/resume`, `session/list`, `session/close`, `session/set_mode`, `session/set_config_option`.
- **Client methods.** `session/request_permission` is baseline. `fs/*`, `terminal/*` and `elicitation/create` are optional ([overview](https://agentclientprotocol.com/protocol/v1/overview), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup)).
- **Streaming.** Delivered as `session/update` notifications: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update` and others ([prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)).
- **Images.** Gated by `promptCapabilities.image`, as base64 `{type:"image", mimeType, data}` blocks ([initialization](https://agentclientprotocol.com/protocol/v1/initialization), [content](https://agentclientprotocol.com/protocol/v1/content)).
- **Model and effort.** Selected through Session Config Options (categories `model` and `thought_level`); stable v1 has no `session/set_model` ([config options](https://agentclientprotocol.com/protocol/v1/session-config-options)).
- **Auth.**
  - `authMethods` are of type `agent` (the client calls `authenticate`) or `terminal` (the client re-runs the agent interactively) ([authentication](https://agentclientprotocol.com/protocol/v1/authentication)).
  - A login URL can reach the client through URL-mode elicitation ([elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)).
  - Stable v1 has no "am I logged in?" method; `auth/status` is a draft RFD ([RFD](https://agentclientprotocol.com/rfds/get-auth-state)).
- **MCP passthrough.**
  - "All Agents **MUST** support the stdio transport", while HTTP and SSE are optional.
  - "Agents **SHOULD** connect to all MCP servers specified by the Client. Clients **MAY** use this ability to provide tools directly to the underlying language model by including their own MCP server."
  - Nothing in the spec excludes the user's own MCP servers ([session setup](https://agentclientprotocol.com/protocol/v1/session-setup)).
  - Serving MCP over the ACP connection itself is only a draft ([MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp)).
- **SDK.** TypeScript `@agentclientprotocol/sdk` 1.7.0, Apache-2.0 ([package.json](https://github.com/agentclientprotocol/typescript-sdk/blob/main/package.json)).

**Tool restriction is not standardized. This settles it for Dum:**
- "The Agent **MAY** request permission from the user before executing a tool call". Permission prompts are at the agent's discretion ([tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)).
- Leaving out the fs capability means only "the Agent **MUST NOT** attempt to call the corresponding filesystem method" on the *client*. It says nothing about the agent's own file tools ([file system](https://agentclientprotocol.com/protocol/v1/file-system)). The same holds for terminals ([terminals](https://agentclientprotocol.com/protocol/v1/terminals)).
- The maintainers note that agents "mostly stuck to their standard implementations", and v2 drops the client fs/terminal surface ([RFD](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities)).
- GitHub's ACP docs say `session/new` "does not carry tool-filtering or reasoning settings" ([Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)).
- No ACP method lists the tools a session can use. Gemini's ACP sends `available_commands_update` (slash commands), not tools ([acpSession.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpSession.ts)).

**Agents and adapters** ([registry](https://agentclientprotocol.com/get-started/registry), [agents](https://agentclientprotocol.com/get-started/agents)): Claude via `@agentclientprotocol/claude-agent-acp` 0.87.0, Codex via `@agentclientprotocol/codex-acp` 2.1.1, Gemini CLI `--acp`, GitHub Copilot `copilot --acp` (public preview), OpenCode `opencode acp`, Cursor `agent acp`, Qwen Code `--acp`, goose `goose acp`, and others. Antigravity CLI has no ACP mode; the feature request is still open ([issue #31](https://github.com/google-antigravity/antigravity-cli/issues/31)).

### 3.2 Comparison: lockdown, setup and policy

"Lockdown" means the model's tool list contains only Dum's tools, with nothing from user config, MCP, plugins, hooks or context files. "Removed" means the tool is gone from the model's list. "Denied" means it is still listed but calls are refused.

| Backend | Setup: install · login reuse | Lockdown verified? | Runtime tool check | Policy for driving the user's subscription | Verdict |
|---|---|---|---|---|---|
| **Claude Agent SDK** 0.3.290 (current) | Native `claude` bundled per platform, as today ([TS docs](https://code.claude.com/docs/en/agent-sdk/typescript)) · reuses the Claude Code login: same Keychain entry unless `CLAUDE_CONFIG_DIR` differs ([auth](https://code.claude.com/docs/en/authentication)) **[inference]** | **Yes, removed.** `tools: []` → "All built-ins are removed. Claude can only use your MCP tools" ([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)). `strictMcpConfig` and `settingSources: []` ([features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)). Auto memory needs its own off switch (§2 gap). | **Yes.** `system/init` lists `tools`, `mcp_servers[].source`, `plugins`, `apiKeySource` (sdk.d.ts `SDKSystemMessage`); Dum asserts it today. | Contested, see R1. Overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login" ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). Legal: end users may sign in "to the unmodified Claude Code binary" a product runs ([legal](https://code.claude.com/docs/en/legal-and-compliance)). Subscription limits still apply to third-party apps ([help center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). | **Ship (reference)** |
| claude-agent-acp 0.87.0 | npm adapter around the Agent SDK · same login; terminal auth `--cli auth login --claudeai` ([acp-agent.ts](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts)) | **Yes, but not by default.** `_meta.claudeCode.options` passes SDK Options through (`tools: []`, `settingSources: []`, `strictMcpConfig`). The defaults load user, project and local settings plus the `claude_code` tool preset (same file). | Partial: raw SDK messages via `_meta.claudeCode.emitRawSDKMessages` (same file) | Same as Claude | Not needed; the SDK direct is simpler |
| **ChatGPT via Sign in with ChatGPT** (Responses API, Dum loop) | No install · browser OAuth "Continue with ChatGPT" with loopback callback; no API key or client secret ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)). A new consent, not a reuse of `~/.codex/auth.json`. | **Yes, by construction.** The model only sees function tools Dum sends; hosted tools (MCP, code interpreter, file search) are unsupported on this route ([preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)). | Not needed: Dum builds the request | **Sanctioned** for open-source and locally hosted apps; paid or hosted apps need the interest form ([SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source)). Dum is MIT and local (`package.json`). | **Ship first** |
| Codex app-server (`@openai/codex` 0.161.0) | npm or brew, native binary ([npm](https://registry.npmjs.org/@openai/codex/latest)) · `codex login` with ChatGPT; `codex login status` exits 0 when credentials are present ([commands](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)); `account/login/start` returns an `authUrl` ([app-server](https://learn.chatgpt.com/docs/app-server.md)) | **Partial.** Shell and apply_patch can be *removed*: `features.shell_tool=false` ([config ref](https://learn.chatgpt.com/docs/config-file/config-reference.md)); the experimental `thread/start.environments: []` drops the environment tools ([spec_plan.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs), [thread.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)). Global `$CODEX_HOME/AGENTS.md` always loads ([instructions](https://github.com/openai/codex/blob/main/codex-rs/codex-home/src/instructions/mod.rs)), and app-server has no `--ignore-user-config` ([cli main.rs](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)). | No full tool list; only `instructionSources` and `mcpServerStatus/list` | "App-server authentication has never been permitted for commercial or hosted services", with a recommendation to migrate to SIWC; app-server is "experimental and [isn't] supported for production workloads" ([app-server](https://learn.chatgpt.com/docs/app-server.md)) | **No.** Superseded by SIWC + Dum loop. |
| codex-acp 2.1.1 | npm, bundles `@openai/codex` · ChatGPT login opens a browser; device code via elicitation ([CodexAuthMethod.ts](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAuthMethod.ts)) | **Partial.** Only a process-wide `CODEX_CONFIG` env var; user MCP servers are always merged; no apply_patch toggle ([README](https://github.com/agentclientprotocol/codex-acp/blob/main/README.md), [CodexAcpClient.ts](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAcpClient.ts)) | No | As Codex | **No** |
| Gemini CLI 0.63.0 (`--acp`) | npm or brew, Node 20+ ([install](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/installation.mdx)) · consumer "Login with Google" **stopped serving Google AI Pro/Ultra and free users on 2026-06-18** ([Google blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)) | **Yes in source, removed.** `tools.core: []` registers zero built-ins ([core config.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/config.ts), [cli config.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)), plus `--allowed-mcp-server-names`, `-e none` and a `GEMINI_CLI_SYSTEM_SETTINGS_PATH` override ([configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)). Context files can only be pointed at a missing name **[inference]**. | No. stream-json `init` has only `session_id` and `model` ([types.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)) | "Directly accessing the services powering Gemini CLI … using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies" ([ToS](https://geminicli.com/docs/resources/tos-privacy/)); third-party agents should use a Vertex or AI Studio API key ([FAQ](https://geminicli.com/docs/resources/faq/)) | **Unusable** for no-key setup |
| Antigravity CLI | Google's consumer replacement for Gemini CLI · no ACP ([issue #31](https://github.com/google-antigravity/antigravity-cli/issues/31)) | Not evaluated | — | "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach" ([terms §6](https://antigravity.google/terms)) | **Unusable** |
| **GitHub Copilot SDK** 1.0.17 (bundles CLI 1.0.93) | npm; "the Copilot CLI is bundled automatically" ([README](https://github.com/github/copilot-sdk/blob/main/README.md)) · reuses the stored `copilot` CLI login; `getAuthStatus()` ([nodejs README](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)) | **Yes in types/docs, removed.** `availableTools` takes `custom:*` / `mcp:<name>`: "When specified, only these tools will be available"; `enableConfigDiscovery` defaults to false ([types.ts](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)). Default is `--allow-all`-like, so Dum must set it (README). | **Not found.** Backstop is `onPreToolUse` / `onPermissionRequest` deny (nodejs README) | SDK is GA and needs a Copilot subscription; billing is like the CLI (README). Explicit terms for a *third-party* desktop app using the user's subscription: **[unverified]** | **Ship second**, after a live probe |
| Copilot CLI `--acp` | as above · `copilot login` | **Partial.** `--available-tools` is fixed at server launch; `--additional-mcp-config` *adds to* the user's MCP config ([CLI ref](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)). ACP is public preview. | No | as above | No (use the SDK) |
| OpenCode 1.18.35 | npm, MIT · ChatGPT Plus, Copilot and GitLab Duo logins; Claude Pro/Max is out ("Anthropic explicitly prohibits this", [providers](https://opencode.ai/docs/providers)) | **Partial.** Tools are removed when the last matching rule is `"*": deny` ([permission/index.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts)), but user global config, global AGENTS.md and `~/.opencode` always load ([config.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/config.ts)) | No | Per provider | No |
| Cursor CLI / `@cursor/sdk` 1.0.37 (beta) | curl installer · the SDK needs an API key created by a browser login; it doesn't reuse the app login ([SDK](https://cursor.com/docs/sdk/typescript)) | CLI **partial**: deny rules only ([permissions](https://cursor.com/docs/cli/reference/permissions)); ACP MCP comes only from `.cursor/mcp.json` ([ACP](https://cursor.com/docs/cli/acp)). SDK `tools: []` documented; context isolation **[unverified]**. | No | Proprietary | No |
| Qwen Code | npm · Qwen OAuth free tier discontinued 2026-04-15 ([auth](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md)) | **Partial.** Whole-tool `permissions.deny` removes built-ins ([settings](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md)) | No | No subscription to reuse | No |
| Goose | `goose acp` ([commands](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)) | **[unverified]**: no documented way to exclude the user's extensions | No | — | No |
| **Ollama** 0.40.1 (OpenAI-compatible, Dum loop) | macOS app, which offers to link the `ollama` CLI ([macOS](https://docs.ollama.com/macos)) · no login | **Yes, by construction.** `/v1/chat/completions` has no server-side tools; web search is a separate cloud REST API ([OpenAI compat](https://docs.ollama.com/api/openai-compatibility), [web search](https://docs.ollama.com/capabilities/web-search)) | Not needed | Local | **Ship first** |
| **LM Studio** ≥0.4.8 (Dum loop) | Desktop app or `llmster` daemon ([headless](https://lmstudio.ai/docs/developer/core/headless)) · no login | **Yes, by construction**, on `/v1/chat/completions`. Server-side MCP exists only on `/v1/responses` and `/api/v1/chat`, and is off unless enabled ([MCP](https://lmstudio.ai/docs/developer/core/mcp)). | Not needed | Local; the app is proprietary freeware for personal and internal business use ([terms](https://lmstudio.ai/app-terms)) | **Ship first** |

### 3.3 Comparison: capabilities

| Backend | Streaming | Resume | Images | Model / effort | License · maturity |
|---|---|---|---|---|---|
| Claude Agent SDK | SDK messages; `includePartialMessages` | `resume`, `persistSession` ([TS docs](https://code.claude.com/docs/en/agent-sdk/typescript)) | Base64 `image` blocks, streaming-input mode only ([streaming vs single](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)) | `model`; `effort` low/medium/high/xhigh/max (sdk.d.ts `EffortLevel`) | Proprietary, Anthropic Commercial Terms (`node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md`) · stable, 0.3.x |
| ChatGPT via SIWC | Required: `stream: true`, `response.*` events ([inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)) | None server-side: `store: false` and no `previous_response_id`; Dum resends history ([preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)) | Yes, "when the selected model accepts them" (same) | Account catalog `GET /v1/models` (same); `reasoning.effort` isn't on the unsupported list, but its values per model are **[unverified]** | API terms · **preview** |
| Codex app-server | `item/agentMessage/delta`, `turn/completed` | `thread/resume` | `image`, `localImage` | `model/list` with `supportedReasoningEfforts` | Apache-2.0 · experimental ([app-server](https://learn.chatgpt.com/docs/app-server.md)) |
| Gemini CLI `--acp` | ACP updates | `session/load` | Yes (inlineData) | `unstable_setSessionModel`; thinking via `modelConfigs` | Apache-2.0 ([npm](https://registry.npmjs.org/@google/gemini-cli/latest)) |
| Copilot SDK | Session events | `resumeSession` | Blob attachments | `model`, `reasoningEffort` low…max ([nodejs README](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)) | SDK MIT, GA. The CLI is proprietary but may be redistributed unmodified "as part of an application" ([LICENSE](https://github.com/github/copilot-cli/blob/main/LICENSE.md)). |
| Ollama | SSE; tool calls stream as chunks to accumulate ([tool calling](https://docs.ollama.com/capabilities/tool-calling)) | None (Dum keeps history) | Base64 only, no image URLs ([OpenAI compat](https://docs.ollama.com/api/openai-compatibility)) | `reasoning_effort`, model-defined (same); no `tool_choice` (same); `capabilities` via `/api/show` ([show](https://docs.ollama.com/api-reference/show-model-details)) | MIT ([LICENSE](https://github.com/ollama/ollama/blob/main/LICENSE)) · v0.40.1, 2026-10-07 |
| LM Studio | SSE with `delta.tool_calls` ([tools](https://lmstudio.ai/docs/developer/openai-compat/tools)) | None | Native `/api/v1/chat` documented; `image_url` on `/v1/chat/completions` **[unverified]** | `reasoning_effort` since 0.4.8 ([changelog](https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.8)); tool-use capability in `GET /api/v0/models` ([0.3.16](https://lmstudio.ai/blog/lmstudio-v0.3.16)) | App proprietary; lmstudio-js MIT |

---

## 4. Recommended architecture

### 4.1 Shape

```
session.ts / oneshot.ts / wizard / look / practice / course
                 │  AgentSession.turn(), DumTool[] (Dum's gated tools, in-process)
                 ▼
          src/agent/registry.ts   (the user's choice: backend + intern/helper selectors)
     ┌───────────┬──────────────┬───────────────┬────────────────┐
  claude.ts   copilot.ts     loop.ts ─────────────────────────────┐
  (Agent SDK) (Copilot SDK)    │ Dum-owned tool loop              │
  tools as    tools as         ├─ openai-responses.ts (SIWC)      │
  in-process  defineTool       └─ openai-compatible.ts (Ollama, LM Studio)
  SDK MCP     handlers
```

Dum's tools never leave the process that owns `Store` and the gate: today that is the host utility process (`src/desktop/host.ts`), plus the main process for screen-wizard helper calls. The two harness backends both accept in-process handlers:
- Claude: `createSdkMcpServer`.
- Copilot SDK: `tools` with handlers ([nodejs README](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)).

The Dum-loop backends call the handlers directly. **No backend needs an out-of-process MCP server**, so `@modelcontextprotocol/sdk` stays a dev dependency.

### 4.2 Why ACP is not the core abstraction now

1. **The hard requirement isn't in the protocol.** Every ACP agent would need its own lockdown recipe through `_meta` (Claude), an env var (`CODEX_CONFIG`), launch flags (Copilot, Gemini) or a settings override (Gemini). The abstraction doesn't cover the part that matters (§3.1).
2. **No runtime evidence.** ACP has no message that lists active tools. Claude can be checked only through the adapter's raw SDK passthrough; Gemini only through its telemetry file.
3. **The tools would have to leave the process.** ACP MCP servers are an absolute `command` path (stdio) or an HTTP URL ([session setup](https://agentclientprotocol.com/protocol/v1/session-setup)). Dum's tools close over `Store`, `Ctx` and the gate, so Dum would need a stdio shim or an authenticated loopback HTTP MCP server. MCP-over-ACP is a draft that Codex's adapter doesn't support (`mcpCapabilities.acp: false`).
4. **The subscriptions worth reusing are better reached directly.** Gemini and Antigravity forbid third-party OAuth use. ChatGPT is sanctioned through SIWC, not app-server. Copilot and Claude have first-party SDKs.

The door stays open. `session/new{mcpServers}` + `session/prompt` + `session/update` + `session/cancel` map onto `open` / `turn` / `AgentEvent` / `interrupt` below. Add an `acp` backend per agent only once that agent has a lockdown recipe verified in source and a runtime check.

### 4.3 The interface

New directory `src/agent/`. This is the contract every slice in §5 codes against.

```ts
// src/agent/types.ts
import type { z } from "zod";

export type BackendId = "claude" | "chatgpt" | "local" | "copilot";
/** "intern" is the conversation; "helper" is every bounded one-shot (course, practice, wizard, look). */
export type Role = "intern" | "helper";

/**
 * One of Dum's gated tools as every backend receives it. `call` already runs inside
 * store.operation and turns refusals and Cancelled into `isError` results (today's wrapper in
 * session.ts:run). Backends namespace `name` themselves (mcp__dum__x, a Responses namespace, …)
 * and report the bare name back.
 */
export type DumTool = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
};

export type Picture = { mimeType: "image/png"; data: string }; // base64, as today
export type UserTurn = { text: string; images?: readonly Picture[] };

export type Selector = { backend: BackendId; model: string; effort: string | null };

export type ModelOption = {
  id: string;
  label: string;
  efforts: readonly string[];  // [] = the model has no effort knob
  images: boolean;
  tools: boolean;              // a model without tool calling can't be the intern
  verified: boolean;           // proven with a real call on this backend (today's MODELS rule)
};

export type Capabilities = {
  images: boolean;             // UserTurn.images is accepted for this selector
  interrupt: boolean;          // a turn can stop while the session stays open
  runtimeToolCheck: boolean;   // the backend reports the model's active tools and open()/turn() asserts them
};

/** One sentence plus booleans. No email, org, token or CLI output, as RuntimeStatus today. */
export type BackendStatus = {
  id: BackendId;
  label: string;
  installed: boolean;          // bundled runtime starts / local server answers / nothing needed
  signedIn: boolean;           // usable now without a login step
  loginRunning: boolean;
  loginNeedsCode: boolean;
  message: string;
};

export type LoginUi = {
  /** Only an https URL on the backend's allowlisted auth hosts is ever opened (AUTH_HOSTS today). */
  openUrl(url: string): Promise<void>;
  changed(): void;             // status changed; re-read status()
};

export type AgentEvent =
  | { type: "model"; model: string; effort: string | null }   // what actually answered
  | { type: "text"; text: string }                             // one whole assistant text block
  | { type: "tool"; name: string }                             // a Dum tool started (status line only)
  | { type: "retry"; message: string }                         // provider retry/backoff, shown as progress
  | { type: "end"; error: string | null; interrupted: boolean };

export type OpenOptions = {
  cwd: string;                 // the active zone's empty runtime/ dir (revamp-design §2); never a git repo
  systemPrompt: string;
  selector: Selector;
  tools: readonly DumTool[];   // the closed set; [] for one-shot helpers
  signal: AbortSignal;         // aborting closes the process/stream at once, even mid-open
  maxTurns?: number;           // model round-trips per user turn
};

export interface AgentSession {
  /** One user turn. Yields until exactly one `end`. Throws on any route or lockdown violation. */
  turn(input: UserTurn): AsyncIterable<AgentEvent>;
  /** Ends the current turn with { type: "end", interrupted: true }; falls back to close(). */
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentBackend {
  readonly id: BackendId;
  readonly label: string;
  status(): Promise<BackendStatus>;
  login(ui: LoginUi): Promise<void>;
  /** Hand a pasted code to the running login (Claude's paste-code flow). */
  code?(code: string): void;
  cancelLogin(): void;
  models(): Promise<ModelOption[]>;
  capabilities(selector: Selector): Capabilities;
  /**
   * Resolves only after the credential route is verified (Claude: assertProvider; ChatGPT: token
   * scopes; local: loopback endpoint and a non-cloud model). Nothing from the user is sent before
   * then. Refuses a selector this backend doesn't list, never falls back.
   */
  open(o: OpenOptions): Promise<AgentSession>;
}
```

```ts
// src/agent/registry.ts
export type AgentChoice = { backend: BackendId; intern: Selector; helper: Selector };
export function backend(id: BackendId): AgentBackend;
/** The saved choice. Throws "choose who powers Dum" when none; never picks one silently. */
export function chosen(): AgentChoice;
export function selector(role: Role): Selector;
```

```ts
// src/oneshot.ts (backend-agnostic replacement)
export async function oneShot(
  prompt: string,
  o: { cwd: string; images?: readonly Picture[]; signal?: AbortSignal },  // cwd required (revamp: no process.cwd() default)
): Promise<string>;  // helper selector, tools: [], maxTurns: 1; throws if images and !capabilities.images
```

```ts
// src/agent/loop.ts (shared by the ChatGPT and local backends)
export type WireCall = { id: string; name: string; arguments: string };
export type WireMessage =
  | { role: "user"; text: string; images?: readonly Picture[] }
  | { role: "assistant"; text: string; calls: readonly WireCall[] }
  | { role: "tool"; callId: string; text: string; isError: boolean };
export type WireTool = { name: string; description: string; parameters: object }; // z.toJSONSchema(z.object(shape))
export type ModelStep = { text: string; calls: WireCall[]; error: string | null };

export interface ModelClient {
  /** One streamed request over the whole history (both routes are stateless for Dum). */
  step(req: {
    system: string; history: readonly WireMessage[]; tools: readonly WireTool[];
    model: string; effort: string | null; signal: AbortSignal;
  }): Promise<ModelStep>;
}

/** turn(): push user → step → emit text → run each call (unknown name ⇒ throw, ending the session)
 *  → push results → repeat until a step has no calls or maxTurns → end. */
export function loopSession(client: ModelClient, o: OpenOptions): AgentSession;
```

`zod` 4.4.3 already ships `z.toJSONSchema` (checked in `node_modules`). The loop is about 150 lines over `fetch` plus SSE parsing, with no new dependency. The alternative considered was the Vercel AI SDK: `ai` 7.0.133 with `@ai-sdk/openai-compatible` 3.0.66, both Apache-2.0 ([ai package.json](https://github.com/vercel/ai/blob/main/packages/ai/package.json), [providers](https://ai-sdk.dev/providers/openai-compatible-providers)). It was rejected because the SIWC route refuses many standard fields (`temperature`, `max_output_tokens`, `metadata`, …) and requires tools grouped in namespaces ([preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)). Dum needs exact control of the request body.

**Resume is not in the interface.** The desktop already runs with `persist: false` (`src/desktop/controller.ts:converse`), and continuity lives in `.dum/transcript.json` and `memory.md`. Only the terminal edition, which the revamp drops, resumes a backend session.

### 4.4 Lockdown contract (every backend, enforced by tests)

1. **Availability.** Native tools are *removed* from the model's tool list, not just denied.
2. **Isolation.** No user or project config, MCP servers, plugins, hooks, skills or context files are loaded.
3. **Call-time backstop.** Any tool call whose name isn't one of `OpenOptions.tools` ends the session with an error. This is today's `src/session.ts:run` check, moved into each backend and repeated in `session.ts` on `tool` events.
4. **Runtime evidence.** Where the backend reports active tools (`Capabilities.runtimeToolCheck`), assert it every turn (Claude `system/init`). Where it doesn't (Copilot), the backend ships only after the live probe in §5 A6. Dum-loop backends need no evidence because Dum writes the tool list.
5. **Provenance before content.** Nothing personal is sent until the route is confirmed (today's `src/runtime.ts:start` input gate).
   - Claude: `assertProvider` + `assertSubscription`, as today.
   - ChatGPT: validated ID token and granted scopes `resource.invoke chatgpt.tokens.use.direct` ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)).
   - Local: base URL host is `127.0.0.1` or `::1` only, and models routed to Ollama's cloud (`:cloud` / `-cloud` tags; "select a cloud model such as `gemma4:cloud`", [OpenAI compat](https://docs.ollama.com/api/openai-compatibility)) are refused.
6. **Environment.** Each backend builds its own child env, generalizing `subscriptionEnv`. Claude keeps today's list. Copilot additionally drops `GH_TOKEN`, `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN`, so only the stored login is used; the CLI accepts all three ([CLI ref](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)).

**Per-backend recipes:**
- **Claude:** today's `closed()` plus auto memory off (§2 gap).
- **Copilot SDK:**
  - `availableTools: ["custom:*"]` with Dum's tools as SDK `tools`.
  - `enableConfigDiscovery: false`.
  - `onPreToolUse` and `onPermissionRequest` deny any name outside Dum's set.
  - Source: [types.ts](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts).
- **ChatGPT:** Dum's request carries only a namespace of Dum's function tools, with `store: false` and `stream: true`.
- **Local:** Dum's request carries only Dum's function tools, sent to `/v1/chat/completions`, never to `/v1/responses` or LM Studio's `/api/v1/chat`.

### 4.5 How Dum's gated tools are exposed

| Backend | Mechanism | Model-visible name | Bare name back to Dum |
|---|---|---|---|
| Claude | In-process `createSdkMcpServer({name:"dum"})` (as today) | `mcp__dum__<tool>` | Strip the prefix |
| Copilot | SDK `tools` with in-process handlers; `availableTools: ["custom:*"]` | `<tool>` (custom) **[unverified: whether custom tools get a prefix]** | Strip any prefix |
| ChatGPT | Responses function tools grouped in a `dum` namespace ([preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)) | Namespace-qualified **[unverified exact wire form]** | Strip the namespace |
| Local | Chat-completions `tools: [{type:"function", function:{name, description, parameters}}]` | `<tool>` | As is |

`session.ts` builds `DumTool[]` from `toolkit(ctx)`, keeping today's `define()` zod parsing and the `store.operation` / `Cancelled` / `toolEvent("refused")` wrapper. The backend never sees `Store`.

### 4.6 Model and effort selection

- **Replace `src/runtime.ts:MODELS`.** Use a per-backend default table of `verified` selectors for each role, plus the backend's live catalog from `models()`:
  - Claude: today's `MODELS`, unchanged.
  - ChatGPT: the account's `GET /v1/models` (`visibility: "list"`, show `display_name`, send `slug`) ([inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)).
  - Copilot: the SDK model list.
  - Ollama: `/api/tags` plus `/api/show` `capabilities`.
  - LM Studio: `GET /api/v0/models` `capabilities`.
- **Defaults are verified by hand.** For new backends, a default is set only after a real tool-calling conversation and a real image look pass on that backend. Until then the picker shows the model as "untested". This keeps the current rule that a selector is "verified with real calls" (`src/runtime.ts` comment).
- **No silent fallback** (today's `verified()` behavior). A selector the backend doesn't list is refused with a readable error. A failing model is reported, never swapped.
- **Effort is a string the backend validates** against `ModelOption.efforts`:
  - Claude `low…max` (sdk.d.ts `EffortLevel`)
  - Copilot `reasoningEffort` low…max
  - ChatGPT `reasoning.effort` values per model **[unverified]**
  - Ollama and LM Studio `reasoning_effort`, model-defined
  - The UI offers only what the model advertises.
- **Role constraints.** The intern needs `tools: true`. Helper calls with pictures (`src/look.ts`, `src/wizard.ts:screenDecision`) need `images: true`. If the helper can't see images, the screen wizard and picture sharing show "the model you chose can't see pictures" instead of running. Text-only helper work is unaffected.
- **`src/store.ts:State.models`** keeps `{model, effort}` per voice and adds the backend label, so the UI can say "ChatGPT · gpt-… · high".

### 4.7 Setup UX

**Setup** replaces today's "Getting dum ready" Claude step (`src/desktop/ui/panel.ts` setup, `src/desktop/runtime-setup.ts`) with a screen called **"Who powers Dum?"**. It doesn't come first. The revamp's first run opens on the learning goal, and zones work without auth (`docs/revamp-design.md` §9). The picker appears when the first model-backed action needs a backend, and stays reachable from Settings.
- **One row per backend.** All `status()` probes run in parallel at launch. No prompt is sent, and no account field is shown, matching today's `RuntimeStatus` privacy rule.
  - **Claude:** "Signed in" or **Sign in**. This is today's bundled `claude auth login --claudeai` flow, including the paste-code box.
  - **ChatGPT:** **Continue with ChatGPT**, the label the SIWC docs require ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)). It opens the system browser with a loopback callback on `127.0.0.1`.
  - **GitHub Copilot** (second release): "Signed in" when `getAuthStatus()` finds the user's `copilot` login, else **Sign in with GitHub**.
  - **On this Mac:**
    - "Ollama · N models" or "LM Studio · N models" when `127.0.0.1:11434` / `127.0.0.1:1234` answers.
    - Otherwise "Not running", with a link to get Ollama.
    - A model without tool calling is listed but can't be chosen as the intern.
- **Ordering.** Ready rows sort first. If exactly one row is ready it is preselected, and one click on **Use** finishes setup.
- **Hints.** Optionally, the existence of `~/.codex` (never its contents) moves ChatGPT up with the hint "You use Codex - your ChatGPT plan works here too". Nothing else from other tools is read.
- **Settings → "Agent".** This replaces the "Claude" group (`panel.ts` ~623): backend, intern model and effort, helper model and effort, Check again, Sign out. Changing it ends the open conversation, the way switching zones does.
- **Where things are stored:**
  - The choice lives in desktop settings as `agent: AgentChoice`. The revamp makes the host the authoritative settings writer.
  - The ChatGPT refresh token and `ext_agent_host_id` live in a separate file encrypted with Electron `safeStorage`. `safeStorage` is main-process only ([Electron docs](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)), and `src/desktop/settings.ts` states that settings never hold tokens. So the main process runs the SIWC browser login and token refresh. That is OAuth, not a model call, so it stays inside the revamp's rule that main makes no model calls. Use the async `safeStorage` API, because the sync API is removed in Electron 46 (same doc).
  - The host asks main for a short-lived access token over the utility-process channel when it opens a session. The token never goes through env and is never logged.
- **No PATH dependence.** A Finder-launched app has no user PATH (`src/runtime.ts:claudeExecutable` comment). Every shipped backend is bundled (Claude, Copilot), HTTP-only (ChatGPT) or reached by loopback HTTP (local).

### 4.8 What ships, in order

1. **Claude** behind the interface: no behavior change, plus the auto-memory hardening.
2. **Local** (Ollama, LM Studio). This is the first Dum-loop backend and proves the interface.
3. **ChatGPT** via SIWC, reusing `loop.ts`.
4. **Copilot SDK**, after the A6 probe passes.

Gemini CLI, Antigravity, Codex app-server, codex-acp, OpenCode, Cursor, Qwen and Goose are not planned.

---

## 5. Implementation plan

Slices are named **A0–A7** so they don't collide with `docs/revamp-design.md` §8, which uses C0, S1–S4, D1–D3, U1–U3 and X1–X3.

**The revamp rewrites most of the files this work touches:**
- D1: `session.ts`, `store.ts`, `oneshot.ts`, `runtime.ts`
- D2: `practice.ts`, `course.ts`, `wizard.ts`
- D3: `controller.ts`, `host.ts`, `host-client.ts`
- U2: `main.ts`, `ipc.ts`, `runtime-setup.ts`, `test/desktop-native.test.ts`
- C0: `protocol.ts`, `host-protocol.ts`
- Revamp S1: `settings.ts`
- X1: `package.json`, `electron-builder.yml`
- X3: docs

It also deletes `src/cli.tsx` and `src/self.ts`. Those import `src/runtime.ts` too, and this plan doesn't touch them, so `runtime.ts` can only go after they do. Two ways to schedule:

- **Option A, fold in (recommended).** Freeze A0 in the revamp's Phase 0, then give each agent change to the revamp slice that already owns the file (mapping below). One rewrite per file. A4 and A5 own only new files and run in parallel from Phase 1. This option means amending the revamp's §7 instruction that `src/runtime.ts` keep its behavior "without changing model selectors". Under A1/A2 the default Claude selectors stay identical, but they move from `MODELS` into the Claude backend's table.
- **Option B, follow-on phase.** Run A1, A2 and A3 as a Phase 5 after the revamp's Phase 4 barrier, with the same file lists applied to the revamped code. Safer for the revamp's schedule, but `session.ts`, `oneshot.ts` and the setup path get rewritten twice. A0, A4 and A5 can still start any time.

| Slice | Owns (files) | Contract / work | Option A owner | Depends on | Tests to change / add |
|---|---|---|---|---|---|
| **A0 Contract** (small, first) | New `src/agent/types.ts`, `src/agent/registry.ts`, `src/agent/schema.ts` (zod → JSON Schema, name namespacing) | Exactly §4.3. The registry gets an `AgentChoice` from its caller (the host's settings) and throws when there is none. Desktop protocol additions: `BackendStatus[]` + `chosen` in `Snapshot.runtime`; `runtime-*` requests become `agent-check`, `agent-login {backend}`, `agent-login-open`, `agent-login-code`, `agent-login-cancel`, `agent-select {choice}`. | Revamp Phase 0 (C0 owns `protocol.ts` / `host-protocol.ts`) | — | New `test/agent-registry.test.ts`; C0's contract test covers the new requests |
| **A1 Claude backend** | `src/agent/claude.ts`, rewritten from `src/runtime.ts`, which is deleted | `AgentBackend` over `closed()`, `start()`, `assertSubscription` and `assertProvider`. `open()` builds the SDK MCP server from `DumTool[]`. SDK messages map to `AgentEvent`: `api_retry` → `retry`; `init` → assert + `model`; assistant text → `text`; a non-Dum `tool_use` throws; `result` → `end`. `retryStatus` and `failure` move here from `session.ts`. The executable path becomes a constructor argument, which removes the `DUM_CLAUDE_BIN` plumbing. Add `autoMemoryEnabled:false` to `FLAGS` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to env (owner sign-off). | D1 (owns `runtime.ts` and the `runtime` tests) | A0; revamp deletion of `cli.tsx` / `self.ts` | `test/runtime.test.ts` → `test/agent-claude.test.ts`, same assertions with fakes driving `open` / `turn` |
| **A1b Claude setup** | `src/agent/claude-setup.ts`: bundled-binary resolution and the `auth login` / `auth status` process, rewritten from `src/desktop/runtime-setup.ts`, which is deleted | Implements `AgentBackend.status/login/code/cancelLogin` for Claude | U2 (owns `runtime-setup.ts` and `test/desktop-native.test.ts`) | A0, A1 | `test/desktop-native.test.ts` ~455-567: import paths, `RuntimeSetup` → Claude setup |
| **A2 Conversation + helpers cutover** | `src/session.ts` (runtime part of `run()`; delete `retryStatus` / `failure`), `src/oneshot.ts`, `src/look.ts`, `src/store.ts` (`models` label) | `run()` builds `DumTool[]` from `toolkit()` and loops `session.turn()`. Keeps the unknown-tool stop, interrupt → `session.interrupt()`, and Stop → abort. `oneShot` per §4.3 (helper selector from the registry, `cwd` required). No SDK import outside `src/agent/`. The revamp already removes resume and `persist`. | D1 | A0 (codes against types; fake backend in tests) | `test/store.test.ts` ~160; D1's `session` / `runtime` suites |
| **A2b Helper callers** | `src/practice.ts`, `src/course.ts`, `src/wizard.ts`: drop `MODELS.helper` / `wizard.MODEL` / `EFFORT`, since the selector comes from `oneShot` | Mechanical | D2 | A0 | `test/practice.test.ts` (types only); `wizard` / `course` suites |
| **A2c Host + controller** | `src/desktop/controller.ts` (`setModel` from the chosen selector, error copy), `src/desktop/host.ts` / `host-client.ts` (`open` carries `AgentChoice`; per-backend child env instead of `subscriptionEnv()` + `DUM_CLAUDE_BIN`; channel that asks main for a ChatGPT access token) | §4.4 rule 6, §4.7 storage | D3 | A0, A1 | `test/desktop-controller.test.ts`: the look test uses a fake backend instead of a fake `Query`; the `withSilentClaude` tests select the Claude backend explicitly; `test/desktop-host.test.ts` for the `open` schema |
| **A3 Setup + selection, main side** | New `src/desktop/agent-setup.ts`, which aggregates every backend's `status()` / `login()` and replaces `RuntimeSetup` (no Git check: the revamp removes it), plus wiring in `src/desktop/main.ts` and `src/desktop/ipc.ts`; the `agent` field in `src/desktop/settings.ts` | Status is booleans plus a sentence, as today. Main hosts the SIWC login and token refresh (§4.7). | U2 (`main.ts`, `ipc.ts`); revamp S1 (`settings.ts`) | A0, A1b, A4 | `test/desktop-native.test.ts` Router / setup tests; `tools/desktop-smoke.mjs` (X2): the signed-out setup assertion becomes "no backend chosen" |
| **A3b Setup + Settings UI** | "Who powers Dum?" sheet and Settings → "Agent" group (§4.7) | Renderer only | U1 | A0 | Smoke screenshots (X2) |
| **A5 Dum loop + local** | New `src/agent/loop.ts`, `src/agent/openai-compatible.ts` (chat-completions SSE, tool-call delta accumulation, base64 images), `src/agent/local.ts` (Ollama and LM Studio detection and catalog; loopback only; cloud-model refusal) | §4.3 `ModelClient` / `loopSession`; §4.4 | Own slice, Phase 1 (new files only) | A0 | New `test/agent-loop.test.ts` (fake SSE server: streamed tool calls, unknown tool → stop, abort mid-stream, maxTurns), `test/agent-local.test.ts` |
| **A4 ChatGPT (SIWC)** | New `src/agent/siwc.ts`: PKCE, state, nonce, `127.0.0.1` listener, `dynamic_agent_client` registration, persisted `ext_agent_host_id`, ID-token and scope validation, refresh. New `src/agent/openai-responses.ts`: a `ModelClient` with `store:false`, `stream:true`, `instructions`, namespaced tools and `input_image`; maps `subscription_sharing_usage_limit_exceeded` to readable text per [errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). New `src/desktop/credentials.ts`: async `safeStorage`, main only. | Uses `loopSession` | Own slice, Phase 1 (new files only) | A0; A5's `loop.ts` contract (parallel against the contract) | New `test/agent-siwc.test.ts` (fake auth server: state mismatch, wrong scopes, non-loopback redirect refused), `test/agent-responses.test.ts` |
| **A6 Copilot SDK** | New `src/agent/copilot.ts`, `tools/copilot-probe.mjs` (dev-only); `package.json` dependency and `electron-builder.yml` asarUnpack for the bundled CLI | §4.4 Copilot recipe. Release gate: the probe opens a session with Dum's tools and prompts the model to read a file, run a shell command and fetch a URL. It passes only if every attempt is absent from the tool list or denied by `onPreToolUse`, and the SDK reports no built-in tool execution. | After the revamp; X1 for `package.json` / builder if still in flight | A0, A2 | New `test/agent-copilot.test.ts` (session config snapshot; the hook denies a non-Dum name) |
| **A7 Docs + policy** | `README.md`, `CONTRIBUTING.md`, `src/site/install.html` | Rewrite "Close every model route" as §4.4. Replace the "No Gemini…" line with the per-backend verdicts in §3.2. Document the data flow per backend (what leaves the Mac for each choice). | X3 | All | — |

**Parallelism:**
- After A0, A4 and A5 run alongside the revamp's Phase 1, because they own only new files.
- A1, A2, A2b and A2c ride Phase 2 inside D1, D2 and D3.
- A3's `settings.ts` field rides revamp S1 (Phase 1). A1b, A3's `main.ts` / `ipc.ts` wiring and A3b ride Phase 3 inside U2 and U1.
- A6 comes after the revamp. A7 goes with X3.
- No slice builds or runs tests mid-flight. The integration owner runs `npm run typecheck`, `npm test` and `npm run desktop:smoke` once at the end, as the revamp's §8 already requires.

---

## 6. Risks and unknowns

- **R1 Claude subscription policy (affects the current product today).**
  - The Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" ([overview](https://code.claude.com/docs/en/agent-sdk/overview)).
  - The legal page bars routing requests "through Free, Pro, or Max plan credentials on behalf of their users" and says developers "may not collect, store, or intermediate Claude.ai credentials". It also says this doesn't "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". It conditions running Claude Code in a product on the Commercial Terms and on not removing, disabling or restricting "any authentication method built into it" ([legal](https://code.claude.com/docs/en/legal-and-compliance)).
  - Dum runs the unmodified bundled binary through Anthropic's own login. However:
    - It refuses API-key auth: `src/runtime.ts:subscriptionEnv`, `assertSubscription`.
    - It relays the pasted OAuth code into the CLI's stdin: `src/desktop/runtime-setup.ts:RuntimeSetup.code`.
  - Whether either point conflicts with those clauses is **[inference, unresolved]**. Ask Anthropic via the page's contact link.
  - Usage does still draw on subscription limits for third-party apps ([help center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
- **R2 SIWC is a preview.**
  - Field restrictions, the namespace requirement and usage-limit errors can change ([preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)).
  - Dum would hold OAuth tokens for the first time, so the credential handling needs review.
  - Still open:
    - The namespaced function-tool wire format is **[unverified]**.
    - `reasoning.effort` support on this route is **[unverified]**.
    - Whether reasoning items must be carried across stateless turns (`include: ["reasoning.encrypted_content"]`) is **[unverified]**.
    - The UI/UX branding rules beyond the button label were not read ([guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)).
- **R3 Local models.**
  - Tool-calling quality varies, and Ollama has no `tool_choice` ([OpenAI compat](https://docs.ollama.com/api/openai-compatibility)).
  - Cloud-proxied Ollama models would break the "stays on this Mac" promise; §4.4 refuses them.
  - LM Studio `image_url` on chat completions is **[unverified]**.
  - LM Studio's app license is proprietary ([terms](https://lmstudio.ai/app-terms)). Dum only talks to it over HTTP and doesn't bundle it.
- **R4 Copilot.**
  - No runtime list of active tools was found, so lockdown rests on `availableTools` semantics plus hooks. That is why the A6 probe gates the release.
  - Whether `enableConfigDiscovery:false` also skips `~/.copilot` hooks, plugins and `mcp-config.json` is **[unverified]**.
  - GitHub's terms for a third-party desktop app using the user's Copilot subscription through the SDK are **[unverified]**.
  - The bundled CLI is proprietary but may be redistributed unmodified ([LICENSE](https://github.com/github/copilot-cli/blob/main/LICENSE.md)).
  - App size grows by the second native runtime **[unverified size]**.
- **R5 The prompt contract was tuned on Claude.** `src/session.ts:contract` may teach worse on other models. The gate still holds, because writes happen only through Dum's tools, but quality is per model. Each backend needs recorded real conversations before its defaults are marked `verified`. The README already treats these as qualitative.
- **R6 Claude auto memory.** The §2 gap: whether safe mode disables it is **[unverified]**. A1 sets it explicitly.
- **R7 ACP may standardize lockdown later.** v2 is a draft that removes the client fs/terminal surface and defers sandbox config to "the future" ([RFD](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities)). Revisit when ACP adds a tool allowlist or an active-tool report.
- **R8 Google routes.**
  - Gemini CLI lockdown is verified in source, but consumer login ended on 2026-06-18, and Google's ToS forbids third-party OAuth use ([ToS](https://geminicli.com/docs/resources/tos-privacy/), [blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)).
  - Antigravity forbids it outright ([terms](https://antigravity.google/terms)).
  - A Gemini API-key backend is technically easy as a Dum-loop backend, but conflicts with "no API keys pasted". It isn't planned unless the owner relaxes that.
- **R9 Codex.**
  - If SIWC stalls, Codex app-server is the fallback. Its lockdown depends on experimental `environments`/`dynamicTools`.
  - It always loads global `AGENTS.md`, so it needs its own `CODEX_HOME`. That forces a separate login, which loses the "reuse" benefit.
  - OpenAI says app-server auth "has never been permitted for commercial or hosted services" ([app-server](https://learn.chatgpt.com/docs/app-server.md)).
- **R10 Policy text in the repo.** `CONTRIBUTING.md` currently forbids every non-Claude route. Changing it is an owner decision that A7 carries out; it isn't an implementation detail. The revamp's own D1 brief says to keep "closed subscription behavior" and "no … fallback models" in `runtime.ts` (`docs/revamp-design.md` §3, §7). Adding backends doesn't contradict that: each backend stays closed, and choosing one is explicit, never a fallback. The integration owner should still confirm it.
- **R11 Where helper calls run.** Today screen-wizard helper calls run in the main process (`src/desktop/main.ts` sets `DUM_CLAUDE_BIN` for `src/wizard.ts:screenDecision`). The revamp moves every model call into the utility host (`docs/revamp-design.md` §6 responsibilities, U3). That simplifies this design, because only the host resolves `AgentChoice` and sessions. Main's only agent work is the SIWC login, refresh and `safeStorage` (A3, A4). If the revamp's U3 move slips, main would need the same `AgentChoice` and a token path.

---
name: add-mcp-tool
description: Add a new `dum_*` MCP tool to Dum's stdio server so agents (Claude on the laptop, omp, Codex, Dum's Discord team) can call it. Use when Dum needs a new ability that reads or writes workshop state through the existing API.
metadata:
  version: "1.0.0"
---

# Add a `dum_*` MCP tool

## When to use

An agent needs to do one more thing with Dum: read something, record something, queue something. The tool talks to the workshop through `Workshop` (src/client/workshop.ts); it never touches the store or disk directly. If the ability needs a new workshop route, add that first (step 4).

Not for: recording Ryan's words. Teaching and attempts go through `ask()` in src/mcp/server.ts:307 and wait for approval. Don't add a second path.

## Files to touch

1. `src/mcp/server.ts`, `TOOLS` array (L67-214). Add one `ToolDef` (shape at L62). Follow `dum_mark_studied` at L132:
   - `name`: `dum_<verb>_<thing>`, snake_case. `title`: short, imperative. `description`: one or two sentences saying what it does and when an agent should call it; this is all the model sees.
   - `inputSchema`: `{ type: "object", properties: {...}, required: [...] }`. For a goal argument use `goalArg` (L59). For an optional wait use `waitArg(what, defaultSeconds)` (L60). Put `maxLength` on free text.
   - `annotations`: `read` (L64) if it only reads, `write` (L65) if it records, or the inline destructive object at L114 if it deletes.
   - Keep the array grouped: goal tools, then creations, shares, handoffs, codes.

2. `src/mcp/server.ts`, handler map `tools` (L322-623). Add `async dum_<name>(args) { ... }` returning a string. Follow `dum_mark_studied` at L458-462:
   - Read args with `str(args, "field")` (L218); `str(args, "field", false)` for optional. It trims and throws `ToolError` when missing.
   - Resolve a goal with `goalOf(ref)` (L249): accepts id or exact title, throws a `ToolError` listing goals when not found. Creations: `jobOf(ref)` (L274).
   - Call `deps.workshop.<method>(...)`. Never import the store.
   - Throw `ToolError` for anything the caller got wrong. `call()` (L625-640) turns `ToolError`, `HandoffError` and `WorkshopRequestError` into `isError: true` with the message; any other throw becomes a generic "Something went wrong on hub" and is logged to stderr. Don't catch and rewrap.
   - Return one plain-text answer: what was recorded or found, and the workshop link (`goalLink`/`link`, L246-247) when there is a page for it. Say "Ryan" and the goal title, like the others.

3. `src/discord/agents.ts`. Tools from `TOOLS` are auto-mapped to `mcp__dum__<name>` (L13-14). `dum` gets all of them via `ALL_DUM` (L48). Decide who else may call it:
   - Read-only and useful to tutor/engineer: add the name to `READ_DUM` (L15).
   - Librarian: add `mcp("dum_x")` to its `tools` at L112 only if importing material needs it.
   - Never give `dum_teach`/`dum_report_attempt`-style recording to a specialist; discord.test.ts:507-510 enforces that.
   discord.test.ts:512-517 checks every `mcp__dum__*` an agent names exists in `TOOLS` and that `dum` can reach all of them. A typo there fails the suite.

4. Only if the workshop lacks the call: `src/client/workshop.ts` `Workshop` type (L41-66) and the client at L106-133; follow `studied` at L50 and L115 (`ws(goalPath(goalId, "/studied"), { method: "POST", body: { concept } })`). Server route in `src/workshop/server.ts`: body limit constant next to `STUDIED_BODY` (L101), route branch next to L867-870 (`readJsonBody` + `field()` + `sendJson(res, 201, {...})`). The route calls a `WorkshopStore` method; add that too.

5. Docs. README.md "Use it" (L51-57) lists tools only when they are a user-facing feature (L55-56 for `code_request`/`code_result`); add one bullet only in that case. docs/demo.md:40 names `dum_overview`/`dum_goal` as examples; leave it. Nothing else enumerates tool names: the server's `tools/list` (server.ts:666) and the Discord allow-lists are generated from `TOOLS`.

## Test to add

File: `src/mcp/mcp.test.ts`. Use `setup(over?)` (L21-81): a fake `Workshop` whose write methods push into `calls` (L33-45), temp dirs for requests/handoffs/posts/codes, a stepped clock. Override one method through `over` when you need specific data (`setup({ progress: async () => [...] })`). Call the tool with `text(name, args)` (L76-79); it returns `{ text, error }` from `mcp.call()`.

If step 4 added a `Workshop` method, add it to the fake at L27-60 with a `calls.push(...)` or the test won't compile.

Assert through the public result, as `dum_build` at L131-144 does:
- Success: `text` matches the answer the agent reads, and `calls` deep-equals the workshop calls you expect, with the resolved goal id (not the title).
- A bad argument: `error === true` and `text` tells the caller what to fix (missing field, unknown goal).
- Nothing recorded on the error path: `calls` unchanged.

Assert behaviour (handler output, the workshop call made, state in the temp dirs, the error), never the source text, the `TOOLS` entry's wording, or wiring (CONTRIBUTING.md L34). The handshake test at L83-101 already covers `tools/list` for every entry.

For a new workshop route, add an HTTP test next to `context-limits.test.ts:62-85` (real server on a free port, `api(method, path, body)`), asserting status and body.

## Checks

- `npm run typecheck`
- `npm test`
- Manual, per CONTRIBUTING.md L32: exercise the affected path in the actual program. `dum mcp install` then call the tool from omp or Codex on hub, or over `ssh hub dum mcp` from the laptop, against a real goal, and read the reply. A workshop route change also needs `dum-workshop.service` restarted (scheduled via `systemd-run --user --on-active=20`, never directly; see agents.ts L99).

## Don't

- Don't record anything as Ryan's words. Teaching and attempts only exist as approval requests via `ask()`; a tool that calls `workshop.teach`/`tried` directly breaks the invariant at server.ts:5-7 and CONTRIBUTING.md L23.
- Don't read or write the workshop store, state files, or `~/handoff` from a handler. Go through `deps.workshop` or the `shared/*` helpers already imported at server.ts:11-17.
- Don't give the shell-bearing engineer, tutor or librarian a write tool they don't need. Allow-lists are the only thing scoping them (agents.ts L1-7).
- Don't throw raw `Error` for user mistakes; it reaches the agent as "Something went wrong on hub" and hides the fix.
- Don't put secrets, tokens or file contents outside `~/internship`/`~/dum-shared` into a tool answer; `dum_share_file` already guards paths, reuse it.
- Don't assert on source strings, descriptions or the `TOOLS` entry in tests.

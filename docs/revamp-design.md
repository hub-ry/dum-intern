# Dum revamp: zones, menu bar, command bar, voice

> **Superseded, 2026-10-08.** This is the history of the earlier revamp. Its menu bar (tray), command bar, panel, subscription sign-in and Wizard asides are gone. Dum is now one floating circle and one working window built around delegation; see [circle-design.md](circle-design.md) for the current contract and [architecture.md](architecture.md) for the rules. The text below is left as it was.

Status: implementation design, not an implemented or verified feature. Ryan's eight decisions in the revamp request take precedence over the corner-pair and terminal instructions in `docs/overhaul-goal.md:Current intent` and `CONTRIBUTING.md:Product rules`. Paths and signatures below are target contracts unless explicitly marked **Current**. This design changes no product code.

## 1. Summary: the product in one screen

```text
Dum menu bar → Programming › Data Structures

What are you trying to learn?                   [first run; local, before login]

Programming › Data Structures                  [active context, not a folder]
Goal: implement and compare balanced trees

Dum     Explain the invariant you're unsure about, or share your implementation.
Wizard  One selective, sourced connection; never a second conversation.

[message / voice draft]                         [share files] [Send]
[Zones] [Global skills] [History] [Settings]
```

- Adopt the coordinator's three entry points: native Tray menu as home; global-hotkey command bar for keyboard work; transient cursor-anchored bubble for voice feedback. The full panel owns zone editing, history, tree, practice, courses, and settings. All surfaces use one active conversation and one draft, not separate agents.
- One global competency tree. Zones overlay a learning goal, context, language preference, and focus skills. Proven ability transfers between zones, not between languages. Zone membership never unlocks anything.
- In the active learning zone, Dum helps explain gaps, choose practice, and review unaided work. It does not force a course or quiz. Explicitly delegated work on proven skills can be automated after a plan approval. Locked concepts remain the user's implementation.
- No repository selection, Git discovery, saved-working-tree observation, corner companion, integrated editor, source writes, or shell tool. Sharing a folder does not make it a project or a lasting workspace.
- Keep two written personae, Dum and the Wizard. No synthesized speech in this revamp. Voice means local speech-to-text input. Keep existing portraits inside the panel/transcript; the bubble uses small labeled text, not a floating pair.
- Mac distribution only. Keep macOS 13+ keyboard support, including Intel; bundled voice remains macOS 14+ / Apple Silicon. Linux Electron remains a developer smoke target, not a supported edition.

**Current grounding.** `skills.home/read`, `notes.toNote/fromNote`, and `curriculum.current` already supply global Markdown competency and prerequisite checks. `gate.needFor/classify/mayChange` enforce recognize for tools, build for concepts, current prerequisites, target language, and all pieces assigned to a shared file. `session.toolkit` performs the plan check; `Workspace.propose` itself is not the skill gate. `DesktopController.choose` requires `readRepo` and rejects non-Git folders. `Store.State` currently contains `repo/root/files`. `main.start` creates companion and panel windows. Those scopes and surfaces must change, not merely their labels.

## 2. Zone model and persistence

### Layout

`H = skills.home()`: `~/.dum` normally; `DUM_HOME` redirects **all revamp application state**, not just skill notes. Electron's profile/cache and Claude credentials remain external, OS/runtime-owned stores. Do not move credentials. Retain the existing app identity `com.dumintern.companion` and Electron userData location to avoid an incidental profile/TCC cutover (`electron-builder.yml:appId`, `main.start`).

```text
H/
  skills/*.md                 existing global notes; format unchanged
  prereqs.json                existing skill-id → prerequisite-name[] map
  removed.json                existing skill-id → ISO removal timestamp map
  web.json                    existing optional {server,id} tree-sync configuration
  context.md | context.json   optional personal background
  zones.json                  zone graph, active ID, graph revision
  settings.json               desktop preferences, version 2
  evidence.json               global private proof ledger and persistent holds, version 2
  session.lock                one utility-host writer for this H
  session.lock.guard          exclusive lock transition guard
  zones/<zone-id>/
    context.md                editable zone context, at most 16 KiB
    memory.md                 editable conversation guidance, at most 16 KiB
    transcript.json           Entry[]; latest 500 entries, at most 4 MiB
    practice.json             existing Task collection, version 1, at most 512 KiB
    active-course.json        active optional Course state, at most 256 KiB
    courses/<name>.<ext>       exclusively created, user-editable course scratch files
    proposals/<proposal-id>/
      proposal.json           immutable manifest, version 1
      change.patch            immutable unified diff
      files/<relative-path>   proposed complete content; never an external source file
    runtime/                  empty SDK cwd; no project settings or shared files
```

No `.dum` subdirectory inside a zone; no `repoRoot`, project association, `claude-session`, legacy todos, source mirror, or saved file grants. Deleted zones retain their directories but are inaccessible through normal APIs. No automatic retention purge of proposals/courses. The UI displays their paths and sizes for manual inspection/removal.

Private app records: directories `0700`, files `0600`, UTF-8, JSON with trailing newline. Use the bounded, regular-file/no-follow, ancestor-checking, atomic replacement and exclusive installation patterns in `workspace.stateDir/statePath/readState/writeState/createState`; extract them into `src/state-files.ts`, then delete the old module. Reject a symlinked H, zone directory, or private record. Do not reuse user-share permission to read private state. Concurrent human edits to Markdown must not be rebuilt over: retain `memory.remember`'s append-in-place semantics. Oversized/corrupt files stay intact with a visible error; invalid small transcripts can be moved aside as `memory.load` already does. Do not silently reset a malformed zone graph.

### Schemas

Shared JSON schemas live in `src/zone-types.ts`; storage implementations in `src/zones.ts`. IDs are lowercase `crypto.randomUUID()` values, independent of titles. ISO dates are UTC strings. All objects reject unknown fields.

```ts
type ZoneId = string;
type SkillRef = { name: string; lang: string }; // canonical skill name; lang="" is language-free
type Zone = {
  id: ZoneId;
  parentId: ZoneId | null;
  name: string;                // trimmed, 1..80 chars; no control characters
  goal: string;                // trimmed, 1..2000 chars; user-written
  language: string | null;     // canonical skills.langName, or inherit
  focusSkills: SkillRef[];     // at most 32, deduplicated by skills.id
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
type ZoneRegistry = {
  version: 1;
  revision: number;            // nonnegative; increment every committed graph mutation
  activeZoneId: ZoneId | null;
  zones: Zone[];               // includes tombstones; at most 1000 records
};
type ZoneContext = {
  id: ZoneId;
  revision: number;            // registry revision; used to invalidate context-bound work
  breadcrumb: { id: ZoneId; name: string }[];
  goal: string;                // leaf goal
  ancestorGoals: { id: ZoneId; goal: string }[];
  language: string;            // nearest non-null language, else ""
  focusSkills: SkillRef[];     // root→leaf stable union
  notes: { id: ZoneId; name: string; text: string }[]; // root→leaf, including leaf
};
type DesktopPreferences = {
  hotkey: string;              // default CommandOrControl+Shift+D
  voiceHotkey: string;         // default Control+Option+Space; OSW native registrar
  sendDraftHotkey: string;     // default CommandOrControl+Shift+Return
  launchAtLogin: boolean;
  personalContext: boolean;
  wizardAdvice: boolean;       // screen observation; false on fresh revamp install
  mode: "understand" | "anti-vibe"; // global; identical gates
};
// H/settings.json = {version:2, settings:DesktopPreferences}
```

Registry validation rejects duplicate IDs, absent/live-child-to-deleted parents, cycles, depth above 16, and an active ID that is missing/deleted. Names may repeat in different branches; reject case-folded duplicate live siblings. An existing name must not become a filesystem component. Revision and IDs are app-issued, never renderer-issued creation metadata. Context reads have a 64 KiB aggregate budget: read each ancestor note with its own limit, then retain nearest-zone complete sections first until the aggregate fits; return those sections in root→leaf order and display which ancestor sections were omitted. Do not silently truncate JSON or reinterpret notes as instructions.

Global evidence schema: `{version:2, held:string[], records:Proof2[]}`. `held` contains unique `skills.id` values, at most 1000. `Proof2 = Proof & {id:string, zoneId:ZoneId, zoneName:string}` using the fields in `src/evidence.ts:Proof`: `at/kind/skill/lang/ok/why`, optional `quote/files/unaided/feedback`. Extend each file record with optional private `sourcePath` for inspection; `path` is the request resource name and `sha` is the full reviewed-byte digest. Keep newest 200 records **and** at most 512 KiB; trimming records never trims holds. Zone names are snapshots for deleted/renamed origins. Notes remain the competency source of truth, not a claim of tamper-proof authorship. Private proof quotes/absolute paths/zone metadata never enter tree sync.

Practice keeps `{version:1,next:number,tasks:Task[]}` and the full `Task/Submission/ProjectPlan/LearningTarget` contracts in `src/practice.ts`; keep 40 tasks, five submissions each, four files / 96 KiB per review. Resource names and origin paths in submissions are history, not reopen permissions. Active courses keep `{course:Course|null,lang,wizard}` with `Course` from `src/course.ts`; change `course.path` to `courses/<name>.<ext>`, resolvable only in its owning zone. Proposed changes use:

```ts
type ProposalManifest = {
  version: 1; id: string; zoneId: ZoneId; requestId: string; createdAt: string;
  target: string;              // <share-id>/<relative-path>, or new/<relative-path>
  sourcePath?: string;         // private display only; no opening authority
  baseSha: string | null;      // null for new content
  nextSha: string;
  skills: SkillRef[];
};
```

`change.patch` and `files/` contain one target per proposal, at most 64 KiB generated content. Retain `Store.Entry` history kinds, including old `fill/result/created` entries as readable historical data; new source outputs are `diff` with `outcome:"proposed"` only. Generated course examples are allowed teaching material, not unaided build credit.

### Lifecycle and first run

- First launch without a live active zone shows exactly the learning-goal question, not a Git chooser, tree exam, or login demand. Text and voice fill the same local draft. Enter/Send submits the goal locally; no model call is needed. Preserve the exact trimmed answer as `goal`; collapse whitespace and take its first 80 characters for the editable default `name`. Do not infer a category, language, focus skills, or competency from it.
- First-run transaction creates an empty zone directory/context file, commits a root Zone with `language:null`, `focusSkills:[]`, timestamps and no deletion marker, increments registry revision, and selects its ID. A directory created before a failed registry write is not an active zone; remove only that newly created empty directory or report the orphan. After persistence, show the active goal and offer nesting/refinement; only now show model sign-in if needed. Empty/cancelled goal writes no zone. Preexisting skills stay untouched.
- Create: user supplies `name`, `goal`, optional `parentId`, language/focus. Native-free operation in the host; default does not switch. A separate “Create and enter” action calls create then enter. No automatic parent creation.
- Enter/switch: validate destination before withdrawing the current session. Serialize transitions; abort model/helpers/observation/recording, withdraw all pending decisions, revoke old request shares/captures, flush/detach history, then open destination with a fresh `zoneEpoch` and prompt token. Do not publish destination as active until its bounded state loads. On failure, retain the previous active ID and reopen it with fresh tokens; never resurrect its pending approvals. Old host work that will not terminate is killed before another writer starts.
- Rename: change metadata only, stable ID and directory. Goal/language/focus/context edits increment revision too. Any context mutation affecting the active ancestor chain follows the same cancellation/reopen boundary as switching; no half-old model prompt. Edits elsewhere need not abort the active conversation.
- Delete: confirm the named subtree and descendant count. Atomically tombstone its live descendants in `zones.json`; never remove global notes, holds, or proof. If active is deleted, withdraw its work and select the nearest surviving ancestor; if none survives, set active null and show the goal question. Deleting an unrelated subtree leaves the active ID unchanged. Files remain for inspection. A deleted ID cannot be entered, used as a share target, or opened through `open-record`. No reparent/move UI in this revamp.
- On restart, restore only selected-zone history/course/practice/memory, not its old decisions, model session, grants, capture tokens, or voice draft. Existing transcript plan approvals are history (`memory.prompt` and `DesktopController.start` already distinguish this).

### Inheritance and prompt plumbing

Leaf goal is the task's learning intent; ancestor goals are background, not replacements. Context notes are labeled root→leaf sections. Focus skills union by identity, with prerequisites computed from the global curriculum. Language inherits nearest non-null value; an explicit request overrides it for suggestions, while implementation/evidence always use the actual target file language. No inherited transcript, practice tasks, approvals, file permissions, personal-context opt-in, or parent memory. Personal background remains separate and global, opt-in only.

`zones.resolveZone(id)` supplies one immutable `ZoneContext` snapshot per top-level request:

1. **Conversation:** `session.systemPrompt(zone, mode)` combines the desktop learning contract and a JSON-encoded `zonePrompt(zone)` background section. `session.prepare/run` consume that same snapshot; opening user data adds active-zone `memory.prompt`, global current skills/prerequisites, explicitly shared files and the request. Rebuild the SDK session on active-context mutation. No `describeRepo`, root manifest reads, or `mainLang` fallback.
2. **Practice/projects/courses:** `Practice` and `course.designPrompt/take` take the same `ZoneContext` and already-resolved opted-in `context.Context`. Suggestions use leaf goal, ancestor context, focus skills, active memory, current global ability, and requested/inherited language. Retain multi-target estimates, prerequisite ordering and independent coverage audit (`Practice.projects/checkedProject/orderTargets`). Accepting a recommendation writes a task, not a skill. Do not let `course.designPrompt` call `context.read()` independently: it currently bypasses the desktop's supplied opt-out context.
3. **Wizard:** extend `wizard.Decision` with `zone:ZoneContext`; `wizard.prompt` includes `zonePrompt`. Conversation decisions and screen observations use the same snapshot. Keep `anchors.candidates` and `wizard.compose/screen/render` sourcing filters. Goal/focus influence relevance only, never establish an external factual claim or permission.

## 3. Removing repositories and preserving the gate

| Current concept / evidence | Revamp disposition |
| --- | --- |
| `repo.readRepo/describe`, `Workspace.list/changes/savedChanges`, `session.mainLang` | Delete. No Git probing, root discovery, diff/status/log, README/manifest context, or inferred working language. |
| `memory.load/save/attach/notes/remember/prompt/fresh` under `<root>/.dum` | Zone-local files above; preserve bounded history and editable append-only notes. Fresh conversation archives that zone's transcript/memory/practice/active-course state; leaves course scratch/proposals/global proof and skills intact. |
| `Evidence` per-root ledger; global `skills.read/write` | One global ledger/service with origin zone IDs; notes still global. Holds apply across zone switches and restarts until an unaided rebuild or explicit manual build self-report clears them. |
| `session-lock.acquire(root,"desktop")` | Acquire H once per utility-host lifetime; serialize all registry, proof, sync and zone writes. Preserve guarded takeover only for a dead local PID. A zone switch does not release this lock. Electron `requestSingleInstanceLock` is additional UI arbitration, not the data lock. |
| `prefs.chooseMode(root,flag)` | Mode in global desktop settings. Remove per-zone/per-repo preferences and one-time terminal migration explanations; modes keep identical skill gates. |
| `todos.load/save`, `session.settleLegacy` | Delete legacy handoff model. No new todos store: planned learning work is `practice.json` or memory. Move only `todos.hole` course-marker parsing into `course.ts`. |
| `course.active/take/newScratch` | Optional zone-owned scratch course; no shared-folder writes. Completion records recognition at most, and separately reports whether evidence was recorded. |
| `Practice` project/practice state and submissions | Zone-local task history, globally earned skills. Re-share evidence files for every review; keep per-target partial credit and prerequisite rechecks after awaited reviews. |
| `Workspace.propose/create` | Immutable zone proposals for both existing and new files. Remove actual external new-file creation; replace `create_file` with `propose_file`. No apply API. |
| Ordinary root-relative file reads, `shareExternal` | Explicit request-scoped saved-file or bounded-folder shares; details below. |
| `boundary.deps` and manifest-derived permission display | Delete dependency scanning. Rewrite `boundary` as current global skill permissions plus current request's share list. A focus skill is not an unlocked tool. |
| `SavedChangeAdvice` Git snapshots | Delete. A shared folder does not authorize passive observation. Requested review and Wizard decisions can use shared request bytes. Retain optional screen advice separately. |
| `.dum/session`, `.dum/claude-session`, `.dum/developer-claude-session` | Never resume or import. Current desktop already calls `session.run` with `persist:false` (`DesktopController.converse`). Continue using local history and no disk SDK resume. |
| Optional global `web.ts/sync.ts` tree link | Retain through explicit Settings link/sync/rotate/off controls; remove CLI wording/callers. Server/site implementation remains out of scope. Sync remains tree-only; holds and private zone data are not synchronized. |

### Explicit sharing, not a replacement repository

Main offers a native file/folder picker and a keyboard “Share path…” action. A typed path is resolved, shown in a native confirmation, and authorized only by the user. Selection grants reading, not writes or competency. No grant from a model-generated pathname, old transcript, recent folder, environment cwd, or zone note. The folder picker is an attachment operation; it must never set app scope.

The host issues a random `ShareId`, bound to `{zoneId,zoneEpoch,inputToken,requestId}`. Pending selections expire after five minutes; activated grants expire when that top-level request completes, errors, is interrupted, or its zone/context closes. Questions, plans and explicit attestations inside that request share its lifetime. A selection for a withdrawn prompt cannot be rebound silently. Persisted excerpts may remain in history/model memory after expiry; disclose that expiry stops future filesystem reads, not deletion of already shared text.

Model paths are virtual `<share-id>/<relative-path>` names. A single-file share exposes only `<share-id>/<basename>`; a folder share exposes only its bounded enumerated allowlist. Reject `/`, home, ancestors of home, system/credential/profile paths, private H/Electron/Claude data, hidden paths, `.git`, `.dum`, dependency/build caches (`node_modules`, `dist`, `build`, `target`, `.venv`), and credential-like names using the existing Workspace deny policy. Keep that policy explicit; do not depend on Git ignore configuration. Do not run Git or execute `.gitignore` filters. Refuse symlink components in shared paths; do not follow a folder symlink to expand authority. Limit enumeration to 2000 regular files, depth 16, 256 KiB filename metadata, eight selected roots per request; reject an over-limit selection rather than silently omitting an unknown remainder. List does not inline content.

Reads revalidate containment and regular/no-follow paths, snapshot complete bytes (at most 256 KiB, valid UTF-8 text, no NUL), compute full SHA-256, and expose at most 120 numbered lines per `read_file`. Review uses complete trusted snapshots, not excerpts masquerading as complete source; at most four files / 96 KiB total. Grants authorize only enumerated files, not later-created siblings or filesystem watching. A regular external-editor replacement at the same canonical location is allowed but requires fresh bytes/hash. If resolved location/containment changed since consent, revoke it and require re-sharing. Recheck file identity during each snapshot read, not across legitimate editor saves.

Plan paths use the same virtual resources; `new/<relative-path>` names a new proposal with no external destination. `gate.normalPath/mayChange` retain exact-resource, actual-language, shared-file blocker and live prerequisite rules. A permitted skill does not grant access to arbitrary files. `propose_change` checks an approved plan and grant, reads current full source, applies unique exact replacements (`session.applyEdits`), then compares baseline SHA before artifact creation. Changed source means refusal and re-read. `propose_file` checks the same gates, saves a `/dev/null` addition patch and content under the zone only. No model tools expose external writing, application, exporting, or commands. Opening a known proposal in the user's editor is permitted; applying/exporting it is the user's action.

Closed model tool list: `ask`, `propose_plan`, `read_file`, `list_files`, `propose_change`, `propose_file`, `check_answer`, `review_submission`, `suggest_practice`, `remember`, `wizard_aside`. Remove `changes`, `run_command`, `create_file`; retain no compatibility aliases. Text commands that remain are tree/history/context/memory/evidence/boundary/help, inspect of a current resource, practice/submit/remember, course, and not-yet. Main handles share-path confirmation before handing authorized resources to the host. Removed commands return a clear unsupported-command error, never get forwarded as a shell or approval.

### Proof, cancellation, and persistence

- Retain `Evidence.explain`'s current-turn quote checks; explanation is recognition, apply requires current build. Retain curated concept classification, language boundaries, prerequisites and direct unaided attestation. A story, screen image, inherited note, course, task choice, or reviewed-but-aided file is not build proof.
- `Evidence.submit` accepts trusted complete snapshots produced by the share broker; recompute/check digest against those full bytes at the producer boundary. No renderer/model supplied digest or excerpt is trusted as a submission. Reviews remain model judgments, not executed tests or physical authorship proof.
- Hold state belongs to the global Evidence service, not a fresh per-zone instance. Record a hold before downgrading/removing a note; never lift it merely by switching zones, recognition, remote sync, or restart. Recheck global skills/holds at proposal time and after every awaited review. Manual tree additions must explicitly say “I can write this unaided,” meet prerequisites, and be labeled self-report rather than reviewed proof.
- New grants persist the proof record before mutating notes; errors stop credit and surface a refusal. Make `skills.write` propagate IO failure instead of swallowing it. A successful review can be logged even if note persistence fails; do not report skill credit until the note is durable. Clear a hold only after a durable allowed rebuild/manual claim and ledger update. No claim of atomic multi-file transactions: an interrupted write can leave retained review with no credit, not credit without a retained review. Human note edits remain user authority.
- Stop/close/switch withdraw decisions without answering them, abort helpers, revoke capabilities, and reject late results. Keep the `Store.Cancelled`/prompt-token behavior; remove typed-ahead approval inference. UI and host transitions are serialized. If shutdown exceeds the existing wind-down bound, terminate the old utility child before starting a replacement.
- Use each zone's empty `runtime/` as SDK cwd for conversation, practice, course, screen and image helpers. `oneshot.oneShot` must no longer default to ambient `process.cwd()`. Preserve `runtime.closed/start/assertSubscription/assertProvider`: bundled Claude, subscription-only environment, no built-in tools, settings, hooks, foreign MCP servers, plugins, API keys or fallback models. No SDK session pointer/resume path remains in the app.

### Migration decision

**Do not migrate any repository `.dum/` data automatically or add a repository importer.** A Git folder does not identify a learning zone or parent/goal; old paths and model sessions also carry obsolete access assumptions. Home-directory/repository scanning would recreate the removed scope. Leave every existing `.dum/` file untouched, including locks, ledger, proposals, course scratch, transcripts, todos and session backups. Existing global skill notes/prerequisite maps/removal tombstones stay in place, so historically earned capability is not reset. Explain that old private histories remain at their original paths and are not in zone history. Users may deliberately copy guidance into zone notes or share old course code for a new review; that is not automatic evidence replay.

One narrow app-settings migration is allowed. If H/settings.json is absent, main reads only the known Electron userData/settings.json version-1 file (`DesktopSettings.load`, `Stored`) and passes validated legacy preferences to host initialization. Under its writer lock, the host imports hotkey/launchAtLogin/personalContext and explicitly stored screen-Wizard preference, writes version 2 under H, and leaves the source intact. Discard recent roots, companion position, always-on-top/all-workspaces settings, and repo modes; global mode starts understand. Old `wizardSource:"files"` becomes advice off with a notice, not silently screen-enabled. Fresh revamp advice is off until the user explicitly enables screen observation; old explicit screen/off choices survive. Repeated launches never overwrite H settings from the old profile.

Personal context now defaults/configures under H; pass its resolved value consistently to all helpers. Existing `context.read` intentionally used real `~/.dum`, not `DUM_HOME`; retain `DUM_CONTEXT=off` and explicit path overrides, named-file limits and opt-in. Do not silently load real personal context in an isolated test profile.

## 4. Electron/macOS surfaces and voice

### Menu bar and full panel

Use the existing Tray icon generation, rendered as a template icon where appropriate; retain app/portrait art. `Tray.setContextMenu(Menu.buildFromTemplate(...))` supplies: disabled current breadcrumb; Ask Dum…; Open panel (Zones/History/Skills/Settings); Switch zone submenu; Start/Stop voice; Send draft when eligible; Pause/Resume Wizard; Quit. Tray menus are mouse entry, not the only route to any function. Command bar actions expose the same navigation and native picker.

Full panel is the existing activating BrowserWindow rewritten, normally hidden. Close hides, not quits; no companion anchor. First run opens it at the learning-goal step. It is not permanently always-on-top or on every Space. All panes and dialogs have labeled Tab order, visible focus, keyboard submit/cancel, and no hover-only actions. Focus tree: arrows traverse nested zones, Right/Left expand/collapse, Enter enters, explicit buttons create/rename/delete. Global skills are a separate view, never duplicated as zone-local competency trees.

### Command bar

New `view=command`, frameless macOS `type:"panel"`, focusable, non-resizable, approximately 640×360 DIP; clamp smaller displays. Summon on `Cmd+Shift+D` centers in the display nearest the current cursor. Snapshot external frontmost app before activation; if the panel was Dum's focused surface, remember that internal surface instead. Show/focus input immediately. Present breadcrumb, draft, recent reply, and current approval/attestation/course controls; long tree/history/settings actions open the full panel by keyboard.

Enter sends, Shift+Enter inserts a newline; ignore IME-composition Return. Tab reaches every action. Escape closes an inner chooser/dialog first; otherwise dismisses the command window, preserves the zone's draft, hides no unrelated panel, and restores previous application focus. Escape does **not** mean Stop, decline, or attestation. `Cmd+.` is explicit Stop. Repeating summon while command is focused dismisses it; otherwise summon activates it. Do not register unmodified Escape globally outside an active recording/dismissal interaction.

Add a small bundled universal native focus executable (`native/macos/FocusBridge.swift`) using `NSWorkspace.frontmostApplication` / `NSRunningApplication` and app activation. Main retains an opaque capture handle, not a persisted process/caret record. This handles keyboard-only Intel users without requiring the arm64 OSW helper. Basic app focus restoration must not demand Accessibility or read an editor's text/caret. No AppleScript/System Events fallback. Restoring the exact external window/caret and behavior over full-screen apps need real-Mac proof; app restoration is the contract, not an unobserved guarantee about caret position.

### Cursor reply bubble

New `view=bubble`: `BrowserWindow({show:false,frame:false,transparent:true,resizable:false,focusable:false,skipTaskbar:true,fullscreenable:false,type:"panel"})`. Set `backgroundColor:"#00000000"`, `setIgnoreMouseEvents(true)`, `setAlwaysOnTop(true,"screen-saver")`, `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true})` for the LSUIElement Mac app, and `showInactive()`. No buttons, hit regions, dragging, text input, or renderer mutation API. `screen-saver` level is transient only; hide for sleep/lock and never attempt to overlay secure OS UI. These are implementation choices supported by [Electron BaseWindow APIs](https://www.electronjs.org/docs/latest/api/base-window#winsetvisibleonallworkspacesvisible-options-macos-linux), not proof of macOS Spaces/full-screen behavior.

At voice start, sample `screen.getCursorScreenPoint()` once; choose `screen.getDisplayNearestPoint(point)`, use its workArea and DIP coordinates. Prefer x+16/y+20; flip left/up if the bubble would overflow, then clamp with 8 DIP margin. Maximum 360×220 DIP; shrink to fit. Do not multiply coordinates by display scaleFactor or assume origin (0,0). Freeze the anchor for that interaction; no mouse polling/following. On display removal/metrics changes, re-clamp to nearest remaining display. Test negative coordinates, Retina/non-Retina mixes and edges.

Show recording/transcribing feedback, a short ready-draft preview, and replies for a voice-originated request. Hide ready draft after 20 seconds without deleting it; hide final reply after eight seconds, or immediately on explicit dismissal, zone switch, permission/course decision, sleep, or close. While awaiting a model response, show bounded status, then at most eight lines / 600 characters of actual Dum/Wizard text and an “Open command bar for full reply” hint. Do not invent a second model summary. Plans/attestations are labeled “decision waiting” and remain actionable in command/panel/tray, never in click-through pixels. Ordinary ambient Wizard advice goes to transcript/tray indicator, not an unsolicited cursor popup.

### Push-to-talk: a new OSW bridge is required

**Current:** `dictation.DictationHelper.status/open` validates/launches a bundled `OpenSuperWhisper.app`; `main` uses `/usr/bin/open`. There is no recording API, state event, transcript event, or Dum-bound paste target. `tools/prepare-dictation.mjs` downloads a pinned 0.1.0 DMG. Simply adding `globalShortcut.register` cannot supply release events or safe transcript routing.

Pin the controlled helper source to OpenSuperWhisper 0.1.0, commit `e406fee45c281fe358b27698bbfca3826e8e4a28`, under `vendor/OpenSuperWhisper/`, with upstream license and a small isolated Dum bridge mode. Retain its local model/onboarding/recorder/transcription engine; do not switch recognizers or use cloud speech. Source evidence: [ShortcutManager.setupKeyboardShortcuts](https://github.com/Starmel/OpenSuperWhisper/blob/0.1.0/OpenSuperWhisper/ShortcutManager.swift) registers `KeyboardShortcuts.onKeyDown/onKeyUp`; `handleKeyDown/handleKeyUp` currently mix toggle recording with a 0.3s hold threshold. [AudioRecorder](https://github.com/Starmel/OpenSuperWhisper/blob/0.1.0/OpenSuperWhisper/AudioRecorder.swift) exposes start/stop/cancel; [TranscriptionService.transcribeAudio](https://github.com/Starmel/OpenSuperWhisper/blob/0.1.0/OpenSuperWhisper/TranscriptionService.swift) returns text. These native internals are reuse points, not an existing IPC bridge.

Bridge mode disables OSW's own tray/indicator/paste/clipboard/history path and unneeded modifier-only event tap. It owns one native modifier+key shortcut, with immediate down=start and up=stop/transcribe; ignore repeat downs. No threshold or tap-to-toggle ambiguity. Use OSW's key-up registration, **not** Electron polling, renderer key-up while unfocused, synthetic paste, or a general keystroke monitor. Main's Electron globalShortcut owns command and explicit Send-draft shortcuts only. Reject equal voice/command/send shortcuts and rollback a conflicting registration; availability/permission errors remain visible. OSW's own standalone shortcut must not run concurrently in bridge mode.

Private inherited stdin/stdout NDJSON pipes between main and the known helper executable, with a launch nonce and bridge version handshake; no localhost port, URL command scheme, clipboard, or public distributed notifications. Separate logs to bounded stderr without transcript/audio/path content. The helper waits for main's `begin` authorization after native press; recording starts only when a live eligible binding was supplied. Release arriving before begin cancels that gesture, rather than starting a stuck recording later. Bind every event to `recordingId`, `zoneId`, `zoneEpoch`, and `inputToken`; one flight. EOF/parent death, cancel, sleep/lock, helper failure or lost release stops recording and discards the result. Enforce a two-minute recording ceiling as a lost-key-up safety stop, not an automatic Send.

On release, transcribe locally; final text fills the **canonical draft**, never sends or approves. Bubble shows the draft and modifier-key Send hint; `Cmd+Shift+Return` or tray/panel Send is the explicit send action, `Cmd+Shift+D` edits. The mouse path has deliberate Start/Stop voice commands/buttons; Stop ends capture for transcription, Cancel discards. Existing nonempty draft is not overwritten by voice: refuse start with an edit/send/clear hint. Invalidated late text is discarded with a visible status, not pasted into whichever app is focused. Voice cannot answer a plan/unaided/share consent by recognition of “yes”; those require explicit typed decision controls. Ordinary Dum questions accept a voice draft exactly as a typed answer. This preserves no-automatic-send safety without making voice depend on focusing a text field.

Keep setup/model download/microphone permission in the helper; show microphone/global-shortcut status in Dum. In bridge mode use temporary audio only, remove it on completion/cancel/error and remove abandoned bridge-owned temporary files on the next launch. Do not call OSW `RecordingStore`/clipboard insertion or print transcription. Stock upstream `IndicatorViewModel.startDecoding` stores recordings and pastes; it must not be used as the bridge completion path. Model files/preferences remain helper-owned, not zone records. Compile/package the controlled helper on macOS; runtime checks must verify expected bridge version, bundle ID, executable containment and executable mode, not the current structural-only “app is present” claim. Use a distinct helper bundle ID `com.dumintern.opensuperwhisper`; don't silently reuse another OSW install's permissions/settings.

## 5. Dum and the Wizard without the pair

Two personae, one transcript and one prompt owner. `Store.Entry.say/question` are Dum; `quip` is Wizard. Existing `ui/transcript.ts:Transcript` and `ui/sprites.ts:Creature/SPRITES` already support these independent of the corner pair.

- Panel: existing pixel portraits next to labeled messages; Wizard links visible, keyboard-accessible. Keep global skill-backed progress using `web/view.ts:view(...).usableBuilt`, not message count.
- Command bar: compact labeled Dum reply; Wizard aside below, never a competing input or default plan approval. Source links open via validated external-link handling.
- Bubble: labeled text only; one Dum excerpt followed by one short Wizard line when part of the voice request. No permanent character or speech widget.
- Screen advice remains optional and inspectable. Fresh revamp off; explicit Pause/Resume in Tray and panel. Remove the screen/files source toggle because there is no saved repo observer. When enabled, capture the display nearest the cursor at poll time, not the first capture-source entry. Keep `ScreenWizardAdvice` dedup/rate/cancellation limits; block no-zone, first-run, voice recording/transcription, busy model, pending consent/plan/course, active unaided practice and sleep/lock.
- Main schedules and obtains pixels; host performs all Wizard model calls with resolved ZoneContext and current practice suppression. Manual capture retains source picker → preview → explicit Send, five-minute expiry, bounded bytes and no image persistence. Capture completion must not reactivate an unfocused Dum window. Denied screen permission has no file fallback.
- Screen content is untrusted observation, never a request/approval or proof. If zone revision/epoch changes during a check, drop its result. The screen can change after capture; an aside is about that observed frame, not a guarantee about the latest display. Keep the sourced-anchor filters and allow silence.

## 6. Processes, protocol, and shared contracts

### Responsibilities

| Process | Owns | Must not own |
| --- | --- | --- |
| Electron main | Tray/windows/focus/global shortcuts, helper pipes, native pickers/consent, canonical draft, capture buffer/tokens, UI preferences mirror, screen scheduling, renderer sender authorization, utility supervision | Model calls, competency decisions, repo discovery, filesystem authority inferred from renderer paths |
| Utility host | H writer lock, zone graph/contexts, global evidence/holds/skills/sync, active Store/session, bounded share broker, memory/practice/course/proposals, all Claude/image/Wizard calls | Electron windows, clipboard or native keyboard APIs |
| Sandboxed renderer | Render snapshot, accessible controls, draft edits and finite requests | Node/filesystem/model/native access, raw host operations, granting permissions by naming a path |
| Native helpers | OSW local recording/transcription; universal focus capture/restore | Claude, app/zone storage, source access, conversation Send/approval |

Main reads settings only for launch/window initialization; the host is the authoritative settings writer. `settings` RPC persists first, then main applies launch/hotkey changes and reports conflict rollback. A single host remains across normal zone switches. On host crash: invalidate epochs, decisions, drafts' send bindings, shares and captures; stop voice/observation; display error; restart only into fresh history, never replay a queued send/approval. Existing `HostController` child/epoch/request-correlation approach remains; validate events as well as requests.

### Frozen type/function seams

Put data-only resource/voice declarations in new `src/share-types.ts` / `src/desktop/voice-protocol.ts`; avoid runtime imports from main into host or renderer. `src/desktop/protocol.ts` supplies Request and its strict Zod schema; `ipc.ts` consumes that schema rather than duplicating it. `host-protocol.ts` supplies strict request **and event** schemas. No legacy union alternatives.

```ts
// zones.ts: host-only; all synchronous writes under the H writer lock
createZone(input: Pick<Zone,"name"|"goal"|"parentId"|"language"|"focusSkills">): Zone;
listZones(): ZoneRegistry;
resolveZone(id: ZoneId): ZoneContext;
updateZone(id: ZoneId, patch: Partial<Pick<Zone,"name"|"goal"|"language"|"focusSkills">>, expectedRevision:number): Zone;
writeZoneContext(id: ZoneId, text:string, expectedRevision:number): ZoneContext;
setActiveZone(id: ZoneId | null, expectedRevision:number): void;
deleteZone(id: ZoneId, expectedRevision:number): {activeZoneId:ZoneId|null; deletedIds:ZoneId[]};
zonePrompt(zone: ZoneContext): string; // JSON background, not authority

// state-files.ts; base is an app-owned H or zone directory, never a shared root
readState(base:string, relative:string, maxBytes:number): string | null;
writeState(base:string, relative:string, text:string): void;
createState(base:string, relative:string, text:string): boolean;
statePath(base:string, relative:string): string;
// session-lock.ts
acquire(home:string): () => void;

// share-types.ts / shared-files.ts
type InputBinding = {zoneId:ZoneId|null; zoneEpoch:string; inputToken:string; requestId:string};
type RequestBinding = InputBinding & {zoneId:ZoneId}; // files/model requests require a live zone
type ResourcePath = string; // normalized <uuid>/<relative>, or new/<relative> for proposals only
type ShareGrant = {id:string; kind:"file"|"folder"; label:string; files:ResourcePath[]};
type SourceSnapshot = {path:ResourcePath; sourcePath:string; text:string; sha:string; complete:true};
class SharedFiles {
  constructor(binding:RequestBinding);
  grant(authorizedPath:string, kind:"file"|"folder"): Promise<ShareGrant>; // trusted main only
  list(): ResourcePath[];
  file(path:ResourcePath): Promise<SourceSnapshot>;
  read(path:ResourcePath, from:number, to:number): Promise<{path:ResourcePath; text:string; sha:string; from:number}>;
  revoke(shareId?:string): void; // omitted ID revokes all
}
// proposals.ts: caller must already have gate verdict; module enforces app-path and stale-source safety
proposeChange(zoneId:ZoneId, binding:RequestBinding, source:SourceSnapshot, next:string, skills:SkillRef[]): Promise<ProposalManifest>;
proposeFile(zoneId:ZoneId, binding:RequestBinding, target:ResourcePath, content:string, skills:SkillRef[]): Promise<ProposalManifest>;
// Existing gate.classify/mayChange signatures stay; path strings now mean ResourcePath.
// boundary.ts: ability levels, not a guessed concept/tool classification from note text
type Boundary = {skills:{skill:SkillRef; level:skills.Level; recognize:boolean; build:boolean}[]; shares:ShareGrant[]};
boundary(tree:skills.Tree, shares:ShareGrant[], held:Set<string>): Boundary;
lines(value:Boundary): string[];

// evidence.ts: one global service; the active store/zone is passed, not captured forever
class Evidence {
  constructor(home:string);
  readonly held: Set<string>;
  explain(origin:{zoneId:ZoneId; zoneName:string; store:Store}, e:ExplanationInput, userText:string): Result;
  submit(origin:{zoneId:ZoneId; zoneName:string; store:Store}, s:SubmissionInput, files:SourceSnapshot[]): Result;
  course(origin:{zoneId:ZoneId; zoneName:string; store:Store}, input:CourseEvidenceInput): Result;
  undo(origin:{zoneId:ZoneId; zoneName:string; store:Store}, name?:string): boolean;
  selfReport(origin:{zoneId:ZoneId; zoneName:string; store:Store}, skill:SkillRef, unaided:true): Result;
  describe(zoneId?:ZoneId): string;
}
// Input types retain current Evidence method payload fields; no claimed hash supplied by model.

// practice.ts / course.ts
class Practice {
  constructor(zone:ZoneContext, store:Store, files:SharedFiles, evidence:Evidence,
              personal:context.Context, ask?:typeof oneShot);
  suggest(argument:string): Promise<string>;
  submit(argument:string): Promise<string>; // paths are current resource names only
  describe(): string;
}
type CourseContext = {zone:ZoneContext; store:Store; evidence:Evidence; personal:context.Context};
take(skill:string, lang:string, ctx:CourseContext): Promise<{completed:boolean; recorded:boolean}>;
designPrompt(skill:string, lang:string, tree:skills.Tree, path:string, zone:ZoneContext, personal:context.Context): string;

// session.ts: no Repo, Surface, persist/resume, legacy todo, or terminal mode
prepare(zone:ZoneContext, mode:gate.Mode, store:Store, personal:context.Context,
        evidence:Evidence, files:SharedFiles): Ctx;
run(request:string, ctx:Ctx, opts:{signal?:AbortSignal}): Promise<void>;
systemPrompt(zone:ZoneContext, mode:gate.Mode): string;
// memory.ts keeps load/save/attach/notes/remember/prompt/describe/fresh, but takes ZoneId, resolves internally.
// tree.ts: treeText(tree:skills.Tree, language:string, filter?:string): string; no root lookup.
```

`run` handles one top-level request and its nested questions/decisions, then closes the SDK session on its result; the controller parks the next prompt. Each request gets a fresh Ctx, SharedFiles and Practice instance; no WeakMap-prepared context or old broker carries over. An empty broker permits conversation without sharing. Grant inputToken identifies its originating prompt; nested prompt changes keep the requestId but responses must carry the latest live prompt token. Snapshot review reads remain bound until their request finishes/cancels. Internal course scratch uses app-owned storage, not a fake shared external root. Global Evidence is injected, never recreated by `prepare`.

`Store` constructor becomes `(zone:{id:ZoneId; name:string}, mode:Mode)`; `State` replaces `repo/root/files` with `zoneId/zoneName`, retaining transcript/prompt/busy/status/stage/unlocked/models. Remove self-maintenance/restart hooks/state, terminal quit parsing, Git commands and CLI-only rendering paths. Keep current cancellation and no-default-approval behavior. `wizard.Decision` requires `zone` and keeps its existing optional skills/lang/paths/practice/changes/images fields; populate `changes` only from explicitly shared/proposed bytes, not Git. `oneshot.Opts.cwd` becomes required.

```ts
// controller.ts and host-client.ts expose the same host-facing operations
openZone(id:ZoneId, personal:context.Context, mode:Mode): Promise<void>;
send(text:string, binding:RequestBinding, shares:ShareGrant[], image?:SharedImage): Promise<void>;
respond(binding:RequestBinding, decision:{kind:"plan"|"attest"|"share"; value:boolean}): Promise<void>;
command(name:"inspect"|"practice"|"submit"|"remember", argument:string, binding:RequestBinding): Promise<void>;
observeScreen(image:SharedImage, zoneRevision:number, signal:AbortSignal): Promise<string|null>;
interrupt(): Promise<void>;
close(): Promise<void>;
// Controller also dispatches zone/settings/tree-edit/tree-sync records through the storage APIs.
// Send consumes current broker grants by ID; wire ShareGrant copies are not authority.
```

Native wrapper signatures (transport IDs/nonce remain internal):

```ts
type VoiceState = {phase:"idle"|"recording"|"transcribing"|"ready"|"error"; recordingId:string|null; status:string};
// DictationHelper retains supported/available/version/message status, but checks bridge readiness too.
status(): DictationStatus;
setup(): Promise<void>;
start(binding:InputBinding, gestureId:string|null): Promise<void>; // null is deliberate mouse start
stop(recordingId:string): Promise<void>;
cancel(recordingId?:string): Promise<void>;
onEvent(listener:(event:VoiceEvent)=>void): () => void;
close(): Promise<void>;
// FocusBridge
capture(): Promise<string>; // opaque handle
restore(handle:string): Promise<boolean>;
close(): Promise<void>;
// ScreenAdviceOptions.check; context() supplies a snapshot before capture
check(image:SharedImage, zone:{id:ZoneId; epoch:string; revision:number}, signal:AbortSignal): Promise<string|null>;
```

Aborting a screen check sends private `wizard-screen-cancel{checkId}` to the host, where checkId is the original RPC ID; the host aborts only that observation's helper. Pause/switch/close must not leave a model request running invisibly. Renderer cannot invoke this operation or supply Wizard text.

### Message inventory

All renderer requests are strict, bounded discriminated objects. Conversation mutations carry InputBinding or the stricter RequestBinding; metadata actions carry `expectedRevision`. `Snapshot` adds `{zones:ZoneRegistry, activeZone:ZoneContext|null, zoneEpoch, binding:InputBinding|null, draft:DraftState, shares:ShareGrant[], voice:VoiceState}` and retains state/tree/settings/runtime/wizardStatus/screenPermission/hotkeyError/platform/version/canAttach. Remove recentProjects and runtime.gitAvailable. Main supplies a local goal binding with `zoneId:null` before first-run zone creation; ordinary host bindings require a live zone. No file/capture/model grant is possible with that null-zone binding. Absolute share roots are not broadcast to every renderer; display labels/resources suffice.

| Request type | Payload / route |
| --- | --- |
| `snapshot` | none; main returns current combined snapshot |
| `zone-create` | editable Zone creation fields; optional `enter:boolean` |
| `zone-enter` | `id,expectedRevision` |
| `zone-update` | `id,patch,expectedRevision` |
| `zone-context` | `id,text,expectedRevision` |
| `zone-delete` | `id,expectedRevision`; main confirms subtree before host delete |
| `draft-set` | `text,expectedDraftRevision,binding`; main compare-and-swap |
| `send` | `binding:InputBinding,draftRevision`; consumes canonical draft and current shares/capture; null-zone goal Send locally creates/enters the root zone, otherwise routes a RequestBinding to host; no renderer-supplied image bytes |
| `respond` | `binding,decision`; explicit decision kind must match parked prompt |
| `interrupt` | current binding; never an answer |
| `panel` | `zones\|tree\|memory\|history\|context\|evidence\|boundary\|practice\|settings` |
| `command` | finite inspect/practice/submit/remember name, argument, binding |
| `share-choose` | `kind:"file"\|"folder",binding`; native picker then host grant |
| `share-path` | `path,kind,binding`; native resolved-path confirmation then host grant |
| `share-remove` | `shareId,binding`; revoke selected grant and remove from draft |
| `open-record` | `record:"proposal"\|"course"\|"memory",id?`; host resolves registered active-zone artifact, not arbitrary path |
| `skill-edit` | `op:"add"\|"remove",skill`; add requires explicit native/typed unaided attestation; global tree |
| `tree-sync` | link with server URL, or sync/rotate/off; existing client APIs, global writer serialization |
| `settings` | complete DesktopPreferences; persist/apply/rollback registration conflicts |
| `capture-sources`, `capture-preview`, `capture-discard` | existing source/preview flow; preview carries current binding |
| `screen-permission` | native permission/status action |
| `voice-setup`, `voice-start`, `voice-stop`, `voice-cancel` | setup native helper; start carries eligible binding; no transcript in renderer request |
| `runtime-check`, `runtime-login`, `runtime-login-open`, `runtime-login-code`, `runtime-login-cancel` | retain bounded subscription setup flow, no Git setup |
| `show-surface`, `dismiss-surface` | panel/command only; main focus manager; bubble is not selectable/mutable |
| `quit` | controlled teardown |

`DraftState = {binding:InputBinding|null, revision:number, text:string, source:"keyboard"|"voice", shareIds:string[], captureToken?:string}`. Main owns per-zone in-memory drafts and the first-run local goal draft. `draft-set` and voice results increment revision; send must match it and the live binding. Input prompt changes invalidate send permission; preserve text as an unsent draft, then explicitly rebind on user edit/open, never send to a different decision. Goal submission/zone creation invalidates its local binding and any late recording. No draft is persisted on app exit.

Host requests keep `{epoch,id,op}` correlation. Target ops: `initialize` (H, sanitized config, acquire writer lock); `zone-create/enter/update/context/delete`; `settings`; `send`; `respond`; `command`; `panel`; `share-add/remove`; `skill-edit`; `tree-sync`; `open-record` (returns validated path to main); `wizard-screen` (bounded image + zone epoch/revision); `wizard-screen-cancel` (original checkId); `interrupt`; `close`. `share-add` is main-authorized canonical path/kind/binding, never a raw renderer dispatch. Remove `open` with root, `wizard-advice` files mode and arbitrary `quip` injection. Host events: `ready`; `state` (active-zone state/tree/tokens/context/registry/shares); `reply` (id, success/error and typed optional operation result); `fatal` (bounded diagnostic). Validate epoch, operation-specific result schema, byte limits and child identity on both ends. Main alone publishes the combined renderer `dum:snapshot` event.

OSW private bridge commands/events (`src/desktop/voice-protocol.ts`):

- Commands: `hello{version:1,nonce}`, `configure{voiceHotkey}`, `begin{gestureId:string|null,recordingId,binding:InputBinding}`, `stop{recordingId}`, `cancel{recordingId}`, `setup`, `shutdown`. A null gesture means deliberate mouse start; native gestures must match a live press.
- Events: `ready{version:1,nonce,bridgeVersion,modelReady,microphoneStatus,shortcutStatus}`, `pressed{gestureId}`, `released{gestureId}`, `recording{recordingId,binding}`, `transcribing{recordingId,binding}`, `transcript{recordingId,binding,text}`, `cancelled{recordingId}`, `error{recordingId?,code,message}`. Correlate the gesture before beginning. Maximum final text 32 KiB; reject oversized/invalid/unsolicited lines; no audio in IPC. `VoiceState` exposes idle/recording/transcribing/ready/error, recording ID and bounded status, never audio. Null-zone voice fills only the local learning-goal draft.

Focus helper commands: `capture{id}` → `captured{id,handle}`, `restore{id,handle}` → `restored{id,ok}`, `shutdown`; handles live only for that main/helper lifetime and refer only to a captured running app. No arbitrary renderer PID/bundle activation request.

Security retained from `main.preferences`, `ipc.ownedPage/Router`, `preload`, `ui/index.html`: sandbox, contextIsolation, no Node, local CSP/no renderer network, allowed top-level frame and registered webContents identity, finite validated IPC, no navigation/popups or arbitrary file/URL opening. Distinguish panel/command/bubble sender roles; bubble gets a read-only subscription preload and no invoke. Capture `Binding.root` becomes RequestBinding; revoke both held and in-flight captures on transition. Settings and tree panels must work without model login or an active zone.

## 7. Deletion and rewrite inventory

Delete after consumers cut over; no compatibility wrappers:

- Terminal/dev: `src/cli.tsx`, `src/plain.ts`, `src/lines.ts`, `src/sprite.ts`, `src/self.ts`, `src/prefs.ts`, `bin/dum`, `bin/dum-dev`, `tools/practice.sh`, `tools/replay.ts`; remove package bin entries and practice/replay scripts.
- Repo-only: `src/repo.ts`, `src/workspace.ts`, `src/todos.ts`, `src/desktop/saved-change-advice.ts`.
- Corner-only: `src/desktop/ui/companion.ts`, `src/desktop/companion-layout.ts`; delete companion BrowserWindow, corner placement/drag/location persistence, `view=companion`, move-companion IPC, corner CSS/bob animation and corner screenshot target.
- Retired suites: `test/cli.test.ts`, `test/lines.test.ts`, `test/self.test.ts`, `test/repo.test.ts`, `test/todos.test.ts`, `test/saved-change-advice.test.ts`. Delete `test/sprite.test.ts`'s terminal draw tests; move only meaningful parser/frame-selection invariants to `test/art-parser.test.ts`, not “there is art” or source snapshots.

Rewrite, retaining useful behavior:

- Core: `src/session.ts`, `src/store.ts`, `src/memory.ts`, `src/evidence.ts`, `src/practice.ts`, `src/course.ts`, `src/gate.ts`, `src/boundary.ts`, `src/tree.ts`, `src/context.ts`, `src/wizard.ts`, `src/oneshot.ts`; narrow `src/skills.ts` persistence failure handling. Remove `session`'s `lines.sentences` import; use a local plain-text helper if still needed. `treeText` no longer discovers a root. `boundary` no longer reads manifests. Remove every maintenance-only Store hook/state, not just CLI entrypoints.
- Desktop: `src/desktop/main.ts`, `controller.ts`, `host.ts`, `host-client.ts`, `host-protocol.ts`, `protocol.ts`, `ipc.ts`, `preload.ts`, `settings.ts`, `capture.ts`, `dictation.ts`, `runtime-setup.ts`, `screen-wizard-advice.ts`; all `src/desktop/ui/` rendering entries/panel/transcript/tree/style affected by new context/draft state. Keep `dom.ts`, shared sprites and art parser; no second art format.
- Packaging/tooling: `package.json`, `package-lock.json` only if dependency metadata changes, `tsconfig.desktop.json`, `tools/desktop-build.mjs`, `tools/prepare-dictation.mjs`, `tools/desktop-smoke.mjs`, `electron-builder.yml`, `.github/workflows/desktop-macos.yml`. Main/build icon parsing imports `art-parser.ts`, not removed `sprite.ts`. Remove Linux distribution target while preserving Linux developer launch; keep Intel keyboard packaging, arm64 OSW only. `desktop:pack` and `desktop:mac` must both prepare their required native resources.
- Documentation: `README.md`, `CONTRIBUTING.md`, `docs/overhaul-goal.md` current rules; only removed-feature copy in `src/site/install.html` and `src/site/how-it-works.html`. Remove corner, choose-Git-folder, Git-install, terminal-edition/source-setup-supported-on-Linux, old storage, and focused-paste-only voice claims. A terminal LLM used to install the Mac source app is not the removed terminal edition; preserve that distinction. Do not redesign site/game/server/routes/download history.
- Optional sync client `src/web.ts`: replace CLI instructions with Settings instructions and keep `web.json`/tree-only semantics. `src/sync.ts`, `src/web/**`, `src/site/game.js`, `src/notes.ts`, `src/curriculum.ts`, `src/anchors.ts`, `src/art/**`, curated trees remain, except a real changed caller/type error requires a scoped update. `src/runtime.ts` keeps closed subscription behavior; remove terminal-only comments/fallback assumptions if unreachable after entry deletion, without changing model selectors.

`test/workspace.test.ts` is replaced, not mechanically renamed: move bounded IO/secret/symlink/stale proposal/no-clobber coverage into new state/share/proposal suites; delete Git filters/commands/working-tree and exclusive external-new-file tests. Rewrite boundary tests around current skills plus granted resources; delete manifest scanner tests. Delete legacy todo settlement and repo-language tests in session; replace external `create_file` expectations with proposal-only output. Source/wording/default-pin tests for removed surfaces are deleted, not re-pinned. Keep language/evidence/prerequisite, cancellation, user-edit races, model provenance, partial project reviews, corruption preservation and source-anchor tests.

## 8. Implementation plan: contracts first, disjoint parallel slices

Phases are dependency barriers, not separate releases. A slice owns its listed files and corresponding listed tests; it does not edit shared contracts or another slice's files. New helper modules belong only to their named owner. Frozen contracts from phase 0 are consumed in later phases; protocol changes go through the integration owner at a barrier. No agent runs builds/tests/formatters mid-flight; integration owner runs checks once after the combined cutover. Slice checks below specify what must be verified then. No production mocks or native protocol stubs count as completion.

### Phase 0 — integration owner freezes contracts

**C0: Contracts and acceptance fixture definition.** Own `src/zone-types.ts`, `src/share-types.ts`, `src/desktop/voice-protocol.ts`, `src/desktop/protocol.ts`, `src/desktop/host-protocol.ts`, and new `test/revamp-contracts.test.ts`. Publish the schemas/signatures in §6, limits, typed replies, sender roles, and a no-Git fixture with two nested zones and isolated H/context. Define `ExplanationInput/SubmissionInput/CourseEvidenceInput` from current Evidence payloads here or in a data-only `src/evidence-types.ts`, owned by C0. Acceptance: validate real good/bad serialized requests/events and reject stale/malformed bindings, extra fields, renderer-supplied images/hashes and legacy root operations; do not test copied union strings. No product workflow is claimed operational in this phase.

### Phase 1 — independent foundations

| Slice / owned files | Exposed / consumed contracts | Acceptance |
| --- | --- | --- |
| **S1 State/zones/settings**: new `src/state-files.ts`, `src/zones.ts`; rewrite `src/memory.ts`, `src/session-lock.ts`, `src/context.ts`, `src/desktop/settings.ts`; tests `memory`, `context`, new `state-files`, `zones`, `session-lock`, `desktop-settings` | §2 schemas, §6 storage/zone APIs; memory accepts ZoneId; `DesktopSettings.load(H, legacyProfile?)`, validated persist of v2 settings; personal context resolved once | nested inheritance/precedence/limits/cycle rejection, stable rename, stale revision, subtree tombstones/no skill removal, registry write failure/no phantom activation, corruption/no-follow refusal, concurrent writer/dead-holder takeover, crash history and editor-safe append, one-time settings import/no repo scan; smoke local goal→restart persistence |
| **S2 Sharing/proposals/gate**: new `src/shared-files.ts`, `src/proposals.ts`; rewrite `src/gate.ts`, `src/boundary.ts`; replace `test/workspace.test.ts`, rewrite `test/gate.test.ts`, `test/boundary.test.ts`, new `shared-files`/`proposals` suites | RequestBinding/ResourcePath/SourceSnapshot; SharedFiles/proposal APIs; unchanged gate method shapes, current global holds input; boundary receives skill tree and grant list, no root | chosen file/folder only, secret/private/binary/oversize/traversal/ancestor+final symlink refusal, enumeration caps, grant expiration and stale binding, full snapshot digest, stale external save refusal, all proposals app-owned/immutable/no external file writes; exact-resource and shared-file/target-language gate tests; smoke edit shared file externally and observe stale refusal |
| **S3 Global evidence**: rewrite `src/evidence.ts`, narrow `src/skills.ts`; rewrite `test/evidence.test.ts`, update failure behavior in `test/skills.test.ts` | global Evidence API and origin; SourceSnapshot; persistent held IDs; skills.write throws failures; keep sync notification seam | own-words recognition only, apply-after-build, direct unaided review/prereqs, no credit from excerpts/images/course, global transfer A→B without language transfer, not-yet across switch/restart, ledger/notes IO failure does not claim credit, no private proof in sync; smoke two-zone credit and revocation with real files/scripted reviewer |
| **S4 Native voice/focus**: new `vendor/OpenSuperWhisper/**`, `native/macos/FocusBridge.swift`, new native bridge additions; rewrite `src/desktop/dictation.ts`, `tools/prepare-dictation.mjs`; new `src/desktop/focus.ts`; rewrite `test/desktop-dictation.test.ts`, new `desktop-focus` suite | private bridge schemas, `DictationHelper.status/setup/start(binding)/stop/cancel/close`, `onEvent`; `FocusBridge.capture/restore/close` promises; no Electron window imports | platform/bundle/bridge/version/executable/containment rejection; down/up/repeat/early-release/cancel/EOF binding behavior; no paste/history/logged transcript; temporary recording cleanup; actual Apple Silicon record→transcribe→draft on physical Mac, universal focus executable on Intel+arm64; Linux tests cover transport state/errors, not microphone claims |

S4 builds the controlled helper, not stock OSW plus invented start/stop calls. Pin upstream dependencies/license; do not change app packaging/workflow files until their phase-4 owner integrates the resources. S1 alone modifies shared persistence primitives; S3 alone changes skill write failure behavior. No duplicate `workspace` replacement API.

### Phase 2 — independent domain and host cutover

| Slice / owned files | Exposed / consumed contracts | Acceptance |
| --- | --- | --- |
| **D1 Conversation**: rewrite `src/session.ts`, `src/store.ts`, `src/oneshot.ts`, `src/runtime.ts`, `src/tree.ts`; tests `session`, `store`, `runtime`, new `tree` | Ctx/prepare/run/systemPrompt, required helper cwd, Store zone state; consumes global Evidence, SharedFiles, Practice/course interfaces | goal/context in emitted system boundary, request-local shares/plan, no built-in/foreign tools, no root/resume/commands, explanation current-turn only, old approvals not live, stale send/typed-ahead cannot approve, Stop/close withdraw decisions; keep unlocked-core and locked-piece refusals; smoke real zone tool calls saving patches without modifying source |
| **D2 Learning/Wizard**: rewrite `src/practice.ts`, `src/course.ts`, `src/wizard.ts`; tests `practice`, `course`, `wizard` | same ZoneContext/personal input to generation/audit/review/Wizard; CourseContext and completed/recorded result; SourceSnapshot review | audited project milestones/time ordering/context, no suggestion credit, partial prerequisite-ordered reviews, post-await revocation/cancellation, course resumption/no scratch clobber/recognition only, no personal-context opt-out bypass, sourced vs unsupported Wizard claims; smoke optional course and project review through public APIs in isolated zones |
| **D3 Utility integration**: rewrite `src/desktop/controller.ts`, `src/desktop/host.ts`, `src/desktop/host-client.ts`; tests `desktop-controller`, `desktop-host` | §6 host operations, strict frozen schemas; one H lock/global Evidence, fresh zoneEpoch; preserve child identity/correlation | real child process opens nested zones without Git, writes correct history, switches with pending plan/review and rejects late response, global lock excludes second writer, dead-child capability invalidation, tree/settings before login/no zone, returns Wizard output only for live context; smoke utility child create/enter/remember/switch/reopen |

D1 and D2 consume each other's phase-0 interfaces, not implementation internals; do not modify the other's files. D3 consumes both and may not patch contract files itself. Barrier owner resolves interface disagreements before phase 3, not with aliases.

### Phase 3 — independent desktop surface slices

| Slice / owned files | Exposed / consumed contracts | Acceptance |
| --- | --- | --- |
| **U1 Renderer**: rewrite `src/desktop/ui/**` except deletion already assigned below; new `command.ts`, `bubble.ts`, `zones.ts`, `composer.ts`; new read-only `src/desktop/bubble-preload.ts` | immutable Snapshot, typed Request/Reply; canonical main draft; renderer dispatch only panel/command/bubble; existing transcript/sprites/tree | actual Tab/arrows/Enter/IME/Esc goal, zone CRUD, keyboard share picker/path, history/tree/settings, draft sync across panel/bar, explicit approval/attestation controls, voice status/draft, clipped bubble and source links; screenshot all three views, narrow-screen no overflow; no renderer file/model/native calls |
| **U2 Main/router/windows**: rewrite `src/desktop/main.ts`, `src/desktop/ipc.ts`, `src/desktop/preload.ts`, `src/desktop/capture.ts`, `src/desktop/runtime-setup.ts`; new `src/desktop/surfaces.ts`, `src/desktop/draft.ts`; rewrite `test/desktop-native.test.ts`, new `desktop-surfaces`/`desktop-draft` | U1 view entrypoints; focus/voice interfaces from S4; host methods from D3; Request role checks, draft revisions, capture binding | remove Git readiness/install, typed path/native consent, stale draft/voice/capture rejection, read-only bubble sender, finite artifact open, no accidental source writes, capture does not steal focus, hotkey rollback, placement/display-removal/TTL tests; real hotkey→type→Send→Esc→editor focus; actual click-through/full-screen/Spaces on Mac |
| **U3 Screen observer**: rewrite `src/desktop/screen-wizard-advice.ts`; rewrite `test/screen-wizard-advice.test.ts` | scheduler accepts injected `capture/check/publish/blocked`, no wizard/model import in main module; U2/D3 supply `observeScreen`; epoch/revision on check | off means zero capture/check, correct zone snapshot, active-practice/voice/consent pause, dedup/rate/error/Stop/close/switch drop stale result, no image persistence, selected cursor display; smoke enabled/paused status through actual app and observed helper boundary |

U1 does not edit main/preload/protocol; U2 does not edit UI or observer. U3 does not edit host-client/main/Wizard. Main supplies scheduler callbacks through the agreed constructor contract. Screen observation cannot be kept in main by leaving a `wizard.screenDecision` import behind.

### Phase 4 — cutover inventory and end-to-end acceptance

- **X1 Removal/build owner:** owns all §7 deleted files/tests, `package.json`/lock, `tsconfig.desktop.json`, `tools/desktop-build.mjs`, `electron-builder.yml`, `.github/workflows/desktop-macos.yml`, and new `test/art-parser.test.ts`. Remove terminal/Git/corner artifacts and scripts, switch tooling art imports (U2 owns main's import), compile/bundle correct views/preloads, package universal focus helper and bridge-enabled arm64 OSW, retain bundled Claude isolation. Consume S4 output; never alter native/vendor code. Acceptance: no product import of deleted modules, no npm bin/terminal edition, macOS x64 keyboard package and arm64 voice package contain verified resources; Linux unpacked developer smoke still starts; no Git probe on app launch.
- **X2 End-to-end smoke owner:** owns only `tools/desktop-smoke.mjs`. Replace the current project/companion journey with §9; no production test-only renderer commands or fake provider in the shipped app. Output screenshots/report under configured private /tmp location. Acceptance: actual Electron windows/utility process plus persistence/relaunch, not DOM string assertions alone.
- **X3 Docs/sync owner:** owns `README.md`, `CONTRIBUTING.md`, `docs/overhaul-goal.md`, removed-feature copy in `src/site/install.html`/`how-it-works.html`, and `src/web.ts` Settings wording. Keeps this design file stable; does not change site/game/server behavior. Acceptance: docs match release support, learning goal, grants/proposals/global proof/storage/native permissions and migration; no promises of physically verified voice/full-screen until evidence exists; existing tree-sync tests remain meaningful.

After all slices land, integration owner alone resolves remaining cross-slice callers/contracts, runs final checks, and reviews removal completeness. Every retired test must be categorized as removed behavior or relocated safety coverage. All temporary diagnostic scripts/fixtures are outside the repo and removed after proof. No commit/push is part of this design assignment; implementation publishing needs separate authorization.

## 9. Verification contract

The design-only assignment runs no application build or model/native checks. The following are required for the **implemented** revamp; they are not results.

### `npm test`

Keep `node --import tsx --test test/*.test.ts` (`package.json:scripts.test`). All fixtures use isolated H, explicit `DUM_CONTEXT=off`, temporary private files, no user credentials/network/model calls. Prove:

- zone graph CRUD/inheritance/active restoration, failed/stale edits, tombstone isolation, settings migration and one global writer;
- global competency/holds/prerequisites/language semantics, honest proof and manually editable-note semantics, no suggestion/course/image mastery;
- explicit sharing/limits/denials/expiry/identity races, exact approved resources, immutable existing/new proposals and external editor safety;
- cancellation at every awaited model/review/share/voice boundary, old epoch/prompt/recording/draft/capture cannot mutate new state;
- preserved project-generation audit and per-target partial credit, scratch resumption, memory bounds/corrupt preservation;
- strictly validated renderer/host/native protocols, subscription isolation, sanctioned artifact opening, bubble role and capture byte lifetime;
- deterministic placement/TTL and voice transport transitions; no claim that injected ports prove OS permissions, press/release or native transcription.

Delete tests for removed terminal rendering, Git catalog/filter/worktree behavior, corner motion, legacy todo settlement and actual external source creation. Keep meaningful parser, gate, model isolation and no-clobber cases under their new public APIs. Do not replace source/prose/default-pin tests with new wording pins.

### `npm run typecheck`

Keep core and renderer `tsc --noEmit` checks. Prove clean imports after deletions, no Repo/root/Git fields in app types, matching finite Request/Host/Voice unions and producers/consumers, required ZoneContext/cwd/personal propagation, new view/preload typing. Typecheck is not native helper compilation or proof that prompts teach well.

### `npm run desktop:smoke`

Keep the real Electron/CDP journey in `tools/desktop-smoke.mjs`, under Xvfb on Linux, no model login. The current harness creates a Git sample, sends `open-project`, writes `<project>/.dum/memory.md`, targets `view=companion`, checks focused-paste voice setup, and restores recent roots; replace all of those assertions. Preserve sandbox/CSP/IPC/token/capture/persistence intentions rather than re-pinning old selectors.

1. Fixture is a normal non-Git folder with code, isolated H/profile/HOME/Claude config and private output under `/tmp`. Launch without Git in PATH; runtime setup may report unauthenticated Claude but must not demand Git.
2. First visible UI is learning goal. Enter it using keyboard; observe `zones.json`, selected zone and empty context/focus, unchanged seeded skills. Auth is not needed to create/edit/view zones.
3. Create Programming parent and Data Structures child through UI, edit labeled notes/language/focus, enter child, inspect resolved breadcrumb/goal/inheritance via app snapshots. Rename without ID/path changes; delete a throwaway subtree and verify retained global notes and inactive data.
4. Open command by app's actual surface path; type draft, dismiss with Escape, reopen and observe preserved draft/shared panel state. Test keyboard navigation to tree/history/settings and native sharing routes. A live global shortcut and external-app restoration remain Mac manual acceptance, not a Linux claim.
5. Share explicit non-Git file/folder; inspect allowed excerpt; attempt stale binding and denied private path. Observe refusals and zero state changes. Remember a note, read it in the zone panel, switch to another zone and prove history/memory separation. No model call required for these local operations.
6. Global tree still shows seeded built skill and locked recursion with correct usableBuilt after prerequisite removal. Replacing a shared source file doesn't count as competency. Local scripted API smokes separately prove gated proposal output and full-byte review; don't pretend a no-login desktop journey exercised Claude implementation.
7. Capture under Linux/Xvfb: preview PNG from listed source, discard, reject reuse/zone-switched preview, no pixels/data URL in H state. Retain honest platform permission limits. No auto refocus after capture.
8. Renderer targets are panel/command/bubble; no companion target. Show genuine read-only bubble projection from available local feedback (e.g. voice-unavailable status after explicit voice attempt on Linux), screenshot it and prove it expires. Test click-through/focus flags through native/window assertions where available; don't describe those flags as full-screen proof. Reject bubble-origin mutation.
9. Relaunch: restore active zone, metadata/settings/history, new epoch/token, no old permission/approval/grant/capture. Keep private nonblank visual evidence for panel and command; recording/reply bubble evidence also required on Mac. `report.json` records observed checks and native limitations, not screenshots for publication.

CDP cannot operate native chooser/confirmation windows. Linux smoke uses XTest via `xdotool`, scoped to the isolated Electron process/dialog IDs, for the native Share-path confirmation and zone-delete consent; it must not add production consent-bypass IPC. Require Xvfb/xdotool as smoke prerequisites and fail visibly if absent. Mac native chooser/consent is covered by the physical-Mac checklist; a packaged Mac CI report must mark any unavailable native-dialog automation as unexercised, not claim those checks passed.

Set `DUM_SMOKE_OUTPUT` to `/tmp/...`; smoke must respect it. This assignment runs no build: the current build unconditionally removes/writes `dist/` and `build/` (`tools/desktop-build.mjs`), and current smoke defaults output to `release/desktop-smoke`.

### Physical Mac and real model acceptance — mandatory separate evidence

Linux/CDP cannot prove native voice or macOS window behavior. Before release, on Apple Silicon/macOS 14+ with the packaged app: setup permissions/local model; press/hold/release from an editor that stays focused; observe recording/transcribing/draft bubble; Send intentionally; prove no clipboard paste/history/audio retention from bridge mode; move focus while decoding, cancel/switch/sleep, test lost release/repeats and denied permissions. Check cursor edges/negative multi-display coordinates, Spaces, full-screen editor/browser, Stage Manager, click-through, screenshot focus restoration and keyboard-only Esc. Also exercise Intel/macOS 13+ keyboard flow and universal focus helper; voice must report unsupported there, not use a fallback recognizer.

Run isolated real Claude subscription conversations for goal-context teaching, one unaided review and globally permitted subsequent implementation, locked refusal, optional course, audited project suggestion and sourced/silent Wizard behavior. Observe actual app/tool outputs; label reviewer advice qualitative, not learning efficacy. Record selectors/provider provenance without account data. Signing/notarization/Gatekeeper/launch-at-login/TCC checks are separate packaging evidence; current configuration is ad-hoc and not notarized (`electron-builder.yml:mac`).

## 10. Risks and Unknowns

### Risks with decisions

- **Permission widening through “zones are just folders.”** No zone root is a source root. Grants are explicit, temporary and read-only; external new-file writes are removed. All output stays in registered zone artifacts.
- **Cross-zone stale decisions and undo.** Preserve epoch/prompt cancellation; global holds survive switches/restarts. Never restore a historical approval or skill merely because another zone opened.
- **Old learning/privacy instructions conflicting with new goal-first behavior.** Rewrite system contract, all helper context inputs and current product rules in one cutover. Old memory is background. Fresh automatic screen advice is off; migrated files-advice is not turned into screen permission.
- **Stock OSW retaining/pasting text to the wrong app.** Use controlled native bridge completion, not existing indicator decoding/paste. Explicit Send remains required. Voice unsupported/missing/permission failure stays visible; keyboard remains complete.
- **Native helper size/supply chain/TCC.** Pin OSW source/dependencies/license, isolate adapter changes, identify bridge version, validate bundled paths, compile both focus architectures. The new helper bundle needs its own permission onboarding; never promise old OSW permissions transfer.
- **Multiple files do not form a database transaction.** Serialize host writes; persist reviewed proof before note credit, holds before revocation, clear holds last. Surface IO failures. User edits are ordinary authority, not cryptographically enforced provenance.
- **Screen advice could expose private windows or unsent drafts.** Preserve explicit enable/pause and permission disclosure; block sensitive learning/voice interactions; keep pixels transient, observations private in zone history, no file fallback or repo watch.
- **Manual migration costs continuity.** Deliberately leave old repo history outside zone history; keep existing global ability. No implicit home scans or importing paths/approvals under a made-up learning goal.
- **Parallel edits can drift interfaces.** C0 owns strict shared contracts; phase barriers, disjoint ownership, one final integration owner. No aliases/protocol fallbacks to paper over disagreements.

### Unknowns — do not claim verified

1. Native bridge mode, universal focus executable and key-up/transcript protocol do not exist in this checkout. Upstream source demonstrates reuse points, not a completed integration. Exact Xcode/Swift dependency compatibility and packaged helper launch/TCC behavior need the S4 implementation and real-Mac run.
2. Existing code sets all-Spaces/full-screen flags but does not prove focus/click-through/Stage Manager behavior. The existing smoke explicitly excludes those native guarantees (`tools/desktop-smoke.mjs` report; `README.md` native limitations). `type:"panel"`, LSUIElement and transient `screen-saver` level need physical-machine evidence.
3. NSRunningApplication restoration's exact external window/caret behavior, especially with multiple windows/full-screen apps, has not been exercised here. The design avoids Accessibility text inspection; acceptance may expose an OS limitation that must be reported rather than hidden.
4. Actual Claude/OSW credential, preference, model-cache and recording storage locations were not exhaustively traced. They are not asserted to be under H, migrated, wiped, or controlled by Dum. The bridge's own temporary audio lifecycle is a new requirement; upstream standalone retention is separate.
5. No census of users' existing `.dum/` formats, corrupted hand-edited notes, old coaching modes or actual data volume was performed. The design preserves their files and global note import semantics rather than guessing a bulk migration.
6. General non-coding zone names are allowed, but the current curated tracks/gates are programming-oriented (`src/trees/`, `curriculum.tracks`). This revamp does not claim validated non-coding assessments or invent a new competency taxonomy.
7. Learning quality, review correctness and Wizard accuracy are model-dependent. `wizard.screen/compose` filter unsupported patterns; they are not a fact-checker. No tests or model/native demonstrations were run to establish quality in this design-only task.

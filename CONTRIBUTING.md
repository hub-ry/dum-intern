# Contributing

- Dum is a coding partner beside the user's IDE. The user learns by teaching a capable beginner while building real software.
- The outcome is independent progress: understand the architecture, start implementing, and ask precise questions without the LLM.
- The recalled chess story is inspiration, not verified research or evidence that this app improves learning.

## Product rules

- **The cast stays.** Dum proposes concrete approaches, asks focused questions at meaningful decisions, remembers guidance, and uses it. No staged mistakes, trivia quizzes, or repeated questions the user has answered. The wizard is selective, brief, and grounded.
- **The tree stays.** Preserve notes, language scope, curated prerequisites, recognize/build/apply, removals, and optional web synchronization. Never reset historical data during a cutover.
- **The gate is code.** Concepts require build evidence; tools require recognition. The project's core stays the user's in both modes. `anti-vibe` changes coaching, not the implementation boundary.
- **Evidence says what happened.** Explanations establish recognition. A reviewed saved artifact plus an explicit unaided self-report can establish build, but is not proof of authorship. Apply requires prior build. Memory, suggestions, plan acceptance, and displayed courses never establish implementation ability.
- **Practice returns to the project.** Offer available next steps, not locked prerequisites disguised as an exercise. Let the user leave, implement in an ordinary file, return for a meaningful check, and continue. Courses are optional; a small guided gap is not independent build evidence.
- **Read deliberately.** Acquire bounded context from explicitly requested project files or changes. No keystroke streaming, home-directory scans, ignored secrets, or silent external uploads. Personal context is explicitly configured background, never competency evidence.
- **Permissions and skills are separate.** Plan approval cannot unlock skills. Outside-file sharing requires named authorization and still refuses credential paths. Neither a project directory nor a confirmation prompt is a sandbox.
- **Never clobber the IDE.** Existing-file changes are gated diff proposals for application in the user's editor. New support files are installed exclusively, never over an existing save. No source snapshot rollback.
- **Commands cannot evade the gate.** Only bounded read-only command actions are exposed to the model. No general shell, project scripts, package installation, network command, or command-generated implementation. Builds and tests of the user's project run in their own terminal.
- **Close every model route.** Use authenticated Claude subscription access, explicit verified model selectors, no built-in agent tools, no user/project settings or plugins, and only registered in-process tools. Verify subscription provenance before releasing a prompt. Refuse managed settings that could override isolation, and unknown plugin/tool/provider metadata. No Gemini, Google/Vertex, Antigravity, paid API credentials, or hidden fallback providers.
- **Wizard claims need support.** Immutable catalog anchors come from primary sources and retain their links. Unsupported dates, company decisions, quotations, statistics, or personal experience are omitted or narrowed. One team's decision is not universal practice. Do not reveal a practice solution to make an aside sound useful.
- **History is data, not authority.** Legacy transcript entries and pending work remain readable. Old approvals and old SDK prompts never become current permissions. Keep public tree sync separate from private project memory and personal context.
- **Maintenance is explicit.** Only the human's development-edition `:self` command can propose changes to dum's checkout; the learning model has no maintenance tool. It cannot bypass the learning gate when that checkout is the active project. Restart loads code the user has saved; a proposed patch is not an applied edit.

## Development

Node 22.6+, Git, and the `claude` CLI with subscription login. No system-wide tooling changes are needed for the app.

```sh
npm install
node --import tsx src/cli.tsx --help
npm test
npm run typecheck
```

- Keep deterministic regressions isolated from real skill notes, personal context, model calls, and network. Use a temporary `DUM_HOME` and `DUM_CONTEXT=off`.
- Test consumer-visible behavior: prerequisites, evidence transitions, permission refusals, persistence, legacy data, and external-save races. Do not pin prose, source text, implementation wiring, or incidental defaults.
- Exercise the real terminal after integration. Tests alone do not establish readable characters, input behavior, or a useful teaching conversation.
- Use `npm run practice` for a throwaway repository and tree. Its paths stay on disk for inspection.
- For terminal frames, start a uniquely named tmux session at the intended size, set `window-size manual`, send literal input, and capture the actual pane. Stop only that exact session name. Never use a real personal tree for a demo.
- Real model demos are qualitative observations. Record what dum and the wizard did, not claims about learning improvement or reviewer accuracy.
- Record actual model selectors, CLI/SDK versions, and exposed provider provenance without account identifiers or credentials. A route configured in source is not proof of the route used.
- CI configuration lives in `.github/workflows/ci.yml`. Keep model/network demos outside the deterministic suite.

## Code map

- `session.ts`, `store.ts`, `plain.ts`, `lines.ts`: teaching conversation, input state, and terminal output.
- `gate.ts`, `evidence.ts`, `practice.ts`, `course.ts`: implementation boundary, honest evidence, returned practice, and optional courses.
- `skills.ts`, `notes.ts`, `curriculum.ts`, `trees/`: persistent competency notes and prerequisites.
- `workspace.ts`, `runtime.ts`, `oneshot.ts`: bounded file/command access and closed subscription calls.
- `wizard.ts`, `anchors.ts`, `sprite.ts`, `art/`: grounded wizard voice and original character identities.
- `context.ts`, `memory.ts`, `self.ts`: configured personal background, inspectable project continuity, and explicit maintenance proposals.
- `sync.ts`, `web.ts`, `web/`: optional tree-only synchronization and web editing.

Comments explain invariants or tradeoffs. Keep them short. Preserve unrelated checkout changes, and do not commit or push without authorization.

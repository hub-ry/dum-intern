# dum-intern product direction

## Current intent

- Keep the two characters in the corner. The interface should stay out of the user's way, like a desktop companion, not a tutoring dashboard.
- The user builds independently. The wizard gives selective unprompted advice using the screen by default, with a toggle to saved project files and a visible pause control. Screen access remains subject to OS permission. No passive audio capture or keystroke watching.
- When the user is satisfied, they tell dum the story of what they built and why. Dum remembers reasoning; a story alone isn't unaided build evidence.
- Dum's implementation capability follows the user's unlocked skill tree, including core algorithms. Anti-vibe accepts an approach already supplied rather than asking for it again.
- Project recommendations use project memory and configured personal context. Show estimated duration and difficulty, with substantial projects spanning several ordered skill milestones for experienced programmers learning a new language.
- Keep prerequisites, language scope, explicit unaided evidence, editor-safe proposals, and independent workspace permissions.
- Feynman Slides is not a visual reference. The user named heyclicky as the desktop-companion reference and explicitly requested default screen-aware advice; don't copy its branding or imply unrelated capabilities.
- Keep typing on demand and deliberate local voice dictation through bundled OpenSuperWhisper on supported Macs. A transcript fills a draft; it never sends automatically. Disclose native permissions, local audio retention, and the screen wizard's independent view of visible drafts.
- Show a thin bright skill-backed progress strip with newbie → intern → good → cracked, without treating conversation volume as evidence.
- Public-site behavior and routes are described in [README.md](../README.md). Non-coding subjects are an exploration of projects and evidence, not a claimed validated assessment system.

## Historical overhaul brief

The brief below records the earlier teaching-first direction. Where it conflicts with the current intent above, the current intent wins.

Overhaul dum-intern in /home/ryanhubbart/code2/dum-intern into a simple terminal coding partner that helps Ryan learn by teaching an AI intern while building real software. Implement and verify the complete experience, not just a plan or scaffold.

## Product intent

The desired relationship is a friend Ryan is responsible for helping, not an examiner checking whether he deserves AI assistance. The design prioritizes the user's independent progress over providing direct answers.

Keep the original outcome: Ryan can take the LLM away and still make progress, understand the architecture, start implementing, and ask precise questions. Teaching dum is the main interaction. The skill tree remains essential and persistent.

The core loop is: build together, encounter a meaningful decision, explain or demonstrate it to dum, see dum use that guidance, discover a genuine knowledge gap, practice what is missing, and return to the project. Avoid detached quizzes, constant permission bookkeeping, artificial mistakes, and performative stupidity.

## Dum and the wizard

Keep both characters, their distinct voices, and recognizable visual identities. Simplifying the interface must not erase the cast.

Dum is a capable beginner. It proposes concrete approaches, asks focused questions about unfamiliar reasoning, remembers useful guidance, and changes its subsequent work accordingly. It does not pretend to misunderstand random facts or ask questions the user has just answered. It can respectfully challenge an explanation when code or evidence contradicts it. Learning interactions should happen at meaningful decisions, not every keystroke.

The wizard is the experienced voice beside the user. It normally opens with an accurate real-world anchor: a context-specific established engineering practice, a documented decision by a named team, a specific product's mechanism, or relevant software history. Then it briefly connects that anchor to the current code or decision.

Ryan likes openings shaped like 'Engineers commonly do X when Y because Z', 'This product uses X to solve Y', or a verified account of how a named team approached a problem. These are shapes, not permission to invent examples or imply universal agreement.

Wizard accuracy rules:
- Never invent dates, quotations, company decisions, statistics, references, personal employment, or professional experience.
- Broad claims about normal practice must be well established and qualified by context. One team's choice is not universal practice.
- Verify specific historical, company, product, and date claims against reliable sources available to the agent. Prefer official documentation, engineering posts, release notes, papers, and source code. Attach a short source link when relying on retrieved evidence.
- Do not add a date or famous company merely for credibility. Explain the relevant mechanism or tradeoff.
- If an anchor cannot be supported, narrow it, use an established conceptual connection, or remain silent. Do not force a credibility statement every turn.
- Usually one or two short sentences. Speak selectively. Do not preempt the user's chance to teach dum or reveal the solution to a practice task. Direct help is appropriate when the user explicitly asks, with skill gates still enforced.

## Workspace and interface

Dum is a terminal agent alongside the user's own IDE, not another IDE. Ryan finds the existing UI clunky and likes omp's conversational experience. Use that as inspiration for clarity, not a mandate to copy omp or rewrite its entire platform.

The user edits real project files in any IDE. Remove the old integrated editor, permanent code pane, file-tree competition, and embedded-shell layout from the normal workflow where they become obsolete. Reuse sound state, curriculum, storage, and agent infrastructure instead of rebuilding everything indiscriminately. Choose the simplest maintainable runtime integration after inspecting what is already available.

Normal view: readable conversation with dum and the wizard, clearly attributable actions/results, and a simple input. Keep their identity/faces without recreating the three-pane workspace. Code appears as focused excerpts and diffs when relevant, never silently as a wall of generated code.

The skill tree must have a usable terminal view one command away, not be reduced to a throwaway paragraph. Show existing tracks, levels, prerequisites, known skills, and available next steps. Preserve the optional web tree and its synchronization if they remain compatible; do not remove them merely to simplify the main terminal surface.

Create a clear way for the user to share saved external-editor changes, such as asking dum to inspect a file or the current changes. Implement explicit, bounded context acquisition first; do not stream all keystrokes or indiscriminately watch the whole home directory. Handle actual file changes safely. Never restore an old snapshot over a user's concurrent external-editor save.

## Skill tree, gates, and learning

Keep the recognize/build/apply distinction, language scoping, curated prerequisites, existing notes, and user control of the tree. No reset or data loss during migration.

Keep build-level gates: explanations establish recognition, not implementation ability. Concepts require implementation evidence before AI may implement them; tools require recognition. Application reasoning does not count as apply without prior build evidence. The current project's core remains the user's to implement. Preserve or deliberately migrate existing user-selected modes without silently weakening the default gates.

Enforce the learning boundary in code, not only in prompts. AI writes, edits, and commands must not bypass it. User-editable files remain ordinary files. A saved artifact by itself is not proof of unaided authorship; record the evidence honestly and do not claim more than a demonstration or self-report supports.

When a skill is missing, offer concrete next steps and practice rather than automatically initiating a mandatory three-minute course. Examples of task shapes: learn how to X, implement function Y from scratch, create Z in C++, and a few possible projects where those skills matter. Suggestions must reflect the user's tree, missing prerequisites, working language, interests, and current project. No suggestions that assume locked prerequisites are already available.

Separate what the user knows from what they can learn next. Let them pursue a practice task outside dum, return with their implementation, receive a meaningful check, and update the tree under the same evidence rules. Suggestions and project ideas never unlock skills merely by being displayed, accepted, or explained. Preserve useful existing course functionality as an optional route where coherent; do not keep obsolete course UI as a second competing default workflow.

Personal context and memory may guide projects, examples, and continuity. They never unlock skills. Preserve existing limits, inspectability, and separation from public tree sync.

## Access and safety

The agent can read project files, propose permitted changes, and run commands, with clear user-visible actions. Computer access does not mean unrestricted home-directory access, credentials access, automatic external uploads, or unbounded shell execution.

Keep workspace/permission controls distinct from skill gates. Use the current project as the default access boundary. Outside-project access and consequential actions need explicit authorization. Do not describe post-execution rollback as a security sandbox. Protect user-owned edits and avoid races with external IDE saves.

At the start inspect git status, current instructions, and implementation. This checkout has substantial pre-existing modified/untracked work; preserve and incorporate it, never reset/stash it away or claim it as newly implemented work. Do not publish private context, credentials, sessions, or account data. Do not change global account configuration or install system-wide tools without authorization.

## Model collaboration

Use Claude Max and Codex Pro through their existing authenticated subscription routes. No Gemini at all: no Google/Gemini/Antigravity model calls, hidden helpers, judges, advisors, titles, or fallback chains. Do not assume an account plan implies an installed model is available; verify exact selectors and working routes. Do not print tokens or credential contents or add paid API credentials.

Claude is the heavy lifter. Prefer anthropic/claude-opus-5-5:high for substantial design, architecture, difficult implementation, and nuanced review. Use anthropic/claude-fable-5-1:high for suitable bounded implementation/research work when available. Use multiple Claude instances for genuinely independent slices, with explicit file ownership and contracts. Specify models explicitly on task spawns. Never silently substitute an unavailable requested model.

The main coordinator is openai-codex/gpt-6.1-sol at high effort. Bounce substantive designs and findings between Claude and Codex: Claude develops and implements; Codex examines assumptions, resolves disagreements, owns integration, and gets the final say on technical choices and acceptance. Codex cannot override Ryan's stated product intent. Record a short decision and evidence when rejecting a Claude proposal. Do not spend turns manufacturing debates over trivial changes.

These are development orchestration preferences. For the shipped app, preserve working Claude subscription support. Add or migrate Codex runtime support only where the chosen complete design needs it; never introduce Gemini support or require paid API keys.

## Execution and acceptance

First read the actual code and current user work. Have Claude investigate the teaching loop/state/gates and the terminal/runtime integration as independent slices; Codex chooses a coherent design after reviewing their evidence. Write a concise implementation plan and shared interfaces before parallel editing. Ask Ryan only for material product tradeoffs not settled here or answerable from the repository.

Implement the complete cutover. Update affected commands, state transitions, callers, tests, docs, and entrypoints; remove genuinely obsolete code and tests. No stubs, fake backends, mocked production behavior, or permanent duplicate legacy paths. Preserve historical user data and provide safe migration where formats change.

Exercise the real CLI/TUI and external-editor workflow with an isolated skill tree, scratch repo, and no private personal context. Verify the characters, focused code/diffs, tree view, saved-edit inspection, generated practice suggestions, prerequisite/evidence boundaries, persistence/resume, and refusal of unauthorized AI implementation. Include external-editor concurrent-save coverage for any file mutation/rollback path retained. Use actual model calls for teaching/wizard behavior; label qualitative observations honestly and do not claim improved learning from a demo.

Retain meaningful deterministic regression tests for consumer-visible behaviors and gate transitions. Run the relevant checks and final suite/typecheck after integration, not repeatedly during parallel edits. Inspect actual terminal frames and interactions rather than relying only on tests. Include sourced and unsupported wizard-claim cases and confirm unsupported specifics are omitted or visibly narrowed.

Update README and product rules to match the shipped design. Ryan prefers short, direct bullets, sparse headers, no horizontal separators, and no OpenSuperWhisper usage claims. Clearly document provider/login requirements, permissions, skill evidence rules, external-IDE workflow, commands, storage, and remaining verified limitations without marketing copy.

Do not commit unrelated pre-existing work or push merely because goal mode is running. If committing/pushing is authorized by the user's standing instructions, publish only task-owned, verified changes that can be separated safely; otherwise deliver the changes with exact status and evidence. Codex must review and accept the final result before delivery.

Done means the complete teaching-first, external-IDE experience works end to end, both characters and the skill tree remain, old data survives, gates remain real, the wizard's claims are grounded, and verification is reported accurately. Stop only when this objective is met or an actual unreachable prerequisite blocks progress.

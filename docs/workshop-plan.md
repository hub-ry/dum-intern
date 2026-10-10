# Dum's workshop: teach, build, flip through

Status: the first workshop backend is implemented and exercised on hub. The redesigned product site and read-only notes journal are deployed and browser-verified, in the order below. This is the current direction, replacing the terminal-first and live agent-controlled presentation proposals.

## The experience

You set your goals and ambitions, study one manageable idea, attempt it, get help for the gaps, and teach Dum what you understood. Dum then builds a small real creation using your teaching. When you return, it has a website ready: a short, manga-like walkthrough with still images, code excerpts, and the cute Dum glyph explaining its work.

You flip through at your own pace. The explanation gives more attention to concepts you taught recently and less to familiar supporting details. It works in small intervals and remembers where you stopped.

The reason to return is curiosity about what Dum made. No streak penalties, guilt, or pressure to skip learning steps.

## Learning and memory

The working learning loop is: study → attempt → inspect the gap → get targeted help → attempt again → teach Dum from memory. This follows the approach the user selected from https://www.youtube.com/watch?v=hCSHuvDejGA; the video's numerical promises are not acceptance criteria.

Study materials belong in the study zone, beside the attempt and teaching textbox. Wizard helps introduce unfamiliar ideas and repair gaps. Dum is the intern you teach and whose creations you review.

Keep a global context for goals, preferences, and useful knowledge across subjects. Each goal has its own context, source materials, attempts, teaching records, and creations. Context updates from actual interactions; the user can inspect and correct it.

The current progress view groups evidence by concept: what was introduced, attempted with help, reported as used independently, and needs revisiting. A single explanation or a completed presentation does not establish mastery. Guided lesson selection is fixed. A skill tree that helps choose the next session remains a product goal; it must not block exploration.

## The presentation: fixed pages, not a live performance

Each build produces a prepared presentation website. Panels and captions are generated once for that creation, then served as ordinary web assets. Reading, flipping, and revisiting require no live model calls.

Each page contains:

- One visual: a screenshot, diagram, result, or readable code excerpt.
- Dum's glyph and a short explanation anchored to that visual.
- Previous/next controls and a visible page position.
- Optional detail to inspect, without making the short explanation a wall of text.

Support keyboard navigation and readable mobile layouts. No automatic page advancement. Save reading position so a short visit can resume later.

Static is intentional. A playable demo may be linked when the creation supports one, but interaction inside every presentation panel is not required. Live chat, voice narration, and agent-driven browser walkthroughs are not required for the first version.

## Example issue: creature shelter

The user recently taught loops and conditions. Dum builds a tiny shelter simulation.

1. **Cover:** “I made a creature shelter with what you taught me.” Show the finished result and name the relevant lessons.
2. **Setup:** show the imports and starting data. “These helpers let me display the shelter.” Keep this brief unless imports are a recent lesson.
3. **Function:** highlight the feeding function. “I put feeding in one function so I could use it for each creature.”
4. **Loop:** show the loop beside a visual of visiting creatures. “Your loop explanation helped me visit every creature once.” Explain the iteration explicitly because it is recent teaching.
5. **Condition:** show hungry and non-hungry creatures beside the condition. “I feed this creature only when its hunger passes the threshold.” Show both outcomes.
6. **Result:** show the actual observed output. Invite the user to explain a change they want or correct Dum's understanding.

The length follows the creation; this example is not a mandatory six-page template. Explain why a step exists and what it does, rather than narrating every keystroke.

## Honest use of the user's teaching

Attach the relevant teaching record to the panels that use it. Preserve what the user actually said; do not fabricate quotes.

Distinguish concepts taught by the user from supporting machinery supplied by the agent. Do not claim the user taught imports, rendering, or packaging just because the finished project needs them.

The model already has knowledge. “Dum learned this” means its persistent instructions and project choices now use the user's guidance, not that the underlying model was retrained.

Do not manufacture confusion or mistakes. If teaching is incomplete or contradictory, ask a focused question or state the assumption used. A polished creation alone is not evidence that the learner understands the concept.

## Building and hosting on hub

Hub owns the persistent records and build jobs, so the laptop can close without stopping a build. Start with an explicit “Make something with this” action; add a user-selected daily or interval schedule after the end-to-end path works.

For each job:

1. Snapshot the selected goal context and teaching records.
2. Build one bounded creation in an isolated workspace without hub credentials or unrelated project access.
3. Run it and exercise the behavior being presented.
4. Capture actual screenshots/results and matching code excerpts. Keep diagrams clearly distinguishable from observed output.
5. Generate the fixed panels and narration, emphasizing recent teaching.
6. Publish a versioned presentation at a stable link and mark it ready only after verification.

If a build fails, retain a clear failure state; do not publish fabricated results as a finished creation. Revisions get their own versions so links and feedback still refer to the work originally shown.

A reusable publishing skill can instruct the agent how to build, verify, capture, and publish. The skill does not replace the runtime, isolation, or web server.

Serve the workshop through a host address reachable from the user's device, initially over the existing private network. A localhost address on hub is not a usable laptop link. Keep personal teaching records private. Serve generated artifacts separately from privileged workshop services; artifacts must not inherit authenticated access to context, credentials, or other builds.

## Visual direction

Preserve Dum's existing glyph character. Draw inspiration from Nothing's Glyph toys: https://playground.nothing.tech/toys. Use dot-matrix personality, restrained animation, and the existing glass/pill language where it fits. Body text, controls, and code must remain readable.

Custom glyphs remain a product goal. A glyph editor is not needed to validate the first presentation. Wizard and Dum must be distinguishable when they speak.

## First complete version

One goal about loops and conditions, source material available in the study zone, a teaching textbox, one real generated creation, and its prepared flip-through presentation hosted on hub. Persist the teaching and reading position. Let the user submit a correction and produce a revised creation and presentation.

Begin with one manually authored presentation to validate the reading experience, then automate generation using the same panel format. Do not confuse the UI demo with proof that the background build pipeline works.

Acceptance:

- The user can study, attempt, and teach without hunting for external material.
- After teaching, a real build can complete while the user's browser is closed.
- Its website shows verified output and accurate excerpts from that build.
- Recent concepts receive explicit explanations tied to actual teaching records.
- The user can flip backward/forward and resume at the saved panel.
- Flipping through the prepared presentation works without an active model session.
- A correction can lead to a revised artifact without overwriting the original.

## Implemented architecture

Node 24 and TypeScript run a persistent, private workshop process. Atomic local records hold goals, context, attempts, teachings, schedules, jobs, and reader positions. The initial guided materials cover loops, conditions, and their combination; this is not an all-subject curriculum.

The authenticated Claude Code CLI generates one bounded HTML/JavaScript creation with tools disabled. Fable medium is the current generation default. A separate, offline Docker/Playwright verifier executes the source and checks declared interactions, exact outputs, and captured screenshots before publishing it. No generated JavaScript runs on the host.

The private UI/API and artifacts use separate origins, ports 8770 and 8771. Authentication is required off loopback; artifact links are private-network-only, not public-authenticated links. The manga reader needs no active model session. A job-specific fragment restores the correct goal, version, and saved page.

Real browser verification completed an original shelter creation and a corrected `>= 5` revision. The verifier also rejected a revision whose declared output disagreed with the real demo. Original artifacts, context, history, and reading position survived service restart.

## Delivery order and public learning log

Finish and exercise the backend before redesigning or deploying dumintern.com. Keep the site's Celeste-inspired visual direction; remove the obsolete desktop-install claims and the promised demo video.

After the product-site design is complete, publish notes.ryhub.dev through Cloudflare Tunnel. This is a public, read-only record of learning, inspired by Feynman Slides. Only authenticated Dum publication can create or revise entries; visitors get no editor. Private context is not published by default.

Use deliberately simple HTML and CSS: dates, topics, notes, and links to actual creations. No invented learning activity, promotional filler, or unnecessary decoration. Less is more.

The deployed journal uses plain topic indexes and prepared pages with native Previous/Next links. Its only write path is the authenticated private publication API/CLI. Public visitors have no editor or mutation API. A factual three-page design journal records these decisions without claiming learner achievements. Create/revise/list, immutable source revisions, public read-only behavior, and mobile reading have been exercised.

GPT-6.1 Sol at high reasoning owns vision, system design, and UX decisions. Claude Fable at medium effort writes implementation code; Claude Opus 5.5 at low effort handles automation. Report actual returned model identities and available usage at milestones; do not silently substitute models or equate list-price accounting with subscription quota.

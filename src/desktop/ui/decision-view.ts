// The delegation loop in Chat: goal alignment, your outcome, the Wizard's options, the ready handoff,
// Do this, and the result with its diffs and Revert. Choosing, revising, editing and reviewing write no
// source file; Do this is the one explicit command (docs/circle-design.md §3, §4).

import type { Snapshot } from "../protocol.ts";
import type {
  AlignmentAttempt, ContextRef, DecisionView, DelegationOption, DirectionOption, DirectionView, HandoffView,
} from "../../delegation-types.ts";
import type { SkillRef, ZoneId } from "../../zone-types.ts";
import { chip, h, icon, skillName, type Client, type Tone } from "./dom.ts";
import { portrait } from "./sprites.ts";
import { diffBody, revertButton } from "./change-view.ts";
import { zonePath } from "./zones.ts";

/** What the cards need from the window around them. */
export type DecisionHooks = {
  /** Writes pending keystrokes to main, so Do this names the draft revision it consumes. */
  flushDraft(): Promise<void>;
  focusDraft(): void;
  /** Alignment or a decision needs a model and none is set up: open Agent setup. */
  needsAgent(): void;
};

/** An inner form: at most one is open, and Esc closes it first. */
type Form =
  | { kind: "outcome" }
  | { kind: "accept"; zoneId: ZoneId; optionId: string | null }
  | { kind: "handoff-edit"; handoffId: string }
  | { kind: "review"; handoffId: string };

const ELIGIBILITY: Record<DelegationOption["eligibility"], { label: string; tone: Tone }> = {
  "can-delegate": { label: "Can delegate now", tone: "ok" },
  "learn-first": { label: "Learn first", tone: "warn" },
  "needs-detail": { label: "Needs a detail", tone: "info" },
};

const HANDOFF_STATE: Record<HandoffView["head"]["state"], { label: string; tone: Tone }> = {
  ready: { label: "ready", tone: "info" },
  running: { label: "running", tone: "info" },
  done: { label: "done, awaiting your review", tone: "ok" },
  blocked: { label: "blocked", tone: "bad" },
  failed: { label: "failed", tone: "bad" },
  cancelled: { label: "cancelled", tone: "muted" },
  interrupted: { label: "interrupted", tone: "warn" },
  dismissed: { label: "dismissed", tone: "muted" },
};

const skillList = (skills: readonly SkillRef[]) => skills.map(skillName).join(", ");

/** "Based on …": the host-issued refs a card cites, by label. A ref the card doesn't carry is shown as missing. */
function basedOn(ids: readonly string[], refs: readonly ContextRef[]): HTMLElement | null {
  if (!ids.length) return null;
  const labels = ids.map((id) => {
    const ref = refs.find((r) => r.id === id);
    return ref ? `${ref.label} (${ref.kind})` : "a source no longer available";
  });
  return h("p", { class: "based-on" }, h("span", { class: "muted" }, "Based on "), labels.join(" · "));
}

function field(label: string, text: string): HTMLElement {
  return h("div", { class: "card-field" }, h("div", { class: "label" }, label), h("div", { class: "card-text" }, text));
}

function speaker(who: "dum" | "wizard", label: string, ...body: (Node | null)[]): HTMLElement {
  return h("div", { class: `speech ${who === "wizard" ? "quip" : "say"}` }, portrait(who), h("div", { class: "speech-body" }, h("div", { class: "speaker" }, label), ...body));
}

const textArea = (label: string, value: string, focus: string, rows = 2) => {
  const el = h("textarea", { class: "input", rows: String(rows), "aria-label": label, "data-focus": focus, required: true });
  el.value = value;
  return el;
};

export class DecisionCards {
  readonly el = h("section", { class: "decisions", "aria-label": "Alignment, options and handoff" });
  /** Alignment of zones you created or re-goaled without entering them, each labeled with its zone. */
  private others = new Map<ZoneId, DirectionView>();
  private form: Form | null = null;
  private outcome = "";
  /** Zones whose alignment start is in flight: reflection and questions are being composed. */
  private starting = new Set<ZoneId>();
  private key = "";

  constructor(private client: Client, private hooks: DecisionHooks) {}

  /**
   * A zone's alignment came back. `fresh` is a create or goal edit: its pending attempt starts at once,
   * because that edit is the user asking to align. Another zone's shows as its own labeled card.
   */
  aligned(view: DirectionView, fresh = false) {
    if (view.zoneId === this.client.snap?.activeZone?.id || view.status === "aligned") this.others.delete(view.zoneId);
    else this.others.set(view.zoneId, view);
    this.redraw();
    if (fresh && view.status === "aligning" && view.attempt?.phase === "reflect" && !view.attempt.reflection) void this.start(view);
  }

  private async start(view: DirectionView) {
    this.starting.add(view.zoneId);
    this.redraw();
    try {
      const r = await this.client.call({ type: "alignment-step", binding: view.binding, action: "start" });
      if (r.ok && r.direction) this.aligned(r.direction);
    } finally {
      this.starting.delete(view.zoneId);
      this.redraw();
    }
  }

  /** Help me decide: opens the outcome editor, starting from the last outcome. */
  decide() {
    this.open({ kind: "outcome" });
  }

  /** Closes an open form; true when Esc had something to close. */
  escape(): boolean {
    if (!this.form) return false;
    this.form = null;
    this.redraw();
    this.el.querySelector<HTMLElement>("[data-focus='decide']")?.focus();
    return true;
  }

  update(s: Snapshot) {
    if (s.decision) this.outcome = s.decision.outcome;
    // A zone that became active shows its alignment through the snapshot.
    if (s.activeZone) this.others.delete(s.activeZone.id);
    for (const id of this.others.keys()) if (!s.zones.zones.some((z) => z.id === id && z.deletedAt === null)) this.others.delete(id);
    const key = JSON.stringify([s.activeZone?.id, s.activeZone?.goal, s.direction, s.decision, s.handoff, s.changes, s.draft.text.trim() !== "", !!s.binding, s.agent.chosen !== null, [...this.others.values()], [...this.starting], this.form]);
    if (key === this.key) return;
    this.key = key;
    const inside = this.el.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    this.draw(s);
    if (inside) this.el.querySelector<HTMLElement>(`[data-focus="${inside}"]`)?.focus();
  }

  private redraw() {
    this.key = "";
    if (this.client.snap) this.update(this.client.snap);
  }

  private open(form: Form) {
    this.form = form;
    this.redraw();
    this.el.querySelector<HTMLElement>(".card-form textarea, .card-form input")?.focus();
  }

  private draw(s: Snapshot) {
    const parts: (HTMLElement | null)[] = [];
    for (const view of this.others.values()) parts.push(this.alignment(s, view, false));
    if (s.activeZone) {
      if (s.direction && (s.direction.status === "aligning" || s.direction.status === "needs-backend")) parts.push(this.alignment(s, s.direction, true));
      if (this.form?.kind === "outcome") parts.push(this.outcomeForm(s));
      if (s.decision) parts.push(this.decision(s, s.decision));
      if (s.handoff && s.handoff.head.state !== "dismissed") parts.push(this.handoff(s, s.handoff));
    }
    this.el.replaceChildren(...parts.filter((p) => p !== null));
  }

  // -- goal alignment ---------------------------------------------------------

  private alignment(s: Snapshot, view: DirectionView, active: boolean): HTMLElement {
    const zone = s.zones.zones.find((z) => z.id === view.zoneId);
    const title = active ? "Goal alignment" : `Goal alignment for ${zonePath(s.zones, view.zoneId) || "another goal"}`;
    const card = h("article", { class: "card alignment", "aria-label": title }, h("div", { class: "card-head" }, icon("boundary"), h("span", {}, title), active ? null : chip("not the goal you're in", "muted")));
    if (zone) card.append(field("Your goal", zone.goal));
    const step = (action: "start" | "revise" | "defer") => async () => {
      const r = await this.client.call({ type: "alignment-step", binding: view.binding, action });
      if (r.ok && r.direction) this.aligned(r.direction);
    };
    if (view.status === "needs-backend") {
      card.append(
        h("p", { class: "hint" }, "Alignment waits for a model. Your goal is saved, and alignment picks up here once Dum is powered."),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary", onclick: () => this.hooks.needsAgent() }, "Who powers Dum?"), h("button", { type: "button", class: "btn ghost", onclick: step("defer") }, "Not now")),
      );
      return card;
    }
    const attempt = view.attempt;
    if (!attempt || !attempt.reflection) {
      card.append(
        this.starting.has(view.zoneId)
          ? h("p", { class: "muted", role: "status" }, "Dum is reading your goal…")
          : h("p", { class: "hint" }, "Dum reflects your goal back, asks at most two questions that change the plan, then offers directions to choose from."),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn primary", disabled: this.starting.has(view.zoneId), onclick: () => void this.start(view) }, "Start alignment"),
          h("button", { type: "button", class: "btn ghost", onclick: step("defer") }, "Not now"),
        ),
      );
      return card;
    }
    card.append(speaker("dum", "Dum", h("p", { class: "muted" }, "Here's what I think you want to become able to do:"), h("p", {}, attempt.reflection)));
    for (const q of attempt.questions) card.append(this.question(view, q));
    if (attempt.options.length) {
      card.append(
        speaker("wizard", "Wizard", h("p", { class: "muted" }, "Directions to choose from. Choosing stores intent only; nothing is written."), h("ol", { class: "options" }, ...attempt.options.map((o) => this.directionOption(view, attempt, o)))),
      );
    }
    const form = this.form;
    if (form?.kind === "accept" && form.zoneId === view.zoneId) card.append(this.acceptForm(view, attempt, form.optionId));
    card.append(
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn", "data-focus": `own-${view.zoneId}`, onclick: () => this.open({ kind: "accept", zoneId: view.zoneId, optionId: null }) }, "Use my own direction"),
        h("button", { type: "button", class: "btn ghost", onclick: step("revise") }, "Revise"),
        h("button", { type: "button", class: "btn ghost", onclick: step("defer") }, "Not now"),
      ),
    );
    return card;
  }

  private question(view: DirectionView, q: AlignmentAttempt["questions"][number]): HTMLElement {
    const box = h("div", { class: "question-card" }, h("p", {}, q.text), h("p", { class: "why" }, `Why it matters: ${q.changesPlan}`));
    if (q.answer !== null) {
      box.append(h("p", { class: "user-text" }, q.answer));
      return box;
    }
    const answer = h("input", { class: "input", type: "text", "aria-label": `Answer: ${q.text}`, "data-focus": `answer-${q.id}` });
    const form = h("form", { class: "inline-form" }, answer, h("button", { type: "submit", class: "btn" }, "Answer"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = answer.value.trim();
      if (!text) return answer.focus();
      const r = await this.client.call({ type: "alignment-step", binding: view.binding, action: "answer", questionId: q.id, text });
      if (r.ok && r.direction) this.aligned(r.direction);
    });
    box.append(form);
    return box;
  }

  private directionOption(view: DirectionView, attempt: AlignmentAttempt, o: DirectionOption): HTMLElement {
    return h(
      "li",
      { class: "option" },
      h("div", { class: "option-head" }, h("strong", {}, o.title), chip(o.kind === "project" ? "learning project" : "decision", o.kind === "project" ? "warn" : "info")),
      o.builds.length ? h("p", {}, h("span", { class: "muted" }, "Builds "), skillList(o.builds)) : null,
      h("p", {}, h("span", { class: "muted" }, "Why it advances your goal: "), o.advancesGoal),
      h("p", {}, h("span", { class: "muted" }, "Tradeoff: "), o.tradeoff),
      basedOn(o.contextIds, attempt.context),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary small", "data-focus": `use-${o.id}`, onclick: () => this.open({ kind: "accept", zoneId: view.zoneId, optionId: o.id }) }, "Use this direction")),
    );
  }

  /** Approve the edited direction: what you'll be able to do, how you'll judge it, and what you accept as given. */
  private acceptForm(view: DirectionView, attempt: AlignmentAttempt, optionId: string | null): HTMLElement {
    const option = attempt.options.find((o) => o.id === optionId) ?? null;
    const ability = textArea("What you'll be able to do", attempt.reflection, "ability");
    const review = textArea("How you'll know it worked", "", "criterion");
    const assumptions = textArea("Assumptions you accept, one per line", "", "assumptions", 2);
    assumptions.required = false;
    const own = option ? null : {
      title: h("input", { class: "input", type: "text", maxlength: "160", required: true, "aria-label": "Your direction", "data-focus": "own-title" }),
      why: textArea("Why it advances your goal", "", "own-why"),
      tradeoff: textArea("What it costs or risks", "", "own-tradeoff"),
      kind: h("select", { class: "input", "aria-label": "It is a", "data-focus": "own-kind" }, h("option", { value: "project" }, "learning project"), h("option", { value: "decision" }, "decision")),
    };
    const form = h(
      "form",
      { class: "card-form", "aria-label": option ? `Use ${option.title}` : "Use my own direction" },
      h("h4", {}, option ? `Use “${option.title}”` : "Your own direction, in your words"),
      ...(own
        ? [h("label", { class: "field" }, h("span", {}, "Direction"), own.title), h("label", { class: "field" }, h("span", {}, "It is a"), own.kind), h("label", { class: "field" }, h("span", {}, "Why it advances your goal"), own.why), h("label", { class: "field" }, h("span", {}, "Tradeoff"), own.tradeoff)]
        : []),
      h("label", { class: "field" }, h("span", {}, "What you'll be able to do"), ability),
      h("label", { class: "field" }, h("span", {}, "How you'll know it worked"), review),
      h("label", { class: "field" }, h("span", {}, "Assumptions you accept (optional, one per line)"), assumptions),
      h("p", { class: "hint" }, "This agrees a direction for the goal. It is not a schedule and gives Dum no permission to write."),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, "Agree this direction"), h("button", { type: "button", class: "btn ghost", onclick: () => this.escape() }, "Cancel")),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const el of [own?.title, own?.why, own?.tradeoff, ability, review]) if (el && !el.value.trim()) return el.focus();
      const base = {
        binding: view.binding,
        ability: ability.value.trim(),
        reviewCriterion: review.value.trim(),
        assumptions: assumptions.value.split("\n").map((a) => a.trim()).filter(Boolean),
      };
      const r = own
        ? await this.client.call({
          type: "alignment-accept", ...base, choiceId: null,
          ownDirection: { id: crypto.randomUUID(), kind: own.kind.value === "decision" ? "decision" : "project", title: own.title.value.trim(), builds: [], advancesGoal: own.why.value.trim(), contextIds: [], tradeoff: own.tradeoff.value.trim() },
        })
        : await this.client.call({ type: "alignment-accept", ...base, choiceId: optionId });
      if (!r.ok) return;
      this.form = null;
      if (r.direction) this.aligned(r.direction);
      else this.redraw();
    });
    return form;
  }

  // -- your outcome and the Wizard's options ----------------------------------------

  /** Revise on a decision card: the outcome editor, starting from the last outcome. */
  private outcomeForm(s: Snapshot): HTMLElement {
    const input = textArea("The outcome you need next", this.outcome || s.draft.text.trim(), "outcome");
    const form = h(
      "form",
      { class: "card-form", "aria-label": "Your outcome" },
      h("label", { class: "field" }, h("span", {}, "What do you need done next?"), input),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, "Help me decide"), h("button", { type: "button", class: "btn ghost", onclick: () => this.escape() }, "Cancel")),
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const outcome = input.value.trim();
      const binding = this.client.requestBinding();
      if (!outcome) return input.focus();
      if (!binding) return;
      if (!this.client.snap?.agent.chosen) return this.hooks.needsAgent();
      const r = await this.client.call({ type: "decision-help", binding, outcome });
      if (!r.ok) return;
      this.outcome = outcome;
      this.form = null;
      this.redraw();
    });
    return form;
  }

  private decision(s: Snapshot, d: DecisionView): HTMLElement {
    const binding = this.client.requestBinding();
    const card = h("article", { class: "card decision", "aria-label": "Options for your outcome" });
    if (d.reflection) card.append(speaker("dum", "Dum", h("p", {}, d.reflection)));
    if (d.questions.length) {
      card.append(
        h(
          "div",
          { class: "question-card" },
          ...d.questions.map((q) => h("div", {}, h("p", {}, q.text), h("p", { class: "why" }, `Why it matters: ${q.changesPlan}`))),
          h("p", { class: "hint" }, "Answer in the message box and send. Dum issues new options from your answer."),
        ),
      );
    }
    if (d.options.length) {
      card.append(speaker("wizard", "Wizard", h("ol", { class: "options" }, ...d.options.map((o) => this.delegationOption(s, d, o)))));
    }
    card.append(
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => this.decide() }, "Revise"),
        h("button", { type: "button", class: "btn ghost", onclick: () => this.hooks.focusDraft() }, "Use my own plan"),
        h("button", { type: "button", class: "btn ghost", disabled: !binding, onclick: () => binding && void this.client.call({ type: "decision-dismiss", binding, decisionId: d.id, revision: d.revision }) }, "Dismiss"),
      ),
    );
    return card;
  }

  private delegationOption(s: Snapshot, d: DecisionView, o: DelegationOption): HTMLElement {
    const binding = this.client.requestBinding();
    const tag = ELIGIBILITY[o.eligibility];
    const action =
      o.eligibility === "can-delegate"
        ? h("button", {
          type: "button", class: "btn primary small", "data-focus": `choose-${o.id}`, disabled: !binding,
          onclick: () => binding && void this.client.call({ type: "handoff-select", binding, decisionId: d.id, revision: d.revision, optionId: o.id }),
        }, "Choose")
        : o.eligibility === "learn-first"
          ? h("button", {
            type: "button", class: "btn small", disabled: !binding || !o.skills.length,
            onclick: () => {
              const skill = o.skills[0];
              const lang = skill?.lang || s.activeZone?.language || "";
              if (binding && skill) void this.client.call({ type: "command", name: "projects", argument: lang ? `${skill.name} in ${lang}` : skill.name, binding });
            },
          }, "Suggest a project to learn it")
          : h("button", { type: "button", class: "btn small", onclick: () => this.hooks.focusDraft() }, "Give this detail");
    return h(
      "li",
      { class: `option option-${o.eligibility}` },
      h("div", { class: "option-head" }, h("strong", {}, o.task), chip(tag.label, tag.tone)),
      h("p", {}, h("span", { class: "muted" }, "Expected result: "), o.expectedResult),
      h("p", {}, h("span", { class: "muted" }, "You review: "), o.review),
      o.skills.length ? h("p", {}, h("span", { class: "muted" }, "Skills: "), skillList(o.skills)) : null,
      h("p", {}, h("span", { class: "muted" }, "Why: "), o.advancesOutcome),
      h("p", {}, h("span", { class: "muted" }, "Tradeoff: "), o.tradeoff),
      o.blockers.length ? h("ul", { class: "blockers" }, ...o.blockers.map((b) => h("li", {}, icon("lock"), h("span", {}, b)))) : null,
      basedOn(o.contextIds, d.context),
      h("div", { class: "actions" }, action),
    );
  }

  // -- the handoff ---------------------------------------------------------------------

  private handoff(s: Snapshot, v: HandoffView): HTMLElement {
    const { handoff: ho, head } = v;
    const binding = this.client.requestBinding();
    const state = HANDOFF_STATE[head.state];
    const card = h(
      "article",
      { class: `card handoff handoff-${head.state}`, "aria-label": "Handoff" },
      h("div", { class: "card-head" }, icon("send"), h("span", {}, "Handoff"), chip(state.label, state.tone), v.needsRefresh && head.state === "ready" ? chip("Needs refresh", "warn") : null),
    );
    const form = this.form;
    if (form?.kind === "handoff-edit" && form.handoffId === ho.id && head.state === "ready") card.append(this.handoffEdit(v));
    else card.append(field("Task", ho.task), field("Expected result", ho.expectedResult), field("What you'll review", ho.review));
    if (ho.skills.length) card.append(h("p", {}, h("span", { class: "muted" }, "Skills: "), skillList(ho.skills)));
    const based = basedOn(ho.context.map((c) => c.id), ho.context);
    if (based) card.append(based);
    if (v.blockers.length) card.append(h("ul", { class: "blockers" }, ...v.blockers.map((b) => h("li", {}, icon("lock"), h("span", {}, b)))));
    if (head.state === "ready") {
      if (s.draft.text.trim()) card.append(h("p", { class: "hint warn-text" }, "Your message box has unsent text. Send or clear it first: Do this never sends it along."));
      card.append(
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn ghost", "data-focus": "handoff-edit", onclick: () => this.open({ kind: "handoff-edit", handoffId: ho.id }) }, icon("pencil"), "Edit"),
          v.needsRefresh
            ? h("button", {
              type: "button", class: "btn", disabled: !binding,
              // An edit of a stale handoff refreshes it: a new version bound to the current session and context.
              onclick: () => binding && void this.client.call({ type: "handoff-edit", binding, handoffId: ho.id, revision: ho.revision, patch: { task: ho.task } }),
            }, icon("refresh"), "Refresh handoff")
            : h("button", { type: "button", class: "btn primary", "data-focus": "do-this", disabled: !binding || v.blockers.length > 0, onclick: () => void this.doThis(v) }, "Do this"),
          h("button", { type: "button", class: "btn ghost", disabled: !binding, onclick: () => binding && void this.client.call({ type: "handoff-dismiss", binding, handoffId: ho.id, revision: ho.revision }) }, "Dismiss"),
        ),
      );
      return card;
    }
    if (head.state === "running") {
      card.append(h("p", { class: "muted", role: "status" }, "Dum is doing it. Stop (⌘.) cancels; changes already made stay listed with Revert."));
      return card;
    }
    if (head.result) card.append(field("What happened", head.result));
    const changes = head.changeIds.map((id) => ({ id, receipt: s.changes.find((c) => c.id === id) }));
    if (changes.length) {
      card.append(
        h(
          "ul",
          { class: "change-list" },
          ...changes.map(({ id, receipt }) =>
            h(
              "li",
              { class: "change" },
              receipt
                ? h("details", { open: receipt.diff.split("\n").length <= 30 }, h("summary", {}, icon("chevron"), h("code", {}, receipt.target), receipt.revertible ? null : chip("not revertible", "muted")), diffBody(receipt.diff))
                : h("p", { class: "muted" }, "This change's record isn't available here any more."),
              h(
                "div",
                { class: "actions" },
                revertButton(this.client, receipt, id),
                h("button", { type: "button", class: "link-btn", onclick: () => void this.client.call({ type: "open-record", record: "change", id }) }, icon("external"), h("span", {}, "open the change record")),
              ),
            ),
          ),
        ),
      );
    } else card.append(h("p", { class: "muted" }, "No file was changed."));
    if (head.reviewed) card.append(field("Your review", head.reviewed.verdict));
    else if (form?.kind === "review" && form.handoffId === ho.id) card.append(this.reviewForm(v));
    else card.append(h("div", { class: "actions" }, h("button", { type: "button", class: "btn", "data-focus": "review", disabled: !binding, onclick: () => this.open({ kind: "review", handoffId: ho.id }) }, "Reviewed…")));
    return card;
  }

  private async doThis(v: HandoffView) {
    await this.hooks.flushDraft();
    const s = this.client.snap;
    const binding = this.client.requestBinding();
    if (!s || !binding) return;
    await this.client.call({ type: "handoff-run", binding, handoffId: v.handoff.id, revision: v.handoff.revision, draftRevision: s.draft.revision });
  }

  private handoffEdit(v: HandoffView): HTMLElement {
    const ho = v.handoff;
    const task = textArea("Task", ho.task, "edit-task");
    const expected = textArea("Expected result", ho.expectedResult, "edit-expected");
    const review = textArea("What you'll review", ho.review, "edit-review");
    const form = h(
      "form",
      { class: "card-form", "aria-label": "Edit the handoff" },
      h("label", { class: "field" }, h("span", {}, "Task"), task),
      h("label", { class: "field" }, h("span", {}, "Expected result"), expected),
      h("label", { class: "field" }, h("span", {}, "What you'll review"), review),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, "Save"), h("button", { type: "button", class: "btn ghost", onclick: () => this.escape() }, "Cancel")),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const el of [task, expected, review]) if (!el.value.trim()) return el.focus();
      const patch = {
        ...(task.value.trim() !== ho.task ? { task: task.value.trim() } : {}),
        ...(expected.value.trim() !== ho.expectedResult ? { expectedResult: expected.value.trim() } : {}),
        ...(review.value.trim() !== ho.review ? { review: review.value.trim() } : {}),
      };
      const binding = this.client.requestBinding();
      if (!binding) return;
      if (Object.keys(patch).length) {
        const r = await this.client.call({ type: "handoff-edit", binding, handoffId: ho.id, revision: ho.revision, patch });
        if (!r.ok) return;
      }
      this.form = null;
      this.redraw();
    });
    return form;
  }

  private reviewForm(v: HandoffView): HTMLElement {
    const verdict = textArea("Your verdict against the expected result", "", "verdict");
    const form = h(
      "form",
      { class: "card-form", "aria-label": "Review the result" },
      h("label", { class: "field" }, h("span", {}, `Did it meet “${v.handoff.expectedResult}”?`), verdict),
      h("p", { class: "hint" }, "Your verdict is kept on the session trail. It can be that it did not advance your goal. It never counts as evidence of a skill."),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, "Save review"), h("button", { type: "button", class: "btn ghost", onclick: () => this.escape() }, "Cancel")),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = verdict.value.trim();
      const binding = this.client.requestBinding();
      if (!text) return verdict.focus();
      if (!binding) return;
      const r = await this.client.call({ type: "handoff-review", binding, handoffId: v.handoff.id, revision: v.handoff.revision, verdict: text });
      if (!r.ok) return;
      this.form = null;
      this.redraw();
    });
    return form;
  }
}

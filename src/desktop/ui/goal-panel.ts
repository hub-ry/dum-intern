// One goal's panel: its name and progress (dot-matrix cells), the step in a glass pill with "Pick … for
// me" and Skip beneath it, then the chat with Dum about it (transcript, alignment, decision and handoff
// cards, one borderless composer line). "⋯" holds editing the goal and three records.
// Chat waits until main has entered the goal; until then the panel draws from the registry.

import type { Snapshot } from "../protocol.ts";
import type { DirectionView } from "../../delegation-types.ts";
import type { ZoneId } from "../../zone-types.ts";
import { h, iconButton, plain, type Client } from "./dom.ts";
import { Composer } from "./composer.ts";
import { Transcript } from "./transcript.ts";
import { DecisionCards } from "./decision-view.ts";
import { StepPill } from "./step-pill.ts";
import { segments } from "./goals-panel.ts";

/** What More opens. */
export type MoreItem = "edit" | "inside" | "delete" | "projects" | "changes" | "memory";

const MORE: { label: string; open: MoreItem }[] = [
  { label: "Edit goal", open: "edit" },
  { label: "New goal inside", open: "inside" },
  { label: "Delete goal", open: "delete" },
  { label: "Suggested projects", open: "projects" },
  { label: "Changes", open: "changes" },
  { label: "Memory", open: "memory" },
];

export type GoalPanelHooks = {
  needsAgent(): void;
  more(item: MoreItem): void;
};

export class GoalPanel {
  readonly el: HTMLElement;
  private composer: Composer;
  private transcript: Transcript;
  private decisions: DecisionCards;
  private step: StepPill;
  private id: ZoneId | null = null;
  private shownZone: ZoneId | null | undefined;
  private forceBottom = false;
  private shownStage = "";
  private dismissedStage = "";

  private title = h("h1", { id: "goal-title", tabindex: "-1" });
  private progressText = h("span", { class: "label" });
  private progressBox = h("span", { class: "goal-progress" });
  private menu = h("ul", { class: "menu-list", role: "menu", hidden: true, "aria-label": "More" });
  private menuBtn: HTMLButtonElement;
  private gone: HTMLElement;
  private stageTitle = h("h3", {});
  private stageBody = h("pre", { class: "info-text" });
  private stageCard: HTMLElement;
  private empty = h("p", { class: "secondary chat-empty" }, "Ask Dum anything about this goal.");
  private waiting = h("p", { class: "secondary chat-empty", hidden: true, role: "status" }, "Opening this goal…");
  private scroller: HTMLElement;
  private dock: HTMLElement;

  constructor(private client: Client, hooks: GoalPanelHooks) {
    this.composer = new Composer(client, () => hooks.needsAgent());
    this.transcript = new Transcript(client);
    this.decisions = new DecisionCards(client, { flushDraft: () => this.composer.flush(), focusDraft: () => this.composer.focus(), needsAgent: () => hooks.needsAgent() });
    this.step = new StepPill(client);
    this.gone = h(
      "div",
      { class: "goal-gone", hidden: true },
      h("p", {}, "This goal is gone."),
      h("button", { type: "button", class: "text-action", onclick: () => void client.call({ type: "panel", panel: { kind: "dum" } }) }, "Your goals"),
    );
    this.stageCard = h(
      "div",
      { class: "stage-card", hidden: true, role: "region", "aria-label": "Dum's answer" },
      h("div", { class: "stage-head" }, this.stageTitle, h("span", { class: "spacer" }), iconButton("close", "Dismiss", () => {
        this.dismissedStage = this.shownStage;
        this.stageCard.hidden = true;
      }, "", "icon-btn tiny")),
      this.stageBody,
    );
    this.menuBtn = h("button", { type: "button", class: "goal-more-btn", "aria-label": "More", title: "More", "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => this.toggleMenu(this.menu.hidden) }, "⋯");
    for (const item of MORE) {
      this.menu.append(h("li", { role: "none" }, h("button", {
        type: "button", role: "menuitem", class: `menu-item${item.open === "delete" ? " danger-text" : ""}`, tabindex: "-1",
        onclick: () => {
          this.toggleMenu(false, false);
          hooks.more(item.open);
        },
      }, item.label)));
    }
    this.menu.addEventListener("keydown", (e) => {
      const items = [...this.menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
      const i = items.findIndex((b) => b === document.activeElement);
      const to = e.key === "ArrowDown" ? items[(i + 1) % items.length] : e.key === "ArrowUp" ? items[(i - 1 + items.length) % items.length] : e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : undefined;
      if (e.key === "Tab") this.toggleMenu(false, false);
      if (!to) return;
      e.preventDefault();
      to.focus();
    });
    document.addEventListener("click", (e) => {
      if (!this.menu.hidden && !this.menu.parentElement!.contains(e.target as Node)) this.toggleMenu(false, false);
    });
    this.scroller = h("div", { class: "scroller" }, this.waiting, this.stageCard, this.transcript.el, this.empty, this.decisions.el);
    this.dock = h("footer", { class: "dock" }, this.composer.el);
    this.el = h(
      "section",
      { class: "panel panel-goal", "aria-labelledby": "goal-title" },
      // The step sits on the header's dot grid, so its glass has something to show through.
      h(
        "header",
        { class: "panel-head" },
        h("div", { class: "goal-head-line" }, this.title, h("div", { class: "menu-wrap" }, this.menuBtn, this.menu)),
        h("div", { class: "goal-head-meta" }, this.progressBox, this.progressText),
        this.step.el,
      ),
      this.gone,
      h("div", { class: "chat-main" }, this.scroller, this.dock),
    );
  }

  /** Alignment of a goal created or re-goaled from here or the folder. */
  aligned(view: DirectionView, fresh: boolean) {
    this.decisions.aligned(view, fresh);
  }

  focus() {
    if (this.chatReady()) this.composer.focus();
    else this.title.focus();
  }

  stop() {
    this.composer.stop();
  }

  /** Esc closes the innermost thing in the panel; true when it closed something. */
  escape(): boolean {
    if (!this.menu.hidden) {
      this.toggleMenu(false);
      return true;
    }
    const at = document.activeElement;
    if (this.step.el.contains(at) && this.step.escape()) return true;
    if (this.decisions.el.contains(at) && this.decisions.escape()) return true;
    return false;
  }

  /** Keeps the chat's scroll while a view covers it. */
  get scrollTop(): number {
    return this.scroller.scrollTop;
  }

  set scrollTop(v: number) {
    this.scroller.scrollTop = v;
  }

  private chatReady(): boolean {
    const s = this.client.snap;
    return !!s && !!this.id && s.activeZone?.id === this.id;
  }

  private toggleMenu(open: boolean, focus = true) {
    this.menu.hidden = !open;
    this.menuBtn.setAttribute("aria-expanded", String(open));
    if (open) this.menu.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    else if (focus) this.menuBtn.focus();
  }

  /** Draws goal `id`; `chatShown` is false while a view covers the chat. */
  update(s: Snapshot, id: ZoneId, chatShown: boolean) {
    this.id = id;
    const zone = s.zones.zones.find((z) => z.id === id && z.deletedAt === null);
    const view = s.goals.find((g) => g.id === id);
    this.gone.hidden = !!zone;
    this.title.textContent = zone?.name ?? "Goal";
    this.title.title = zone?.goal ?? "";
    const done = view?.progress.done ?? 0;
    const total = view?.progress.total ?? 0;
    this.progressBox.replaceChildren(segments(done, total));
    this.progressText.textContent = view?.skippedAt ? `${done}/${total} skipped` : `${done}/${total}`;
    this.step.update(view?.step ?? null);
    this.step.el.hidden = !zone;
    // Chat: only once main has entered this goal.
    const ready = this.chatReady();
    this.waiting.hidden = ready || !zone;
    this.dock.hidden = !ready;
    this.transcript.el.hidden = !ready;
    this.decisions.el.hidden = !ready;
    this.composer.update(s);
    this.decisions.update(s);
    const zoneId = s.activeZone?.id ?? null;
    if (zoneId !== this.shownZone) {
      if (this.shownZone !== undefined) {
        this.transcript.clear();
        this.dismissedStage = "";
      }
      this.shownZone = zoneId;
      this.forceBottom = true;
    }
    const state = ready ? s.state : null;
    if (!state) {
      this.stageCard.hidden = true;
      this.empty.hidden = !ready || !!s.decision || !!s.handoff;
      return;
    }
    const stage = state.stage;
    const stageKey = stage.kind === "info" ? stage.title + "\u0000" + stage.body : "";
    // A typed :command's answer shows in Chat, unless a record view asked for it.
    if (stageKey && stageKey !== this.shownStage && chatShown) this.dismissedStage = "";
    this.shownStage = stageKey;
    this.stageCard.hidden = !stageKey || stageKey === this.dismissedStage || !chatShown;
    if (stage.kind === "info") {
      this.stageTitle.textContent = stage.title;
      this.stageBody.textContent = plain(stage.body);
    }
    if (!chatShown) return;
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48;
    this.transcript.update(state.transcript, state.prompt, s.changes);
    this.empty.hidden = state.transcript.length > 0 || !!s.decision || !!s.handoff;
    if (atBottom || this.forceBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
    this.forceBottom = false;
  }
}

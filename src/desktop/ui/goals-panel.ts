// Dum's panel: the global goals folder you prompt. One borderless line takes what you want to work
// toward (Return adds it, opens it and pins it to the column). Below it, every goal as text: its name,
// and its one next step beneath. The name opens the goal; "⋯" beside it reveals Pin and Skip.

import type { Snapshot } from "../protocol.ts";
import type { DirectionView } from "../../delegation-types.ts";
import type { ZoneId } from "../../zone-types.ts";
import { h, type Client } from "./dom.ts";
import { goalDepth, goalOrder, goalTitle } from "./zones.ts";

/** Progress as a row of dot-matrix cells: done cells lit, the rest dim. At most ten cells; the label says it exactly. */
export function segments(done: number, total: number): HTMLElement {
  const cells = Math.min(10, total);
  const lit = total ? Math.round((done / total) * cells) : 0;
  return h(
    "span",
    { class: "segments", role: "img", "aria-label": `${done} of ${total} skills` },
    ...Array.from({ length: cells }, (_, i) => h("i", { class: i < lit ? "on" : null })),
  );
}

type Open = { id: ZoneId; confirm: boolean };

export class GoalsPanel {
  readonly el: HTMLElement;
  private input = h("input", { class: "line-input goal-prompt", type: "text", maxlength: "2000", placeholder: "What do you want to work toward?", "aria-label": "What do you want to work toward?" });
  private list = h("ul", { class: "goal-list", "aria-label": "Your goals" });
  /** The goal whose "⋯" is open, and whether it is asking "Skip this goal?". */
  private open: Open | null = null;
  private sending = false;
  private key = "";

  /** `aligned`: a new goal's alignment came back; it starts at once. */
  constructor(private client: Client, private aligned: (view: DirectionView) => void) {
    const form = h("form", { class: "goal-prompt-form" }, this.input);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.create();
    });
    this.el = h(
      "section",
      { class: "panel panel-dum", "aria-labelledby": "goals-title" },
      h("header", { class: "panel-head" }, h("h1", { id: "goals-title", tabindex: "-1" }, "Your goals")),
      h("div", { class: "panel-body" }, form, this.list),
    );
  }

  focus() {
    this.input.focus();
  }

  /** Esc backs out of "Skip this goal?", then closes "⋯". */
  escape(): boolean {
    if (!this.open) return false;
    const id = this.open.id;
    this.open = this.open.confirm ? { id, confirm: false } : null;
    this.redraw();
    this.list.querySelector<HTMLElement>(`[data-focus="more:${id}"]`)?.focus();
    return true;
  }

  update(s: Snapshot) {
    if (this.open && !s.zones.zones.some((z) => z.id === this.open!.id && z.deletedAt === null)) this.open = null;
    const key = JSON.stringify([s.zones, s.goals, s.pinned, this.open]);
    if (key === this.key) return;
    this.key = key;
    const inside = this.list.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    this.draw(s);
    if (inside) this.list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(inside)}"]`)?.focus();
  }

  private redraw() {
    this.key = "";
    if (this.client.snap) this.update(this.client.snap);
  }

  private async create() {
    const text = this.input.value.trim();
    if (!text || this.sending) return;
    this.sending = true;
    try {
      const r = await this.client.call({ type: "zone-create", zone: { name: goalTitle(text), goal: text, parentId: null, language: null, focusSkills: [] }, enter: true });
      if (!r.ok) return;
      this.input.value = "";
      if (r.direction) this.aligned(r.direction);
      const id = r.direction?.zoneId ?? r.snapshot?.zones.activeZoneId;
      if (!id) return;
      await this.client.call({ type: "panel", panel: { kind: "goal", id } });
      // Three are pinned already: the goal still lives in the folder; that refusal isn't news.
      await this.client.call({ type: "goal-pin", id, pinned: true }, true);
    } finally {
      this.sending = false;
    }
  }

  private draw(s: Snapshot) {
    const goals = goalOrder(s.zones);
    if (!goals.length) {
      this.list.replaceChildren(h("li", { class: "secondary goal-empty" }, "No goals yet."));
      return;
    }
    const text = (focus: string, label: string, onclick: () => void, cls = "") =>
      h("button", { type: "button", class: `text-action${cls}`, "data-focus": focus, onclick }, label);
    this.list.replaceChildren(
      ...goals.map((z) => {
        const view = s.goals.find((g) => g.id === z.id);
        const pinned = s.pinned.includes(z.id);
        const active = z.id === s.zones.activeZoneId;
        const skipped = !!view?.skippedAt;
        const open = this.open?.id === z.id ? this.open : null;
        const actions = !open
          ? null
          : open.confirm
            ? h(
                "div",
                { class: "goal-more", role: "group", "aria-label": `Skip ${z.name}` },
                h("span", { class: "secondary" }, "Skip this goal? Its skills count as trusted."),
                text(`confirm:${z.id}`, "Skip", () => void this.skip(z.id)),
                text(`cancel:${z.id}`, "Cancel", () => this.escape(), " quiet"),
              )
            : h(
                "div",
                { class: "goal-more", role: "group", "aria-label": `${z.name} options` },
                text(`pin:${z.id}`, pinned ? "Unpin" : "Pin to the column", () => void this.client.call({ type: "goal-pin", id: z.id, pinned: !pinned })),
                skipped
                  ? text(`unskip:${z.id}`, "Undo skip", () => void this.client.call({ type: "goal-skip", id: z.id, skip: false }))
                  : text(`skip:${z.id}`, "Skip goal", () => {
                      this.open = { id: z.id, confirm: true };
                      this.redraw();
                      this.list.querySelector<HTMLElement>(`[data-focus="confirm:${z.id}"]`)?.focus();
                    }),
              );
        const step = skipped ? "Skipped, trusted." : view?.step?.text ?? "";
        const row = h(
          "li",
          { class: `goal-row${active ? " active" : ""}${skipped ? " skipped" : ""}`, style: `--depth:${goalDepth(s.zones, z)}` },
          h(
            "button",
            { type: "button", class: "goal-open", "data-focus": `open:${z.id}`, "aria-current": active ? "true" : null, title: z.goal, onclick: () => void this.client.call({ type: "panel", panel: { kind: "goal", id: z.id } }) },
            h("span", { class: "goal-name" }, z.name, pinned ? h("span", { class: "visually-hidden" }, ", pinned") : null),
            step ? h("span", { class: "goal-step" }, step) : null,
          ),
          h("button", {
            type: "button", class: "goal-more-btn", "data-focus": `more:${z.id}`, "aria-label": `${z.name} options`, "aria-expanded": String(!!open), title: "More",
            onclick: () => {
              this.open = open ? null : { id: z.id, confirm: false };
              this.redraw();
            },
          }, "⋯"),
          actions,
        );
        return row;
      }),
    );
  }

  private async skip(id: ZoneId) {
    const r = await this.client.call({ type: "goal-skip", id, skip: true });
    if (r.ok) this.open = null;
    this.redraw();
    this.list.querySelector<HTMLElement>(`[data-focus="more:${id}"]`)?.focus();
  }
}

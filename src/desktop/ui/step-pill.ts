// A goal's one step in its panel: the sentence in a glass pill, and beneath it "Pick … for me" (the
// panel's one filled action) and a quiet "Skip". Skip is always offered; a step past beginner level
// asks "Sure?" first, because skipping makes Dum treat the skill as known (trusted) and write it for you.

import type { StepView } from "../../step-types.ts";
import { h, skillName, type Client } from "./dom.ts";

export class StepPill {
  readonly el = h("div", { class: "step", role: "group", "aria-label": "Next step" });
  private step: StepView | null = null;
  private confirming = "";
  private busy = false;
  private key = "\u0000";

  constructor(private client: Client) {}

  update(step: StepView | null) {
    if (step?.id !== this.step?.id) this.confirming = "";
    this.step = step;
    const key = JSON.stringify([step, this.confirming, this.busy]);
    if (key === this.key) return;
    this.key = key;
    const inside = this.el.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    this.draw();
    if (inside) (this.el.querySelector<HTMLElement>(`[data-focus="${inside}"]`) ?? this.el.querySelector<HTMLElement>("button"))?.focus();
  }

  /** Esc backs out of "Sure?"; true when it had something to close. */
  escape(): boolean {
    if (!this.confirming) return false;
    this.confirming = "";
    this.redraw();
    this.el.querySelector<HTMLElement>("[data-focus='skip']")?.focus();
    return true;
  }

  private redraw() {
    this.key = "\u0000";
    this.update(this.step);
  }

  private async run(request: Parameters<Client["call"]>[0]) {
    if (this.busy) return;
    this.busy = true;
    this.redraw();
    const r = await this.client.call(request);
    this.busy = false;
    if (r.ok) this.confirming = "";
    this.redraw();
  }

  private draw() {
    const step = this.step;
    if (!step) {
      this.el.replaceChildren(h("p", { class: "secondary step-none" }, "Nothing waiting. Press ▶ in the skill tree for what's next."));
      return;
    }
    const act = (focus: string, label: string, cls: string, onclick: () => void) =>
      h("button", { type: "button", class: cls, "data-focus": focus, disabled: this.busy, onclick }, label);
    const skip = { type: "step-skip" as const, zoneId: step.zoneId, stepId: step.id };
    const actions = this.confirming === step.id
      ? h(
          "div",
          { class: "step-actions" },
          h("span", { class: "secondary" }, `Sure? Dum will treat ${step.skill ? skillName(step.skill) : "this step"} as known and write it for you.`),
          act("trust", "Trust me", "fill-pill", () => void this.run({ ...skip, confirmed: true })),
          act("cancel", "Cancel", "text-action quiet", () => this.escape()),
        )
      : h(
          "div",
          { class: "step-actions" },
          step.pick ? act("pick", step.pick.label, "fill-pill", () => void this.run({ type: "step-pick", zoneId: step.zoneId, stepId: step.id })) : null,
          act("skip", "Skip", "text-action quiet", () => {
            if (!step.confirmSkip) return void this.run({ ...skip, confirmed: false });
            this.confirming = step.id;
            this.redraw();
            this.el.querySelector<HTMLElement>("[data-focus='trust']")?.focus();
          }),
        );
    this.el.replaceChildren(h("p", { class: "glass-pill" }, h("span", { class: "pill-text" }, step.text)), actions);
  }
}

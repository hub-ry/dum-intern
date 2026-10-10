// The bubble: one sentence in a semi-transparent glass pill, with a small glass dot on the side the
// circle is on (`toward`). It only draws: no buttons, nothing focusable, click-through. `step` is the
// active goal's one step, `wizard` the Wizard jumping in (lavender, with its portrait), `reply` Dum's
// sentence (plus the Wizard's line, when it spoke, as a second pill), `voice` the dictation preview.

import type { BubbleView } from "../protocol.ts";
import { h } from "./dom.ts";
import { portrait } from "./sprites.ts";

/** A line main labels "Wizard: …" is the Wizard's; every other line is Dum's. */
const WIZARD = /^Wizard:\s*/;

function pill(text: string, who: "dum" | "wizard" | "voice", label?: string): HTMLElement {
  return h(
    "div",
    { class: `glass-pill ${who}`, "aria-label": label ?? null },
    who === "wizard" ? portrait("wizard") : null,
    h("span", { class: "pill-text" }, text),
  );
}

export function bubble() {
  const box = h("div", { class: "bubble", hidden: true, role: "status", "aria-live": "polite" });
  let timer = 0;

  const hide = () => {
    box.hidden = true;
    box.replaceChildren();
  };

  function render(view: BubbleView) {
    clearTimeout(timer);
    let pills: HTMLElement[];
    if (view.kind === "step") pills = [pill(view.step.text, "dum", `${view.step.goal}: ${view.step.text}`)];
    else if (view.kind === "wizard") pills = view.text ? [pill(view.text, "wizard", `Wizard: ${view.text}`)] : [];
    else if (view.kind === "reply") {
      const dum = view.lines.find((l) => !WIZARD.test(l));
      const wizard = view.lines.find((l) => WIZARD.test(l))?.replace(WIZARD, "");
      pills = [dum ? pill(dum, "dum") : null, wizard ? pill(wizard, "wizard", `Wizard: ${wizard}`) : null].filter((p) => p !== null);
    } else pills = view.lines.map((l) => pill(l, "voice"));
    const left = view.kind === "step" ? Infinity : view.expiresAt - Date.now();
    if (!pills.length || left <= 0) return hide();
    const toward = "toward" in view ? view.toward : undefined;
    // The first pill points at Dum with one small glass dot half over its end.
    if (toward) pills[0]!.append(h("span", { class: "glass-dot", "aria-hidden": "true" }));
    box.className = `bubble bubble-${view.kind}${toward ? ` anchored toward-${toward}` : ""}`;
    box.replaceChildren(...pills);
    box.hidden = false;
    if (left !== Infinity) timer = window.setTimeout(hide, left);
  }

  document.body.append(box);
  window.dumBubble.subscribe(render);
}

// The reply bubble near the cursor: voice status and the answer, with a small Dum or Wizard. Read-only
// and click-through; it can't invoke anything and goes away on its own.

import type { BubbleView } from "../protocol.ts";
import { h } from "./dom.ts";
import { portrait } from "./sprites.ts";

/** A line main labels "Wizard: …" is the Wizard's; every other line is Dum's. */
const WIZARD = /^Wizard:\s*/;

export function bubble() {
  const box = h("div", { class: "bubble", hidden: true, role: "status", "aria-live": "polite" });
  let timer = 0;

  function render(view: BubbleView) {
    clearTimeout(timer);
    const left = view.expiresAt - Date.now();
    if (!view.lines.length || left <= 0) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.className = `bubble bubble-${view.kind}`;
    box.replaceChildren(
      ...view.lines.map((line) => {
        const wizard = WIZARD.test(line);
        return h("div", { class: `bubble-line ${wizard ? "wizard" : "dum"}` }, portrait(wizard ? "wizard" : "dum"), h("span", { class: "bubble-text" }, line.replace(WIZARD, "")));
      }),
    );
    box.hidden = false;
    timer = window.setTimeout(() => {
      box.hidden = true;
      box.replaceChildren();
    }, left);
  }

  document.body.append(box);
  window.dumBubble.subscribe(render);
}

// The floating pair: Dum and the wizard, a speech bubble, a dot when something waits on you.

import type { Snapshot } from "../protocol.ts";
import { bounds } from "../../art-parser.ts";
import { BUBBLE_HEIGHT, GAP, PAD, PIXEL } from "../companion-layout.ts";
import { h } from "./dom.ts";
import { Creature, SPRITES, type DumState, type WizardState } from "./sprites.ts";

/** How long a new line stays up when nothing is waiting on you. */
const SPEECH_MS = 8000;
/** Pointer travel that turns a press into a drag rather than a click. */
const DRAG_THRESHOLD = 4;

export function companion() {
  const root = document.documentElement.style;
  root.setProperty("--pixel", `${PIXEL}px`);
  root.setProperty("--gap", `${GAP}px`);
  root.setProperty("--pad", `${PAD}px`);
  root.setProperty("--bubble-height", `${BUBBLE_HEIGHT}px`);
  root.setProperty("--sprites-height", `${Math.max(bounds(SPRITES.dum).rows, bounds(SPRITES.wizard).rows) * PIXEL}px`);

  const dum = new Creature("dum", PIXEL);
  const wizard = new Creature("wizard", PIXEL);
  const bubbleText = h("span", { class: "bubble-text" });
  const bubble = h("div", { class: "bubble", role: "status", "aria-live": "polite", hidden: true }, bubbleText);
  const badge = h("span", { class: "badge", hidden: true });
  const pair = h("button", { type: "button", class: "pair", "aria-label": "Open dum" }, dum.canvas, wizard.canvas, badge);
  document.body.append(h("main", { class: "companion" }, bubble, pair));

  // Click and drag share one press. Movement past the threshold makes it a drag and swallows the click.
  let press: { x: number; y: number; moved: boolean; sentX: number; sentY: number } | null = null;
  let dragged = false;
  let frame = 0;
  let pending = { x: 0, y: 0 };
  const flush = () => {
    frame = 0;
    if (!press) return;
    const dx = Math.round(pending.x - press.sentX);
    const dy = Math.round(pending.y - press.sentY);
    if (!dx && !dy) return;
    press.sentX += dx;
    press.sentY += dy;
    void window.dum.invoke({ type: "move-companion", dx, dy });
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragged = false;
    press = { x: e.screenX, y: e.screenY, moved: false, sentX: e.screenX, sentY: e.screenY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!press) return;
    if (!press.moved && Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_THRESHOLD) return;
    press.moved = true;
    document.body.classList.add("dragging");
    pending = { x: e.screenX, y: e.screenY };
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const onUp = (e: PointerEvent) => {
    if (!press) return;
    if (press.moved) {
      pending = { x: e.screenX, y: e.screenY };
      flush();
      dragged = true;
    }
    press = null;
    document.body.classList.remove("dragging");
  };
  for (const el of [pair, bubble] as HTMLElement[]) {
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", () => {
      if (dragged) dragged = false;
      else void window.dum.invoke({ type: "toggle-panel" });
    });
  }

  // Speech: only lines that arrive while the companion is open, never a replay of old history.
  let seen = -1;
  let spoken: { text: string; wizard: boolean; at: number } | null = null;
  let quipAt = 0;
  let refusedAt = 0;
  let hideTimer = 0;
  let last: Snapshot | null = null;
  let shownRoot: string | null = null;

  const render = (snap: Snapshot) => {
    last = snap;
    const { runtime, state } = snap;
    const transcript = state?.transcript ?? [];
    const newest = transcript.reduce((m, e) => Math.max(m, e.id), 0);
    const now = Date.now();
    if (seen < 0 || (state?.root ?? null) !== shownRoot || newest < seen) {
      seen = newest;
      spoken = null;
    }
    shownRoot = state?.root ?? null;
    for (const e of transcript) {
      if (e.id <= seen) continue;
      if (e.kind === "say" || e.kind === "quip") spoken = { text: e.text, wizard: e.kind === "quip", at: now };
      if (e.kind === "quip") quipAt = now;
      if ((e.kind === "tool" && e.outcome === "refused") || (e.kind === "diff" && e.outcome === "refused")) refusedAt = now;
    }
    seen = newest;

    const prompt = state?.prompt ?? null;
    const waiting = !!prompt && prompt.type !== "next";
    const setupNeeded = !runtime.gitAvailable || !runtime.available || !runtime.authenticated;

    let sticky = "";
    if (!runtime.gitAvailable) sticky = "needs Git first";
    else if (!runtime.available) sticky = "can't find Claude";
    else if (!runtime.authenticated) sticky = runtime.loginRunning ? "finishing sign-in" : "sign in to Claude";
    else if (!state) sticky = "pick a project";
    else if (prompt?.type === "plan") sticky = "plan's ready";
    else if (prompt?.type === "course") sticky = `course: ${prompt.card.skill}`;
    else if (prompt?.type === "question") sticky = prompt.intern ? prompt.question : "needs your answer";

    const fresh = spoken && now - spoken.at < SPEECH_MS ? spoken : null;
    const text = sticky || fresh?.text || "";
    bubbleText.textContent = text.replace(/\s+/g, " ").trim();
    bubble.hidden = !text;
    bubble.classList.toggle("wizard", !sticky && !!fresh?.wizard);
    badge.hidden = !waiting && !setupNeeded;
    clearTimeout(hideTimer);
    if (!sticky && fresh) hideTimer = window.setTimeout(() => last && render(last), SPEECH_MS - (now - fresh.at) + 50);

    let mood: DumState = "idle";
    if (setupNeeded || now - refusedAt < SPEECH_MS) mood = "blocked";
    else if (waiting) mood = "asking";
    else if (state?.busy) mood = /think/i.test(state.status) || !state.status ? "thinking" : "building";
    dum.set(mood);
    const wiz: WizardState = now - quipAt < SPEECH_MS / 2 ? "talking" : state?.busy ? "pondering" : "idle";
    wizard.set(wiz);
    if (mood === "blocked" || wiz === "talking") {
      // Back to the resting face once the moment passes.
      window.setTimeout(() => last === snap && render(snap), SPEECH_MS);
    }

    const status = sticky || (state?.busy ? state.status || "working" : "");
    pair.setAttribute("aria-label", status ? `Open dum - ${status}` : "Open dum");
    pair.title = status ? `dum: ${status}` : "dum";
  };

  window.dum.subscribe(render);
  void window.dum.invoke({ type: "snapshot" }).then((r) => r.ok && r.snapshot && render(r.snapshot));
}

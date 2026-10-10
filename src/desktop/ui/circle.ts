// The persistent circle and its column. Collapsed: one dark disk wearing the open panel's disk, or Dum's
// face when nothing is open. Expanded: Dum, up to three goals, the skill tree, the monitor and settings,
// identical dark disks on one see-through capsule, fading down out of the first slot. Every disk is a
// button until movement proves a drag, and main decides which: the page only reports a primary press,
// its release or its loss, and main samples the pointer and resolves the slot itself. Keyboard and accessibility presses pick a
// slot by name (Enter) or fold the column (Esc). No coordinates, settings or transcript cross here.

import type { CircleReason, CircleSlot, CircleState, CircleView } from "../protocol.ts";
import { h } from "./dom.ts";
import { Creature, type DumState } from "./sprites.ts";
import { CIRCLE } from "../surfaces.ts";

/** The existing face each state wears. */
const FACE: Record<CircleState, DumState> = {
  idle: "idle",
  looking: "thinking",
  thinking: "thinking",
  listening: "asking",
  attention: "blocked",
};

/** What the accessible name says for each reason; the state's indicator never relies on color alone. */
const SAYS: Record<CircleReason, string> = {
  none: "idle",
  "look-paused": "look paused",
  looking: "looking",
  zone: "thinking",
  debug: "thinking about a debug question",
  recording: "listening",
  transcribing: "transcribing",
  decision: "a decision is waiting",
  "host-failed": "needs attention, Dum stopped working",
  setup: "needs setup",
  "key-rejected": "needs attention, the API key was rejected",
  "voice-error": "needs attention, voice failed",
  "look-route": "needs attention, the look model can't be used",
};

const SVG = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>, ...kids: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}

/** A monoline glyph on a 16-unit grid: 1.5 px strokes, round caps, no fills, at most five strokes. */
function glyph(...kids: SVGElement[]): SVGElement {
  return svg("svg", { class: "disk-glyph", viewBox: "0 0 16 16", "aria-hidden": "true" }, ...kids);
}

/** The one status dot at two o'clock: accent for a waiting step or attention, off-white while recording. */
const dot = (kind: "wait" | "rec") => h("span", { class: `disk-dot ${kind}`, "aria-hidden": "true" });

/** What a disk other than Dum's draws: a goal's two initials, or a utility's glyph. */
function diskContent(slot: CircleSlot): Node[] {
  switch (slot.ref.kind) {
    case "tree":
      return [glyph(
        svg("circle", { cx: 8, cy: 3, r: 1.6 }), svg("circle", { cx: 3.5, cy: 12.5, r: 1.6 }), svg("circle", { cx: 12.5, cy: 12.5, r: 1.6 }),
        svg("path", { d: "M8 4.6v3M8 7.6l-3.6 3.5M8 7.6l3.6 3.5" }))];
    case "monitor":
      return [glyph(svg("rect", { x: 1.5, y: 2.5, width: 13, height: 9, rx: 1.5 }), svg("path", { d: "M5.5 14h5" })), ...(slot.waiting ? [dot("rec")] : [])];
    case "settings":
      return [glyph(svg("circle", { cx: 8, cy: 8, r: 2.4 }), svg("path", { d: "M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" }))];
    default:
      return [h("span", { class: "disk-mark", "aria-hidden": "true" }, slot.mark.slice(0, 2)), ...(slot.waiting ? [dot("wait")] : [])];
  }
}

export function circle(): void {
  const style = h("link", { rel: "stylesheet", href: "./circle.css" });
  document.head.append(style);

  // Dum keeps its own amber: the character is the one coloured thing on the monochrome disks.
  const leadFace = new Creature("dum", CIRCLE.faceScale);
  const slotFace = new Creature("dum", CIRCLE.faceScale);
  const wear = h("span", { class: "circle-wear", "aria-hidden": "true" });
  // Dum's face with its state indicators: a ring inside the disk's edge, and the accent dot for attention.
  const ring = () => h("span", { class: "circle-ring", "aria-hidden": "true" });
  const attention = () => h("span", { class: "disk-dot wait circle-attention", "aria-hidden": "true" });
  const lead = h("button", { type: "button", class: "circle lead", "aria-label": "Dum. Show your goals" }, ring(), leadFace.canvas, attention(), wear);
  const background = h("div", { class: "column-bg", "aria-hidden": "true" });
  const list = h("div", { class: "slots", role: "group", "aria-label": "Dum's circles" });
  const root = h("div", { class: "column", "data-expanded": "false" }, background, lead, list);

  let current: CircleView | null = null;
  let slotsJson = "";
  let slotButtons: HTMLButtonElement[] = [];
  /** A keyboard press unfolded the column: focus its first circle once it's out. */
  let focusFirst = false;

  /** The press in flight: its pointer, and main's gesture id once main answered. */
  let press: { pointerId: number; gestureId: string | null; ended: "end" | "cancel" | null } | null = null;

  const finish = (phase: "end" | "cancel") => {
    const p = press;
    if (!p || p.ended) return;
    p.ended = phase;
    if (p.gestureId) {
      press = null;
      void window.dumCircle.invoke({ type: "circle-press", phase, gestureId: p.gestureId });
    }
  };

  /** Mouse presses on any disk are main's gestures; keyboard and accessibility presses (no click count) run `keyed`. */
  const pressable = (button: HTMLButtonElement, keyed: () => void) => {
    button.addEventListener("pointerdown", (e) => {
      // Primary button of the primary pointer only; a second finger or the right button does nothing.
      if (!e.isPrimary || e.button !== 0 || press) return;
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      const p = { pointerId: e.pointerId, gestureId: null as string | null, ended: null as "end" | "cancel" | null };
      press = p;
      void window.dumCircle.invoke({ type: "circle-press", phase: "begin" }).then((reply) => {
        if (press !== p) return;
        if (!reply.ok || !reply.gesture) {
          press = null;
          return;
        }
        render(reply.view);
        p.gestureId = reply.gesture.gestureId;
        // Released before main answered: send the release now.
        if (p.ended) {
          press = null;
          void window.dumCircle.invoke({ type: "circle-press", phase: p.ended, gestureId: p.gestureId });
        }
      }, () => {
        if (press === p) press = null;
      });
    });
    button.addEventListener("pointerup", (e) => {
      if (press?.pointerId === e.pointerId) finish("end");
    });
    button.addEventListener("pointercancel", (e) => {
      if (press?.pointerId === e.pointerId) finish("cancel");
    });
    button.addEventListener("lostpointercapture", (e) => {
      // After a release this is a no-op; without one, the press was lost.
      if (press?.pointerId === e.pointerId) finish("cancel");
    });
    button.addEventListener("click", (e) => {
      if (e.detail === 0) keyed();
    });
    button.addEventListener("contextmenu", (e) => e.preventDefault());
    button.addEventListener("dragstart", (e) => e.preventDefault());
  };

  pressable(lead, () => {
    focusFirst = !current?.open;
    void window.dumCircle.invoke({ type: "circle-toggle" }).then((r) => r.ok && render(r.view));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !current?.expanded) return;
    e.preventDefault();
    void window.dumCircle.invoke({ type: "circle-collapse" }).then((r) => r.ok && render(r.view));
  });

  /** The accessible name of one circle in the column. */
  const named = (slot: CircleSlot, view: CircleView): string => {
    if (slot.ref.kind === "dum") return `${slot.label} — Dum ${SAYS[view.reason]}`;
    if (slot.ref.kind === "monitor") return `${slot.label}${slot.waiting ? ", recording" : ""}`;
    if (slot.ref.kind !== "goal") return slot.label;
    return `${slot.label}, ${Math.round(slot.progress * 100)}% done${slot.waiting ? ", a step is waiting" : ""}`;
  };

  /** One button per circle, top to bottom; rebuilt only when the column's circles change. */
  const build = (view: CircleView) => {
    const json = JSON.stringify(view.slots);
    if (json === slotsJson) return;
    slotsJson = json;
    slotButtons = view.slots.map((slot, i) => {
      const content = slot.ref.kind === "dum" ? [ring(), slotFace.canvas, attention()] : diskContent(slot);
      const button = h("button", { type: "button", class: `circle slot slot-${slot.ref.kind}` }, ...content);
      // Through CSSOM: the page's CSP drops inline style attributes.
      button.style.setProperty("--i", String(i));
      pressable(button, () => void window.dumCircle.invoke({ type: "circle-pick", slot: slot.ref }).then((r) => r.ok && render(r.view)));
      return button;
    });
    list.replaceChildren(...slotButtons);
    root.style.setProperty("--n", String(Math.max(1, view.slots.length)));
  };

  function render(view: CircleView): void {
    const opened = current !== null && !current.expanded && view.expanded;
    current = view;
    build(view);
    leadFace.set(FACE[view.state]);
    slotFace.set(FACE[view.state]);
    for (const el of [lead, slotButtons[0]]) {
      if (!el) continue;
      el.dataset.state = view.state;
      el.dataset.reason = view.reason;
      el.dataset.paused = String(view.paused);
    }
    view.slots.forEach((slot, i) => {
      slotButtons[i]?.setAttribute("aria-label", named(slot, view));
      slotButtons[i]?.setAttribute("title", slot.label);
    });

    // Collapsed, the circle wears the open panel's circle; Dum's face when nothing (or Dum) is open.
    const showing = view.open && view.showing?.kind !== "dum" ? JSON.stringify(view.showing) : null;
    const worn = showing ? view.slots.find((s) => JSON.stringify(s.ref) === showing) ?? null : null;
    lead.dataset.wearing = worn ? worn.ref.kind : "dum";
    wear.replaceChildren(...(worn ? diskContent(worn) : []));
    // The open panel's disk wears a 1 px off-white ring.
    view.slots.forEach((slot, i) => slotButtons[i]?.classList.toggle("selected", view.open && JSON.stringify(slot.ref) === JSON.stringify(view.showing)));
    lead.setAttribute("aria-label", worn
      ? `${worn.label} is open — Dum ${SAYS[view.reason]}. Hide it`
      : `Dum — ${SAYS[view.reason]}. ${view.open ? "Hide Dum" : "Show your goals"}`);

    root.dataset.expanded = String(view.expanded);
    if (opened && focusFirst) {
      focusFirst = false;
      // After the first disk is visible; visibility flips at the start of the slide.
      requestAnimationFrame(() => slotButtons[0]?.focus());
    } else if (!view.expanded && slotButtons.includes(document.activeElement as HTMLButtonElement)) {
      lead.focus();
    }
  }

  document.body.append(root);
  window.dumCircle.subscribe(render);
  void window.dumCircle.invoke({ type: "circle-view" }).then((r) => r.ok && render(r.view));
}

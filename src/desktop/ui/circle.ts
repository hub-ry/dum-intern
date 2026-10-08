// The persistent circle: Dum's face on a dark disk. Every pixel of it is a button until movement
// proves a drag, and main decides which: the page only reports a primary press, its release or its
// loss, and main samples the pointer itself. No coordinates, settings or transcript cross here.

import type { CircleReason, CircleState, CircleView } from "../protocol.ts";
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

export function circle(): void {
  const style = h("link", { rel: "stylesheet", href: "./circle.css" });
  document.head.append(style);

  const face = new Creature("dum", CIRCLE.faceScale);
  const ring = h("span", { class: "circle-ring", "aria-hidden": "true" });
  const badge = h("span", { class: "circle-badge", "aria-hidden": "true" }, "!");
  const button = h("button", { type: "button", class: "circle", "aria-label": "Dum. Open Dum" }, ring, face.canvas, badge);

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
    // Mouse clicks are the gesture above; only an accessibility or keyboard press (no click count) toggles here.
    if (e.detail === 0) void window.dumCircle.invoke({ type: "circle-toggle" }).then((r) => r.ok && render(r.view));
  });
  button.addEventListener("contextmenu", (e) => e.preventDefault());
  button.addEventListener("dragstart", (e) => e.preventDefault());

  function render(view: CircleView): void {
    face.set(FACE[view.state]);
    button.dataset.state = view.state;
    button.dataset.reason = view.reason;
    button.dataset.paused = String(view.paused);
    button.setAttribute("aria-label", `Dum — ${SAYS[view.reason]}. ${view.open ? "Hide Dum" : "Open Dum"}`);
  }

  document.body.append(button);
  window.dumCircle.subscribe(render);
  void window.dumCircle.invoke({ type: "circle-view" }).then((r) => r.ok && render(r.view));
}

// Settings → Debug chat: ask Dum about Dum. Its own draft, transcript, binding, Send and Stop; it never
// touches the zone draft, context or skills, and its only authority is reading diagnostics (§6).

import type { DebugView as DebugState } from "../../diagnostic-types.ts";
import { chip, h, icon, type Client } from "./dom.ts";

const MAX_BYTES = 8 * 1024;

const STATE: Record<DebugState["state"], string> = {
  idle: "ready",
  busy: "answering",
  "needs-backend": "needs a model",
  expired: "expired",
};

/** The element fires this when the debug chat needs Agent setup; the draft stays here. */
export const NEEDS_AGENT = "dum-debug-needs-agent";

export class DebugView {
  readonly el = h("section", { class: "debug", "aria-label": "Debug chat" });
  readonly draft = h("textarea", { class: "input", rows: "2", "aria-label": "Question about Dum", placeholder: "e.g. Which look model is running?", "data-focus": "debug-draft" });
  private log = h("ol", { class: "debug-log", role: "log", "aria-label": "Debug conversation" });
  private state = h("span", { role: "status" });
  private notice = h("div", { class: "notice", hidden: true });
  private sendBtn = h("button", { type: "submit", class: "btn primary small" }, icon("send"), "Send");
  private stopBtn = h("button", { type: "button", class: "btn ghost small", title: "Stop (⌘. while here)", onclick: () => void this.stop() }, icon("stop"), "Stop");
  private view: DebugState | null = null;
  private key = "";
  /** The host has published a debug view in a snapshot at least once. */
  private published = false;
  /** The question in flight to the host and the newest entry id before it, until it shows up in the log. */
  private sent: { text: string; after: number } | null = null;

  constructor(private client: Client) {
    const form = h(
      "form",
      { class: "debug-form" },
      this.draft,
      h(
        "div",
        { class: "composer-row" },
        this.sendBtn,
        this.stopBtn,
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn ghost small", onclick: () => void this.reset(false) }, "New debug session"),
        h("button", { type: "button", class: "btn ghost small", onclick: () => void this.reset(true) }, "Clear"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.draft.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.draft.addEventListener("input", () => this.sync());
    this.el.append(
      h("p", { class: "hint" }, "Ask Dum about itself. Read-only; each Send makes one model call."),
      h("div", { class: "card-head" }, h("span", {}, "Debug chat"), this.state),
      this.notice,
      this.log,
      form,
    );
  }

  /** Opens the debug session when the disclosure opens. */
  async open() {
    if (this.view) return;
    const r = await this.client.call({ type: "debug-open" });
    if (r.ok && r.debug) this.apply(r.debug);
  }

  /** ⌘. while the debug chat has focus: stops only this flight. */
  async stop() {
    const v = this.view;
    if (v?.state === "busy") await this.client.call({ type: "debug-stop", binding: v.binding });
  }

  /**
   * The host's published debug view. A null before the host has published one doesn't wipe the view a
   * debug-open or debug-reset reply already showed; a null after one means the host closed it.
   */
  update(view: DebugState | null) {
    if (view) this.published = true;
    else if (!this.published) return;
    this.apply(view);
  }

  private apply(view: DebugState | null) {
    this.view = view;
    const key = JSON.stringify(view);
    if (key !== this.key) {
      this.key = key;
      this.draw(view);
    }
    // The question leaves the box only once the host took it for a flight: your new entry is in the log.
    // Needs-backend records nothing, so the question stays here for after Agent setup.
    if (this.sent && view?.entries.some((e) => e.from === "you" && e.id > this.sent!.after)) {
      if (this.draft.value.trim() === this.sent.text) this.draft.value = "";
      this.sent = null;
    }
    this.sync();
  }

  private draw(view: DebugState | null) {
    this.state.replaceChildren(view ? chip(STATE[view.state], view.state === "busy" ? "info" : view.state === "idle" ? "ok" : "warn") : chip("closed", "muted"));
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 32;
    this.log.replaceChildren(
      ...(view?.dropped ? [h("li", { class: "debug-entry notice-entry" }, `${view.dropped} older entr${view.dropped === 1 ? "y" : "ies"} dropped to stay small.`)] : []),
      ...(view?.entries ?? []).map((e) => h("li", { class: `debug-entry debug-${e.from}` }, h("span", { class: "speaker" }, e.from === "you" ? "you" : e.from === "dum" ? "Dum" : "note"), h("span", { class: "debug-text" }, e.text))),
    );
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
    if (view?.state === "needs-backend") {
      this.notice.replaceChildren(
        h("span", {}, "The debug chat uses Dum's model. Set one up; your question stays here."),
        h("button", { type: "button", class: "btn small", onclick: () => this.el.dispatchEvent(new CustomEvent(NEEDS_AGENT, { bubbles: true })) }, "Set up Agent"),
      );
      this.notice.hidden = false;
    } else if (view?.state === "expired") {
      this.notice.replaceChildren(h("span", {}, "This debug session expired after 30 idle minutes."), h("button", { type: "button", class: "btn small", onclick: () => void this.reset(false) }, "New debug session"));
      this.notice.hidden = false;
    } else this.notice.hidden = true;
  }

  private sync() {
    const v = this.view;
    const text = this.draft.value.trim();
    this.sendBtn.disabled = !v || v.state !== "idle" || !text || new TextEncoder().encode(text).length > MAX_BYTES;
    this.stopBtn.disabled = v?.state !== "busy";
  }

  private async send() {
    const v = this.view;
    const text = this.draft.value.trim();
    if (!v || v.state !== "idle" || !text) return;
    if (new TextEncoder().encode(text).length > MAX_BYTES) return this.client.showError("That question is too long for the debug chat.");
    this.sent = { text, after: Math.max(-1, ...v.entries.map((e) => e.id)) };
    const r = await this.client.call({ type: "debug-send", binding: v.binding, text });
    if (r.ok && r.snapshot?.debug) this.update(r.snapshot.debug);
    // The host answers after the flight, so an accepted question has already left the box by now.
    this.sent = null;
  }

  private async reset(clearDraft: boolean) {
    const r = await this.client.call({ type: "debug-reset" });
    if (r.ok && r.debug) this.apply(r.debug);
    this.sent = null;
    if (r.ok && clearDraft) {
      this.draft.value = "";
      this.sync();
    }
  }
}

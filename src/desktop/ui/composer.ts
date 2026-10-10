// A goal's one message box: a single borderless line. The draft lives in main, one per goal, so voice
// (on its hotkey) fills the same text and Do this consumes the same revision. Sending is always
// explicit: Return or the ↩ that appears once there is text. Stop shows only while Dum is working;
// voice shows its state here.

import type { Snapshot } from "../protocol.ts";
import type { Prompt } from "../../store-types.ts";
import { h, icon, type Client } from "./dom.ts";

const DRAFT_DELAY_MS = 250;

export class Composer {
  readonly el: HTMLElement;
  readonly textarea = h("textarea", { class: "composer-input", rows: "1", "aria-label": "Message to Dum" });
  private dirty = false;
  private timer = 0;
  private flushing: Promise<void> = Promise.resolve();
  private sending = false;
  private promptKey = "\u0000";

  private promptBox = h("div", { class: "prompt-box", hidden: true, tabindex: "-1" });
  private statusText = h("span", { class: "status-text" });
  private stopBtn = h("button", { type: "button", class: "text-action", title: "Stop (⌘.)", onclick: () => this.stop() }, "Stop");
  private statusLine = h("div", { class: "status-line", hidden: true, role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), this.statusText, h("span", { class: "spacer" }), this.stopBtn);
  private voiceText = h("p", { class: "voice-text", role: "status", hidden: true });
  private sendBtn = h("button", { type: "submit", class: "send", "aria-label": "Send", title: "Send (Return)", hidden: true }, icon("send"));
  private agentNote = h("p", { class: "hint agent-note", hidden: true });

  /** `needsAgent`: the send needs a backend and none is chosen yet. */
  constructor(private client: Client, private needsAgent: () => void) {
    const form = h("form", { class: "composer" }, this.textarea, this.sendBtn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.textarea.addEventListener("input", () => {
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.flush(), DRAFT_DELAY_MS);
      this.sync();
    });
    this.el = h("div", { class: "composer-wrap" }, this.statusLine, this.promptBox, this.voiceText, this.agentNote, form);
  }

  focus() {
    this.textarea.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
  }

  stop() {
    const binding = this.client.snap?.binding;
    if (binding && this.client.snap?.state?.busy) void this.client.call({ type: "interrupt", binding });
  }

  update(s: Snapshot) {
    if (!this.dirty && this.textarea.value !== s.draft.text) {
      void this.flushing.then(() => {
        if (!this.dirty && this.client.snap) this.textarea.value = this.client.snap.draft.text;
        this.sync();
      });
    }
    const v = s.voice;
    this.voiceText.textContent = v.phase === "idle" ? "" : v.status;
    this.voiceText.className = `voice-text voice-${v.phase}`;
    this.voiceText.hidden = v.phase === "idle" || !v.status;
    if (s.agent.chosen) this.agentNote.hidden = true;
    if (s.state) this.drawPrompt(s.state.prompt, s);
    else this.promptBox.hidden = true;
    this.statusLine.hidden = !s.state?.busy;
    this.statusText.textContent = s.state?.status || "working";
    this.sync();
  }

  private sync() {
    const s = this.client.snap;
    const prompt = s?.state?.prompt;
    const blocked = !!s?.state?.busy && prompt?.type !== "question";
    // ↩ shows only once there's something to send.
    this.sendBtn.hidden = !this.textarea.value.trim();
    this.sendBtn.disabled = !s || this.sending || blocked || !s.binding;
    this.textarea.placeholder = prompt?.type === "question" ? (prompt.purpose ? "Or type a reply" : "Answer Dum") : blocked ? "Dum is working" : "Ask Dum, or tell it what you built";
  }

  /** Main's copy of the draft follows the box; Do this calls it first so it names the revision it consumes. Each write names the revision it replaces. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.flushing = this.flushing.then(async () => {
      const s = this.client.snap;
      if (!this.dirty || !s) return;
      this.dirty = false;
      const text = this.textarea.value;
      const r = await this.client.call({ type: "draft-set", text, expectedDraftRevision: s.draft.revision, binding: s.activeZone ? s.binding : null });
      if (!r.ok && !this.dirty && this.client.snap) this.textarea.value = this.client.snap.draft.text;
    });
    return this.flushing;
  }

  private async send() {
    const s = this.client.snap;
    const text = this.textarea.value.trim();
    if (!s || !text || this.sending) return;
    this.sending = true;
    this.sync();
    try {
      await this.flush();
      if (!s.agent.chosen && !text.startsWith(":")) {
        this.agentNote.textContent = "Choose who powers Dum first. Your message stays here.";
        this.agentNote.hidden = false;
        this.needsAgent();
        return;
      }
      const now = this.client.snap;
      if (!now?.binding) return;
      await this.client.call({ type: "send", binding: now.binding, draftRevision: now.draft.revision });
    } finally {
      this.sending = false;
      this.sync();
    }
  }

  private drawPrompt(p: Prompt, s: Snapshot) {
    const key = JSON.stringify(p) + String(!!s.binding);
    if (key === this.promptKey) return;
    const fresh = this.promptKey !== "\u0000";
    this.promptKey = key;
    this.promptBox.replaceChildren();
    if (p?.type !== "question" || !p.purpose) {
      this.promptBox.hidden = true;
      return;
    }
    const purpose = p.purpose;
    const binding = this.client.requestBinding();
    // Neither answer is the default: no button is primary or focused, and voice can't press them.
    const answer = (value: boolean, label: string) =>
      h("button", { type: "button", class: "btn small", disabled: !binding, onclick: () => binding && void this.client.call({ type: "respond", binding, decision: { kind: purpose, value } }) }, label);
    this.promptBox.className = `prompt-box ${purpose === "attest" ? "self-report" : "permission"}`;
    this.promptBox.append(h("h3", {}, p.question.replace(/\s*\((?:y\/n|yes\/no)\)\s*$/i, "")));
    if (p.why) this.promptBox.append(h("p", { class: "hint" }, p.why));
    this.promptBox.append(
      purpose === "attest"
        ? h("div", { class: "actions" }, answer(true, "Yes, I wrote it myself"), answer(false, "No, I had help"))
        : h("div", { class: "actions" }, answer(true, "Yes, share it"), answer(false, "No")),
    );
    this.promptBox.hidden = false;
    if (fresh && document.hasFocus() && document.activeElement !== this.textarea) this.promptBox.focus();
  }
}

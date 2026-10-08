// The message box the panel and the command bar share. The draft lives in main, one per zone, so
// typing here shows up in the other surface and voice fills the same text. Sending is always explicit.

import type { CapturePreview, CaptureSource, Snapshot } from "../protocol.ts";
import type { Prompt } from "../../store-types.ts";
import { h, icon, iconButton, type Client } from "./dom.ts";
import { nameFromGoal } from "./zones.ts";

const DRAFT_DELAY_MS = 250;
type Chooser = "share" | "path" | "sources" | null;

export type ComposerOptions = {
  client: Client;
  /** The send needs a backend and none is chosen yet: show "Who powers Dum?". */
  needsAgent(): void;
};

export class Composer {
  readonly el: HTMLElement;
  readonly textarea = h("textarea", { class: "input composer-input", rows: "2", "aria-label": "Message to Dum", "aria-describedby": "composer-keys" });
  private client: Client;
  private needsAgent: () => void;
  private dirty = false;
  private timer = 0;
  private flushing: Promise<void> = Promise.resolve();
  private sending = false;
  private preview: CapturePreview | null = null;
  private chooser: Chooser = null;
  private promptKey = "\u0000";

  private promptBox = h("div", { class: "prompt-box", hidden: true, tabindex: "-1" });
  private statusText = h("span", { class: "status-text" });
  private stopBtn = h("button", { type: "button", class: "btn ghost small", title: "Stop (⌘.)", onclick: () => this.stop() }, icon("stop"), "Stop");
  private statusLine = h("div", { class: "status-line", hidden: true, role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), this.statusText, h("span", { class: "spacer" }), this.stopBtn);
  private voiceText = h("span", { class: "voice-text" });
  private voiceLabel = h("span", {}, "Voice");
  private voiceBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => void this.voice() }, icon("mic"), this.voiceLabel);
  private voiceCancel = h("button", { type: "button", class: "btn ghost small", hidden: true, onclick: () => void this.voiceCancelNow() }, "Cancel");
  private shareBtn = h("button", { type: "button", class: "btn ghost small", "aria-haspopup": "true", "aria-expanded": "false", onclick: () => this.toggle("share") }, icon("folder"), h("span", {}, "Share"));
  private shares = h("ul", { class: "shares", "aria-label": "Shared with this message" });
  private chooserBox = h("div", { class: "chooser-box", hidden: true });
  private previewImg = h("img", { class: "preview-img", alt: "" });
  private previewName = h("span", { class: "preview-name" });
  private previewCard = h(
    "div",
    { class: "preview", hidden: true, role: "group", "aria-label": "Picture waiting for your message" },
    h("div", { class: "preview-head" }, icon("screen"), this.previewName, h("span", { class: "chip chip-warn" }, "not sent"), h("span", { class: "spacer" }), h("button", { type: "button", class: "btn ghost small", onclick: () => void this.discard() }, icon("close"), "Discard")),
    this.previewImg,
    h("p", { class: "hint" }, "Look it over for anything private. It goes with your next message only when you send it."),
  );
  private sendLabel = h("span", {}, "Send");
  private sendBtn = h("button", { type: "submit", class: "btn primary send" }, icon("send"), this.sendLabel);
  private agentNote = h("p", { class: "hint agent-note", hidden: true });

  constructor(o: ComposerOptions) {
    this.client = o.client;
    this.needsAgent = o.needsAgent;
    const form = h(
      "form",
      { class: "composer" },
      this.textarea,
      h(
        "div",
        { class: "composer-row" },
        this.voiceBtn,
        this.voiceCancel,
        this.shareBtn,
        h("span", { id: "composer-keys", class: "hint keys" }, "Return sends · Shift-Return new line"),
        h("span", { class: "spacer" }),
        this.sendBtn,
      ),
    );
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
    this.el = h("div", { class: "composer-wrap" }, this.statusLine, this.promptBox, this.voiceText, this.agentNote, this.previewCard, this.shares, this.chooserBox, form);
  }

  focus() {
    this.textarea.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
  }

  /** Closes an inner chooser; true when Esc had something to close. */
  escape(): boolean {
    if (!this.chooser) return false;
    this.chooser = null;
    this.drawChooser();
    this.shareBtn.focus();
    return true;
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
    if (this.preview && (s.draft.captureToken !== this.preview.token || this.preview.expiresAt <= Date.now())) {
      this.preview = null;
      this.drawPreview();
    }
    const firstRun = !s.activeZone;
    this.textarea.setAttribute("aria-label", firstRun ? "What are you trying to learn?" : "Message to Dum");
    this.shareBtn.hidden = firstRun;
    this.shares.hidden = firstRun || !s.shares.length;
    this.shares.replaceChildren(
      ...s.shares.map((g) =>
        h(
          "li",
          { class: "share" },
          icon(g.kind === "folder" ? "folder" : "file"),
          h("span", {}, g.label),
          g.scope === "zone" ? h("span", { class: "chip chip-muted" }, "followed") : null,
          g.scope === "request" ? iconButton("close", `Stop sharing ${g.label}`, () => {
            const binding = this.client.requestBinding();
            if (binding) void this.client.call({ type: "share-remove", shareId: g.id, binding });
          }, "", "icon-btn tiny") : null,
        ),
      ),
    );
    const v = s.voice;
    this.voiceText.textContent = v.phase === "idle" ? "" : v.status;
    this.voiceText.className = `voice-text voice-${v.phase}`;
    this.voiceText.hidden = v.phase === "idle" || !v.status;
    const recording = v.phase === "recording";
    this.voiceLabel.textContent = recording ? "Stop voice" : "Voice";
    this.voiceBtn.setAttribute("aria-pressed", String(recording));
    this.voiceBtn.disabled = v.phase === "transcribing";
    this.voiceCancel.hidden = !(recording || v.phase === "transcribing") || !v.recordingId;
    if (s.agent.chosen) this.agentNote.hidden = true;
    if (s.state) this.drawPrompt(s.state.prompt, s);
    else this.promptBox.hidden = true;
    const state = s.state;
    this.statusLine.hidden = !state?.busy;
    this.statusText.textContent = state?.status || "working";
    this.sync();
  }

  private sync() {
    const s = this.client.snap;
    const prompt = s?.state?.prompt;
    const blocked = !!s?.state?.busy && prompt?.type !== "question";
    const firstRun = !!s && !s.activeZone;
    this.sendBtn.disabled = !s || this.sending || blocked || !this.textarea.value.trim() || (!firstRun && !s.binding);
    this.sendLabel.textContent = firstRun ? "Start" : this.preview ? "Send with picture" : "Send";
    this.textarea.placeholder = firstRun
      ? "What are you trying to learn?"
      : prompt?.type === "question" ? (prompt.purpose ? "Or type a reply" : "Answer Dum") : blocked ? "Dum is working - Stop it to write" : "Ask Dum, or tell it what you built";
  }

  /** Main's copy of the draft follows the box. Each write names the revision it replaces, so two surfaces can't clobber each other. */
  private flush(): Promise<void> {
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
      if (!s.activeZone) {
        await this.flush();
        await this.client.call({ type: "zone-create", zone: { name: nameFromGoal(text), goal: text, parentId: null, language: null, focusSkills: [] }, enter: true });
        return;
      }
      if (!s.agent.chosen && !text.startsWith(":")) {
        await this.flush();
        this.agentNote.textContent = "Choose who powers Dum first. Your message stays here.";
        this.agentNote.hidden = false;
        this.needsAgent();
        return;
      }
      await this.flush();
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
      h("button", { type: "button", class: "btn", disabled: !binding, onclick: () => binding && void this.client.call({ type: "respond", binding, decision: { kind: purpose, value } }) }, label);
    this.promptBox.className = `prompt-box ${purpose === "attest" ? "self-report" : "permission"}`;
    this.promptBox.append(h("h3", {}, p.question.replace(/\s*\((?:y\/n|yes\/no)\)\s*$/i, "")));
    if (p.why) this.promptBox.append(h("p", { class: "hint" }, p.why));
    if (purpose === "attest") {
      this.promptBox.append(
        h("p", { class: "hint" }, "Only you know this. A yes plus a passing review builds the skill. A no keeps the review on record and builds nothing."),
        h("div", { class: "actions" }, answer(true, "Yes, I wrote it myself"), answer(false, "No, I had help")),
      );
    } else this.promptBox.append(h("div", { class: "actions" }, answer(true, "Yes, share it"), answer(false, "No")));
    this.promptBox.hidden = false;
    if (fresh && document.hasFocus() && document.activeElement !== this.textarea) this.promptBox.focus();
  }

  private async voice() {
    const s = this.client.snap;
    if (!s) return;
    const v = s.voice;
    if (v.phase === "recording" && v.recordingId) await this.client.call({ type: "voice-stop", recordingId: v.recordingId });
    else if (s.binding) {
      await this.flush();
      const now = this.client.snap;
      if (now?.binding) await this.client.call({ type: "voice-start", binding: now.binding });
    }
  }

  private async voiceCancelNow() {
    const id = this.client.snap?.voice.recordingId;
    if (id) await this.client.call({ type: "voice-cancel", recordingId: id });
  }

  // -- sharing --------------------------------------------------------------

  private toggle(chooser: Exclude<Chooser, null>) {
    this.chooser = this.chooser === chooser ? null : chooser;
    this.drawChooser();
  }

  private drawChooser() {
    this.shareBtn.setAttribute("aria-expanded", String(this.chooser !== null));
    this.chooserBox.hidden = !this.chooser;
    if (this.chooser === "share") {
      const choose = (kind: "file" | "folder") => async () => {
        const binding = this.client.requestBinding();
        if (!binding) return;
        const r = await this.client.call({ type: "share-choose", kind, binding });
        if (r.ok) this.escape();
      };
      this.chooserBox.replaceChildren(
        h(
          "div",
          { class: "menu", role: "group", "aria-label": "Share with this message" },
          h("button", { type: "button", class: "btn ghost", onclick: choose("file") }, icon("file"), "A file…"),
          h("button", { type: "button", class: "btn ghost", onclick: choose("folder") }, icon("folder"), "A folder…"),
          h("button", { type: "button", class: "btn ghost", onclick: () => this.toggle("path") }, icon("pencil"), "Type a path…"),
          h("button", { type: "button", class: "btn ghost", disabled: !this.client.snap?.canAttach, onclick: () => void this.openSources() }, icon("screen"), "A screen or window…"),
        ),
        h("p", { class: "hint" }, "Dum reads what you share for this message only. Esc closes this."),
      );
      this.chooserBox.querySelector<HTMLElement>("button")?.focus();
    } else if (this.chooser === "path") {
      const path = h("input", { class: "input", type: "text", spellcheck: "false", "aria-label": "Path to share", placeholder: "/Users/you/code/project/src/main.rs" });
      const kind = h("select", { class: "input", "aria-label": "It is a" }, h("option", { value: "file" }, "file"), h("option", { value: "folder" }, "folder"));
      const form = h("form", { class: "inline-form" }, path, kind, h("button", { type: "submit", class: "btn" }, "Share"));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const binding = this.client.requestBinding();
        if (!path.value.trim()) return path.focus();
        if (!binding) return;
        const r = await this.client.call({ type: "share-path", path: path.value.trim(), kind: kind.value === "folder" ? "folder" : "file", binding });
        if (r.ok) this.escape();
      });
      this.chooserBox.replaceChildren(form, h("p", { class: "hint" }, "Dum asks you to confirm before it reads anything."));
      path.focus();
    }
  }

  private async openSources() {
    this.chooser = "sources";
    this.drawChooser();
    this.chooserBox.replaceChildren(h("p", { class: "muted" }, "Looking for screens and windows…"));
    const r = await this.client.call({ type: "capture-sources" }, true);
    if (this.chooser !== "sources") return;
    if (!r.ok) {
      this.chooserBox.replaceChildren(h("div", { class: "notice bad" }, icon("warning"), h("span", {}, r.error)), this.permissionHelp());
      return;
    }
    const sources = r.sources ?? [];
    const group = (kind: CaptureSource["kind"], title: string) => {
      const list = sources.filter((x) => x.kind === kind);
      return list.length
        ? h("div", { class: "source-group" }, h("h3", {}, title), h("ul", { class: "source-list" }, ...list.map((src) => h("li", {}, h("button", { type: "button", class: "source", onclick: () => void this.capture(src) }, icon(kind === "screen" ? "screen" : "window"), h("span", {}, src.name))))))
        : null;
    };
    this.chooserBox.replaceChildren(
      h("p", { class: "hint" }, "Pick one and Dum takes a single still image for you to look at. Nothing is sent until you send your message."),
      ...(sources.length ? [group("screen", "Screens"), group("window", "Windows")].filter((x) => x !== null) : [h("p", { class: "muted" }, "No screens or windows to share."), this.permissionHelp()]),
    );
    this.chooserBox.querySelector<HTMLElement>("button.source")?.focus();
  }

  private permissionHelp(): HTMLElement {
    return h(
      "div",
      { class: "notice" },
      h("span", {}, "macOS decides whether Dum may record the screen."),
      h("button", { type: "button", class: "btn ghost small", onclick: () => void this.client.call({ type: "screen-permission" }) }, icon("external"), "Open settings"),
    );
  }

  private async capture(src: CaptureSource) {
    const binding = this.client.requestBinding();
    if (!binding) return;
    this.chooserBox.replaceChildren(h("p", { class: "muted" }, `Taking one image of ${src.name}…`));
    const r = await this.client.call({ type: "capture-preview", sourceId: src.id, binding }, true);
    if (!r.ok || !r.preview) {
      this.chooserBox.replaceChildren(h("div", { class: "notice bad" }, icon("warning"), h("span", {}, r.ok ? "No image came back. Nothing was shared." : r.error)), this.permissionHelp());
      return;
    }
    this.preview = r.preview;
    this.chooser = null;
    this.drawChooser();
    this.drawPreview();
    this.focus();
  }

  private drawPreview() {
    this.previewCard.hidden = !this.preview;
    if (this.preview) {
      this.previewImg.src = this.preview.dataUrl;
      this.previewImg.alt = `Preview of ${this.preview.name}`;
      this.previewName.textContent = this.preview.name;
    } else this.previewImg.removeAttribute("src");
    this.sync();
  }

  private async discard() {
    const token = this.preview?.token;
    if (!token || this.sending) return;
    this.preview = null;
    this.drawPreview();
    await this.client.call({ type: "capture-discard", token }, true);
    this.focus();
  }
}

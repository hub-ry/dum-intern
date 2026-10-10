// The Settings panel: a list of plain rows, "Agent · Claude", "Look · Haiku", "Mode · Understand", …
// Pressing a row reveals its control beneath it, one at a time. Choices are segmented text, switches
// are flat mechanical toggles. Rows start collapsed unless one needs recovering.

import type { CircleDisplays, DesktopPreferences, Snapshot } from "../protocol.ts";
import type { BackendId } from "../../agent/types.ts";
import { h, type Client } from "./dom.ts";
import { AgentSheet } from "./agent-sheet.ts";
import { DebugView, NEEDS_AGENT } from "./debug-view.ts";

type Hotkey = "hotkey" | "voiceHotkey" | "sendDraftHotkey";

const PERMISSION: Record<string, string> = {
  granted: "Screen Recording: allowed.",
  denied: "Screen Recording: blocked in System Settings.",
  restricted: "Screen Recording: restricted on this Mac.",
  "not-determined": "Screen Recording: macOS asks the first time Dum looks.",
  "not-required": "Screen Recording: no permission needed on this system.",
  unknown: "Screen Recording: status unknown.",
};

const PERSONAL: Record<Snapshot["personal"]["status"], string> = {
  off: "Off. Dum reads no personal file.",
  loaded: "On. Dum reads these files:",
  missing: "On, but no personal context file was found.",
  unreadable: "On, but the file couldn't be read.",
};

/** An Electron accelerator from a key press, or "" when it isn't a usable shortcut yet. */
export function pressed(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">, mac: boolean): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(mac ? "Command" : "Super");
  let key = "";
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (e.code === "Space") key = "Space";
  else if (e.code === "Enter") key = "Return";
  else if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) key = e.code.slice(5);
  return key && (e.ctrlKey || e.altKey || e.metaKey) ? [...mods, key].join("+") : "";
}

/** How a shortcut reads on this platform: ⌃⌥Space on a Mac, Ctrl + Alt + Space elsewhere. */
export function shortcutText(acc: string, mac: boolean): string {
  if (!acc) return "none";
  if (!mac) return acc.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl").replace(/\+/g, " + ");
  const sym: Record<string, string> = { Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Super: "⌘", Return: "↩" };
  return acc.split("+").map((p) => sym[p] ?? p).join("");
}

/** One settings row: its name and current value; pressing it reveals `body` beneath. */
function disclosure(title: string, value: HTMLElement, ...body: (Node | null)[]): HTMLDetailsElement {
  return h("details", { class: "row disclosure" }, h("summary", {}, h("span", { class: "row-name" }, title), value), h("div", { class: "row-body" }, ...body));
}

/** A switch: a checkbox drawn as a flat mechanical toggle, its name on the left. */
function toggleRow(input: HTMLInputElement, label: string, ...after: (Node | null)[]): HTMLElement {
  input.className = "toggle";
  input.setAttribute("role", "switch");
  return h("div", { class: "row" }, h("label", { class: "toggle-row" }, h("span", { class: "row-name" }, label), input), ...after);
}

const BACKENDS: Record<BackendId, string> = { claude: "Claude", chatgpt: "ChatGPT", copilot: "Copilot" };

const MODES: Record<DesktopPreferences["mode"], string> = {
  understand: "Dum implements with skills you've unlocked; concepts need work you built yourself.",
  "anti-vibe": "The same gates, with your approach first: say how you want it done, then delegate.",
};

/** Move circle: choose a display, or nudge it with arrows (Shift for 1 DIP), Enter commits, Esc restores. */
class MoveCircle {
  readonly el = h("div", { class: "move-circle", tabindex: "0", hidden: true, "aria-label": "Move the circle with the arrow keys" });
  private displays: CircleDisplays | null = null;

  constructor(private client: Client) {
    this.el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 10;
      const move = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (move) {
        e.preventDefault();
        void this.call({ type: "circle-nudge", dx: move[0]!, dy: move[1]! });
      } else if (e.key === "Enter" && e.target === this.el) {
        e.preventDefault();
        void this.commit();
      }
    });
  }

  get active(): boolean {
    return !this.el.hidden;
  }

  async begin() {
    this.el.hidden = false;
    await this.call({ type: "circle-position", action: "begin" });
    this.el.focus();
  }

  /** Esc: puts the circle back where it was. */
  cancel() {
    if (this.displays?.positioning) void this.client.call({ type: "circle-position", action: "cancel" }, true);
    this.displays = null;
    this.el.hidden = true;
  }

  private async commit() {
    await this.call({ type: "circle-position", action: "commit" });
    this.displays = null;
    this.el.hidden = true;
  }

  private async call(request: Parameters<Client["call"]>[0]) {
    const r = await this.client.call(request);
    if (r.ok && r.displays) {
      this.displays = r.displays;
      this.draw();
    }
  }

  private draw() {
    const d = this.displays;
    this.el.replaceChildren(
      h("p", { class: "hint" }, "Arrows move it, Shift for small steps. Enter keeps it, Esc puts it back."),
      h(
        "ul",
        { class: "display-list", "aria-label": "Displays" },
        ...(d?.displays ?? []).map((x) =>
          h("li", {}, h("button", { type: "button", class: `btn ghost small${x.current ? " picked" : ""}`, "aria-pressed": String(x.current), onclick: () => void this.call({ type: "circle-display", displayId: x.id }) }, x.label, x.primary ? " (main)" : "")),
        ),
      ),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary small", onclick: () => void this.commit() }, "Keep it here")),
    );
  }
}

export class SettingsView {
  readonly el: HTMLElement;
  private agentSheet: AgentSheet;
  private debug: DebugView;
  private agent: HTMLDetailsElement;
  private look: HTMLDetailsElement;
  private shortcuts: HTMLDetailsElement;
  private debugBox: HTMLDetailsElement;
  private move: MoveCircle;
  private lookBoxes = { apps: h("input", { type: "checkbox" }), screen: h("input", { type: "checkbox" }) };
  private launchAtLogin = h("input", { type: "checkbox" });
  private personalContext = h("input", { type: "checkbox" });
  private modeChoices: Record<DesktopPreferences["mode"], HTMLButtonElement>;
  private modeHint = h("p", { id: "mode-hint", class: "hint" });
  private mode: HTMLDetailsElement;
  private values = { agent: h("span", { class: "row-value" }), look: h("span", { class: "row-value" }), mode: h("span", { class: "row-value" }), shortcuts: h("span", { class: "row-value" }), voice: h("span", { class: "row-value" }), debug: h("span", { class: "row-value" }) };
  private screenStatus = h("p", { class: "hint" });
  private personalStatus = h("div", { class: "hint" });
  private hotkeyError = h("p", { class: "hint error-text", role: "alert" });
  private versionLine = h("span", { class: "label" });
  private recorders = new Map<Hotkey, HTMLInputElement>();
  private recording: HTMLInputElement | null = null;
  private recovered = "";

  constructor(private client: Client) {
    this.agentSheet = new AgentSheet(client);
    this.debug = new DebugView(client);
    this.move = new MoveCircle(client);
    this.agent = disclosure("Agent", this.values.agent, this.agentSheet.el);
    this.look = disclosure(
      "Look",
      this.values.look,
      toggleRow(this.lookBoxes.apps, "Notice app switches"),
      toggleRow(this.lookBoxes.screen, "Look at the screen"),
      this.screenStatus,
      h("button", { type: "button", class: "text-action", onclick: () => void client.call({ type: "screen-permission" }) }, "Open Screen Recording settings"),
    );
    const choice = (mode: DesktopPreferences["mode"], label: string) =>
      h("button", { type: "button", class: "seg", "aria-pressed": "false", onclick: () => void this.save({ mode }) }, label);
    this.modeChoices = { understand: choice("understand", "Understand"), "anti-vibe": choice("anti-vibe", "Anti-vibe") };
    this.mode = disclosure("Mode", this.values.mode, h("div", { class: "segmented", role: "group", "aria-label": "Mode", "aria-describedby": "mode-hint" }, this.modeChoices.understand, this.modeChoices["anti-vibe"]), this.modeHint);
    this.shortcuts = disclosure(
      "Shortcuts",
      this.values.shortcuts,
      this.recorder("hotkey", "Open Dum"),
      this.recorder("voiceHotkey", "Hold to talk"),
      this.recorder("sendDraftHotkey", "Send the draft"),
      h("p", { id: "hotkey-hint", class: "hint" }, "Click one, then press a shortcut with ⌘, ⌃ or ⌥."),
      this.hotkeyError,
    );
    const voice = disclosure("Voice", this.values.voice, h("button", { type: "button", class: "text-action", onclick: () => void client.call({ type: "voice-setup" }) }, "Set up voice"));
    this.debugBox = disclosure("Debug chat", this.values.debug, this.debug.el);
    this.debugBox.addEventListener("toggle", () => {
      if (this.debugBox.open) void this.debug.open();
    });
    this.lookBoxes.apps.addEventListener("change", () => client.snap && void this.save({ look: { ...client.snap.settings.look, apps: this.lookBoxes.apps.checked } }));
    this.lookBoxes.screen.addEventListener("change", () => client.snap && void this.save({ look: { ...client.snap.settings.look, screen: this.lookBoxes.screen.checked } }));
    this.launchAtLogin.addEventListener("change", () => void this.save({ launchAtLogin: this.launchAtLogin.checked }));
    this.personalContext.addEventListener("change", () => void this.save({ personalContext: this.personalContext.checked }));
    const rows = [this.agent, this.look, this.mode, this.shortcuts, voice, this.debugBox];
    // Only the row you opened stays open.
    for (const row of rows) row.addEventListener("toggle", () => {
      if (row.open) for (const other of rows) if (other !== row) other.open = false;
    });
    const body = h(
      "div",
      { class: "panel-body settings" },
      this.agent,
      this.look,
      this.mode,
      this.shortcuts,
      h("div", { class: "row" }, h("button", { type: "button", class: "row-button", onclick: () => void this.move.begin() }, h("span", { class: "row-name" }, "Move circle")), this.move.el),
      toggleRow(this.launchAtLogin, "Open at login"),
      toggleRow(this.personalContext, "Use personal context", this.personalStatus),
      voice,
      this.debugBox,
      h("div", { class: "settings-foot" }, this.versionLine, h("button", { type: "button", class: "text-action quiet", onclick: () => void client.call({ type: "quit" }) }, "Quit Dum")),
    );
    body.addEventListener(NEEDS_AGENT, () => this.openAgent());
    this.el = h(
      "section",
      { class: "panel panel-settings", "aria-labelledby": "settings-title" },
      h("header", { class: "panel-head" }, h("h1", { id: "settings-title", tabindex: "-1" }, "Settings")),
      body,
    );
  }

  focus() {
    this.el.querySelector<HTMLElement>("summary")?.focus();
  }

  /** "Who powers Dum?": opens Agent and puts focus in it. */
  openAgent() {
    this.agent.open = true;
    this.agentSheet.focus();
  }

  /** True when focus is in the debug chat, so ⌘. stops it rather than the goal's conversation. */
  get debugFocused(): boolean {
    return this.debugBox.open && this.debug.el.contains(document.activeElement);
  }

  stopDebug() {
    void this.debug.stop();
  }

  /** Leaving Settings hides the debug chat and puts the circle back if a move was open. */
  closed() {
    this.debugBox.open = false;
    if (this.move.active) this.move.cancel();
  }

  /** Esc: a circle move puts it back; inside an open disclosure, collapses it. True when it did either. */
  escape(): boolean {
    if (this.move.active) {
      this.move.cancel();
      return true;
    }
    const box = document.activeElement?.closest("details.disclosure");
    if (!(box instanceof HTMLDetailsElement) || !box.open || !this.el.contains(box)) return false;
    box.open = false;
    box.querySelector("summary")?.focus();
    return true;
  }

  update(s: Snapshot) {
    const mac = s.platform === "darwin";
    this.agentSheet.update(s);
    this.debug.update(s.debug);
    for (const [name, input] of this.recorders) if (input !== this.recording) input.value = shortcutText(s.settings[name], mac);
    this.hotkeyError.textContent = s.hotkeyError;
    this.hotkeyError.hidden = !s.hotkeyError;
    const keep = (el: HTMLInputElement) => document.activeElement === el;
    if (!keep(this.lookBoxes.apps)) this.lookBoxes.apps.checked = s.settings.look.apps;
    if (!keep(this.lookBoxes.screen)) this.lookBoxes.screen.checked = s.settings.look.screen;
    if (!keep(this.launchAtLogin)) this.launchAtLogin.checked = s.settings.launchAtLogin;
    if (!keep(this.personalContext)) this.personalContext.checked = s.settings.personalContext;
    for (const [mode, btn] of Object.entries(this.modeChoices)) btn.setAttribute("aria-pressed", String(mode === s.settings.mode));
    this.modeHint.textContent = MODES[s.settings.mode];
    const chosen = s.agent.chosen;
    this.values.agent.textContent = chosen ? BACKENDS[chosen.backend] : "Not set";
    this.values.look.textContent = s.look.paused ? "Paused" : !s.settings.look.apps && !s.settings.look.screen ? "Off" : chosen ? s.look.resolved ?? chosen.look.model : "No model";
    this.values.mode.textContent = s.settings.mode === "anti-vibe" ? "Anti-vibe" : "Understand";
    this.values.shortcuts.textContent = shortcutText(s.settings.hotkey, mac);
    this.values.voice.textContent = { idle: "Idle", recording: "Listening", transcribing: "Transcribing", ready: "Ready", error: "Error" }[s.voice.phase];
    this.values.debug.textContent = s.debug ? s.debug.state : "";
    this.screenStatus.textContent = PERMISSION[s.look.permission] ?? `Screen Recording: ${s.look.permission}.`;
    const p = s.personal;
    this.personalStatus.replaceChildren(
      h("p", {}, PERSONAL[p.status]),
      ...(p.files.length ? [h("ul", { class: "personal-files" }, ...p.files.map((f) => h("li", {}, h("code", {}, f))))] : []),
      ...(p.warning ? [h("p", { class: "warn-text" }, p.warning)] : []),
    );
    this.versionLine.textContent = `DUM ${s.version}`;
    // Recovery opens its disclosure once; after that it's yours to close.
    const recovery = [
      !s.agent.chosen ? "agent" : "",
      s.hotkeyError ? "shortcuts" : "",
      s.settings.look.screen && s.look.permission === "denied" ? "look" : "",
    ].filter(Boolean).join(",");
    if (recovery !== this.recovered) {
      this.recovered = recovery;
      if (recovery.includes("agent")) this.agent.open = true;
      if (recovery.includes("shortcuts")) this.shortcuts.open = true;
      if (recovery.includes("look")) this.look.open = true;
    }
  }

  private async save(patch: Partial<DesktopPreferences>) {
    const s = this.client.snap;
    if (!s) return;
    const r = await this.client.call({ type: "settings", settings: { ...s.settings, ...patch } });
    // A refused setting puts the switches back the way main has them.
    if (!r.ok && this.client.snap) {
      const now = this.client.snap.settings;
      this.lookBoxes.apps.checked = now.look.apps;
      this.lookBoxes.screen.checked = now.look.screen;
      this.launchAtLogin.checked = now.launchAtLogin;
      this.personalContext.checked = now.personalContext;
    }
  }

  private recorder(name: Hotkey, label: string): HTMLElement {
    const input = h("input", { class: "line-input hotkey", type: "text", readonly: true, "aria-label": label, "aria-describedby": "hotkey-hint" });
    input.addEventListener("focus", () => {
      this.recording = input;
      input.value = "press a shortcut…";
    });
    input.addEventListener("blur", () => {
      this.recording = null;
      if (this.client.snap) input.value = shortcutText(this.client.snap.settings[name], this.client.snap.platform === "darwin");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return input.blur();
      const acc = pressed(e, this.client.snap?.platform === "darwin");
      if (!acc) return;
      input.blur();
      void this.save({ [name]: acc });
    });
    this.recorders.set(name, input);
    return h("label", { class: "key-row" }, h("span", { class: "row-name" }, label), input);
  }
}

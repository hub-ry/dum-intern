// Settings, as a sheet inside Chat: exactly the §5 list. Agent; Look; Shortcuts; Open at login; Use
// personal context; Set up voice; Debug chat; version and Quit. Disclosures start collapsed unless one
// needs recovering. Mode lives in Chat, follow in Context, the web tree in Skills, Pause in Current context.

import type { DesktopPreferences, Snapshot } from "../protocol.ts";
import { h, icon, type Client } from "./dom.ts";
import { AgentSheet } from "./agent-sheet.ts";
import { DebugView, NEEDS_AGENT } from "./debug-view.ts";

type Hotkey = "hotkey" | "voiceHotkey" | "sendDraftHotkey";

const PERMISSION: Record<string, string> = {
  granted: "Screen Recording: allowed.",
  denied: "Screen Recording: blocked in System Settings. Dum keeps watching app switches and saved files until you allow it.",
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

function disclosure(title: string, ...body: (Node | null)[]): HTMLDetailsElement {
  return h("details", { class: "group disclosure" }, h("summary", {}, icon("chevron"), h("span", {}, title)), ...body);
}

export class SettingsView {
  readonly el = h("div", { class: "settings" });
  private agentSheet: AgentSheet;
  private debug: DebugView;
  private agent: HTMLDetailsElement;
  private look: HTMLDetailsElement;
  private shortcuts: HTMLDetailsElement;
  private debugBox: HTMLDetailsElement;
  private lookBoxes = { apps: h("input", { type: "checkbox" }), screen: h("input", { type: "checkbox" }) };
  private launchAtLogin = h("input", { type: "checkbox" });
  private personalContext = h("input", { type: "checkbox" });
  private lookStatus = h("p", { class: "hint", role: "status" });
  private screenStatus = h("p", { class: "hint" });
  private personalStatus = h("div", { class: "hint" });
  private voiceStatus = h("p", { class: "hint", role: "status" });
  private hotkeyError = h("p", { class: "hint error-text", role: "alert" });
  private versionLine = h("p", { class: "hint" });
  private recorders = new Map<Hotkey, HTMLInputElement>();
  private recording: HTMLInputElement | null = null;
  private recovered = "";

  constructor(private client: Client) {
    this.agentSheet = new AgentSheet(client, "settings");
    this.debug = new DebugView(client);
    this.agent = disclosure("Agent", this.agentSheet.el);
    this.look = disclosure(
      "Look",
      h("p", { class: "hint" }, "Every 3 seconds Dum checks which app is in front, how much the screen changed and the folders you follow. It calls the look model only when something changed: one fresh frame of the screen for each eligible changed tick, plus a line about what it saw last, never older pictures. One call at a time. It never reads keystrokes, the clipboard or your editor, and it never teaches or advises."),
      this.lookStatus,
      h("label", { class: "check" }, this.lookBoxes.apps, h("span", {}, "Apps: notice when you switch apps")),
      h("label", { class: "check" }, this.lookBoxes.screen, h("span", {}, "Screen: notice screen changes and send the look model one fresh frame per changed tick")),
      this.screenStatus,
      h("button", { type: "button", class: "btn ghost", onclick: () => void client.call({ type: "screen-permission" }) }, icon("external"), "Open Screen Recording settings"),
      h("p", { class: "hint" }, "Pause and Resume are in Current context. Turning Screen off keeps app and file observation."),
    );
    this.shortcuts = disclosure(
      "Shortcuts",
      this.recorder("hotkey", "Open Dum"),
      this.recorder("voiceHotkey", "Hold to talk"),
      this.recorder("sendDraftHotkey", "Send the draft"),
      h("p", { id: "hotkey-hint", class: "hint" }, "Click a field, then press the new shortcut. It needs ⌘, ⌃ or ⌥. Esc cancels. Send the draft only ever sends the zone's message, never the debug chat."),
      this.hotkeyError,
    );
    this.debugBox = disclosure("Debug chat", this.debug.el);
    this.debugBox.addEventListener("toggle", () => {
      if (this.debugBox.open) void this.debug.open();
    });
    this.el.addEventListener(NEEDS_AGENT, () => {
      this.agent.open = true;
      this.agentSheet.focus();
    });
    this.lookBoxes.apps.addEventListener("change", () => client.snap && void this.save({ look: { ...client.snap.settings.look, apps: this.lookBoxes.apps.checked } }));
    this.lookBoxes.screen.addEventListener("change", () => client.snap && void this.save({ look: { ...client.snap.settings.look, screen: this.lookBoxes.screen.checked } }));
    this.launchAtLogin.addEventListener("change", () => void this.save({ launchAtLogin: this.launchAtLogin.checked }));
    this.personalContext.addEventListener("change", () => void this.save({ personalContext: this.personalContext.checked }));
    this.el.append(
      this.agent,
      this.look,
      this.shortcuts,
      h("div", { class: "group" }, h("label", { class: "check" }, this.launchAtLogin, h("span", {}, "Open at login")), h("p", { class: "hint" }, "Starts the circle and Dum's host, not the window.")),
      h(
        "div",
        { class: "group" },
        h("label", { class: "check" }, this.personalContext, h("span", {}, "Use personal context")),
        this.personalStatus,
        h("p", { class: "hint" }, "Background about you that shapes decisions and suggested projects. It never adds skills. Edit the file yourself, then Reload context from Current context."),
      ),
      h("div", { class: "group" }, h("button", { type: "button", class: "btn ghost", onclick: () => void client.call({ type: "voice-setup" }) }, icon("mic"), "Set up voice"), this.voiceStatus),
      this.debugBox,
      h("div", { class: "group settings-foot" }, this.versionLine, h("button", { type: "button", class: "btn danger", onclick: () => void client.call({ type: "quit" }) }, icon("power"), "Quit Dum")),
    );
  }

  /** True when focus is in the debug chat, so ⌘. stops it rather than the zone. */
  get debugFocused(): boolean {
    return this.debugBox.open && this.debug.el.contains(document.activeElement);
  }

  stopDebug() {
    void this.debug.stop();
  }

  /** Closing Settings hides the debug chat; New or Clear starts a new one. */
  closed() {
    this.debugBox.open = false;
  }

  /** Esc inside an open disclosure collapses it and puts focus on its title; true when it did. */
  escape(): boolean {
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
    this.lookStatus.textContent = s.look.paused ? "Looking is paused." : s.look.noPictures ? `No pictures: ${s.look.noPictures}` : "Looking is on.";
    this.screenStatus.textContent = PERMISSION[s.look.permission] ?? `Screen Recording: ${s.look.permission}.`;
    const p = s.personal;
    this.personalStatus.replaceChildren(
      h("p", {}, PERSONAL[p.status]),
      ...(p.files.length ? [h("ul", { class: "personal-files" }, ...p.files.map((f) => h("li", {}, h("code", {}, f))))] : []),
      ...(p.warning ? [h("p", { class: "warn-text" }, p.warning)] : []),
    );
    this.voiceStatus.textContent = s.voice.status || "Voice is idle.";
    this.versionLine.textContent = `Dum ${s.version} · ${s.platform}`;
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
    const input = h("input", { class: "input hotkey", type: "text", readonly: true, "aria-label": label, "aria-describedby": "hotkey-hint" });
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
    return h("label", { class: "field" }, h("span", {}, label), input);
  }
}

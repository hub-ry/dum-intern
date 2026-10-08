// The full panel: the conversation, zones, the skill tree, every note pane, changes and settings.
// Normally hidden; the menu bar, the command bar and the hotkey open it. Everything is reachable by keyboard.

import type { DesktopPreferences, Panel, Snapshot, TreeSync } from "../protocol.ts";
import type { State } from "../../store-types.ts";
import type { View } from "../../web/view.ts";
import { ZONE_LIMITS } from "../../zone-types.ts";
import { Client, h, icon, iconButton, plain, type IconName } from "./dom.ts";
import { Transcript } from "./transcript.ts";
import { SkillTree } from "./tree.ts";
import { Creature } from "./sprites.ts";
import { Composer } from "./composer.ts";
import { ZoneTree, zonePath } from "./zones.ts";
import { ChangesPane } from "./change-view.ts";
import { AgentSheet } from "./agent-sheet.ts";

type Pane = "chat" | Panel;

const PANES: Record<Pane, { label: string; icon: IconName; needsZone: boolean }> = {
  chat: { label: "Conversation", icon: "send", needsZone: true },
  zones: { label: "Zones", icon: "zones", needsZone: false },
  tree: { label: "Skills", icon: "tree", needsZone: false },
  memory: { label: "Memory", icon: "memory", needsZone: true },
  history: { label: "History", icon: "history", needsZone: true },
  context: { label: "Context", icon: "context", needsZone: true },
  evidence: { label: "Evidence", icon: "evidence", needsZone: true },
  boundary: { label: "Boundary", icon: "boundary", needsZone: true },
  projects: { label: "Suggested projects", icon: "tools", needsZone: true },
  changes: { label: "Changes", icon: "undo", needsZone: true },
  settings: { label: "Settings", icon: "gear", needsZone: false },
};
/** Panes whose text the host writes into the stage when asked. */
const TEXT_PANES: Pane[] = ["memory", "history", "context", "evidence", "boundary", "projects"];

const MODES: Record<DesktopPreferences["mode"], string> = {
  understand: "Dum can implement with skills you've unlocked. Concepts need work you've built yourself. Tools need you to know what they're for.",
  "anti-vibe": "The same skill gates, with your approach first. Tell Dum how you want it done, then delegate the unlocked parts. Explaining an approach doesn't count as building a skill.",
};

const PERMISSION: Record<string, string> = {
  granted: "Screen Recording: allowed.",
  denied: "Screen Recording: blocked in System Settings. Dum looks at app switches and saved files only until you allow it.",
  restricted: "Screen Recording: restricted on this Mac.",
  "not-determined": "Screen Recording: macOS asks the first time Dum looks.",
};

/** An Electron accelerator from a key press, or "" when it isn't a usable shortcut yet. */
function pressed(e: KeyboardEvent, mac: boolean): string {
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

function tierInfo(tree: View | null): { pct: number; tier: "newbie" | "intern" | "good" | "cracked"; built: number } {
  const built = tree?.usableBuilt ?? 0;
  return { pct: Math.min(built / 64, 1), tier: built >= 64 ? "cracked" : built >= 24 ? "good" : built >= 8 ? "intern" : "newbie", built };
}

export function panel() {
  const client = new Client();
  let pane: Pane = "chat";
  let awaiting: Pane | null = null;
  let wantAgent = false;
  let shownStage = "";
  let dismissedStage = "";
  let shownZone: string | null | undefined;
  let forceBottom = false;
  const mac = () => client.snap?.platform === "darwin";

  // -- header ---------------------------------------------------------------

  const face = new Creature("dum", 3);
  const crumb = h("span", { class: "crumb-text" }, "no zone");
  const crumbBtn = h("button", { type: "button", class: "crumb-btn", title: "Zones", onclick: () => void show("zones") }, icon("zones"), crumb);
  const tierFill = h("div", { class: "tier-fill tier-newbie" });
  const tierBar = h("div", { class: "tier-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "64", hidden: true }, tierFill);
  const tierName = h("span", { class: "tier-name", hidden: true });
  const lookBtn = h("button", {
    type: "button", class: "look-pill",
    onclick: () => {
      const s = client.snap;
      if (s) void client.call({ type: "look-pause", paused: !s.look.paused });
    },
  });
  const header = h(
    "header",
    { class: "top" },
    h("div", { class: "face" }, face.canvas),
    crumbBtn,
    h("span", { class: "spacer" }),
    tierName,
    lookBtn,
    iconButton("hide", "Hide (Esc)", () => void client.call({ type: "dismiss-surface", surface: "panel" })),
    tierBar,
  );

  // -- navigation: a tablist; arrows move, Enter or Space opens -------------

  const tabs = new Map<Pane, HTMLButtonElement>();
  const nav = h("nav", { class: "panes", role: "tablist", "aria-label": "Panel", "aria-orientation": "horizontal" });
  for (const [name, meta] of Object.entries(PANES) as [Pane, (typeof PANES)[Pane]][]) {
    const tab = h("button", { type: "button", role: "tab", class: "pane-tab", id: `tab-${name}`, "aria-controls": "pane", tabindex: "-1", onclick: () => void show(name) }, icon(meta.icon), h("span", {}, meta.label));
    tabs.set(name, tab);
    nav.append(tab);
  }
  nav.addEventListener("keydown", (e) => {
    const list = [...tabs.values()].filter((t) => !t.disabled);
    const i = list.findIndex((t) => t === document.activeElement);
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? list[(i + 1) % list.length] : e.key === "ArrowLeft" || e.key === "ArrowUp" ? list[(i - 1 + list.length) % list.length] : e.key === "Home" ? list[0] : e.key === "End" ? list[list.length - 1] : undefined;
    if (!to) return;
    e.preventDefault();
    to.focus();
  });

  // -- the conversation -----------------------------------------------------

  const agentSetup = new AgentSheet(client, "setup", () => {
    wantAgent = false;
    composer.focus();
  });
  const composer = new Composer({
    client,
    needsAgent: () => {
      wantAgent = true;
      void show("chat").then(() => agentSetup.focus());
    },
  });
  const transcript = new Transcript(client);
  const firstRun = h(
    "section",
    { class: "first-run", hidden: true, "aria-labelledby": "first-run-title" },
    h("h1", { id: "first-run-title", tabindex: "-1" }, "What are you trying to learn?"),
    h("p", { class: "muted" }, "Say it in your own words, typed or by voice. It becomes your first zone. You can rename it, nest zones inside it and add more later. Nothing is sent to a model."),
  );
  const agentBanner = h(
    "div",
    { class: "notice", hidden: true },
    h("span", {}, "Dum isn't powered yet. Zones, skills and notes work without it."),
    h("button", {
      type: "button", class: "btn small",
      onclick: () => {
        wantAgent = true;
        render();
        agentSetup.focus();
      },
    }, "Who powers Dum?"),
  );
  const stageTitle = h("h3", {});
  const stageBody = h("pre", { class: "info-text" });
  const stageCard = h(
    "div",
    { class: "stage-card", hidden: true, role: "region", "aria-label": "Dum's answer" },
    h("div", { class: "stage-head" }, stageTitle, h("span", { class: "spacer" }), iconButton("close", "Dismiss", () => {
      dismissedStage = shownStage;
      stageCard.hidden = true;
    }, "", "icon-btn tiny")),
    stageBody,
  );
  const empty = h("div", { class: "empty" }, h("p", {}, "Build on your own. Dum can wait."), h("p", { class: "muted" }, "Ask about anything you're stuck on, or tell Dum what you built and why. Share files from the message box. If you want Dum to change a file, ask; it still checks your skills, and you can revert any change."));
  const scroller = h("div", { class: "scroller" }, agentBanner, agentSetup.el, stageCard, transcript.el, empty);
  const chat = h("div", { class: "chat" }, firstRun, scroller, h("footer", { class: "dock" }, composer.el));

  // -- other panes ----------------------------------------------------------

  const zones = new ZoneTree(client);
  const tree = new SkillTree({ projects: (arg) => void command("projects", arg) });
  const changes = new ChangesPane(client);
  const infoText = h("pre", { class: "info-text" });
  const paneTitle = h("h2", { id: "pane-title", tabindex: "-1" });
  const paneBody = h("div", { class: "pane-body" });
  const paneEl = h("section", { class: "pane", id: "pane", role: "tabpanel", "aria-labelledby": "pane-title" }, paneTitle, paneBody);

  async function command(name: "inspect" | "projects" | "submit" | "remember", argument: string) {
    const binding = client.requestBinding();
    if (!binding) return client.showError("Enter a zone first.");
    const r = await client.call({ type: "command", name, argument, binding });
    if (r.ok && name !== "remember") {
      forceBottom = true;
      void show("chat");
    }
    return r;
  }

  const form = (label: string, input: HTMLInputElement, submit: string, run: (value: string) => Promise<unknown>, hint = "") => {
    const f = h("form", { class: "tool" }, h("label", { class: "field" }, h("span", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null), h("button", { type: "submit", class: "btn" }, submit));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      await run(input.value.trim());
      input.value = "";
    });
    return f;
  };
  const textInput = (placeholder: string) => h("input", { class: "input", type: "text", spellcheck: "false", placeholder });

  const memoryExtras = h(
    "div",
    { class: "pane-extras" },
    form("Remember a note", textInput("e.g. I prefer small functions"), "Remember", async (note) => {
      const r = await command("remember", note);
      if (r?.ok) void client.call({ type: "panel", panel: "memory" });
    }, "Notes stay in this zone and come back next time. They never count as evidence."),
    h("button", { type: "button", class: "link-btn", onclick: () => void client.call({ type: "open-record", record: "memory" }) }, icon("external"), h("span", {}, "open the memory file to edit it")),
  );

  const contextText = h("textarea", { class: "input", rows: "6", "aria-label": "Notes for this zone" });
  const contextGoal = h("p", { class: "hint" });
  const contextForm = h("form", { class: "tool" }, h("h3", {}, "Notes for this zone"), contextGoal, contextText, h("p", { class: "hint" }, "Background Dum reads in this zone and the zones inside it. It's context, never permission."), h("button", { type: "submit", class: "btn" }, "Save notes"));
  contextForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = client.snap;
    if (!s?.activeZone) return;
    if (new TextEncoder().encode(contextText.value).length > ZONE_LIMITS.contextBytes) return client.showError("Those notes are too long.");
    const r = await client.call({ type: "zone-context", id: s.activeZone.id, text: contextText.value, expectedRevision: s.zones.revision });
    if (r.ok) void client.call({ type: "panel", panel: "context" });
  });
  const contextExtras = h("div", { class: "pane-extras" }, contextForm);

  const unaided = h("input", { type: "checkbox" });
  const submitTask = textInput("p1");
  const submitFiles = textInput("src/walk.rs src/tree.rs");
  const handIn = h(
    "form",
    { class: "tool" },
    h("h3", {}, "Hand in a project"),
    h("label", { class: "field" }, h("span", {}, "Project"), submitTask),
    h("label", { class: "field" }, h("span", {}, "Files"), submitFiles, h("span", { class: "hint" }, "Share the files from the message box first, then name them here.")),
    h("label", { class: "check" }, unaided, h("span", {}, "I wrote this myself, without AI help or copied code")),
    h("button", { type: "submit", class: "btn" }, "Hand it in"),
  );
  handIn.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!submitTask.value.trim()) return submitTask.focus();
    if (!submitFiles.value.trim()) return submitFiles.focus();
    const r = await command("submit", `${submitTask.value.trim()} ${submitFiles.value.trim()}${unaided.checked ? " --unaided" : ""}`);
    if (r?.ok) {
      submitTask.value = "";
      submitFiles.value = "";
      unaided.checked = false;
    }
  });
  const projectsExtras = h(
    "div",
    { class: "pane-extras" },
    h(
      "div",
      { class: "tool" },
      h("h3", {}, "Suggested projects"),
      h("p", { class: "hint" }, "Projects sized to what you're learning, using your skill tree, this zone and its notes. You build them yourself."),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn", onclick: () => void command("projects", "new") }, "Suggest projects for this zone"),
        h("button", { type: "button", class: "btn ghost", onclick: () => void command("projects", "stop") }, "Stop the project I'm on"),
      ),
    ),
    form("Projects for one skill", textInput("recursion in rust"), "Suggest", (skill) => command("projects", skill)),
    form("Start a project", textInput("p1"), "Start", (id) => command("projects", `start ${id}`), "While you're on a project, the Wizard keeps quiet."),
    handIn,
  );

  // -- settings -------------------------------------------------------------

  const agentSettings = new AgentSheet(client, "settings");
  async function save(patch: Partial<DesktopPreferences>) {
    const s = client.snap;
    if (!s) return;
    const r = await client.call({ type: "settings", settings: { ...s.settings, ...patch } });
    if (!r.ok) renderSettings(s, true);
  }
  const box = (onChange: (checked: boolean) => void) => {
    const el = h("input", { type: "checkbox" });
    el.addEventListener("change", () => onChange(el.checked));
    return el;
  };
  const look = {
    apps: box((apps) => client.snap && void save({ look: { ...client.snap.settings.look, apps } })),
    screen: box((screen) => client.snap && void save({ look: { ...client.snap.settings.look, screen } })),
  };
  const toggles = {
    launchAtLogin: box((launchAtLogin) => void save({ launchAtLogin })),
    personalContext: box((personalContext) => void save({ personalContext })),
  };
  const lookStatus = h("p", { class: "hint", role: "status" });
  const lookPause = h("button", { type: "button", class: "btn ghost", onclick: () => client.snap && void client.call({ type: "look-pause", paused: !client.snap.look.paused }) });
  const screenStatus = h("p", { class: "hint" });
  const follows = h("ul", { class: "follows" });
  const followAdd = h("button", { type: "button", class: "btn ghost", onclick: () => void client.call({ type: "follow-add" }) }, icon("plus"), "Follow a folder…");
  const modeSelect = h("select", { class: "input", "aria-label": "Mode" }, h("option", { value: "understand" }, "understand"), h("option", { value: "anti-vibe" }, "anti-vibe"));
  modeSelect.addEventListener("change", () => void save({ mode: modeSelect.value === "anti-vibe" ? "anti-vibe" : "understand" }));
  const modeHint = h("p", { class: "hint" });
  const voiceStatus = h("p", { class: "hint" });
  const hotkeyError = h("p", { class: "hint error-text", role: "alert" });
  const versionLine = h("p", { class: "hint" });
  const webServer = h("input", { class: "input", type: "url", placeholder: "https://…", "aria-label": "Server" });
  const webStatus = h("p", { class: "hint", role: "status" });
  async function treeSync(sync: TreeSync, done: string) {
    webStatus.textContent = "";
    if ((await client.call({ type: "tree-sync", sync })).ok) webStatus.textContent = done;
  }
  const webLink = () => {
    const server = webServer.value.trim();
    if (!server) return client.showError("Type the server's address first.");
    void treeSync({ action: "link", server }, "Linked. The page opened in your browser.");
  };
  webServer.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    webLink();
  });

  const recorders = new Map<"hotkey" | "voiceHotkey" | "sendDraftHotkey", HTMLInputElement>();
  let recording: HTMLInputElement | null = null;
  const recorder = (name: "hotkey" | "voiceHotkey" | "sendDraftHotkey", label: string) => {
    const input = h("input", { class: "input hotkey", type: "text", readonly: true, "aria-label": label, "aria-describedby": "hotkey-hint" });
    input.addEventListener("focus", () => {
      recording = input;
      input.value = "press a shortcut…";
    });
    input.addEventListener("blur", () => {
      recording = null;
      if (client.snap) input.value = shortcutText(client.snap.settings[name], mac());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return input.blur();
      const acc = pressed(e, mac());
      if (!acc) return;
      input.blur();
      void save({ [name]: acc });
    });
    recorders.set(name, input);
    return h("label", { class: "field" }, h("span", {}, label), input);
  };

  const settingsBody = h(
    "div",
    { class: "settings" },
    h("div", { class: "group" }, agentSettings.el),
    h(
      "div",
      { class: "group", "aria-labelledby": "look-title", role: "group" },
      h("h3", { id: "look-title" }, "Look"),
      h("p", { class: "hint" }, "Dum looks every 3 seconds at which app is in front, how much the screen changed and the folders you follow. It calls a model only when something changed. It never reads keystrokes, the clipboard or your editor."),
      lookStatus,
      lookPause,
      h("label", { class: "check" }, look.apps, h("span", {}, "Apps: notice when you switch apps")),
      h("label", { class: "check" }, look.screen, h("span", {}, "Screen: notice how much the screen changes, and show the Wizard a frame when it asks")),
      screenStatus,
      h("button", { type: "button", class: "btn ghost", onclick: () => void client.call({ type: "screen-permission" }) }, icon("external"), "Screen Recording settings"),
      h("h4", {}, "Followed folders"),
      h("p", { class: "hint" }, "Folders in this zone whose saved files Dum may read. Dum notices when you save code there."),
      follows,
      followAdd,
    ),
    h(
      "div",
      { class: "group" },
      h("h3", {}, "Shortcuts"),
      recorder("hotkey", "Open the command bar"),
      recorder("voiceHotkey", "Hold to talk"),
      recorder("sendDraftHotkey", "Send the draft"),
      h("p", { id: "hotkey-hint", class: "hint" }, "Click a field, then press the new shortcut. It needs ⌘, ⌃ or ⌥."),
      hotkeyError,
    ),
    h(
      "div",
      { class: "group" },
      h("h3", {}, "Conversation"),
      h("label", { class: "field" }, h("span", {}, "Mode"), modeSelect),
      modeHint,
      h("label", { class: "check" }, toggles.personalContext, h("span", {}, "Use my personal context file for suggestions")),
      h("p", { class: "hint" }, "Off unless you turn it on. It's the Markdown file at ~/.dum/context.md. It shapes suggested projects and never adds skills."),
    ),
    h(
      "div",
      { class: "group", "aria-labelledby": "web-title", role: "group" },
      h("h3", { id: "web-title" }, "Web tree"),
      h("p", { class: "hint" }, "Keep a copy of your skill tree at a private link you can open and edit in a browser. Only the tree goes there: no zones, conversations, holds or files."),
      h("label", { class: "field" }, h("span", {}, "Server"), webServer),
      h("button", { type: "button", class: "btn ghost", onclick: webLink }, icon("external"), "Link"),
      h("button", { type: "button", class: "btn ghost", onclick: () => void treeSync({ action: "sync" }, "Synced.") }, "Sync now"),
      h("button", { type: "button", class: "btn ghost", onclick: () => void treeSync({ action: "rotate" }, "New link made; the old one stopped working. The page opened in your browser.") }, "New link"),
      h("button", { type: "button", class: "btn ghost", onclick: () => void treeSync({ action: "off" }, "Unlinked. The web copy is gone; the tree here is untouched.") }, "Unlink"),
      webStatus,
    ),
    h(
      "div",
      { class: "group" },
      h("h3", {}, "Voice"),
      voiceStatus,
      h("button", { type: "button", class: "btn ghost", onclick: () => void client.call({ type: "voice-setup" }) }, icon("mic"), "Set up voice"),
      h("p", { class: "hint" }, "Hold the talk shortcut, speak, let go. Your words land in the message box; nothing is sent until you send it. Speech stays on this Mac."),
    ),
    h(
      "div",
      { class: "group" },
      h("label", { class: "check" }, toggles.launchAtLogin, h("span", {}, "Open Dum when you log in")),
      versionLine,
      h("button", { type: "button", class: "btn danger", onclick: () => void client.call({ type: "quit" }) }, icon("power"), "Quit Dum"),
    ),
  );

  function renderSettings(s: Snapshot, force = false) {
    agentSettings.update(s);
    for (const [name, input] of recorders) if (input !== recording) input.value = shortcutText(s.settings[name], s.platform === "darwin");
    hotkeyError.textContent = s.hotkeyError;
    hotkeyError.hidden = !s.hotkeyError;
    const keep = (el: HTMLInputElement | HTMLSelectElement) => !force && document.activeElement === el;
    if (!keep(look.apps)) look.apps.checked = s.settings.look.apps;
    if (!keep(look.screen)) look.screen.checked = s.settings.look.screen;
    if (!keep(toggles.launchAtLogin)) toggles.launchAtLogin.checked = s.settings.launchAtLogin;
    if (!keep(toggles.personalContext)) toggles.personalContext.checked = s.settings.personalContext;
    if (!keep(modeSelect)) modeSelect.value = s.settings.mode;
    modeHint.textContent = MODES[s.settings.mode];
    lookStatus.textContent = s.look.status;
    lookPause.textContent = s.look.paused ? "Resume looking" : "Pause looking";
    screenStatus.textContent = PERMISSION[s.look.screenPermission] ?? `Screen Recording: ${s.look.screenPermission || "unknown"}.`;
    follows.replaceChildren(
      ...(s.follows.length
        ? s.follows.map((f) => h("li", { class: "follow" }, icon("folder"), h("span", {}, f.label), h("span", { class: "muted small" }, `${f.files} file${f.files === 1 ? "" : "s"}`), iconButton("close", `Stop following ${f.label}`, () => void client.call({ type: "follow-remove", followId: f.id }), "", "icon-btn tiny")))
        : [h("li", { class: "muted" }, s.activeZone ? "None in this zone." : "Enter a zone to follow folders in it.")]),
    );
    followAdd.disabled = !s.activeZone;
    voiceStatus.textContent = s.voice.status || "Voice is idle.";
    versionLine.textContent = `Dum ${s.version} · ${s.platform} · ${s.agent.flavor} build`;
  }

  // -- showing panes --------------------------------------------------------

  async function show(name: Pane) {
    // A pane's text was read there; it doesn't follow you back to the conversation.
    if (TEXT_PANES.includes(pane)) dismissedStage = shownStage;
    pane = name;
    awaiting = TEXT_PANES.includes(name) ? name : null;
    render();
    paneTitle.focus();
    if (name === "chat") composer.focus();
    if (name !== "chat" && name !== "zones" && name !== "settings") await client.call({ type: "panel", panel: name });
    if (awaiting === name) awaiting = null;
    render();
  }

  function renderPane(s: Snapshot) {
    for (const [name, tab] of tabs) {
      tab.setAttribute("aria-selected", String(name === pane));
      tab.tabIndex = name === pane ? 0 : -1;
      tab.disabled = PANES[name].needsZone && !s.activeZone && name !== "chat";
    }
    chat.hidden = pane !== "chat";
    paneEl.hidden = pane === "chat";
    if (pane === "chat") return;
    paneTitle.textContent = PANES[pane].label;
    const kids: Node[] = [];
    if (pane === "zones") {
      zones.update(s);
      kids.push(zones.el);
    } else if (pane === "tree") {
      if (s.tree) {
        tree.update(s.tree);
        kids.push(tree.el);
      } else kids.push(h("p", { class: "muted" }, "loading…"));
    } else if (pane === "changes") {
      changes.update(s);
      kids.push(changes.el);
    } else if (pane === "settings") {
      renderSettings(s);
      kids.push(settingsBody);
    } else {
      const stage = s.state?.stage;
      infoText.textContent = awaiting ? "loading…" : stage?.kind === "info" ? plain(stage.body) || "nothing here yet." : "nothing to show.";
      kids.push(infoText);
      if (pane === "memory") kids.push(memoryExtras);
      if (pane === "context") kids.push(contextExtras);
      if (pane === "projects") kids.push(projectsExtras);
    }
    // Swapping in the same nodes would reset scroll positions and focus.
    if (paneBody.childNodes.length !== kids.length || kids.some((k, i) => paneBody.childNodes[i] !== k)) paneBody.replaceChildren(...kids);
  }

  function renderChat(s: Snapshot, state: State | null) {
    firstRun.hidden = !!s.activeZone;
    scroller.hidden = !s.activeZone;
    if (s.agent.chosen) wantAgent = false;
    agentBanner.hidden = !s.activeZone || !!s.agent.chosen || wantAgent;
    agentSetup.el.hidden = !s.activeZone || !wantAgent;
    if (wantAgent) agentSetup.update(s);
    composer.update(s);
    if (!state) return;
    const stage = state.stage;
    const stageKey = stage.kind === "info" ? stage.title + "\u0000" + stage.body : "";
    // A typed :command's answer shows on the conversation, unless a pane asked for it.
    if (stageKey && stageKey !== shownStage && !TEXT_PANES.includes(pane)) dismissedStage = "";
    shownStage = stageKey;
    stageCard.hidden = !stageKey || stageKey === dismissedStage || TEXT_PANES.includes(pane);
    if (stage.kind === "info") {
      stageTitle.textContent = stage.title;
      stageBody.textContent = plain(stage.body);
    }
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    transcript.update(state.transcript, state.prompt, s.changes);
    empty.hidden = state.transcript.length > 0;
    if (atBottom || forceBottom) scroller.scrollTop = scroller.scrollHeight;
    forceBottom = false;
  }

  function render() {
    const s = client.snap;
    if (!s) return;
    const state = s.state;
    const zoneId = s.activeZone?.id ?? null;
    if (zoneId !== shownZone) {
      if (shownZone !== undefined) {
        transcript.clear();
        dismissedStage = "";
        if (PANES[pane].needsZone && pane !== "chat") pane = "chat";
      }
      shownZone = zoneId;
      forceBottom = true;
    }
    if (!s.activeZone && pane !== "zones" && pane !== "tree" && pane !== "settings") pane = "chat";
    crumb.textContent = s.activeZone ? zonePath(s.zones, s.activeZone.id) || s.activeZone.breadcrumb.map((b) => b.name).join(" › ") : "no zone yet";
    crumbBtn.title = s.activeZone ? `Goal: ${s.activeZone.goal}` : "Zones";
    lookBtn.textContent = s.look.paused ? "looking paused · resume" : `looking · ${s.look.status || "on"}`;
    lookBtn.setAttribute("aria-label", s.look.paused ? "Resume looking" : "Pause looking");
    lookBtn.hidden = !s.activeZone;
    let mood: "idle" | "asking" | "thinking" | "building" | "blocked" = "idle";
    if (!s.activeZone) mood = "idle";
    else if (state?.prompt && state.prompt.type !== "next") mood = "asking";
    else if (state?.busy) mood = /think/i.test(state.status) || !state.status ? "thinking" : "building";
    else if (!s.agent.chosen) mood = "blocked";
    face.set(mood);
    const t = tierInfo(s.tree);
    tierFill.className = `tier-fill tier-${t.tier}`;
    tierFill.style.width = `${Math.round(t.pct * 100)}%`;
    const tierText = `${t.tier} · ${t.built} currently usable built skills`;
    tierBar.setAttribute("aria-label", tierText);
    tierBar.setAttribute("aria-valuenow", String(Math.min(t.built, 64)));
    tierBar.title = "newbie → intern (8) → good (24) → cracked (64). Counts built skills with intact prerequisites, not messages.";
    tierName.textContent = t.tier;
    tierName.hidden = tierBar.hidden = !s.tree;
    renderChat(s, state);
    renderPane(s);
    const own = s.activeZone?.notes.find((n) => n.id === s.activeZone?.id);
    if (document.activeElement !== contextText) contextText.value = own?.text ?? "";
    contextGoal.textContent = s.activeZone ? `Goal: ${s.activeZone.goal}` : "";
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "." && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      composer.stop();
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    if (composer.escape() || zones.escape()) return;
    if (pane !== "chat" && client.snap?.activeZone) void show("chat");
    else void client.call({ type: "dismiss-surface", surface: "panel" });
  });
  window.addEventListener("focus", () => {
    if (document.activeElement === document.body) (pane === "chat" ? composer.textarea : tabs.get(pane))?.focus();
  });

  const app = h("div", { class: "app" }, header, nav, client.errors, h("main", { class: "body" }, chat, paneEl));
  document.body.append(app);
  client.on(render);
  // Main opens a pane (from the menu bar or the command bar) by setting the location hash.
  const fromHash = () => {
    const name = decodeURIComponent(location.hash.slice(1));
    // Cleared at once, so opening the same pane again is a fresh hashchange.
    history.replaceState(null, "", location.pathname + location.search);
    if (Object.hasOwn(PANES, name)) void show(name as Pane);
  };
  window.addEventListener("hashchange", fromHash);
  void client.call({ type: "snapshot" }).then(() => {
    composer.focus();
    void client.call({ type: "panel", panel: "tree" }, true);
    fromHash();
  });
}

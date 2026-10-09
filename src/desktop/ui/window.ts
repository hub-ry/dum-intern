// The one working window, chat first: a status strip (zone, look, goal) whose Context chevron expands the
// zone tree and Current context above Chat (docs/circle-design.md §3). Settings, Skills, Records, Story and
// Move circle open inside the Chat region and return focus to their opener. Tab follows the visual order;
// ⌘K switches zone, ⌘. stops, ⌘W hides, and Esc closes the innermost thing first, then the expanded strip,
// then an in-window view, then hides the window. Esc is never Stop, No or a dismissal.

import type { CircleDisplays, DesktopPreferences, Snapshot, ViewName } from "../protocol.ts";
import { Client, h, icon, iconButton, plain } from "./dom.ts";
import { Composer } from "./composer.ts";
import { Transcript } from "./transcript.ts";
import { ZoneSwitcher, ZoneTree, zonePath } from "./zones.ts";
import { AgentSheet } from "./agent-sheet.ts";
import { DecisionCards } from "./decision-view.ts";
import { ContextTrail, StoryView, alignmentChip, lookChip } from "./context-trail.ts";
import { SettingsView } from "./settings-view.ts";
import { RECORD_TABS, RecordsView, SkillsView, type RecordTab } from "./records-view.ts";

type Aux = "settings" | "skills" | "records" | "story" | "move";

const MODES: Record<DesktopPreferences["mode"], string> = {
  understand: "Dum can implement with skills you've unlocked. Concepts need work you've built yourself. Tools need you to know what they're for.",
  "anti-vibe": "The same skill gates, with your approach first. Tell Dum how you want it done, then delegate the unlocked parts. Explaining an approach doesn't count as building a skill.",
};

/** The Chat header's menu, in the order it lists things. */
const MENU: { label: string; open: ViewName }[] = [
  { label: "Manage zones", open: "zones" },
  { label: "Skills", open: "tree" },
  ...(Object.entries(RECORD_TABS) as [RecordTab, { label: string }][]).map(([tab, meta]) => ({ label: meta.label, open: tab })),
  { label: "Full story", open: "story" },
];

const isRecordTab = (v: ViewName): v is RecordTab => Object.hasOwn(RECORD_TABS, v);

/** Every focusable control inside an element, in tab order. */
function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, [tabindex='0'], a[href]")].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
}

/** Move circle: choose a display, or nudge it with arrows (Shift for 1 DIP), Enter commits, Esc restores. */
class MoveCircle {
  readonly el = h("div", { class: "move-circle", tabindex: "0", "aria-describedby": "move-hint" });
  private displays: CircleDisplays | null = null;

  constructor(private client: Client, private done: () => void) {
    this.el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 10;
      const move = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (move) {
        e.preventDefault();
        void this.call({ type: "circle-nudge", dx: move[0]!, dy: move[1]! });
      } else if (e.key === "Enter" && e.target === this.el) {
        e.preventDefault();
        void this.call({ type: "circle-position", action: "commit" }).then(() => this.done());
      }
    });
  }

  async begin() {
    await this.call({ type: "circle-position", action: "begin" });
    this.el.focus();
  }

  /** Esc: restores where the circle was. */
  cancel() {
    if (this.displays?.positioning) void this.client.call({ type: "circle-position", action: "cancel" }, true);
    this.displays = null;
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
      h("p", { id: "move-hint", class: "hint" }, "Arrow keys move the circle 10 points, Shift+arrows 1 point. Enter keeps it there, Esc puts it back."),
      h(
        "ul",
        { class: "display-list", "aria-label": "Displays" },
        ...(d?.displays ?? []).map((x) =>
          h("li", {}, h("button", { type: "button", class: `btn ghost small${x.current ? " picked" : ""}`, "aria-pressed": String(x.current), onclick: () => void this.call({ type: "circle-display", displayId: x.id }) }, x.label, x.primary ? " (main)" : "")),
        ),
      ),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary small", onclick: () => void this.call({ type: "circle-position", action: "commit" }).then(() => this.done()) }, "Keep it here")),
    );
  }
}

export function windowView() {
  const client = new Client();
  let aux: Aux | null = null;
  let opener: HTMLElement | null = null;
  let wantAgent = false;
  let managing = false;
  let contextOpen = false;
  let shownZone: string | null | undefined;
  let forceBottom = false;
  let chatScroll = 0;
  let shownStage = "";
  let dismissedStage = "";

  // -- Chat ---------------------------------------------------------------------------

  const agentSetup = new AgentSheet(client, "setup", () => {
    wantAgent = false;
    render();
    composer.focus();
  });
  const needsAgent = () => {
    wantAgent = true;
    closeAux(false);
    render();
    agentSetup.focus();
  };
  // First run's goal becomes the root zone, and its goal-start alignment begins at once.
  const composer = new Composer({ client, needsAgent, created: (view) => decisions.aligned(view, true) });
  const transcript = new Transcript(client);
  const decisions = new DecisionCards(client, { flushDraft: () => composer.flush(), focusDraft: () => composer.focus(), needsAgent });
  const firstRun = h(
    "section",
    { class: "first-run", hidden: true, "aria-labelledby": "first-run-title" },
    h("h1", { id: "first-run-title", tabindex: "-1" }, "What are you trying to learn?"),
    h("p", { class: "muted" }, "Say it in your own words, typed or by voice. It becomes your first zone, and Dum then works out with you what that goal means. Nothing is sent to a model until Dum is powered."),
  );
  const agentBanner = h(
    "div",
    { class: "notice", hidden: true },
    h("span", {}, "Dum isn't powered yet. Zones, skills and notes work without it."),
    h("button", { type: "button", class: "btn small", onclick: needsAgent }, "Who powers Dum?"),
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
  const empty = h("div", { class: "empty" }, h("p", {}, "Say what you need done."), h("p", { class: "muted" }, "Dum reflects it back, the Wizard compares ways to get there when you ask, and you choose what to hand off. Anything you haven't proven yet becomes something to learn first."));
  const scroller = h("div", { class: "scroller" }, agentBanner, agentSetup.el, stageCard, transcript.el, empty, decisions.el);
  const chatMain = h("div", { class: "chat-main" }, firstRun, scroller, h("footer", { class: "dock" }, composer.el));

  // -- views inside Chat ----------------------------------------------------------------

  const backToChat = () => closeAux(true);
  const settings = new SettingsView(client);
  const records = new RecordsView(client, backToChat);
  const skills = new SkillsView(client, backToChat);
  const story = new StoryView(client);
  const move = new MoveCircle(client, backToChat);
  const auxTitle = h("h2", { id: "aux-title", tabindex: "-1" });
  const auxBody = h("div", { class: "aux-body" });
  const auxEl = h(
    "section",
    { class: "aux", hidden: true, role: "region", "aria-labelledby": "aux-title" },
    h("div", { class: "aux-head" }, h("button", { type: "button", class: "btn ghost small", onclick: backToChat }, "‹ Back"), auxTitle),
    auxBody,
  );

  function openAux(next: Aux) {
    if (!aux) {
      opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      chatScroll = scroller.scrollTop;
    }
    if (aux === "move" && next !== "move") move.cancel();
    if (aux === "settings" && next !== "settings") settings.closed();
    aux = next;
    render();
    auxTitle.focus();
  }

  function closeAux(restoreFocus: boolean) {
    if (!aux) return;
    if (aux === "move") move.cancel();
    if (aux === "settings") settings.closed();
    aux = null;
    render();
    scroller.scrollTop = chatScroll;
    if (!restoreFocus) return;
    if (opener?.isConnected && opener.offsetParent !== null) opener.focus();
    else composer.focus();
    opener = null;
  }

  /** Main and in-window links name a view; each opens where it lives in this window. */
  function showView(view: ViewName) {
    if (view === "zones") {
      closeAux(false);
      manage(true);
      zones.focus();
    } else if (view === "settings") openAux("settings");
    else if (view === "tree") {
      openAux("skills");
      void client.call({ type: "view", view: "tree" }, true);
    } else if (view === "story") {
      openAux("story");
      void story.show("story");
    } else if (isRecordTab(view)) {
      openAux("records");
      void records.show(view);
    }
  }

  // -- Status strip: zone crumb, look, goal; Context expands the zone tree and Current context ---

  const zones = new ZoneTree(client, {
    aligned: (v, goalSet) => {
      decisions.aligned(v, goalSet);
      render();
    },
    badge: (id) => decisions.badge(id),
  });
  const crumb = h("span", { class: "crumb-text" }, "no zone yet");
  const switcher = new ZoneSwitcher(client, () => crumbBtn.focus());
  const crumbBtn = h("button", { type: "button", class: "crumb-btn", "aria-haspopup": "dialog", title: "Switch zone (⌘K)", onclick: () => switcher.open() }, icon("zones"), crumb, icon("chevron"));
  const lookChipEl = h("span", { class: "chip strip-look", role: "status" });
  const goalText = h("span", { class: "strip-goal" });
  const contextBtn = h("button", { type: "button", class: "btn ghost small strip-toggle", "aria-expanded": "false", "aria-controls": "context-panel", onclick: () => openContext(!contextOpen) }, icon("chevron"), "Context");
  const stripHead = h(
    "header",
    { class: "strip-head" },
    h("h2", { id: "strip-title", class: "visually-hidden" }, "Zones and context"),
    crumbBtn,
    lookChipEl,
    goalText,
    h("span", { class: "spacer" }),
    contextBtn,
    iconButton("gear", "Settings", () => (aux === "settings" ? closeAux(true) : openAux("settings"))),
    iconButton("hide", "Hide (Esc)", () => void client.call({ type: "dismiss-surface", surface: "window" })),
  );
  const context = new ContextTrail(client, {
    show: showView,
    story: (kind) => {
      openAux("story");
      void story.show(kind);
    },
    editGoal: () => {
      const id = client.snap?.activeZone?.id;
      if (!id) return;
      manage(true);
      zones.edit(id);
    },
  });
  const zoneBox = h("div", { class: "zone-tree-box", id: "zone-tree-box" }, zones.el);
  const panel = h("div", { class: "strip-panel", id: "context-panel", hidden: true }, zoneBox, context.el);
  const strip = h("section", { class: "strip", "aria-labelledby": "strip-title" }, stripHead, switcher.el, panel);

  /** Expanded or collapsed for the rest of this window session; focus stays on the chevron. */
  function openContext(open: boolean) {
    contextOpen = open;
    render();
  }

  /** Manage shows the zone tree's tools and forms; it lives inside the expanded strip. */
  function manage(on: boolean) {
    managing = on;
    if (on) contextOpen = true;
    render();
  }

  // -- Chat header ------------------------------------------------------------------

  const modeSelect = h("select", { class: "input mode-select", "aria-label": "Mode", "aria-describedby": "mode-hint" }, h("option", { value: "understand" }, "Mode: understand"), h("option", { value: "anti-vibe" }, "Mode: anti-vibe"));
  const modeHint = h("span", { id: "mode-hint", class: "visually-hidden" });
  modeSelect.addEventListener("change", () => {
    const s = client.snap;
    if (s) void client.call({ type: "settings", settings: { ...s.settings, mode: modeSelect.value === "anti-vibe" ? "anti-vibe" : "understand" } });
  });
  const menu = h("ul", { class: "menu-list", role: "menu", hidden: true, "aria-label": "Menu" });
  const menuBtn = h("button", { type: "button", class: "btn ghost small", "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => toggleMenu(menu.hidden) }, "Menu", icon("chevron"));
  for (const item of MENU) {
    menu.append(h("li", { role: "none" }, h("button", { type: "button", role: "menuitem", class: "menu-item", tabindex: "-1", onclick: () => { toggleMenu(false); showView(item.open); } }, item.label)));
  }
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].filter((b) => !b.disabled);
    const i = items.findIndex((b) => b === document.activeElement);
    const to = e.key === "ArrowDown" ? items[(i + 1) % items.length] : e.key === "ArrowUp" ? items[(i - 1 + items.length) % items.length] : e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : undefined;
    if (e.key === "Tab") toggleMenu(false, false);
    if (!to) return;
    e.preventDefault();
    to.focus();
  });
  function toggleMenu(open: boolean, focus = true) {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    else if (focus) menuBtn.focus();
  }
  const chatHead = h(
    "div",
    { class: "section-head chat-head" },
    h("h2", {}, "Chat"),
    h("span", { class: "spacer" }),
    modeSelect,
    modeHint,
    h("div", { class: "menu-wrap" }, menuBtn, menu),
    h("button", { type: "button", class: "btn ghost small", onclick: () => { openAux("move"); void move.begin(); } }, icon("move"), "Move circle"),
  );
  const chat = h("section", { class: "chat", "aria-label": "Chat" }, chatHead, h("div", { class: "chat-region" }, chatMain, auxEl));

  // -- rendering -------------------------------------------------------------------

  function renderAux(s: Snapshot) {
    auxEl.hidden = !aux;
    chatMain.hidden = !!aux;
    auxEl.classList.toggle("sheet", aux === "settings");
    if (!aux) return;
    let body: HTMLElement;
    if (aux === "settings") {
      auxTitle.textContent = "Settings";
      settings.update(s);
      body = settings.el;
    } else if (aux === "skills") {
      auxTitle.textContent = "Skills";
      skills.update(s);
      body = skills.el;
    } else if (aux === "records") {
      auxTitle.textContent = `Records · ${records.title}`;
      records.update(s);
      body = records.el;
    } else if (aux === "story") {
      auxTitle.textContent = story.title;
      story.update(s);
      body = story.el;
    } else {
      auxTitle.textContent = "Move circle";
      body = move.el;
    }
    if (auxBody.firstChild !== body) auxBody.replaceChildren(body);
  }

  function renderChat(s: Snapshot) {
    const state = s.state;
    firstRun.hidden = !!s.activeZone;
    scroller.hidden = !s.activeZone && !wantAgent;
    if (s.agent.chosen) wantAgent = false;
    agentBanner.hidden = !s.activeZone || !!s.agent.chosen || wantAgent;
    agentSetup.el.hidden = !wantAgent;
    if (wantAgent) agentSetup.update(s);
    composer.update(s);
    decisions.update(s);
    if (!state) {
      empty.hidden = !!s.decision || !!s.handoff;
      return;
    }
    const stage = state.stage;
    const stageKey = stage.kind === "info" ? stage.title + "\u0000" + stage.body : "";
    // A typed :command's answer shows in Chat, unless a Records view asked for it.
    if (stageKey && stageKey !== shownStage && aux !== "records") dismissedStage = "";
    shownStage = stageKey;
    stageCard.hidden = !stageKey || stageKey === dismissedStage || aux === "records";
    if (stage.kind === "info") {
      stageTitle.textContent = stage.title;
      stageBody.textContent = plain(stage.body);
    }
    if (aux) return;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    transcript.update(state.transcript, state.prompt, s.changes);
    empty.hidden = state.transcript.length > 0 || !!s.decision || !!s.handoff;
    if (atBottom || forceBottom) scroller.scrollTop = scroller.scrollHeight;
    forceBottom = false;
  }

  function render() {
    const s = client.snap;
    if (!s) return;
    const zoneId = s.activeZone?.id ?? null;
    if (zoneId !== shownZone) {
      if (shownZone !== undefined) {
        transcript.clear();
        dismissedStage = "";
        // Records belong to the zone you left; the rest of this render shows Chat.
        if (aux === "records") aux = null;
      }
      shownZone = zoneId;
      forceBottom = true;
    }
    const live = s.zones.zones.some((z) => z.deletedAt === null);
    const zone = s.activeZone;
    crumb.textContent = zone ? zonePath(s.zones, zone.id) || zone.breadcrumb.map((b) => b.name).join(" › ") : live ? "choose a zone" : "no zone yet";
    crumbBtn.title = zone ? `Goal: ${zone.goal} · Switch zone (⌘K)` : "Switch zone (⌘K)";
    crumbBtn.disabled = !live;
    const look = lookChip(s.look);
    lookChipEl.textContent = look.label;
    lookChipEl.className = `chip chip-${look.tone} strip-look`;
    lookChipEl.hidden = !zone;
    goalText.replaceChildren(!zone ? "" : s.direction?.current ? zone.goal : alignmentChip(s.direction));
    goalText.title = zone?.goal ?? "";
    contextBtn.setAttribute("aria-expanded", String(contextOpen));
    panel.hidden = !contextOpen;
    zoneBox.classList.toggle("managing", managing);
    zones.update(s);
    context.update(s);
    if (document.activeElement !== modeSelect) modeSelect.value = s.settings.mode;
    modeSelect.title = MODES[s.settings.mode];
    modeHint.textContent = MODES[s.settings.mode];
    renderChat(s);
    renderAux(s);
  }

  // -- keyboard ----------------------------------------------------------------------

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === ".") {
      e.preventDefault();
      if (aux === "settings" && settings.debugFocused) settings.stopDebug();
      else composer.stop();
      return;
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (client.snap?.zones.zones.some((z) => z.deletedAt === null)) switcher.open();
      return;
    }
    if (mod && e.key.toLowerCase() === "w") {
      e.preventDefault();
      void client.call({ type: "dismiss-surface", surface: "window" });
      return;
    }
    if (e.key === "Tab" && aux === "settings" && auxEl.contains(document.activeElement)) {
      // Settings is a sheet: Tab cycles inside it until Back or Esc.
      const list = focusables(auxEl);
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    if (switcher.isOpen) return switcher.close();
    if (!menu.hidden) return toggleMenu(false);
    const closeManaging = () => {
      if (!managing) return false;
      manage(false);
      contextBtn.focus();
      return true;
    };
    // Innermost first: a form or detail inside the expanded strip, then a chooser or form in Chat, then the
    // strip itself (it stays open above a view), then the view, then the window.
    if (strip.contains(document.activeElement) && (zones.escape() || closeManaging() || context.escape())) return;
    if (!aux && (composer.escape() || decisions.escape())) return;
    if (contextOpen) {
      openContext(false);
      return contextBtn.focus();
    }
    if (aux) {
      // An open view hides Chat: its forms wait behind it and never take this Esc.
      if (aux === "settings" && settings.escape()) return;
      if (aux === "story" && story.escape()) return;
      return closeAux(true);
    }
    void client.call({ type: "dismiss-surface", surface: "window" });
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.parentElement!.contains(e.target as Node)) toggleMenu(false, false);
  });
  window.addEventListener("focus", () => {
    if (document.activeElement === document.body) (aux ? auxTitle : composer.textarea).focus();
  });

  document.body.append(h("div", { class: "window" }, strip, client.errors, chat));
  client.on(render);
  // Main opens an in-window view by setting the location hash.
  const fromHash = () => {
    const name = decodeURIComponent(location.hash.slice(1));
    // Cleared at once, so opening the same view again is a fresh hashchange.
    history.replaceState(null, "", location.pathname + location.search);
    if (name === "zones" || name === "tree" || name === "settings" || name === "story" || isRecordTab(name as ViewName)) showView(name as ViewName);
  };
  window.addEventListener("hashchange", fromHash);
  void client.call({ type: "snapshot" }).then(() => {
    composer.focus();
    void client.call({ type: "view", view: "tree" }, true);
    fromHash();
  });
}

// The working window draws exactly one panel, the one main names in `snapshot.panel`: Dum's goals
// folder, one goal, the skill tree, the Monitor or Settings. The circle floats over one of the panel's
// top corners, so both keep a clear square. A goal's records and its editor open as a view over the
// goal panel and return focus to their opener. ⌘K opens a goal, ⌘. stops, ⌘W hides, and Esc closes
// the innermost thing first, then an open view, then hides the window. Esc is never Stop, No or a dismissal.

import type { PanelRef, Snapshot, ViewName } from "../protocol.ts";
import { Client, h } from "./dom.ts";
import { SettingsView } from "./settings-view.ts";
import { RECORD_TITLES, RecordsView, type RecordTab } from "./records-view.ts";
import { GoalEditor, GoalSwitcher } from "./zones.ts";
import { GoalsPanel } from "./goals-panel.ts";
import { GoalPanel, type MoreItem } from "./goal-panel.ts";
import { TreePanel } from "./tree-panel.ts";
import { MonitorPanel } from "./monitor-panel.ts";

type Aux = "records" | "edit";

const isRecordTab = (v: string): v is RecordTab => Object.hasOwn(RECORD_TITLES, v);

const panelKey = (p: PanelRef) => (p.kind === "goal" ? `goal:${p.id}` : p.kind);

export function windowView() {
  const client = new Client();
  let aux: Aux | null = null;
  let opener: HTMLElement | null = null;
  let shownPanel = "";
  let chatScroll = 0;

  // -- panels ---------------------------------------------------------------------------

  /** A send needs a backend and none is chosen: Settings, with Agent open. */
  const needsAgent = () => {
    void client.call({ type: "panel", panel: { kind: "settings" } }).then(() => settings.openAgent());
  };
  const goal = new GoalPanel(client, { needsAgent, more });
  const goals = new GoalsPanel(client, (view) => goal.aligned(view, true));
  const tree = new TreePanel(client, toActiveGoal);
  const monitor = new MonitorPanel(client);
  const settings = new SettingsView(client);

  /** A command from the tree answered in Chat: show the goal it ran in. */
  function toActiveGoal() {
    const id = client.snap?.activeZone?.id;
    closeAux(false);
    if (id) void client.call({ type: "panel", panel: { kind: "goal", id } });
  }

  // -- views over the goal panel ----------------------------------------------------------

  const records = new RecordsView(client, () => closeAux(true));
  const editor = new GoalEditor(client, {
    aligned: (view, fresh) => goal.aligned(view, fresh),
    done: () => {
      if (aux === "edit") closeAux(true);
    },
  });
  const auxTitle = h("h2", { id: "aux-title", tabindex: "-1" });
  const auxBody = h("div", { class: "aux-body" });
  const auxEl = h(
    "section",
    { class: "panel aux", role: "region", "aria-labelledby": "aux-title" },
    h("header", { class: "panel-head aux-head" }, h("button", { type: "button", class: "btn ghost small", onclick: () => closeAux(true) }, "‹ Back"), auxTitle),
    auxBody,
  );

  function openAux(next: Aux) {
    if (!aux) {
      opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      chatScroll = goal.scrollTop;
    }
    aux = next;
    render();
    auxTitle.focus();
  }

  function closeAux(restoreFocus: boolean) {
    if (!aux) return;
    aux = null;
    render();
    goal.scrollTop = chatScroll;
    if (!restoreFocus) return;
    if (opener?.isConnected && opener.offsetParent !== null) opener.focus();
    else focusPanel();
    opener = null;
  }

  /** The goal panel's More menu. */
  function more(item: MoreItem) {
    const s = client.snap;
    const id = s?.panel.kind === "goal" ? s.panel.id : s?.activeZone?.id;
    if (item === "edit" || item === "delete" || item === "inside") {
      if (!id) return;
      openAux("edit");
      editor.open(item === "inside" ? { kind: "create", parentId: id } : { kind: item, id });
      auxTitle.textContent = editor.title;
    } else {
      openAux("records");
      void records.show(item);
    }
  }

  /** A view main names by the location hash; each opens where it lives. */
  function showView(view: ViewName) {
    closeAux(false);
    if (view === "zones") void client.call({ type: "panel", panel: { kind: "dum" } });
    else if (view === "settings") void client.call({ type: "panel", panel: { kind: "settings" } });
    else if (view === "tree") {
      void client.call({ type: "panel", panel: { kind: "tree" } });
      void client.call({ type: "view", view: "tree" }, true);
    } else if (isRecordTab(view)) more(view);
  }

  function renderAux(s: Snapshot) {
    if (aux === "records") {
      auxTitle.textContent = records.title;
      records.update(s);
      if (auxBody.firstChild !== records.el) auxBody.replaceChildren(records.el);
    } else if (aux === "edit") {
      auxTitle.textContent = editor.title;
      editor.update(s);
      if (auxBody.firstChild !== editor.el) auxBody.replaceChildren(editor.el);
    }
  }

  // -- rendering ---------------------------------------------------------------------------

  const switcher = new GoalSwitcher(client);
  const stage = h("div", { class: "panel-stage" });
  const shell = h("div", { class: "window" }, stage, switcher.el, client.errors);

  function panelEl(p: PanelRef): HTMLElement {
    switch (p.kind) {
      case "dum": return goals.el;
      case "goal": return goal.el;
      case "tree": return tree.el;
      case "monitor": return monitor.el;
      case "settings": return settings.el;
    }
  }

  function focusPanel() {
    const kind = client.snap?.panel.kind;
    if (kind === "dum") goals.focus();
    else if (kind === "goal") goal.focus();
    else if (kind === "tree") tree.focus();
    else if (kind === "monitor") monitor.focus();
    else if (kind === "settings") settings.focus();
  }

  function render() {
    const s = client.snap;
    if (!s) return;
    const key = panelKey(s.panel);
    const switched = key !== shownPanel;
    if (switched && shownPanel) {
      // Views belong to the goal you left.
      aux = null;
      opener = null;
      if (shownPanel === "settings") settings.closed();
    }
    shownPanel = key;
    shell.dataset.panel = s.panel.kind;
    switch (s.panel.kind) {
      case "dum": goals.update(s); break;
      case "goal": goal.update(s, s.panel.id, !aux); break;
      case "tree": tree.update(s); break;
      case "monitor": monitor.update(s); break;
      case "settings": settings.update(s); break;
    }
    renderAux(s);
    const el = aux ? auxEl : panelEl(s.panel);
    if (stage.firstChild !== el) stage.replaceChildren(el);
    if (switched && !aux && document.hasFocus()) focusPanel();
  }

  // -- keyboard ------------------------------------------------------------------------

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const kind = client.snap?.panel.kind;
    if (mod && e.key === ".") {
      e.preventDefault();
      if (kind === "settings" && settings.debugFocused) settings.stopDebug();
      else goal.stop();
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
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    if (switcher.isOpen) return switcher.close();
    // An open view covers the panel: its forms wait behind it and never take this Esc.
    if (aux) return closeAux(true);
    if (kind === "dum" && goals.escape()) return;
    if (kind === "goal" && goal.escape()) return;
    if (kind === "tree" && tree.escape()) return;
    if (kind === "settings" && settings.escape()) return;
    void client.call({ type: "dismiss-surface", surface: "window" });
  });
  window.addEventListener("focus", () => {
    if (document.activeElement === document.body) {
      if (aux) auxTitle.focus();
      else focusPanel();
    }
  });

  document.body.append(shell);
  client.on(render);
  // Main opens an in-window view by setting the location hash.
  const fromHash = () => {
    const name = decodeURIComponent(location.hash.slice(1));
    // Cleared at once, so opening the same view again is a fresh hashchange.
    history.replaceState(null, "", location.pathname + location.search);
    if (name === "zones" || name === "tree" || name === "settings" || isRecordTab(name)) showView(name as ViewName);
  };
  window.addEventListener("hashchange", fromHash);
  void client.call({ type: "snapshot" }).then(() => {
    focusPanel();
    void client.call({ type: "view", view: "tree" }, true);
    fromHash();
  });
}

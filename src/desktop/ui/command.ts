// The command bar: summoned by the hotkey, used without the mouse. Type and Return sends, Esc puts
// you back where you were, ⌘K switches zone, ⌘. stops. Long work (tree, history, settings) opens the panel.

import type { Entry } from "../../store-types.ts";
import type { Panel, Snapshot } from "../protocol.ts";
import { Client, h, icon } from "./dom.ts";
import { portrait } from "./sprites.ts";
import { Composer } from "./composer.ts";
import { ZoneSwitcher, zonePath } from "./zones.ts";
import { prose } from "./transcript.ts";

const OPEN: { panel: Panel; label: string }[] = [
  { panel: "zones", label: "Zones" },
  { panel: "tree", label: "Skills" },
  { panel: "history", label: "History" },
  { panel: "changes", label: "Changes" },
  { panel: "settings", label: "Settings" },
];

/** What Dum and the Wizard said since your last message: the reply the bar shows. */
function latestReply(entries: readonly Entry[]): Entry[] {
  let from = entries.length;
  while (from > 0 && entries[from - 1]!.kind !== "user") from--;
  return entries.slice(from).filter((e) => e.kind === "say" || e.kind === "quip" || (e.kind === "question" && e.answer === null) || (e.kind === "diff" && e.outcome === "applied"));
}

export function command() {
  const client = new Client();
  /** Main shows the panel at that pane when the command bar asks for one. */
  const openPanel = (panel: Panel) => client.call({ type: "panel", panel });
  const composer = new Composer({ client, needsAgent: () => void openPanel("settings") });
  const switcher = new ZoneSwitcher(client, () => crumbBtn.focus());

  const crumb = h("span", { class: "crumb-text" });
  const crumbBtn = h("button", { type: "button", class: "crumb-btn", "aria-haspopup": "dialog", title: "Switch zone (⌘K)", onclick: () => switcher.open() }, icon("zones"), crumb, icon("chevron"));
  const title = h("h1", { class: "command-title", hidden: true }, "What are you trying to learn?");
  const reply = h("div", { class: "reply", role: "log", "aria-live": "polite", "aria-label": "Dum's latest reply" });
  const open = h(
    "nav",
    { class: "command-open", "aria-label": "Open in the panel" },
    ...OPEN.map((o) => h("button", { type: "button", class: "link-btn", onclick: () => void openPanel(o.panel) }, o.label)),
  );
  const keys = h("p", { class: "hint command-keys" }, "Return sends · Esc goes back · ⌘K switches zone · ⌘. stops");
  let replyKey = "";

  function render(s: Snapshot) {
    const zone = s.activeZone;
    crumbBtn.hidden = !zone && !s.zones.zones.some((z) => z.deletedAt === null);
    crumb.textContent = zone ? zonePath(s.zones, zone.id) : "no zone";
    title.hidden = !!zone;
    open.hidden = !zone;
    composer.update(s);
    const entries = s.state ? latestReply(s.state.transcript) : [];
    const key = JSON.stringify(entries);
    if (key !== replyKey) {
      replyKey = key;
      reply.replaceChildren(
        ...entries.map((e) => {
          if (e.kind === "diff") return h("p", { class: "reply-change" }, icon("undo"), h("span", {}, "Dum changed "), h("code", {}, e.path), h("span", { class: "muted" }, ". Revert it from Changes."));
          const wizard = e.kind === "quip";
          const text = e.kind === "question" ? e.question : e.kind === "say" || e.kind === "quip" ? e.text : "";
          return h("div", { class: `reply-line ${wizard ? "wizard" : "dum"}` }, portrait(wizard ? "wizard" : "dum"), h("div", {}, h("div", { class: "speaker" }, wizard ? "Wizard" : "Dum"), prose(text)));
        }),
      );
      reply.scrollTop = reply.scrollHeight;
    }
    reply.hidden = !entries.length;
  }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ".") {
      e.preventDefault();
      composer.stop();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (client.snap?.zones.zones.some((z) => z.deletedAt === null)) switcher.open();
    } else if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) {
      e.preventDefault();
      // Esc closes the innermost thing first and never means Stop, No or decline.
      if (switcher.isOpen) switcher.close();
      else if (!composer.escape()) void client.call({ type: "dismiss-surface", surface: "command" });
    }
  });
  window.addEventListener("focus", () => {
    if (!switcher.isOpen) composer.focus();
  });

  document.body.append(
    h(
      "div",
      { class: "command" },
      h("header", { class: "command-top" }, portrait("dum"), crumbBtn, title, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn ghost small", onclick: () => void client.call({ type: "show-surface", surface: "panel" }) }, icon("window"), "Panel")),
      switcher.el,
      client.errors,
      reply,
      composer.el,
      h("footer", { class: "command-foot" }, open, keys),
    ),
  );
  client.on(render);
  void client.call({ type: "snapshot" }).then(() => composer.focus());
}

// The skill tree panel: Graph (explorable, ordered by prerequisites) or Tree (the rung list with your
// tier and the Web tree link), a track filter, Tidy, and ▶ Play, which asks Dum what to work on next
// and spotlights it: "Next: <skill>. <why>".

import type { Snapshot } from "../protocol.ts";
import type { SkillRef } from "../../zone-types.ts";
import { h, skillName, type Client } from "./dom.ts";
import { SkillGraph } from "./graph.ts";
import { SkillsView } from "./records-view.ts";
import { goalLanguage } from "./zones.ts";

type Mode = "graph" | "tree";

export class TreePanel {
  readonly el: HTMLElement;
  private mode: Mode = "graph";
  /** The track filter the user picked; null follows the active goal's language. */
  private chosen: string | null = null;
  private graph: SkillGraph;
  private skills: SkillsView;
  private modeBtns: Record<Mode, HTMLButtonElement>;
  private filter = h("select", { class: "text-select track-filter", "aria-label": "Track" });
  private tidyBtn = h("button", { type: "button", class: "text-action quiet", onclick: () => this.graph.tidy() }, "Tidy");
  private nextText = h("p", { class: "next-text", role: "status", hidden: true });
  private body = h("div", { class: "tree-body" });
  private loading = h("p", { class: "secondary" }, "loading…");
  private played = false;

  constructor(private client: Client, answered: () => void) {
    const edit = async (op: "add" | "remove", skill: SkillRef) => (await client.call({ type: "skill-edit", op, skill })).ok;
    this.graph = new SkillGraph({
      play: (skill) => void client.call({ type: "play", skill }),
      trust: (skill) => edit("add", skill),
      untrust: (skill) => edit("remove", skill),
      pick: (step) => void client.call({ type: "step-pick", zoneId: step.zoneId, stepId: step.id }),
    });
    this.skills = new SkillsView(client, answered);
    const modeBtn = (m: Mode, label: string) => h("button", { type: "button", class: "seg", "aria-pressed": String(m === this.mode), onclick: () => this.setMode(m) }, label);
    this.modeBtns = { graph: modeBtn("graph", "Graph"), tree: modeBtn("tree", "Tree") };
    this.filter.addEventListener("change", () => {
      this.chosen = this.filter.value;
      this.redraw();
    });
    this.el = h(
      "section",
      { class: "panel panel-tree", "aria-labelledby": "tree-title" },
      h(
        "header",
        { class: "panel-head tree-toolbar" },
        h("h1", { id: "tree-title", class: "visually-hidden", tabindex: "-1" }, "Skill tree"),
        h("div", { class: "segmented", role: "group", "aria-label": "View" }, this.modeBtns.graph, this.modeBtns.tree),
        this.filter,
        this.tidyBtn,
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "fill-pill play", onclick: () => void this.play() }, "▶ Play"),
      ),
      this.nextText,
      this.body,
    );
  }

  focus() {
    if (this.mode === "graph") this.graph.focus();
    else this.modeBtns.tree.focus();
  }

  escape(): boolean {
    return this.mode === "graph" && this.graph.escape();
  }

  update(s: Snapshot) {
    this.modeBtns.graph.setAttribute("aria-pressed", String(this.mode === "graph"));
    this.modeBtns.tree.setAttribute("aria-pressed", String(this.mode === "tree"));
    this.filter.hidden = this.mode !== "graph";
    this.tidyBtn.hidden = this.mode !== "graph";
    this.nextText.hidden = !this.played || !s.next;
    if (s.next) this.nextText.textContent = `Next: ${skillName(s.next.skill)}. ${s.next.why}`;
    else if (this.played) this.nextText.textContent = "";
    if (this.mode === "tree") {
      this.skills.update(s);
      if (this.body.firstChild !== this.skills.el) this.body.replaceChildren(this.skills.el);
      return;
    }
    if (!s.tree) {
      if (this.body.firstChild !== this.loading) this.body.replaceChildren(this.loading);
      return;
    }
    const tracks = s.tree.tracks;
    const opts = JSON.stringify(tracks.map((t) => [t.name, t.lang, t.done, t.total]));
    if (this.filter.dataset.key !== opts) {
      this.filter.dataset.key = opts;
      this.filter.replaceChildren(
        h("option", { value: "" }, "All tracks"),
        ...tracks.map((t) => h("option", { value: t.lang }, `${t.name}${t.lang && t.lang !== t.name ? ` (${t.lang})` : ""} · ${t.done}/${t.total}`)),
      );
    }
    let track = this.chosen;
    if (track === null || (track && !tracks.some((t) => t.lang === track))) {
      const lang = s.activeZone ? goalLanguage(s.zones, s.activeZone.id).toLowerCase() : "";
      track = tracks.find((t) => lang && (t.lang.toLowerCase() === lang || t.name.toLowerCase() === lang))?.lang ?? "";
    }
    if (document.activeElement !== this.filter) this.filter.value = track;
    this.graph.update(s.tree, track, s.next, s.step);
    if (this.body.firstChild !== this.graph.el) this.body.replaceChildren(this.graph.el);
  }

  private redraw() {
    if (this.client.snap) this.update(this.client.snap);
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.redraw();
    this.modeBtns[m].focus();
  }

  private async play() {
    const r = await this.client.call({ type: "play", skill: null });
    if (!r.ok) return;
    this.played = true;
    const s = this.client.snap;
    // The pick may sit on another track: show them all so it can be seen.
    if (s?.next && s.tree && this.chosen !== "" && !s.tree.tracks.some((t) => t.lang === this.filter.value && t.nodes.some((n) => n.name === s.next!.skill.name))) this.chosen = "";
    if (this.mode !== "graph") this.mode = "graph";
    this.redraw();
    this.graph.spotlight();
  }
}

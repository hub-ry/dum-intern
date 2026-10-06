// The skill tree, drawn from the same view the web page uses: tracks, rungs by depth, where each skill stands.

import type { View as TreeData, NodeView, TrackView } from "../../web/view.ts";
import { h, icon } from "./dom.ts";

const STATE_TEXT: Record<NodeView["state"], string> = {
  built: "built - you implemented it on your own",
  recognized: "recognized - you've explained it; building it is next",
  open: "open - everything under it is built",
  locked: "locked - it builds on skills you haven't built yet",
};

export type TreeActions = {
  /** `:practice <skill> [in <lang>]`: practice tasks you do yourself. */
  practice(arg: string): void;
  /** Puts `course <skill>` in the message box. Starting it is still your send. */
  draftCourse(text: string): void;
};

export class SkillTree {
  readonly el = h("div", { class: "tree" });
  private track = "";
  private picked = "";
  private data: TreeData | null = null;
  private select = h("select", { "aria-label": "Track" });
  private rungs = h("ol", { class: "rungs" });
  private detail = h("div", { class: "node-detail", "aria-live": "polite" });
  private off = h("div", { class: "off-tree" });

  constructor(private actions: TreeActions) {
    this.select.addEventListener("change", () => {
      this.track = this.select.value;
      this.picked = "";
      this.draw();
    });
    this.el.append(
      h(
        "div",
        { class: "tree-head" },
        h("label", { class: "field-inline" }, h("span", {}, "track"), this.select),
        h(
          "div",
          { class: "legend", "aria-hidden": "true" },
          ...(["built", "recognized", "open", "locked"] as const).map((s) => h("span", { class: `legend-item node-${s}` }, h("i"), s)),
        ),
      ),
      this.rungs,
      this.detail,
      this.off,
    );
  }

  update(data: TreeData) {
    if (this.data && JSON.stringify(this.data) === JSON.stringify(data)) return;
    this.data = data;
    const key = (t: TrackView) => `${t.name}\u0000${t.lang}`;
    if (!data.tracks.some((t) => key(t) === this.track)) {
      // The track with the most built is most likely the one they're working in.
      const best = [...data.tracks].sort((a, b) => b.done - a.done)[0];
      this.track = best ? key(best) : "";
      this.picked = "";
    }
    this.select.replaceChildren(
      ...data.tracks.map((t) => h("option", { value: key(t), selected: key(t) === this.track }, `${t.name}${t.lang && t.lang !== t.name ? ` (${t.lang})` : ""} · ${t.done}/${t.total}`)),
    );
    this.select.value = this.track;
    this.draw();
  }

  private draw() {
    const data = this.data;
    if (!data) return;
    const track = data.tracks.find((t) => `${t.name}\u0000${t.lang}` === this.track);
    this.rungs.replaceChildren();
    if (track) {
      const depth = Math.max(0, ...track.nodes.map((n) => n.depth));
      for (let d = 0; d <= depth; d++) {
        const nodes = track.nodes.filter((n) => n.depth === d);
        if (!nodes.length) continue;
        this.rungs.append(
          h(
            "li",
            { class: "rung" },
            h("div", { class: "rung-label" }, d === 0 ? "start" : `step ${d + 1}`),
            h(
              "div",
              { class: "rung-nodes" },
              ...nodes.map((n) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: `node node-${n.state}${n.name === this.picked ? " picked" : ""}`,
                    "aria-pressed": String(n.name === this.picked),
                    "aria-label": `${n.name}: ${n.state}`,
                    onclick: () => {
                      this.picked = this.picked === n.name ? "" : n.name;
                      this.draw();
                    },
                  },
                  n.state === "locked" ? icon("lock") : n.state === "built" ? icon("check") : null,
                  h("span", {}, n.name),
                ),
              ),
            ),
          ),
        );
      }
    }
    const node = track?.nodes.find((n) => n.name === this.picked);
    this.detail.replaceChildren(...(track && node ? this.describe(track, node) : [h("p", { class: "muted" }, track ? "pick a skill to see what it rests on and what's next." : "no tracks yet.")]));
    this.detail.hidden = false;
    this.off.replaceChildren();
    if (data.off.length) {
      this.off.append(
        h("h4", {}, "off the tracks"),
        h("ul", { class: "off-list" }, ...data.off.map((s) => h("li", {}, h("span", {}, s.name), h("span", { class: "muted" }, `${s.lang ? `${s.lang} · ` : ""}${s.level}`)))),
      );
    }
    this.off.append(h("p", { class: "muted small" }, `${data.count} skill${data.count === 1 ? "" : "s"} on your tree. Only your own work moves them: an explanation for recognize, a reviewed unaided build for build.`));
  }

  private describe(track: TrackView, n: NodeView): Node[] {
    const where = track.lang ? ` in ${track.lang}` : "";
    const out: Node[] = [h("h4", {}, n.name), h("p", {}, STATE_TEXT[n.state])];
    if (n.level) out.push(h("p", { class: "muted" }, `level on your tree: ${n.level}`));
    if (n.requires.length) out.push(h("p", {}, h("span", { class: "muted" }, "rests on "), n.requires.join(", ")));
    if (n.needs.length) out.push(h("p", {}, h("span", { class: "muted" }, "still needs "), n.needs.join(", ")));
    const row = h("div", { class: "node-actions" });
    if (n.state === "locked" && n.next) {
      row.append(h("button", { type: "button", class: "btn small", onclick: () => this.actions.practice(`${n.next}${where}`) }, `practice ${n.next} first`));
    } else if (n.state === "open" || n.state === "recognized") {
      row.append(h("button", { type: "button", class: "btn small", onclick: () => this.actions.practice(`${n.name}${where}`) }, "practice it"));
      if (n.state === "open") row.append(h("button", { type: "button", class: "btn small ghost", onclick: () => this.actions.draftCourse(`course ${n.name}${where}`) }, "short course"));
    } else if (n.state === "built") {
      row.append(h("button", { type: "button", class: "btn small ghost", onclick: () => this.actions.practice(`${n.name}${where}`) }, "practice more"));
    }
    if (row.childElementCount) out.push(row);
    if (n.state === "open") out.push(h("p", { class: "muted small" }, "a short course counts as recognizing it. building it means writing it yourself and handing it in."));
    return out;
  }
}

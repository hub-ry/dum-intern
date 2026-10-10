// The skill graph: every skill as a node, laid out by prerequisites. Columns are depth (left → right),
// rows are sorted inside a column, and each track is its own band when all are shown. Explore it the
// way you would an Obsidian graph: drag the background to pan, wheel or pinch to zoom around the
// pointer, drag a node to move it (it keeps a small offset and springs back toward its ordered slot).
// Tidy puts everything back. Keyboard: arrows walk along edges and columns, Enter opens the card, Esc closes it.
// State is never color alone: built is filled, recognized half-filled, open outlined with a glow, locked
// dim with a lock, trusted has a dashed ring and a "trusted" tag, and the next skill pulses with a "next" tag.

import type { View as TreeData, State as NodeState } from "../../web/view.ts";
import type { NextSkill, StepView } from "../../step-types.ts";
import type { SkillRef } from "../../zone-types.ts";
import { h, icon, reducedMotion } from "./dom.ts";

const NS = "http://www.w3.org/2000/svg";
const NODE_W = 150;
const NODE_H = 32;
const COL = 200;
const ROW = 48;
const BAND_HEAD = 30;
const BAND_GAP = 28;
/** How far a dragged node may stay from its slot once let go. */
const KEEP = 22;
const MIN_ZOOM = 0.3;
/** The first view and Tidy never shrink labels below this; a wider graph is panned, not squeezed. */
const FIT_ZOOM = 0.8;
const MAX_ZOOM = 2.5;

const STATE_TEXT: Record<NodeState, string> = {
  built: "built: you implemented it on your own",
  recognized: "recognized: you've explained it; building it is next",
  open: "open: everything under it is built",
  locked: "locked: it builds on skills you haven't built yet",
};

type GNode = {
  id: string;
  name: string;
  lang: string;
  track: string;
  state: NodeState;
  trusted: boolean;
  level: string | null;
  depth: number;
  requires: string[];
  needs: string[];
  /** Ids of prerequisites and dependents drawn in the graph. */
  ins: string[];
  outs: string[];
  col: number;
  row: number;
  band: number;
  x: number;
  y: number;
  el: SVGGElement | null;
};

type Edge = { from: string; to: string; el: SVGPathElement };

export type GraphActions = {
  play(skill: SkillRef): void;
  /** Skip, trust me: add the skill at build level by your own word. */
  trust(skill: SkillRef): Promise<boolean>;
  untrust(skill: SkillRef): Promise<boolean>;
  /** "Pick … for me" for the active goal's current step, when this node is its skill. */
  pick(step: StepView): void;
};

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: (Node | string | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid !== null) el.append(kid);
  return el;
}

const nodeId = (lang: string, name: string) => `${lang.toLowerCase()}\u0000${name.toLowerCase()}`;

export class SkillGraph {
  readonly el = h("div", { class: "graph" });
  private svg = svg("svg", { class: "graph-svg", tabindex: "0", role: "group", "aria-roledescription": "skill graph", "aria-label": "Skill graph. Arrow keys move along prerequisites, Enter opens a skill." });
  private world = svg("g", { class: "graph-world" });
  private edgeLayer = svg("g", { class: "graph-edges" });
  private nodeLayer = svg("g", { class: "graph-nodes" });
  private bandLayer = svg("g", { class: "graph-bands" });
  private card = h("div", { class: "graph-card", hidden: true, role: "dialog", "aria-label": "Skill" });
  private live = h("p", { class: "visually-hidden", "aria-live": "polite" });
  private nodes = new Map<string, GNode>();
  private edges: Edge[] = [];
  private offsets = new Map<string, { dx: number; dy: number }>();
  private targets = new Map<string, { dx: number; dy: number }>();
  private view = { x: 20, y: 20, k: 1 };
  private selected: string | null = null;
  private carded: string | null = null;
  private confirming = false;
  private busy = false;
  private next: string | null = null;
  private step: StepView | null = null;
  private data: TreeData | null = null;
  private filter = "";
  private key = "";
  private fitted = false;
  private frame = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { kind: "pan" | "node" | "pinch"; id?: string; startX: number; startY: number; moved: boolean; dist?: number } | null = null;

  constructor(private actions: GraphActions) {
    const defs = svg(
      "defs",
      {},
      svg("marker", { id: "graph-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, svg("path", { d: "M0 0L10 5L0 10z", class: "graph-arrowhead" })),
    );
    this.world.append(this.bandLayer, this.edgeLayer, this.nodeLayer);
    this.svg.append(defs, svg("rect", { class: "graph-bg", x: "0", y: "0", width: "100%", height: "100%" }), this.world);
    this.el.append(this.svg, this.card, this.live);
    this.svg.addEventListener("pointerdown", (e) => this.down(e));
    this.svg.addEventListener("pointermove", (e) => this.move(e));
    this.svg.addEventListener("pointerup", (e) => this.up(e));
    this.svg.addEventListener("pointercancel", (e) => this.up(e, true));
    this.svg.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.svg.addEventListener("keydown", (e) => this.onKey(e));
    this.svg.addEventListener("focus", () => {
      if (!this.selected) this.select(this.next && this.nodes.has(this.next) ? this.next : this.first(), false);
    });
    new ResizeObserver(() => {
      if (!this.fitted && this.svg.clientWidth) this.fit();
    }).observe(this.svg);
  }

  /** Draws the tree for one track (`lang` key) or all of them (""), the play pick and the active goal's step. */
  update(data: TreeData, filter: string, next: NextSkill | null, step: StepView | null) {
    this.next = next ? nodeId(next.skill.lang, next.skill.name) : null;
    this.step = step;
    const key = JSON.stringify([data, filter]);
    if (key !== this.key) {
      const refit = filter !== this.filter || !this.data;
      this.key = key;
      this.data = data;
      this.filter = filter;
      this.build();
      if (refit) {
        this.fitted = false;
        this.fit();
      }
    }
    for (const n of this.nodes.values()) n.el?.classList.toggle("is-next", n.id === this.next);
    if (this.carded && !this.nodes.has(this.carded)) this.closeCard();
    else if (this.carded) this.drawCard();
  }

  /** Play: select the recommended skill, center it and open its card. */
  spotlight() {
    if (!this.next || !this.nodes.has(this.next)) return false;
    this.select(this.next, true);
    this.center(this.next);
    this.openCard(this.next);
    return true;
  }

  /** Tidy: every node springs back to its ordered slot, and the whole graph fits the view. */
  tidy() {
    for (const id of this.offsets.keys()) this.targets.set(id, { dx: 0, dy: 0 });
    this.animate();
    this.fit();
  }

  focus() {
    this.svg.focus();
  }

  /** Esc: closes the card first. True when it had something to close. */
  escape(): boolean {
    if (this.confirming) {
      this.confirming = false;
      this.drawCard();
      this.card.querySelector<HTMLElement>("[data-focus='trust']")?.focus();
      return true;
    }
    if (!this.carded) return false;
    this.closeCard();
    this.svg.focus();
    return true;
  }

  // -- layout -----------------------------------------------------------------------

  private build() {
    const data = this.data!;
    this.nodes.clear();
    const tracks = data.tracks.filter((t) => !this.filter || t.lang === this.filter);
    let top = 0;
    const bands: { label: string; top: number; height: number }[] = [];
    tracks.forEach((track, band) => {
      const byName = new Map(track.nodes.map((n) => [n.name.toLowerCase(), nodeId(track.lang, n.name)]));
      const local: GNode[] = track.nodes.map((n) => ({
        id: nodeId(track.lang, n.name), name: n.name, lang: track.lang, track: track.name, state: n.state, trusted: n.trusted, level: n.level,
        depth: n.depth, requires: n.requires, needs: n.needs, ins: n.requires.map((r) => byName.get(r.toLowerCase())).filter((r): r is string => !!r),
        outs: [], col: n.depth, row: 0, band, x: 0, y: 0, el: null,
      }));
      for (const n of local) this.nodes.set(n.id, n);
      for (const n of local) for (const r of n.ins) this.nodes.get(r)?.outs.push(n.id);
      // Rows: the first column alphabetically, every later one by where its prerequisites sit (fewer crossings), then name.
      const maxDepth = Math.max(0, ...local.map((n) => n.depth));
      let tallest = 1;
      for (let d = 0; d <= maxDepth; d++) {
        const col = local.filter((n) => n.depth === d);
        const weight = (n: GNode) => {
          const rows = n.ins.map((r) => this.nodes.get(r)!.row);
          return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0;
        };
        col.sort((a, b) => (d === 0 ? 0 : weight(a) - weight(b)) || a.name.localeCompare(b.name));
        col.forEach((n, i) => (n.row = i));
        tallest = Math.max(tallest, col.length);
      }
      for (const n of local) {
        n.x = n.col * COL;
        n.y = top + BAND_HEAD + n.row * ROW;
      }
      const height = BAND_HEAD + tallest * ROW;
      bands.push({ label: `${track.name}${track.lang && track.lang !== track.name ? ` (${track.lang})` : ""} · ${track.done}/${track.total}`, top, height });
      top += height + BAND_GAP;
    });
    for (const id of this.offsets.keys()) if (!this.nodes.has(id)) this.offsets.delete(id);
    this.bandLayer.replaceChildren(
      ...bands.map((b, i) =>
        svg(
          "g",
          { class: "graph-band" },
          svg("rect", { x: -16, y: b.top - 8, width: Math.max(...[...this.nodes.values()].filter((n) => n.band === i).map((n) => n.x), 0) + NODE_W + 32, height: b.height, rx: 12 }),
          svg("text", { x: -4, y: b.top + 12, class: "graph-band-label" }, b.label),
        )),
    );
    this.nodeLayer.replaceChildren(...[...this.nodes.values()].map((n) => this.drawNode(n)));
    this.edges = [];
    this.edgeLayer.replaceChildren();
    for (const n of this.nodes.values()) {
      for (const r of n.ins) {
        const el = svg("path", { class: `graph-edge${n.state === "locked" ? " dim" : ""}`, "marker-end": "url(#graph-arrow)" });
        this.edges.push({ from: r, to: n.id, el });
        this.edgeLayer.append(el);
      }
    }
    if (this.selected && !this.nodes.has(this.selected)) this.selected = null;
    this.place();
    this.paintSelection();
  }

  private drawNode(n: GNode): SVGGElement {
    const short = n.name.length > 19 ? `${n.name.slice(0, 18)}…` : n.name;
    const tag = n.trusted ? "trusted" : "";
    const g = svg(
      "g",
      { class: `graph-node node-${n.state}${n.trusted ? " trusted" : ""}`, "data-node": n.id },
      svg("title", {}, `${n.name}: ${n.state}${n.trusted ? ", trusted" : ""}`),
      svg("rect", { class: "graph-node-ring", x: -4, y: -4, width: NODE_W + 8, height: NODE_H + 8, rx: (NODE_H + 8) / 2 }),
      svg("rect", { class: "graph-node-body", x: 0, y: 0, width: NODE_W, height: NODE_H, rx: NODE_H / 2 }),
      n.state === "recognized" ? svg("path", { class: "graph-node-half", d: `M${NODE_H / 2} 0H${NODE_W / 2}V${NODE_H}H${NODE_H / 2}A${NODE_H / 2} ${NODE_H / 2} 0 0 1 ${NODE_H / 2} 0z` }) : null,
      svg("text", { class: "graph-node-label", x: n.state === "locked" ? 28 : 14, y: NODE_H / 2 + 4 }, short),
      tag ? svg("text", { class: "graph-node-tag", x: NODE_W - 8, y: -7, "text-anchor": "end" }, tag) : null,
      svg("text", { class: "graph-node-next", x: 8, y: -7 }, "next"),
    );
    if (n.state === "locked") {
      const lock = icon("lock");
      for (const [k, v] of Object.entries({ x: 9, y: 8, width: 16, height: 16 })) lock.setAttribute(k, String(v));
      g.append(lock);
    }
    n.el = g;
    return g;
  }

  /** Positions every node and edge from slot + offset, and the world from the view. */
  private place() {
    for (const n of this.nodes.values()) {
      const o = this.offsets.get(n.id);
      n.el?.setAttribute("transform", `translate(${n.x + (o?.dx ?? 0)} ${n.y + (o?.dy ?? 0)})`);
    }
    for (const e of this.edges) {
      const a = this.pos(e.from);
      const b = this.pos(e.to);
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x - 3;
      const y2 = b.y + NODE_H / 2;
      const bend = Math.max(30, Math.abs(x2 - x1) / 2);
      e.el.setAttribute("d", `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`);
    }
    this.world.setAttribute("transform", `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
  }

  private pos(id: string): { x: number; y: number } {
    const n = this.nodes.get(id)!;
    const o = this.offsets.get(id);
    return { x: n.x + (o?.dx ?? 0), y: n.y + (o?.dy ?? 0) };
  }

  private fit() {
    const w = this.svg.clientWidth;
    const hgt = this.svg.clientHeight;
    if (!w || !hgt || !this.nodes.size) return;
    const xs = [...this.nodes.values()].map((n) => n.x);
    const ys = [...this.nodes.values()].map((n) => n.y);
    const minX = Math.min(...xs) - 20;
    const minY = Math.min(...ys) - BAND_HEAD;
    const bw = Math.max(...xs) + NODE_W + 20 - minX;
    const bh = Math.max(...ys) + NODE_H + 20 - minY;
    const k = Math.max(FIT_ZOOM, Math.min(1, (w - 32) / bw, (hgt - 32) / bh));
    const y = 16 - minY * k;
    if (bw * k <= w - 32) {
      this.view = { k, x: (w - bw * k) / 2 - minX * k, y };
    } else {
      // Too wide to read whole: start at the next skill's column, else at the first column.
      const at = this.next && this.nodes.has(this.next) ? this.pos(this.next).x + NODE_W / 2 : null;
      const x = at === null ? 16 - minX * k : w / 2 - at * k;
      this.view = { k, x: Math.min(16 - minX * k, Math.max(w - 16 - (minX + bw) * k, x)), y };
    }
    this.fitted = true;
    this.place();
  }

  private center(id: string) {
    const p = this.pos(id);
    const k = Math.max(this.view.k, 0.8);
    this.view = { k, x: this.svg.clientWidth / 2 - (p.x + NODE_W / 2) * k, y: this.svg.clientHeight / 2 - (p.y + NODE_H / 2) * k };
    this.place();
  }

  /** Keeps a keyboard-selected node inside the view. */
  private reveal(id: string) {
    const p = this.pos(id);
    const { x, y, k } = this.view;
    const sx = x + p.x * k;
    const sy = y + p.y * k;
    const w = this.svg.clientWidth;
    const hgt = this.svg.clientHeight;
    const pad = 24;
    let dx = 0;
    let dy = 0;
    if (sx < pad) dx = pad - sx;
    else if (sx + NODE_W * k > w - pad) dx = w - pad - (sx + NODE_W * k);
    if (sy < pad + 20) dy = pad + 20 - sy;
    else if (sy + NODE_H * k > hgt - pad) dy = hgt - pad - (sy + NODE_H * k);
    if (!dx && !dy) return;
    this.view = { k, x: x + dx, y: y + dy };
    this.place();
  }

  // -- springs ----------------------------------------------------------------------

  private animate() {
    if (reducedMotion.matches) {
      for (const [id, t] of this.targets) this.offsets.set(id, t);
      this.targets.clear();
      this.prune();
      this.place();
      return;
    }
    if (this.frame) return;
    const step = () => {
      for (const [id, t] of this.targets) {
        const o = this.offsets.get(id) ?? { dx: 0, dy: 0 };
        const dx = o.dx + (t.dx - o.dx) * 0.16;
        const dy = o.dy + (t.dy - o.dy) * 0.16;
        if (Math.abs(t.dx - dx) < 0.3 && Math.abs(t.dy - dy) < 0.3) {
          this.offsets.set(id, t);
          this.targets.delete(id);
        } else this.offsets.set(id, { dx, dy });
      }
      this.place();
      this.frame = this.targets.size ? requestAnimationFrame(step) : 0;
      if (!this.frame) this.prune();
    };
    this.frame = requestAnimationFrame(step);
  }

  private prune() {
    for (const [id, o] of this.offsets) if (!o.dx && !o.dy) this.offsets.delete(id);
  }

  // -- pointer ----------------------------------------------------------------------

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.svg.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: "pinch", startX: 0, startY: 0, moved: true, dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
      return;
    }
    const target = (e.target as Element).closest("[data-node]");
    const id = target?.getAttribute("data-node") ?? undefined;
    const p = this.local(e);
    this.gesture = { kind: id ? "node" : "pan", id, startX: p.x, startY: p.y, moved: false };
    if (id) this.targets.delete(id);
    this.el.classList.add(id ? "dragging-node" : "panning");
  }

  private move(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    const g = this.gesture;
    if (!prev || !g) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (g.kind === "pinch") {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / (g.dist || dist));
      g.dist = dist;
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) < 4) return;
    g.moved = true;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (g.kind === "pan") {
      this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    } else if (g.id) {
      const o = this.offsets.get(g.id) ?? { dx: 0, dy: 0 };
      this.offsets.set(g.id, { dx: o.dx + dx / this.view.k, dy: o.dy + dy / this.view.k });
    }
    this.place();
  }

  private up(e: PointerEvent, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (this.pointers.size) return;
    this.gesture = null;
    this.el.classList.remove("panning", "dragging-node");
    if (!g || cancelled) return;
    if (g.kind === "node" && g.id) {
      if (!g.moved) {
        this.select(g.id, false);
        this.openCard(g.id);
        return;
      }
      // Let go: it keeps a little of where you put it and springs toward its ordered slot.
      const o = this.offsets.get(g.id) ?? { dx: 0, dy: 0 };
      const len = Math.hypot(o.dx, o.dy);
      const keep = len > KEEP ? KEEP / len : 1;
      this.targets.set(g.id, { dx: o.dx * keep, dy: o.dy * keep });
      this.animate();
    } else if (g.kind === "pan" && !g.moved && this.carded) this.closeCard();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    // A trackpad pinch arrives as a wheel with ctrlKey and small deltas; scale it up to feel the same.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomAt(p.x, p.y, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
  }

  private zoomAt(px: number, py: number, factor: number) {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.k * factor));
    const ratio = k / this.view.k;
    this.view = { k, x: px - (px - this.view.x) * ratio, y: py - (py - this.view.y) * ratio };
    this.place();
  }

  // -- keyboard and selection ----------------------------------------------------------

  private first(): string | null {
    const all = [...this.nodes.values()].sort((a, b) => a.band - b.band || a.col - b.col || a.row - b.row);
    return all[0]?.id ?? null;
  }

  private onKey(e: KeyboardEvent) {
    if (e.target !== this.svg) return;
    const cur = this.selected ? this.nodes.get(this.selected) : undefined;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (cur) this.openCard(cur.id);
      return;
    }
    if (e.key === "+" || e.key === "=" || e.key === "-") {
      e.preventDefault();
      this.zoomAt(this.svg.clientWidth / 2, this.svg.clientHeight / 2, e.key === "-" ? 1 / 1.2 : 1.2);
      return;
    }
    const dirs: Record<string, true> = { ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, Home: true, End: true };
    if (!dirs[e.key]) return;
    e.preventDefault();
    if (!cur) return this.select(this.first(), true);
    const all = [...this.nodes.values()];
    const inCol = (band: number, col: number) => all.filter((n) => n.band === band && n.col === col).sort((a, b) => a.row - b.row);
    const nearest = (list: GNode[]) => list.sort((a, b) => Math.abs(a.row - cur.row) - Math.abs(b.row - cur.row))[0];
    let to: GNode | undefined;
    if (e.key === "ArrowRight") to = nearest(cur.outs.map((id) => this.nodes.get(id)!)) ?? nearest(inCol(cur.band, cur.col + 1));
    else if (e.key === "ArrowLeft") to = nearest(cur.ins.map((id) => this.nodes.get(id)!)) ?? nearest(inCol(cur.band, cur.col - 1));
    else if (e.key === "ArrowDown") to = inCol(cur.band, cur.col).find((n) => n.row === cur.row + 1) ?? inCol(cur.band + 1, 0)[0];
    else if (e.key === "ArrowUp") to = inCol(cur.band, cur.col).find((n) => n.row === cur.row - 1) ?? inCol(cur.band - 1, 0).at(-1);
    else if (e.key === "Home") to = inCol(cur.band, 0)[0];
    else to = all.filter((n) => n.band === cur.band).sort((a, b) => b.col - a.col || a.row - b.row)[0];
    if (to) this.select(to.id, true);
  }

  private select(id: string | null, announce: boolean) {
    this.selected = id;
    this.paintSelection();
    if (!id) return;
    this.reveal(id);
    const n = this.nodes.get(id)!;
    if (announce) this.live.textContent = `${n.name}, ${n.state}${n.trusted ? ", trusted" : ""}${id === this.next ? ", next" : ""}. ${n.requires.length ? `Rests on ${n.requires.join(", ")}.` : "No prerequisites."}`;
    if (this.carded && this.carded !== id) this.openCard(id, false);
  }

  private paintSelection() {
    for (const n of this.nodes.values()) n.el?.classList.toggle("selected", n.id === this.selected);
    for (const e of this.edges) e.el.classList.toggle("lit", e.from === this.selected || e.to === this.selected);
  }

  // -- detail card -------------------------------------------------------------------

  private openCard(id: string, focus = true) {
    this.carded = id;
    this.confirming = false;
    this.drawCard();
    if (focus) this.card.querySelector<HTMLElement>("button")?.focus();
  }

  private closeCard() {
    this.carded = null;
    this.confirming = false;
    this.card.hidden = true;
    this.card.replaceChildren();
  }

  private drawCard() {
    const n = this.carded ? this.nodes.get(this.carded) : undefined;
    if (!n) return this.closeCard();
    const skill: SkillRef = { name: n.name, lang: n.lang };
    const known = n.state === "built" || n.trusted;
    const trust = async () => {
      this.busy = true;
      this.drawCard();
      const ok = await this.actions.trust(skill).finally(() => (this.busy = false));
      if (ok) this.confirming = false;
      this.drawCard();
    };
    const focusKey = document.activeElement instanceof HTMLElement && this.card.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    const btn = (focus: string, label: Node | string, cls: string, onclick: () => void) =>
      h("button", { type: "button", class: `btn small ${cls}`, "data-focus": focus, disabled: this.busy, onclick }, label);
    this.card.setAttribute("aria-label", n.name);
    this.card.replaceChildren(...[
      h("div", { class: "graph-card-head" }, h("h3", {}, n.name), btn("close", "Close", "ghost", () => this.escape() || this.closeCard())),
      h("p", {}, STATE_TEXT[n.state], n.trusted ? h("span", { class: "chip chip-info" }, "trusted") : null, n.id === this.next ? h("span", { class: "chip chip-warn" }, "next") : null),
      n.level ? h("p", { class: "muted small" }, `Level on your tree: ${n.level}${n.trusted ? " (your word, not a review)" : ""}`) : null,
      h("p", { class: "small" }, h("span", { class: "muted" }, "Requires "), n.requires.length ? n.requires.join(", ") : "nothing"),
      n.needs.length ? h("p", { class: "small" }, h("span", { class: "muted" }, "Still needs "), n.needs.join(", ")) : null,
      this.confirming
        ? h(
            "div",
            { class: "graph-confirm" },
            h("p", {}, `Sure? Dum will treat ${n.name} as known and write it for you.`),
            h("div", { class: "actions" }, btn("trust", "Trust me", "primary", () => void trust()), btn("cancel", "Cancel", "ghost", () => this.escape())),
          )
        : h(
            "div",
            { class: "actions" },
            btn("play", h("span", {}, "▶ Work on this"), "primary", () => this.actions.play(skill)),
            this.step?.pick && this.step.skill && nodeId(this.step.skill.lang, this.step.skill.name) === n.id
              ? btn("pick", this.step.pick.label, "ghost", () => this.step && this.actions.pick(this.step))
              : null,
            !known ? btn("skip", "Skip, trust me", "ghost", () => {
              if (n.depth <= 1) return void trust();
              this.confirming = true;
              this.drawCard();
              this.card.querySelector<HTMLElement>("[data-focus='trust']")?.focus();
            }) : null,
            n.trusted ? btn("untrust", "Undo trust", "ghost", () => void this.actions.untrust(skill)) : null,
          ),
    ].filter((x) => x !== null));
    this.card.hidden = false;
    if (focusKey) this.card.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`)?.focus();
  }
}

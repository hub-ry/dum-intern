// The tree and the queue as one picture you can move around in.
//
// Two traditions, on purpose. The Rust project's skill-tree draws a roadmap as
// Graphviz boxes, each a group of items with a box to tick, climbing from what
// exists toward what's planned - which is exactly what a project is here: a
// group of skills it unlocks. Obsidian's graph is how you actually live in a
// vault: hover to see what touches what, click to read the note. So the layout
// is Graphviz's and the interaction is Obsidian's.
//
// It's one HTML file with everything inside it. Graphviz runs here, in Node, as
// WebAssembly from npm, and the SVG goes into the page already laid out; the
// pan-and-zoom script is inlined from node_modules. Nothing loads from a CDN,
// so it opens on a plane.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { instance } from "@viz-js/viz";
import * as skills from "./skills.ts";
import * as projects from "./projects.ts";
import { fileName } from "./notes.ts";

export type Node = {
  id: string;
  kind: "skill" | "project";
  title: string;
  /** solid | claimed | shaky | ghost for a skill; done | ready | waiting | unplanned for a project. */
  state: string;
  /** Skill: goal/step/idea is empty. Project: its kind. */
  sub: string;
  body: string;
  /** Where the note lives, for "open in Obsidian". "" for a ghost. */
  path: string;
  /** Skill: repos it was shown in. Project: its start request, if any. */
  extra: string[];
};

export type Edge = { from: string; to: string; kind: "req" | "after" };

export type Graph = { nodes: Node[]; edges: Edge[]; dot: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SKILL_MARK: Record<string, string> = { solid: "☑", claimed: "◐", shaky: "☐", ghost: "☐" };
const PROJECT_MARK: Record<string, string> = { done: "✓", ready: "▶", waiting: "·", unplanned: "?" };

/**
 * The graph, and the DOT that lays it out.
 *
 * A skill lives in exactly one place: as a row in the first project that
 * unlocks it, or as a node of its own if no project does. Its prerequisites
 * point at wherever they live - a node, or a row in some project's box - so
 * the tree you've grown and the climb you've queued are one graph, not two
 * pictures side by side.
 */
export function build(t: skills.Tree, ps: projects.Project[], home = skills.home()): Graph {
  const holds = projects.holder(t);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const idOf = new Map<string, string>(); // skill key -> node id, or "p-3:r2" for a row
  const nodeOf = new Map<string, string>(); // skill key -> the node it's drawn in

  // Projects first, so a skill some project unlocks is drawn as that row.
  const pid = new Map<string, string>();
  ps.forEach((p, i) => pid.set(skills.key(p.title), `p-${i}`));
  const rows = new Map<string, { key: string; name: string; port: string }[]>();
  // Every project lists everything it unlocks, the way a skill-tree group
  // lists its items even when another group has them too. One of those rows
  // is where the skill "lives" for its prerequisite edges: the first in a
  // step or goal, since that's the climb; an idea only when nothing else has it.
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => Number(a.p.kind === "idea") - Number(b.p.kind === "idea"));
  for (const { p, i } of order) {
    const id = `p-${i}`;
    const mine: { key: string; name: string; port: string }[] = [];
    p.unlocks.forEach((u, r) => {
      const k = skills.key(u);
      if (!k || mine.some((m) => m.key === k)) return;
      const port = `r${r}`;
      if (!idOf.has(k)) {
        idOf.set(k, `${id}:${port}`);
        nodeOf.set(k, id);
      }
      mine.push({ key: k, name: skills.find(t, u)?.name ?? u, port });
    });
    rows.set(id, mine);
  }
  ps.forEach((p, i) => {
    const id = `p-${i}`;
    nodes.push({
      id,
      kind: "project",
      title: p.title,
      state: projects.status(p, ps, holds),
      sub: p.kind,
      body: p.body,
      path: `${projects.folder(home)}/${fileName(p.title)}`,
      extra: p.start ? [p.start] : [],
    });
  });

  // Skills on the tree, then prerequisites nobody has recorded: the frontier.
  let n = 0;
  const skillNode = (name: string, state: string, s?: skills.Skill) => {
    const k = skills.key(name);
    const id = `s-${n++}`;
    idOf.set(k, id);
    nodeOf.set(k, id);
    nodes.push({
      id,
      kind: "skill",
      title: name,
      state,
      sub: s?.breadth === "niche" ? "niche" : "",
      body: s?.why ?? "",
      path: s ? `${skills.folder(home)}/${fileName(s.name)}` : "",
      extra: s?.repos ?? [],
    });
  };
  for (const s of t.skills) if (!idOf.has(skills.key(s.name))) skillNode(s.name, s.claimed ? "claimed" : s.solid ? "solid" : "shaky", s);
  for (const s of t.skills)
    for (const r of s.requires) if (!idOf.has(skills.key(r)) && !skills.find(t, r)) skillNode(r, "ghost");

  // Rows that are skills on the tree carry their note too, for the panel.
  const rowSkill = new Map<string, skills.Skill>();
  for (const s of t.skills) if (idOf.get(skills.key(s.name))?.includes(":")) rowSkill.set(skills.key(s.name), s);

  // Edges. Prerequisite -> what builds on it, between wherever each lives.
  const seen = new Set<string>();
  const dotEdges: string[] = [];
  const addEdge = (from: string, to: string, kind: Edge["kind"], fromAt: string, toAt: string) => {
    const tag = `${fromAt}->${toAt}`;
    if (from === to || seen.has(tag)) return;
    seen.add(tag);
    edges.push({ from, to, kind });
    dotEdges.push(
      `  ${q(fromAt)} -> ${q(toAt)} [id="e-${edges.length - 1}" class="${kind}"${kind === "after" ? ' penwidth=1.6' : ' style=dashed arrowsize=0.5'}]`,
    );
  };
  for (const s of t.skills) {
    const to = idOf.get(skills.key(s.name));
    if (!to) continue;
    for (const r of s.requires) {
      const from = idOf.get(skills.key(r));
      if (!from) continue;
      addEdge(nodeOf.get(skills.key(r))!, nodeOf.get(skills.key(s.name))!, "req", from, to);
    }
  }
  ps.forEach((p, i) => {
    for (const a of p.after) {
      const from = pid.get(skills.key(a));
      if (from) addEdge(from, `p-${i}`, "after", from, `p-${i}`);
    }
  });

  // -- DOT -------------------------------------------------------------------
  const skillDot = (nd: Node) =>
    `  ${q(nd.id)} [id="${nd.id}" class="skill ${nd.state}" label="${esc(nd.title)}"${nd.state === "ghost" ? " style=\"rounded,dashed\"" : ""}]`;
  const projectDot = (nd: Node) => {
    const head = `<TR><TD ALIGN="LEFT" CELLPADDING="7"><B>${esc(PROJECT_MARK[nd.state] ?? "")} ${esc(nd.title)}</B></TD></TR>`;
    const body = (rows.get(nd.id) ?? [])
      .map((r) => {
        const s = rowSkill.get(r.key);
        const state = s ? (s.claimed ? "claimed" : s.solid ? "solid" : "shaky") : "ghost";
        return `<TR><TD ALIGN="LEFT" PORT="${r.port}" HREF="#${nd.id}:${r.port}" TITLE="${esc(r.name)}">${SKILL_MARK[state]} ${esc(r.name)}</TD></TR>`;
      })
      .join("");
    return `  ${q(nd.id)} [id="${nd.id}" class="project ${nd.state} ${nd.sub}" shape=plain label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" STYLE="ROUNDED">${head}${body}</TABLE>>]`;
  };

  // A goal and the steps that lead to it share a frame, like a roadmap
  // section. The tree you've grown gets its own. Ideas float.
  const clusters: string[] = [];
  const inCluster = new Set<string>();
  ps.forEach((p, i) => {
    if (p.kind !== "goal") return;
    const members = ps
      .map((q, j) => ({ q, j }))
      .filter(({ q }) => q.kind === "step" && skills.key(q.leadsTo) === skills.key(p.title))
      .map(({ j }) => `p-${j}`);
    members.push(`p-${i}`);
    members.forEach((m) => inCluster.add(m));
    clusters.push(
      `  subgraph "cluster_${i}" {\n    id="c-${i}" class="goal" label="${esc(p.title)}" style="rounded,dashed"\n${members
        .map((m) => projectDot(nodes.find((x) => x.id === m)!))
        .map((l) => "  " + l)
        .join("\n")}\n  }`,
    );
  });
  const treeNodes = nodes.filter((x) => x.kind === "skill");
  const loose = nodes.filter((x) => x.kind === "project" && !inCluster.has(x.id));

  const dot = [
    "digraph dum {",
    '  graph [rankdir=TB bgcolor="transparent" nodesep=0.35 ranksep=0.55 fontname="Helvetica" fontsize=13 labeljust=l]',
    '  node [shape=box style="rounded" fontname="Helvetica" fontsize=12 margin="0.14,0.06"]',
    '  edge [arrowsize=0.6]',
    treeNodes.length
      ? `  subgraph "cluster_tree" {\n    id="c-tree" class="tree" label="your tree" style="rounded,dashed"\n${treeNodes.map((x) => "  " + skillDot(x)).join("\n")}\n  }`
      : "",
    ...clusters,
    ...loose.map(projectDot),
    ...dotEdges,
    "}",
  ]
    .filter(Boolean)
    .join("\n");

  // Rows get their own entries so a click on one opens that skill.
  for (const [pidKey, rs] of rows) {
    for (const r of rs) {
      const s = rowSkill.get(r.key);
      nodes.push({
        id: `${pidKey}:${r.port}`,
        kind: "skill",
        title: r.name,
        state: s ? (s.claimed ? "claimed" : s.solid ? "solid" : "shaky") : "ghost",
        sub: s?.breadth === "niche" ? "niche" : "",
        body: s?.why ?? "",
        path: s ? `${skills.folder(home)}/${fileName(s.name)}` : "",
        extra: s?.repos ?? [],
      });
    }
  }
  return { nodes, edges, dot };
}

const q = (id: string) => `"${id.replace(/"/g, "")}"`;

/** Lay the DOT out as SVG. */
export async function render(dot: string): Promise<string> {
  const viz = await instance();
  return viz.renderString(dot, { format: "svg" });
}

const require = createRequire(import.meta.url);

/** The whole page: SVG, data, style and script, in one file. */
export function page(svg: string, g: Graph, counts: { known: number; claimed: number; shaky: number; projects: number }): string {
  const panZoom = readFileSync(require.resolve("svg-pan-zoom/dist/svg-pan-zoom.min.js"), "utf8");
  // The data is text inside a script tag, so nothing in a note can close it.
  const data = JSON.stringify({ nodes: g.nodes, edges: g.edges }).replace(/</g, "\\u003c");
  const body = svg.replace(/^[\s\S]*?(<svg)/, "$1");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dum skill graph</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <span class="brand">dum</span>
  <span class="counts">${counts.known} known · ${counts.claimed} claimed · ${counts.shaky} shaky · ${counts.projects} projects</span>
  <input id="find" type="search" placeholder="find a skill or project" autocomplete="off" spellcheck="false">
</header>
<main>
  <div id="stage">${body}</div>
  <aside id="panel" hidden>
    <button id="close" aria-label="close">×</button>
    <div id="note"></div>
  </aside>
</main>
<footer>
  <span><i class="sw solid"></i>known</span><span><i class="sw claimed"></i>claimed</span><span><i class="sw shaky"></i>shaky</span><span><i class="sw ghost"></i>not shown yet</span>
  <span class="sep"></span>
  <span>✓ done</span><span>▶ ready</span><span>· waiting</span>
  <span class="hint">drag to pan · scroll to zoom · click to read</span>
</footer>
<script type="application/json" id="data">${data}</script>
<script>${panZoom}</script>
<script>${JS}</script>
</body>
</html>
`;
}

/** Build, render and write the page. Returns where it went. */
export async function write(dir = skills.home()): Promise<string> {
  const t = skills.read(dir);
  const ps = projects.read(dir);
  const g = build(t, ps, dir);
  const svg = await render(g.dot);
  const known = t.skills.filter((s) => s.solid && !s.claimed).length;
  const out = `${dir}/graph.html`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, page(svg, g, { known, claimed: skills.claimed(t).length, shaky: skills.shaky(t).length, projects: ps.length }));
  return out;
}

const CSS = `
:root {
  --bg: #fafafa; --panel: #ffffff; --line: #e3e3e3; --text: #222; --muted: #7a7a7a;
  --accent: #6c5ce7; --solid: #2f9e62; --claimed: #3d7fd6; --shaky: #c07b12; --ghost: #9a9a9a;
  --box: #ffffff; --edge: #b8b8b8; --after: #6c5ce7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e1e; --panel: #262626; --line: #363636; --text: #dcddde; --muted: #8b8b8b;
    --accent: #8f7ff5; --solid: #6bcf94; --claimed: #7fb0f0; --shaky: #e0ae5f; --ghost: #6f6f6f;
    --box: #2a2a2a; --edge: #555; --after: #8f7ff5;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 Helvetica, Arial, sans-serif; }
body { display: grid; grid-template-rows: auto 1fr auto; }
header, footer { display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-bottom: 1px solid var(--line); min-width: 0; flex-wrap: wrap; }
footer { border-bottom: 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; gap: 12px; }
.brand { font-weight: 700; color: var(--accent); }
.counts { color: var(--muted); font-size: 13px; }
#find { margin-left: auto; min-width: 0; width: 240px; max-width: 100%; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; }
main { position: relative; min-height: 0; overflow: hidden; }
#stage, #stage > svg { width: 100%; height: 100%; display: block; }
svg text { fill: var(--text); font-family: Helvetica, Arial, sans-serif; }
.graph > polygon { fill: transparent; }
.cluster > path, .cluster > polygon { fill: none; stroke: var(--line); }
.cluster > text { fill: var(--muted); }
.node.skill path, .node.skill polygon { fill: var(--box); stroke: var(--edge); stroke-width: 1.2; }
.node.skill.solid path, .node.skill.solid polygon { stroke: var(--solid); }
.node.skill.claimed path, .node.skill.claimed polygon { stroke: var(--claimed); }
.node.skill.shaky path, .node.skill.shaky polygon { stroke: var(--shaky); }
.node.skill.ghost path, .node.skill.ghost polygon { fill: transparent; stroke: var(--ghost); }
.node.skill.ghost text { fill: var(--muted); }
.node.project path, .node.project polygon { fill: var(--box); stroke: var(--edge); }
.node.project.ready path, .node.project.ready polygon { stroke: var(--accent); stroke-width: 1.6; }
.node.project.done path, .node.project.done polygon { stroke: var(--solid); }
.node.project.waiting text { fill: var(--muted); }
.node.project.goal path, .node.project.goal polygon { stroke-width: 2; }
a.row-solid text { fill: var(--solid); }
a.row-claimed text { fill: var(--claimed); }
a.row-shaky text { fill: var(--shaky); }
a.row-ghost text { fill: var(--muted); }
.edge path { stroke: var(--edge); fill: none; }
.edge polygon { fill: var(--edge); stroke: var(--edge); }
.edge.after path { stroke: var(--after); opacity: .55; }
.edge.after polygon { fill: var(--after); stroke: var(--after); opacity: .55; }
.node, a { cursor: pointer; }
.node, .edge, a { transition: opacity .12s; }
.dim { opacity: .15; }
.hit path, .hit polygon { stroke-width: 2.4 !important; }
#panel { position: absolute; top: 12px; right: 12px; bottom: 12px; width: min(380px, calc(100% - 24px)); overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 18px 22px; box-shadow: 0 8px 30px rgba(0,0,0,.18); }
#close { position: absolute; top: 8px; right: 10px; border: 0; background: none; color: var(--muted); font-size: 22px; cursor: pointer; }
#note h2 { margin: 0 24px 6px 0; font-size: 18px; }
#note .badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 99px; border: 1px solid currentColor; margin-right: 6px; }
#note .solid { color: var(--solid); } #note .claimed { color: var(--claimed); } #note .shaky { color: var(--shaky); } #note .ghost { color: var(--muted); }
#note .done { color: var(--solid); } #note .ready { color: var(--accent); } #note .waiting, #note .unplanned { color: var(--muted); }
#note h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 6px; }
#note p { margin: 8px 0; }
#note code, #note pre { font: 12.5px/1.4 ui-monospace, Menlo, monospace; background: var(--bg); border-radius: 4px; }
#note code { padding: 1px 4px; } #note pre { padding: 8px 10px; white-space: pre-wrap; word-break: break-word; }
#note a.link { color: var(--accent); text-decoration: none; display: inline-block; margin: 2px 8px 2px 0; }
#note a.link:hover { text-decoration: underline; }
#note .muted { color: var(--muted); font-size: 13px; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1.5px solid; margin-right: 5px; vertical-align: -1px; }
.sw.solid { border-color: var(--solid); } .sw.claimed { border-color: var(--claimed); } .sw.shaky { border-color: var(--shaky); } .sw.ghost { border-color: var(--ghost); border-style: dashed; }
.sep { width: 1px; height: 14px; background: var(--line); }
.hint { margin-left: auto; }
@media (max-width: 640px) { .hint { display: none; } #find { width: 100%; margin-left: 0; } }
`;

const JS = `
(() => {
  const data = JSON.parse(document.getElementById("data").textContent);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const svg = document.querySelector("#stage svg");
  svg.removeAttribute("width"); svg.removeAttribute("height");
  const pz = svgPanZoom(svg, { zoomScaleSensitivity: 0.3, minZoom: 0.1, maxZoom: 10, fit: true, center: true, dblClickZoomEnabled: false });
  window.addEventListener("resize", () => { pz.resize(); });

  // Rows inside a project's box: coloured by the skill's state, clickable.
  const rows = [...svg.querySelectorAll("a")].filter((a) => (a.getAttribute("xlink:href") || a.getAttribute("href") || "").startsWith("#"));
  for (const a of rows) {
    const id = (a.getAttribute("xlink:href") || a.getAttribute("href")).slice(1);
    const n = byId.get(id);
    if (n) a.classList.add("row-" + n.state);
    a.dataset.id = id;
  }

  // Who touches whom. A row counts as its project for the edges it draws.
  const near = new Map();
  const link = (a, b) => { if (!near.has(a)) near.set(a, new Set()); near.get(a).add(b); };
  data.edges.forEach((e, i) => { link(e.from, e.to); link(e.to, e.from); });
  const boxOf = (id) => id.split(":")[0];

  const all = () => svg.querySelectorAll(".node, .edge");
  function focus(id) {
    const box = boxOf(id);
    const keep = new Set([box, ...(near.get(box) || [])]);
    all().forEach((el) => el.classList.toggle("dim", !keep.has(el.id) && !isEdgeOf(el, box)));
  }
  function isEdgeOf(el, box) {
    if (!el.classList.contains("edge")) return false;
    const e = data.edges[Number(el.id.slice(2))];
    return e && (e.from === box || e.to === box);
  }
  function clear() { all().forEach((el) => el.classList.remove("dim")); }

  svg.querySelectorAll(".node").forEach((g) => {
    g.addEventListener("mouseenter", () => focus(g.id));
    g.addEventListener("mouseleave", clear);
  });

  // Drag is pan; only a click that didn't move opens a note.
  let down = null;
  svg.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  svg.addEventListener("click", (e) => {
    const moved = down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4;
    const row = e.target.closest("a[data-id]");
    if (row) e.preventDefault();
    if (moved) return;
    const g = e.target.closest(".node");
    const id = row ? row.dataset.id : g && g.id;
    if (id && byId.has(id)) open(id);
  });

  const panel = document.getElementById("panel");
  const note = document.getElementById("note");
  document.getElementById("close").onclick = () => { panel.hidden = true; svg.querySelectorAll(".hit").forEach((x) => x.classList.remove("hit")); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("close").click(); });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Just enough markdown for a brief: paragraphs, bold, inline code.
  const md = (s) => s.trim().split(/\\n{2,}/).map((p) => "<p>" + esc(p).replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>").replace(/\`([^\`]+)\`/g, "<code>$1</code>") + "</p>").join("");
  const WORD = { solid: "known", claimed: "claimed", shaky: "shaky", ghost: "not shown yet", done: "done", ready: "ready", waiting: "waiting", unplanned: "not planned yet" };
  const linkTo = (id) => { const n = byId.get(id); return n ? '<a class="link" href="#" data-go="' + esc(id) + '">' + esc(n.title) + "</a>" : ""; };

  function open(id) {
    const n = byId.get(id);
    const box = boxOf(id);
    const ins = data.edges.filter((e) => e.to === box).map((e) => e.from);
    const outs = data.edges.filter((e) => e.from === box).map((e) => e.to);
    let h = "<h2>" + esc(n.title) + "</h2>";
    h += '<span class="badge ' + n.state + '">' + (WORD[n.state] || n.state) + "</span>";
    if (n.sub) h += '<span class="badge ghost">' + esc(n.sub) + "</span>";
    if (n.body) h += md(n.body);
    else if (n.kind === "skill" && n.state === "ghost") h += '<p class="muted">Something on your tree builds on this, and you haven\\'t shown it yet. That\\'s the frontier.</p>';
    if (n.kind === "project") {
      const rowsHere = data.nodes.filter((x) => x.id.startsWith(n.id + ":"));
      if (rowsHere.length) h += "<h3>unlocks</h3>" + rowsHere.map((r) => linkTo(r.id)).join("");
      if (n.extra[0]) h += "<h3>start</h3><pre>dum \\"" + esc(n.extra[0]) + "\\"</pre>";
    }
    if (ins.length) h += "<h3>" + (n.kind === "project" ? "comes after" : "builds on") + "</h3>" + [...new Set(ins)].map(linkTo).join("");
    if (outs.length) h += "<h3>" + (n.kind === "project" ? "leads to" : "built on by") + "</h3>" + [...new Set(outs)].map(linkTo).join("");
    if (n.kind === "skill" && id.includes(":")) h += "<h3>unlocked by</h3>" + linkTo(box);
    if (n.kind === "skill" && n.extra.length) h += "<h3>shown in</h3>" + n.extra.map((r) => '<div class="muted">' + esc(r) + "</div>").join("");
    if (n.path) h += '<h3>note</h3><a class="link" href="obsidian://open?path=' + encodeURIComponent(n.path) + '">open in Obsidian</a><div class="muted">' + esc(n.path) + "</div>";
    note.innerHTML = h;
    panel.hidden = false;
    svg.querySelectorAll(".hit").forEach((x) => x.classList.remove("hit"));
    const el = document.getElementById(box);
    if (el) el.classList.add("hit");
  }
  note.addEventListener("click", (e) => {
    const a = e.target.closest("[data-go]");
    if (!a) return;
    e.preventDefault();
    open(a.dataset.go);
    center(boxOf(a.dataset.go));
  });

  // Into the middle of what the panel leaves visible, not under it.
  function center(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const r = el.getBoundingClientRect(), s = svg.getBoundingClientRect();
    const covered = panel.hidden || s.width < 700 ? 0 : panel.getBoundingClientRect().width + 12;
    const cx = s.left + (s.width - covered) / 2;
    pz.panBy({ x: cx - (r.left + r.width / 2), y: s.top + s.height / 2 - (r.top + r.height / 2) });
  }

  // #open=<id> opens a note on load, so a link can point into the graph.
  const want = decodeURIComponent((location.hash.match(/^#open=(.+)$/) || [])[1] || "");
  if (want && byId.has(want)) { open(want); center(boxOf(want)); }

  const find = document.getElementById("find");
  find.addEventListener("input", () => {
    const q = find.value.trim().toLowerCase();
    if (!q) return clear();
    const hit = data.nodes.find((n) => n.title.toLowerCase().includes(q));
    if (!hit) return;
    focus(hit.id);
    center(boxOf(hit.id));
  });
  find.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = find.value.trim().toLowerCase();
    const hit = data.nodes.find((n) => n.title.toLowerCase().includes(q));
    if (hit) open(hit.id);
  });
})();
`;

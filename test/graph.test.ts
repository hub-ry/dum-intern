import { test } from "node:test";
import assert from "node:assert/strict";
import { build, page, render } from "../src/graph.ts";
import type { Skill, Tree } from "../src/skills.ts";
import type { Project } from "../src/projects.ts";

const sk = (name: string, over: Partial<Skill> = {}): Skill => ({
  name, solid: true, claimed: false, breadth: "general", requires: [], why: "", repos: [], at: "", ...over,
});
const pr = (title: string, over: Partial<Project> = {}): Project => ({
  title, kind: "step", unlocks: [], after: [], leadsTo: "", start: "", planned: "2026-09-25", body: "", ...over,
});

const tree: Tree = {
  skills: [
    sk("functions"),
    sk("tcp sockets", { solid: false, requires: ["functions", "byte streams"] }),
    sk("http", { claimed: true, requires: ["tcp sockets"] }),
  ],
};
const queue: Project[] = [
  pr("an idea", { kind: "idea", unlocks: ["tcp sockets"] }),
  pr("echo server", { unlocks: ["tcp sockets"], leadsTo: "chat" }),
  pr("chat", { kind: "goal", unlocks: ["websockets"], after: ["echo server"] }),
];

test("a skill a project unlocks is a row in it, and lives in the step before the idea", () => {
  const g = build(tree, queue, "/h");
  const echo = g.nodes.find((n) => n.title === "echo server")!;
  const idea = g.nodes.find((n) => n.title === "an idea")!;
  // Both boxes list it...
  assert.ok(g.nodes.some((n) => n.id.startsWith(echo.id + ":") && n.title === "tcp sockets"));
  assert.ok(g.nodes.some((n) => n.id.startsWith(idea.id + ":") && n.title === "tcp sockets"));
  // ...but its prerequisite edges attach to the step's row.
  assert.match(g.dot, new RegExp(`-> "${echo.id}:r0"`));
  assert.doesNotMatch(g.dot, new RegExp(`-> "${idea.id}:r0"`));
});

test("skills no project unlocks are nodes, and unrecorded prerequisites are ghosts", () => {
  const g = build(tree, queue, "/h");
  const state = (t: string) => g.nodes.find((n) => n.title === t && !n.id.includes(":"))?.state;
  assert.equal(state("functions"), "solid");
  assert.equal(state("http"), "claimed");
  assert.equal(state("byte streams"), "ghost");
  assert.match(g.dot, /class="skill ghost"[^\]]*dashed/);
});

test("after is a project edge, and a goal frames its steps", () => {
  const g = build(tree, queue, "/h");
  assert.ok(g.edges.some((e) => e.kind === "after"));
  assert.match(g.dot, /subgraph "cluster_\d+" \{\s*id="c-\d+" class="goal" label="chat"/);
});

test("labels are escaped, so a note can't break the layout", () => {
  const g = build({ skills: [sk('a <b> & "c"')] }, [], "/h");
  assert.match(g.dot, /label="a &lt;b&gt; &amp; &quot;c&quot;"/);
});

test("the page is one file: no network, and the data can't close its script tag", async () => {
  const g = build({ skills: [sk("x", { why: "</script><script>alert(1)</script>" })] }, [], "/h");
  const html = page(await render(g.dot), g, { known: 1, claimed: 0, shaky: 0, projects: 0 });
  // Namespace URIs and a licence comment are fine; anything that loads isn't.
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:|fetch\(/);
  assert.equal(html.split("</script>").length - 1, 3, "only the three real script tags close");
  assert.match(html, /<svg/);
});

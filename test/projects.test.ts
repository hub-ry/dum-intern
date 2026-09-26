import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fromNote, toNote, tiers, ladder, status, read, write, folder, type Project, type Need } from "../src/projects.ts";

const known = (...names: string[]) => (n: string) => names.map((x) => x.toLowerCase()).includes(n.toLowerCase());

// A game server, eight-ish tiers up from someone who knows loops and functions.
const server: Need[] = [
  { name: "multiplayer game server", requires: ["tick loops", "websockets"] },
  { name: "tick loops", requires: ["event loops"] },
  { name: "websockets", requires: ["http", "tcp sockets"] },
  { name: "http", requires: ["tcp sockets"] },
  { name: "tcp sockets", requires: ["byte streams"] },
  { name: "byte streams", requires: ["functions"] },
  { name: "event loops", requires: ["callbacks"] },
  { name: "callbacks", requires: ["functions"] },
];

test("tiers count up from what you hold", () => {
  const t = tiers(server, known("functions"));
  assert.equal(t.get("byte streams"), 1);
  assert.equal(t.get("tcp sockets"), 2);
  assert.equal(t.get("http"), 3);
  assert.equal(t.get("websockets"), 4);
  assert.equal(t.get("multiplayer game server"), 5);
  // Knowing a middle rung lowers everything above it.
  assert.equal(tiers(server, known("functions", "tcp sockets")).get("websockets"), 2);
});

test("a cycle in the map is cut, not followed forever", () => {
  const t = tiers([{ name: "a", requires: ["b"] }, { name: "b", requires: ["a"] }], known());
  assert.ok(t.get("a")! >= 1 && t.get("b")! >= 1);
});

test("the ladder: a step per tier below the goal, ordered only by real dependencies", () => {
  const { steps, top, topAfter, height } = ladder(server, known("functions"));
  assert.equal(height, 5);
  assert.deepEqual(top, ["multiplayer game server"]);
  assert.deepEqual(topAfter, [2, 3]);
  assert.deepEqual(steps.map((s) => [s.tier, s.unlocks]), [
    [1, ["byte streams", "callbacks"]],
    [2, ["tcp sockets", "event loops"]],
    [3, ["tick loops", "http"]],
    [4, ["websockets"]],
  ]);
  assert.deepEqual(steps.map((s) => s.after), [[], [0], [1], [1, 2]]);
});

test("a goal one tier up needs no steps", () => {
  const { steps, top } = ladder([{ name: "a", requires: ["x"] }, { name: "b", requires: [] }], known("x"));
  assert.deepEqual(steps, []);
  assert.deepEqual(top, ["a", "b"]);
});

test("a wide tier is cut into evening-sized steps", () => {
  const wide: Need[] = [
    { name: "goal", requires: ["a", "b", "c", "d", "e"] },
    ...["a", "b", "c", "d", "e"].map((n) => ({ name: n, requires: [] })),
  ];
  assert.deepEqual(ladder(wide, known()).steps.map((s) => s.unlocks), [["a", "b", "c"], ["d", "e"]]);
});

const p = (title: string, over: Partial<Project> = {}): Project => ({
  title,
  kind: "step",
  unlocks: [],
  after: [],
  leadsTo: "",
  start: "",
  planned: "2026-09-25",
  body: "",
  ...over,
});

test("status comes off the tree: done when unlocked, ready when what's before is done", () => {
  const a = p("echo server", { unlocks: ["tcp sockets"] });
  const b = p("chat room", { unlocks: ["websockets"], after: ["echo server"] });
  const idea = p("some idea", { kind: "idea", planned: "" });
  const all = [a, b, idea];
  assert.equal(status(a, all, known()), "ready");
  assert.equal(status(b, all, known()), "waiting");
  assert.equal(status(a, all, known("tcp sockets")), "done");
  assert.equal(status(b, all, known("tcp sockets")), "ready");
  assert.equal(status(idea, all, known()), "unplanned");
  // A loop someone wrote by hand blocks nothing.
  const x = p("x", { unlocks: ["q"], after: ["y"] });
  const y = p("y", { unlocks: ["r"], after: ["x"] });
  assert.equal(status(x, [x, y], known()), "waiting");
});

test("a project round-trips, and a bare markdown file is an unplanned idea", () => {
  const q = p("chat room / v2", { kind: "goal", unlocks: ["websockets"], after: ["echo server"], start: "add a /join command", body: "Build a chat room." });
  assert.deepEqual(fromNote(toNote(q), "x.md"), q);
  assert.match(toNote(q), /after: \[\[echo server\]\]/);
  const dir = mkdtempSync(`${tmpdir()}/dum-proj-`);
  mkdirSync(folder(dir));
  writeFileSync(`${folder(dir)}/a raytracer.md`, "I want to render spheres with shadows.\n");
  const got = read(dir);
  assert.equal(got[0]!.title, "a raytracer");
  assert.equal(status(got[0]!, got, known()), "unplanned");
  write([{ ...got[0]!, kind: "goal", planned: "2026-09-25", unlocks: ["ray tracing"] }], dir);
  assert.equal(read(dir).length, 1, "rewrites the same note, not a second one");
});

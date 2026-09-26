import { test } from "node:test";
import assert from "node:assert/strict";
import { fileName, fromNote, toNote } from "../src/notes.ts";
import type { Skill } from "../src/skills.ts";

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "leases",
  solid: true,
  claimed: false,
  breadth: "general",
  requires: [],
  why: "",
  repos: [],
  at: "2026-09-23T04:03:15.135Z",
  ...over,
});

test("a note round-trips every state", () => {
  for (const over of [{}, { solid: false }, { claimed: true }, { breadth: "niche" as const, repos: ["/r"] }]) {
    const s = skill({ ...over, requires: ["timeouts", "Side / ranking"], why: "They said `x`." });
    assert.deepEqual(fromNote(toNote(s), fileName(s.name)), s);
  }
});

test("builds-on is Obsidian links, aliased when the file name had to change", () => {
  const text = toNote(skill({ requires: ["timeouts", "retrieval / ranking split"] }));
  assert.match(text, /builds on: \[\[timeouts\]\], \[\[retrieval - ranking split\|retrieval \/ ranking split\]\]/);
  assert.match(text, /tags:\n  - dum\/solid/);
});

test("file names drop what a file system or Obsidian refuses", () => {
  assert.equal(fileName("Side features and the retrieval / ranking split"), "Side features and the retrieval - ranking split.md");
  assert.equal(fileName("c++ templates"), "c++ templates.md");
  assert.equal(fileName("  ..  "), "skill.md");
});

test("any link in the body is a prerequisite, and an unknown state is a claim", () => {
  const s = fromNote("---\nstate: expert\n---\nlike [[a]] and [[b|B]]\n", "x.md")!;
  assert.deepEqual(s.requires, ["a", "B"]);
  assert.ok(s.claimed);
  assert.equal(s.name, "x");
});

test("a scan reply is read even with a fence or a sentence around it", async () => {
  const { parse } = await import("../src/scan.ts");
  const got = parse('here you go:\n```json\n[{"name":"sql joins","breadth":"general","requires":["sql"],"evidence":"db.py:4 - joins"},{"name":"SQL Joins"},{"name":""},{"nope":1}]\n```');
  assert.deepEqual(got.map((f) => [f.name, f.breadth, f.requires]), [["sql joins", "general", ["sql"]]]);
  assert.deepEqual(parse("no json here"), []);
});

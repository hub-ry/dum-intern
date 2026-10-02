import { test } from "node:test";
import assert from "node:assert/strict";
import { fileName, fromNote, toNote } from "../src/notes.ts";
import type { Skill } from "../src/skills.ts";

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "recursion",
  lang: "",
  how: "typed",
  requires: [],
  why: "",
  at: "2026-10-02T04:03:15.135Z",
  ...over,
});

test("a note round-trips every way a skill gets unlocked", () => {
  for (const how of ["typed", "explained", "course", "added"] as const) {
    for (const lang of ["", "python"]) {
      const s = skill({ how, lang, requires: ["functions", "Side / ranking"], why: "They said `x`." });
      assert.deepEqual(fromNote(toNote(s), fileName(s.name)), s);
    }
  }
});

test("builds-on links point at the prerequisite's note in the same language", () => {
  const text = toNote(skill({ lang: "python", requires: ["functions"] }));
  assert.match(text, /builds on: \[\[functions \(python\)\|functions\]\]/);
  assert.match(text, /tags:\n  - dum\/typed/);
  assert.match(toNote(skill({ requires: ["retries"] })), /builds on: \[\[retries\]\]/);
});

test("file names drop what a file system or Obsidian refuses", () => {
  assert.equal(fileName("tcp/ip: basics"), "tcp - ip - basics.md");
  assert.equal(fileName("  .hidden  "), "hidden.md");
  assert.equal(fileName("///"), "skill.md");
});

test("a note with nothing in it is a skill somebody added by hand", () => {
  assert.deepEqual(fromNote("can do these\n\nsee [[arrays]]", "pointers.md"), {
    name: "pointers",
    lang: "",
    how: "added",
    requires: ["arrays"],
    why: "can do these\n\nsee [[arrays]]",
    at: "",
  });
});

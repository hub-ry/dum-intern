// The skill tree as text, drawn for the active zone's language: no repository to infer one from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeText } from "../src/tree.ts";
import * as skills from "../src/skills.ts";
import * as curriculum from "../src/curriculum.ts";

process.env.DUM_HOME = mkdtempSync(join(tmpdir(), "dum-tree-home-"));
process.env.DUM_CONTEXT = "off";

const python = curriculum.tracks().find((t) => t.lang === "python")!;

test("an empty tree in a zone with no language shows every track's summary", () => {
  const text = treeText({ skills: [] }, "");
  assert.match(text, /^you know: nothing on the tree yet/);
  for (const t of curriculum.tracks()) assert.ok(text.includes(t.name), t.name);
  assert.match(text, /:tree <language> shows a track's skills/);
  assert.match(text, /:projects <skill> suggests projects/);
  assert.doesNotMatch(text, /:practice|course/);
});

test("the zone's language picks its track, by any spelling", () => {
  const text = treeText({ skills: [] }, "py");
  assert.ok(text.includes(python.skills[0]!.name));
  assert.match(text, new RegExp(`next · :projects ${python.skills[0]!.name} in python`), "an open skill points at suggested projects");
  assert.doesNotMatch(text, /:practice/);
  assert.doesNotMatch(text, /:tree <language> shows a track's skills/, "one track drawn, not the summary");
  assert.equal(treeText({ skills: [] }, "python"), text);
});

test("what's on the tree is drawn with the zone's language, and a filter narrows or widens it", () => {
  const t = skills.unlock({ skills: [] }, { name: "printing", lang: "python", how: "typed", why: "test" });
  const here = treeText(t, "rust");
  assert.match(here, /^you know: 1 built, 0 recognized only/);
  assert.match(here, /rust/);
  assert.match(here, /python/);
  assert.doesNotMatch(treeText(t, "rust", "python"), /rust ·|\brust\b.*basics/);
  assert.match(treeText(t, "", "all"), new RegExp(curriculum.tracks().at(-1)!.name));
  assert.match(treeText(t, "", "cobol"), /^no curated track for "cobol"/);
});

// The tree decides what dum writes for you, so the failure that matters is it drifting upward
// on its own - a skill that was never shown means code you never wrote, in every repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { unlock, find, named, holds, spoken, levelIn, key, id, read, write, remove, reset, folder, describe, label, langOf, extFor, type Tree } from "../src/skills.ts";

const empty: Tree = { skills: [] };
const home = () => mkdtempSync(`${tmpdir()}/dum-skills-`);

test("printing in python and printing in c++ are two skills", () => {
  let t = unlock(empty, { name: "printing", lang: "python", how: "typed", why: "" });
  t = unlock(t, { name: "printing", lang: "cpp", how: "course", why: "" });
  assert.equal(t.skills.length, 2);
  assert.equal(find(t, "printing", "c++")?.how, "course");
  assert.equal(named(t, "Printing").length, 2);
  assert.notEqual(id("printing", "python"), id("printing", "c++"));
});

test("a language-scoped skill counts only in its language", () => {
  const t = unlock(empty, { name: "for loops", lang: "python", how: "typed", why: "" });
  assert.ok(holds(t, "for loops", "python"));
  assert.ok(!holds(t, "for loops", "c++"));
});

test("an idea with no language counts only where they've written something", () => {
  let t = unlock(empty, { name: "recursion", how: "typed", why: "" });
  assert.ok(!holds(t, "recursion", "rust"), "knowing recursion doesn't write rust");
  t = unlock(t, { name: "serde", lang: "rust", how: "explained", why: "" });
  assert.ok(!spoken(t, "rust"), "recognizing a library isn't writing rust");
  t = unlock(t, { name: "printing", lang: "rust", how: "typed", why: "" });
  assert.ok(spoken(t, "rust"));
  assert.ok(holds(t, "recursion", "rust"));
  assert.ok(holds(t, "recursion", ""), "with no language at all, any unlock counts");
});

test("a level only goes up, and holds asks for one", () => {
  let t = unlock(empty, { name: "hash maps", lang: "python", how: "explained", why: "said what it's for" });
  assert.equal(find(t, "hash maps", "python")?.level, "recognize");
  assert.ok(holds(t, "hash maps", "python", "recognize"));
  assert.ok(!holds(t, "hash maps", "python"), "recognizing isn't building");
  t = unlock(t, { name: "hash maps", lang: "python", how: "reasoned", why: "picked it for lookup by id" });
  t = unlock(t, { name: "hash maps", lang: "python", how: "explained", why: "again" });
  assert.equal(find(t, "hash maps", "python")?.level, "apply");
  assert.equal(find(t, "hash maps", "python")?.how, "reasoned", "a lower showing doesn't overwrite how it got higher");
  assert.equal(levelIn(t, "hash maps", "python"), "apply");
  assert.equal(levelIn(t, "trees", "python"), null);
});

test("respellings are one node, a symbol is not", () => {
  const t = unlock(empty, { name: "Linked Lists", lang: "c", how: "typed", why: "" });
  const t2 = unlock(t, { name: "linked list", lang: "c", how: "course", why: "again" });
  assert.equal(t2.skills.length, 1);
  assert.equal(t2.skills[0]!.name, "Linked Lists", "the first spelling wins");
  assert.notEqual(key("c"), key("c++"));
});

test("requires accumulate, never include the skill itself, and stop at three", () => {
  let t = unlock(empty, { name: "recursion", lang: "python", how: "typed", requires: ["functions", "Recursion"], why: "" });
  t = unlock(t, { name: "recursion", lang: "python", how: "typed", requires: ["functions", "conditionals", "return values", "lists"], why: "" });
  assert.deepEqual(t.skills[0]!.requires, ["functions", "conditionals", "return values"]);
  assert.equal(unlock(empty, { name: "  ", how: "added", why: "" }).skills.length, 0);
});

test("the tree round-trips through disk, one note per skill, the language in the file name", () => {
  const dir = home();
  let t = unlock(empty, { name: "printing", lang: "python", how: "typed", why: "typed it" });
  t = unlock(t, { name: "printing", lang: "c", how: "course", why: "passed" });
  t = unlock(t, { name: "idempotency", how: "explained", requires: ["retries"], why: "said so" });
  write(t, dir);
  assert.deepEqual(readdirSync(folder(dir)).sort(), ["idempotency.md", "printing (c).md", "printing (python).md"]);
  const back = read(dir);
  assert.equal(back.skills.length, 3);
  assert.deepEqual(find(back, "idempotency")?.requires, ["retries"]);
  assert.equal(find(back, "printing", "c")?.how, "course");
});

test("an older tree still loads: solid notes count, shaky ones were only taught and stay locked", () => {
  const dir = home();
  mkdirSync(folder(dir), { recursive: true });
  writeFileSync(`${folder(dir)}/leases.md`, "---\nname: leases\nstate: solid\nbreadth: general\n---\n\nexplained it\n");
  writeFileSync(`${folder(dir)}/for loops.md`, "---\nname: for loops\nstate: solid\nlang: c++\nshown-in:\n  - c++\n---\n");
  writeFileSync(`${folder(dir)}/heartbeats.md`, "---\nname: heartbeats\nstate: shaky\n---\n");
  writeFileSync(`${folder(dir)}/structs.md`, "I can write these without AI.\n");
  writeFileSync(`${folder(dir)}/broken.md`, "---\nname: [unclosed\n---\n");
  const t = read(dir);
  assert.equal(find(t, "leases")?.how, "explained");
  assert.equal(find(t, "leases")?.level, "recognize", "explaining was recognition all along");
  assert.equal(find(t, "for loops", "c++")?.level, "build");
  assert.equal(find(t, "for loops", "c++")?.how, "typed");
  assert.equal(find(t, "structs")?.how, "added", "a note written by hand is an add");
  assert.equal(find(t, "heartbeats"), undefined);
  assert.equal(t.skills.length, 3);
});

test("writing into a hand-named note updates it rather than growing a second", () => {
  const dir = home();
  mkdirSync(folder(dir), { recursive: true });
  writeFileSync(`${folder(dir)}/My Recursion Note.md`, "---\nname: recursion\nlang: python\nhow: added\n---\n");
  write(unlock(read(dir), { name: "recursion", lang: "python", how: "typed", why: "typed it" }), dir);
  assert.deepEqual(readdirSync(folder(dir)), ["My Recursion Note.md"]);
  assert.equal(find(read(dir), "recursion", "python")?.how, "typed");
});

test("remove takes one language's note off, and reset moves the tree aside", () => {
  const dir = home();
  let t = unlock(empty, { name: "printing", lang: "python", how: "typed", why: "" });
  t = unlock(t, { name: "printing", lang: "go", how: "typed", why: "" });
  write(t, dir);
  assert.ok(remove("printing", "go", dir));
  assert.ok(!remove("printing", "go", dir));
  assert.deepEqual(read(dir).skills.map(label), ["printing (python)"]);
  const aside = reset(dir);
  assert.ok(aside && existsSync(aside));
  assert.equal(read(dir).skills.length, 0);
});

test("the intern sees what's unlocked by language, and that everything else is locked", () => {
  assert.match(describe(empty), /empty/);
  const t = unlock(unlock(empty, { name: "printing", lang: "rust", how: "typed", why: "" }), { name: "recursion", how: "explained", why: "" });
  const text = describe(t);
  assert.match(text, /Anything not here is locked/);
  assert.match(text, /rust:\n  - printing \(build\)/);
  assert.match(text, /any language:\n  - recursion \(recognize\)/);
});

test("file extensions map to languages and back", () => {
  assert.equal(langOf("src/a.cpp"), "c++");
  assert.equal(langOf("README.md"), "");
  assert.equal(extFor("python"), "py");
  assert.equal(extFor("c++"), "cc");
  assert.equal(extFor("brainfuck"), "txt");
});

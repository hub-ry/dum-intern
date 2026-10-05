// What a skill on the tree rests on: their quoted words for recognition, and hashed files plus
// their unaided self-report plus a passing review for a build. Nothing else unlocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Evidence, quoted } from "../src/evidence.ts";
import * as skills from "../src/skills.ts";
import type { Store } from "../src/store.ts";
import type { Artifact } from "../src/workspace.ts";

function setup(built: string[] = [], lang = "python") {
  const root = mkdtempSync(`${tmpdir()}/dum-evidence-`);
  process.env.DUM_HOME = `${root}/home`;
  let t: skills.Tree = { skills: [] };
  for (const name of built) t = skills.unlock(t, { name, lang, how: "added", level: "build", why: "" });
  if (t.skills.length) skills.write(t);
  const notes: string[] = [];
  const store = { note: (text: string) => notes.push(text), setUnlocked: () => {} } as unknown as Store;
  return { root, notes, ev: new Evidence(root, store), done: () => rmSync(root, { recursive: true, force: true }) };
}

const level = (name: string, lang = "python") => skills.find(skills.read(), name, lang)?.level ?? null;
const artifact = (path: string, text: string): Artifact => ({ path, text, sha: createHash("sha256").update(text).digest("hex"), from: 1 });
const BASICS = ["printing", "variables", "functions", "conditionals", "return values"];

test("a quote counts only when they said it just now, and it's long enough to explain anything", () => {
  assert.ok(quoted("a function that calls itself", "So, recursion is: a function that calls itself, on smaller input!"));
  assert.ok(!quoted("a function that calls itself", "it's a loop, basically"));
  assert.ok(!quoted("it loops", "it loops"), "too short to be an explanation");
  assert.ok(!quoted("calls itself on", "it recalls itself only"), "matched on whole words");
});

test("an explanation records recognition only, keeps their words local, and never builds", () => {
  const { ev, root, done } = setup(BASICS);
  try {
    const said = "recursion is when a function calls itself on a smaller piece until it hits a base case";
    const wrong = ev.explain({ skill: "recursion", lang: "python", quote: "a function calls itself on a smaller piece", feedback: "right" }, "something else entirely");
    assert.equal(wrong.ok, false);
    assert.equal(level("recursion"), null, "a quote they didn't say unlocks nothing");
    assert.equal(ev.explain({ skill: "recursion", lang: "python", quote: "a function calls itself on a smaller piece", feedback: "close", passed: false }, said).ok, false);
    assert.equal(level("recursion"), null, "a failed verdict unlocks nothing");
    const r = ev.explain({ skill: "Recursion", lang: "py", quote: "a function calls itself on a smaller piece", feedback: "base case and all" }, said);
    assert.ok(r.ok);
    assert.equal(level("recursion"), "recognize");
    const note = skills.find(skills.read(), "recursion", "python")!;
    assert.equal(note.how, "explained");
    assert.doesNotMatch(note.why, /smaller piece/, "their words stay out of the note that may sync");
    const ledger = JSON.parse(readFileSync(`${root}/.dum/evidence.json`, "utf8"));
    assert.equal(ledger.records.at(-1).quote, "a function calls itself on a smaller piece");
    assert.match(ev.describe(), /✓ recognize recursion \(python\)/);
  } finally {
    done();
  }
});

test("recognition needs its prerequisites recognized", () => {
  const { ev, done } = setup(["printing"]);
  try {
    const r = ev.explain({ skill: "recursion", lang: "python", quote: "a function calling itself again", feedback: "yes" }, "a function calling itself again");
    assert.equal(r.ok, false);
    assert.match(r.why, /builds on return values, conditionals/);
    assert.equal(level("recursion"), null);
  } finally {
    done();
  }
});

test("reasoning about using a skill is apply only on top of a build", () => {
  const { ev, done } = setup([...BASICS, "lists"]);
  try {
    const said = "I'd use a dictionary here because lookups by name happen on every request";
    const quote = "lookups by name happen on every request";
    const first = ev.explain({ skill: "dictionaries", lang: "python", quote, feedback: "good call", apply: true }, said);
    assert.ok(first.ok);
    assert.match(first.why, /recognition only/);
    assert.equal(level("dictionaries"), "recognize");
    ev.submit({ skill: "dictionaries", lang: "python", paths: ["d.py"], unaided: true, passed: true, feedback: "counts words with a dict" }, [artifact("d.py", "c = {}\nfor w in words: c[w] = c.get(w, 0) + 1\n")]);
    assert.equal(level("dictionaries"), "build");
    assert.ok(ev.explain({ skill: "dictionaries", lang: "python", quote, feedback: "good call", apply: true }, said).ok);
    assert.equal(level("dictionaries"), "apply");
  } finally {
    done();
  }
});

test("a submission builds only with an unaided self-report, a passing review, matching hashed files and built prerequisites", () => {
  const { ev, done } = setup(BASICS);
  try {
    const file = artifact("src/walk.py", "def walk(n):\n    return 0 if n == 0 else 1 + walk(n - 1)\n");
    const base = { skill: "recursion", lang: "python", paths: ["src/walk.py"], unaided: true, passed: true, feedback: "base case and the shrinking step are both there" };
    const refused = [
      ev.submit({ ...base, unaided: false }, [file]),
      ev.submit({ ...base, passed: false }, [file]),
      ev.submit({ ...base, feedback: "ok" }, [file]),
      ev.submit(base, []),
      ev.submit({ ...base, paths: ["other.py"] }, [file]),
      ev.submit(base, [{ ...file, sha: "nope" }]),
      ev.submit(base, [{ ...file, text: "   " }]),
      ev.submit({ ...base, paths: ["walk.js"] }, [artifact("walk.js", "function walk(n) { return n ? 1 + walk(n - 1) : 0 }\n")]),
    ];
    for (const r of refused) assert.equal(r.ok, false, r.why);
    assert.match(refused[0]!.why, /without AI help/);
    assert.match(refused[7]!.why, /none of these files is python/);
    assert.equal(level("recursion"), null, "nothing short of all of it builds");

    const r = ev.submit({ ...base, paths: ["/home/someone/private/walk.py"] }, [{ ...file, path: "/home/someone/private/walk.py" }]);
    assert.ok(r.ok, r.why);
    assert.equal(level("recursion"), "build");
    const note = skills.find(skills.read(), "recursion", "python")!;
    assert.match(note.why, new RegExp(`walk\\.py sha256:${file.sha}`));
    assert.match(note.why, /self-reported unaided/);
    assert.doesNotMatch(note.why, /home\/someone/, "no path outside the repo in the note");
  } finally {
    done();
  }
});

test("a submission for a skill whose prerequisites aren't built changes nothing", () => {
  const { ev, done } = setup(["printing"]);
  try {
    const r = ev.submit(
      { skill: "recursion", lang: "python", paths: ["r.py"], unaided: true, passed: true, feedback: "works on the sample input" },
      [artifact("r.py", "def f(n):\n    return 1 if n < 2 else n * f(n - 1)\n")],
    );
    assert.equal(r.ok, false);
    assert.match(r.why, /haven't built yet/);
    assert.equal(level("recursion"), null);
  } finally {
    done();
  }
});

test("a guided course records recognition, never a build", () => {
  const { ev, done } = setup(["printing", "variables"]);
  try {
    assert.ok(ev.course({ name: "functions", lang: "python", how: "course", why: "filled the gap" }).ok);
    assert.equal(level("functions"), "recognize");
    assert.equal(skills.find(skills.read(), "functions", "python")!.how, "explained");
  } finally {
    done();
  }
});

test("not yet takes back what this session added, and holds it locked for the rest of it", () => {
  const { ev, notes, done } = setup(BASICS);
  try {
    const said = "a function that calls itself with a smaller input";
    ev.explain({ skill: "recursion", lang: "python", quote: said, feedback: "yes" }, said);
    assert.match(notes.join("\n"), /\+ skill: recursion \(python\) \(recognize\) - not yet takes it back/);
    assert.ok(ev.undo());
    assert.equal(level("recursion"), null);
    assert.ok(ev.held.has(skills.id("recursion", "python")));
    assert.equal(ev.undo("nothing like this"), false);
    assert.ok(ev.undo("functions"));
    assert.equal(level("functions"), null, "a skill from before this session comes off the tree, as not yet always did");
    // An older note doesn't outlive its prerequisite: recording on it rechecks what it builds on.
    const r = ev.explain({ skill: "return values", lang: "python", quote: "what the function hands back", feedback: "yes" }, "what the function hands back");
    assert.equal(r.ok, false);
    assert.match(r.why, /builds on functions/);
    assert.match(ev.describe(), /undo recursion/);
  } finally {
    done();
  }
});

test("explaining a skill after not yet keeps its older build held; only an unaided rebuild lifts it", () => {
  const { ev, done } = setup([...BASICS, "recursion"]);
  const k = skills.id("recursion", "python");
  try {
    const said = "I'd recurse here because the folders nest to any depth and each level looks the same";
    const quote = "the folders nest to any depth";
    assert.ok(ev.explain({ skill: "recursion", lang: "python", quote, feedback: "right call", apply: true }, said).ok);
    assert.equal(level("recursion"), "apply");
    assert.ok(ev.undo("recursion"));
    assert.equal(level("recursion"), "build", "put back as it was before this session");
    assert.ok(ev.held.has(k));

    for (const apply of [false, true]) {
      const r = ev.explain({ skill: "recursion", lang: "python", quote, feedback: "right call", apply }, said);
      assert.equal(r.ok, false, r.why);
      assert.match(r.why, /not yet/);
      assert.equal(level("recursion"), "build", "an explanation never writes apply over a held build");
      assert.ok(ev.held.has(k), "an explanation doesn't lift the hold on an older build");
    }

    const file = artifact("walk.py", "def depth(d):\n    return 1 + max((depth(c) for c in d.values()), default=0)\n");
    const built = ev.submit({ skill: "recursion", lang: "python", paths: ["walk.py"], unaided: true, passed: true, feedback: "recurses into each folder with a base case" }, [file]);
    assert.ok(built.ok, built.why);
    assert.match(built.why, /recorded build/);
    assert.ok(!ev.held.has(k), "an unaided rebuild lifts the hold even though the note already said build");
    assert.match(skills.find(skills.read(), "recursion", "python")!.why, /self-reported unaided/);
    assert.ok(ev.explain({ skill: "recursion", lang: "python", quote, feedback: "right call", apply: true }, said).ok);
    assert.equal(level("recursion"), "apply");
  } finally {
    done();
  }
});

test("a ledger dum can't read puts nothing on the tree and is left exactly as it was", () => {
  const { ev, root, notes, done } = setup(BASICS);
  try {
    // Their words from an earlier session, then a stray edit that breaks the JSON.
    const broken = '{"version": 1, "records": [{"skill": "recursion", "quote": "a function calls itself"\n';
    mkdirSync(`${root}/.dum`);
    writeFileSync(`${root}/.dum/evidence.json`, broken);
    const tree = skills.read();
    const said = "recursion is when a function calls itself on a smaller piece until it hits a base case";
    const results = [
      ev.submit({ skill: "recursion", lang: "python", paths: ["r.py"], unaided: true, passed: true, feedback: "works on the sample input" }, [artifact("r.py", "def f(n):\n    return 1 if n < 2 else n * f(n - 1)\n")]),
      ev.explain({ skill: "recursion", lang: "python", quote: "a function calls itself on a smaller piece", feedback: "base case and all" }, said),
      ev.course({ name: "recursion", lang: "python", how: "explained", why: "finished it" }),
    ];
    for (const r of results) {
      assert.equal(r.ok, false, r.why);
      assert.match(r.why, /\.dum\/evidence\.json/, "refused for the ledger, not for anything they showed");
    }
    assert.deepEqual(skills.read(), tree, "nothing went on the tree");
    assert.equal(readFileSync(`${root}/.dum/evidence.json`, "utf8"), broken, "the ledger wasn't replaced");
    assert.ok(notes.length, "the failure is shown");
    for (const shown of [...notes, ...results.map((r) => r.why), ev.describe()]) {
      assert.doesNotMatch(shown, /calls itself/, "what's shown names the file, never what it holds");
    }
  } finally {
    done();
  }
});

// What a skill on the tree rests on: their quoted words for recognition, and complete hashed
// files plus their unaided self-report plus a passing review for a build. One ledger for every
// zone, holds that outlive a switch or a restart, and no credit claimed when a write fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Evidence, quoted, type Origin } from "../src/evidence.ts";
import * as skills from "../src/skills.ts";
import type { SourceSnapshot } from "../src/share-types.ts";
import type { Store } from "../src/store.ts";

process.env.DUM_CONTEXT = "off";
const SHARE = "0b6f2a1e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ZONE_A = "11111111-1111-4111-8111-111111111111";
const ZONE_B = "22222222-2222-4222-8222-222222222222";
const BASICS = ["printing", "variables", "functions", "conditionals", "return values"];

function zone(zoneId: string, zoneName: string, notes: string[]): Origin {
  const store = { note: (text: string) => notes.push(text), setUnlocked: () => {} } as unknown as Store;
  return { zoneId, zoneName, store };
}

function setup(built: string[] = [], lang = "python") {
  const home = mkdtempSync(`${tmpdir()}/dum-evidence-`);
  process.env.DUM_HOME = home;
  let t: skills.Tree = { skills: [] };
  for (const name of built) t = skills.unlock(t, { name, lang, how: "added", level: "build", why: "" });
  if (t.skills.length) skills.write(t);
  const notes: string[] = [];
  return {
    home,
    notes,
    a: zone(ZONE_A, "Learn Python", notes),
    b: zone(ZONE_B, "Web scraper", notes),
    ev: new Evidence(home),
    ledger: () => JSON.parse(readFileSync(`${home}/evidence.json`, "utf8")),
    done: () => {
      chmodSync(home, 0o700);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const level = (name: string, lang = "python") => skills.find(skills.read(), name, lang)?.level ?? null;
const snap = (rel: string, text: string, sourcePath = `/home/someone/private/${rel}`): SourceSnapshot => ({
  path: `${SHARE}/${rel}`,
  sourcePath,
  text,
  sha: createHash("sha256").update(text).digest("hex"),
  complete: true,
});
const WALK = snap("walk.py", "def walk(n):\n    return 0 if n == 0 else 1 + walk(n - 1)\n");
const build = (skill: string, file: SourceSnapshot, feedback = "base case and the shrinking step are both there") =>
  ({ skill, lang: "python", paths: [file.path], unaided: true, passed: true, feedback });

test("a quote counts only when they said it just now, and it's long enough to explain anything", () => {
  assert.ok(quoted("a function that calls itself", "So, recursion is: a function that calls itself, on smaller input!"));
  assert.ok(!quoted("a function that calls itself", "it's a loop, basically"));
  assert.ok(!quoted("it loops", "it loops"), "too short to be an explanation");
  assert.ok(!quoted("calls itself on", "it recalls itself only"), "matched on whole words");
});

test("an explanation records recognition in the global ledger with its zone, keeps their words private, and never builds", () => {
  const { ev, a, ledger, done } = setup(BASICS);
  try {
    const said = "recursion is when a function calls itself on a smaller piece until it hits a base case";
    const quote = "a function calls itself on a smaller piece";
    // Words from a suggestion, the screen or an ambient note aren't what they said this turn.
    assert.equal(ev.explain(a, { skill: "recursion", lang: "python", quote, feedback: "right" }, "something else entirely").ok, false);
    assert.equal(level("recursion"), null, "a quote they didn't say unlocks nothing");
    assert.equal(ev.explain(a, { skill: "recursion", lang: "python", quote, feedback: "close", passed: false }, said).ok, false);
    assert.equal(level("recursion"), null, "a failed verdict unlocks nothing");
    const r = ev.explain(a, { skill: "Recursion", lang: "py", quote, feedback: "base case and all" }, said);
    assert.ok(r.ok, r.why);
    assert.equal(level("recursion"), "recognize");
    assert.equal(skills.find(skills.read(), "recursion", "python")!.how, "explained");
    const last = ledger().records.at(-1);
    assert.equal(last.quote, quote);
    assert.equal(last.zoneId, ZONE_A);
    assert.equal(last.zoneName, "Learn Python");
    assert.match(ev.describe(), /✓ recognize recursion \(python\) \[Learn Python\]/);
    assert.match(ev.describe(ZONE_A), /✓ recognize recursion \(python\):/);
    assert.match(ev.describe(ZONE_B), /nothing recorded in this zone yet/);
  } finally {
    done();
  }
});

test("recognition needs its prerequisites recognized", () => {
  const { ev, a, done } = setup(["printing"]);
  try {
    const r = ev.explain(a, { skill: "recursion", lang: "python", quote: "a function calling itself again", feedback: "yes" }, "a function calling itself again");
    assert.equal(r.ok, false);
    assert.match(r.why, /builds on return values, conditionals/);
    assert.equal(level("recursion"), null);
  } finally {
    done();
  }
});

test("reasoning about using a skill is apply only on top of a build", () => {
  const { ev, a, done } = setup([...BASICS, "lists"]);
  try {
    const said = "I'd use a dictionary here because lookups by name happen on every request";
    const quote = "lookups by name happen on every request";
    const first = ev.explain(a, { skill: "dictionaries", lang: "python", quote, feedback: "good call", apply: true }, said);
    assert.ok(first.ok);
    assert.match(first.why, /recognition only/);
    assert.equal(level("dictionaries"), "recognize");
    const file = snap("d.py", "c = {}\nfor w in words: c[w] = c.get(w, 0) + 1\n");
    assert.ok(ev.submit(a, build("dictionaries", file, "counts words with a dict"), [file]).ok);
    assert.equal(level("dictionaries"), "build");
    assert.ok(ev.explain(a, { skill: "dictionaries", lang: "python", quote, feedback: "good call", apply: true }, said).ok);
    assert.equal(level("dictionaries"), "apply");
  } finally {
    done();
  }
});

test("a submission builds only with an unaided self-report, a passing review, complete matching files and built prerequisites", () => {
  const { ev, a, done } = setup(BASICS);
  try {
    const base = build("recursion", WALK);
    const js = snap("walk.js", "function walk(n) { return n ? 1 + walk(n - 1) : 0 }\n");
    const refused = [
      ev.submit(a, { ...base, unaided: false }, [WALK]),
      ev.submit(a, { ...base, passed: false }, [WALK]),
      ev.submit(a, { ...base, feedback: "ok" }, [WALK]),
      ev.submit(a, base, []),
      ev.submit(a, { ...base, paths: [`${SHARE}/other.py`] }, [WALK]),
      ev.submit(a, base, [{ ...WALK, sha: "nope" }]),
      ev.submit(a, base, [{ ...WALK, text: `${WALK.text}# edited after hashing\n` }]),
      ev.submit(a, base, [{ ...WALK, complete: false as true }]),
      ev.submit(a, base, [{ ...WALK, text: "   ", sha: createHash("sha256").update("   ").digest("hex") }]),
      ev.submit(a, { ...base, paths: [js.path] }, [js]),
    ];
    for (const r of refused) assert.equal(r.ok, false, r.why);
    assert.match(refused[0]!.why, /without AI help/);
    assert.match(refused[6]!.why, /content hash/);
    assert.match(refused[7]!.why, /excerpt/);
    assert.match(refused[9]!.why, /none of these files is python/);
    assert.equal(level("recursion"), null, "nothing short of all of it builds");

    const r = ev.submit(a, base, [WALK]);
    assert.ok(r.ok, r.why);
    assert.equal(level("recursion"), "build");
    const note = skills.find(skills.read(), "recursion", "python")!;
    assert.match(note.why, new RegExp(`walk\\.py sha256:${WALK.sha}`));
    assert.match(note.why, /self-reported unaided/);
  } finally {
    done();
  }
});

test("a submission for a skill whose prerequisites aren't built changes nothing", () => {
  const { ev, a, done } = setup(["printing"]);
  try {
    const file = snap("r.py", "def f(n):\n    return 1 if n < 2 else n * f(n - 1)\n");
    const r = ev.submit(a, build("recursion", file, "works on the sample input"), [file]);
    assert.equal(r.ok, false);
    assert.match(r.why, /haven't built yet/);
    assert.equal(level("recursion"), null);
  } finally {
    done();
  }
});

test("a skill earned in one zone counts in another, but not in another language", () => {
  const { ev, a, b, done } = setup(BASICS);
  try {
    assert.ok(ev.submit(a, build("recursion", WALK), [WALK]).ok);
    const said = "a function calls itself on a smaller piece until the base case";
    const again = ev.explain(b, { skill: "recursion", lang: "python", quote: "a function calls itself on a smaller piece", feedback: "yes" }, said);
    assert.ok(again.ok);
    assert.match(again.why, /already build/, "zone B sees zone A's build");
    const rust = ev.explain(b, { skill: "recursion", lang: "rust", quote: "a function calls itself on a smaller piece", feedback: "yes" }, said);
    assert.equal(rust.ok, false, "knowing it in python doesn't recognize it in rust");
    assert.equal(level("recursion", "rust"), null);
  } finally {
    done();
  }
});

test("not yet holds across a zone switch and a restart; only an unaided rebuild lifts it", () => {
  const { home, ev, a, b, done } = setup([...BASICS, "recursion"]);
  const k = skills.id("recursion", "python");
  try {
    const said = "I'd recurse here because the folders nest to any depth and each level looks the same";
    const quote = "the folders nest to any depth";
    assert.ok(ev.explain(a, { skill: "recursion", lang: "python", quote, feedback: "right call", apply: true }, said).ok);
    assert.equal(level("recursion"), "apply");
    assert.ok(ev.undo(a, "recursion"));
    assert.equal(level("recursion"), "build", "put back as it was before");
    assert.ok(ev.held.has(k));
    assert.equal(ev.undo(a, "nothing like this"), false);

    const restarted = new Evidence(home);
    assert.ok(restarted.held.has(k), "the hold survives a restart");
    for (const apply of [false, true]) {
      const r = restarted.explain(b, { skill: "recursion", lang: "python", quote, feedback: "right call", apply }, said);
      assert.equal(r.ok, false, r.why);
      assert.match(r.why, /not yet/);
      assert.equal(level("recursion"), "build", "an explanation never writes over a held build");
      assert.ok(restarted.held.has(k), "neither a switch nor an explanation lifts the hold");
    }

    const file = snap("depth.py", "def depth(d):\n    return 1 + max((depth(c) for c in d.values()), default=0)\n");
    const built = restarted.submit(b, build("recursion", file, "recurses into each folder with a base case"), [file]);
    assert.ok(built.ok, built.why);
    assert.ok(!restarted.held.has(k), "an unaided rebuild lifts the hold even though the note already said build");
    assert.ok(!new Evidence(home).held.has(k), "and the lift is saved");
    assert.ok(restarted.explain(b, { skill: "recursion", lang: "python", quote, feedback: "right call", apply: true }, said).ok);
    assert.equal(level("recursion"), "apply");
  } finally {
    done();
  }
});

test("a skill this run added comes off the tree with not yet, and its dependents are rechecked", () => {
  const { ev, a, notes, done } = setup(BASICS);
  try {
    const said = "a function that calls itself with a smaller input";
    ev.explain(a, { skill: "recursion", lang: "python", quote: said, feedback: "yes" }, said);
    assert.match(notes.join("\n"), /\+ skill: recursion \(python\) \(recognize\) - not yet takes it back/);
    assert.ok(ev.undo(a));
    assert.equal(level("recursion"), null);
    assert.ok(ev.undo(a, "functions"));
    assert.equal(level("functions"), null);
    const r = ev.explain(a, { skill: "return values", lang: "python", quote: "what the function hands back", feedback: "yes" }, "what the function hands back");
    assert.equal(r.ok, false);
    assert.match(r.why, /builds on functions/);
    assert.match(ev.describe(), /undo recursion/);
  } finally {
    done();
  }
});

test("a self-report needs built prerequisites, says it's their word, and lifts a hold", () => {
  const { ev, a, ledger, done } = setup(["printing"]);
  try {
    assert.equal(ev.selfReport(a, { name: "recursion", lang: "python" }, true).ok, false);
    assert.equal(level("recursion"), null);
    const r = ev.selfReport(a, { name: "variables", lang: "python" }, true);
    assert.ok(r.ok, r.why);
    assert.match(r.why, /self-report/);
    const note = skills.find(skills.read(), "variables", "python")!;
    assert.equal(note.level, "build");
    assert.match(note.why, /not reviewed/);
    assert.ok(ev.undo(a, "variables"));
    assert.ok(ev.held.has(skills.id("variables", "python")));
    assert.ok(ev.selfReport(a, { name: "variables", lang: "python" }, true).ok);
    assert.ok(!ev.held.has(skills.id("variables", "python")));
    assert.deepEqual(ledger().held, []);
  } finally {
    done();
  }
});

test("a ledger dum can't read puts nothing on the tree and is left exactly as it was", () => {
  const { home, ev, a, notes, done } = setup(BASICS);
  try {
    const broken = '{"version": 2, "held": [], "records": [{"skill": "recursion", "quote": "a function calls itself"\n';
    writeFileSync(`${home}/evidence.json`, broken);
    const tree = skills.read();
    const said = "recursion is when a function calls itself on a smaller piece until it hits a base case";
    const results = [
      ev.submit(a, build("recursion", WALK), [WALK]),
      ev.explain(a, { skill: "recursion", lang: "python", quote: "a function calls itself on a smaller piece", feedback: "base case and all" }, said),
      ev.selfReport(a, { name: "recursion", lang: "python" }, true),
    ];
    for (const r of results) {
      assert.equal(r.ok, false, r.why);
      assert.match(r.why, /evidence\.json/, "refused for the ledger, not for anything they showed");
    }
    assert.equal(ev.undo(a, "functions"), false);
    assert.deepEqual(skills.read(), tree, "nothing went on or came off the tree");
    assert.equal(readFileSync(`${home}/evidence.json`, "utf8"), broken, "the ledger wasn't replaced");
    assert.ok(notes.length, "the failure is shown");
    for (const shown of [...notes, ...results.map((r) => r.why), ev.describe()]) {
      assert.doesNotMatch(shown, /calls itself/, "what's shown names the file, never what it holds");
    }
  } finally {
    done();
  }
});

test("a ledger that can't be written claims no credit", () => {
  const { home, ev, a, done } = setup(BASICS);
  try {
    chmodSync(home, 0o500);
    const r = ev.submit(a, build("recursion", WALK), [WALK]);
    assert.equal(r.ok, false);
    assert.match(r.why, /couldn't save the evidence ledger/);
    assert.equal(level("recursion"), null);
  } finally {
    done();
  }
});

test("a note that can't be saved keeps the review but claims no credit", () => {
  const { home, ev, a, ledger, done } = setup(BASICS);
  try {
    chmodSync(skills.folder(home), 0o500);
    const r = ev.submit(a, build("recursion", WALK), [WALK]);
    chmodSync(skills.folder(home), 0o700);
    assert.equal(r.ok, false);
    assert.match(r.why, /no credit yet/);
    assert.equal(level("recursion"), null);
    const records = ledger().records;
    assert.equal(records.at(-2).why, "recorded build: reviewed files plus their unaided self-report", "the review is kept");
    assert.equal(records.at(-1).ok, false);
  } finally {
    done();
  }
});

test("no private proof reaches the notes that sync", () => {
  const { home, ev, a, ledger, done } = setup(BASICS);
  try {
    const said = "recursion is when a function calls itself on a smaller piece until it hits a base case";
    assert.ok(ev.explain(a, { skill: "recursion", lang: "python", quote: "a function calls itself on a smaller piece", feedback: "yes" }, said).ok);
    assert.ok(ev.submit(a, build("recursion", WALK), [WALK]).ok);
    assert.equal(ledger().records.at(-1).files[0].sourcePath, WALK.sourcePath, "the ledger keeps where it came from, locally");
    const text = readdirSync(skills.folder(home)).map((n) => readFileSync(`${skills.folder(home)}/${n}`, "utf8")).join("\n");
    for (const secret of ["smaller piece", "/home/someone", SHARE, ZONE_A, "Learn Python"]) {
      assert.ok(!text.includes(secret), `${secret} stays out of the notes`);
    }
  } finally {
    done();
  }
});

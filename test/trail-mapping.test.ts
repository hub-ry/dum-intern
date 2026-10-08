// Topic mapping onto the existing catalog: exact refs map, everything else stays an unmapped gap,
// and nothing here writes the tree, prereqs.json or anything else under DUM_HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidates, mapHints, exactHints, candidateLines } from "../src/trail-mapping.ts";
import * as curriculum from "../src/curriculum.ts";
import * as skills from "../src/skills.ts";
import { TRAIL_LIMITS, TopicHintSchema, TopicHintsSchema } from "../src/trail-types.ts";
import type { SkillRef, ZoneContext } from "../src/zone-types.ts";

const HOME = mkdtempSync(`${tmpdir()}/dum-trail-mapping-`);
process.env.DUM_HOME = HOME;
process.env.DUM_CONTEXT = "off";

// An off-track C++ note with mapped prerequisites, a language-free git note and a python note.
let seed: skills.Tree = { skills: [] };
seed = skills.unlock(seed, { name: "linear search", lang: "c++", how: "typed", why: "wrote one", requires: ["vectors", "for loops"] });
seed = skills.unlock(seed, { name: "git", lang: "", how: "added", why: "commits daily" });
seed = skills.unlock(seed, { name: "list comprehensions", lang: "python", how: "typed", why: "wrote one" });
skills.write(seed, HOME);
curriculum.map("linear search", "c++", ["vectors", "for loops"]);
const tree = skills.read(HOME);

const zone = (language: string, focusSkills: SkillRef[] = []): ZoneContext => ({
  id: "zone-1",
  revision: 1,
  breadcrumb: [{ id: "zone-1", name: "Interview prep" }],
  goal: "Pass a C++ interview",
  ancestorGoals: [],
  language,
  focusSkills,
  notes: [],
});
const cpp = zone("c++", [{ name: "Binary Search", lang: "cpp" }]);
const offered = candidates(cpp, tree, "");
const ids = (refs: readonly SkillRef[]) => refs.map((r) => skills.id(r.name, r.lang));
const hint = (topic: string, skill: unknown, confidence = 0.95, reason = "named on screen") => ({ topic, skill, confidence, reason });

function hashHome(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      h.update(p);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(HOME);
  return h.digest("hex");
}

test("candidates put focus skills, literal mentions and their prerequisites first, within the cap", () => {
  const got = candidates(cpp, tree, "Docker logs next to a list comprehension and a Sliding Window problem");
  assert.ok(got.length <= 128);
  assert.deepEqual(got[0], { name: "binary search", lang: "c++" });
  const order = ids(got);
  assert.deepEqual(order.slice(1, 4), [":docker", "python:list comprehension", "c++:sliding window"]);
  // Prerequisites of the focus skill and the mentions come before the rest of the catalog.
  assert.ok(order.indexOf("c++:array and string") < order.indexOf("c++:printing"));
  assert.ok(order.indexOf("c++:two pointer") < order.indexOf("c++:printing"));
  // Curated rungs in the zone language, language-free curated skills and tree notes are all offered.
  for (const want of ["c++:array and string", "c++:two pointer", "c++:vector", "c++:move semantic", ":http", ":git", "c++:linear search"]) assert.ok(order.includes(want), want);
  // A python note on the tree is offered only because the text mentions it.
  assert.ok(!ids(offered).includes("python:list comprehension"));
  assert.equal(new Set(order).size, order.length);
  for (const r of got) assert.equal(r.lang, skills.langName(r.lang));
});

test("a language-free zone offers language-free skills, and prerequisites resolve where the gate asks", () => {
  const got = ids(candidates(zone("", [{ name: "REST APIs", lang: "python" }]), { skills: [] }, ""));
  assert.equal(got[0], ":rest apis");
  assert.ok(got.includes(":http") && got.includes(":json"));
  assert.ok(!got.some((k) => k.startsWith("c++:")));
});

test("candidates never exceed 128, keeping focus skills and their prerequisites", () => {
  let big: skills.Tree = { skills: [] };
  for (let i = 0; i < 200; i++) big = skills.unlock(big, { name: `widget ${i}`, lang: "c++", how: "added", why: "" });
  const got = candidates(cpp, big, "");
  assert.equal(got.length, 128);
  assert.deepEqual(got.slice(0, 2), [{ name: "binary search", lang: "c++" }, { name: "arrays and strings", lang: "c++" }]);
});

test("C++ vectors, then linear search, then binary search map to exact catalog refs in order", () => {
  const got = mapHints([
    hint("std::vector push_back", { name: "Vectors", lang: "cpp" }),
    hint("scanning a vector for a value", { name: "linear search", lang: "c++" }),
    hint("halving a sorted range", { name: "binary search", lang: "C++" }, 0.9),
  ], offered);
  assert.deepEqual(got.map((h) => h.skill), [
    { name: "vectors", lang: "c++" },
    { name: "linear search", lang: "c++" },
    { name: "binary search", lang: "c++" },
  ]);
  assert.equal(got[2]!.confidence, 0.9);
  TopicHintsSchema.parse(got);
});

test("an irrelevant tab, an invented skill and no match all stay unmapped gaps", () => {
  const got = mapHints([
    hint("weather forecast tab", null),
    hint("bogo sort", { name: "bogo sort", lang: "c++" }),
    hint("knitting patterns", { name: "knitting" }),
  ], offered);
  assert.deepEqual(got.map((h) => [h.topic, h.skill]), [
    ["weather forecast tab", null],
    ["bogo sort", null],
    ["knitting patterns", null],
  ]);
});

test("a language-free skill stays language-free, even when reported from the zone language", () => {
  const got = mapHints([hint("git rebase", { name: "git", lang: "c++" }), hint("curl a URL", { name: "HTTP", lang: "" })], offered);
  assert.deepEqual(got.map((h) => h.skill), [{ name: "git", lang: "" }, { name: "http", lang: "" }]);
});

test("the right name in the wrong language is a gap", () => {
  const got = mapHints([hint("bisect", { name: "binary search", lang: "python" }), hint("Vec<T>", { name: "vectors", lang: "rust" })], offered);
  assert.deepEqual(got.map((h) => h.skill), [null, null]);
});

test("inferred hints below 0.8 keep their topic but no skill; 0.85 visits the ref", () => {
  const got = mapHints([hint("maybe a vector", { name: "vectors", lang: "c++" }, 0.6), hint("probably a vector", { name: "vectors", lang: "c++" }, 0.85)], offered);
  assert.deepEqual(got[0], { topic: "maybe a vector", skill: null, confidence: 0.6, reason: "named on screen" });
  assert.deepEqual(got[1]!.skill, { name: "vectors", lang: "c++" });
  assert.equal(TRAIL_LIMITS.inferredConfidence, 0.8);
});

test("more than three hints keep the first three valid ones, in reported order", () => {
  const got = mapHints([
    hint("", { name: "vectors", lang: "c++" }),
    hint("one", { name: "vectors", lang: "c++" }),
    hint("two", null, 1.5),
    hint("three", { name: "maps", lang: "c++" }),
    hint("four", { name: "iterators", lang: "c++" }),
    hint("five", { name: "lambdas", lang: "c++" }),
  ], offered);
  assert.deepEqual(got.map((h) => h.topic), ["one", "three", "four"]);
});

test("garbage gives no hints", () => {
  for (const raw of [undefined, null, "topics", 5, {}, { topics: [] }]) assert.deepEqual(mapHints(raw, offered), []);
  assert.deepEqual(mapHints([
    null, 1, "vectors", [], { topic: 7, confidence: 1 }, { topic: "x" }, { topic: "x", confidence: Number.NaN },
    { topic: "x", confidence: Infinity }, { topic: "x", confidence: -0.1 }, { topic: "x", confidence: "0.9" }, { topic: " \n\t ", confidence: 1 },
  ], offered), []);
  assert.deepEqual(mapHints([hint("x", "vectors"), hint("y", { name: 3, lang: "c++" }), hint("z", { name: "vectors", lang: 1 })], offered).map((h) => h.skill), [null, null, null]);
});

test("topics and reasons are trimmed, stripped of control characters and clipped", () => {
  const got = mapHints([{ topic: `  a\u0000b\n${"t".repeat(400)}`, skill: { name: "vectors", lang: "c++" }, confidence: 1, reason: `\u0007${"r".repeat(500)}\u{1F600}` }], offered);
  assert.equal(got.length, 1);
  assert.ok(got[0]!.topic.startsWith("a b t"));
  assert.ok(got[0]!.topic.length <= TRAIL_LIMITS.topicChars && got[0]!.reason.length <= TRAIL_LIMITS.reasonChars);
  const pair = mapHints([{ topic: `${"x".repeat(159)}\u{1F600}`, skill: null, confidence: 1 }], offered);
  assert.equal(pair[0]!.topic, "x".repeat(159));
  assert.equal(pair[0]!.reason, "");
  TopicHintsSchema.parse([...got, ...pair]);
});

test("exact artifact refs keep their language, take the track's spelling and coalesce consecutive repeats", () => {
  const refs: SkillRef[] = [
    { name: "Vectors", lang: "c++" }, { name: "vectors", lang: "cpp" }, { name: "Git", lang: "" }, { name: "custom allocators", lang: "c++" },
    { name: "vectors", lang: "c++" }, { name: "maps", lang: "c++" }, { name: "iterators", lang: "c++" }, { name: "lambdas", lang: "c++" },
    { name: "classes", lang: "c++" },
  ];
  const got = exactHints(refs, " change to main.cpp ", "listed in the change manifest");
  assert.deepEqual(got.map((h) => h.skill), [
    { name: "vectors", lang: "c++" }, { name: "git", lang: "" }, { name: "custom allocators", lang: "c++" }, { name: "vectors", lang: "c++" },
    { name: "maps", lang: "c++" }, { name: "iterators", lang: "c++" }, { name: "lambdas", lang: "c++" }, { name: "classes", lang: "c++" },
  ]);
  for (const h of got) {
    TopicHintSchema.parse(h);
    assert.equal(h.confidence, 1);
    assert.equal(h.topic, "change to main.cpp");
    assert.equal(h.reason, "listed in the change manifest");
  }
  assert.equal(exactHints([{ name: "git", lang: "" }], "\n", "")[0]!.topic, "git");
});

test("candidate lines name each ref and its language", () => {
  assert.equal(candidateLines([{ name: "vectors", lang: "c++" }, { name: "git", lang: "" }]), "vectors (c++)\ngit (any language)");
  assert.equal(candidateLines([]), "");
});

test("mapping writes nothing: not the tree, not prereqs.json", () => {
  const before = hashHome();
  const prereqs = readFileSync(join(HOME, "prereqs.json"), "utf8");
  const refs = candidates(cpp, tree, "binary search over a vector, git, docker and a brand new thing");
  mapHints([hint("brand new thing", { name: "brand new thing", lang: "c++" }), hint("vectors", { name: "vectors", lang: "c++" })], refs);
  exactHints([{ name: "brand new thing", lang: "c++" }], "artifact", "owner validated");
  candidateLines(refs);
  assert.equal(hashHome(), before);
  assert.equal(readFileSync(join(HOME, "prereqs.json"), "utf8"), prereqs);
  assert.deepEqual(skills.read(HOME), tree);
  assert.equal(curriculum.mapped("brand new thing", "c++"), undefined);
});

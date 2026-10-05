import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import * as memory from "../src/memory.ts";
import { Workspace } from "../src/workspace.ts";

test("answers and course results survive an interrupted process and a fresh store", async () => {
  const root = mkdtempSync(`${tmpdir()}/dum-memory-`);
  try {
    const store = new Store("practice", "understand", root);
    const detach = memory.attach(root, store);
    const answer = store.askQuestion("what are you building?", "");
    store.submit("a guessing game");
    await answer;
    const card = { skill: "functions", lang: "c++", lesson: "Split the steps.", example: "void guess() {}", wizard: "", task: "write a function", path: ".dum/courses/functions.cc", run: "g++ functions.cc" };
    store.course(card);
    store.endCourse(card, true);
    memory.remember(root, "Next: split input and guessing into functions.");
    detach();
    const loaded = memory.load(root);
    assert.equal(loaded.warning, "");
    const restored = new Store("practice", "understand", root);
    restored.restoreTranscript(loaded.entries);
    assert.equal(restored.getSnapshot().prompt, null, "history doesn't re-approve old plans");
    assert.ok(restored.getSnapshot().transcript.some((e) => e.kind === "question" && e.answer === "a guessing game"));
    assert.ok(restored.getSnapshot().transcript.some((e) => e.kind === "course" && e.passed));
    restored.note("back again");
    const ids = restored.getSnapshot().transcript.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    const prompt = memory.prompt(root, loaded.entries);
    assert.match(prompt, /guessing game/);
    assert.match(prompt, /"passed":true/);
    memory.fresh(root);
    assert.deepEqual(memory.load(root).entries, []);
    assert.equal(memory.notes(root), "");
    assert.ok(readdirSync(`${root}/.dum`).some((f) => f.startsWith("memory.md.old-")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dum --new after a proposal starts an empty conversation and keeps every saved proposal", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-memory-`);
  try {
    const store = new Store("practice", "understand", root);
    const detach = memory.attach(root, store);
    writeFileSync(`${root}/main.py`, "print(1)\n");
    const ws = new Workspace(root, store);
    const { artifact } = ws.propose("main.py", ws.file("main.py").sha, "print(2)\n");
    const patch = readFileSync(`${root}/${artifact}`, "utf8");
    detach();
    assert.ok(memory.load(root).entries.length > 0);
    memory.fresh(root);
    assert.deepEqual(memory.load(root).entries, []);
    assert.equal(readFileSync(`${root}/${artifact}`, "utf8"), patch, "the proposal stays where it was saved");
    assert.ok(readdirSync(`${root}/.dum`).some((f) => f.startsWith("transcript.json.old-")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared excerpts, proposals, results and old-session entries all come back, and feed dum's memory", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-memory-`);
  try {
    const store = new Store("practice", "understand", root);
    const detach = memory.attach(root, store);
    store.excerpt("guess.py", 3, "if guess > secret:\n    print('lower')", "you");
    store.diff("util.py", "--- a/util.py\n+++ b/util.py\n+x = 1", "proposed", ".dum/proposals/1-util.py.diff");
    store.result("git status", " M guess.py", 0);
    void store.askNext();
    store.submit("use a dict for the scores, I explained why last time");
    detach();
    // An older session's fill and an empty-question answer are still valid history.
    const saved = JSON.parse(readFileSync(`${root}/.dum/transcript.json`, "utf8"));
    saved.unshift({ id: 900, kind: "fill", path: "a.py", concept: "loops", code: "for x in y: pass" }, { id: 901, kind: "question", question: "", why: "", answer: "done" });
    writeFileSync(`${root}/.dum/transcript.json`, JSON.stringify(saved));
    const loaded = memory.load(root);
    assert.equal(loaded.warning, "");
    assert.deepEqual(loaded.entries.map((e) => e.kind), ["fill", "question", "excerpt", "diff", "result", "user"]);
    const prompt = memory.prompt(root, loaded.entries);
    assert.match(prompt, /use a dict for the scores/);
    assert.match(prompt, /guess\.py:3/);
    assert.match(prompt, /proposed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a note is appended to the file as their editor left it, never rewritten from an old copy", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-memory-`);
  try {
    memory.remember(root, "Use a music example.");
    // Their editor saves between dum's read and its next note.
    writeFileSync(`${root}/.dum/memory.md`, "# Session memory\n\n- Use a cooking example instead.\n");
    memory.remember(root, "Next: split input from scoring.");
    const notes = memory.notes(root);
    assert.match(notes, /cooking example instead/);
    assert.match(notes, /split input from scoring/);
    assert.doesNotMatch(notes, /music/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symlinked memory or transcript is refused visibly and never followed or moved", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-memory-`);
  const outside = mkdtempSync(`${tmpdir()}/dum-outside-`);
  try {
    writeFileSync(`${outside}/secret.txt`, "token=abc");
    mkdirSync(`${root}/.dum`);
    symlinkSync(`${outside}/secret.txt`, `${root}/.dum/memory.md`);
    symlinkSync(`${outside}/secret.txt`, `${root}/.dum/transcript.json`);
    assert.throws(() => memory.notes(root));
    assert.throws(() => memory.remember(root, "a note"));
    assert.doesNotMatch(memory.prompt(root, []), /token=abc/);
    const loaded = memory.load(root);
    assert.deepEqual(loaded.entries, []);
    assert.ok(loaded.warning, "the refusal is shown");
    assert.equal(readFileSync(`${outside}/secret.txt`, "utf8"), "token=abc");
    assert.ok(existsSync(`${root}/.dum/transcript.json`), "not renamed away as a corrupt backup");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("memory stays bounded, rejects malformed history, and reflects edited notes", () => {
  const root = mkdtempSync(`${tmpdir()}/dum-memory-`);
  try {
    const entries = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, kind: "say" as const, text: `reply ${i}` }));
    memory.save(root, entries);
    assert.equal(memory.load(root).entries.length, memory.MAX_ENTRIES);
    memory.remember(root, "I want to practice functions.");
    writeFileSync(`${root}/.dum/memory.md`, "# Session memory\nUse a music example instead.\n");
    assert.match(memory.prompt(root, entries), /music example/);
    writeFileSync(`${root}/.dum/transcript.json`, '[{"id":1,"kind":"question","answer":{}}]');
    assert.ok(memory.load(root).warning);
    assert.ok(readdirSync(`${root}/.dum`).some((f) => f.startsWith("transcript.invalid-")), "keep corrupt history for recovery");
    assert.equal(memory.load(root).entries.length, 0);
    assert.match(readFileSync(`${root}/.dum/memory.md`, "utf8"), /music/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self maintenance at a course prompt preserves the pending answer and queues input", async () => {
  const store = new Store("practice", "understand");
  let finish!: (reply: string) => void;
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  store.onSelfChange = async () => { started(); return new Promise((resolve) => { finish = resolve; }); };
  const card = { skill: "functions", lang: "c++", lesson: "", example: "", wizard: "", task: "", path: "functions.cc", run: "" };
  store.course(card);
  const answer = store.askCourse(card);
  store.submit(":self fix the scroll position");
  await starting;
  assert.equal(store.getSnapshot().prompt, null);
  assert.equal(store.getSnapshot().busy, true);
  store.submit("done");
  finish("fixed the scroll position");
  assert.equal(await answer, "done");
  assert.ok(store.getSnapshot().transcript.some((e) => e.kind === "say" && /scroll position/.test(e.text)));
});

test("a failed self change leaves the learning question answerable", async () => {
  const store = new Store("practice", "understand");
  store.onSelfChange = async () => { throw new Error("connection lost"); };
  const question = store.askQuestion("what next?", "");
  assert.match(await store.changeSelf("fix dum"), /connection lost/);
  assert.equal(store.getSnapshot().prompt?.type, "question");
  store.submit("practice functions");
  assert.equal(await question, "practice functions");
});

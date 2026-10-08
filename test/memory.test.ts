import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as memory from "../src/memory.ts";
import type { Entry } from "../src/store-types.ts";
import { ZONE_LIMITS } from "../src/zone-types.ts";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "dum-memory-"));
  const home = join(root, "home");
  const zone = randomUUID();
  return { root, home, zone, dir: join(home, "zones", zone), done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Just enough conversation store for `attach`. */
class FakeStore implements memory.Transcribed {
  transcript: Entry[] = [];
  notes: string[] = [];
  private listeners: (() => void)[] = [];
  getSnapshot() { return { transcript: this.transcript }; }
  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }
  note(text: string) { this.notes.push(text); }
  push(entry: Entry) {
    this.transcript = [...this.transcript, entry];
    for (const l of this.listeners) l();
  }
}

test("a zone's conversation and notes live in its own directory and survive a restart", () => {
  const { home, zone, dir, done } = scratch();
  try {
    const store = new FakeStore();
    const detach = memory.attach(home, zone, store);
    store.push({ kind: "question", id: 1, question: "what are you building?", why: "", answer: "a guessing game" });
    store.push({ kind: "diff", id: 2, path: "src/guess.py", diff: "+x", outcome: "applied", changeId: randomUUID() });
    detach();
    store.push({ kind: "say", id: 3, text: "after detach" });
    memory.remember(home, zone, "Next: split input and guessing into functions.");
    assert.deepEqual(readdirSync(dir).sort(), ["memory.md", "transcript.json"]);
    const loaded = memory.load(home, zone);
    assert.equal(loaded.warning, "");
    assert.deepEqual(loaded.entries.map((e) => e.id), [1, 2], "nothing saved after detaching");
    const prompt = memory.prompt(home, zone, loaded.entries);
    assert.match(prompt, /guessing game/);
    assert.match(prompt, /"outcome":"applied"/);
    assert.match(prompt, /split input and guessing/);
    assert.match(memory.describe(home, zone), new RegExp(`zones/${zone}/memory\\.md`));
  } finally { done(); }
});

test("zones don't share memory: another zone starts empty", () => {
  const { home, zone, done } = scratch();
  try {
    memory.save(home, zone, [{ kind: "say", id: 1, text: "only here" }]);
    memory.remember(home, zone, "only here too");
    const other = randomUUID();
    assert.deepEqual(memory.load(home, other), { entries: [], warning: "" });
    assert.equal(memory.notes(home, other), "");
    assert.equal(memory.prompt(home, other, []), "");
  } finally { done(); }
});

test("a zone ID that isn't app-issued never becomes a path", () => {
  const { home, done } = scratch();
  try {
    for (const bad of ["../escape", "a/b", "", "ABCDEF00-0000-4000-8000-000000000000"]) {
      assert.throws(() => memory.save(home, bad, []), /isn't an app-issued zone ID/, bad);
      assert.throws(() => memory.remember(home, bad, "note"), /isn't an app-issued zone ID/, bad);
    }
    assert.equal(existsSync(home), false);
  } finally { done(); }
});

test("a note is appended to the file as their editor left it, never rewritten from an old copy", () => {
  const { home, zone, dir, done } = scratch();
  try {
    memory.remember(home, zone, "Use a music example.");
    writeFileSync(join(dir, "memory.md"), "# Zone memory\n\n- Use a cooking example instead.\n");
    memory.remember(home, zone, "Next: split input from scoring.");
    const notes = memory.notes(home, zone);
    assert.match(notes, /cooking example instead/);
    assert.match(notes, /split input from scoring/);
    assert.doesNotMatch(notes, /music/);
  } finally { done(); }
});

test("notes are bounded: a note that would overflow is refused and the file is unchanged", () => {
  const { home, zone, dir, done } = scratch();
  try {
    mkdirSync(dir, { recursive: true });
    const full = `# Zone memory\n\n${"x".repeat(ZONE_LIMITS.memoryBytes - 30)}\n`;
    writeFileSync(join(dir, "memory.md"), full);
    assert.throws(() => memory.remember(home, zone, "one more note that will not fit"), /full/);
    assert.equal(readFileSync(join(dir, "memory.md"), "utf8"), full);
    writeFileSync(join(dir, "memory.md"), "x".repeat(ZONE_LIMITS.memoryBytes + 1));
    assert.throws(() => memory.notes(home, zone), /KiB/);
  } finally { done(); }
});

test("the transcript keeps the newest entries within the count and byte limits", () => {
  const { home, zone, dir, done } = scratch();
  try {
    const entries: Entry[] = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, kind: "say", text: `reply ${i}` }));
    memory.save(home, zone, entries);
    const loaded = memory.load(home, zone).entries;
    assert.equal(loaded.length, memory.MAX_ENTRIES);
    assert.equal(loaded.at(-1)?.id, 700);
    const big = "y".repeat(200 * 1024);
    memory.save(home, zone, Array.from({ length: 30 }, (_, i) => ({ id: i + 1, kind: "say", text: big })));
    assert.ok(readFileSync(join(dir, "transcript.json")).length <= ZONE_LIMITS.transcriptBytes);
    assert.equal(memory.load(home, zone).entries.at(-1)?.id, 30);
  } finally { done(); }
});

test("a corrupt transcript is preserved aside, not reset in place; an oversized one is left exactly where it is", () => {
  const { home, zone, dir, done } = scratch();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript.json"), '[{"id":1,"kind":"question","answer":{}}]');
    const loaded = memory.load(home, zone);
    assert.deepEqual(loaded.entries, []);
    assert.match(loaded.warning, /kept the original/);
    const aside = readdirSync(dir).find((f) => f.startsWith("transcript.invalid-"));
    assert.ok(aside);
    assert.equal(readFileSync(join(dir, aside), "utf8"), '[{"id":1,"kind":"question","answer":{}}]');

    writeFileSync(join(dir, "transcript.json"), "x".repeat(ZONE_LIMITS.transcriptBytes + 1));
    assert.match(memory.load(home, zone).warning, /couldn't restore/);
    assert.equal(readFileSync(join(dir, "transcript.json")).length, ZONE_LIMITS.transcriptBytes + 1);
  } finally { done(); }
});

test("a symlinked memory or transcript is refused visibly and never followed or moved", () => {
  const { root, home, zone, dir, done } = scratch();
  try {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "token=abc");
    mkdirSync(dir, { recursive: true });
    symlinkSync(secret, join(dir, "memory.md"));
    symlinkSync(secret, join(dir, "transcript.json"));
    assert.throws(() => memory.notes(home, zone), /symlink/);
    assert.throws(() => memory.remember(home, zone, "a note"));
    assert.doesNotMatch(memory.prompt(home, zone, []), /token=abc/);
    const loaded = memory.load(home, zone);
    assert.deepEqual(loaded.entries, []);
    assert.match(loaded.warning, /symlink/);
    assert.equal(readFileSync(secret, "utf8"), "token=abc");
    assert.ok(existsSync(join(dir, "transcript.json")), "not renamed away as a corrupt backup");
  } finally { done(); }
});

test("old history stays readable and recalled as history, not as permission", () => {
  const { home, zone, dir, done } = scratch();
  try {
    mkdirSync(dir, { recursive: true });
    const card = { skill: "functions", lang: "c++", lesson: "", example: "", wizard: "", task: "", path: "", run: "" };
    writeFileSync(join(dir, "transcript.json"), JSON.stringify([
      { id: 1, kind: "plan", plan: "rewrite main.py", approved: true },
      { id: 2, kind: "course", card, passed: true },
      { id: 3, kind: "fill", path: "a.py", concept: "loops", code: "for x in y: pass" },
      { id: 4, kind: "diff", path: "util.py", diff: "+x", outcome: "proposed", artifact: ".dum/proposals/1.diff" },
      { id: 5, kind: "result", label: "git status", output: " M a.py", code: 0 },
    ]));
    const loaded = memory.load(home, zone);
    assert.equal(loaded.warning, "");
    const prompt = memory.prompt(home, zone, loaded.entries);
    assert.match(prompt, /"old_plan":"rewrite main.py"/);
    assert.match(prompt, /"old_course":"functions"/);
    assert.match(prompt, /not permission for new work/);
  } finally { done(); }
});

test("starting fresh moves this zone's conversation aside and deletes nothing", () => {
  const { home, zone, dir, done } = scratch();
  try {
    memory.save(home, zone, [{ kind: "say", id: 1, text: "hello" }]);
    memory.remember(home, zone, "keep this somewhere");
    writeFileSync(join(dir, "context.md"), "zone context stays");
    memory.fresh(home, zone);
    assert.deepEqual(memory.load(home, zone).entries, []);
    assert.equal(memory.notes(home, zone), "");
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("transcript.json.old-")));
    assert.ok(files.some((f) => f.startsWith("memory.md.old-")));
    assert.equal(readFileSync(join(dir, "context.md"), "utf8"), "zone context stays");
  } finally { done(); }
});

test("a failed save warns once through the store instead of throwing into it", () => {
  const { home, zone, dir, done } = scratch();
  try {
    mkdirSync(join(dir, "transcript.json"), { recursive: true });
    const store = new FakeStore();
    const detach = memory.attach(home, zone, store);
    store.push({ kind: "say", id: 1, text: "a" });
    store.push({ kind: "say", id: 2, text: "b" });
    detach();
    assert.equal(store.notes.length, 1);
    assert.match(store.notes[0]!, /couldn't save/);
  } finally { done(); }
});

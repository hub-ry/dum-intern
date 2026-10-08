// What a typed line does: answers the prompt showing, runs one of dum's commands, or waits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store, Cancelled, parseCommand } from "../src/store.ts";

const tick = () => new Promise((r) => setImmediate(r));
const zone = () => ({ id: randomUUID(), name: "Data Structures" });

test("a store holds one zone's conversation state, with no model until one is set", () => {
  const z = zone();
  const s = new Store(z, "anti-vibe");
  const state = s.getSnapshot();
  assert.equal(state.zoneId, z.id);
  assert.equal(state.zoneName, "Data Structures");
  assert.equal(state.mode, "anti-vibe");
  assert.deepEqual(state.models, { intern: null, helper: null, look: null });
  assert.equal(state.prompt, null);
  assert.ok(!("repo" in state) && !("root" in state) && !("files" in state));
});

test("model labels name the backend, model and effort, and set only on change", () => {
  const s = new Store(zone(), "understand");
  let changes = 0;
  s.subscribe(() => void changes++);
  s.setModel("intern", { backend: "claude", model: "claude-opus-5-5", effort: "high" });
  s.setModel("intern", { backend: "claude", model: "claude-opus-5-5", effort: "high" });
  s.setModel("helper", { backend: "local", model: "qwen3:8b", effort: null });
  assert.equal(changes, 2, "the same label twice is no change");
  assert.deepEqual(s.getSnapshot().models, {
    intern: { backend: "claude", model: "claude-opus-5-5", effort: "high" },
    helper: { backend: "local", model: "qwen3:8b", effort: null },
    look: null,
  });
  s.setModel("intern", null);
  assert.equal(s.getSnapshot().models.intern, null);
});

test("dum's commands never answer the question showing, and only their exact words are commands", async () => {
  const s = new Store(zone(), "understand");
  const edits: string[][] = [];
  s.onSkillEdit = (a, n, l) => void edits.push([a, n, l]);
  s.onSkills = (arg) => `tree ${arg || "here"}`;
  const reply = s.askQuestion("which file?", "");
  s.submit(":skill for loops in python");
  s.submit(":skill -recursion");
  s.submit(":tree rust");
  const panel = s.getSnapshot().stage;
  assert.ok(panel.kind === "info" && panel.body === "tree rust");
  s.submit(": log");
  assert.equal(s.getSnapshot().prompt?.type, "question", "still waiting on the question");
  s.submit(":yes");
  assert.equal(await reply, ":yes", "not a command: an answer");
  assert.deepEqual(edits, [["add", "for loops", "python"], ["forget", "recursion", ""]]);
  assert.equal(parseCommand(":help me with this"), null, "a sentence after a bare command is a sentence");
  assert.deepEqual(parseCommand(":inspect walk.py:3-9"), { name: "inspect", arg: "walk.py:3-9" });
  assert.deepEqual(parseCommand(":projects recursion in python"), { name: "projects", arg: "recursion in python" });
});

test("commands from earlier versions are refused with a pointer to :help, never sent or used as an answer", async () => {
  const s = new Store(zone(), "understand");
  const reply = s.askQuestion("q?", "");
  for (const line of [":run status", ":self fix it", ":web", ":changes", ":share ~/x.md", ":practice recursion", ":restart"]) {
    assert.equal(parseCommand(line), null);
    s.submit(line);
  }
  const notes = s.getSnapshot().transcript.filter((e) => e.kind === "note");
  assert.equal(notes.length, 7);
  assert.ok(notes.every((e) => e.kind === "note" && /isn't one of dum's commands - :help lists them/.test(e.text)));
  s.submit("real answer");
  assert.equal(await reply, "real answer");
});

test("a slow command keeps the question open, its failure is shown, one runs at a time, and command() settles when it's done", async () => {
  const s = new Store(zone(), "understand");
  let finish!: () => void;
  const seen: string[] = [];
  s.onInspect = (arg) => {
    seen.push(arg);
    const { promise, resolve } = Promise.withResolvers<void>();
    finish = resolve;
    return promise;
  };
  s.onProjects = async () => { throw new Error("no helper model chosen"); };
  const reply = s.askQuestion("what next?", "");
  let answered = false;
  void reply.then(() => { answered = true; });
  let inspected = false;
  const inspecting = s.command("inspect", "main.py:1-20").then(() => { inspected = true; });
  s.submit(":inspect other.py");
  assert.deepEqual(seen, ["main.py:1-20"], "the second waits its turn instead of racing a permission question");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "note" && /wait for :inspect/.test(e.text)));
  s.submit("yes");
  await tick();
  assert.equal(answered, false, "text typed during a local read cannot answer the suspended question");
  assert.equal(inspected, false);
  finish();
  await inspecting;
  await s.command("projects", "recursion");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "note" && /:projects didn't work: no helper model chosen/.test(e.text)));
  assert.equal(s.getSnapshot().prompt?.type, "question");
  s.submit("keep going");
  assert.equal(await reply, "keep going");
});

test("a permission asked during dum's question is answered first, then dum's question comes back", async () => {
  const s = new Store(zone(), "understand");
  const outer = s.askQuestion("which approach?", "");
  let consent = "";
  s.onSubmit = async () => { consent = await s.askQuestion("did you write it unaided?", "", false, "attest"); };
  s.submit(":submit hashing walk.py --unaided");
  await tick();
  const asking = s.getSnapshot().prompt;
  assert.ok(asking?.type === "question" && asking.purpose === "attest");
  s.respond({ kind: "attest", value: true });
  await tick();
  assert.equal(consent, "yes");
  const p = s.getSnapshot().prompt;
  assert.ok(p?.type === "question" && p.question === "which approach?", "the outer question is showing again");
  assert.throws(() => s.respond({ kind: "attest", value: true }), /nothing is waiting for that answer/, "a button never answers a different prompt");
  s.submit("a hash map");
  assert.equal(await outer, "a hash map");
});

test("a line typed while dum works is never an answer to a later question, only the next request", async () => {
  const s = new Store(zone(), "understand");
  s.working("thinking");
  s.submit("y");
  const question = s.askQuestion("overwrite your notes?", "", true, "share");
  await tick();
  assert.equal(s.getSnapshot().prompt?.type, "question", "the question waits for a reply typed after it showed");
  s.submit("no");
  assert.equal(await question, "no");
  assert.equal(await s.askNext(), "y", "the early line is the next request");
  const said = s.getSnapshot().transcript.flatMap((e) => (e.kind === "user" ? [e.text] : []));
  assert.deepEqual(said, ["y"], "said once, in order");
});

test("not yet takes a skill back without costing the turn, and is an answer when there's nothing to take", async () => {
  const s = new Store(zone(), "understand");
  const taken: string[] = [];
  let has = true;
  s.onNotYet = (name) => (has ? (taken.push(name), true) : false);
  const reply = s.askQuestion("have you added tests?", "");
  s.submit("not yet");
  s.submit("Not yet: rust macros");
  assert.deepEqual(taken, ["", "rust macros"]);
  has = false;
  s.submit("not yet");
  assert.equal(await reply, "not yet");
});

test("answering closes a help panel so the reply is visible", async () => {
  const s = new Store(zone(), "understand");
  s.command("help");
  const panel = s.getSnapshot().stage;
  assert.ok(panel.kind === "info" && /:projects/.test(panel.body) && !/:run|:web|:self|course/.test(panel.body));
  const request = s.askQuestion("what do you want?", "", false);
  s.submit("hello");
  assert.equal(await request, "hello");
  assert.equal(s.getSnapshot().stage.kind, "conversation");
});

test("the boundary panel names the zone", () => {
  const s = new Store(zone(), "understand");
  s.onBoundary = () => "nothing shared";
  s.command("boundary");
  const panel = s.getSnapshot().stage;
  assert.ok(panel.kind === "info" && panel.title === "what AI may do in Data Structures" && panel.body === "nothing shared");
});

test("a change and its revert go in the transcript with the change ID", () => {
  const s = new Store(zone(), "understand");
  const id = randomUUID();
  s.diff("g/main.py", "-a\n+b\n", "applied", id);
  s.diff("g/main.py", "-b\n+a\n", "reverted", id);
  const diffs = s.getSnapshot().transcript.filter((e) => e.kind === "diff");
  assert.deepEqual(diffs.map((e) => e.kind === "diff" && [e.outcome, e.changeId]), [["applied", id], ["reverted", id]]);
  assert.match(s.logText(), new RegExp(`applied g/main.py \\(change ${id}\\)`));
});

test("Stop and close withdraw questions without answering them", async () => {
  const s = new Store(zone(), "understand");
  const asked = s.askQuestion("which one?", "");
  s.cancel();
  await assert.rejects(asked, (err) => err instanceof Cancelled && !err.final);
  const next = s.askNext();
  s.cancel();
  assert.equal(s.getSnapshot().prompt?.type, "next", "what next survives Stop");
  const attest = s.askQuestion("did you write it?", "", false, "attest");
  s.close();
  await assert.rejects(attest, (err) => err instanceof Cancelled && err.final);
  await assert.rejects(next, (err) => err instanceof Cancelled && err.final);
  await assert.rejects(s.askNext(), (err) => err instanceof Cancelled && err.final);
  assert.ok(s.getSnapshot().transcript.every((e) => e.kind !== "question" || e.answer === null));
});

test("a helper call begun after Stop, inside the work Stop ended, never runs; work begun after Stop is unaffected", async () => {
  const s = new Store(zone(), "understand");
  let ran = 0;
  await assert.rejects(
    s.operation(async () => {
      await Promise.resolve();
      s.cancel();
      await Promise.resolve();
      await s.helper(async () => void ran++);
    }),
    (err) => err instanceof Cancelled && !err.final,
  );
  assert.equal(ran, 0);
  assert.equal(await s.helper(async () => (ran++, "fresh")), "fresh", "the next thing they ask for runs normally");
  s.close();
  await assert.rejects(s.helper(async () => void ran++), (err) => err instanceof Cancelled && err.final);
  assert.equal(ran, 1);
  await s.settled();
});

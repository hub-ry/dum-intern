// What a typed line does: answers the prompt showing, runs one of dum's commands, or waits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, Cancelled, parseCommand } from "../src/store.ts";

const tick = () => new Promise((r) => setImmediate(r));

test("dum's commands never answer the question showing, and only their exact words are commands", async () => {
  const s = new Store("r", "understand");
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
  assert.deepEqual(parseCommand(":inspect src/a.py:3-9"), { name: "inspect", arg: "src/a.py:3-9" });
});

test("a shell line is refused, never run and never an answer", async () => {
  const s = new Store("r", "understand");
  const reply = s.askQuestion("q?", "");
  s.submit("!rm -rf build");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "note" && /doesn't run shell commands/.test(e.text)));
  s.submit("real answer");
  assert.equal(await reply, "real answer");
});

test("a slow command keeps the question open, its failure is shown, and one runs at a time", async () => {
  const s = new Store("r", "understand");
  let finish!: () => void;
  const seen: string[] = [];
  s.onInspect = (arg) => {
    seen.push(arg);
    return new Promise<void>((r) => { finish = r; });
  };
  s.onChanges = async () => { throw new Error("not a git repository"); };
  const reply = s.askQuestion("what next?", "");
  let answered = false;
  void reply.then(() => { answered = true; });
  s.submit(":inspect main.py:1-20");
  s.submit(":share ~/notes/plan.md");
  assert.deepEqual(seen, ["main.py:1-20"], "the second waits its turn instead of racing a permission question");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "note" && /wait for :inspect/.test(e.text)));
  s.submit("yes");
  await tick();
  assert.equal(answered, false, "text typed during a local read cannot approve or answer the suspended question");
  finish();
  await tick();
  s.submit(":changes");
  await tick();
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "note" && /:changes didn't work: not a git repository/.test(e.text)));
  assert.equal(s.getSnapshot().prompt?.type, "question");
  s.submit("keep going");
  assert.equal(await reply, "keep going");
});

test("a permission asked during dum's question is answered first, then dum's question comes back", async () => {
  const s = new Store("r", "understand");
  const outer = s.askQuestion("which approach?", "");
  let consent = "";
  s.onInspect = async () => { consent = await s.askQuestion("let dum read ~/x.md?", "", false); };
  s.submit(":share ~/x.md");
  await tick();
  const asking = s.getSnapshot().prompt;
  assert.ok(asking?.type === "question" && asking.question === "let dum read ~/x.md?");
  s.submit("y");
  await tick();
  assert.equal(consent, "y");
  const p = s.getSnapshot().prompt;
  assert.ok(p?.type === "question" && p.question === "which approach?", "the outer question is showing again");
  s.submit("a hash map");
  assert.equal(await outer, "a hash map");
});

test("a line typed while dum works is never an approval or a permission, only the next request", async () => {
  const s = new Store("r", "understand");
  s.working("thinking");
  s.submit("y");
  const plan = s.proposePlan("**x**");
  await tick();
  assert.equal(s.getSnapshot().prompt?.type, "plan", "the plan waits for a reply typed after it showed");
  s.submit("no, smaller");
  assert.equal(await plan, "no, smaller");
  assert.ok(s.getSnapshot().transcript.some((e) => e.kind === "plan" && e.approved === false));
  assert.equal(await s.askNext(), "y", "the early line is the next request");
  const said = s.getSnapshot().transcript.flatMap((e) => (e.kind === "user" ? [e.text] : []));
  assert.deepEqual(said, ["y", "no, smaller"], "each said once, in order");
});

test("only y approves a plan, and a course reply pauses it without declining", async () => {
  const s = new Store("r", "understand");
  const first = s.proposePlan("**a**");
  s.submit("yes please");
  assert.equal(await first, "yes please");
  const second = s.proposePlan("**b**");
  s.submit("course recursion");
  assert.equal(await second, "course recursion");
  const third = s.proposePlan("**c**");
  s.submit("Y");
  await third;
  const plans = s.getSnapshot().transcript.filter((e) => e.kind === "plan");
  assert.deepEqual(plans.map((e) => e.kind === "plan" && [e.approved, !!e.paused]), [[false, false], [null, true], [true, false]]);
});

test("not yet takes a skill back without costing the turn, and is an answer when there's nothing to take", async () => {
  const s = new Store("r", "understand");
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
  const s = new Store("r", "understand");
  s.show("nothing's unlocked yet", "Ask for something.");
  const request = s.askQuestion("what do you want?", "", false);
  s.submit("hello");
  assert.equal(await request, "hello");
  assert.equal(s.getSnapshot().stage.kind, "conversation");
});

test(":web connects without consuming the pending answer, and a late reply can't cover the conversation", async () => {
  const s = new Store("r", "understand");
  const servers: (string | undefined)[] = [];
  s.onWeb = async (server) => { servers.push(server); return "https://trees.example.com/private"; };
  const question = s.askQuestion("what do you want?", "", false);
  s.submit(":web https://trees.example.com");
  await tick();
  assert.deepEqual(servers, ["https://trees.example.com"]);
  const panel = s.getSnapshot().stage;
  assert.ok(panel.kind === "info" && panel.body.includes("/private"));
  s.submit("a guessing game");
  assert.equal(await question, "a guessing game");
  let finish!: (link: string) => void;
  s.onWeb = () => new Promise<string>((resolve) => { finish = resolve; });
  s.command("web");
  s.closeBoard();
  finish("private link");
  await tick();
  assert.equal(s.getSnapshot().stage.kind, "conversation");
});

test("an init without effort never wipes an effort already read back", () => {
  const s = new Store("r", "understand");
  s.setModel("intern", "claude-opus-5-5", "high");
  s.setModel("intern", "claude-opus-5-5");
  assert.deepEqual(s.getSnapshot().models.intern, { model: "claude-opus-5-5", effort: "high" });
  s.setModel("intern", "claude-fable-5-1");
  assert.deepEqual(s.getSnapshot().models.intern, { model: "claude-fable-5-1", effort: "" });
});

test("a helper call begun after Stop, inside the work Stop ended, never runs; work begun after Stop is unaffected", async () => {
  const s = new Store("r", "understand");
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

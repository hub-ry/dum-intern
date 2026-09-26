// An Enter that arrives in the same chunk as the text before it must still
// submit. Reproduced end to end first: `tmux send-keys "print hi" Enter` left
// the request sitting in the field.

import { test } from "node:test";
import assert from "node:assert/strict";
import { typed, pasted } from "../src/typing.ts";

const empty = { value: "", at: 0 };

test("plain typing inserts at the cursor", () => {
  assert.deepEqual(typed({ value: "ac", at: 1 }, "b"), { field: { value: "abc", at: 2 }, submit: [] });
});

test("text and an Enter in one chunk submits it", () => {
  assert.deepEqual(typed(empty, "print hi in python\r"), {
    field: empty,
    submit: ["print hi in python"],
  });
});

test("the chunk joins what was already typed", () => {
  assert.deepEqual(typed({ value: "print ", at: 6 }, "hi\n").submit, ["print hi"]);
});

test("text after the Enter stays in the field", () => {
  assert.deepEqual(typed(empty, "y\rnext thing"), {
    field: { value: "next thing", at: 10 },
    submit: ["y"],
  });
});

test("two Enters submit twice", () => {
  assert.deepEqual(typed(empty, "a\r\nb\r").submit, ["a", "b"]);
});

test("a paste never submits and flattens its line breaks", () => {
  assert.deepEqual(pasted(empty, "first line\nsecond line\n"), { value: "first line second line", at: 22 });
});

test("a paste lands at the cursor", () => {
  assert.deepEqual(pasted({ value: "ab", at: 1 }, "XY"), { value: "aXYb", at: 3 });
});

test("ctrl-e runs interpreted files and hands compiled ones back as a line to type", async () => {
  const { runnerFor } = await import("../src/shell.ts");
  assert.deepEqual(runnerFor("miner.py"), { cmd: "python3 miner.py" });
  assert.deepEqual(runnerFor("src/my app.js"), { cmd: "node 'src/my app.js'" });
  const cpp = runnerFor("cpp/vector_lab.cpp") as { hint: string };
  assert.match(cpp.hint, /compile it yourself/);
  assert.match(cpp.hint, /\n!g\+\+ -std=c\+\+17 -Wall -o vector_lab cpp\/vector_lab\.cpp && \.\/vector_lab/);
  assert.equal(runnerFor("notes.md"), null);
});

test("! is a shell, never an answer", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand");
  const ran: string[] = [];
  s.onShell = (c) => ran.push(c);
  const reply = s.askQuestion("q?", "");
  s.submit("!g++ main.cpp");
  s.submit("!");
  s.submit("real answer");
  assert.deepEqual(ran, ["g++ main.cpp", ""]);
  assert.equal(await reply, "real answer");
});

test("the input has readline's keys", async () => {
  const { readline } = await import("../src/typing.ts");
  const f = { value: "use a vector here", at: 10 };
  assert.deepEqual(readline("a", f), { value: f.value, at: 0 });
  assert.deepEqual(readline("e", f), { value: f.value, at: 17 });
  assert.deepEqual(readline("u", f), { value: "or here", at: 0 });
  assert.deepEqual(readline("k", f), { value: "use a vect", at: 10 });
  assert.deepEqual(readline("w", { value: "use a vector ", at: 13 }), { value: "use a ", at: 6 });
  assert.equal(readline("g", f), null);
});

test(": commands are dum's, and only the exact words", async () => {
  const { Store } = await import("../src/store.ts");
  const s = new Store("r", "understand");
  let graphs = 0;
  s.onGraph = () => void graphs++;
  const reply = s.askQuestion("q?", "");
  s.submit(":graph");
  s.submit(": log");
  assert.equal(graphs, 1);
  assert.equal(s.getSnapshot().stage.kind, "transcript");
  s.submit(":yes");
  assert.equal(await reply, ":yes");
});

test("mouse reports come out of the input, and nothing else does", async () => {
  const { strip } = await import("../src/mouse.ts");
  assert.deepEqual(strip("\x1b[<65;40;12M"), { rest: "", wheels: [{ x: 40, y: 12, delta: 3 }], held: "" });
  assert.deepEqual(strip("ab\x1b[<64;1;2Mcd").wheels, [{ x: 1, y: 2, delta: -3 }]);
  assert.equal(strip("ab\x1b[<64;1;2Mcd").rest, "abcd");
  // Clicks and releases are dropped, not typed.
  assert.deepEqual(strip("\x1b[<0;5;5M\x1b[<0;5;5m"), { rest: "", wheels: [], held: "" });
  // A report cut in half waits for the rest; a lone escape never waits.
  assert.deepEqual(strip("x\x1b[<65;4"), { rest: "x", wheels: [], held: "\x1b[<65;4" });
  assert.deepEqual(strip("\x1b"), { rest: "", wheels: [], held: "\x1b" }, "held briefly - filtered() lets it go as a key");
  assert.deepEqual(strip("a\x1b["), { rest: "a", wheels: [], held: "\x1b[" });
  assert.equal(strip("\x1b[A").rest, "\x1b[A", "arrow keys pass through");
});

test("a split report is still a report, and a lone escape still arrives as a key", async () => {
  const { filtered, mouse } = await import("../src/mouse.ts");
  const { PassThrough } = await import("node:stream");
  const real = Object.assign(new PassThrough(), { setRawMode() {}, isTTY: true }) as never as NodeJS.ReadStream;
  const f = filtered(real);
  let typed = "";
  f.stdin.on("data", (d: Buffer) => (typed += d.toString()));
  const wheels: unknown[] = [];
  const onWheel = (w: unknown) => wheels.push(w);
  mouse.on("wheel", onWheel);
  (real as never as PassThrough).write("\x1b");
  (real as never as PassThrough).write("[<65;60;12M");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(wheels.length, 1);
  assert.equal(typed, "");
  (real as never as PassThrough).write("\x1b");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(typed, "\x1b");
  mouse.off("wheel", onWheel);
  f.close();
});

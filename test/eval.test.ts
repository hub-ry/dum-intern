import { test } from "node:test";
import assert from "node:assert/strict";
import { Scenario, checks, facts, type Run } from "../src/eval.ts";

const run = (transcript: string, written: Record<string, string> = {}, openHoles = 0): Run => ({ transcript, written, openHoles, timedOut: false });

test("facts: questions before the spec, holes, fills, code dum wrote, reply length", () => {
  const t = [
    "  how does it grow?",
    "  answer it · idk · type it",
    "  > idk",
    "  ╭─ spec ───╮",
    "  build this? [y/N] y",
    "  · Write  vec.cpp",
    "  ▌ hole  vec.cpp: growth  (yours to type)",
    "  ✓ fill  vec.cpp: printing  (a skill you hold)",
    "  vec.cpp compiles.",
    "  your hole: vec.cpp:12",
  ].join("\n");
  const file = "// tiny vector\n#include <cstdio>\nint main() {\n  // TODO(dum): growth\n  // double it\n  return 0;\n}\n";
  const f = facts(run(t, { "vec.cpp": file }));
  assert.equal(f.questions, 1);
  assert.ok(f.specShown);
  assert.equal(f.holes, 1);
  assert.equal(f.fills, 1);
  assert.equal(f.codeLines, 3, "#include, main, } - the hole and its stub don't count");
  assert.equal(f.replyLines, 2);
});

test("checks: expectations and the things dum must never say", () => {
  const s = Scenario.parse({ name: "x", request: "r", expect: { noBuild: true, maxReplyLines: 1 } });
  const bad = checks(s, run("  it's gate-sized\n  and long\n  and longer", { "a.py": "print(1)\n" }));
  const failed = bad.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes("builds nothing"));
  assert.ok(failed.includes("no reply over 1 lines"));
  assert.ok(failed.includes("never names dum's machinery"));
  const good = checks(s, run("  try a vector lab.\n"));
  assert.deepEqual(good.filter((c) => !c.ok), []);
});

test("every scenario file parses", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../scenarios/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    Scenario.parse(JSON.parse(readFileSync(dir + f, "utf8")));
  }
});

test("off dum's own record: what the intern said, not the wizard or the notes", async () => {
  const { fromEntries } = await import("../src/eval.ts");
  const es = [
    { kind: "question", id: 1, question: "how?", why: "because", answer: "idk" },
    { kind: "spec", id: 2, spec: "x", approved: true },
    { kind: "tool", id: 3, name: "hole", detail: "a.py: x", outcome: "held" },
    { kind: "fill", id: 4, path: "a.py", concept: "y", code: "z" },
    { kind: "quip", id: 5, text: "a very long wizard line ".repeat(20), about: "" },
    { kind: "note", id: 6, text: "+ skill: x" },
    { kind: "say", id: 7, text: "a.py runs.\nyour hole: a.py:3" },
  ] as never;
  assert.deepEqual(fromEntries(es), { questions: 1, specShown: true, holes: 1, fills: 1, replyLines: 2 });
});

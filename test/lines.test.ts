// What the terminal shows: prose rendered rather than shown as markdown, code as focused,
// numbered excerpts and diffs, and nothing a shared file or a model writes able to drive the terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown, c, printable, format, inert } from "../src/lines.ts";
import type { Entry } from "../src/store.ts";

const shown = (e: Entry, width = 80) => format(e, width).map(printable);

test("bold renders as bold, not as asterisks", () => {
  const out = markdown("**What:** one file\n- **Files:** main.rs", 60).join("\n");
  assert.ok(!out.includes("**"), out);
  assert.ok(out.includes(c.bold("What:")));
  assert.ok(out.includes(c.bold("Files:")));
});

test("a lone asterisk is left alone", () => {
  assert.equal(markdown("a * b", 60)[0], "a * b");
});

test("fenced code keeps its indentation and loses its fences", () => {
  const out = markdown("Built it:\n```rust\nfn main() {\n    println!(\"hi\");\n}\n```", 60);
  assert.ok(!out.some((l) => l.includes("```")));
  assert.ok(out.includes("  " + c.blue('    println!("hi");')));
});

test("colour codes do not count toward the wrap width", () => {
  // 34 printable columns, over 44 once the two code spans are coloured.
  const out = markdown("- Inclusive range `1..=10`, not `1..11`.", 40);
  assert.equal(out.length, 1, out.join("\n"));
});

test("a heading with inline code keeps the code's case and its colour", () => {
  const [head] = markdown("## add `median(xs)` to stats.py", 60);
  assert.equal(printable(head!), "ADD median(xs) TO STATS.PY");
  assert.ok(!/\[\d+(;\d+)*M/.test(head!), "no uppercased escape codes");
});

test("model ids read the way people say them", async () => {
  const { modelName } = await import("../src/lines.ts");
  assert.equal(modelName("claude-opus-5-5"), "opus 5.5");
  assert.equal(modelName("claude-sonnet-5"), "sonnet 5");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "haiku 4.5");
  assert.equal(modelName("claude-fable-5-1"), "fable 5.1");
  assert.equal(modelName("us.anthropic.claude-x"), "us.anthropic.claude-x");
});

test("a fill shows the code that went in, not just that it happened", async () => {
  const { format } = await import("../src/lines.ts");
  const code = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  const out = format({ kind: "fill", id: 1, path: "a.py", concept: "median", code }, 80).map(printable);
  assert.match(out[0]!, /fill\s+a\.py: median\s+\(a skill you hold\)/);
  assert.equal(out[1], "  │ line 0");
  assert.match(out[out.length - 1]!, /… 3 more in a\.py/);
});

test("a voice reads as model and effort", async () => {
  const { voiceName } = await import("../src/lines.ts");
  assert.equal(voiceName("claude-opus-5-5", "high"), "opus 5.5 · high");
  assert.equal(voiceName("claude-sonnet-5"), "sonnet 5");
  assert.equal(voiceName("", "high"), "");
});

test("sentences keeps the first few, whole", async () => {
  const { sentences } = await import("../src/lines.ts");
  assert.equal(sentences("Correct. You sort twice though. Delete one.", 1), "Correct.");
  assert.equal(sentences("Correct. You sort twice though. Delete one.", 2), "Correct. You sort twice though.");
  assert.equal(sentences("no punctuation at all", 1), "no punctuation at all");
  assert.equal(sentences("s[n // 2] is the middle. ok", 1), "s[n // 2] is the middle.");
});

test("a shared excerpt is numbered from where it starts in the file, and says where the rest is", () => {
  const text = Array.from({ length: 50 }, (_, i) => `row ${i + 10}`).join("\n");
  const out = shown({ kind: "excerpt", id: 1, path: "src/a.py", from: 10, text, by: "you" });
  assert.match(out[0]!, /you shared src\/a\.py:10-59/);
  assert.match(out[1]!, /^10 │ row 10$/);
  assert.ok(out.some((l) => /^49 │ row 49$/.test(l)));
  assert.ok(!out.some((l) => /row 50/.test(l)), "past the cap, the excerpt stops");
  assert.ok(out.some((l) => l.includes(":inspect src/a.py:50-59")));
});

test("a proposed diff carries the file's line numbers and points at its artifact", () => {
  const diff = ["--- a/a.py", "+++ b/a.py", "@@ -3,3 +3,3 @@", " keep", "-old", "+new", " tail"].join("\n");
  const out = shown({ kind: "diff", id: 1, path: "a.py", diff, outcome: "proposed", artifact: ".dum/proposals/1.diff" });
  const rows = out.map((line) => line.trim().replace(/\s+/g, " "));
  assert.ok(rows.includes("3 keep"));
  assert.ok(rows.includes("4 -old"));
  assert.ok(rows.includes("4 +new"));
  assert.ok(rows.includes("5 tail"));
  assert.ok(out.some((line) => line.includes(".dum/proposals/1.diff")));
  assert.ok(!out.some((l) => l.startsWith("+++") || l.startsWith("---")));
});

test("a refused change never shows the code it would have written", () => {
  const out = shown({ kind: "diff", id: 1, path: "core.py", diff: "@@ -0,0 +1 @@\n+def solve(): return 42", outcome: "refused" });
  assert.ok(out.some((l) => l.includes("core.py") && l.includes("refused")));
  assert.ok(!out.join("\n").includes("solve"));
});

test("a long generated block in what dum says is cut short instead of filling the screen", () => {
  const code = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const out = shown({ kind: "say", id: 1, text: `here:\n\`\`\`py\n${code}\n\`\`\`` });
  assert.ok(out.some((l) => l.includes("line19")));
  assert.ok(!out.some((l) => l.includes("line20")));
  assert.ok(out.some((l) => l.includes("10 more lines not shown")));
});

test("escape sequences and control bytes in shared text can't style, retitle or rewrite the terminal", () => {
  const hostile = "ok\x1b[2J\x1b]0;pwned\x07\x1b]52;c;ZXZpbA==\x1b\\\rdum created x\x08\ttab";
  assert.equal(inert(hostile), "okdum created x\ttab");
  const lines = format({ kind: "result", id: 1, label: "git log", output: hostile, code: 0 }, 80).join("\n");
  assert.ok(!lines.includes("\x1b]"));
  assert.ok(!lines.includes("\x1b[2J"));
  assert.ok(!lines.includes("\r"));
  const excerpt = format({ kind: "excerpt", id: 2, path: "a\x1b[31m.py", from: 1, text: "x", by: "dum" }, 80).join("\n");
  assert.ok(!excerpt.includes("\x1b[31m"));
});

test("shared saved changes read as a diff, each file named, numbered by its own hunks", () => {
  const text = [
    "diff --git a/a.py b/a.py",
    "--- a/a.py",
    "+++ b/a.py",
    "@@ -7,1 +7,1 @@",
    "-x = 1",
    "+x = 2",
    "diff --git a/b.py b/b.py",
    "--- a/b.py",
    "+++ b/b.py",
    "@@ -1,0 +1,1 @@",
    "+import os",
  ].join("\n");
  const out = shown({ kind: "excerpt", id: 1, path: "working tree", from: 1, text, by: "you", note: "saved changes" });
  assert.ok(out.some((l) => l.includes("── a.py")));
  assert.ok(out.some((l) => l.includes("── b.py")));
  assert.ok(out.some((l) => /^\s+7 \+x = 2$/.test(l)));
  assert.ok(out.some((l) => /^\s+1 \+import os$/.test(l)));
  assert.ok(!out.some((l) => /│ diff --git/.test(l)), "not shown as numbered source");
});

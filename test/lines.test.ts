// The spec is the one screen that gates anything, so it must read as prose,
// not as markdown source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown, c, slice, printable } from "../src/lines.ts";

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

test("slice keeps the colour in force at its start and closes at its end", () => {
  const styled = "ab" + c.green("cdef") + "gh";
  assert.equal(slice(styled, 0, 2), "ab");
  assert.equal(slice(styled, 3, 5), "\x1b[38;5;108mde\x1b[0m");
  assert.equal(slice(styled, 3, 100), "\x1b[38;5;108mdef\x1b[0mgh");
  assert.equal(slice(styled, 9, 12), "");
  assert.equal(printable(slice(styled, 1, 7)), "bcdefg");
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

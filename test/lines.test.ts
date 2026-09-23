// The spec is the one screen that gates anything, so it must read as prose,
// not as markdown source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown, c } from "../src/lines.ts";

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

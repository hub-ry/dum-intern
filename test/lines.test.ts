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

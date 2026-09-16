// The property that matters is that lines are INDEPENDENT. The code pane shows
// a window onto a file, so a line's colours must start and end on that line -
// otherwise scrolling into the middle of a block comment tints the rest of the
// pane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight, langFor } from "../src/highlight.ts";

const ESC = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ESC, "");

function balanced(line: string) {
  // Every colour opened on a line is closed on the same line.
  let open = 0;
  for (const m of line.match(ESC) ?? []) open += m === "\x1b[0m" ? -1 : 1;
  return open === 0;
}

test("text is preserved exactly", () => {
  const src = 'const x = "hi";\n// note\nfn();\n';
  assert.equal(highlight(src, "a.ts").map(plain).join("\n"), src);
});

test("line count is preserved", () => {
  const src = "a\n\n\nb\n";
  assert.equal(highlight(src, "a.ts").length, src.split("\n").length);
});

test("a block comment closes its colour on every line it crosses", () => {
  const out = highlight("let a = 1;\n/* one\n   two\n   three */\nlet b = 2;", "a.ts");
  for (const [i, line] of out.entries()) assert.ok(balanced(line), `line ${i} leaks: ${JSON.stringify(line)}`);
});

test("a python triple-quoted string closes its colour on every line", () => {
  const out = highlight('x = """\nhello\nworld\n"""\ny = 1', "a.py");
  for (const [i, line] of out.entries()) assert.ok(balanced(line), `line ${i} leaks`);
});

test("an apostrophe in a comment does not tint the rest of the file", () => {
  const out = highlight("# it's fine\nx = 1\ny = 2", "a.py");
  // If the quote had run away, later lines would carry the string colour.
  assert.ok(balanced(out[1]!) && balanced(out[2]!));
  assert.equal(plain(out[2]!), "y = 2");
});

test("an unterminated string stops at the newline", () => {
  const out = highlight('const a = "oops\nconst b = 2;', "a.ts");
  assert.ok(balanced(out[0]!) && balanced(out[1]!));
  assert.equal(plain(out[1]!), "const b = 2;");
});

test("a partially arrived file is fine", () => {
  // This is the normal case for the code pane: the intern is still typing.
  const src = 'export function claim(worker: string) {\n  const now = "';
  assert.doesNotThrow(() => highlight(src, "a.ts"));
  assert.equal(highlight(src, "a.ts").map(plain).join("\n"), src);
});

test("language is chosen by extension, and extensionless files read as shell", () => {
  assert.equal(langFor("src/a.rs"), langFor("b.rs"));
  assert.notEqual(langFor("a.py"), langFor("a.ts"));
  assert.equal(langFor("bin/dum"), langFor("x.sh"));
});

test("keywords, strings and numbers each get their own colour", () => {
  const [line] = highlight('const n = 42;', "a.ts");
  const codes = new Set(line!.match(ESC));
  assert.ok(codes.size >= 3, `expected several colours, got ${[...codes].length}`);
});

test("a template literal keeps its colour across lines", () => {
  const src = "const q = `select *\n  from jobs\n  for update`;\nconst n = 1;";
  const out = highlight(src, "a.ts");
  // `from` and `for` are inside the string, so they must not be keyword-coloured.
  assert.ok(!out[1]!.includes("\x1b[38;5;110m"), "keyword colour leaked into a template literal");
  assert.ok(!out[2]!.includes("\x1b[38;5;110m"), "keyword colour leaked into a template literal");
  // ...but the line after it is real code again.
  assert.ok(out[3]!.includes("\x1b[38;5;110m"), "code after the string lost its colour");
  for (const [i, line] of out.entries()) assert.ok(balanced(line), `line ${i} leaks`);
});

test("a python triple-quoted string spans lines but a plain quote does not", () => {
  const tri = highlight('d = """\nfrom x\n"""\nimport y', "a.py");
  assert.ok(!tri[1]!.includes("\x1b[38;5;110m"), "keyword leaked into a docstring");
  assert.ok(tri[3]!.includes("\x1b[38;5;110m"), "code after the docstring lost its colour");

  const single = highlight("s = 'oops\nimport y", "a.py");
  assert.ok(single[1]!.includes("\x1b[38;5;110m"), "an unclosed quote swallowed the next line");
});

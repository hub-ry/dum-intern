// The extractor is the one piece here that fails quietly: a bug in it shows up
// as a code pane that is subtly truncated or garbled, which looks like the
// model's fault rather than ours. So it gets tested against the ways a stream
// actually stops.

import { test } from "node:test";
import assert from "node:assert/strict";
import { peekString } from "../src/stream.ts";

test("missing key is null, not empty", () => {
  assert.equal(peekString('{"file_path":"a.ts"', "content"), null);
  assert.equal(peekString("", "content"), null);
  assert.equal(peekString('{"content', "content"), null);
  assert.equal(peekString('{"content":', "content"), null);
});

test("empty-so-far is a value, not a miss", () => {
  assert.equal(peekString('{"content":"', "content"), "");
});

test("reads a complete value", () => {
  assert.equal(peekString('{"content":"hello","x":1}', "content"), "hello");
});

test("reads a value that has not finished arriving", () => {
  assert.equal(peekString('{"file_path":"a.ts","content":"const x = 1', "content"), "const x = 1");
});

test("decodes escapes", () => {
  assert.equal(peekString('{"content":"a\\nb\\tc\\"d\\\\e"}', "content"), 'a\nb\tc"d\\e');
  assert.equal(peekString('{"content":"\\u0041\\u00e9"}', "content"), "Aé");
});

test("stops cleanly on a half-arrived escape", () => {
  // The backslash is the last byte of the chunk: it is not a character yet.
  assert.equal(peekString('{"content":"line\\', "content"), "line");
  assert.equal(peekString('{"content":"line\\u00', "content"), "line");
  assert.equal(peekString('{"content":"line\\u004', "content"), "line");
  assert.equal(peekString('{"content":"line\\u0041', "content"), "lineA");
});

test("an escaped quote does not end the value", () => {
  assert.equal(peekString('{"content":"say \\"hi\\" now', "content"), 'say "hi" now');
});

test("does not match the key name inside an earlier value", () => {
  // Edit sends old_string first, and it can contain anything at all.
  const buf = '{"old_string":"content\\":\\"decoy","new_string":"real';
  assert.equal(peekString(buf, "new_string"), "real");
});

test("survives being fed one character at a time", () => {
  const whole = '{"file_path":"a.ts","content":"fn main() {\\n  println!(\\"hi\\");\\n}"}';
  let buf = "";
  const seen: string[] = [];
  for (const ch of whole) {
    buf += ch;
    const v = peekString(buf, "content");
    if (v !== null) seen.push(v);
  }
  // Monotonic: a live view must never show text it then takes back.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(
      seen[i]!.startsWith(seen[i - 1]!) || seen[i - 1]!.startsWith(seen[i]!),
      `not monotonic at ${i}: ${JSON.stringify(seen[i - 1])} -> ${JSON.stringify(seen[i])}`,
    );
  }
  assert.equal(seen[seen.length - 1], 'fn main() {\n  println!("hi");\n}');
});

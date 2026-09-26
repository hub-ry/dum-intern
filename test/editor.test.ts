// The buffer, driven by keys, with no terminal.
//
// The cases are the ones that bit while building it: a cursor that sails
// past the end of a line, an undo that forgets where it was, a search that
// finds the match under the cursor and calls it the next one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { open, press, paste, text, dirty, saved, key, scroll, type Buf, type View } from "../src/editor.ts";

const view: View = { rows: 10, cols: 40 };

/** Type a string one key at a time, with <esc>, <cr>, <bs> and <c-x> spelled out. */
function type(b: Buf, keys: string): { buf: Buf; effects: string[] } {
  const effects: string[] = [];
  const parts = keys.match(/<[^>]+>|./gs) ?? [];
  for (const p of parts) {
    let r;
    if (p === "<esc>") r = press(b, "", key({ escape: true }), view);
    else if (p === "<cr>") r = press(b, "", key({ return: true }), view);
    else if (p === "<bs>") r = press(b, "", key({ backspace: true }), view);
    else if (p === "<del>") r = press(b, "", key({ delete: true }), view);
    else if (p === "<tab>") r = press(b, "", key({ tab: true }), view);
    else if (p === "<down>") r = press(b, "", key({ downArrow: true }), view);
    else if (p === "<up>") r = press(b, "", key({ upArrow: true }), view);
    else if (p === "<end>") r = press(b, "", key({ end: true }), view);
    else if (p.startsWith("<c-")) r = press(b, p[3]!, key({ ctrl: true }), view);
    else r = press(b, p, key({ shift: /[A-Z]/.test(p) }), view);
    b = r.buf;
    effects.push(...r.effects);
  }
  return { buf: b, effects };
}

const at = (b: Buf) => `${b.row}:${b.col}`;

test("a trailing newline survives a round trip, and its absence does too", () => {
  assert.equal(text(open("a\nb\n")), "a\nb\n");
  assert.equal(text(open("a\nb")), "a\nb");
  assert.deepEqual(open("a\nb\n").lines, ["a", "b"]);
  assert.deepEqual(open("").lines, [""]);
});

test("j/k remember the column across a short line", () => {
  const b = open("a long line\n\nanother long line");
  const r = type(b, "$jj").buf;
  assert.equal(at(r), "2:10");
});

test("the cursor never sits past the end of a line in normal mode", () => {
  const b = open("abc\nde");
  assert.equal(at(type(b, "$").buf), "0:2");
  assert.equal(at(type(b, "$j").buf), "1:1");
  assert.equal(at(type(b, "lllll").buf), "0:2");
});

test("gg and G go to the ends, and a half-typed g goes nowhere", () => {
  const b = open("one\ntwo\nthree");
  assert.equal(at(type(b, "G").buf), "2:0");
  assert.equal(at(type(b, "Ggg").buf), "0:0");
  // `gj` is not `j`.
  assert.equal(at(type(b, "gj").buf), "0:0");
});

test("w and b step over words and across lines", () => {
  const b = open("foo.bar baz\n\nqux");
  const w1 = type(b, "w").buf;
  assert.equal(at(w1), "0:3");
  assert.equal(at(type(w1, "w").buf), "0:4");
  assert.equal(at(type(w1, "ww").buf), "0:8");
  // The empty line is a stop, then qux.
  assert.equal(at(type(w1, "www").buf), "1:0");
  assert.equal(at(type(w1, "wwww").buf), "2:0");
  // Back over qux: the empty line is a stop that way too, then baz.
  assert.equal(at(type(w1, "wwwwb").buf), "1:0");
  assert.equal(at(type(w1, "wwwwbb").buf), "0:8");
});

test("i types at the cursor and esc steps back onto the last typed char", () => {
  const r = type(open("ac"), "lib<esc>");
  assert.equal(text(r.buf), "abc");
  assert.equal(r.buf.mode, "normal");
  assert.equal(at(r.buf), "0:1");
});

test("a and A append, o and O open lines with the indent kept", () => {
  assert.equal(text(type(open("ab"), "aX<esc>").buf), "aXb");
  assert.equal(text(type(open("ab"), "AX<esc>").buf), "abX");
  assert.equal(text(type(open("  ab"), "oX<esc>").buf), "  ab\n  X");
  assert.equal(text(type(open("  ab"), "OX<esc>").buf), "  X\n  ab");
});

test("Enter in insert mode carries the indent", () => {
  const r = type(open("  if x {}"), "$i<cr>y<esc>").buf;
  assert.equal(text(r), "  if x {\n  y}");
});

test("backspace joins lines at the start of one, delete joins at the end", () => {
  assert.equal(text(type(open("ab\ncd"), "ji<bs><esc>").buf), "abcd");
  assert.equal(text(type(open("ab\ncd"), "A<del><esc>").buf), "abcd");
  assert.equal(text(type(open("abc"), "A<bs><bs><esc>").buf), "a");
});

test("an Enter inside a typed chunk is a line break", () => {
  const r = press(open(""), "one\rtwo", key({}), view).buf;
  assert.equal(r.mode, "normal");
  // Not in insert mode: the chunk is ignored, since none of it is a command.
  assert.equal(text(r), "");
  const ins = type(open(""), "i").buf;
  assert.equal(text(press(ins, "one\rtwo", key({}), view).buf), "one\ntwo");
});

test("x, dd, D and J edit in place", () => {
  assert.equal(text(type(open("abc"), "lx").buf), "ac");
  assert.equal(text(type(open("a\nb\nc"), "jdd").buf), "a\nc");
  assert.equal(text(type(open("only"), "dd").buf), "");
  assert.equal(text(type(open("abcdef"), "llD").buf), "ab");
  assert.equal(text(type(open("a {\n  b\n}"), "J").buf), "a { b\n}");
});

test("dd and yy fill the register, p and P put it", () => {
  const b = open("one\ntwo");
  assert.equal(text(type(b, "ddp").buf), "two\none");
  assert.equal(text(type(b, "yyP").buf), "one\none\ntwo");
  assert.equal(type(b, "p").buf.message, "nothing to put - dd or yy first");
});

test("undo puts the text and the cursor back; redo re-applies", () => {
  const b = open("hello world");
  const edited = type(b, "wiBIG <esc>").buf;
  assert.equal(text(edited), "hello BIG world");
  const undone = type(edited, "u").buf;
  assert.equal(text(undone), "hello world");
  assert.equal(at(undone), "0:6");
  assert.equal(text(type(undone, "<c-r>").buf), "hello BIG world");
  assert.equal(type(b, "u").buf.message, "already at oldest change");
});

test("one insert session is one undo step", () => {
  const r = type(open(""), "iabc<cr>def<esc>u").buf;
  assert.equal(text(r), "");
});

test("dirty is about identity with what was saved, so undo can clean it", () => {
  const b = open("x");
  assert.equal(dirty(b), false);
  const e = type(b, "ay<esc>").buf;
  assert.equal(dirty(e), true);
  assert.equal(dirty(type(e, "u").buf), false);
  assert.equal(dirty(saved(e)), false);
});

test(":w saves, :q leaves, :wq does both, :e reloads", () => {
  assert.deepEqual(type(open("x"), ":w<cr>").effects, ["save"]);
  assert.deepEqual(type(open("x"), ":q<cr>").effects, ["leave"]);
  assert.deepEqual(type(open("x"), ":wq<cr>").effects, ["save", "leave"]);
  assert.deepEqual(type(open("x"), ":e<cr>").effects, ["reload"]);
  assert.deepEqual(type(open("x"), "<c-s>").effects, ["save"]);
  assert.deepEqual(type(open("x"), "i<c-s>").effects, ["save"]);
  assert.equal(type(open("x"), ":nope<cr>").buf.message, "not a command: nope");
});

test(":<n> goes to a line, clamped", () => {
  const b = open("a\n  b\nc\nd");
  assert.equal(at(type(b, ":2<cr>").buf), "1:2");
  assert.equal(at(type(b, ":99<cr>").buf), "3:0");
  assert.equal(at(type(b, "G:$<cr>").buf), "3:0");
});

test("esc leaves from normal mode and cancels a chord or a command", () => {
  assert.deepEqual(type(open("x"), "<esc>").effects, ["leave"]);
  assert.deepEqual(type(open("x"), "g<esc>").effects, []);
  const r = type(open("x"), ":wq<esc>");
  assert.deepEqual(r.effects, []);
  assert.equal(r.buf.cmd, null);
});

test("/ finds the next match, wraps, and n and N repeat", () => {
  const b = open("foo\nbar foo\nFoo");
  const r = type(b, "/foo<cr>").buf;
  assert.equal(at(r), "1:4");
  // Smart case: lowercase pattern matches Foo too.
  assert.equal(at(type(r, "n").buf), "2:0");
  const wrapped = type(r, "nn").buf;
  assert.equal(at(wrapped), "0:0");
  assert.equal(wrapped.message, "search hit bottom, continuing at top");
  assert.equal(at(type(r, "N").buf), "0:0");
  assert.equal(type(b, "/zzz<cr>").buf.message, "not found: zzz");
  // Capitals mean it.
  assert.equal(at(type(b, "/Foo<cr>").buf), "2:0");
});

test("a read-only buffer refuses edits and says why", () => {
  const b = open("x", { readOnly: "still being written" });
  const r = type(b, "ix");
  assert.equal(text(r.buf), "x");
  assert.equal(r.buf.message, "read only - still being written");
  assert.equal(text(type(b, "dd").buf), "x");
  // Reading still works.
  assert.equal(at(type(open("a\nb", { readOnly: "x" }), "j").buf), "1:0");
});

test("paste lands at the cursor in either mode and keeps its line breaks", () => {
  const n = paste(type(open("ab"), "l").buf, "X\nY");
  assert.equal(text(n), "aX\nYb");
  assert.equal(n.mode, "normal");
  assert.equal(text(type(n, "u").buf), "ab");
  const i = paste(type(open("ab"), "i").buf, "1\r\n2");
  assert.equal(text(i), "1\n2ab");
});

test("scrolling follows the cursor with a margin and never past the end", () => {
  const b = open(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
  const down = type(b, "jjjjjjjjjjjj").buf; // row 12
  assert.equal(down.row, 12);
  assert.equal(down.top, 12 - 10 + 1 + 3);
  const end = type(b, "G").buf;
  assert.equal(end.top, 40);
  const back = type(end, "gg").buf;
  assert.equal(back.top, 0);
  // A smaller window after a resize still shows the cursor.
  assert.equal(scroll(end, { rows: 5, cols: 40 }).top, 45);
});

test("a long line scrolls sideways under the cursor, tabs counting two", () => {
  const b = open("\t" + "x".repeat(100));
  const r = type(b, "$").buf;
  assert.equal(r.left, 102 - 40);
  assert.equal(type(r, "0").buf.left, 0);
});

test("tab in insert mode is two spaces", () => {
  assert.equal(text(type(open(""), "i<tab>x<esc>").buf), "  x");
});

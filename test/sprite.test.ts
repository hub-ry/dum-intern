// The art is hand-edited text, so its failure mode is silent: an undefined
// character renders as transparent, which is a hole in a face rather than an
// error. These are the checks a person cannot do by eye on 18 rows of dots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { load, parse, framesFor, draw } from "../src/sprite.ts";

const ART = new URL("../src/art/", import.meta.url).pathname;
const files = readdirSync(ART).filter((f) => f.endsWith(".txt"));

test("there is art to load", () => {
  assert.ok(files.length >= 2, "expected an intern and a wizard");
});

for (const file of files) {
  test(`${file}: every pixel is a colour the palette defines`, () => {
    const sprite = load(ART + file);
    for (const frame of sprite.frames) {
      for (const [y, row] of frame.rows.entries()) {
        for (const [x, ch] of [...row].entries()) {
          assert.ok(
            sprite.palette.has(ch),
            `${frame.name} row ${y} col ${x}: '${ch}' is not in the palette`,
          );
        }
      }
    }
  });

  test(`${file}: frames are rectangular and all the same size`, () => {
    const sprite = load(ART + file);
    const [first, ...rest] = sprite.frames;
    assert.ok(first, "no frames");
    const w = first.rows[0]!.length;
    const h = first.rows.length;
    assert.equal(h % 2, 0, "an odd number of rows leaves a half-drawn cell row");
    for (const frame of [first, ...rest]) {
      assert.equal(frame.rows.length, h, `${frame.name} is a different height`);
      for (const [y, row] of frame.rows.entries()) {
        assert.equal(row.length, w, `${frame.name} row ${y} is ${row.length}, want ${w}`);
      }
    }
  });

  test(`${file}: draws to half the rows, at full width`, () => {
    const sprite = load(ART + file);
    const frame = framesFor(sprite, sprite.frames[0]!.name)[0]!;
    const rows = draw(sprite, frame);
    assert.equal(rows.length, frame.rows.length / 2);
    const visible = rows[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal([...visible].length, frame.rows[0]!.length);
  });
}

test("parser keeps blank rows inside a frame but trims trailing ones", () => {
  const s = parse("palette\n. none\nx ff0000\nend\n\nframe a\nxx\n..\nxx\n\n\n");
  assert.deepEqual(s.frames[0]!.rows, ["xx", "..", "xx"]);
});

test("a state picks up its variant frames", () => {
  const s = parse("palette\n. none\nend\nframe idle\n..\nframe idle.blink\n..\nframe talking\n..");
  assert.deepEqual(framesFor(s, "idle").map((f) => f.name), ["idle", "idle.blink"]);
  assert.deepEqual(framesFor(s, "talking").map((f) => f.name), ["talking"]);
});

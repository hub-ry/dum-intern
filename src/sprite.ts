// Pixel art, in a terminal.

import { readFileSync } from "node:fs";
import { parse, type Frame, type Sprite } from "./art-parser.ts";

export { parse, framesFor, type Frame, type Sprite } from "./art-parser.ts";

// Half-block glyphs.
const UPPER = "\u2580";
const LOWER = "\u2584";

export function load(path: string): Sprite {
  return parse(readFileSync(path, "utf8"));
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** One frame as terminal rows, each already carrying its escape codes. */
export function draw(sprite: Sprite, frame: Frame): string[] {
  const width = Math.max(...frame.rows.map((r) => r.length), 0);
  const out: string[] = [];
  for (let y = 0; y < frame.rows.length; y += 2) {
    let line = "";
    let fg: string | null | undefined;
    let bg: string | null | undefined;
    for (let x = 0; x < width; x++) {
      const top = sprite.palette.get(frame.rows[y]?.[x] ?? ".") ?? null;
      const bottom = sprite.palette.get(frame.rows[y + 1]?.[x] ?? ".") ?? null;

      let glyph = " ";
      let wantFg: string | null = null;
      let wantBg: string | null = null;
      if (top && bottom) {
        glyph = UPPER;
        wantFg = top;
        wantBg = bottom;
      } else if (top) {
        glyph = UPPER;
        wantFg = top;
      } else if (bottom) {
        glyph = LOWER;
        wantFg = bottom;
      }

      // Only emit a colour when it changes.
      if (wantFg !== fg) {
        line += wantFg ? `\x1b[38;2;${rgb(wantFg).join(";")}m` : "\x1b[39m";
        fg = wantFg;
      }
      if (wantBg !== bg) {
        line += wantBg ? `\x1b[48;2;${rgb(wantBg).join(";")}m` : "\x1b[49m";
        bg = wantBg;
      }
      line += glyph;
    }
    out.push(line + "\x1b[0m");
  }
  return out;
}


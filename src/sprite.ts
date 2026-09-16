// Pixel art, in a terminal.
//
// A cell is two pixels: `▀` painted with a foreground for the top half and a
// background for the bottom. So a 9x8 sprite is 9 columns by 4 rows, which is
// a character small enough to sit in a side pane and still read as a face.
//
// The art lives in .txt files rather than in here. They are meant to be
// redrawn - the two characters ARE the personality of this program, and that
// should not require touching TypeScript or a binary asset pipeline.

import { readFileSync } from "node:fs";

export type Frame = { name: string; rows: string[] };
export type Sprite = { palette: Map<string, string | null>; frames: Frame[] };

// Half-block glyphs. Which one a cell uses depends on which of its two pixels
// are actually there:
//
//   both        ▀  foreground is the top pixel, background is the bottom
//   top only    ▀  foreground is the top pixel, background left alone
//   bottom only ▄  foreground is the bottom pixel, background left alone
//   neither     ' ' nothing is painted at all
//
// Getting that last pair wrong is what puts a slab behind a sprite: drawing ▀
// with no foreground set still paints an upper half-block in whatever the
// terminal's default text colour is, so every transparent cell comes out as a
// grey bar and the character appears to be sitting on a card.
const UPPER = "\u2580";
const LOWER = "\u2584";

/**
 * Parse the art format:
 *
 *   palette
 *   . none
 *   o 1a1a22
 *   end
 *
 *   frame idle
 *   ..oooo..
 *   ...
 *
 * Blank lines inside a frame are significant - a sprite can have an empty row -
 * so a frame ends at the next `frame` header or at the end of the file, and
 * trailing blank rows are trimmed rather than guessed at.
 */
export function parse(text: string): Sprite {
  const palette = new Map<string, string | null>();
  const frames: Frame[] = [];
  let mode: "none" | "palette" | "frame" = "none";
  let current: Frame | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;

    if (trimmed === "palette") {
      mode = "palette";
      continue;
    }
    if (trimmed === "end" && mode === "palette") {
      mode = "none";
      continue;
    }
    if (mode === "palette") {
      if (!trimmed) continue;
      const ch = line[0]!;
      const hex = trimmed.slice(1).trim().toLowerCase();
      palette.set(ch, hex === "none" ? null : hex);
      continue;
    }
    const head = /^frame\s+(\S+)$/.exec(trimmed);
    if (head) {
      current = { name: head[1]!, rows: [] };
      frames.push(current);
      mode = "frame";
      continue;
    }
    if (mode === "frame" && current) current.rows.push(line);
  }

  for (const f of frames) while (f.rows.length && !f.rows[f.rows.length - 1]!.trim()) f.rows.pop();
  return { palette, frames };
}

export function load(path: string): Sprite {
  return parse(readFileSync(path, "utf8"));
}

/** The frames belonging to a state: `idle` plus any `idle.something`. */
export function framesFor(sprite: Sprite, state: string): Frame[] {
  const hit = sprite.frames.filter((f) => f.name === state || f.name.startsWith(state + "."));
  return hit.length ? hit : sprite.frames.slice(0, 1);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * One frame as terminal rows, each already carrying its escape codes.
 *
 * Emitted as pre-composed strings rather than as nested colour components:
 * a 9-wide sprite is 9 separately coloured cells per row, and expressing
 * that as elements costs far more than it buys when the whole thing is a
 * single `<Text>` either way.
 */
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

      // Only emit a colour when it changes. A sprite is mostly flat areas, and
      // repeating the same truecolor pair per cell quadruples the bytes Ink
      // has to diff on every animation tick.
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


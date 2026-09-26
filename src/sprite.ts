// Pixel art, in a terminal.

import { readFileSync } from "node:fs";

export type Frame = { name: string; rows: string[] };
export type Sprite = { palette: Map<string, string | null>; frames: Frame[] };

// Half-block glyphs.
const UPPER = "\u2580";
const LOWER = "\u2584";

/** Parse the art format. Blank rows inside a frame are significant; trailing ones are trimmed. */
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


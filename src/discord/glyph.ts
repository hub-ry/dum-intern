// Dum's authored pixel glyph as a PNG, for the bot's avatar and Discord art. Reads the same
// sprite file the rest of Dum draws from and encodes the PNG by hand, so no image tools needed.

import { readFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { join } from "node:path";

export type Sprite = { palette: Map<string, [number, number, number] | null>; frames: Map<string, string[]> };

export const SPRITE_PATH = join(import.meta.dirname, "..", "art", "intern.txt");

export function parseSprite(text: string): Sprite {
  const palette = new Map<string, [number, number, number] | null>();
  const frames = new Map<string, string[]>();
  let section: "none" | "palette" | "frame" = "none";
  let frame: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("#")) continue;
    if (line === "palette") section = "palette";
    else if (line === "end") section = "none";
    else if (line.startsWith("frame ")) {
      section = "frame";
      frame = [];
      frames.set(line.slice(6).trim(), frame);
    } else if (!line) {
      if (section === "frame") section = "none";
    } else if (section === "palette") {
      const [key, value] = line.split(/\s+/);
      palette.set(key!, value === "none" ? null : [parseInt(value!.slice(0, 2), 16), parseInt(value!.slice(2, 4), 16), parseInt(value!.slice(4, 6), 16)]);
    } else if (section === "frame") frame.push(line);
  }
  return { palette, frames };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A square PNG: the frame scaled up with crisp pixels, centered on a solid background. */
export function renderPng(sprite: Sprite, frameName: string, size: number, background: [number, number, number]): Buffer {
  const rows = sprite.frames.get(frameName);
  if (!rows?.length) throw new Error(`no frame ${frameName}`);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const scale = Math.floor((size * 0.62) / Math.max(w, h));
  const ox = Math.floor((size - w * scale) / 2);
  const oy = Math.floor((size - h * scale) / 2);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - ox) / scale);
      const gy = Math.floor((y - oy) / scale);
      const inside = x >= ox && y >= oy && gx < w && gy < h;
      const color = inside ? sprite.palette.get(rows[gy]![gx] ?? ".") ?? null : null;
      const [r, g, b] = color ?? background;
      raw.set([r, g, b, 255], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The avatar: the idle frame on Dum's dusk background. */
export function avatarPng(size = 512): Buffer {
  return renderPng(parseSprite(readFileSync(SPRITE_PATH, "utf8")), "idle", size, [0x1c, 0x17, 0x2b]);
}

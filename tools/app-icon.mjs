// Dum's app icon: the idle portrait on a rounded dark tile, encoded as PNG with no image tooling.
// Laid out on a 1024 grid and scaled, so every size is the same picture.
import { deflateSync } from 'node:zlib';

export function appIconPng(sprite, size = 1024) {
  const frame = sprite.frames.find(frame => frame.name === 'idle');
  if (!frame) throw new Error('Dum has no idle portrait');
  const colors = Object.fromEntries([...sprite.palette].map(([key, hex]) => [key, hex ? [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) : null]));
  const k = size / 1024;
  const radius = 200 * k, far = 823 * k, top = 176 * k, left = 232 * k, cell = 80 * k;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cornerX = Math.max(radius - x, x - far, 0);
      const cornerY = Math.max(radius - y, y - far, 0);
      const at = y * (size * 4 + 1) + 1 + x * 4;
      if (cornerX * cornerX + cornerY * cornerY > radius * radius) continue;
      const row = Math.floor((y - top) / cell);
      const col = Math.floor((x - left) / cell);
      const color = colors[frame.rows[row]?.[col]];
      pixels[at] = color?.[0] ?? 25;
      pixels[at + 1] = color?.[1] ?? 23;
      pixels[at + 2] = color?.[2] ?? 33;
      pixels[at + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  crcTable[i] = crc;
}

function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  out.write(type, 4, 4, 'ascii');
  bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (let at = 4; at < out.length - 4; at++) crc = (crc >>> 8) ^ crcTable[(crc ^ out[at]) & 255];
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

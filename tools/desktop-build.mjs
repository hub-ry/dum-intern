import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { deflateSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.desktop.json'], { stdio: 'inherit' });
await Promise.all([
  cp('src/trees', 'dist/trees', { recursive: true }),
  cp('src/art', 'dist/art', { recursive: true }),
  cp('src/desktop/ui/index.html', 'dist/desktop/ui/index.html'),
  cp('src/desktop/ui/style.css', 'dist/desktop/ui/style.css'),
  build({ entryPoints: ['src/desktop/preload.ts'], outfile: 'dist/desktop/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' }),
  build({ entryPoints: ['src/desktop/ui/renderer.ts'], outfile: 'dist/desktop/ui/renderer.js', bundle: true, platform: 'browser', format: 'iife', loader: { '.txt': 'text' }, target: 'chrome144' }),
]);
await rm('dist/desktop/preload.js', { force: true });

// Reuse Dum's original portrait for the app icon. PNG generation needs no image tooling.
const { parse } = await import('../dist/sprite.js');
const sprite = parse(await readFile('src/art/intern.txt', 'utf8'));
const frame = sprite.frames.find(frame => frame.name === 'idle');
if (!frame) throw new Error('Dum has no idle portrait');
const colors = Object.fromEntries([...sprite.palette].map(([key, hex]) => [key, hex ? [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) : null]));
const size = 1024;
const pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const cornerX = Math.max(200 - x, x - 823, 0);
    const cornerY = Math.max(200 - y, y - 823, 0);
    const at = y * (size * 4 + 1) + 1 + x * 4;
    if (cornerX * cornerX + cornerY * cornerY > 200 * 200) continue;
    const row = Math.floor((y - 176) / 80);
    const col = Math.floor((x - 232) / 80);
    const color = colors[frame.rows[row]?.[col]];
    pixels[at] = color?.[0] ?? 25;
    pixels[at + 1] = color?.[1] ?? 23;
    pixels[at + 2] = color?.[2] ?? 33;
    pixels[at + 3] = 255;
  }
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
const header = Buffer.alloc(13);
header.writeUInt32BE(size);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
await mkdir('build', { recursive: true });
await writeFile('build/icon.png', png);
await writeFile('dist/desktop/icon.png', png);
if (process.platform === 'darwin') {
  await mkdir('build/icon.iconset', { recursive: true });
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('/usr/bin/sips', ['-z', String(points * scale), String(points * scale), 'build/icon.png', '--out', `build/icon.iconset/icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns'], { stdio: 'inherit' });
}
console.log('Desktop compiled with local renderer, curriculum, portraits and app icon.');

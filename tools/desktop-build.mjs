import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { appIconPng } from './app-icon.mjs';

await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.desktop.json'], { stdio: 'inherit' });
await Promise.all([
  cp('src/trees', 'dist/trees', { recursive: true }),
  cp('src/art', 'dist/art', { recursive: true }),
  cp('src/desktop/ui/index.html', 'dist/desktop/ui/index.html'),
  cp('src/desktop/ui/style.css', 'dist/desktop/ui/style.css'),
  cp('src/desktop/ui/circle.css', 'dist/desktop/ui/circle.css'),
  ...['preload', 'circle-preload', 'bubble-preload'].map((name) =>
    build({ entryPoints: [`src/desktop/${name}.ts`], outfile: `dist/desktop/${name}.cjs`, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })),
  build({ entryPoints: ['src/desktop/ui/renderer.ts'], outfile: 'dist/desktop/ui/renderer.js', bundle: true, platform: 'browser', format: 'iife', loader: { '.txt': 'text' }, target: 'chrome144' }),
]);
// tsc also emitted each preload as an ES module; only the bundled .cjs is loaded.
await Promise.all(['preload', 'circle-preload', 'bubble-preload'].map((name) => rm(`dist/desktop/${name}.js`, { force: true })));

// Reuse Dum's original portrait for the app icon.
const { parse } = await import('../dist/art-parser.js');
const png = appIconPng(parse(await readFile('src/art/intern.txt', 'utf8')));
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
console.log('Desktop compiled with renderer, curriculum, portraits and app icon.');

// Writes the site's favicon from the same renderer as the desktop app icon.
// Run after changing src/art/intern.txt:  npm run site:favicon
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from '../src/sprite.ts';
import { appIconPng } from './app-icon.mjs';

// 256 keeps the 1024 layout on whole pixels: each art pixel is exactly 20px.
await writeFile('src/site/favicon.png', appIconPng(parse(await readFile('src/art/intern.txt', 'utf8')), 256));
console.log('wrote src/site/favicon.png');

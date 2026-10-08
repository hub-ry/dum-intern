// Add a build recording to /builds:  npm run site:add-build -- <youtube link> "<title>" ["<note>"]
// Then commit src/site/builds.json and deploy.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseBuilds, youtubeId } from '../src/web/builds.ts';

const FILE = new URL('../src/site/builds.json', import.meta.url);
const [link, title, note] = process.argv.slice(2);
const id = link ? youtubeId(link) : null;
if (!id || !title?.trim()) {
  console.error('usage: npm run site:add-build -- <youtube link> "<title>" ["<note>"]');
  process.exit(2);
}
const builds = parseBuilds(readFileSync(FILE, 'utf8'));
if (builds.some((b) => b.youtube === id)) {
  console.error(`that video is already on /builds`);
  process.exit(1);
}
const entry = { title: title.trim(), youtube: id, date: new Date().toISOString().slice(0, 10), ...(note?.trim() ? { note: note.trim() } : {}) };
// Validate the whole list with the new entry before writing, so a bad title can't break the site.
const next = parseBuilds(JSON.stringify([entry, ...builds]));
writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
console.log(`added "${entry.title}" (${id}) to src/site/builds.json`);

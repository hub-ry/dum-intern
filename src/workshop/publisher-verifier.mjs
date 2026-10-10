import { chromium } from '/opt/workshop/node_modules/playwright/index.mjs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const TESTID = /^[a-z][a-z0-9-]{0,48}$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(() => { console.error('verifier timed out'); process.exit(1); }, 80_000).unref();

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) return undefined;
    await sleep(50);
  }
}

async function main() {
  const html = await readFile('/creation/demo.html', 'utf8');
  if (html.length > 200000) fail('source too large');
  const manifest = JSON.parse(await readFile('/creation/.verify.json', 'utf8'));
  if (typeof manifest.nonce !== 'string' || !Array.isArray(manifest.panels) || manifest.panels.length < 3 || manifest.panels.length > 8) fail('bad manifest');
  const sourceHash = sha(html);
  if (manifest.sourceHash !== sourceHash) fail('source hash mismatch');

  const problems = [];
  const check = () => { if (problems.length) fail(problems.slice(0, 5).join('; ')); };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const freshPage = async () => {
      const ctx = await browser.newContext({
        offline: true, serviceWorkers: 'block', acceptDownloads: false, permissions: [],
        viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(5000);
      await page.route('**/*', (route) => { problems.push('request ' + route.request().url().slice(0, 100)); route.abort().catch(() => {}); });
      page.on('request', (r) => problems.push('request attempt ' + r.url().slice(0, 100)));
      page.on('pageerror', (e) => problems.push('pageerror ' + String(e.message).slice(0, 200)));
      page.on('console', (message) => { if (message.type() === 'error') problems.push('console error'); });
      page.on('popup', () => problems.push('popup'));
      page.on('dialog', (d) => { problems.push('dialog'); d.dismiss().catch(() => {}); });
      await page.setContent(html, { waitUntil: 'load' });
      await sleep(100);
      return page;
    };

    const observe = async (page, testid) => {
      if (!TESTID.test(testid)) fail('bad test id');
      const loc = page.locator(`[data-testid="${testid}"]`);
      if ((await loc.count()) !== 1) fail(`test id ${testid} must match exactly one element`);
      await loc.scrollIntoViewIfNeeded();
      const r = await loc.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 'zero size';
        if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return 'outside viewport';
        for (let n = el; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility !== 'visible' || parseFloat(s.opacity) <= 0) return 'hidden by ancestor style';
        }
        const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        if (!hit || !(hit === el || el.contains(hit))) return 'obscured';
        const text = (el.innerText ?? el.textContent ?? '').trim();
        if (text.length > 2000) return 'text too long';
        return { text };
      });
      if (typeof r === 'string') fail(`${testid}: ${r}`);
      return { loc, text: r.text };
    };

    const a = await freshPage();
    const b = await freshPage();
    check();
    const captureOptions = { type: 'png', animations: 'disabled', caret: 'hide' };
    const initialSha256 = sha(await a.screenshot(captureOptions));
    if (initialSha256 !== sha(await b.screenshot(captureOptions))) fail('initial render is nondeterministic');
    await b.context().close();

    let changed = 0;
    const panels = [];
    for (let i = 0; i < manifest.panels.length; i++) {
      const p = manifest.panels[i];
      const acts = Array.isArray(p.actions) ? p.actions : [];
      if (acts.length > 4 || typeof p.expected !== 'string') fail('bad panel');
      if (i === 0 && acts.length) fail('first panel must have no actions');
      const actions = [];
      for (const act of acts) {
        if (act.kind !== 'click' && act.kind !== 'fill') fail('bad action kind');
        const before = await observe(a, p.observe);
        if (before.text !== act.expectedBefore) fail(`panel ${i + 1}: pre-action output does not match expectedBefore`);
        const beforeHash = sha(await before.loc.screenshot(captureOptions));
        const target = await observe(a, act.target);
        if (act.kind === 'click') await target.loc.click();
        else await target.loc.fill(String(act.value ?? '').slice(0, 500));
        const after = await waitFor(async () => { const o = await observe(a, p.observe); return o.text === act.expectedAfter && o.text !== before.text ? o : undefined; }, 5000);
        if (!after) fail(`panel ${i + 1}: ${act.kind} ${act.target} did not produce expectedAfter on ${p.observe}`);
        const afterHash = sha(await after.loc.screenshot(captureOptions));
        if (afterHash === beforeHash) fail(`panel ${i + 1}: ${act.target} changed text but not rendering`);
        check();
        changed++;
        actions.push({ kind: act.kind, target: act.target, before: before.text, after: after.text, beforeHash, afterHash });
      }
      const final = await waitFor(async () => { const o = await observe(a, p.observe); return o.text === p.expected ? o : undefined; }, 5000);
      if (!final) {
        const o = await observe(a, p.observe);
        fail(`panel ${i + 1}: expected ${JSON.stringify(p.expected.slice(0, 200))} but ${p.observe} shows ${JSON.stringify(o.text.slice(0, 200))}`);
      }
      const image = `panel-${i + 1}.png`;
      const png = await a.screenshot({ ...captureOptions, fullPage: false });
      await writeFile('/captures/' + image, png);
      check();
      panels.push({ actual: final.text, actions, image, sha256: sha(png) });
    }
    if (!changed) fail('no action changed observed text');
    await writeFile('/captures/report.json', JSON.stringify({ ok: true, nonce: manifest.nonce, sourceHash, initialSha256, panels }));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then(() => process.exit(0), (e) => { console.error(String(e && e.message ? e.message : e).slice(0, 2000)); process.exit(1); });

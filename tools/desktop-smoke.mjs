// Exercises the installed Electron app with a clean private profile. No model or account login.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { inflateSync } from 'node:zlib';

const fixture = await mkdtemp(join(tmpdir(), 'dum-desktop-smoke-'));
const project = join(fixture, 'sample-project');
const profile = join(fixture, 'desktop');
const output = resolve(process.env.DUM_SMOKE_OUTPUT || 'release/desktop-smoke');
await Promise.all([mkdir(project), mkdir(profile), mkdir(join(fixture, 'home')), mkdir(output, { recursive: true })]);
execFileSync('git', ['init', '-q', project]);
await writeFile(join(project, 'counter.py'), 'counter = 0\nprint(counter)\n');
const settings = { hotkey: 'CommandOrControl+Shift+D', alwaysOnTop: true, allWorkspaces: true, launchAtLogin: false, personalContext: false };
await writeFile(join(profile, 'settings.json'), JSON.stringify({ version: 1, settings, recent: [project], companion: null }), { mode: 0o600 });
const executable = process.env.DUM_SMOKE_EXECUTABLE
  ? resolve(process.env.DUM_SMOKE_EXECUTABLE)
  : (await import('electron')).default;
const development = !process.env.DUM_SMOKE_EXECUTABLE;
const checks = [];
const windows = {};
const record = label => { checks.push(label); console.error(`ok: ${label}`); };

// Pixels stay in the private output directory. The report keeps only evidence a window really painted:
// its size, how many distinct colors it has, and how much of it differs from its dominant color.
function paint(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = { 2: 3, 6: 4 }[png[25]];
  assert.ok(png[24] === 8 && channels && png[28] === 0, 'screenshot is an 8-bit non-interlaced RGB(A) PNG');
  const parts = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const data = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x];
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y ? rows[(y - 1) * stride + x] : 0;
      const upLeft = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      const estimate = left + up - upLeft;
      const nearest = Math.min(Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft));
      const paeth = nearest === Math.abs(estimate - left) ? left : nearest === Math.abs(estimate - up) ? up : upLeft;
      rows[y * stride + x] = (raw + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
    }
  }
  const counts = new Map();
  for (let at = 0; at < rows.length; at += channels) {
    const key = rows.readUIntBE(at, channels);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dominant = [...counts.values()].reduce((most, count) => Math.max(most, count), 0);
  return { width, height, colors: counts.size, differsFromBackground: Number((1 - dominant / (width * height)).toFixed(3)) };
}
// A frame that never arrives must fail the run instead of hanging it.
async function shoot(page, name, options = {}) {
  await delay(400); // let panel transitions finish so the image shows the settled window
  const png = await Promise.race([page.screenshot(options), delay(20_000).then(() => { throw new Error(`screenshot ${name} timed out`); })]);
  await writeFile(join(output, name), png);
  const stats = paint(png);
  assert.ok(stats.colors > 1 && stats.differsFromBackground > 0, `${name} is not a blank window`);
  windows[name] = stats;
}
let active;

async function launch() {
  const env = { ...process.env, HOME: join(fixture, 'home'), DUM_DESKTOP_DATA: profile, DUM_HOME: join(fixture, 'tree'), DUM_CONTEXT: 'off', CLAUDE_CONFIG_DIR: join(fixture, 'claude'), XDG_CONFIG_HOME: join(fixture, 'config') };
  for (const key of Object.keys(env)) if (/(?:API_KEY|TOKEN|PASSWORD|SECRET)|^(?:ANTHROPIC_|GOOGLE_|GEMINI_|VERTEX_|ANTIGRAVITY_|CLAUDE_CODE_USE_)/i.test(key)) delete env[key];
  delete env.DUM_CLAUDE_BIN;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  // A packaged app must not accidentally rely on the runner's Node/npm/global Claude PATH.
  if (!development) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const args = [...(development ? ['.'] : []), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
  // Only this isolated Linux smoke harness disables the unusable SUID sandbox on hub.
  if (process.platform === 'linux') args.push('--no-sandbox');
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = Promise.withResolvers();
  let diagnostic = '';
  child.stderr.on('data', bytes => {
    diagnostic = (diagnostic + bytes.toString()).slice(-64 * 1024);
    const found = diagnostic.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (found) endpoint.resolve(found[1]);
  });
  child.once('error', endpoint.reject);
  const exit = Promise.withResolvers();
  child.once('exit', (code, signal) => { exit.resolve({ code, signal }); endpoint.reject(new Error(`desktop exited before startup (${code ?? signal})`)); });
  const deadline = setTimeout(() => endpoint.reject(new Error('desktop did not expose its smoke debugging endpoint')), 30_000);
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: await endpoint.promise, defaultViewport: null });
    const target = await browser.waitForTarget(target => target.url().includes('view=panel'), { timeout: 30_000 });
    const page = await target.page();
    assert.ok(page, 'conversation window exists');
    await page.waitForFunction(() => typeof window.dum?.invoke === 'function');
    return { child, browser, page, exit: exit.promise, diagnostic: () => diagnostic };
  } catch (error) {
    child.kill();
    await exit.promise;
    browser?.disconnect();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
async function invoke(request) {
  return active.page.evaluate(request => window.dum.invoke(request), request);
}
async function snapshot() {
  const reply = await invoke({ type: 'snapshot' });
  assert.equal(reply.ok, true, reply.error);
  return reply.snapshot;
}
async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await snapshot();
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not arrive`);
}
async function stop() {
  if (!active) return;
  const instance = active;
  active = null;
  await instance.page.evaluate(() => window.dum.invoke({ type: 'quit' })).catch(() => {});
  const abort = new AbortController();
  try {
    const result = await Promise.race([instance.exit, delay(10_000, undefined, { signal: abort.signal }).then(() => { instance.child.kill(); throw new Error('desktop did not quit cleanly'); })]);
    assert.equal(result.code, 0, `desktop exit: ${result.code ?? result.signal}`);
  } finally {
    abort.abort();
    instance.browser.disconnect();
  }
}

try {
  active = await launch();
  const safeRenderer = await active.page.evaluate(() => ({ process: typeof process, require: typeof require }));
  assert.deepEqual(safeRenderer, { process: 'undefined', require: 'undefined' });
  record('sandboxed renderer has no Node capabilities');
  const setup = await until(value => value.runtime.available && value.runtime.gitAvailable, 'bundled runtime and Git preflight');
  assert.equal(setup.runtime.authenticated, false, 'clean profile is signed out');
  assert.match(setup.runtime.message, /^Sign in with your Claude subscription/, 'the bundled CLI reported a real signed-out state');
  // The conversation window starts hidden, like a real launch. A hidden window never produces a frame to capture.
  assert.equal((await invoke({ type: 'toggle-panel' })).ok, true);
  await active.page.waitForFunction(() => document.visibilityState === 'visible', { timeout: 10_000 });
  await shoot(active.page, 'onboarding.png');
  record('bundled Claude works with a signed-out clean profile');
  const opened = await invoke({ type: 'open-project', root: project });
  assert.equal(opened.ok, true, opened.error);
  const initial = await until(value => value.state?.root === project && value.inputToken, 'project request prompt');
  assert.equal(initial.canAttach, true);
  record('real utility host opens an explicitly chosen project');

  const stale = await invoke({ type: 'send', text: 'unsafe stale reply', inputToken: 'old-prompt-token' });
  assert.equal(stale.ok, false);
  assert.equal((await snapshot()).state.transcript.some(entry => entry.kind === 'user' && entry.text === 'unsafe stale reply'), false);
  const shell = await invoke({ type: 'command', name: 'self', argument: 'write anything' });
  assert.equal(shell.ok, false);
  record('stale prompt and out-of-catalog commands refused without submission');

  assert.equal((await invoke({ type: 'panel', panel: 'tree' })).ok, true);
  const tree = await until(value => value.tree?.tracks.length && value.state?.stage.kind === 'info', 'skill tree');
  const python = tree.tree.tracks.find(track => track.lang === 'python');
  assert.ok(python, 'bundled curriculum is available');
  assert.equal(python.nodes.find(node => node.name === 'recursion').state, 'locked');
  await shoot(active.page, 'tree.png');
  record('bundled skill tree preserves prerequisite locks');

  const note = 'Use integer cents for money in this smoke project.';
  assert.equal((await invoke({ type: 'command', name: 'remember', argument: note })).ok, true);
  await until(value => value.state?.transcript.some(entry => entry.kind === 'note' && entry.text.includes(note)), 'remembered note');
  assert.ok((await readFile(join(project, '.dum', 'memory.md'), 'utf8')).includes(note));
  assert.equal((await invoke({ type: 'panel', panel: 'memory' })).ok, true);
  await until(value => value.state?.stage.kind === 'info' && value.state.stage.body.includes(note), 'memory panel');
  await shoot(active.page, 'memory.png');
  const changed = { ...settings, alwaysOnTop: false, allWorkspaces: false };
  const saved = await invoke({ type: 'settings', settings: changed });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).settings.alwaysOnTop, false);
  record('memory and user settings persist through actual app actions');

  if (process.platform === 'linux') {
    const listed = await invoke({ type: 'capture-sources' });
    assert.equal(listed.ok, true, listed.error);
    const source = listed.sources.find(source => source.kind === 'screen');
    assert.ok(source, 'isolated Xvfb screen exists');
    const current = await snapshot();
    const preview = await invoke({ type: 'capture-preview', sourceId: source.id, inputToken: current.inputToken });
    assert.equal(preview.ok, true, preview.error);
    const png = Buffer.from(preview.preview.dataUrl.split(',')[1], 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    assert.equal((await invoke({ type: 'capture-discard' })).ok, true);
    const refused = await invoke({ type: 'send', text: 'look at this', inputToken: current.inputToken, captureToken: preview.preview.token });
    assert.equal(refused.ok, false);
    const persisted = await readFile(join(project, '.dum', 'transcript.json'), 'utf8');
    assert.equal(persisted.includes(preview.preview.dataUrl), false);
    record('real Xvfb capture preview discarded; consumed token cannot upload');
  }
  const buddyTarget = await active.browser.waitForTarget(target => target.url().includes('view=companion'));
  await shoot(await buddyTarget.page(), 'companion.png', { omitBackground: true });
  // A Mac runner has a real window server, so also ask macOS for a screen image. Without Screen Recording
  // permission it may omit app windows; the report records only what the command did.
  let macScreen = 'not attempted on this platform';
  if (process.platform === 'darwin') {
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', join(output, 'macos-screen.png')], { timeout: 20_000, stdio: 'ignore' });
      macScreen = `screencapture exited 0; ${JSON.stringify(paint(await readFile(join(output, 'macos-screen.png'))))}`;
    } catch (error) {
      macScreen = `screencapture failed: ${String(error.message).slice(0, 160)}`;
    }
  }
  await stop();

  active = await launch();
  assert.equal((await snapshot()).settings.alwaysOnTop, false);
  assert.equal((await invoke({ type: 'open-project', root: project })).ok, true);
  const restored = await until(value => value.state?.root === project && value.inputToken, 'restored project');
  assert.ok(restored.state.transcript.some(entry => entry.kind === 'note' && entry.text.includes(note)));
  assert.notEqual(restored.inputToken, initial.inputToken);
  record('quit/relaunch restores history and settings, but creates a fresh prompt');
  await stop();
  await writeFile(join(output, 'report.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, appVersion: setup.version, checks, windows, macScreen, nativePermissionLimit: 'This run does not establish macOS Screen Recording, full-screen focus, global-hotkey permission or login-item behavior.' }, null, 2));
  console.log(`Desktop smoke passed on ${process.platform}-${process.arch}: ${checks.join('; ')}.`);
} finally {
  if (active) { active.child.kill(); await active.exit; active.browser.disconnect(); }
  await rm(fixture, { recursive: true, force: true });
}
